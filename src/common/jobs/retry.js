'use strict';

const { DEFAULT_RETRY_DELAYS_MS } = require('./config');

function getRetryDelayMs(attempt, delays = DEFAULT_RETRY_DELAYS_MS) {
  const list = Array.isArray(delays) && delays.length ? delays : DEFAULT_RETRY_DELAYS_MS;
  const safeAttempt = Math.max(1, Number(attempt) || 1);
  const index = Math.min(safeAttempt, list.length) - 1;
  return Math.max(0, Number(list[index]) || 0);
}

function isPermanentError(err) {
  if (!err) return false;
  if (err.permanent === true) return true;
  const status = Number(err.status || err.statusCode);
  if (status === 400 || status === 404 || status === 422) return true;
  const code = String(err.code || '').toUpperCase();
  if (['ENOENT', 'ENOTFOUND', 'VALIDATION_ERROR', 'PERMANENT'].includes(code)) {
    return status ? status < 500 : true;
  }
  const message = String(err.message || '').toLowerCase();
  if (!message) return false;
  if (message.includes('not found')) return true;
  if (message.includes('validation')) return true;
  if (message.includes('invalid recipient')) return true;
  if (message.includes('permanent failure')) return true;
  if (message.includes('duplicate')) return true;
  return false;
}

module.exports = {
  getRetryDelayMs,
  isPermanentError,
};
