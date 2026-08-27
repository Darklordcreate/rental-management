/**
 * ledgerEngine.js
 * Core engine for payments (payment_logs), water logs, documents, and dashboard analytics.
 */

const DOCS_BUCKET = 'tenant-documents';

// --- SHARED HELPERS ---

/** Whole months elapsed from a start date to now, inclusive (minimum 1). */
export function monthsElapsedInclusive(startDateStr) {
  const start = parseLocalDate(startDateStr);
  const now = new Date();
  const total = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth()) + 1;
  return Math.max(1, total);
}

export function formatDuration(startDateStr) {
  const n = monthsElapsedInclusive(startDateStr);
  return `${n} Month${n > 1 ? 's' : ''}`;
}

/** The date billing calculations should count from: rent_anchor_date if set, else move_in_date. */
export function billingAnchor(tenant) {
  return tenant.rent_anchor_date || tenant.move_in_date;
}

async function getCurrentUserId(supabase) {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user?.id;
}

/**
 * Safely parses a date-only string ("YYYY-MM-DD") as a LOCAL calendar date.
 * `new Date("YYYY-MM-DD")` is parsed as UTC midnight per spec — once you then call
 * local-time methods (.getMonth(), .toLocaleDateString()) on it, a browser whose
 * timezone is behind UTC silently shifts it back a day, which for the 1st of a
 * month becomes an entire month off. This is the root cause of "August payments
 * showing as July". Full timestamps (with a T or space + time) represent a genuine
 * instant and are parsed normally — the bug only applies to bare calendar dates.
 */
export function parseLocalDate(value) {
  if (!value) return new Date();
  if (value instanceof Date) return value;
  const str = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(str);
}

export function todayLocalISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function currentMonthFirstLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

/** Converts a Date object to "YYYY-MM-DD" using LOCAL components — the counterpart
 *  to parseLocalDate. .toISOString() converts to UTC first, which is wrong here for
 *  the same reason (a timezone ahead of UTC rolls the date backward). */
export function toLocalISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function getRentDueDay(supabase) {
  const ownerId = await getCurrentUserId(supabase);
  const { data } = await supabase.from('app_settings').select('rent_due_day').eq('owner_id', ownerId).maybeSingle();
  return data?.rent_due_day ?? 5;
}

function monthKeyToDate(key) {
  return new Date(Math.floor(key / 12), ((key % 12) + 12) % 12, 1);
}

function monthLabel(date) {
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/** Batch-fetches rent payment totals per tenant per month, for the tracking-status calc below. */
async function fetchPaidByTenantMonth(supabase, tenantIds) {
  const map = {};
  if (tenantIds.length === 0) return map;
  const { data: payments } = await supabase.from('payment_logs').select('tenant_id, period_month, amount_paid')
    .in('tenant_id', tenantIds).eq('payment_type', 'rent');
  (payments || []).forEach(p => {
    const mk = monthKey(p.period_month);
    map[p.tenant_id] = map[p.tenant_id] || {};
    map[p.tenant_id][mk] = (map[p.tenant_id][mk] || 0) + (parseFloat(p.amount_paid) || 0);
  });
  return map;
}

/**
 * Finds the earliest month (from billing anchor to now) that isn't fully paid, and sums
 * arrears across EVERY unpaid month in that range (not just the earliest one) — a tenant
 * behind on 3 months should show the true total owed, not just one month's shortfall.
 * PAID: everything up to the current month is settled (any excess becomes `credit`).
 * DUE: an unpaid month exists but its (dueDay of the following month) deadline hasn't passed.
 *      By construction this can only ever be the single most recent month — if an earlier
 *      month were also unpaid, its (earlier) deadline would already have passed, making the
 *      overall status LATE instead.
 * LATE: the earliest unpaid month's deadline has passed.
 */
function computeRentTrackingStatus(paidByMonth, anchorDateStr, baseRent, dueDay) {
  const anchorKey = monthKey(anchorDateStr);
  const nowKey = monthKey(new Date());
  let firstUnpaidKey = null;
  let totalArrears = 0;
  let monthsBehind = 0;

  for (let k = anchorKey; k <= nowKey; k++) {
    const paid = (paidByMonth && paidByMonth[k]) || 0;
    const shortfall = baseRent - paid;
    if (shortfall > 0) {
      totalArrears += shortfall;
      monthsBehind += 1;
      if (firstUnpaidKey === null) firstUnpaidKey = k;
    }
  }

  if (firstUnpaidKey === null) {
    // Every tracked month is fully covered — anything beyond that is genuine credit.
    let totalPaid = 0;
    for (let k = anchorKey; k <= nowKey; k++) totalPaid += (paidByMonth && paidByMonth[k]) || 0;
    const totalExpected = baseRent * (nowKey - anchorKey + 1);
    const credit = Math.max(0, totalPaid - totalExpected);
    return { trackingLabel: monthLabel(monthKeyToDate(nowKey)), trackingMonthIso: toLocalISODate(monthKeyToDate(nowKey)), status: 'PAID', lateLabel: null, amountOwing: 0, monthsBehind: 0, credit };
  }

  const unpaidMonthDate = monthKeyToDate(firstUnpaidKey);
  const deadline = new Date(unpaidMonthDate.getFullYear(), unpaidMonthDate.getMonth() + 1, dueDay);
  const isLate = new Date() > deadline;

  return {
    trackingLabel: monthLabel(unpaidMonthDate),
    trackingMonthIso: toLocalISODate(unpaidMonthDate),
    status: isLate ? 'LATE' : 'DUE',
    lateLabel: isLate ? monthLabel(unpaidMonthDate) : null,
    amountOwing: totalArrears,
    monthsBehind,
    credit: 0,
    dueDateLabel: deadline.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  };
}

/** Public batch helper: pass [{tenant, baseRent}] pairs, get back a Map keyed by tenant.id. */
export async function getRentTrackingStatuses(supabase, tenantUnitPairs) {
  const dueDay = await getRentDueDay(supabase);
  const tenantIds = tenantUnitPairs.map(p => p.tenant.id);
  const paidMap = await fetchPaidByTenantMonth(supabase, tenantIds);
  const result = {};
  tenantUnitPairs.forEach(({ tenant, baseRent }) => {
    result[tenant.id] = computeRentTrackingStatus(paidMap[tenant.id], billingAnchor(tenant), baseRent, dueDay);
  });
  return result;
}

/** Announces a brief message to screen-reader users via the hidden aria-live region in
 *  index.html. Doesn't replace visual feedback — just gives non-visual users the same signal. */
export function announce(message) {
  const el = document.getElementById('sr-announcer');
  if (!el) return;
  el.textContent = '';
  requestAnimationFrame(() => { el.textContent = message; });
}

/**
 * Promise-based replacement for the native confirm(). Resolves true/false.
 * Usage: if (await showConfirm({ message: '...' })) { ...proceed... }
 */
export function showConfirm({ title = 'Confirm', message = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirm-overlay');
    const titleEl = document.getElementById('confirm-title');
    const msgEl = document.getElementById('confirm-message');
    const okBtn = document.getElementById('confirm-ok-btn');
    const cancelBtn = document.getElementById('confirm-cancel-btn');

    titleEl.textContent = title;
    msgEl.textContent = message;
    okBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;
    okBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';

    const previouslyFocused = document.activeElement;

    function cleanup(result) {
      overlay.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('keydown', onKeydown);
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onKeydown(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cleanup(false); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        const focusables = [cancelBtn, okBtn];
        const idx = focusables.indexOf(document.activeElement);
        const nextIdx = e.shiftKey ? (idx <= 0 ? focusables.length - 1 : idx - 1) : (idx === focusables.length - 1 ? 0 : idx + 1);
        focusables[nextIdx].focus();
      }
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('keydown', onKeydown);

    overlay.style.display = 'flex';
    cancelBtn.focus(); // default to the safer option for destructive actions
  });
}

/** Replacement for native alert() — a dismissable toast instead of a blocking browser popup. */
export function showToast(message, type = 'info') {
  announce(message);
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 4500);
}

function firstOfMonth(dateStr) {
  const d = parseLocalDate(dateStr);
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** Computes EARLY / ON_TIME / LATE / PARTIAL for a rent payment.
 *  Deadline convention: a given month's rent is due by <dueDay> of the FOLLOWING month
 *  (e.g. August rent due by September 5th) — matches how rent is actually collected. */
function computeStatus(periodMonthStr, paymentDateStr, totalPaidForMonth, baseRent, dueDay) {
  if (totalPaidForMonth < baseRent) return 'PARTIAL';

  const periodStart = firstOfMonth(periodMonthStr);
  const paymentDate = parseLocalDate(paymentDateStr);
  const dueDate = new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, dueDay);

  if (paymentDate < periodStart) return 'EARLY';
  if (paymentDate <= dueDate) return 'ON_TIME';
  return 'LATE';
}

function monthKey(d) {
  const dt = parseLocalDate(d);
  return dt.getFullYear() * 12 + dt.getMonth();
}

/** Whole months where a tenancy (from anchor to now) overlaps a given [start,end] window (either side optional). */
function monthsInRange(anchorDateStr, rangeStart, rangeEnd) {
  const anchorKey = monthKey(anchorDateStr);
  const nowKey = monthKey(new Date());
  const startKey = rangeStart ? Math.max(monthKey(rangeStart), anchorKey) : anchorKey;
  const endKey = rangeEnd ? Math.min(monthKey(rangeEnd), nowKey) : nowKey;
  return Math.max(0, endKey - startKey + 1);
}

/** Preset date ranges for the dashboard period selector. 'todate' = null/null (all-time, current behavior). */
export function getPresetRange(preset) {
  const now = new Date();
  const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  switch (preset) {
    case 'month': return { start: startOfThisMonth, end: startOfThisMonth };
    case '3m': return { start: new Date(now.getFullYear(), now.getMonth() - 2, 1), end: startOfThisMonth };
    case '6m': return { start: new Date(now.getFullYear(), now.getMonth() - 5, 1), end: startOfThisMonth };
    case '1y': return { start: new Date(now.getFullYear(), now.getMonth() - 11, 1), end: startOfThisMonth };
    case 'todate':
    default: return { start: null, end: null };
  }
}

