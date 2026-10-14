/**
 * Portal-agnostic controller logging helpers.
 *
 * Works for HOA, shared API controllers, and any portal that does NOT use the
 * landlord-specific `logLandlordStep` / `handleLandlordError` utilities.
 *
 * USAGE
 * ```js
 * const { logControllerStep, handleControllerError } = require('../../../common/helpers/controllerLogger');
 *
 * const createInvoice = async (req, res, next) => {
 *   const action = 'createInvoice';
 *   logControllerStep(req, 'START', { action, portal: 'hoa' });
 *   try {
 *     const result = await invoiceService.createInvoice(req.body, req.userId);
 *     logControllerStep(req, 'END', { action, invoiceId: result._id, success: true });
 *     return res.status(201).json(result);
 *   } catch (err) {
 *     return handleControllerError(req, res, err, next, action);
 *   }
 * };
 * ```
 *
 * STEP NAMES
 *   START  - handler entered
 *   END    - handler completed successfully
 *   ERROR  - handler threw / rejected
 *
 * CORRELATION
 * Uses req.requestId (set by httpLogger.middleware) so every log line for a
 * single HTTP request shares the same ID regardless of portal.
 */
const logger = require('../logger');

/**
 * Emits a structured controller-layer log line.
 *
 * @param {import('express').Request} req
 * @param {'START'|'END'|'ERROR'} step
 * @param {object} [meta] - Whitelisted metadata (action, portal, entityId, …)
 * @param {string} [customMessage]
 */
function logControllerStep(req, step, meta = {}, customMessage) {
  const message = customMessage || `[CONTROLLER] ${step}`;
  logger.step(`HANDLER_${step}`, message, {
    requestId: req.requestId || req.landlordRequestId,
    userId: req.userId || req.user?._id || req.user?.id,
    layer: 'controller',
    ...meta,
  });
}

/**
 * Logs HANDLER_ERROR and returns the appropriate HTTP error response.
 * Delegates to `next(err)` for 5xx so the global errorHandler can format it.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Error} err
 * @param {Function} next
 * @param {string} action - Handler name for log context
 */
function handleControllerError(req, res, err, next, action) {
  logControllerStep(req, 'ERROR', {
    action,
    error: err?.message,
    statusCode: err?.status || 500,
  }, `[CONTROLLER] ERROR in "${action}": ${err?.message || 'unknown error'}`);

  if (err && err.status) {
    return res.status(err.status).json({ message: err.message });
  }
  if (typeof next === 'function') {
    return next(err);
  }
  return res.status(500).json({ message: err?.message || 'Internal server error' });
}

module.exports = { logControllerStep, handleControllerError };
