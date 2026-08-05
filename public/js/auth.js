
// Fetch configuration from backend before initializing Google Auth
async function fetchConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    window.PINBOXX_GOOGLE_CLIENT_ID = data.googleClientId;
  } catch (err) {
    console.error('Failed to fetch config', err);
  }
}

// Call fetchConfig immediately
const configPromise = fetchConfig();
// ============================================
// CoBox Auth Gate - Uses JWT + MongoDB backend
// ============================================

const PINBOXX_AUTH_SESSION_KEY = 'pinboxx_user_session'; // kept for compat

function getGoogleClientId() {
  const metaValue = document.querySelector('meta[name="google-signin-client_id"]')?.content?.trim();
  return window.PINBOXX_GOOGLE_CLIENT_ID || localStorage.getItem('pinboxx_google_client_id') || metaValue || '';
}

function parseJwtPayload(token) {
  try {
    const payload = token.split('.')[1];
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(normalized.padEnd(normalized.length + (4 - normalized.length % 4) % 4, '='));
    return JSON.parse(decodeURIComponent(decoded.split('').map(char => {
      return '%' + ('00' + char.charCodeAt(0).toString(16)).slice(-2);
    }).join('')));
  } catch {
    return null;
  }
}

function getGoogleRedirectUri() {
  const metaValue = document.querySelector('meta[name="google-redirect-uri"]')?.content?.trim();
  const configured = window.PINBOXX_GOOGLE_REDIRECT_URI || localStorage.getItem('pinboxx_google_redirect_uri') || metaValue;
  if (configured) return configured;
  return `${window.location.origin}/home`;
}

