/**
 * app.js
 * Main frontend application logic.
 */

import {
  loadTenantLedger,
  openPaymentModal,
  openWaterModal,
  loadWaterReadings,
  openDocumentModal,
  loadDocuments,
  openAddPropertyModal,
  openEditPropertyModal,
  openAddUnitModal,
  openEditUnitModal,
  openSettingsModal,
  initTheme,
  toggleTheme,
  updateDashboardStats,
  formatDuration,
  getTenantBalance,
  getPresetRange,
  openHistoryModal,
  openTenantSettingsModal,
  getRentTrackingStatuses,
  getWaterStatuses,
  openMovedOutTenantsModal,
  openLogMaintenanceModal,
  loadMaintenanceList,
  openLogWaterBillModal,
  loadWaterReconciliation,
  parseLocalDate,
  todayLocalISO,
  showToast,
  showConfirm
} from './ledgerEngine.js?v=20260828a';

import { setupAuthScreen, showAuthScreen, showApp, getSession, onAuthChange, onPasswordRecovery, signOut } from './auth.js?v=20260828a';

// 1. Initialize Supabase Client
const SUPABASE_URL = 'https://bqgdlpxydyrptiomiyev.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJxZ2RscHh5ZHlycHRpb21peWV2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5MjQyMjMsImV4cCI6MjEwMTUwMDIyM30.6P87NwA3-FWEPUyu4jg1GQb6Bk2odqksU4Y4gREl4EI';
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// 2. DOM Elements
const propertyTabsContainer = document.getElementById('property-tabs');
const unitsGrid = document.getElementById('units-grid');
const drawerOverlay = document.getElementById('drawer-overlay');
const tenantDrawer = document.getElementById('tenant-drawer');
const closeDrawerBtn = document.getElementById('close-drawer-btn');
const addPropertyBtn = document.getElementById('add-property-btn');
const addUnitBtn = document.getElementById('add-unit-btn');
const logoutBtn = document.getElementById('logout-btn');

let currentRange = { start: null, end: null }; // 'To Date' by default

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  setupDrawerInteractions();
  setupActionButtons();
  setupAccessibilityHandlers();

  const { showResetPasswordCard } = setupAuthScreen(supabase, async (session) => {
    showApp(session);
    await loadProperties();
  });

  // Fallback for the recovery event firing after this check (e.g. a slow client init).
  onPasswordRecovery(supabase, () => {
    showAuthScreen();
    showResetPasswordCard();
  });

  // Checked synchronously (not awaited) so there's no race against getSession() below —
  // a recovery link must never fall through to auto-login straight into the dashboard.
  const isRecoveryLink = window.location.hash.includes('type=recovery');

  if (isRecoveryLink) {
    showAuthScreen();
    showResetPasswordCard();
  } else {
    const session = await getSession(supabase);
    if (session) {
      showApp(session);
      await loadProperties();
    } else {
      showAuthScreen();
    }
  }

  onAuthChange(supabase, (session) => {
    if (!session) showAuthScreen();
  });
});

