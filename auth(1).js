/**
 * auth.js
 * Supabase Auth session handling for the Rental Manager.
 * Simple model for now: any authenticated user has full landlord-level access.
 * (Role-based restrictions can be layered on later via a profiles table.)
 */

export async function getSession(supabase) {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

export function onAuthChange(supabase, callback) {
  supabase.auth.onAuthStateChange((_event, session) => callback(session));
}

export async function signIn(supabase, email, password) {
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signUp(supabase, email, password) {
  return supabase.auth.signUp({ email, password });
}

export async function signOut(supabase) {
  return supabase.auth.signOut();
}

export async function resendConfirmation(supabase, email) {
  return supabase.auth.resend({ type: 'signup', email });
}

/** Sends a reset-password email. redirectTo uses the current origin/path dynamically,
 *  so this keeps working automatically when the app moves off localhost to a real domain —
 *  no hardcoded URL to remember to update later. */
export async function resetPasswordForEmail(supabase, email) {
  return supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname
  });
}

export async function updatePassword(supabase, newPassword) {
  return supabase.auth.updateUser({ password: newPassword });
}

/** Supabase fires a PASSWORD_RECOVERY event when the user lands back on the site via the
 *  reset-password email link (it briefly issues a valid recovery session for this purpose). */
export function onPasswordRecovery(supabase, callback) {
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') callback(session);
  });
}

function isUnconfirmedEmailError(error) {
  if (!error) return false;
  const msg = error.message?.toLowerCase() || '';
  return msg.includes('email not confirmed') || msg.includes('email_not_confirmed');
}

/**
 * Wires up the login/signup screen. Calls onAuthenticated(session) once signed in.
 */