// --- DASHBOARD FINANCIAL STATS ---

/**
 * Rent Expected = base_rent x months overlapping the given range (or all-time-to-date if null/null).
 * Water Expected = sum of logged water_readings.total_cost whose period_month falls in the range.
 * Collected figures = actual sum of payment_logs (by type) whose period_month falls in the range.
 * Overdue / Credit are rent-specific (water doesn't have a late-payment concept yet).
 */
export async function updateDashboardStats(supabase, selectedPropertyId = 'all', range = { start: null, end: null }) {
  const els = {
    rentExpected: document.getElementById('stat-rent-expected'),
    rentCollected: document.getElementById('stat-rent-collected'),
    overdue: document.getElementById('stat-overdue'),
    credit: document.getElementById('stat-credit'),
    waterExpected: document.getElementById('stat-water-expected'),
    waterCollected: document.getElementById('stat-water-collected'),
    totalExpected: document.getElementById('stat-total-expected'),
    totalCollected: document.getElementById('stat-total-collected')
  };
  const setAll = (val) => Object.values(els).forEach(el => { if (el) el.textContent = `KES ${val.toLocaleString()}`; });

  let unitsQuery = supabase.from('units').select('id, base_rent, property_id, status').eq('status', 'occupied');
  if (selectedPropertyId !== 'all') unitsQuery = unitsQuery.eq('property_id', selectedPropertyId);
  const { data: units } = await unitsQuery;

  if (!units || units.length === 0) { setAll(0); return; }

  const unitIds = units.map(u => u.id);
  const { data: tenants } = await supabase
    .from('tenants').select('id, unit_id, move_in_date, rent_anchor_date').in('unit_id', unitIds).eq('status', 'active');

  const tenantByUnit = {};
  (tenants || []).forEach(t => { tenantByUnit[t.unit_id] = t; });
  const tenantIds = (tenants || []).map(t => t.id);

  let collectedRentByTenant = {}, collectedWaterByTenant = {};
  if (tenantIds.length > 0) {
    let paymentsQuery = supabase.from('payment_logs').select('tenant_id, amount_paid, payment_type, period_month')
      .in('tenant_id', tenantIds).in('payment_type', ['rent', 'water']);
    if (range.start) paymentsQuery = paymentsQuery.gte('period_month', toLocalISODate(range.start));
    if (range.end) paymentsQuery = paymentsQuery.lte('period_month', toLocalISODate(range.end));
    const { data: payments } = await paymentsQuery;
    (payments || []).forEach(p => {
      const bucket = p.payment_type === 'rent' ? collectedRentByTenant : collectedWaterByTenant;
      bucket[p.tenant_id] = (bucket[p.tenant_id] || 0) + (parseFloat(p.amount_paid) || 0);
    });
  }

  let waterExpected = 0;
  let waterReadingsQuery = supabase.from('water_readings').select('total_cost, period_month').in('unit_id', unitIds);
  if (range.start) waterReadingsQuery = waterReadingsQuery.gte('period_month', toLocalISODate(range.start));
  if (range.end) waterReadingsQuery = waterReadingsQuery.lte('period_month', toLocalISODate(range.end));
  const { data: waterReadings } = await waterReadingsQuery;
  (waterReadings || []).forEach(r => { waterExpected += parseFloat(r.total_cost) || 0; });

  let rentExpected = 0, rentCollected = 0, totalOverdue = 0, totalCredit = 0, waterCollected = 0;

  units.forEach(unit => {
    const tenant = tenantByUnit[unit.id];
    if (!tenant) return; // occupied but no active tenant record — skip from financials
    const baseRent = parseFloat(unit.base_rent) || 0;
    const months = monthsInRange(billingAnchor(tenant), range.start, range.end);
    const expected = baseRent * months;
    const collected = collectedRentByTenant[tenant.id] || 0;

    rentExpected += expected;
    rentCollected += collected;
    if (collected >= expected) totalCredit += (collected - expected);
    else totalOverdue += (expected - collected);

    waterCollected += collectedWaterByTenant[tenant.id] || 0;
  });

  if (els.rentExpected) els.rentExpected.textContent = `KES ${rentExpected.toLocaleString()}`;
  if (els.rentCollected) els.rentCollected.textContent = `KES ${rentCollected.toLocaleString()}`;
  if (els.overdue) els.overdue.textContent = `KES ${totalOverdue.toLocaleString()}`;
  if (els.credit) els.credit.textContent = `KES ${totalCredit.toLocaleString()}`;
  if (els.waterExpected) els.waterExpected.textContent = `KES ${waterExpected.toLocaleString()}`;
  if (els.waterCollected) els.waterCollected.textContent = `KES ${waterCollected.toLocaleString()}`;
  if (els.totalExpected) els.totalExpected.textContent = `KES ${(rentExpected + waterExpected).toLocaleString()}`;
  if (els.totalCollected) els.totalCollected.textContent = `KES ${(rentCollected + waterCollected).toLocaleString()}`;
}

/** Public batch helper: current-month water reading + payment status per unit. Pass [{tenant, unitId}]. */
/** Every reading for a set of tenants, keyed by tenant then month — the shared building
 *  block for both the card badge and the full per-month ledger in the drawer. */
async function fetchReadingsByTenantMonth(supabase, tenantIds) {
  const map = {};
  if (tenantIds.length === 0) return map;
  const { data } = await supabase.from('water_readings')
    .select('tenant_id, period_month, prev_reading, curr_reading, units_consumed, total_cost, reading_date, id')
    .in('tenant_id', tenantIds);
  (data || []).forEach(r => {
    const mk = monthKey(r.period_month);
    map[r.tenant_id] = map[r.tenant_id] || {};
    map[r.tenant_id][mk] = r;
  });
  return map;
}

/** Walks every month from the tenant's billing anchor (same one rent uses) to now,
 *  flagging which ones have no logged reading at all — not just whether this month is set. */
function computeWaterTrackingStatus(readingsByMonth, anchorDateStr) {
  const anchorKey = monthKey(anchorDateStr);
  const nowKey = monthKey(new Date());
  const missingKeys = [];
  for (let k = anchorKey; k <= nowKey; k++) {
    if (!readingsByMonth || !readingsByMonth[k]) missingKeys.push(k);
  }
  return {
    missingCount: missingKeys.length,
    earliestMissingLabel: missingKeys.length > 0 ? monthLabel(monthKeyToDate(missingKeys[0])) : null,
    missingMonthKeys: missingKeys,
    currentReading: (readingsByMonth && readingsByMonth[nowKey]) || null
  };
}

/** Public batch helper for unit cards: missing-months gap (mirrors rent's LATE tracking)
 *  plus this month's paid/unpaid status when nothing's missing. */
export async function getWaterStatuses(supabase, tenantUnitPairs) {
  const tenantIds = tenantUnitPairs.map(p => p.tenant.id);
  const result = {};
  if (tenantIds.length === 0) return result;

  const readingsByTenantMonth = await fetchReadingsByTenantMonth(supabase, tenantIds);

  const currentMonthIso = currentMonthFirstLocal();
  const { data: payments } = await supabase.from('payment_logs')
    .select('tenant_id, amount_paid')
    .in('tenant_id', tenantIds).eq('payment_type', 'water').eq('period_month', currentMonthIso);
  const paidByTenant = {};
  (payments || []).forEach(p => { paidByTenant[p.tenant_id] = (paidByTenant[p.tenant_id] || 0) + (parseFloat(p.amount_paid) || 0); });

  tenantUnitPairs.forEach(({ tenant }) => {
    const tracking = computeWaterTrackingStatus(readingsByTenantMonth[tenant.id], billingAnchor(tenant));
    const reading = tracking.currentReading;
    const logged = !!reading;
    const cost = logged ? (parseFloat(reading.total_cost) || 0) : 0;
    const paid = paidByTenant[tenant.id] || 0;
    result[tenant.id] = {
      logged,
      consumed: logged ? reading.units_consumed : null,
      cost,
      paid,
      isPaid: logged ? paid >= cost : false,
      missingCount: tracking.missingCount,
      earliestMissingLabel: tracking.earliestMissingLabel
    };
  });

  return result;
}

/**
 * Returns the same figures the unit card badge is built from, so the drawer header and the
 * card can never show contradictory pictures of a tenant's standing. `status` is
 * PAID / DUE / LATE (matching the card), `owing` is total arrears across every unpaid month
 * (not just the most recent), and `credit` is only ever non-zero when nothing is owed —
 * an overpayment on one month no longer masks an unpaid earlier month as "credit".
 */
export async function getTenantBalance(supabase, tenant, baseRent) {
  const rent = parseFloat(baseRent) || 0;
  // These two are independent of each other — fetch concurrently instead of one-after-another.
  const [paidMap, dueDay] = await Promise.all([
    fetchPaidByTenantMonth(supabase, [tenant.id]),
    getRentDueDay(supabase)
  ]);
  const tenantPaidByMonth = paidMap[tenant.id] || {};
  const tracking = computeRentTrackingStatus(tenantPaidByMonth, billingAnchor(tenant), rent, dueDay);

  // collected is just the sum across every month already fetched above — no need for a
  // second round-trip to re-fetch the same underlying payment_logs rows.
  const collected = Object.values(tenantPaidByMonth).reduce((sum, v) => sum + v, 0);
  const months = monthsElapsedInclusive(billingAnchor(tenant));
  const expected = rent * months;

  return {
    expected,
    collected,
    balance: tracking.status === 'PAID' ? tracking.credit : -tracking.amountOwing,
    owing: tracking.amountOwing,
    credit: tracking.credit,
    status: tracking.status,
    trackingLabel: tracking.trackingLabel,
    trackingMonthIso: tracking.trackingMonthIso,
    monthsBehind: tracking.monthsBehind || 0
  };
}