function setupActionButtons() {
  if (addPropertyBtn) {
    addPropertyBtn.addEventListener('click', () => openAddPropertyModal(supabase, loadProperties));
  }
  if (addUnitBtn) {
    addUnitBtn.addEventListener('click', () => {
      openAddUnitModal(supabase, () => {
        const activeTab = document.querySelector('.tab-btn.active');
        loadUnitsForProperty(activeTab ? activeTab.dataset.propertyId : 'all');
      });
    });
  }
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await signOut(supabase);
      showAuthScreen();
    });
  }
  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) settingsBtn.addEventListener('click', () => openSettingsModal(supabase));

  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  if (themeToggleBtn) themeToggleBtn.addEventListener('click', toggleTheme);

  const customRangePanel = document.getElementById('custom-range-panel');
  const customPeriodBtn = document.getElementById('custom-period-btn');

  document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.period === 'custom') {
        const isOpen = customRangePanel.style.display === 'flex';
        customRangePanel.style.display = isOpen ? 'none' : 'flex';
        customPeriodBtn.setAttribute('aria-expanded', String(!isOpen));
        return; // Revealing the date pickers isn't itself a range change — wait for Apply.
      }
      customRangePanel.style.display = 'none';
      customPeriodBtn.setAttribute('aria-expanded', 'false');
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentRange = getPresetRange(btn.dataset.period);
      const activeTab = document.querySelector('.tab-btn.active');
      updateDashboardStats(supabase, activeTab ? activeTab.dataset.propertyId : 'all', currentRange);
    });
  });

  const applyCustomBtn = document.getElementById('apply-custom-range-btn');
  if (applyCustomBtn) {
    applyCustomBtn.addEventListener('click', () => {
      const startVal = document.getElementById('custom-range-start').value;
      const endVal = document.getElementById('custom-range-end').value;
      if (!startVal && !endVal) { showToast('Pick at least one date first.', 'info'); return; }
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
      customPeriodBtn.classList.add('active');
      currentRange = { start: startVal ? parseLocalDate(startVal) : null, end: endVal ? parseLocalDate(endVal) : null };
      const activeTab = document.querySelector('.tab-btn.active');
      updateDashboardStats(supabase, activeTab ? activeTab.dataset.propertyId : 'all', currentRange);
    });
  }

  const historyBtn = document.getElementById('open-history-btn');
  if (historyBtn) historyBtn.addEventListener('click', () => openHistoryModal(supabase));

  const movedOutBtn = document.getElementById('open-moved-out-btn');
  if (movedOutBtn) {
    movedOutBtn.addEventListener('click', () => {
      openMovedOutTenantsModal(supabase, () => {
        const activeTab = document.querySelector('.tab-btn.active');
        loadUnitsForProperty(activeTab ? activeTab.dataset.propertyId : 'all');
      });
    });
  }

  const logMaintenanceBtn = document.getElementById('log-maintenance-btn');
  if (logMaintenanceBtn) {
    logMaintenanceBtn.addEventListener('click', () => {
      openLogMaintenanceModal(supabase, () => {
        const activeTab = document.querySelector('.tab-btn.active');
        loadMaintenanceList(supabase, activeTab ? activeTab.dataset.propertyId : 'all');
      });
    });
  }

  const logWaterBillBtn = document.getElementById('log-water-bill-btn');
  if (logWaterBillBtn) {
    logWaterBillBtn.addEventListener('click', () => {
      const activeTab = document.querySelector('.tab-btn.active');
      const propertyId = activeTab ? activeTab.dataset.propertyId : 'all';
      if (!propertyId || propertyId === 'all') {
        showToast('Select a specific property tab first — water bills are per-property.', 'info');
        return;
      }
      openLogWaterBillModal(supabase, propertyId, () => loadWaterReconciliation(supabase, propertyId));
    });
  }
}

// --- DATA FETCHING & RENDERING ---

async function loadProperties() {
  const { data: properties, error } = await supabase.from('properties').select('*');
  if (error) { console.error('Error fetching properties:', error); return; }

  propertyTabsContainer.innerHTML = '<button class="tab-btn active" data-property-id="all">All Properties</button>';
  const allTabBtn = propertyTabsContainer.querySelector('[data-property-id="all"]');
  allTabBtn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    allTabBtn.classList.add('active');
    loadUnitsForProperty('all');
  });

  const { data: { session } } = await supabase.auth.getSession();
  const { data: settings } = await supabase.from('app_settings').select('target_property_count').eq('owner_id', session?.user?.id).maybeSingle();
  const progressEl = document.getElementById('property-target-progress');
  if (progressEl) {
    if (settings?.target_property_count) {
      progressEl.textContent = `${(properties || []).length} of ${settings.target_property_count} properties`;
      progressEl.style.display = 'inline';
    } else {
      progressEl.style.display = 'none';
    }
  }

  (properties || []).forEach(prop => {
    const wrapper = document.createElement('span');
    wrapper.style.cssText = 'display:inline-flex; align-items:center; gap:0.15rem;';

    const btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.textContent = prop.name;
    btn.dataset.propertyId = prop.id;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadUnitsForProperty(prop.id);
    });

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.textContent = '✎';
    editBtn.title = `Edit ${prop.name} (name, water rate)`;
    editBtn.setAttribute('aria-label', `Edit ${prop.name}`);
    editBtn.style.cssText = 'background:none; border:none; color:var(--text-muted); cursor:pointer; font-size:0.9rem; padding:0 0.3rem;';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditPropertyModal(supabase, prop, loadProperties);
    });

    wrapper.appendChild(btn);
    wrapper.appendChild(editBtn);
    propertyTabsContainer.appendChild(wrapper);
  });

  loadUnitsForProperty('all');
}

