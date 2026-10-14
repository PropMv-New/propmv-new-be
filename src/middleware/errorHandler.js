/**
 * ------------------------------------------------------------------
 * File: errorHandler.js
 * Module: Backend Middleware
 *
 * Purpose:
 * Backend utility/module providing helper functions for errorHandler.
 *
 * Used By:
 * app
 * ------------------------------------------------------------------
 */

const responseHelper = require('../common/helpers/responseHelper');
const { ValidationError, BusinessLogicError, NotFoundError, UnauthorizedError, ForbiddenError, ConflictError } = require('../common/exceptions');
const logger = require('../common/logger');

/**
 * Converts thrown application errors into the API's standard response envelope.
 * This keeps client-facing failures predictable across validation, business logic, and infrastructure errors.
 */
module.exports = function errorHandler(err, req, res, next) {
  // If headers already sent, delegate to default handler
  if (res.headersSent) return next(err);

  // Log the error for debugging
  logger.error('Unhandled error', {
    method: req.method,
    path: req.url,
    error: err.message,
  });

  let status = 500;
  let message = 'Internal Server Error';
  let errors = null;

  // Handle custom exceptions
  if (err instanceof ValidationError) {
    status = err.status;
    message = err.message;
    errors = err.errors;
  } else if (err instanceof BusinessLogicError || err instanceof NotFoundError ||
    err instanceof UnauthorizedError || err instanceof ForbiddenError ||
    err instanceof ConflictError) {
    status = err.status;
    message = err.message;
  } else if (err.name === 'ValidationError' && err.details) {
    // Handle Joi validation errors
    status = 400;
    message = 'Validation failed';
    errors = err.details.map(detail => ({
      field: detail.path.join('.'),
      message: detail.message
    }));
  } else if (err.name === 'CastError') {
    // Handle MongoDB cast errors
    status = 400;
    message = 'Invalid ID format';
  } else if (err.code === 11000) {
    // Handle MongoDB duplicate key errors
    status = 409;
    message = 'Resource already exists';
  } else if (err.code === 'ENOENT') {
    status = 500;
    message = 'Upload storage is not available';
  } else if (err.name === 'MulterError') {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : err.message;
  } else if (err.status || err.statusCode) {
    // Handle errors with status codes - clamp to valid error range to prevent
    // S3/storage redirect codes (3xx) from leaking as API response status
    const raw = err.status || err.statusCode;
    status = (raw >= 400) ? raw : 500;
    message = err.message || message;
  }

  return responseHelper.error(res, message, status, null, errors);
};
