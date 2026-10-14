/**
 * ------------------------------------------------------------------
 * File: validationHelper.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for validationHelper.
 *
 * Used By:
 * tenant.service
 * ------------------------------------------------------------------
 */

// Validation helper for common input validations

/**
 * Validates email format using regex pattern
 * @param {string} email - Email to validate
 * @returns {boolean} - True if valid email format
 */
function isValidEmail(email) {
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return emailRegex.test(email);
}

const SPECIAL_CHAR_PATTERN = new RegExp('[!@#$%^&*()_+\\-=\\[\\]{}|;:,.<>?]');

/**
 * Validates password strength requirements:
 * - 8–128 characters
 * - At least 1 uppercase letter
 * - At least 1 lowercase letter
 * - At least 1 digit
 * - At least 1 special character
 * @param {string} password - Password to validate
 * @returns {object} - {isValid: boolean, errors: string[]}
 */
function validatePassword(input) {
  const errors = [];

  if (!input || typeof input !== 'string') {
    errors.push('Password is required');
    return { isValid: false, errors };
  }

  if (input.length < 8) {
    errors.push('Password must be at least 8 characters long');
  }

  if (input.length > 128) {
    errors.push('Password must be at most 128 characters long');
  }

  if (!/[A-Z]/.test(input)) {
    errors.push('Password must contain at least 1 uppercase letter');
  }

  if (!/[a-z]/.test(input)) {
    errors.push('Password must contain at least 1 lowercase letter');
  }

  if (!SPECIAL_CHAR_PATTERN.test(input)) {
    errors.push('Password must contain at least 1 special character');
  }

  if (!/[0-9]/.test(input)) {
    errors.push('Password must contain at least 1 digit');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Validates signup input data
 * @param {object} data - Signup data to validate
 * @returns {object} - {isValid: boolean, errors: string[]}
 */
function validateSignupData(data) {
  const errors = [];

  // Email validation
  if (!data.email) {
    errors.push('Email is required');
  } else if (!isValidEmail(data.email)) {
    errors.push('Please provide a valid email address');
  }

  // Password validation
  if (!data.password) {
    errors.push('Password is required');
  } else {
    const passwordValidation = validatePassword(data.password);
    if (!passwordValidation.isValid) {
      errors.push(...passwordValidation.errors);
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

module.exports = {
  isValidEmail,
  validatePassword,
  validateSignupData
};