/** Re-renders the unit cards so LATE/DUE/PAID and water badges never go stale after an
 *  in-drawer action (payment, water log, billing-start change). The grid isn't visible while
 *  the drawer is open, so a full reload here is safe and simplest to keep correct. */
function refreshUnitCardInPlace(unitId, propertyScopeId) {
  loadUnitsForProperty(propertyScopeId || 'all');
}

async function loadUnitsForProperty(propertyId) {
  unitsGrid.innerHTML = '<p>Loading units...</p>';
  updateDashboardStats(supabase, propertyId, currentRange);
  loadMaintenanceList(supabase, propertyId);
  loadWaterReconciliation(supabase, propertyId);

  let query = supabase.from('units').select(`
    id, house_number, base_rent, status, property_id,
    properties ( name ),
    tenants ( id, full_name, status, move_in_date, rent_anchor_date )
  `);
  if (propertyId !== 'all') query = query.eq('property_id', propertyId);

  const { data: units, error } = await query;
  if (error) { console.error('Error fetching units:', error); unitsGrid.innerHTML = '<p class="text-danger">Failed to load units.</p>'; return; }

  unitsGrid.innerHTML = '';
  if (!units || units.length === 0) { unitsGrid.innerHTML = '<p>No units found for this property.</p>'; return; }

  const tenantUnitPairs = [];
  units.forEach(unit => {
    const activeTenant = unit.tenants?.find(t => t.status === 'active');
    if (activeTenant) tenantUnitPairs.push({ tenant: activeTenant, baseRent: unit.base_rent, unitId: unit.id });
  });
  const [trackingStatuses, waterStatuses] = await Promise.all([
    getRentTrackingStatuses(supabase, tenantUnitPairs),
    getWaterStatuses(supabase, tenantUnitPairs)
  ]);

  units.forEach(unit => {
    const activeTenant = unit.tenants?.find(t => t.status === 'active');
    const tracking = activeTenant ? trackingStatuses[activeTenant.id] : null;
    const water = activeTenant ? waterStatuses[activeTenant.id] : null;

    let trackingHtml = '';
    if (tracking) {
      if (tracking.status === 'PAID') {
        trackingHtml = `<p style="font-size:0.8rem; color:var(--success);">✓ ${tracking.trackingLabel} paid</p>`;
      } else if (tracking.status === 'DUE') {
        trackingHtml = `<p style="font-size:0.8rem; color:var(--text-muted);">${tracking.trackingLabel}: KES ${tracking.amountOwing.toLocaleString()} due by ${tracking.dueDateLabel}</p>`;
      } else {
        const span = tracking.monthsBehind > 1 ? ` (${tracking.monthsBehind} months)` : '';
        trackingHtml = `<p style="font-size:0.8rem; color:var(--danger); font-weight:600;">LATE since ${tracking.lateLabel} — KES ${tracking.amountOwing.toLocaleString()} owing${span}</p>`;
      }
    }

    let waterHtml = '';
    if (activeTenant) {
      if (water && water.missingCount > 0) {
        const monthWord = water.missingCount > 1 ? 'months' : 'month';
        waterHtml = `<p style="font-size:0.8rem; color:var(--warning); font-weight:600;">💧 ${water.missingCount} ${monthWord} of readings missing since ${water.earliestMissingLabel}</p>`;
      } else if (water && water.isPaid) {
        waterHtml = `<p style="font-size:0.8rem; color:var(--success);">💧 ${water.consumed} m³ — paid</p>`;
      } else if (water) {
        const owing = water.cost - water.paid;
        waterHtml = `<p style="font-size:0.8rem; color:var(--warning);">💧 ${water.consumed} m³ — KES ${owing.toLocaleString()} unpaid</p>`;
      }
    }

    const card = document.createElement('div');
    card.className = 'unit-card';
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'button');
    const cardLabel = activeTenant
      ? `${unit.properties ? unit.properties.name : 'Property'} ${unit.house_number}, tenant ${activeTenant.full_name}, open details`
      : `${unit.properties ? unit.properties.name : 'Property'} ${unit.house_number}, vacant, open details`;
    card.setAttribute('aria-label', cardLabel);
    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
        <h3>${unit.properties ? unit.properties.name : 'Property'} - ${unit.house_number}</h3>
        <span class="badge ${unit.status === 'occupied' ? 'badge-occupied' : 'badge-vacant'}">${unit.status.toUpperCase()}</span>
      </div>
      <p><strong>Tenant:</strong> ${activeTenant ? activeTenant.full_name : 'None'}</p>
      <p><strong>Rent:</strong> KES ${Number(unit.base_rent).toLocaleString()}</p>
      ${trackingHtml}
      ${waterHtml}
      <button type="button" class="btn btn-secondary btn-edit-unit" style="margin-top:0.5rem; padding:0.3rem 0.6rem; font-size:0.8rem;">Edit</button>
    `;
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-edit-unit')) return;
      openTenantDrawer(unit, activeTenant);
    });
    card.addEventListener('keydown', (e) => {
      if (e.target.classList.contains('btn-edit-unit')) return; // let the Edit button handle its own Enter/Space
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openTenantDrawer(unit, activeTenant);
      }
    });
    card.querySelector('.btn-edit-unit').addEventListener('click', (e) => {
      e.stopPropagation();
      openEditUnitModal(supabase, unit, () => {
        const activeTab = document.querySelector('.tab-btn.active');
        loadUnitsForProperty(activeTab ? activeTab.dataset.propertyId : 'all');
      });
    });
    unitsGrid.appendChild(card);
  });
}

// --- DRAWER INTERACTION LOGIC ---

// --- ACCESSIBILITY: keyboard + focus management for modal-overlay and the tenant drawer ---

let lastFocusedBeforeModal = null;
let lastFocusedBeforeDrawer = null;

function getFocusable(container) {
  return Array.from(container.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  ));
}

function trapTabKey(e, container) {
  const focusables = getFocusable(container);
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function setupAccessibilityHandlers() {
  const modalOverlayEl = document.getElementById('modal-overlay');
  const modalContentEl = modalOverlayEl?.querySelector('.modal-content');

  // Automatically move focus into a modal the moment it opens (any of the ~15 modal-opening
  // functions across the app), and restore focus to whatever triggered it when it closes —
  // implemented once here via the shared #modal-overlay element, rather than touching every
  // individual modal function.
  if (modalOverlayEl) {
    const modalObserver = new MutationObserver(() => {
      const isOpen = modalOverlayEl.style.display === 'flex';
      if (isOpen) {
        lastFocusedBeforeModal = document.activeElement;
        const focusables = getFocusable(modalContentEl || modalOverlayEl);
        if (focusables.length > 0) focusables[0].focus();
      } else if (lastFocusedBeforeModal) {
        lastFocusedBeforeModal.focus();
        lastFocusedBeforeModal = null;
      }
    });
    modalObserver.observe(modalOverlayEl, { attributes: true, attributeFilter: ['style'] });
  }

  // Same idea for the tenant drawer.
  const drawerObserver = new MutationObserver(() => {
    const isOpen = tenantDrawer.classList.contains('open');
    if (isOpen) {
      lastFocusedBeforeDrawer = document.activeElement;
      const focusables = getFocusable(tenantDrawer);
      if (focusables.length > 0) focusables[0].focus();
    } else if (lastFocusedBeforeDrawer) {
      lastFocusedBeforeDrawer.focus();
      lastFocusedBeforeDrawer = null;
    }
  });
  drawerObserver.observe(tenantDrawer, { attributes: true, attributeFilter: ['class'] });

  document.addEventListener('keydown', (e) => {
    const modalIsOpen = modalOverlayEl && modalOverlayEl.style.display === 'flex';
    const drawerIsOpen = tenantDrawer.classList.contains('open');

    if (e.key === 'Escape') {
      if (modalIsOpen) { modalOverlayEl.style.display = 'none'; return; }
      if (drawerIsOpen) { closeDrawer(); return; }
    }

    if (e.key === 'Tab' && modalIsOpen) {
      trapTabKey(e, modalContentEl || modalOverlayEl);
    } else if (e.key === 'Tab' && drawerIsOpen && !modalIsOpen) {
      trapTabKey(e, tenantDrawer);
    }
  });
}

function setupDrawerInteractions() {
  if (closeDrawerBtn) closeDrawerBtn.addEventListener('click', closeDrawer);
  if (drawerOverlay) drawerOverlay.addEventListener('click', closeDrawer);

  document.querySelectorAll('.drawer-tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.drawer-tab-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
      const targetPane = document.getElementById(`tab-${e.target.dataset.tab}`);
      if (targetPane) targetPane.classList.add('active');
    });
  });
}

function renderTenantHeaderHtml(tenant, tb) {
  let badge;
  if (tb.status === 'LATE') {
    const span = tb.monthsBehind > 1 ? ` across ${tb.monthsBehind} months` : '';
    badge = `<span style="color:#dc2626; font-weight:600; margin-left:8px;">(LATE since ${tb.trackingLabel} — KES ${tb.owing.toLocaleString()} owing${span})</span>`;
  } else if (tb.status === 'DUE') {
    badge = `<span style="color:#b45309; font-weight:600; margin-left:8px;">(${tb.trackingLabel} due — KES ${tb.owing.toLocaleString()})</span>`;
  } else if (tb.credit > 0) {
    badge = `<span style="color:#0284c7; font-weight:600; margin-left:8px;">(Credit: +KES ${tb.credit.toLocaleString()})</span>`;
  } else {
    badge = `<span style="color:#16a34a; font-weight:600; margin-left:8px;">(Settled)</span>`;
  }
  return `Tenant: <strong>${tenant.full_name}</strong> ${badge} <span style="color:#94a3b8; font-size:0.8rem;">(Expected KES ${tb.expected.toLocaleString()} to date, paid KES ${tb.collected.toLocaleString()})</span>`;
}

export async function openTenantDrawer(unit, tenant) {
  const drawerTitle = document.getElementById('drawer-unit-title');
  const drawerTenantName = document.getElementById('drawer-tenant-name');
  const metaBanner = document.getElementById('drawer-tenant-meta');
  const actionContainer = document.getElementById('drawer-action-container');
  const btnLogWater = document.getElementById('btn-log-water');
  const btnUploadDoc = document.getElementById('btn-upload-doc');

  drawerTitle.textContent = `${unit.properties ? unit.properties.name : ''} - ${unit.house_number}`;
  drawerTenantName.textContent = tenant ? `Tenant: ${tenant.full_name}` : 'Tenant: Vacant';

  // Open right away — everything below this is async, and the click shouldn't feel frozen
  // while it resolves. The rest of the drawer fills in a moment later.
  drawerOverlay.classList.add('open');
  tenantDrawer.classList.add('open');
  actionContainer.innerHTML = '<span style="color:var(--text-muted); font-size:0.9rem;">Loading…</span>';

  if (btnLogWater) {
    btnLogWater.onclick = () => {
      const activeTab = document.querySelector('.tab-btn.active');
      openWaterModal(supabase, unit, tenant, null, () => {
        refreshUnitCardInPlace(unit.id, activeTab ? activeTab.dataset.propertyId : 'all');
      });
    };
  }
  if (btnUploadDoc) {
    btnUploadDoc.onclick = () => {
      openDocumentModal(supabase, unit.id, tenant ? tenant.id : null);
    };
  }

  if (tenant) {
    metaBanner.style.display = 'flex';
    const displayDate = tenant.move_in_date ? parseLocalDate(tenant.move_in_date).toLocaleDateString() : '—';

    metaBanner.innerHTML = `
      <div class="meta-item"><span class="meta-label">Move-in Date:</span><span class="meta-value">${displayDate}</span></div>
      <div class="meta-item"><span class="meta-label">Duration:</span><span class="meta-value" id="meta-tenancy-duration">${formatDuration(tenant.move_in_date)}</span></div>
    `;

    // These don't depend on the balance calculation, so start them now rather than after —
    // otherwise the tables sit showing the previous tenant's rows for the whole wait.
    document.getElementById('ledger-table-body').innerHTML = '<tr><td colspan="6" style="text-align:center;">Loading…</td></tr>';
    document.getElementById('water-table-body').innerHTML = '<tr><td colspan="7" style="text-align:center;">Loading…</td></tr>';
    document.getElementById('document-list').innerHTML = '<li>Loading…</li>';
    loadTenantLedger(supabase, tenant.id);
    loadWaterReadings(supabase, unit, tenant);
    loadDocuments(supabase, unit.id, tenant.id);

    const tb = await getTenantBalance(supabase, tenant, unit.base_rent);
    drawerTenantName.innerHTML = renderTenantHeaderHtml(tenant, tb);

    actionContainer.innerHTML = `
      <button id="btn-log-payment" class="btn btn-primary">+ Record Payment</button>
      <button id="btn-tenant-settings" class="btn btn-secondary" style="margin-left:0.5rem;">Tenant Settings</button>
      <button id="btn-move-out" class="btn btn-secondary" style="margin-left:0.5rem;">Move Out Tenant</button>
    `;

    document.getElementById('btn-tenant-settings').onclick = () => {
      openTenantSettingsModal(supabase, tenant, () => {
        const activeTab = document.querySelector('.tab-btn.active');
        const scopeId = activeTab ? activeTab.dataset.propertyId : 'all';
        updateDashboardStats(supabase, scopeId, currentRange);
        refreshUnitCardInPlace(unit.id, scopeId);
        openTenantDrawer(unit, tenant);
      });
    };

    document.getElementById('btn-log-payment').onclick = () => {
      openPaymentModal(supabase, unit, tenant, null, async () => {
        const activeTab = document.querySelector('.tab-btn.active');
        const scopeId = activeTab ? activeTab.dataset.propertyId : 'all';
        updateDashboardStats(supabase, scopeId, currentRange);
        // Refresh just the balance header (not the whole drawer, so the active tab stays put)...
        const refreshed = await getTenantBalance(supabase, tenant, unit.base_rent);
        drawerTenantName.innerHTML = renderTenantHeaderHtml(tenant, refreshed);
        // ...but the card behind the drawer also shows LATE/DUE/PAID and needs the same refresh,
        // otherwise it keeps showing a stale badge until the property tab is switched.
        refreshUnitCardInPlace(unit.id, scopeId);
      });
    };

    document.getElementById('btn-move-out').onclick = async () => {
      const ok = await showConfirm({
        title: 'Move Out Tenant',
        message: `Mark ${tenant.full_name} as moved out and free up ${unit.house_number}?`,
        confirmLabel: 'Move Out',
        danger: true
      });
      if (!ok) return;
      await supabase.from('tenants').update({ status: 'archived' }).eq('id', tenant.id);
      await supabase.from('units').update({ status: 'vacant' }).eq('id', unit.id);
      closeDrawer();
      const activeTab = document.querySelector('.tab-btn.active');
      loadUnitsForProperty(activeTab ? activeTab.dataset.propertyId : 'all');
    };

  } else {
    metaBanner.style.display = 'none';
    drawerTenantName.textContent = 'Tenant: Vacant';
    actionContainer.innerHTML = `<button id="assign-tenant-btn" class="btn btn-primary">+ Assign Tenant</button>`;
    document.getElementById('assign-tenant-btn').onclick = () => openAssignTenantModal(unit);
    document.getElementById('ledger-table-body').innerHTML = '<tr><td colspan="6" style="text-align:center;">Unit is vacant.</td></tr>';
    document.getElementById('water-table-body').innerHTML = '<tr><td colspan="7" style="text-align:center;">Unit is vacant.</td></tr>';
    loadDocuments(supabase, unit.id, null);
  }
}

function openAssignTenantModal(unit) {
  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');

  modalTitle.textContent = `Assign Tenant to ${unit.house_number}`;
  modalBody.innerHTML = `
    <form id="assign-tenant-form">
      <div class="form-group"><label for="tenant-name">Tenant Full Name</label><input type="text" id="tenant-name" placeholder="e.g. John Doe" required /></div>
      <div class="form-group"><label for="tenant-phone">Phone Number</label><input type="tel" id="tenant-phone" placeholder="e.g. +254712345678" required /></div>
      <div class="form-group"><label for="tenant-movein">Move-in Date</label><input type="date" id="tenant-movein" value="${todayLocalISO()}" required /></div>
      <div class="form-group" id="billing-start-group" style="display:none;">
        <label for="tenant-billing-mode">Rent Ledger Should Start From</label>
        <select id="tenant-billing-mode">
          <option value="movein">Move-in date (backfill all months owed since then)</option>
          <option value="fresh">This month (start fresh, ignore past months)</option>
        </select>
        <small style="color:var(--text-muted);">This tenant moved in before today — choose how far back to count rent as due.</small>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="cancel-assign-btn">Cancel</button>
        <button type="submit" class="btn btn-primary">Assign Tenant</button>
      </div>
    </form>
  `;
  modalOverlay.style.display = 'flex';

  const moveinInput = document.getElementById('tenant-movein');
  const billingGroup = document.getElementById('billing-start-group');
  const todayStr = todayLocalISO();
  function syncBillingGroupVisibility() {
    billingGroup.style.display = moveinInput.value && moveinInput.value < todayStr ? 'block' : 'none';
  }
  moveinInput.addEventListener('change', syncBillingGroupVisibility);
  syncBillingGroupVisibility();

  document.getElementById('assign-tenant-form').onsubmit = async (e) => {
    e.preventDefault();
    const tenantName = document.getElementById('tenant-name').value.trim();
    const phone = document.getElementById('tenant-phone').value.trim();
    const moveInDate = moveinInput.value;
    const billingMode = document.getElementById('tenant-billing-mode')?.value || 'movein';
    const rentAnchorDate = billingMode === 'fresh'
      ? `${todayStr.slice(0, 7)}-01`
      : null; // null = use move_in_date (backfill)

    const { error: tenantError } = await supabase.from('tenants').insert([{
      unit_id: unit.id, full_name: tenantName, phone_number: phone, status: 'active',
      lease_start: moveInDate, move_in_date: moveInDate, rent_anchor_date: rentAnchorDate
    }]);
    if (tenantError) { showToast('Failed to assign tenant: ' + tenantError.message, 'error'); return; }

    await supabase.from('units').update({ status: 'occupied' }).eq('id', unit.id);
    modalOverlay.style.display = 'none';
    closeDrawer();
    const activeTab = document.querySelector('.tab-btn.active');
    loadUnitsForProperty(activeTab ? activeTab.dataset.propertyId : 'all');
  };

  document.getElementById('cancel-assign-btn').onclick = () => { modalOverlay.style.display = 'none'; };
  document.getElementById('close-modal-btn').onclick = () => { modalOverlay.style.display = 'none'; };
}

function closeDrawer() {
  drawerOverlay.classList.remove('open');
  tenantDrawer.classList.remove('open');
}
