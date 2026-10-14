/**
 * ------------------------------------------------------------------
 * File: validationMessageHelper.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for validationMessageHelper.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * Validation Message Helper
 * 
 * This utility helps apply user-friendly error messages to Joi validation schemas.
 * It provides a consistent way to override default Joi error messages with custom ones.
 * 
 * IMPORTANT: This helper does NOT provide fallback messages. All messages must be
 * explicitly defined in the module's message file to ensure clarity and specificity.
 */

/**
 * Apply custom messages to a Joi schema
 * @param {Object} schema - Joi schema object
 * @param {Object} messages - Custom error messages object
 * @returns {Object} - Joi schema with custom messages
 */
function applyMessages(schema, messages) {
  return schema.messages(messages);
}

/**
 * Format validation error with user-friendly message
 * @param {Object} error - Joi validation error
 * @param {Object} messageMap - Map of field paths to custom messages
 * @returns {Array} - Array of formatted error objects
 */
function formatValidationErrors(error, messageMap = {}) {
  if (!error || !error.details) return [];
  
  return error.details.map(detail => {
    const fieldPath = detail.path.join('.');
    const customMessage = messageMap[fieldPath];
    
    return {
      field: fieldPath,
      message: customMessage || detail.message
    };
  });
}

/**
 * Get user-friendly message for a specific field and error type
 * @param {string} field - Field name
 * @param {string} errorType - Type of error (required, invalid, etc.)
 * @param {Object} messages - Module messages object
 * @returns {string} - User-friendly error message
 */
function getFieldMessage(field, errorType, messages) {
  const messageKey = `${field.toUpperCase()}_${errorType.toUpperCase()}`;
  return messages[messageKey];
}

module.exports = {
  applyMessages,
  formatValidationErrors,
  getFieldMessage
};
