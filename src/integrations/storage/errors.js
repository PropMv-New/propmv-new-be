/**
 * Typed storage errors - preserve HTTP-ish status for API mapping
 * while keeping provider-agnostic messages.
 */
class StorageError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, cause?: Error, retryable?: boolean }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'StorageError';
    this.status = options.status || 500;
    this.code = options.code || 'STORAGE_ERROR';
    this.retryable = !!options.retryable;
    if (options.cause) this.cause = options.cause;
  }
}

function isTransientStorageError(err) {
  if (!err) return false;
  if (err.retryable) return true;
  const code = String(err.code || err.name || '').toUpperCase();
  const status = err.$metadata?.httpStatusCode || err.statusCode || err.status;
  if (status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  return [
    'TIMEOUT',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'NETWORKERROR',
    'THROTTLING',
    'SLOWDOWN',
    'REQUESTTIMEOUT',
    'SERVICEUNAVAILABLE',
    'TOOMANYREQUESTS',
  ].some((token) => code.includes(token) || String(err.message || '').toUpperCase().includes(token));
}

/**
 * Retry an async operation for transient storage failures.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ retries?: number, baseDelayMs?: number, operation?: string }} [opts]
 * @returns {Promise<T>}
 */
async function withRetry(fn, opts = {}) {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= retries || !isTransientStorageError(err)) {
        throw err;
      }
      const delay = baseDelayMs * (2 ** (attempt - 1));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

module.exports = {
  StorageError,
  isTransientStorageError,
  withRetry,
};
