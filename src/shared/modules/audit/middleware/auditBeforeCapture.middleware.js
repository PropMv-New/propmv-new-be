'use strict';

const logger = require('../../../../common/logger');

/**
 * Runs an async loader before the handler and attaches the result to req.auditBefore.
 * Failures are logged and do not block the request.
 */
function captureAuditBefore(loader) {
  if (typeof loader !== 'function') {
    throw new Error('captureAuditBefore requires a loader function');
  }

  return async function auditBeforeCaptureMiddleware(req, res, next) {
    if (req.auditBefore != null) return next();

    try {
      const snapshot = await loader(req);
      if (snapshot != null) {
        req.auditBefore = snapshot;
      }
    } catch (err) {
      logger.warn('[Audit] Before-state capture failed', {
        error: err.message,
        path: `${req.baseUrl || ''}${req.path || ''}`,
        method: req.method,
      });
    }

    return next();
  };
}

module.exports = {
  captureAuditBefore,
};
