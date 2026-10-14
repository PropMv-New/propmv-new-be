/**
 * ------------------------------------------------------------------
 * File: joiHelper.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for joiHelper.
 *
 * Used By:
 * paymentManagement.validator
 * ------------------------------------------------------------------
 */

const { validateBody, validateQuery, validateParams } = require('../middleware/requestValidator');

/**
 * createValidator - compatibility helper for existing code that expects
 * a `createValidator(schema, location)` function returning an express middleware.
 *
 * location: 'body' | 'query' | 'params'
 */
function createValidator(schema, location = 'body') {
  if (location === 'query') return validateQuery(schema);
  if (location === 'params') return validateParams(schema);
  return validateBody(schema);
}

module.exports = {
  createValidator,
};
