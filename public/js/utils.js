// ============================================
// CoBox Utilities
// ============================================

const FIRST_NAMES = [
  'Alex', 'Jordan', 'Morgan', 'Casey', 'Riley', 'Quinn', 'Avery', 'Sage',
  'Rowan', 'Finley', 'Blake', 'Drew', 'Ellis', 'Harper', 'Kai', 'Lane',
  'Noel', 'Parker', 'Reed', 'Taylor', 'Skyler', 'Phoenix', 'Emery', 'Dakota',
  'Cameron', 'Charlie', 'Hayden', 'Jessie', 'Logan', 'Robin', 'Ash', 'Devon',
  'Sam', 'Jamie', 'Pat', 'Dana', 'Kim', 'Lee', 'Chris', 'Andy'
];

const LAST_NAMES = [
  'Rivera', 'Chen', 'Nakamura', 'Petrov', 'Kim', 'Santos', 'Okafor', 'Jensen',
  'Müller', 'Park', 'Silva', 'Walsh', 'Tanaka', 'Larsson', 'Ahmed', 'Berg',
  'Costa', 'Duval', 'Fischer', 'Grant', 'Hayes', 'Ivanov', 'Jones', 'Kelly',
  'Lin', 'Marsh', 'Novak', 'Owens', 'Patel', 'Ross', 'Shaw', 'Torres',
  'Voss', 'Webb', 'Yang', 'Zhao', 'Bloom', 'Cruz', 'Drake', 'Frost'
];

const EMAIL_DOMAIN = 'vrushabhudepurkar.tech';

/**
 * Generate a random string of given length using alphanumeric chars
 */
function randomString(length = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  for (let i = 0; i < length; i++) {
    result += chars[arr[i] % chars.length];
  }
  return result;
}

/**
 * Generate a random display name
 */
function generateRandomName() {
  const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  return `${first} ${last}`;
}

/**
 * Generate a random temp email address
 */
function generateRandomEmail() {
  return `${randomString(8)}@${EMAIL_DOMAIN}`;
}

/**
 * Generate a random password (cosmetic — Claude is passwordless)
 */
function generatePassword(length = 12) {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const special = '!@#$%&*?';
  const all = upper + lower + digits + special;

  // Ensure at least one of each type
  let pwd = '';
  pwd += upper[Math.floor(Math.random() * upper.length)];
  pwd += lower[Math.floor(Math.random() * lower.length)];
  pwd += digits[Math.floor(Math.random() * digits.length)];
  pwd += special[Math.floor(Math.random() * special.length)];

  for (let i = 4; i < length; i++) {
    pwd += all[Math.floor(Math.random() * all.length)];
  }

  // Shuffle
  return pwd.split('').sort(() => Math.random() - 0.5).join('');
}

/**
 * Generate a UUID v4
 */
function generateId() {
  return crypto.randomUUID();
}

/**
 * Format milliseconds remaining into human readable
 */
function formatTimeRemaining(ms) {
  if (ms <= 0) return 'Ready';
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Format ISO date to local readable
 */
function formatDate(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  return d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

/**
 * Copy text to clipboard
 */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return true;
  }
}

/**
 * Show a temporary toast notification
 */
function showToast(message, type = 'info', duration = 3000) {
  const existing = document.querySelector('.cobox-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `cobox-toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('show'));

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/**
 * Rough token estimate (1 token ≈ 4 chars)
 */
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}
