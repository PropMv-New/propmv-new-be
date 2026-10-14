/**
 * ------------------------------------------------------------------
 * File: logger.js
 * Module: Src Common
 *
 * Purpose:
 * Backend utility/module providing helper functions for logger.
 *
 * Used By:
 * SyndicationProviderFactory, setupZillowMock, zillow.routes, zillowBulkFeedCronJob
 * ------------------------------------------------------------------
 */

/**
 * Production-safe structured logger for the propmv API server.
 *
 * DESIGN PRINCIPLES
 * - All landlord pipeline steps flow through `logger.step()` via landlordFlowLog.js.
 * - Metadata is sanitized before output - only whitelisted keys and *Id fields pass through.
 * - Full request bodies, MongoDB documents, and nested arrays are never logged.
 *
 * LOG LEVELS (env LOG_LEVEL)
 *   error < warn < info < debug  (default: info)
 *
 * LANDLORD TRACE FORMAT
 *   [2026-06-30T12:00:00.000Z] [INFO] [LANDLORD] JWT validated - user identity attached {"requestId":"abc","step":"AUTH_OK",...}
 *
 * @see portals/landlord/utils/landlordFlowLog.js - step names and pipeline docs
 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const DEFAULT_LEVEL = process.env.LOG_LEVEL || 'info';
const CURRENT_LEVEL = LEVELS[DEFAULT_LEVEL] !== undefined ? LEVELS[DEFAULT_LEVEL] : LEVELS.info;

/**
 * Metadata keys allowed in log output. Add new keys here when introducing new
 * trace fields - never log arbitrary object keys without review.
 */
const SAFE_META_KEYS = new Set([
  // Pipeline / tracing
  'step', 'action', 'module', 'method', 'path', 'route', 'statusCode', 'durationMs',
  'requestId', 'correlationId', 'layer', 'phase', 'outcome', 'handler',
  // Identity
  'userId', 'createdBy', 'actorId', 'isAdministrator',
  // Domain entities
  'listingId', 'propertyId', 'tenantId', 'leaseId', 'invoiceId',
  'expenseId', 'vendorId', 'ownerId', 'hoaId', 'companyId',
  'maintenanceId', 'documentId', 'paymentId', 'eventId',
  // Pagination / counts
  'count', 'total', 'page', 'pageSize', 'pageNumber', 'offset', 'limit',
  // Outcomes
  'success', 'error', 'code', 'reason',
  // File / storage
  'fileSize', 'objectKey', 'contentType', 'container', 'provider',
  // Syndication
  'listingCount', 'feedListingId',
  // Auth
  'privilegeCount', 'requiredCount',
  // HTTP
  'httpMethod', 'httpPath', 'httpStatus', 'ip', 'userAgent',
  // Misc
  'operation', 'portal', 'service', 'controller', 'format',
  'jobType', 'attempts', 'status', 'queueName', 'worker',
  'retryAfterMs',
]);

/**
 * truncate
 *
 * Performs logic operations for truncate.
 *
 * @param value - Request/input argument
 * @param max - Request/input argument
 * @returns Operations result
 */