// --- PAYMENT LEDGER MODULE ---

export async function loadTenantLedger(supabase, tenantId) {
  const tbody = document.getElementById('ledger-table-body');
  if (!tbody) return;

  const { data: payments, error } = await supabase
    .from('payment_logs').select('*').eq('tenant_id', tenantId).order('payment_date', { ascending: false });

  if (error || !payments || payments.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No payment records found.</td></tr>';
    return;
  }

  const statusClass = { ON_TIME: 'badge-success', EARLY: 'badge-info', LATE: 'badge-danger', PARTIAL: 'badge-warning' };

  tbody.innerHTML = payments.map(p => {
    const payDate = parseLocalDate(p.payment_date);
    const periodLabel = parseLocalDate(p.period_month).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    return `
      <tr data-payment-id="${p.id}">
        <td>${payDate.toLocaleDateString()}</td>
        <td><strong>${periodLabel}</strong></td>
        <td>${p.payment_type}</td>
        <td>KES ${(parseFloat(p.amount_paid) || 0).toLocaleString()}</td>
        <td><span class="badge ${statusClass[p.status] || ''}">${p.status}</span></td>
        <td><button class="btn-icon-delete" data-delete-payment="${p.id}" title="Delete" aria-label="Delete">&times;</button></td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('[data-delete-payment]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const okDeletePayment = await showConfirm({ title: 'Delete Payment', message: 'Delete this payment record? This cannot be undone.', confirmLabel: 'Delete', danger: true });
      if (!okDeletePayment) return;
      await supabase.from('payment_logs').delete().eq('id', btn.dataset.deletePayment);
      loadTenantLedger(supabase, tenantId);
    });
  });
}

export async function openPaymentModal(supabase, unit, tenant, selectedDate, onSuccess) {
  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');

  modalTitle.textContent = `Record Payment: ${unit.house_number}`;
  const todayStr = selectedDate || todayLocalISO();

  // Default the target month to whatever the tenant actually owes (DUE/LATE), not just
  // today — so catching up on a missed month doesn't require remembering to change it.
  const tenantBalance = await getTenantBalance(supabase, tenant, unit.base_rent);
  const defaultTargetMonth = (tenantBalance.trackingMonthIso || todayStr).slice(0, 7);

  modalBody.innerHTML = `
    <form id="payment-form">
      <div class="form-group"><label for="pay-tenant-name-display">Tenant Name</label><input type="text" id="pay-tenant-name-display" value="${tenant.full_name}" disabled /></div>
      <div class="form-group">
        <label id="pay-reference-label" for="pay-reference-value">Base Rent (KES)</label>
        <input type="text" id="pay-reference-value" value="${unit.base_rent}" disabled />
      </div>
      <div class="form-group">
        <label for="pay-type">Payment Type</label>
        <select id="pay-type">
          <option value="rent">Rent</option>
          <option value="water">Water</option>
          <option value="deposit">Deposit</option>
          <option value="penalty">Penalty</option>
        </select>
      </div>
      <div class="form-group"><label for="pay-date">Payment Date</label><input type="date" id="pay-date" value="${todayStr}" required /></div>
      <div class="form-group"><label for="pay-month">Target Month (which month this pays for)</label><input type="month" id="pay-month" value="${defaultTargetMonth}" required /></div>
      <div class="form-group"><label for="pay-amount">Amount Paid (KES)</label><input type="number" id="pay-amount" placeholder="e.g. 15000" required step="0.01" /></div>
      <div class="form-group"><label for="pay-ref">Reference Code (optional)</label><input type="text" id="pay-ref" placeholder="M-Pesa code, etc." /></div>
      <div id="payment-summary" style="margin-top: 0.5rem; font-size: 0.85rem; font-weight: 600;"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="cancel-modal-btn">Cancel</button>
        <button type="submit" class="btn btn-primary">Save Payment</button>
      </div>
    </form>
  `;
  modalOverlay.style.display = 'flex';

  const amountInput = document.getElementById('pay-amount');
  const summaryDiv = document.getElementById('payment-summary');
  const typeSelect = document.getElementById('pay-type');
  const monthInput = document.getElementById('pay-month');
  const refLabel = document.getElementById('pay-reference-label');
  const refValue = document.getElementById('pay-reference-value');

  // Cached so the amount field's keystroke handler stays synchronous — only re-fetched
  // when payment type or target month actually change, not on every digit typed.
  let payContext = { referenceAmount: null, priorPaid: 0, comparisonLabel: null };

  function updateSummary() {
    const paid = parseFloat(amountInput.value) || 0;
    if (paid === 0 || payContext.referenceAmount === null) {
      if (paid > 0 && payContext.referenceAmount === null) {
        summaryDiv.innerHTML = `<span style="color:var(--text-muted);">${payContext.comparisonLabel || 'No reference amount to compare against for this payment type.'}</span>`;
      } else {
        summaryDiv.innerHTML = '';
      }
      return;
    }
    const remaining = payContext.referenceAmount - payContext.priorPaid;
    const diff = paid - remaining;
    if (diff > 0) summaryDiv.innerHTML = `<span style="color:#0284c7;">Surplus vs amount still owed for this month: KES ${diff.toLocaleString()}</span>`;
    else if (diff < 0) summaryDiv.innerHTML = `<span style="color:#eab308;">Short of amount still owed for this month: KES ${Math.abs(diff).toLocaleString()}</span>`;
    else summaryDiv.innerHTML = `<span style="color:#16a34a;">Matches what's still owed for this month.</span>`;
  }

  async function refreshPayContext() {
    const type = typeSelect.value;
    const [py, pm] = monthInput.value.split('-');
    const periodMonth = `${py}-${pm}-01`;

    if (type === 'rent') {
      refLabel.textContent = 'Base Rent (KES)';
      refValue.value = unit.base_rent;
      const { data: existing } = await supabase.from('payment_logs').select('amount_paid')
        .eq('tenant_id', tenant.id).eq('payment_type', 'rent').eq('period_month', periodMonth);
      const priorPaid = (existing || []).reduce((s, p) => s + (parseFloat(p.amount_paid) || 0), 0);
      payContext = { referenceAmount: parseFloat(unit.base_rent) || 0, priorPaid, comparisonLabel: null };
    } else if (type === 'water') {
      const { data: reading } = await supabase.from('water_readings').select('total_cost')
        .eq('unit_id', unit.id).eq('period_month', periodMonth).maybeSingle();
      if (reading) {
        refLabel.textContent = "This Month's Water Bill (KES)";
        refValue.value = reading.total_cost;
        const { data: existing } = await supabase.from('payment_logs').select('amount_paid')
          .eq('tenant_id', tenant.id).eq('payment_type', 'water').eq('period_month', periodMonth);
        const priorPaid = (existing || []).reduce((s, p) => s + (parseFloat(p.amount_paid) || 0), 0);
        payContext = { referenceAmount: parseFloat(reading.total_cost) || 0, priorPaid, comparisonLabel: null };
      } else {
        refLabel.textContent = "This Month's Water Bill (KES)";
        refValue.value = 'Not logged yet';
        payContext = { referenceAmount: null, priorPaid: 0, comparisonLabel: 'No water reading logged for this month yet — nothing to compare against.' };
      }
    } else {
      // deposit / penalty have no fixed expected amount in the system
      refLabel.textContent = type === 'deposit' ? 'Deposit' : 'Penalty';
      refValue.value = 'No fixed amount on file';
      payContext = { referenceAmount: null, priorPaid: 0, comparisonLabel: null };
    }
    updateSummary();
  }

  amountInput.addEventListener('input', updateSummary);
  typeSelect.addEventListener('change', refreshPayContext);
  monthInput.addEventListener('change', refreshPayContext);
  refreshPayContext();

  document.getElementById('payment-form').onsubmit = async (e) => {
    e.preventDefault();
    const paidAmount = parseFloat(amountInput.value);
    const paymentType = document.getElementById('pay-type').value;
    const paymentDate = document.getElementById('pay-date').value;
    const [y, m] = document.getElementById('pay-month').value.split('-');
    const periodMonth = `${y}-${m}-01`;
    const referenceCode = document.getElementById('pay-ref').value.trim() || null;

    let status = 'ON_TIME';
    let surplus = 0;
    if (paymentType === 'rent') {
      const { data: existing } = await supabase
        .from('payment_logs').select('amount_paid')
        .eq('tenant_id', tenant.id).eq('payment_type', 'rent').eq('period_month', periodMonth);
      const priorForMonth = (existing || []).reduce((s, p) => s + (parseFloat(p.amount_paid) || 0), 0);
      const totalForMonth = priorForMonth + paidAmount;
      const dueDay = await getRentDueDay(supabase);
      status = computeStatus(periodMonth, paymentDate, totalForMonth, unit.base_rent, dueDay);
      if (totalForMonth > parseFloat(unit.base_rent)) surplus = totalForMonth - parseFloat(unit.base_rent);
    }

    const { error } = await supabase.from('payment_logs').insert([{
      tenant_id: tenant.id,
      amount_paid: paidAmount,
      payment_type: paymentType,
      payment_date: paymentDate,
      period_month: periodMonth,
      reference_code: referenceCode,
      status
    }]);

    if (error) { showToast('Error saving payment: ' + error.message, 'error'); return; }

    modalOverlay.style.display = 'none';
    loadTenantLedger(supabase, tenant.id);
    if (onSuccess) onSuccess();

    if (surplus > 0) {
      openSurplusAllocationModal(supabase, unit, tenant, surplus, periodMonth, paymentDate, () => {
        loadTenantLedger(supabase, tenant.id);
        if (onSuccess) onSuccess();
      });
    }
  };

  document.getElementById('cancel-modal-btn').onclick = () => { modalOverlay.style.display = 'none'; };
  document.getElementById('close-modal-btn').onclick = () => { modalOverlay.style.display = 'none'; };
}

/** Shown after a rent payment exceeds what was owed for that month — lets the landlord
 *  route the extra toward the water bill or next month's rent instead of it sitting as
 *  unexplained "credit". */
function openSurplusAllocationModal(supabase, unit, tenant, surplus, periodMonth, paymentDate, onDone) {
  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');
  const monthLabelText = parseLocalDate(periodMonth).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  modalTitle.textContent = 'Extra Payment Received';
  modalBody.innerHTML = `
    <p>This payment is <strong>KES ${surplus.toLocaleString()}</strong> more than ${monthLabelText}'s rent. What should happen to the extra?</p>
    <div style="display:flex; flex-direction:column; gap:0.6rem; margin-top:1rem;">
      <button class="btn btn-primary" id="surplus-to-water">Apply to this month's water bill</button>
      <button class="btn btn-primary" id="surplus-to-next-rent">Apply to next month's rent</button>
      <button class="btn btn-secondary" id="surplus-keep-credit">Leave as credit</button>
    </div>
  `;
  modalOverlay.style.display = 'flex';

  document.getElementById('surplus-keep-credit').onclick = () => { modalOverlay.style.display = 'none'; };
  document.getElementById('close-modal-btn').onclick = () => { modalOverlay.style.display = 'none'; };

  document.getElementById('surplus-to-water').onclick = async () => {
    await supabase.from('payment_logs').insert([{
      tenant_id: tenant.id, amount_paid: surplus, payment_type: 'water',
      payment_date: paymentDate, period_month: periodMonth, status: 'ON_TIME'
    }]);
    modalOverlay.style.display = 'none';
    if (onDone) onDone();
  };

  document.getElementById('surplus-to-next-rent').onclick = async () => {
    const d = parseLocalDate(periodMonth);
    const nextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const nextPeriodMonth = toLocalISODate(nextMonth);
    const dueDay = await getRentDueDay(supabase);
    const status = computeStatus(nextPeriodMonth, paymentDate, surplus, unit.base_rent, dueDay);
    await supabase.from('payment_logs').insert([{
      tenant_id: tenant.id, amount_paid: surplus, payment_type: 'rent',
      payment_date: paymentDate, period_month: nextPeriodMonth, status
    }]);
    modalOverlay.style.display = 'none';
    if (onDone) onDone();
  };
}

// --- WATER LOGGING MODULE ---

export async function loadWaterReadings(supabase, unit, tenant) {
  const tbody = document.getElementById('water-table-body');
  if (!tbody) return;

  const { data: readings } = await supabase
    .from('water_readings').select('*').eq('unit_id', unit.id);

  const readingByMonth = {};
  (readings || []).forEach(r => { readingByMonth[monthKey(r.period_month)] = r; });

  const anchorKey = monthKey(billingAnchor(tenant));
  const nowKey = monthKey(new Date());
  const rows = [];
  for (let k = nowKey; k >= anchorKey; k--) rows.push({ key: k, reading: readingByMonth[k] || null });

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No tracked months yet.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(row => {
    const monthDate = monthKeyToDate(row.key);
    const periodLabel = monthLabel(monthDate);
    const r = row.reading;

    if (r) {
      const rDate = parseLocalDate(r.reading_date || r.created_at);
      return `
        <tr data-reading-id="${r.id}">
          <td>${rDate.toLocaleDateString()}</td>
          <td><strong>${periodLabel}</strong></td>
          <td>${r.prev_reading}</td>
          <td>${r.curr_reading}</td>
          <td>${r.units_consumed} m³</td>
          <td>KES ${(parseFloat(r.total_cost) || 0).toLocaleString()}</td>
          <td><button class="btn-icon-delete" data-delete-reading="${r.id}" title="Delete" aria-label="Delete">&times;</button></td>
        </tr>
      `;
    }

    return `
      <tr style="background:rgba(217,119,6,0.08);">
        <td>—</td>
        <td><strong>${periodLabel}</strong></td>
        <td colspan="3" style="color:var(--warning); font-weight:600;">Not recorded</td>
        <td></td>
        <td><button type="button" class="btn btn-secondary btn-log-missing-month" data-month="${toLocalISODate(monthDate)}" style="padding:0.2rem 0.5rem; font-size:0.78rem;">Log</button></td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('[data-delete-reading]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const okDeleteReading = await showConfirm({ title: 'Delete Water Reading', message: 'Delete this water reading? This cannot be undone.', confirmLabel: 'Delete', danger: true });
      if (!okDeleteReading) return;
      await supabase.from('water_readings').delete().eq('id', btn.dataset.deleteReading);
      loadWaterReadings(supabase, unit, tenant);
    });
  });

  tbody.querySelectorAll('.btn-log-missing-month').forEach(btn => {
    btn.addEventListener('click', () => {
      openWaterModal(supabase, unit, tenant, null, () => loadWaterReadings(supabase, unit, tenant), btn.dataset.month);
    });
  });
}

export async function openWaterModal(supabase, unit, tenant, selectedDate, onSuccess, presetMonth) {
  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');

  modalTitle.textContent = 'Log Water Reading';
  const todayStr = selectedDate || todayLocalISO();

  // Auto-fill previous reading from the last logged current reading for this unit
  const { data: lastReading } = await supabase
    .from('water_readings').select('curr_reading').eq('unit_id', unit.id)
    .order('reading_date', { ascending: false }).limit(1).maybeSingle();
  const prevDefault = lastReading ? lastReading.curr_reading : 0;
  const currentOwnerId = await getCurrentUserId(supabase);
  let defaultRate = 150;
  if (unit.property_id) {
    const { data: propertyRow } = await supabase.from('properties').select('water_rate').eq('id', unit.property_id).maybeSingle();
    if (propertyRow?.water_rate != null) defaultRate = propertyRow.water_rate;
    else {
      const { data: settingsRow } = await supabase.from('app_settings').select('default_water_rate').eq('owner_id', currentOwnerId).maybeSingle();
      defaultRate = settingsRow?.default_water_rate ?? 150;
    }
  }

  modalBody.innerHTML = `
    <form id="water-form">
      <div class="form-group"><label for="water-date">Reading Date</label><input type="date" id="water-date" value="${todayStr}" required /></div>
      <div class="form-group"><label for="water-month">Reading Month</label><input type="month" id="water-month" value="${(presetMonth || todayStr).slice(0,7)}" required /></div>
      <p id="water-existing-note" style="font-size:0.82rem; color:var(--warning); display:none;"></p>
      <div class="form-group"><label for="water-prev">Previous Meter Reading</label><input type="number" id="water-prev" value="${prevDefault}" step="0.1" required /></div>
      <div class="form-group"><label for="water-curr">Current Meter Reading</label><input type="number" id="water-curr" placeholder="e.g. 135" step="0.1" required /></div>
      <div class="form-group"><label for="water-rate">Rate per Unit (KES)</label><input type="number" id="water-rate" value="${defaultRate}" step="1" required /></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="cancel-water-btn">Cancel</button>
        <button type="submit" class="btn btn-primary">Save Reading</button>
      </div>
    </form>
  `;
  modalOverlay.style.display = 'flex';

  const monthInput = document.getElementById('water-month');
  const existingNote = document.getElementById('water-existing-note');
  const prevInput = document.getElementById('water-prev');
  const currInput = document.getElementById('water-curr');
  const rateInput = document.getElementById('water-rate');
  let editingExistingId = null;

  async function checkExistingForMonth() {
    const [y, m] = monthInput.value.split('-');
    const periodMonth = `${y}-${m}-01`;
    const { data: existing } = await supabase.from('water_readings')
      .select('id, prev_reading, curr_reading, rate_per_unit')
      .eq('unit_id', unit.id).eq('period_month', periodMonth).maybeSingle();

    if (existing) {
      editingExistingId = existing.id;
      prevInput.value = existing.prev_reading;
      currInput.value = existing.curr_reading;
      rateInput.value = existing.rate_per_unit;
      existingNote.textContent = 'A reading already exists for this month — editing it in place.';
      existingNote.style.display = 'block';
    } else {
      editingExistingId = null;
      existingNote.style.display = 'none';
    }
  }

  monthInput.addEventListener('change', checkExistingForMonth);
  checkExistingForMonth();

  document.getElementById('water-form').onsubmit = async (e) => {
    e.preventDefault();
    const readingDate = document.getElementById('water-date').value;
    const [y, m] = document.getElementById('water-month').value.split('-');
    const periodMonth = `${y}-${m}-01`;
    const prev = parseFloat(document.getElementById('water-prev').value);
    const curr = parseFloat(document.getElementById('water-curr').value);
    const rate = parseFloat(document.getElementById('water-rate').value);

    if (curr < prev) { showToast('Current reading cannot be lower than previous reading.', 'info'); return; }
    if (!tenant) { showToast('Cannot log a water reading for a vacant unit.', 'info'); return; }

    if (editingExistingId) {
      const monthLabelText = parseLocalDate(periodMonth).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      const ok = await showConfirm({
        title: 'Overwrite Existing Reading?',
        message: `${monthLabelText} already has a reading logged for this unit. Save these values over it?`,
        confirmLabel: 'Overwrite',
        danger: true
      });
      if (!ok) return;

      const { error: updateError } = await supabase.from('water_readings').update({
        prev_reading: prev, curr_reading: curr, rate_per_unit: rate, reading_date: readingDate, tenant_id: tenant.id
      }).eq('id', editingExistingId);

      if (updateError) { showToast('Error updating water log: ' + updateError.message, 'error'); return; }

      modalOverlay.style.display = 'none';
      loadWaterReadings(supabase, unit, tenant);
      if (onSuccess) onSuccess();
      return;
    }

    const { error } = await supabase.from('water_readings').insert([{
      unit_id: unit.id,
      tenant_id: tenant.id,
      period_month: periodMonth,
      prev_reading: prev,
      curr_reading: curr,
      rate_per_unit: rate,
      reading_date: readingDate
    }]);

    if (error) { showToast('Error saving water log: ' + error.message, 'error'); return; }

    modalOverlay.style.display = 'none';
    loadWaterReadings(supabase, unit, tenant);
    if (onSuccess) onSuccess();
  };

  document.getElementById('cancel-water-btn').onclick = () => { modalOverlay.style.display = 'none'; };
  document.getElementById('close-modal-btn').onclick = () => { modalOverlay.style.display = 'none'; };
}

// --- DOCUMENT VAULT MODULE (real Supabase Storage uploads) ---

export async function loadDocuments(supabase, unitId, tenantId) {
  const docList = document.getElementById('document-list');
  if (!docList) return;

  docList.innerHTML = '<li>Loading documents...</li>';

  let query = supabase.from('documents').select('*');
  query = tenantId ? query.or(`unit_id.eq.${unitId},tenant_id.eq.${tenantId}`) : query.eq('unit_id', unitId);
  const { data: docs, error } = await query.order('uploaded_at', { ascending: false });

  if (error || !docs || docs.length === 0) {
    docList.innerHTML = '<li style="text-align:center; color:#777;">No documents uploaded.</li>';
    return;
  }

  docList.innerHTML = '';
  for (const doc of docs) {
    const uploadDate = doc.uploaded_at ? parseLocalDate(doc.uploaded_at).toLocaleDateString() : '';
    const { data: signed } = await supabase.storage.from(DOCS_BUCKET).createSignedUrl(doc.file_url, 3600);
    const li = document.createElement('li');
    li.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem; padding:0.5rem; background:#f9f9f9; border-radius:4px;';
    li.innerHTML = `
      <span>📄 <strong>${doc.file_name}</strong> <small style="color:#777;">(${uploadDate})</small></span>
      <span style="display:flex; gap:0.4rem;">
        <a href="${signed?.signedUrl || '#'}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary" style="padding:0.2rem 0.5rem; font-size:0.8rem; text-decoration:none;">View</a>
        <button class="btn-icon-delete" data-delete-doc="${doc.id}" data-storage-path="${doc.file_url}" title="Delete" aria-label="Delete">&times;</button>
      </span>
    `;
    docList.appendChild(li);
  }

  docList.querySelectorAll('[data-delete-doc]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const okDeleteDoc = await showConfirm({ title: 'Delete Document', message: 'Delete this document? This cannot be undone.', confirmLabel: 'Delete', danger: true });
      if (!okDeleteDoc) return;
      await supabase.storage.from(DOCS_BUCKET).remove([btn.dataset.storagePath]);
      await supabase.from('documents').delete().eq('id', btn.dataset.deleteDoc);
      loadDocuments(supabase, unitId, tenantId);
    });
  });
}

export function openDocumentModal(supabase, unitId, tenantId, onSuccess) {
  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');

  modalTitle.textContent = 'Upload Document';

  modalBody.innerHTML = `
    <form id="doc-form">
      <div class="form-group"><label for="doc-name">Document Title</label><input type="text" id="doc-name" placeholder="e.g. Lease Agreement" required /></div>
      <div class="form-group"><label for="doc-file">File</label><input type="file" id="doc-file" required /></div>
      <div id="doc-upload-status" style="font-size:0.85rem; color:var(--text-muted);"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="cancel-doc-btn">Cancel</button>
        <button type="submit" class="btn btn-primary" id="doc-submit-btn">Save Document</button>
      </div>
    </form>
  `;
  modalOverlay.style.display = 'flex';

  document.getElementById('doc-form').onsubmit = async (e) => {
    e.preventDefault();
    const fileName = document.getElementById('doc-name').value.trim();
    const fileInput = document.getElementById('doc-file');
    const file = fileInput.files[0];
    const statusEl = document.getElementById('doc-upload-status');
    const submitBtn = document.getElementById('doc-submit-btn');
    if (!file) return;

    submitBtn.disabled = true;
    statusEl.textContent = 'Uploading…';

    const currentOwnerId = await getCurrentUserId(supabase);
    const storagePath = `${currentOwnerId}/${unitId}/${Date.now()}_${file.name.replace(/\s+/g, '_')}`;
    const { error: uploadError } = await supabase.storage.from(DOCS_BUCKET).upload(storagePath, file);

    if (uploadError) {
      statusEl.textContent = '';
      submitBtn.disabled = false;
      showToast('Upload failed: ' + uploadError.message, 'error');
      return;
    }

    const { error } = await supabase.from('documents').insert([{
      unit_id: unitId,
      tenant_id: tenantId || null,
      file_name: fileName,
      file_url: storagePath
    }]);

    submitBtn.disabled = false;
    if (error) { showToast('Error saving document: ' + error.message, 'error'); return; }

    modalOverlay.style.display = 'none';
    loadDocuments(supabase, unitId, tenantId);
    if (onSuccess) onSuccess();
  };

  document.getElementById('cancel-doc-btn').onclick = () => { modalOverlay.style.display = 'none'; };
  document.getElementById('close-modal-btn').onclick = () => { modalOverlay.style.display = 'none'; };
}

// --- PROPERTY AND UNIT CREATION / EDIT MODALS ---

export function openAddPropertyModal(supabase, onSuccess) {
  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');

  modalTitle.textContent = 'Add New Property';
  modalBody.innerHTML = `
    <form id="property-form">
      <div class="form-group"><label for="prop-name">Property Name</label><input type="text" id="prop-name" placeholder="e.g. Shem 2" required /></div>
      <div class="form-group">
        <label for="prop-water-rate">Water Rate (KES per unit)</label>
        <input type="number" id="prop-water-rate" placeholder="Leave blank to use your default rate" step="1" min="0" />
        <small style="color:var(--text-muted);">Only set this if water costs differ at this property. Otherwise your Settings default applies.</small>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="cancel-prop-btn">Cancel</button>
        <button type="submit" class="btn btn-primary">Save Property</button>
      </div>
    </form>
  `;
  modalOverlay.style.display = 'flex';

  document.getElementById('property-form').onsubmit = async (e) => {
    e.preventDefault();
    const name = document.getElementById('prop-name').value.trim();
    const rateRaw = document.getElementById('prop-water-rate').value;
    const waterRate = rateRaw === '' ? null : parseFloat(rateRaw);
    const { error } = await supabase.from('properties').insert([{ name, water_rate: waterRate }]);
    if (error) { showToast('Error adding property: ' + error.message, 'error'); return; }
    modalOverlay.style.display = 'none';
    if (onSuccess) onSuccess();
  };
  document.getElementById('cancel-prop-btn').onclick = () => { modalOverlay.style.display = 'none'; };
  document.getElementById('close-modal-btn').onclick = () => { modalOverlay.style.display = 'none'; };
}

export async function openAddUnitModal(supabase, onSuccess) {
  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');

  const { data: properties } = await supabase.from('properties').select('*');
  if (!properties || properties.length === 0) { showToast('Please add at least one property before adding units.', 'info'); return; }

  modalTitle.textContent = 'Add New Unit / House';
  const propertyOptions = properties.map(p => `<option value="${p.id}">${p.name}</option>`).join('');

  modalBody.innerHTML = `
    <form id="unit-form">
      <div class="form-group"><label for="unit-property-id">Select Property</label><select id="unit-property-id" required>${propertyOptions}</select></div>
      <div class="form-group"><label for="unit-number">House / Unit Number</label><input type="text" id="unit-number" placeholder="e.g. House 3" required /></div>
      <div class="form-group"><label for="unit-rent">Base Monthly Rent (KES)</label><input type="number" id="unit-rent" placeholder="e.g. 15000" step="0.01" required /></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="cancel-unit-btn">Cancel</button>
        <button type="submit" class="btn btn-primary">Save Unit</button>
      </div>
    </form>
  `;
  modalOverlay.style.display = 'flex';

  document.getElementById('unit-form').onsubmit = async (e) => {
    e.preventDefault();
    const propertyId = document.getElementById('unit-property-id').value;
    const houseNumber = document.getElementById('unit-number').value.trim();
    const baseRent = parseFloat(document.getElementById('unit-rent').value);
    const { error } = await supabase.from('units').insert([{ property_id: propertyId, house_number: houseNumber, base_rent: baseRent, status: 'vacant' }]);
    if (error) { showToast('Error adding unit: ' + error.message, 'error'); return; }
    modalOverlay.style.display = 'none';
    if (onSuccess) onSuccess();
  };
  document.getElementById('cancel-unit-btn').onclick = () => { modalOverlay.style.display = 'none'; };
  document.getElementById('close-modal-btn').onclick = () => { modalOverlay.style.display = 'none'; };
}

// --- LANDLORD SETTINGS ---

export async function openSettingsModal(supabase) {
  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');

  const ownerId = await getCurrentUserId(supabase);
  const { data: settings } = await supabase.from('app_settings').select('*').eq('owner_id', ownerId).maybeSingle();

  modalTitle.textContent = 'Settings';
  modalBody.innerHTML = `
    <form id="settings-form">
      <div class="form-group">
        <label for="set-due-day">Rent due day (day of month)</label>
        <input type="number" id="set-due-day" min="1" max="28" value="${settings?.rent_due_day ?? 5}" required />
        <small style="color:var(--text-muted);">Payments made after this day are marked LATE.</small>
      </div>
      <div class="form-group">
        <label for="set-water-rate">Default water rate (KES per unit)</label>
        <input type="number" id="set-water-rate" min="0" step="1" value="${settings?.default_water_rate ?? 150}" required />
      </div>
      <div class="form-group">
        <label for="set-property-target">How many properties are you planning to manage?</label>
        <input type="number" id="set-property-target" min="0" step="1" value="${settings?.target_property_count ?? ''}" placeholder="Optional" />
        <small style="color:var(--text-muted);">Shown on your dashboard as a simple progress reference.</small>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="cancel-settings-btn">Cancel</button>
        <button type="submit" class="btn btn-primary">Save Settings</button>
      </div>
    </form>
  `;
  modalOverlay.style.display = 'flex';

  document.getElementById('settings-form').onsubmit = async (e) => {
    e.preventDefault();
    const dueDay = parseInt(document.getElementById('set-due-day').value, 10);
    const waterRate = parseFloat(document.getElementById('set-water-rate').value);
    const targetRaw = document.getElementById('set-property-target').value;
    const target = targetRaw === '' ? null : parseInt(targetRaw, 10);

    const { error } = await supabase.from('app_settings').upsert({
      owner_id: ownerId,
      rent_due_day: dueDay,
      default_water_rate: waterRate,
      target_property_count: target
    }, { onConflict: 'owner_id' });

    if (error) { showToast('Error saving settings: ' + error.message, 'error'); return; }
    modalOverlay.style.display = 'none';
  };

  document.getElementById('cancel-settings-btn').onclick = () => { modalOverlay.style.display = 'none'; };
  document.getElementById('close-modal-btn').onclick = () => { modalOverlay.style.display = 'none'; };
}

// --- APPEARANCE (client-side only, per-browser) ---

export function initTheme() {
  const saved = localStorage.getItem('rm-theme');
  if (saved === 'dark') { document.documentElement.classList.add('dark-theme'); document.body.classList.add('dark-theme'); }
}

export function toggleTheme() {
  document.documentElement.classList.toggle('dark-theme');
  document.body.classList.toggle('dark-theme');
  localStorage.setItem('rm-theme', document.body.classList.contains('dark-theme') ? 'dark' : 'light');
}

// --- PAYMENT HISTORY (custom range + property, with CSV export) ---

export async function openHistoryModal(supabase) {
  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');

  const { data: properties } = await supabase.from('properties').select('*');
  const propertyOptions = ['<option value="all">All Properties</option>']
    .concat((properties || []).map(p => `<option value="${p.id}">${p.name}</option>`)).join('');

  const todayStr = todayLocalISO();
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const yearAgoStr = toLocalISODate(oneYearAgo);

  modalTitle.textContent = 'Payment History';
  modalBody.innerHTML = `
    <div class="form-group"><label for="hist-property">Property</label><select id="hist-property">${propertyOptions}</select></div>
    <div style="display:flex; gap:0.75rem;">
      <div class="form-group" style="flex:1;"><label for="hist-start">From</label><input type="date" id="hist-start" value="${yearAgoStr}" /></div>
      <div class="form-group" style="flex:1;"><label for="hist-end">To</label><input type="date" id="hist-end" value="${todayStr}" /></div>
    </div>
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
      <button id="hist-run-btn" class="btn btn-primary">Filter</button>
      <button id="hist-export-btn" class="btn btn-secondary">Export CSV</button>
    </div>
    <div style="max-height:320px; overflow-y:auto;">
      <table class="data-table">
        <thead><tr><th>Date</th><th>Property / Unit</th><th>Tenant</th><th>Target Month</th><th>Type</th><th>Amount</th><th>Status</th></tr></thead>
        <tbody id="hist-table-body"><tr><td colspan="7" style="text-align:center;">Loading…</td></tr></tbody>
      </table>
    </div>
    <div class="modal-actions"><button type="button" class="btn btn-secondary" id="close-history-btn">Close</button></div>
  `;
  modalOverlay.style.display = 'flex';

  let currentRows = [];

  async function runFilter() {
    const tbody = document.getElementById('hist-table-body');
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">Loading…</td></tr>';

    const propertyId = document.getElementById('hist-property').value;
    const start = document.getElementById('hist-start').value;
    const end = document.getElementById('hist-end').value;

    let unitQuery = supabase.from('units').select('id, house_number, properties(name)');
    if (propertyId !== 'all') unitQuery = unitQuery.eq('property_id', propertyId);
    const { data: units } = await unitQuery;
    const unitIds = (units || []).map(u => u.id);
    const unitById = {};
    (units || []).forEach(u => { unitById[u.id] = u; });

    if (unitIds.length === 0) { tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No units found.</td></tr>'; currentRows = []; return; }

    const { data: tenants } = await supabase.from('tenants').select('id, full_name, unit_id').in('unit_id', unitIds);
    const tenantById = {};
    (tenants || []).forEach(t => { tenantById[t.id] = t; });
    const tenantIds = (tenants || []).map(t => t.id);

    if (tenantIds.length === 0) { tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No tenants found.</td></tr>'; currentRows = []; return; }

    let paymentsQuery = supabase.from('payment_logs').select('*').in('tenant_id', tenantIds).order('payment_date', { ascending: false });
    if (start) paymentsQuery = paymentsQuery.gte('period_month', start);
    if (end) paymentsQuery = paymentsQuery.lte('period_month', end);
    const { data: payments } = await paymentsQuery;

    currentRows = (payments || []).map(p => {
      const tenant = tenantById[p.tenant_id];
      const unit = tenant ? unitById[tenant.unit_id] : null;
      return {
        date: parseLocalDate(p.payment_date).toLocaleDateString(),
        propertyUnit: unit ? `${unit.properties?.name || ''} - ${unit.house_number}` : '—',
        tenant: tenant?.full_name || '—',
        month: parseLocalDate(p.period_month).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
        type: p.payment_type,
        amount: parseFloat(p.amount_paid) || 0,
        status: p.status
      };
    });

    if (currentRows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No payments in this range.</td></tr>';
      return;
    }

    tbody.innerHTML = currentRows.map(r => `
      <tr>
        <td>${r.date}</td><td>${r.propertyUnit}</td><td>${r.tenant}</td><td>${r.month}</td>
        <td>${r.type}</td><td>KES ${r.amount.toLocaleString()}</td><td>${r.status}</td>
      </tr>
    `).join('');
  }

  document.getElementById('hist-run-btn').onclick = runFilter;
  document.getElementById('hist-export-btn').onclick = () => {
    if (currentRows.length === 0) { showToast('No data to export — run a filter first.', 'info'); return; }
    const header = 'Date,Property/Unit,Tenant,Target Month,Type,Amount,Status\n';
    const csv = header + currentRows.map(r =>
      [r.date, r.propertyUnit, r.tenant, r.month, r.type, r.amount, r.status]
        .map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
    ).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payment-history-${todayLocalISO()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  document.getElementById('close-history-btn').onclick = () => { modalOverlay.style.display = 'none'; };
  document.getElementById('close-modal-btn').onclick = () => { modalOverlay.style.display = 'none'; };

  runFilter();
}

// --- TENANT SETTINGS (name, phone, move-in date, billing start — all in one place) ---

export function openTenantSettingsModal(supabase, tenant, onSuccess) {
  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');

  const moveInIso = tenant.move_in_date ? String(tenant.move_in_date).slice(0, 10) : todayLocalISO();
  const currentMonthFirst = currentMonthFirstLocal();
  const anchor = tenant.rent_anchor_date;
  let initialMode = 'movein';
  if (anchor) initialMode = anchor === currentMonthFirst ? 'fresh' : 'custom';
  const customAnchorValue = initialMode === 'custom' ? anchor : moveInIso;

  modalTitle.textContent = `Tenant Settings: ${tenant.full_name}`;
  modalBody.innerHTML = `
    <form id="tenant-settings-form">
      <div class="form-group"><label for="ts-name">Full Name</label><input type="text" id="ts-name" value="${tenant.full_name}" required /></div>
      <div class="form-group"><label for="ts-phone">Phone Number</label><input type="tel" id="ts-phone" value="${tenant.phone_number || ''}" /></div>
      <div class="form-group"><label for="ts-movein">Move-in Date</label><input type="date" id="ts-movein" value="${moveInIso}" required /></div>

      <fieldset class="form-group" style="border:none; padding:0; margin:1rem 0;">
        <legend style="font-weight:600; margin-bottom:0.3rem; padding:0;">When should rent start counting from?</legend>
        <div style="display:flex; flex-direction:column; gap:0.5rem; margin-top:0.25rem;">
          <label style="display:flex; align-items:center; gap:0.5rem; font-weight:400;">
            <input type="radio" name="ts-billing-mode" value="movein" ${initialMode === 'movein' ? 'checked' : ''} /> Actual move-in date (full history, backfilled)
          </label>
          <label style="display:flex; align-items:center; gap:0.5rem; font-weight:400;">
            <input type="radio" name="ts-billing-mode" value="fresh" ${initialMode === 'fresh' ? 'checked' : ''} /> This month (start fresh, ignore past months)
          </label>
          <label style="display:flex; align-items:center; gap:0.5rem; font-weight:400;">
            <input type="radio" name="ts-billing-mode" value="custom" ${initialMode === 'custom' ? 'checked' : ''} /> Custom date:
          </label>
          <label for="ts-billing-custom" class="sr-only">Custom billing start date</label>
          <input type="date" id="ts-billing-custom" value="${customAnchorValue}" style="width:auto; margin-left:1.6rem;" />
        </div>
        <small style="color:var(--text-muted);">Current billing start: ${anchor || moveInIso}</small>
      </fieldset>

      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="cancel-ts-btn">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>
  `;
  modalOverlay.style.display = 'flex';

  document.getElementById('tenant-settings-form').onsubmit = async (e) => {
    e.preventDefault();
    const fullName = document.getElementById('ts-name').value.trim();
    const phone = document.getElementById('ts-phone').value.trim();
    const moveInDate = document.getElementById('ts-movein').value;
    const billingMode = document.querySelector('input[name="ts-billing-mode"]:checked')?.value || 'movein';

    let rentAnchorDate = null;
    if (billingMode === 'fresh') rentAnchorDate = currentMonthFirstLocal();
    else if (billingMode === 'custom') rentAnchorDate = document.getElementById('ts-billing-custom').value;

    const { error } = await supabase.from('tenants').update({
      full_name: fullName,
      phone_number: phone,
      move_in_date: moveInDate,
      lease_start: moveInDate,
      rent_anchor_date: rentAnchorDate
    }).eq('id', tenant.id);

    if (error) { showToast('Error saving tenant settings: ' + error.message, 'error'); return; }

    tenant.full_name = fullName;
    tenant.phone_number = phone;
    tenant.move_in_date = moveInDate;
    tenant.rent_anchor_date = rentAnchorDate;

    modalOverlay.style.display = 'none';
    if (onSuccess) onSuccess();
  };

  document.getElementById('cancel-ts-btn').onclick = () => { modalOverlay.style.display = 'none'; };
  document.getElementById('close-modal-btn').onclick = () => { modalOverlay.style.display = 'none'; };
}

export function openEditPropertyModal(supabase, property, onSuccess) {
  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');

  modalTitle.textContent = `Edit ${property.name}`;
  modalBody.innerHTML = `
    <form id="edit-property-form">
      <div class="form-group"><label for="ep-name">Property Name</label><input type="text" id="ep-name" value="${property.name}" required /></div>
      <div class="form-group">
        <label for="ep-water-rate">Water Rate (KES per unit)</label>
        <input type="number" id="ep-water-rate" value="${property.water_rate ?? ''}" placeholder="Leave blank to use your default rate" step="1" min="0" />
        <small style="color:var(--text-muted);">Only set this if water costs differ at this property. Otherwise your Settings default applies.</small>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="cancel-ep-btn">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>
  `;
  modalOverlay.style.display = 'flex';

  document.getElementById('edit-property-form').onsubmit = async (e) => {
    e.preventDefault();
    const name = document.getElementById('ep-name').value.trim();
    const rateRaw = document.getElementById('ep-water-rate').value;
    const waterRate = rateRaw === '' ? null : parseFloat(rateRaw);
    const { error } = await supabase.from('properties').update({ name, water_rate: waterRate }).eq('id', property.id);
    if (error) { showToast('Error updating property: ' + error.message, 'error'); return; }
    modalOverlay.style.display = 'none';
    if (onSuccess) onSuccess();
  };
  document.getElementById('cancel-ep-btn').onclick = () => { modalOverlay.style.display = 'none'; };
  document.getElementById('close-modal-btn').onclick = () => { modalOverlay.style.display = 'none'; };
}

// --- MOVED-OUT TENANTS (view + reinstate) ---

export async function openMovedOutTenantsModal(supabase, onSuccess) {
  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');

  modalTitle.textContent = 'Moved-Out Tenants';
  modalBody.innerHTML = `<div id="moved-out-list" style="max-height:400px; overflow-y:auto;">Loading…</div>
    <div class="modal-actions"><button type="button" class="btn btn-secondary" id="close-moved-out-btn">Close</button></div>`;
  modalOverlay.style.display = 'flex';

  document.getElementById('close-moved-out-btn').onclick = () => { modalOverlay.style.display = 'none'; };
  document.getElementById('close-modal-btn').onclick = () => { modalOverlay.style.display = 'none'; };

  const listEl = document.getElementById('moved-out-list');
  const { data: tenants, error } = await supabase
    .from('tenants').select('id, full_name, phone_number, move_in_date, unit_id, units(house_number, status, properties(name))')
    .eq('status', 'archived').order('move_in_date', { ascending: false });

  if (error) { listEl.innerHTML = `<p class="text-danger">Error loading: ${error.message}</p>`; return; }
  if (!tenants || tenants.length === 0) { listEl.innerHTML = '<p style="text-align:center; color:var(--text-muted);">No moved-out tenants on record.</p>'; return; }

  listEl.innerHTML = tenants.map(t => {
    const unit = t.units;
    const unitLabel = unit ? `${unit.properties?.name || ''} - ${unit.house_number}` : 'Unit removed';
    const unitVacant = unit?.status === 'vacant';
    return `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:0.6rem 0; border-bottom:1px solid var(--border);">
        <div>
          <strong>${t.full_name}</strong> <span style="color:var(--text-muted); font-size:0.85rem;">— ${unitLabel}</span>
        </div>
        <button class="btn btn-secondary" data-reinstate="${t.id}" data-unit="${t.unit_id}" ${unitVacant ? '' : 'disabled title="Unit is occupied — move that tenant out first, or assign this tenant to a different unit manually"'} style="padding:0.3rem 0.6rem; font-size:0.85rem;">
          ${unitVacant ? 'Reinstate' : 'Unit occupied'}
        </button>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('[data-reinstate]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tenantId = btn.dataset.reinstate;
      const unitId = btn.dataset.unit;
      const okReinstate = await showConfirm({ title: 'Reinstate Tenant', message: 'Reinstate this tenant as active on their original unit?', confirmLabel: 'Reinstate' });
      if (!okReinstate) return;
      await supabase.from('tenants').update({ status: 'active' }).eq('id', tenantId);
      await supabase.from('units').update({ status: 'occupied' }).eq('id', unitId);
      modalOverlay.style.display = 'none';
      if (onSuccess) onSuccess();
    });
  });
}

