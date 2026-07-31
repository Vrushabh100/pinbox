// ============================================
// Pinboxx - AES-256-GCM Encryption Utilities
// ============================================
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_HEX = process.env.ENCRYPTION_KEY; // must be 64 hex chars (32 bytes)

function getKey() {
  if (!KEY_HEX || KEY_HEX.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }
  return Buffer.from(KEY_HEX, 'hex');
}

/**
 * Encrypt plaintext → "iv:authTag:ciphertext" hex string
 */
function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt "iv:authTag:ciphertext" hex string → plaintext
 * Returns original value if not encrypted (graceful legacy support)
 */
function decrypt(value) {
  if (!value || !value.includes(':')) return value; // legacy cleartext
  try {
    const [ivHex, authTagHex, encryptedHex] = value.split(':');
    const key = getKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    return decipher.update(Buffer.from(encryptedHex, 'hex')) + decipher.final('utf8');
  } catch (e) {
    return value; // return as-is if decryption fails (legacy data)
  }
}

module.exports = { encrypt, decrypt };