function createGoogleNonce() {
  const nonce = (window.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`).replace(/-/g, '');
  sessionStorage.setItem('pinboxx_google_nonce', nonce);
  return nonce;
}

function startGoogleRedirect() {
  const clientId = getGoogleClientId();
  if (!clientId) return false;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getGoogleRedirectUri(),
    response_type: 'id_token',
    scope: 'openid email profile',
    nonce: createGoogleNonce(),
    prompt: 'select_account'
  });
  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  return true;
}

// ─── Session helpers ──────────────────────────────────────────────────────────

function getPinboxxUserSession() {
  try {
    // localStorage persists across browser restarts (unlike sessionStorage)
    const raw = localStorage.getItem(PINBOXX_AUTH_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function savePinboxxUserSession(user) {
  const session = {
    userId: user.id || user._id,
    username: user.username,
    fullName: user.fullName || '',
    email: user.email,
    mobile: user.mobile,
    age: user.age,
    purpose: user.purpose,
    authProvider: user.authProvider,
    plan: user.plan || 'free',
    status: user.status || 'active',
    warnings: user.warnings || 0,
    suspendedUntil: user.suspendedUntil || null,
    startTime: new Date().toISOString()
  };
  // Use localStorage so session survives browser restarts
  localStorage.setItem(PINBOXX_AUTH_SESSION_KEY, JSON.stringify(session));
  return session;
}

function isPinboxxAuthenticated() {
  // getToken() always returns null (auth uses HttpOnly cookie, not JS-accessible token).
  // Instead, check if a valid user session exists in sessionStorage — this is populated
  // on login and cleared on logout, making it the reliable client-side auth indicator.
  const session = getPinboxxUserSession();
  return !!(session && (session.userId || session.username));
}

// ─── Register profile with backend ───────────────────────────────────────────

async function persistUserProfile(profile) {
  try {
    const result = await apiRequest('POST', '/auth/register', profile);
    setToken(result.token);
    savePinboxxUserSession(result.user);

    // Notify tracking system
    if (typeof initializeUserSession === 'function') {
      initializeUserSession(result.user);
    }

    return result.user;
  } catch (err) {
    console.error('Profile persist error:', err);
    throw err;
  }
}

// ─── Fetch current user status from backend ───────────────────────────────────

async function refreshCurrentUserFromServer() {
  if (!isPinboxxAuthenticated()) return null;
  try {
    const user = await apiRequest('GET', '/auth/me');
    savePinboxxUserSession(user);
    return user;
  } catch (err) {
    if (err.status === 401) {
      // Token expired or invalid — clear all local session state
      clearToken();
      sessionStorage.removeItem(PINBOXX_AUTH_SESSION_KEY);
      localStorage.removeItem(PINBOXX_AUTH_SESSION_KEY);
    }
    return null;
  }
}

// ─── Restore session from HttpOnly cookie on page load ────────────────────────
// Called when no local session exists but a valid server-side cookie might.
// The browser automatically sends pb_token cookie — if valid, we restore the session.
async function _tryRestoreSessionFromCookie() {
  // Show a brief loading overlay so the app doesn't flash as logged-out
  const loader = document.createElement('div');
  loader.id = 'auth-init-loader';
  loader.style.cssText = 'position:fixed;inset:0;z-index:999999;background:#000;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;';
  loader.innerHTML = '<span class="spinner" style="margin-right:15px;"></span> Authenticating...';
  document.body.appendChild(loader);

  try {
    // credentials: 'include' sends the pb_token HttpOnly cookie automatically
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (res.ok) {
      const user = await res.json();
      savePinboxxUserSession(user);
      document.getElementById('auth-init-loader')?.remove();
      updateAvatarUI();
      checkAndEnforceUserStatus();
      // If on landing/root, redirect into the app
      if (window.location.pathname === '/landingpage' || window.location.pathname === '/') {
        window.location.href = '/home';
      }
      return;
    }
  } catch (e) {
    // Network error — treat as not logged in
  }

  // No valid cookie — user is not authenticated
  document.getElementById('auth-init-loader')?.remove();
  updateAvatarUI();
  // Only show the login gate on protected pages (not landing/root)
  if (window.location.pathname !== '/landingpage' && window.location.pathname !== '/') {
    if (typeof window.openPinboxxAuthGate === 'function') {
      window.openPinboxxAuthGate();
    }
  }
}

// ─── User status enforcement ──────────────────────────────────────────────────

function showUserBlockedOverlay(reason, message, until) {
  let existing = document.getElementById('pinboxx-blocked-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'pinboxx-blocked-overlay';
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:99999;
    background:rgba(0,0,0,0.97);
    display:flex;align-items:center;justify-content:center;
    flex-direction:column;gap:1rem;padding:2rem;text-align:center;
  `;

  const icon = reason === 'banned' ? '🔒' : '⏸️';
  const title = reason === 'banned' ? 'Account Banned' : 'Account Suspended';
  const color = reason === 'banned' ? '#e62e2d' : '#f97316';

  let untilText = '';
  if (until) {
    untilText = `<div style="color:#9ca3af;font-size:0.875rem;margin-top:0.5rem">Until: ${new Date(until).toLocaleString()}</div>`;
  }

  overlay.innerHTML = `
    <div style="font-size:4rem">${icon}</div>
    <div style="font-size:1.75rem;font-weight:800;color:${color}">${title}</div>
    <div style="color:#d1d5db;max-width:480px;line-height:1.6">${message || 'Your account has been restricted by an administrator.'}</div>
    ${untilText}
    <div style="color:#6b7280;font-size:0.75rem;margin-top:1rem">Contact support if you believe this is an error.</div>
    ${reason === 'suspended' ? `<button onclick="location.reload()" style="margin-top:1rem;padding:0.75rem 1.5rem;border:1px solid #4b5563;background:transparent;color:white;cursor:pointer;font-size:0.875rem">Check Again</button>` : ''}
  `;
  document.body.appendChild(overlay);
}

function showUserWarningBanner(warnings, message) {
  let existing = document.getElementById('pinboxx-warning-banner');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.id = 'pinboxx-warning-banner';
  banner.style.cssText = `
    position:fixed;top:0;left:0;right:0;z-index:999999;
    background:#78350f;border-bottom:2px solid #f59e0b;
    color:#fef3c7;padding:0.625rem 1.25rem;
    display:flex;align-items:center;justify-content:between;
    font-size:0.8125rem;gap:0.75rem;
  `;
  banner.innerHTML = `
    <span style="font-size:1.1rem">⚠️</span>
    <span><strong>Warning ${warnings}/3:</strong> ${message || 'You have received a warning from the administrator. Further violations may result in suspension.'}</span>
    <button onclick="this.parentElement.remove()" style="margin-left:auto;background:none;border:none;color:#fef3c7;cursor:pointer;font-size:1rem;padding:0 0.5rem">×</button>
  `;

  document.body.prepend(banner);
}

function getPinboxxRestrictionFromSession() {
  const session = getPinboxxUserSession();
  if (!session) return null;

  if (session.status === 'banned') {
    return {
      reason: 'banned',
      title: 'Account Banned',
      message: 'Your account has been permanently banned. make an appeal on rishabhudekar@gmail.com to reinstate your account.',
      until: null
    };
  }

  if (session.status === 'suspended') {
    if (session.suspendedUntil && new Date(session.suspendedUntil) <= new Date()) return null;
    return {
      reason: 'suspended',
      title: 'Account Suspended',
      message: session.suspendedUntil
        ? `Your account is suspended until ${new Date(session.suspendedUntil).toLocaleString()}.due to voilation of our terms.`
        : 'Your account is suspended.due to voilations of our terms of use',
      until: session.suspendedUntil || null
    };
  }

  return null;
}

function _getStatusConfig(reason) {
  const map = {
    banned:    { color: '#e62e2d', bg: '#2a0a0a', icon: 'ban',            label: 'Account Banned',     ring: '#e62e2d' },
    suspended: { color: '#f97316', bg: '#1f1005', icon: 'pause-octagon',  label: 'Account Suspended',  ring: '#f97316' },
    warned:    { color: '#f59e0b', bg: '#1f1800', icon: 'triangle-alert', label: 'Account Warned',     ring: '#f59e0b' },
  };
  return map[reason] || map.banned;
}

function showUserRestrictionBanner(reason, message, until) {
  // Remove old banners
  document.getElementById('pinboxx-blocked-overlay')?.remove();
  document.getElementById('pinboxx-restriction-banner')?.remove();

  const cfg = _getStatusConfig(reason);
  
  let displayMessage = message;
  let untilText = '';
  
  if (reason === 'banned') {
    displayMessage = 'YOUR ACCOUNT IS BANNED.';
  } else if (reason === 'suspended') {
    let hoursStr = '';
    if (until) {
      const hours = Math.max(1, Math.ceil((new Date(until) - Date.now()) / 3600000));
      hoursStr = ` ${hours} HOURS`;
    }
    displayMessage = `YOUR ACCOUNT SUSPENDED TEMPORARILY TILL${hoursStr}.`;
  } else if (!displayMessage) {
    displayMessage = 'Account restricted by administrator.';
  }

  // Inject status into dropdown
  _injectStatusIntoDropdown('pinboxx', cfg, displayMessage, untilText);

  // Style the avatar button ring
  const btn = document.getElementById('btn-avatar');
  if (btn) {
    btn.style.outline = `2px solid ${cfg.ring}`;
    btn.style.outlineOffset = '2px';
  }
}

function _injectStatusIntoDropdown(prefix, cfg, message, untilText) {
  const dropdown = document.getElementById('avatar-dropdown');
  if (!dropdown) return;

  // Remove old status badge
  dropdown.querySelector('.account-status-badge')?.remove();

  const badge = document.createElement('div');
  badge.className = 'account-status-badge';
  badge.style.cssText = `
    background:${cfg.bg};
    border:1px solid ${cfg.color}33;
    border-radius:6px;
    padding:8px 10px;
    margin-bottom:8px;
    font-size:0.72rem;
  `;
  badge.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
      <i data-lucide="${cfg.icon}" style="width:12px;height:12px;color:${cfg.color};flex-shrink:0"></i>
      <span style="font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:${cfg.color}">${cfg.label}</span>
    </div>
    <div style="color:#aaa;line-height:1.4">${message || 'Account restricted by administrator.'}</div>
    ${untilText ? `<div style="color:#666;margin-top:3px;font-size:0.68rem;text-transform:uppercase;">${untilText}</div>` : ''}
  `;

  // Insert at top of dropdown
  dropdown.insertBefore(badge, dropdown.firstChild);
  if (window.lucide) window.lucide.createIcons();
}

function showUserBlockedOverlay(reason, message, until) {
  showUserRestrictionBanner(reason, message, until);
}

function showUserWarningBanner(warnings, message) {
  document.getElementById('pinboxx-warning-banner')?.remove();

  const cfg = _getStatusConfig('warned');
  const msg = message || `Warning ${warnings}/3: Further violations may result in suspension.`;
  _injectStatusIntoDropdown('pinboxx', cfg, msg, '');

  // Style the avatar button ring amber
  const btn = document.getElementById('btn-avatar');
  if (btn) {
    btn.style.outline = `2px solid ${cfg.ring}`;
    btn.style.outlineOffset = '2px';
  }
}

function isPinboxxUserRestricted() {
  return !!getPinboxxRestrictionFromSession();
}

function enforcePinboxxServiceAccess() {
  const restriction = getPinboxxRestrictionFromSession();
  if (!restriction) return true;
  showUserRestrictionBanner(restriction.reason, restriction.message, restriction.until);
  return false;
}

function updateAvatarUI() {
  const session = getPinboxxUserSession();
  const btnAvatar = document.getElementById('btn-avatar');
  const dropdownUsername = document.getElementById('dropdown-username-display');
  const loginBtn = document.getElementById('btn-open-login');
  const avatarWrapper = document.getElementById('avatar-wrapper');

  if (session && btnAvatar) {
    if (loginBtn) loginBtn.style.display = 'none';
    if (avatarWrapper) avatarWrapper.style.display = 'block';

    // First letter of full name, or username, or email
    const nameStr = session.fullName || session.username || session.email || 'U';
    btnAvatar.textContent = nameStr.charAt(0).toUpperCase();
    if (dropdownUsername) {
      dropdownUsername.innerHTML = `<span style="color:#aaa">@</span>${session.username}`;
    }

    const planBadge = document.getElementById('dropdown-plan-badge');
    if (planBadge && session) {
      const planLabel = { free: 'Free Plan', pro: 'Pro Plan', premium: 'Max Plan' };
      planBadge.textContent = planLabel[session.plan] || 'Free Plan';
    }

    // Show restriction badge in dropdown if needed
    const restriction = getPinboxxRestrictionFromSession();
    if (restriction) {
      const cfg = _getStatusConfig(restriction.reason);
      const untilText = restriction.until ? `Until: ${new Date(restriction.until).toLocaleString()}` : '';
      _injectStatusIntoDropdown('pinboxx', cfg, restriction.message, untilText);
      btnAvatar.style.outline = `2px solid ${cfg.ring}`;
      btnAvatar.style.outlineOffset = '2px';
    } else if (session.status === 'warned') {
      const cfg = _getStatusConfig('warned');
      _injectStatusIntoDropdown('pinboxx', cfg, 'Your account has received a warning.', '');
      btnAvatar.style.outline = `2px solid ${cfg.ring}`;
      btnAvatar.style.outlineOffset = '2px';
    }
  } else {
    if (avatarWrapper) avatarWrapper.style.display = 'none';
    if (loginBtn) loginBtn.style.display = '';
  }

  // Also sync the plan buttons in the UI (defined in index.html)
  if (typeof updateProButtonState === 'function') {
    updateProButtonState();
  }
}

async function checkAndEnforceUserStatus() {
  const user = await refreshCurrentUserFromServer();
  if (!user) return;

  if (user.restriction && user.restriction.restricted) {
    showUserBlockedOverlay(user.restriction.reason, user.restriction.message, user.restriction.until);
    return;
  }

  if (user.status === 'warned' && user.warnings > 0) {
    const latestReason = user.latestAction?.reason || '';
    showUserWarningBanner(user.warnings, latestReason);
  }
}

// ─── Auth Gate UI ─────────────────────────────────────────────────────────────

function initPinboxxAuthGate() {
  const gate = document.getElementById('auth-gate');
  const providerStep = document.getElementById('auth-provider-step');
  const profileStep = document.getElementById('auth-profile-step');
  const providerLabel = document.getElementById('auth-provider-label');
  const form = document.getElementById('auth-profile-form');
  const errorEl = document.getElementById('auth-error');
  const googleErrorEl = document.getElementById('auth-google-error');
  const loginBtn = document.getElementById('btn-open-login');
  const closeBtn = document.getElementById('btn-auth-close');
  const logoutBtn = document.getElementById('btn-user-logout');
  let selectedProvider = '';
  let googleProfile = null;

  function hideGate() {
    if (!gate) return;
    gate.classList.add('hidden');
    gate.classList.remove('flex');
  }

  function showGate() {
    if (!gate) return;
    gate.classList.remove('hidden');
    gate.classList.add('flex');
    providerStep.classList.remove('hidden');
    profileStep.classList.add('hidden');
    const referralStep = document.getElementById('auth-referral-step');
    if (referralStep) referralStep.classList.add('hidden');
    if (googleErrorEl) googleErrorEl.classList.add('hidden');
    if (errorEl) errorEl.classList.add('hidden');
    if (window.lucide) window.lucide.createIcons();
  }

  window.openPinboxxAuthGate = showGate;

  function showProfileStep(provider, profile = {}) {
    selectedProvider = provider;
    googleProfile = profile;
    if (provider === 'referral') {
      providerLabel.textContent = 'Referral Code';
    } else if (provider === 'google') {
      providerLabel.textContent = 'Google';
    } else {
      providerLabel.textContent = provider;
    }
    document.getElementById('auth-provider-input').value = provider;
    document.getElementById('auth-email').value = profile.email || '';
    document.getElementById('auth-email').readOnly = provider === 'google';
    document.getElementById('auth-fullname').value = profile.name || '';
    document.getElementById('auth-username').value = '';
    providerStep.classList.add('hidden');
    profileStep.classList.remove('hidden');
    if (window.lucide) window.lucide.createIcons();
    const nextInput = document.getElementById('auth-username').value
      ? document.getElementById('auth-mobile')
      : document.getElementById('auth-username');
    nextInput.focus();
  }

  function showGoogleError(message) {
    if (!googleErrorEl) return;
    googleErrorEl.textContent = message;
    googleErrorEl.classList.remove('hidden');
  }

  // Wire the single custom Google button
  async function initGoogleButton() {
    if (typeof configPromise !== "undefined") await configPromise;
    const clientId = getGoogleClientId();
    const btn = document.getElementById('btn-google-continue');
    if (!btn) return;

    // The Google callback (used when SDK is available via prompt)
    const handleGoogleCredential = async (response) => {
      if (!response?.credential) { showGoogleError('Google sign-in failed.'); return; }
      const claims = parseJwtPayload(response.credential);
      if (!claims?.email) { showGoogleError('No email returned from Google.'); return; }

      try {
        const loginRes = await fetch('/api/auth/google-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken: response.credential })
        });
        if (loginRes.ok) {
          const result = await loginRes.json();
          setToken(result.token);
          savePinboxxUserSession(result.user);
          if (typeof initializeUserSession === 'function') initializeUserSession(result.user);
          hideGate();
          await checkAndEnforceUserStatus();
          updateAvatarUI();
          window.location.href = '/home';
          return;
        }
      } catch (e) {
        console.error('Google login bypass error', e);
      }

      showProfileStep('google', {
        email: claims.email,
        name: claims.name || claims.given_name || '',
        googleSubject: claims.sub || '',
        credential: response.credential
      });
    };

    // Initialize Google SDK silently (no button render) if client ID exists
    if (clientId && window.location.protocol !== 'file:') {
      const tryInit = () => {
        if (window.google?.accounts?.id) {
          window.google.accounts.id.initialize({
            client_id: clientId,
            callback: handleGoogleCredential,
            use_fedcm_for_button: false,
            use_fedcm_for_prompt: false,
            auto_select: false
          });
        } else {
          setTimeout(tryInit, 200);
        }
      };
      tryInit();
    }

    // Button click: use Google prompt if SDK loaded, else redirect flow
    btn.addEventListener('click', async () => {
      if (googleErrorEl) googleErrorEl.classList.add('hidden');
      if (window.google?.accounts?.id && clientId && window.location.protocol !== 'file:') {
        window.google.accounts.id.prompt((notification) => {
          if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
            // Prompt not shown (e.g. browser blocks it), fall back to redirect
            if (!startGoogleRedirect()) showGoogleError('Google sign-in is not configured.');
          }
        });
      } else if (clientId && window.location.protocol !== 'file:') {
        if (!startGoogleRedirect()) showGoogleError('Google sign-in is not configured.');
      } else {
        showGoogleError('Google Sign-In requires a running server (not file://).');
      }
    });
  }

  function handleGoogleRedirectResult() {
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
    const params = new URLSearchParams(hash);
    const idToken = params.get('id_token');
    const error = params.get('error');

    if (error) {
      showGate();
      showGoogleError(`Google sign-in failed: ${error}`);
      history.replaceState(null, '', getGoogleRedirectUri());
      return true;
    }

    if (!idToken) return false;

    const claims = parseJwtPayload(idToken);
    history.replaceState(null, '', getGoogleRedirectUri());

    if (!claims?.email) {
      showGate();
      showGoogleError('Google sign-in succeeded, but no email was returned.');
      return true;
    }

    (async () => {
      try {
        const loginRes = await fetch('/api/auth/google-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken })
        });
        if (loginRes.ok) {
          const result = await loginRes.json();
          setToken(result.token);
          savePinboxxUserSession(result.user);
          if (typeof initializeUserSession === 'function') initializeUserSession(result.user);
          await checkAndEnforceUserStatus();
          updateAvatarUI();
          window.location.href = '/home';
          return;
        }
      } catch (e) {
        console.error('Google login bypass error', e);
      }

      showGate();
      showProfileStep('google', {
        email: claims.email,
        name: claims.name || claims.given_name || '',
        googleSubject: claims.sub || '',
        credential: idToken
      });
    })();
    return true;
  }

  // ─── Referral Code Flow ───────────────────────────────────────────────────
  const referralStep = document.getElementById('auth-referral-step');
  const referralInput = document.getElementById('auth-referral-input');
  const referralError = document.getElementById('auth-referral-error');

  document.getElementById('btn-show-referral')?.addEventListener('click', () => {
    providerStep.classList.add('hidden');
    referralStep.classList.remove('hidden');
    referralInput.value = '';
    referralError.classList.add('hidden');
    referralInput.focus();
  });

  document.getElementById('btn-referral-back')?.addEventListener('click', () => {
    referralStep.classList.add('hidden');
    providerStep.classList.remove('hidden');
    referralError.classList.add('hidden');
  });

  document.getElementById('btn-verify-referral')?.addEventListener('click', async () => {
    const code = referralInput.value.trim().toUpperCase();
    if (!code) {
      referralError.textContent = 'Please enter your referral code.';
      referralError.classList.remove('hidden');
      return;
    }

    const btn = document.getElementById('btn-verify-referral');
    btn.disabled = true;
    btn.textContent = 'Verifying...';
    referralError.classList.add('hidden');

    try {
      const res = await fetch('/api/auth/validate-referral', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      const data = await res.json();

      if (!res.ok) {
        referralError.textContent = data.error || 'Invalid referral code.';
        referralError.classList.remove('hidden');
        return;
      }

      // Valid! Move to profile step
      referralStep.classList.add('hidden');
      document.getElementById('auth-referral-code').value = code;
      showProfileStep('referral', { email: '', name: '' });
    } catch (err) {
      referralError.textContent = 'Could not connect. Try again.';
      referralError.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Verify Code';
    }
  });

  // Allow Enter key to trigger verify
  referralInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-verify-referral')?.click();
  });

  document.getElementById('btn-auth-back')?.addEventListener('click', () => {
    profileStep.classList.add('hidden');
    providerStep.classList.remove('hidden');
    errorEl.classList.add('hidden');
  });

  form?.addEventListener('submit', async event => {
    event.preventDefault();
    errorEl.classList.add('hidden');

    const submitBtn = form.querySelector('[type="submit"]');
    const originalText = submitBtn?.textContent;
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Saving...'; }

    const profile = {
      username: document.getElementById('auth-username').value.trim(),
      fullName: document.getElementById('auth-fullname').value.trim(),
      email: document.getElementById('auth-email').value.trim(),
      mobile: document.getElementById('auth-mobile').value.trim(),
      age: document.getElementById('auth-age').value.trim(),
      purpose: document.getElementById('auth-purpose').value.trim(),
      authProvider: selectedProvider || document.getElementById('auth-provider-input').value,
      googleSubject: googleProfile?.googleSubject || '',
      referralCode: document.getElementById('auth-referral-code')?.value || undefined,
      idToken: googleProfile?.credential || undefined
    };

    if (!profile.username || !profile.email || !profile.mobile || !profile.age || !profile.purpose || !profile.authProvider) {
      errorEl.textContent = 'Complete all profile fields to continue.';
      errorEl.classList.remove('hidden');
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalText; }
      return;
    }

    try {
      await persistUserProfile(profile);
      hideGate();
      // Check user status after login
      await checkAndEnforceUserStatus();
      updateAvatarUI();
      window.location.href = '/home';
    } catch (err) {
      errorEl.textContent = err.message || 'Failed to save profile. Please try again.';
      errorEl.classList.remove('hidden');
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalText; }
    }
  });

  initGoogleButton();
  handleGoogleRedirectResult();

  loginBtn?.addEventListener('click', showGate);
  closeBtn?.addEventListener('click', hideGate);

  logoutBtn?.addEventListener('click', async () => {
    try {
      // Tell server to (optionally) invalidate session tracking
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch (e) { /* ignore */ }
    clearToken();
    // Clear both storages so session is fully gone
    sessionStorage.removeItem(PINBOXX_AUTH_SESSION_KEY);
    localStorage.removeItem(PINBOXX_AUTH_SESSION_KEY);
    updateAvatarUI();
    window.location.href = '/logout';
  });
  
  // Avatar Dropdown Toggle Logic
  const btnAvatar = document.getElementById('btn-avatar');
  const avatarDropdown = document.getElementById('avatar-dropdown');
  if (btnAvatar && avatarDropdown) {
    // Ensure it starts hidden using inline style (not Tailwind class)
    avatarDropdown.style.display = 'none';

    btnAvatar.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = avatarDropdown.style.display !== 'none';
      avatarDropdown.style.display = isOpen ? 'none' : 'block';
    });
    document.addEventListener('click', (e) => {
      if (!avatarDropdown.contains(e.target) && !btnAvatar.contains(e.target)) {
        avatarDropdown.style.display = 'none';
      }
    });
  }

  if (isPinboxxAuthenticated()) {
    // Local session cache exists — show UI immediately, then validate with server
    hideGate();
    updateAvatarUI();

    // Show a loading overlay while verifying session
    const loader = document.createElement('div');
    loader.id = 'auth-init-loader';
    loader.style.cssText = 'position:fixed;inset:0;z-index:999999;background:#000;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;';
    loader.innerHTML = '<span class="spinner" style="margin-right:15px;"></span> Authenticating...';
    document.body.appendChild(loader);

    // Validate token against server — clears stale tokens automatically
    refreshCurrentUserFromServer().then(user => {
      document.getElementById('auth-init-loader')?.remove();

      if (!user) {
        // Token was invalid/expired — already cleared by refreshCurrentUserFromServer
        updateAvatarUI();
        // Redirect to landing page and show gate if not already there
        if (window.location.pathname !== '/landingpage' && window.location.pathname !== '/') {
          window.location.href = '/landingpage';
        } else {
          showGate();
        }
      } else {
        updateAvatarUI(); // Update UI now that localStorage is populated
        checkAndEnforceUserStatus();

        // If logged in and on landing page, redirect to app home
        if (window.location.pathname === '/landingpage' || window.location.pathname === '/') {
          window.location.href = '/home';
        }
      }
    });
  } else {
    // No local session cache — but the user may have a valid HttpOnly cookie
    // (e.g. returning after browser restart). Always check the server.
    hideGate();
    _tryRestoreSessionFromCookie();
  }
}

// Ensure avatar UI is updated on initial load (if auth.js runs early)
document.addEventListener('DOMContentLoaded', updateAvatarUI);

// ─── Plan Helpers ─────────────────────────────────────────────────────────────

function getUserPlan() {
  const session = getPinboxxUserSession();
  return (session && session.plan) ? session.plan : 'free';
}

function isProOrMax() {
  const plan = getUserPlan();
  return plan === 'pro' || plan === 'premium';
}

function isMax() {
  return getUserPlan() === 'premium';
}

function isFree() {
  return getUserPlan() === 'free';
}

function getPlanAccountLimit() {
  const plan = getUserPlan();
  if (plan === 'premium') return Infinity;
  if (plan === 'pro') return 15;
  return 4;
}

// Call this to gate a feature behind Pro/Max plan.
// Shows premium modal with context message if user doesn't qualify.
// Returns true if user CAN use the feature, false if blocked.
function requirePlanForFeature(minPlan, featureName) {
  const planRank = { free: 0, pro: 1, premium: 2 };
  const userRank = planRank[getUserPlan()] !== undefined ? planRank[getUserPlan()] : 0;
  const requiredRank = planRank[minPlan] !== undefined ? planRank[minPlan] : 1;
  if (userRank >= requiredRank) return true;
  // User doesn't have the required plan — open premium modal
  if (typeof window.openPremiumModal === 'function') {
    window.openPremiumModal(featureName + ' requires ' + (minPlan === 'pro' ? 'Pro' : 'Max') + ' plan. Upgrade to unlock.');
  }
  return false;
}

// initiateRazorpayCheckout is defined in razorpay-checkout.js (loaded separately)