export function setupAuthScreen(supabase, onAuthenticated) {
  const authCard = document.getElementById('auth-signin-card');
  const confirmPanel = document.getElementById('auth-confirm-pending');
  const forgotPanel = document.getElementById('auth-forgot-password');
  const resetPanel = document.getElementById('auth-reset-password');
  const confirmEmailEl = document.getElementById('auth-confirm-email');
  const resendBtn = document.getElementById('auth-resend-btn');
  const resendStatus = document.getElementById('auth-resend-status');
  const backToSignInBtn = document.getElementById('auth-back-to-signin');

  const authForm = document.getElementById('auth-form');
  const authEmail = document.getElementById('auth-email');
  const authPassword = document.getElementById('auth-password');
  const authError = document.getElementById('auth-error');
  const authSubmitBtn = document.getElementById('auth-submit-btn');
  const authToggleBtn = document.getElementById('auth-toggle-mode');
  const authTitle = document.getElementById('auth-title');
  const authToggleText = document.getElementById('auth-toggle-text');
  const forgotLink = document.getElementById('auth-forgot-link');

  const forgotForm = document.getElementById('forgot-password-form');
  const forgotEmail = document.getElementById('forgot-email');
  const forgotStatus = document.getElementById('forgot-password-status');
  const forgotSubmitBtn = document.getElementById('forgot-password-submit-btn');
  const forgotBackBtn = document.getElementById('forgot-back-to-signin');

  const resetForm = document.getElementById('reset-password-form');
  const resetNewInput = document.getElementById('reset-password-new');
  const resetConfirmInput = document.getElementById('reset-password-confirm');
  const resetStatus = document.getElementById('reset-password-status');
  const resetSubmitBtn = document.getElementById('reset-password-submit-btn');

  let mode = 'signin'; // or 'signup'

  function hideAllAuthPanels() {
    authCard.style.display = 'none';
    confirmPanel.style.display = 'none';
    forgotPanel.style.display = 'none';
    resetPanel.style.display = 'none';
  }

  function renderMode() {
    authError.textContent = '';
    authError.style.color = 'var(--danger)';
    if (mode === 'signin') {
      authTitle.textContent = 'Sign in';
      authSubmitBtn.textContent = 'Sign in';
      authToggleText.textContent = "New staff member?";
      authToggleBtn.textContent = 'Create an account';
    } else {
      authTitle.textContent = 'Create staff account';
      authSubmitBtn.textContent = 'Create account';
      authToggleText.textContent = 'Already have an account?';
      authToggleBtn.textContent = 'Sign in instead';
    }
  }

  function showConfirmPending(email) {
    hideAllAuthPanels();
    confirmPanel.style.display = 'block';
    confirmEmailEl.textContent = email;
    resendStatus.textContent = '';
    resendBtn.disabled = false;
    resendBtn.textContent = 'Resend confirmation email';
  }

  function showSignInCard() {
    hideAllAuthPanels();
    authCard.style.display = 'block';
    mode = 'signin';
    renderMode();
  }

  function showForgotPasswordCard() {
    hideAllAuthPanels();
    forgotPanel.style.display = 'block';
    forgotStatus.textContent = '';
    forgotEmail.value = authEmail.value || '';
  }

  function showResetPasswordCard() {
    hideAllAuthPanels();
    resetPanel.style.display = 'block';
    resetStatus.textContent = '';
    resetNewInput.value = '';
    resetConfirmInput.value = '';
  }

  backToSignInBtn.addEventListener('click', showSignInCard);
  forgotLink.addEventListener('click', showForgotPasswordCard);
  forgotBackBtn.addEventListener('click', showSignInCard);

  forgotForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = forgotEmail.value.trim();
    forgotSubmitBtn.disabled = true;
    forgotSubmitBtn.textContent = 'Sending…';
    const { error } = await resetPasswordForEmail(supabase, email);
    forgotSubmitBtn.disabled = false;
    forgotSubmitBtn.textContent = 'Send reset link';

    if (error) {
      forgotStatus.style.color = 'var(--danger)';
      forgotStatus.textContent = error.message;
      return;
    }
    // Supabase doesn't reveal whether the email exists (avoids account enumeration) —
    // this wording is deliberately conditional to match that.
    forgotStatus.style.color = 'var(--info)';
    forgotStatus.textContent = `If ${email} has an account, a reset link is on its way. Check your inbox.`;
  });

  resetForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw1 = resetNewInput.value;
    const pw2 = resetConfirmInput.value;

    if (pw1 !== pw2) {
      resetStatus.style.color = 'var(--danger)';
      resetStatus.textContent = "Passwords don't match.";
      return;
    }

    resetSubmitBtn.disabled = true;
    resetSubmitBtn.textContent = 'Saving…';
    const { error } = await updatePassword(supabase, pw1);
    resetSubmitBtn.disabled = false;
    resetSubmitBtn.textContent = 'Set new password';

    if (error) {
      resetStatus.style.color = 'var(--danger)';
      resetStatus.textContent = error.message;
      return;
    }

    // The recovery link grants a real (temporary-becomes-permanent) session — sign
    // straight into the app instead of making them log in again with the new password.
    const session = await getSession(supabase);
    if (session) {
      document.getElementById('auth-screen').style.display = 'none';
      onAuthenticated(session);
    } else {
      resetStatus.style.color = 'var(--info)';
      resetStatus.textContent = 'Password updated. Please sign in.';
      setTimeout(showSignInCard, 1500);
    }
  });

  resendBtn.addEventListener('click', async () => {
    const email = confirmEmailEl.textContent;
    resendBtn.disabled = true;
    resendBtn.textContent = 'Sending…';
    const { error } = await resendConfirmation(supabase, email);
    if (error) {
      resendStatus.style.color = 'var(--danger)';
      resendStatus.textContent = error.message;
      resendBtn.disabled = false;
      resendBtn.textContent = 'Resend confirmation email';
      return;
    }
    resendStatus.style.color = 'var(--info)';
    resendStatus.textContent = 'Confirmation email sent.';
    let secondsLeft = 30;
    resendBtn.textContent = `Resend in ${secondsLeft}s`;
    const interval = setInterval(() => {
      secondsLeft -= 1;
      if (secondsLeft <= 0) {
        clearInterval(interval);
        resendBtn.disabled = false;
        resendBtn.textContent = 'Resend confirmation email';
      } else {
        resendBtn.textContent = `Resend in ${secondsLeft}s`;
      }
    }, 1000);
  });

  authToggleBtn.addEventListener('click', () => {
    mode = mode === 'signin' ? 'signup' : 'signin';
    renderMode();
  });

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.textContent = '';
    authSubmitBtn.disabled = true;
    authSubmitBtn.textContent = mode === 'signin' ? 'Signing in…' : 'Creating account…';

    const email = authEmail.value.trim();
    const password = authPassword.value;

    const { data, error } = mode === 'signin'
      ? await signIn(supabase, email, password)
      : await signUp(supabase, email, password);

    authSubmitBtn.disabled = false;
    authSubmitBtn.textContent = mode === 'signin' ? 'Sign in' : 'Create account';

    if (error) {
      if (isUnconfirmedEmailError(error)) {
        showConfirmPending(email);
        return;
      }
      authError.textContent = error.message;
      return;
    }

    if (mode === 'signup' && !data.session) {
      showConfirmPending(email);
      return;
    }

    if (data.session) {
      document.getElementById('auth-screen').style.display = 'none';
      onAuthenticated(data.session);
    }
  });

  renderMode();

  return { showResetPasswordCard };
}

export function showAuthScreen() {
  const authScreen = document.getElementById('auth-screen');
  const appRoot = document.getElementById('app-root');
  const authCard = document.getElementById('auth-signin-card');
  const confirmPanel = document.getElementById('auth-confirm-pending');
  const forgotPanel = document.getElementById('auth-forgot-password');
  const resetPanel = document.getElementById('auth-reset-password');
  if (authScreen) authScreen.style.display = 'flex';
  if (appRoot) appRoot.style.display = 'none';
  // Reset to the sign-in card so logging out never leaves some other panel showing
  if (confirmPanel) confirmPanel.style.display = 'none';
  if (forgotPanel) forgotPanel.style.display = 'none';
  if (resetPanel) resetPanel.style.display = 'none';
  if (authCard) authCard.style.display = 'block';
}

export function showApp(session) {
  const authScreen = document.getElementById('auth-screen');
  const appRoot = document.getElementById('app-root');
  const userEmailEl = document.getElementById('current-user-email');
  if (authScreen) authScreen.style.display = 'none';
  if (appRoot) appRoot.style.display = 'block';
  if (userEmailEl && session?.user?.email) userEmailEl.textContent = session.user.email;
}
