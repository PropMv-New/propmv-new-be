'use strict';

const SENSITIVE_KEY = /password|passwd|secret|token|authorization|cookie|api[_-]?key|creditcard|cardnumber|ssn|private[_-]?key|otp|cvv|cvc/i;

function toPlain(value) {
  if (value == null) return value;
  if (typeof value.toObject === 'function') {
    try {
      return value.toObject();
    } catch {
      return value;
    }
  }
  return value;
}

function sanitizeJobPayload(value, depth = 0) {
  if (value == null) return value;
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return value.length > 4000 ? `${value.slice(0, 4000)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'function') return undefined;

  const plain = toPlain(value);
  if (Array.isArray(plain)) {
    return plain.slice(0, 100).map((item) => sanitizeJobPayload(item, depth + 1));
  }
  if (plain && typeof plain === 'object') {
    if (plain._bsontype === 'ObjectId' || (plain.id && typeof plain.toHexString === 'function')) {
      return String(plain);
    }
    const out = {};
    for (const [key, nested] of Object.entries(plain)) {
      if (SENSITIVE_KEY.test(key)) continue;
      if (nested === undefined) continue;
      out[key] = sanitizeJobPayload(nested, depth + 1);
    }
    return out;
  }
  return String(plain);
}

module.exports = {
  sanitizeJobPayload,
};
