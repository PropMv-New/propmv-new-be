/**
 * ------------------------------------------------------------------
 * File: index.js
 * Module: Src Common Exceptions
 *
 * Purpose:
 * Backend utility/module providing helper functions for index.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * ValidationError
 *
 * Represents the Validation Error controller/model class.
 */
class ValidationError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.errors = errors;
  }
}

/**
 * BusinessLogicError
 *
 * Represents the Business Logic Error controller/model class.
 */
class BusinessLogicError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'BusinessLogicError';
    this.status = status;
  }
}

/**
 * NotFoundError
 *
 * Represents the Not Found Error controller/model class.
 */
class NotFoundError extends Error {
  constructor(message = 'Resource not found') {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

/**
 * UnauthorizedError
 *
 * Represents the Unauthorized Error controller/model class.
 */
class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
    this.status = 401;
  }
}

/**
 * ForbiddenError
 *
 * Represents the Forbidden Error controller/model class.
 */
class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
    this.status = 403;
  }
}

/**
 * ConflictError
 *
 * Represents the Conflict Error controller/model class.
 */
class ConflictError extends Error {
  constructor(message = 'Conflict') {
    super(message);
    this.name = 'ConflictError';
    this.status = 409;
  }
}

module.exports = {
  ValidationError,
  BusinessLogicError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError
};