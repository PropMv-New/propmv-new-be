/**
 * ------------------------------------------------------------------
 * File: phoneValidation.util.js
 * Module: Src Shared Utils
 *
 * Purpose:
 * Backend utility/module providing helper functions for phoneValidation.util.
 *
 * Used By:
 * application.validator, property.model, property.validator, tenant.service
 * ------------------------------------------------------------------
 */

// Allows international phone formats while enforcing 7-15 digits overall.
// Examples supported: +919923563591, +1 (415) 555-2671, 020-1234-5678
const INTERNATIONAL_PHONE_REGEX = /^(?=(?:\D*\d){7,15}\D*$)\+?[0-9\s().-]+$/;

const SIGNUP_PHONE_FORMAT_REGEX = /^[0-9+\-\s()]+$/;
const US_PHONE_CORE_REGEX = /^[2-9]\d{2}[2-9]\d{6}$/;

const isValidInternationalPhone = (value) => {
  if (typeof value !== 'string') return false;
  return INTERNATIONAL_PHONE_REGEX.test(value.trim());
};

/**
 * digits From Phone
 *
 * Performs logic operations for digitsFromPhone.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function digitsFromPhone(value) {
  return String(value || '').replace(/\D/g, '');
}

/** Matches HOA Board Member signup / auth signup US phone rules (+ international 10–15 digits). */
function isValidSignupPhone(value) {
  if (value == null || String(value).trim() === '') return true;
  const digitsOnly = digitsFromPhone(value);
  if (digitsOnly.length < 10 || digitsOnly.length > 15) return false;
  if (digitsOnly.length === 10) return US_PHONE_CORE_REGEX.test(digitsOnly);
  if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) {
    return /^1[2-9]\d{2}[2-9]\d{6}$/.test(digitsOnly);
  }
  return true;
}

/**
 * signup Phone Joi Custom
 *
 * Performs logic operations for signupPhoneJoiCustom.
 *
 * @param value - Request/input argument
 * @param helpers - Request/input argument
 * @returns Operations result
 */
function signupPhoneJoiCustom(value, helpers) {
  if (!value) return value;
  if (!SIGNUP_PHONE_FORMAT_REGEX.test(value)) {
    return helpers.error('string.pattern.base');
  }
  if (!isValidSignupPhone(value)) {
    return helpers.error('any.invalid');
  }
  return value;
}

const SIGNUP_PHONE_JOI_MESSAGES = {
  'string.pattern.base': 'Phone number can only contain digits, +, -, spaces, and ()',
  'string.min': 'Phone number must be at least 10 characters',
  'string.max': 'Phone number must not exceed 20 characters',
  'any.invalid': 'Invalid phone number format. US numbers must be 10 digits starting with area code (2-9)',
};

module.exports = {
  INTERNATIONAL_PHONE_REGEX,
  SIGNUP_PHONE_FORMAT_REGEX,
  SIGNUP_PHONE_JOI_MESSAGES,
  isValidInternationalPhone,
  isValidSignupPhone,
  signupPhoneJoiCustom,
};
