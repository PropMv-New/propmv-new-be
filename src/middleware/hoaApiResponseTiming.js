/**
 * ------------------------------------------------------------------
 * File: hoaApiResponseTiming.js
 * Module: Backend Middleware
 *
 * Purpose:
 * Backend utility/module providing helper functions for hoaApiResponseTiming.
 *
 * Used By:
 * hoa-board
 * ------------------------------------------------------------------
 */

/**
 * Logs response time for all /api/v1/hoa/* routes (board member + owner self-service).
 * Example: [API] Properties response sent: 842ms status=200 size=12.4kb
 */
const { formatPerfTimings } = require('../common/helpers/perfTimings');
const logger = require('../common/logger');

const RESOURCE_LABELS = {
  property: 'Properties',
  properties: 'Properties',
  owners: 'Owners',
  invoice: 'Invoices',
  invoices: 'Invoices',
  expense: 'Expenses',
  payee: 'Payees',
  maintenance: 'Maintenance',
  messaging: 'Messaging',
  email: 'Email',
  users: 'Users',
  'board-members': 'Board members',
  'hoa-settings': 'HOA settings',
  dashboard: 'Dashboard',
  activity: 'Activity',
  tenants: 'Tenants',
  leasing: 'Leasing',
  lease: 'Leases',
  leases: 'Leases',
  support: 'Support',
};

/**
 * get Hoa Api Label
 *
 * Performs logic operations for getHoaApiLabel.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function getHoaApiLabel(req) {
  const path = (req.path || '').split('?')[0];
  const segments = path.split('/').filter(Boolean);

  if (segments[0] === 'owners' && segments[1] === 'me') {
    const subResource = segments.slice(2).join(' ') || 'profile';
    return `Owner ${subResource}`;
  }

  const key = segments[0];
  if (key && RESOURCE_LABELS[key]) {
    return RESOURCE_LABELS[key];
  }

  if (!key) return 'HOA';
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * format Payload Size
 *
 * Performs logic operations for formatPayloadSize.
 *
 * @param bytes - Request/input argument
 * @returns Operations result
 */
function formatPayloadSize(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return 'unknown';
  if (bytes < 1024) return `${bytes}b`;
  return `${(bytes / 1024).toFixed(1)}kb`;
}

/**
 * hoa Api Response Timing Middleware
 *
 * Performs logic operations for hoaApiResponseTimingMiddleware.
 *
 * @param req - Request/input argument
 * @param res - Request/input argument
 * @param next - Request/input argument
 * @returns Operations result
 */
function hoaApiResponseTimingMiddleware(req, res, next) {
  const startTime = Date.now();
  const label = getHoaApiLabel(req);
  let responseBytes = null;

  const originalJson = res.json.bind(res);
  res.json = function hoaTimedJson(body) {
    try {
      responseBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    } catch {
      responseBytes = null;
    }
    return originalJson(body);
  };

  res.on('finish', () => {
    const responseTime = Date.now() - startTime;
    const perfDetail = formatPerfTimings(req);
    const perfSuffix = perfDetail ? ` ${perfDetail}` : '';
    const sizeSuffix = responseBytes != null ? ` size=${formatPayloadSize(responseBytes)}` : '';
    const logLine = `[API] ${label} response sent: ${responseTime}ms status=${res.statusCode}${sizeSuffix}${perfSuffix}`;

    if (responseTime >= Number(process.env.SLOW_API_MS || 1000)) {
      logger.warn(logLine, { durationMs: responseTime });
    } else {
      logger.debug(logLine, { durationMs: responseTime });
    }
  });

  next();
}

module.exports = {
  hoaApiResponseTimingMiddleware,
  getHoaApiLabel,
};
