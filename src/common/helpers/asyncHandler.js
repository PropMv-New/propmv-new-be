/**
 * ------------------------------------------------------------------
 * File: asyncHandler.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for asyncHandler.
 *
 * Used By:
 * application.controller, quoteEstimate.controller, paymentManagement.controller, property.controller
 * ------------------------------------------------------------------
 */

/**
 * Wraps an async Express route handler so that any thrown error
 * is forwarded to next(err) instead of crashing the process.
 *
 * Usage:
 *   router.get('/path', asyncHandler(myAsyncController));
 *
 * Or wrap an entire controller object:
 *   module.exports = wrapController({ getAll, create, update });
 */

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * Wraps every function value in a controller object with asyncHandler.
 * Allows a single call at the bottom of each controller file.
 */
const wrapController = (controller) => {
  const wrapped = {};
  for (const [key, fn] of Object.entries(controller)) {
    wrapped[key] = typeof fn === 'function' ? asyncHandler(fn) : fn;
  }
  return wrapped;
};

module.exports = { asyncHandler, wrapController };
