/**
 * ------------------------------------------------------------------
 * File: cryptoHelper.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for cryptoHelper.
 *
 * Used By:
 * auth.service, owner.service, tenant.service, portalInvitation.service
 * ------------------------------------------------------------------
 */

const crypto = require('crypto');
const env = require('../../config/env');


/**
 * Returns true if password encryption is enabled via env config.
 * @returns {boolean}
 */
function isEncryptionEnabled() {
  const flag = (env.PASSWORD_ENCRYPTION || process.env.PASSWORD_ENCRYPTION || '').toString().toLowerCase();
  return flag === 'true' || flag === '1' || flag === 'on' || flag === 'yes';
}

/**
 * Returns true if email content encryption is enabled via env config.
 * @returns {boolean}
 */
function isEmailEncryptionEnabled() {
  const flag = (process.env.EMAIL_ENCRYPTION || '').toString().toLowerCase();
  return flag === 'true' || flag === '1' || flag === 'on' || flag === 'yes';
}

/**
 * Reads AES key/IV from env and decodes from base64.
 * @returns {{key: Buffer, iv: Buffer}}
 * @throws {Error} If key or IV is not configured or invalid
 */
function getKeyAndIv() {
  const keyB64 = env.PASSWORD_ENCRYPTION_KEY || process.env.PASSWORD_ENCRYPTION_KEY;
  const ivB64 = env.PASSWORD_ENCRYPTION_IV || process.env.PASSWORD_ENCRYPTION_IV;
  if (!keyB64 || !ivB64) {
    throw new Error('Encryption key/iv not configured in environment variables');
  }
  if (typeof keyB64 !== 'string' || typeof ivB64 !== 'string') {
    throw new Error('Encryption key/iv must be strings');
  }
  const key = Buffer.from(keyB64, 'base64');
  const iv = Buffer.from(ivB64, 'base64');
  if (key.length !== 32 || iv.length !== 16) {
    throw new Error('Encryption key must be 32 bytes and IV must be 16 bytes');
  }
  return { key, iv };
}

/**
 * Encrypts a UTF-8 string using AES-256-CBC and returns base64 ciphertext.
 * @param {string} plaintext
 * @returns {string}
 */
function encryptAES(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) return plaintext;
  const { key, iv } = getKeyAndIv();
  try {
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return encrypted.toString('base64');
  } catch (err) {
    throw new Error('Failed to encrypt data: ' + err.message);
  }
}

/**
 * Decrypts a base64-encoded AES-256-CBC ciphertext into a UTF-8 string.
 * @param {string} ciphertextBase64
 * @returns {string}
 * @throws {Error} If decryption fails
 */
function decryptAES(ciphertextBase64) {
  if (typeof ciphertextBase64 !== 'string' || ciphertextBase64.length === 0) return ciphertextBase64;
  const { key, iv } = getKeyAndIv();
  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    if (typeof ciphertextBase64 !== 'string') throw new Error('Ciphertext must be a string');
    const ciphertext = Buffer.from(ciphertextBase64, 'base64');
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    throw new Error('Failed to decrypt password: ' + err.message);
  }
}

/**
 * Transparently decrypts when the feature flag is ON; otherwise returns input as-is.
 * @param {string} maybeEncrypted
 * @returns {string}
 */
function decryptIfEnabled(maybeEncrypted) {
  if (!isEncryptionEnabled()) return maybeEncrypted;
  if (maybeEncrypted == null) return maybeEncrypted;
  return decryptAES(maybeEncrypted);
}

/**
 * Encrypts email field when EMAIL_ENCRYPTION is enabled; otherwise returns input as-is.
 * Returns null/undefined as-is.
 * @param {string|null|undefined} value
 * @returns {string|null|undefined}
 */
function encryptEmailField(value) {
  if (!isEmailEncryptionEnabled()) return value;
  if (value == null || value === '') return value;
  return encryptAES(String(value));
}

/**
 * Decrypts email field when EMAIL_ENCRYPTION is enabled; otherwise returns input as-is.
 * Gracefully returns the original value if decryption fails (e.g. pre-existing plaintext rows).
 * @param {string|null|undefined} value
 * @returns {string|null|undefined}
 */
function decryptEmailField(value) {
  if (!isEmailEncryptionEnabled()) return value;
  if (value == null || value === '') return value;
  try {
    return decryptAES(String(value));
  } catch {
    // Pre-existing plaintext row - return as-is so the UI still works
    return value;
  }
}

/**
 * Validates if a string appears to be AES-256-CBC base64 encrypted
 * @param {string} password
 * @returns {boolean}
 */
function isValidEncryptedPassword(password) {
  if (typeof password !== 'string' || password.length === 0) return false;
  // Check if it's base64 encoded (basic validation)
  try {
    if (typeof password !== 'string') return false;
    const decoded = Buffer.from(password, 'base64');
    // AES-256-CBC encrypted data should be at least 16 bytes (IV size) + some data
    return decoded.length >= 16;
  } catch (error) {
    return false;
  }
}

/**
 * Validates if password is plaintext (not encrypted)
 * @param {string} password
 * @returns {boolean}
 */
function isPlaintextPassword(password) {
  if (typeof password !== 'string' || password.length === 0) return false;
  // Check if it contains only printable ASCII characters and common password chars
  // This is a heuristic - encrypted passwords are base64 and won't match this pattern
  const plaintextPattern = /^[a-zA-Z0-9!@#$%^&*()_+\-=\[\]{}|;':",./<>? ]+$/;
  return plaintextPattern.test(password) && !isValidEncryptedPassword(password);
}

module.exports = {
  isEncryptionEnabled,
  isEmailEncryptionEnabled,
  encryptAES,
  decryptAES,
  decryptIfEnabled,
  encryptEmailField,
  decryptEmailField,
  isValidEncryptedPassword,
  isPlaintextPassword,
};