// --- MAINTENANCE COSTS ---

export async function openLogMaintenanceModal(supabase, onSuccess) {
  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');

  const { data: properties } = await supabase.from('properties').select('id, name');
  if (!properties || properties.length === 0) { showToast('Add a property first.', 'info'); return; }

  modalTitle.textContent = 'Log Maintenance Cost';
  const propertyOptions = properties.map(p => `<option value="${p.id}">${p.name}</option>`).join('');

  modalBody.innerHTML = `
    <form id="maintenance-form">
      <div class="form-group"><label for="maint-property">Property</label><select id="maint-property">${propertyOptions}</select></div>
      <fieldset class="form-group" style="border:none; padding:0; margin:1rem 0;">
        <legend style="font-weight:600; margin-bottom:0.3rem; padding:0;">Scope</legend>
        <div style="display:flex; gap:1rem;">
          <label style="display:flex; align-items:center; gap:0.4rem; font-weight:400;"><input type="radio" name="maint-scope" value="general" checked /> General (whole property)</label>
          <label style="display:flex; align-items:center; gap:0.4rem; font-weight:400;"><input type="radio" name="maint-scope" value="unit" /> Specific unit</label>
        </div>
      </fieldset>
      <div class="form-group" id="maint-unit-group" style="display:none;">
        <label for="maint-unit">Unit</label>
        <select id="maint-unit"><option>Loading…</option></select>
      </div>
      <div class="form-group"><label for="maint-description">Description</label><input type="text" id="maint-description" placeholder="e.g. Plumbing repair, painting" /></div>
      <div class="form-group"><label for="maint-cost">Cost (KES)</label><input type="number" id="maint-cost" step="0.01" min="0" required /></div>
      <div class="form-group"><label for="maint-date">Date</label><input type="date" id="maint-date" value="${todayLocalISO()}" required /></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="cancel-maint-btn">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>
  `;
  modalOverlay.style.display = 'flex';

  const scopeRadios = document.querySelectorAll('input[name="maint-scope"]');
  const unitGroup = document.getElementById('maint-unit-group');
  const unitSelect = document.getElementById('maint-unit');
  const propertySelect = document.getElementById('maint-property');

  async function loadUnitsForSelectedProperty() {
    const { data: units } = await supabase.from('units').select('id, house_number').eq('property_id', propertySelect.value);
    unitSelect.innerHTML = (units || []).map(u => `<option value="${u.id}">${u.house_number}</option>`).join('') || '<option value="">No units</option>';
  }

  scopeRadios.forEach(r => r.addEventListener('change', () => {
    const isUnit = document.querySelector('input[name="maint-scope"]:checked').value === 'unit';
    unitGroup.style.display = isUnit ? 'block' : 'none';
    if (isUnit) loadUnitsForSelectedProperty();
  }));
  propertySelect.addEventListener('change', () => {
    if (document.querySelector('input[name="maint-scope"]:checked').value === 'unit') loadUnitsForSelectedProperty();
  });

  document.getElementById('maintenance-form').onsubmit = async (e) => {
    e.preventDefault();
    const propertyId = propertySelect.value;
    const isUnitScope = document.querySelector('input[name="maint-scope"]:checked').value === 'unit';
    const unitId = isUnitScope ? unitSelect.value : null;
    const description = document.getElementById('maint-description').value.trim() || null;
    const cost = parseFloat(document.getElementById('maint-cost').value);
    const maintenanceDate = document.getElementById('maint-date').value;

    const { error } = await supabase.from('maintenance_logs').insert([{
      property_id: propertyId, unit_id: unitId, description, cost, maintenance_date: maintenanceDate
    }]);
    if (error) { showToast('Error saving maintenance cost: ' + error.message, 'error'); return; }

    modalOverlay.style.display = 'none';
    if (onSuccess) onSuccess();
  };

  document.getElementById('cancel-maint-btn').onclick = () => { modalOverlay.style.display = 'none'; };
  document.getElementById('close-modal-btn').onclick = () => { modalOverlay.style.display = 'none'; };
}

