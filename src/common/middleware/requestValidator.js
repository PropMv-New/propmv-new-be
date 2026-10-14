/**
 * ------------------------------------------------------------------
 * File: requestValidator.js
 * Module: Src Common Middleware
 *
 * Purpose:
 * Backend utility/module providing helper functions for requestValidator.
 *
 * Used By:
 * joiHelper, billingSettings.routes, dashboard.routes, expense.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');
const { ValidationError } = require('../exceptions');

/**
 * Format Joi error message to be more user-friendly
 * Removes quotes and technical jargon from default Joi messages
 */
function formatErrorMessage(message) {
  return message
    .replace(/"/g, '') // Remove quotes
    .replace(/\[\]/g, '') // Remove array brackets
    .replace(/must be \[(.+?)\]/, 'must be $1') // Clean up enum messages
    .replace(/fails to match the required pattern/, 'has an invalid format')
    .replace(/with value .+? fails/, 'is invalid');
}

/**
 * validate Body
 *
 * Performs logic operations for validateBody.
 *
 * @param schema - Request/input argument
 * @returns Operations result
 */
function validateBody(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body || {}, { abortEarly: false, allowUnknown: true });
    if (error) {
      const errors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: formatErrorMessage(detail.message)
      }));
      throw new ValidationError('Validation failed', errors);
    }
    req.body = value;
    next();
  };
}

/**
 * validate Query
 *
 * Performs logic operations for validateQuery.
 *
 * @param schema - Request/input argument
 * @returns Operations result
 */
function validateQuery(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.query || {}, { abortEarly: false, allowUnknown: true });
    if (error) {
      const errors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: formatErrorMessage(detail.message)
      }));
      throw new ValidationError('Validation failed', errors);
    }
    req.query = value;
    next();
  };
}

/**
 * validate Params
 *
 * Performs logic operations for validateParams.
 *
 * @param schema - Request/input argument
 * @returns Operations result
 */
function validateParams(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.params || {}, { abortEarly: false, allowUnknown: true });
    if (error) {
      const errors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: formatErrorMessage(detail.message)
      }));
      throw new ValidationError('Validation failed', errors);
    }
    req.params = value;
    next();
  };
}

/**
 * validate
 *
 * Performs logic operations for validate.
 *
 * @param schemas - Request/input argument
 * @returns Operations result
 */
function validate(schemas) {
  return (req, res, next) => {
    const errors = [];
    
    if (schemas.body) {
      const { error } = schemas.body.validate(req.body || {}, { abortEarly: false, allowUnknown: true });
      if (error) {
        errors.push(...error.details.map(detail => ({
          field: detail.path.join('.'),
          message: formatErrorMessage(detail.message)
        })));
      }
    }
    
    if (schemas.query) {
      const { error, value } = schemas.query.validate(req.query || {}, { abortEarly: false, allowUnknown: true });
      if (error) {
        errors.push(...error.details.map(detail => ({
          field: detail.path.join('.'),
          message: formatErrorMessage(detail.message)
        })));
      } else {
        req.query = value;
      }
    }
    
    if (schemas.params) {
      const { error, value } = schemas.params.validate(req.params || {}, { abortEarly: false, allowUnknown: true });
      if (error) {
        errors.push(...error.details.map(detail => ({
          field: detail.path.join('.'),
          message: formatErrorMessage(detail.message)
        })));
      } else {
        req.params = value;
      }
    }
    
    if (errors.length > 0) {
      throw new ValidationError('Validation failed', errors);
    }
    
    next();
  };
}

module.exports = {
  validateBody,
  validateQuery,
  validateParams,
  validate,
  Joi,
};
