/**
 * ------------------------------------------------------------------
 * File: landlordController.util.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for landlordController.util.
 *
 * Used By:
 * listing.controller
 * ------------------------------------------------------------------
 */

/**
 * Landlord controller logging helpers - Step 4 of the API pipeline.
 *
 * USAGE IN CONTROLLERS
 * ```js
 * const { logLandlordStep } = require('../../utils/landlordController.util');
 *
 * const myHandler = async (req, res, next) => {
 *   const action = 'myHandler';
 *   logLandlordStep(req, 'HANDLER_START', { action, entityId: req.params.id });
 *   try {
 *     const result = await myService.doWork(id, {
 *       requestId: req.landlordRequestId,  // correlate with service logs
 *       action,
 *     });
 *     logLandlordStep(req, 'HANDLER_END', { action, success: true });
 *     return res.status(200).json(result);
 *   } catch (err) {
 *     return handleLandlordError(req, res, err, next, action);
 *   }
 * };
 * ```
 *
 * REFERENCE IMPLEMENTATION: modules/listing/controller/listing.controller.js
 *
 * @see landlordFlowLog.js for the full step catalogue
 */
const { logLandlordFlow } = require('./landlordFlowLog');

/**
 * Logs a controller-layer pipeline step.
 *
 * @param {import('express').Request} req - Must have landlordRequestId from request logger
 * @param {string} step - HANDLER_START | HANDLER_END | HANDLER_ERROR
 * @param {object|string} metaOrLabel - Metadata object, or legacy action name string
 * @param {object|string} [maybeMeta] - Metadata when 3rd arg is a string, or custom message
 */
function logLandlordStep(req, step, metaOrLabel = {}, maybeMeta) {
  let meta = {};
  let customMessage;

  if (typeof metaOrLabel === 'string') {
    customMessage = `Controller handler: ${metaOrLabel}`;
    meta = typeof maybeMeta === 'object' && maybeMeta !== null ? maybeMeta : {};
    if (!meta.action) meta.action = metaOrLabel;
  } else {
    meta = metaOrLabel || {};
    customMessage = typeof maybeMeta === 'string' ? maybeMeta : undefined;
  }

  logLandlordFlow(step, {
    requestId: req.landlordRequestId,
    userId: req.userId || req.user?._id,
    layer: 'controller',
    ...meta,
  }, customMessage);
}

/**
 * Standard error responder for landlord controllers.
 * Logs HANDLER_ERROR then returns the appropriate HTTP status.
 */
function handleLandlordError(req, res, err, next, action) {
  logLandlordFlow('HANDLER_ERROR', {
    requestId: req.landlordRequestId,
    userId: req.userId,
    action,
    error: err?.message,
    status: err?.status || 500,
    layer: 'controller',
  }, `Controller "${action}" failed: ${err?.message || 'unknown error'}`);

  if (err && err.status) {
    return res.status(err.status).json({ message: err.message });
  }
  if (typeof next === 'function') {
    return next(err);
  }
  return res.status(500).json({ message: err?.message || 'Internal server error' });
}

module.exports = {
  logLandlordStep,
  handleLandlordError,
};