function truncate(value, max = 120) {
  if (value == null) return value;
  const str = String(value);
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

/**
 * Keys whose values must never appear in a log line.
 * Matches "otp: 123456", "smtpPassword=secret", and JSON like "mfaOtp":"123456".
 */
const LABELED_SECRET = /(["']?)([A-Za-z0-9]*(?:otp|password|passwd|secret|token|authorization|api[_-]?key|cvv|cvc|ssn|account[_-]?number|routing[_-]?number)[A-Za-z0-9]*)\1\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const BEARER_SECRET = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const JWT_SECRET = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const SECRET_LABEL = /[A-Za-z0-9]*(?:otp|password|passwd|secret|token|authorization|api[_-]?key|cvv|cvc|ssn|account[_-]?number|routing[_-]?number)\s*[:=]\s*$/i;

function redactLogText(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    .replace(JWT_SECRET, '[REDACTED]')
    .replace(BEARER_SECRET, 'Bearer [REDACTED]')
    .replace(LABELED_SECRET, '$1$2$1: [REDACTED]');
}

/** True when the message is a label waiting for a secret in the next argument. */
function messageExpectsSecretValue(message) {
  return SECRET_LABEL.test(String(message || '').trim());
}

/**
 * Strips unsafe fields from metadata. Objects and Errors are reduced to safe scalars.
 * Keys ending in `Id` or `_id` are included (truncated) even if not in SAFE_META_KEYS.
 */
function sanitizeScalar(value) {
  if (typeof value === 'string') return truncate(redactLogText(value));
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return truncate(redactLogText(String(value)));
}

function sanitizeMeta(meta, message) {
  if (meta == null) return undefined;
  if (typeof meta === 'string') {
    if (messageExpectsSecretValue(message)) return '[REDACTED]';
    return truncate(redactLogText(meta));
  }
  if (typeof meta !== 'object') return truncate(meta);

  if (meta instanceof Error) {
    return { error: truncate(redactLogText(meta.message || '')), code: meta.code };
  }

  const safe = {};
  Object.entries(meta).forEach(([key, value]) => {
    if (SAFE_META_KEYS.has(key)) {
      safe[key] = typeof value === 'object' && value != null
        ? truncate(redactLogText(JSON.stringify(value)))
        : sanitizeScalar(value);
      return;
    }
    if (key.endsWith('Id') || key.endsWith('_id')) {
      safe[key] = truncate(value, 64);
      return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      safe[key] = value;
    }
  });

  return Object.keys(safe).length ? safe : undefined;
}

/**
 * format Line
 *
 * Performs logic operations for formatLine.
 *
 * @param level - Request/input argument
 * @param message - Request/input argument
 * @param meta - Request/input argument
 * @returns Operations result
 */
function formatLine(level, message, meta) {
  const timestamp = new Date().toISOString();
  const safeMessage = redactLogText(message == null ? '' : String(message));
  const base = `[${timestamp}] [${level.toUpperCase()}] ${safeMessage}`;
  const safe = sanitizeMeta(meta, safeMessage);
  if (!safe) return base;
  try {
    return `${base} ${JSON.stringify(safe)}`;
  } catch {
    return base;
  }
}

/**
 * write
 *
 * Performs logic operations for write.
 *
 * @param level - Request/input argument
 * @param message - Request/input argument
 * @param meta - Request/input argument
 * @returns Operations result
 */
function write(level, message, meta) {
  const levelNum = LEVELS[level];
  if (levelNum == null || CURRENT_LEVEL < levelNum) return;

  const line = formatLine(level, message, meta);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else if (level === 'debug') console.debug(line);
  else console.log(line);
}

const logger = {
  error: (msg, meta) => write('error', msg, meta),
  warn: (msg, meta) => write('warn', msg, meta),
  info: (msg, meta) => write('info', msg, meta),
  debug: (msg, meta) => write('debug', msg, meta),

  /**
   * Pipeline step marker - used by landlordFlowLog for multi-phase request tracing.
   * @param {string} step - Canonical step id (e.g. AUTH_OK, SERVICE_DB_WRITE)
   * @param {string} message - Human-readable description (prefixed with [LANDLORD] upstream)
   * @param {object} [meta] - Sanitized metadata; `step` is always injected
   */
  step: (step, message, meta = {}) => write('info', message, { ...meta, step }),

  /**
   * Logs an inbound HTTP request. Called by httpLogger middleware.
   * @param {object} meta - { requestId, httpMethod, httpPath, ip, userAgent, portal }
   */
  httpRequest: (meta) => write('info', '[HTTP] Incoming request', meta),

  /**
   * Logs an outbound HTTP response. Called by httpLogger middleware.
   * @param {object} meta - { requestId, httpMethod, httpPath, httpStatus, durationMs, portal }
   */
  httpResponse: (meta) => {
    const level = meta && meta.httpStatus >= 500 ? 'error'
      : meta && meta.httpStatus >= 400 ? 'warn'
      : 'info';
    write(level, '[HTTP] Response sent', meta);
  },
};

module.exports = logger;
