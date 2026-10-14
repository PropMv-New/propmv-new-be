/**
 * ------------------------------------------------------------------
 * File: responseFormatter.js
 * Module: Backend Middleware
 *
 * Purpose:
 * Backend utility/module providing helper functions for responseFormatter.
 *
 * Used By:
 * app
 * ------------------------------------------------------------------
 */

/**
 * Wraps JSON responses so controllers can continue returning plain payloads while the API stays consistent.
 * The middleware normalizes successful and error responses into the shared envelope used by the frontend.
 */
module.exports = function responseFormatter(req, res, next) {
  const originalJson = res.json.bind(res);

  res.json = function (payload) {
    const statusCode = res.statusCode && Number.isInteger(res.statusCode) ? res.statusCode : 200;

    // 204 No Content -> send without body
    if (statusCode === 204) {
      return res.status(204).send();
    }

    // If already in our canonical shape, leave untouched
    if (
      payload && typeof payload === 'object' &&
      Object.prototype.hasOwnProperty.call(payload, 'message') &&
      Object.prototype.hasOwnProperty.call(payload, 'statuscode') &&
      Object.prototype.hasOwnProperty.call(payload, 'data')
    ) {
      return originalJson(payload);
    }

    // If payload has a message property but not the canonical shape, use it as message
    let message = statusCode >= 200 && statusCode < 300 ? 'Success' : 'Error';
    let data = null;

    if (payload && typeof payload === 'object') {
      if (Object.prototype.hasOwnProperty.call(payload, 'message') && !Object.prototype.hasOwnProperty.call(payload, 'data') && !Object.prototype.hasOwnProperty.call(payload, 'statuscode')) {
        // Use payload.message as message, and rest as data (if any)
        message = payload.message;
        const { message: _m, ...rest } = payload;
        data = Object.keys(rest).length ? rest : null;
        return originalJson({ message, statuscode: statusCode, data });
      }
      // Payload is an object but does not include message - treat entire payload as data
      data = payload;
      return originalJson({ message, statuscode: statusCode, data });
    }

    // For primitives (string/number/etc) or null, put into data
    data = payload === undefined ? null : payload;
    return originalJson({ message, statuscode: statusCode, data });
  };

  next();
};
