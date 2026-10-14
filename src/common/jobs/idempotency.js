'use strict';

const crypto = require('crypto');

function normalizePart(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    if (value._id) return String(value._id).trim();
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value).trim();
}

function buildJobIdempotencyKey(...parts) {
  return parts
    .map(normalizePart)
    .filter(Boolean)
    .join(':')
    .slice(0, 300);
}

function hashFingerprint(value) {
  const raw = normalizePart(value);
  if (!raw) return '';
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

module.exports = {
  buildJobIdempotencyKey,
  hashFingerprint,
};
