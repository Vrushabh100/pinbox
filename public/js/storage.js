// ============================================
// Pinboxx API Client
// Auth: HttpOnly cookie (pb_token) set by server — no localStorage token storage
// ============================================

const API_BASE = window.location.origin + '/api';

// ─── Token helpers (kept as no-ops for backward compat with callers) ──────────
function getToken() { return null; } // token is in HttpOnly cookie, not accessible from JS
function setToken(token) {
  // If old code passes a token from server response, store it temporarily in memory
  // (never in localStorage). The HttpOnly cookie is the real auth mechanism.
  window.__pb_token_mem = token;
}
function clearToken() {
  window.__pb_token_mem = null;
}

// ─── Core fetch wrapper ───────────────────────────────────────────────────────
async function apiRequest(method, path, body = null, isAdmin = false) {
  const headers = { 'Content-Type': 'application/json' };
  // Auth is handled by HttpOnly cookie automatically via credentials: 'include'
  const opts = { method, headers, credentials: 'include' };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${API_BASE}${path}`, opts);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.reason = data.reason || null;
    if (data.code) err.code = data.code;
    throw err;
  }

  return data;
}

// ─── Account API ─────────────────────────────────────────────────────────────

/** Get accounts created by the current user */
async function getAllAccounts() {
  try {
    return await apiRequest('GET', '/accounts/mine');
  } catch {
    return [];
  }
}

/** Get shared vault accounts (visible to everyone) */
async function getSharedVaultAccounts() {
  try {
    return await apiRequest('GET', '/accounts/vault');
  } catch {
    return [];
  }
}

/** Get dashboard stats */
async function getStats() {
  try {
    const data = await apiRequest('GET', '/accounts/stats');
    // Flatten to match old interface
    return {
      total: data.my.total,
      active: data.my.active,
      rateLimited: data.my.rateLimited,
      nextCooldownEnd: data.my.nextCooldownEnd,
      shared: data.shared
    };
  } catch {
    return { total: 0, active: 0, rateLimited: 0, nextCooldownEnd: null, shared: { total: 0, active: 0, rateLimited: 0 } };
  }
}

/** Save a new account (goes to "My Accounts" by default) */
async function saveAccount(accountData) {
  try {
    const account = await apiRequest('POST', '/accounts', accountData);
    return account;
  } catch (err) {
    console.error('Save account error:', err);
    if (err.reason === 'banned') showUserBlockedOverlay('banned');
    if (err.reason === 'suspended') showUserBlockedOverlay('suspended');
    throw err;
  }
}

/** Delete an account by ID */
async function deleteAccount(id) {
  try {
    await apiRequest('DELETE', `/accounts/${id}`);
    return true;
  } catch (err) {
    console.error('Delete account error:', err);
    return false;
  }
}

/** Mark account as rate-limited */
async function markRateLimited(id) {
  try {
    return await apiRequest('PATCH', `/accounts/${id}/status`, { status: 'rate_limited' });
  } catch (err) {
    console.error('Mark rate limited error:', err);
    return null;
  }
}

/** Mark account as active */
async function markActive(id) {
  try {
    return await apiRequest('PATCH', `/accounts/${id}/status`, { status: 'active' });
  } catch (err) {
    console.error('Mark active error:', err);
    return null;
  }
}

/** Mark account as used (increment usage counter) */
async function markUsed(id) {
  try {
    return await apiRequest('PATCH', `/accounts/${id}/used`);
  } catch (err) {
    console.error('Mark used error:', err);
    return null;
  }
}

/** Toggle sharing an account to the shared vault */
async function toggleShareAccount(id, note = null) {
  try {
    const body = note === null ? null : { note };
    return await apiRequest('PATCH', `/accounts/${id}/share`, body);
  } catch (err) {
    console.error('Share account error:', err);
    return null;
  }
}

/** Get a single account (from local array - avoid extra round trip) */
function getAccount(id, accountsArray) {
  return (accountsArray || []).find(a => (a._id || a.id) === id) || null;
}

/** Get next available active account for a platform */
function getNextAvailable(accounts, platform = null) {
  let active = accounts.filter(a => {
    if (a.status !== 'active') return false;
    if (platform) return (a.platform || '').toLowerCase() === platform.toLowerCase();
    return true;
  });

  if (active.length === 0) return null;

  active.sort((a, b) => {
    const aTime = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
    const bTime = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
    return aTime - bTime;
  });

  return active[0];
}

/** Refresh expired cooldowns in the local array (no server call needed — server handles it) */
function refreshCooldowns(accounts) {
  const now = Date.now();
  return (accounts || []).map(a => {
    if (a.status === 'rate_limited' && a.cooldownEndsAt) {
      if (now >= new Date(a.cooldownEndsAt).getTime()) {
        return { ...a, status: 'active', cooldownEndsAt: null };
      }
    }
    return a;
  });
}

// ─── Export/Import (local JSON only — for backup) ─────────────────────────────
function exportVault(accounts) {
  return JSON.stringify({
    version: 2,
    exportedAt: new Date().toISOString(),
    accounts
  }, null, 2);
}

// ─── Saved Chat (still localStorage — not user-data, just a session convenience) ──
const SAVED_CHAT_KEY = 'cobox_saved_chat';

function saveChat(chatData) {
  const record = {
    text: chatData.text || '',
    platform: chatData.platform || 'Claude',
    accountEmail: chatData.accountEmail || '',
    savedAt: new Date().toISOString(),
    charCount: (chatData.text || '').length,
    estimatedTokens: Math.ceil((chatData.text || '').length / 4)
  };
  localStorage.setItem(SAVED_CHAT_KEY, JSON.stringify(record));
  return record;
}

function getSavedChat() {
  try {
    const raw = localStorage.getItem(SAVED_CHAT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearSavedChat() {
  localStorage.removeItem(SAVED_CHAT_KEY);
}