export async function loadMaintenanceList(supabase, propertyId = 'all') {
  const container = document.getElementById('maintenance-list');
  const totalEl = document.getElementById('maintenance-total');
  if (!container) return;
  container.innerHTML = '<p style="color:var(--text-muted);">Loading…</p>';

  let query = supabase.from('maintenance_logs')
    .select('id, cost, description, maintenance_date, property_id, unit_id, properties(name), units(house_number)')
    .order('maintenance_date', { ascending: false });
  if (propertyId !== 'all') query = query.eq('property_id', propertyId);

  const { data: logs, error } = await query;
  if (error) { container.innerHTML = `<p class="text-danger">Error loading maintenance logs: ${error.message}</p>`; return; }

  const total = (logs || []).reduce((sum, l) => sum + (parseFloat(l.cost) || 0), 0);
  if (totalEl) totalEl.textContent = `KES ${total.toLocaleString()}`;

  if (!logs || logs.length === 0) { container.innerHTML = '<p style="color:var(--text-muted);">No maintenance costs logged yet.</p>'; return; }

  container.innerHTML = logs.map(l => {
    const scopeLabel = l.unit_id ? `${l.properties?.name || ''} - ${l.units?.house_number || ''}` : `${l.properties?.name || ''} (general)`;
    return `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:0.5rem 0; border-bottom:1px solid var(--border);">
        <div>
          <strong>KES ${(parseFloat(l.cost) || 0).toLocaleString()}</strong> — ${scopeLabel}
          ${l.description ? `<div style="font-size:0.8rem; color:var(--text-muted);">${l.description}</div>` : ''}
        </div>
        <div style="display:flex; align-items:center; gap:0.6rem;">
          <span style="font-size:0.8rem; color:var(--text-muted);">${parseLocalDate(l.maintenance_date).toLocaleDateString()}</span>
          <button class="btn-icon-delete" data-delete-maint="${l.id}" title="Delete" aria-label="Delete">&times;</button>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('[data-delete-maint]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const okDeleteMaint = await showConfirm({ title: 'Delete Maintenance Record', message: 'Delete this maintenance record? This cannot be undone.', confirmLabel: 'Delete', danger: true });
      if (!okDeleteMaint) return;
      await supabase.from('maintenance_logs').delete().eq('id', btn.dataset.deleteMaint);
      loadMaintenanceList(supabase, propertyId);
    });
  });
}

// --- WATER BILL RECONCILIATION (property-level: billed vs metered vs collected) ---

export async function openLogWaterBillModal(supabase, propertyId, onSuccess) {
  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');

  modalTitle.textContent = 'Log Water Bill';
  modalBody.innerHTML = `
    <form id="water-bill-form">
      <div class="form-group"><label for="wb-period">Billing Period</label><input type="month" id="wb-period" value="${currentMonthFirstLocal().slice(0, 7)}" required /></div>
      <div class="form-group"><label for="wb-amount">Bill Amount (KES)</label><input type="number" id="wb-amount" step="0.01" min="0" required /></div>
      <div class="form-group"><label for="wb-notes">Notes (optional)</label><input type="text" id="wb-notes" placeholder="e.g. includes an estimated reading" /></div>
      <p style="font-size:0.82rem; color:var(--text-muted);">Logging a period that's already been billed will overwrite it.</p>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="cancel-wb-btn">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>
  `;
  modalOverlay.style.display = 'flex';

  document.getElementById('water-bill-form').onsubmit = async (e) => {
    e.preventDefault();
    const [y, m] = document.getElementById('wb-period').value.split('-');
    const periodMonth = `${y}-${m}-01`;
    const billAmount = parseFloat(document.getElementById('wb-amount').value);
    const notes = document.getElementById('wb-notes').value.trim() || null;

    const { error } = await supabase.from('property_water_bills').upsert(
      { property_id: propertyId, period_month: periodMonth, bill_amount: billAmount, notes },
      { onConflict: 'property_id,period_month' }
    );

    if (error) { showToast('Error saving water bill: ' + error.message, 'error'); return; }
    modalOverlay.style.display = 'none';
    if (onSuccess) onSuccess();
  };

  document.getElementById('cancel-wb-btn').onclick = () => { modalOverlay.style.display = 'none'; };
  document.getElementById('close-modal-btn').onclick = () => { modalOverlay.style.display = 'none'; };
}

/**
 * Three-way comparison per billed period for a property:
 * Billed (what the water company charged) vs Metered (sum of unit readings' cost, what the
 * meters say usage should be) vs Collected (sum of tenant water payments). The gap between
 * Billed and Metered is common-area usage/loss; the gap between Metered and Collected is arrears.
 * Only meaningful per-property — hidden entirely when "All Properties" is selected.
 */
export async function loadWaterReconciliation(supabase, propertyId) {
  const wrapper = document.getElementById('water-reconciliation-wrapper');
  const container = document.getElementById('water-reconciliation-list');
  if (!wrapper || !container) return;

  if (!propertyId || propertyId === 'all') {
    wrapper.style.display = 'none';
    return;
  }
  wrapper.style.display = 'block';
  container.innerHTML = '<p style="color:var(--text-muted);">Loading…</p>';

  const { data: bills } = await supabase.from('property_water_bills')
    .select('*').eq('property_id', propertyId).order('period_month', { ascending: false });

  if (!bills || bills.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);">No water bills logged for this property yet. Log one to start reconciling billed vs. metered vs. collected.</p>';
    return;
  }

  const { data: units } = await supabase.from('units').select('id').eq('property_id', propertyId);
  const unitIds = (units || []).map(u => u.id);
  const periods = bills.map(b => b.period_month);

  let meteredByPeriod = {};
  if (unitIds.length > 0) {
    const { data: readings } = await supabase.from('water_readings')
      .select('period_month, total_cost').in('unit_id', unitIds).in('period_month', periods);
    (readings || []).forEach(r => {
      meteredByPeriod[r.period_month] = (meteredByPeriod[r.period_month] || 0) + (parseFloat(r.total_cost) || 0);
    });
  }

  let collectedByPeriod = {};
  if (unitIds.length > 0) {
    const { data: tenants } = await supabase.from('tenants').select('id').in('unit_id', unitIds);
    const tenantIds = (tenants || []).map(t => t.id);
    if (tenantIds.length > 0) {
      const { data: payments } = await supabase.from('payment_logs')
        .select('period_month, amount_paid').in('tenant_id', tenantIds).eq('payment_type', 'water').in('period_month', periods);
      (payments || []).forEach(p => {
        collectedByPeriod[p.period_month] = (collectedByPeriod[p.period_month] || 0) + (parseFloat(p.amount_paid) || 0);
      });
    }
  }

  container.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Period</th><th>Billed</th><th>Metered (Units)</th><th>Collected (Tenants)</th><th>Unaccounted</th><th>Collection Gap</th><th></th></tr></thead>
      <tbody>
        ${bills.map(b => {
          const billed = parseFloat(b.bill_amount) || 0;
          const metered = meteredByPeriod[b.period_month] || 0;
          const collected = collectedByPeriod[b.period_month] || 0;
          const unaccounted = billed - metered;
          const gap = metered - collected;
          return `
            <tr>
              <td><strong>${parseLocalDate(b.period_month).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</strong>${b.notes ? `<div style="font-size:0.75rem; color:var(--text-muted);">${b.notes}</div>` : ''}</td>
              <td>KES ${billed.toLocaleString()}</td>
              <td>KES ${metered.toLocaleString()}</td>
              <td>KES ${collected.toLocaleString()}</td>
              <td style="color:${unaccounted > 0 ? 'var(--warning)' : 'var(--success)'}; font-weight:600;">KES ${unaccounted.toLocaleString()}</td>
              <td style="color:${gap > 0 ? 'var(--danger)' : 'var(--success)'}; font-weight:600;">KES ${gap.toLocaleString()}</td>
              <td><button class="btn-icon-delete" data-delete-bill="${b.id}" title="Delete" aria-label="Delete">&times;</button></td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
    <p style="font-size:0.78rem; color:var(--text-muted); margin-top:0.5rem;">
      <strong>Unaccounted</strong> = billed minus what your unit meters say usage should cost — likely common-area use, leaks, or estimate variance.
      <strong>Collection Gap</strong> = metered cost minus what tenants have actually paid so far.
    </p>
  `;

  container.querySelectorAll('[data-delete-bill]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ok = await showConfirm({ title: 'Delete Water Bill', message: 'Delete this water bill record? This cannot be undone.', confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      await supabase.from('property_water_bills').delete().eq('id', btn.dataset.deleteBill);
      loadWaterReconciliation(supabase, propertyId);
    });
  });
}

export function openEditUnitModal(supabase, unit, onSuccess) {
  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');

  modalTitle.textContent = `Edit ${unit.house_number}`;
  modalBody.innerHTML = `
    <form id="edit-unit-form">
      <div class="form-group"><label for="edit-unit-number">House / Unit Number</label><input type="text" id="edit-unit-number" value="${unit.house_number}" required /></div>
      <div class="form-group"><label for="edit-unit-rent">Base Monthly Rent (KES)</label><input type="number" id="edit-unit-rent" value="${unit.base_rent}" step="0.01" required /></div>
      <div class="form-group">
        <label for="edit-unit-status">Status</label>
        <select id="edit-unit-status">
          <option value="vacant" ${unit.status === 'vacant' ? 'selected' : ''}>Vacant</option>
          <option value="occupied" ${unit.status === 'occupied' ? 'selected' : ''}>Occupied</option>
          <option value="maintenance" ${unit.status === 'maintenance' ? 'selected' : ''}>Maintenance</option>
        </select>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="cancel-edit-unit-btn">Cancel</button>
        <button type="submit" class="btn btn-primary">Save Changes</button>
      </div>
    </form>
  `;
  modalOverlay.style.display = 'flex';

  document.getElementById('edit-unit-form').onsubmit = async (e) => {
    e.preventDefault();
    const houseNumber = document.getElementById('edit-unit-number').value.trim();
    const baseRent = parseFloat(document.getElementById('edit-unit-rent').value);
    const status = document.getElementById('edit-unit-status').value;
    const { error } = await supabase.from('units').update({ house_number: houseNumber, base_rent: baseRent, status }).eq('id', unit.id);
    if (error) { showToast('Error updating unit: ' + error.message, 'error'); return; }
    modalOverlay.style.display = 'none';
    if (onSuccess) onSuccess();
  };
  document.getElementById('cancel-edit-unit-btn').onclick = () => { modalOverlay.style.display = 'none'; };
  document.getElementById('close-modal-btn').onclick = () => { modalOverlay.style.display = 'none'; };
}
