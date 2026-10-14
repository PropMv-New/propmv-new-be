'use strict';

/** Keys that must never appear in audit before/after payloads. */
const SENSITIVE_KEY_EXACT = new Set([
  'password',
  'confirmPassword',
  'plainPassword',
  'newPassword',
  'oldPassword',
  'currentPassword',
  'accessToken',
  'refreshToken',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'cvv',
  'cvc',
  'securityCode',
  'accountNumber',
  'account_number',
  'routingNumber',
  'routing_number',
  'paykey',
  'paykeyToken',
  'paykeyId',
  'secret',
  'apiKey',
  'api_key',
  'authorization',
  'resetPasswordOtp',
  'mfaOtp',
  'otp',
  'ssn',
  'taxId',
  'tax_id',
  'ein',
]);

/** Substrings in key names that trigger redaction (case-insensitive). */
const SENSITIVE_KEY_SUBSTRINGS = [
  'password',
  'secret',
  'token',
  'otp',
  'cvv',
  'cvc',
];

const MAX_DEPTH = 10;
const MAX_STRING_LENGTH = 2000;

function maskLast4(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '[REDACTED]';
  if (digits.length <= 4) return `****${digits}`;
  return `****${digits.slice(-4)}`;
}

function maskRouting(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '[REDACTED]';
  if (digits.length <= 4) return `*****${digits}`;
  return `*****${digits.slice(-4)}`;
}

function isSensitiveKey(key) {
  if (!key) return false;
  const lower = String(key).toLowerCase();
  if (SENSITIVE_KEY_EXACT.has(key) || SENSITIVE_KEY_EXACT.has(lower)) return true;
  return SENSITIVE_KEY_SUBSTRINGS.some((part) => lower.includes(part));
}

/**
 * Deep-redact sensitive fields from audit payloads.
 * Preserves structure; replaces secrets with [REDACTED] or masked values.
 */
function redactForAudit(value, depth = 0) {
  if (depth > MAX_DEPTH) return '[MaxDepth]';
  if (value == null) return value;

  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…`
      : value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (value instanceof Date) return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactForAudit(item, depth + 1));
  }

  if (typeof value !== 'object') return value;

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      if (key === 'last4' || key.toLowerCase() === 'last4') {
        out[key] = val;
      } else if (key === 'routingNumber' || key === 'routing_number') {
        out[key] = maskRouting(val);
      } else if (key === 'accountNumber' || key === 'account_number') {
        out[key] = maskLast4(val);
      } else {
        out[key] = '[REDACTED]';
      }
      continue;
    }
    out[key] = redactForAudit(val, depth + 1);
  }
  return out;
}

module.exports = {
  redactForAudit,
  maskLast4,
  maskRouting,
  isSensitiveKey,
};
