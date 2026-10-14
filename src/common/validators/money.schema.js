const Joi = require('joi');

/**
 * Strict decimal string patterns (no scientific notation, no redundant leading zeros).
 * "0", "0.50", "100", "100.50" are valid; "0100", "0000e", "1e5" are not.
 */
const UNSIGNED_MONEY_STRING = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
const SIGNED_MONEY_STRING = /^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
const UNSIGNED_INTEGER_STRING = /^(?:0|[1-9]\d*)$/;
const SIGNED_INTEGER_STRING = /^-?(?:0|[1-9]\d*)$/;

const MONEY_MESSAGES = {
  'money.scientific': 'must be a valid amount without scientific notation',
  'money.format': 'must be a valid amount',
  'money.invalid': 'must be a valid number',
  'money.decimals': 'must have at most 2 decimal places',
};

function containsScientificNotation(value) {
  return typeof value === 'string' && /e/i.test(value.trim());
}

function roundMoney(n) {
  return Math.round(n * 100) / 100;
}

function hasAtMostTwoDecimalPlaces(n) {
  return Math.abs(roundMoney(n) - n) < 1e-9;
}

/**
 * Validates and coerces a monetary value from number or string.
 * Rejects scientific notation strings and amounts with more than 2 decimal places.
 */
function validateAndCoerceMoney(value, helpers, options = {}) {
  const {
    min,
    max,
    allowNegative = false,
    allowZero = true,
    positive = false,
  } = options;

  if (value === undefined || value === null || value === '') {
    return helpers.error('any.required');
  }

  if (containsScientificNotation(value)) {
    return helpers.error('money.scientific');
  }

  let n;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    const pattern = allowNegative ? SIGNED_MONEY_STRING : UNSIGNED_MONEY_STRING;
    if (!pattern.test(trimmed)) {
      return helpers.error('money.format');
    }
    n = parseFloat(trimmed);
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return helpers.error('money.invalid');
    }
    if (!hasAtMostTwoDecimalPlaces(value)) {
      return helpers.error('money.decimals');
    }
    n = value;
  } else {
    return helpers.error('money.invalid');
  }

  n = roundMoney(n);

  if (!allowNegative && n < 0) {
    return helpers.error('number.min', { limit: min ?? 0 });
  }
  if (positive && n <= 0) {
    return helpers.error('number.positive');
  }
  if (!allowZero && n === 0) {
    return helpers.error('number.positive');
  }
  if (min !== undefined && n < min) {
    return helpers.error('number.min', { limit: min });
  }
  if (max !== undefined && n > max) {
    return helpers.error('number.max', { limit: max });
  }

  return n;
}

function validateAndCoerceQuantity(value, helpers, options = {}) {
  const { min = 0, max, allowNegative = false } = options;

  if (value === undefined || value === null || value === '') {
    return helpers.error('any.required');
  }

  if (containsScientificNotation(value)) {
    return helpers.error('money.scientific');
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    const pattern = allowNegative ? SIGNED_INTEGER_STRING : UNSIGNED_INTEGER_STRING;
    if (!pattern.test(trimmed)) {
      return helpers.error('money.format');
    }
  }

  const n = typeof value === 'number' ? value : parseInt(String(value).trim(), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return helpers.error('money.invalid');
  }
  if (n < min) {
    return helpers.error('number.min', { limit: min });
  }
  if (max !== undefined && n > max) {
    return helpers.error('number.max', { limit: max });
  }
  return n;
}

/**
 * Joi schema for monetary amounts (non-negative by default, max 2 decimal places).
 * Uses Joi.any() so invalid strings are not coerced before validation.
 */
function moneyAmount(options = {}) {
  const { required = true, ...coerceOptions } = options;

  let schema = Joi.any()
    .custom((value, helpers) => validateAndCoerceMoney(value, helpers, coerceOptions))
    .messages(MONEY_MESSAGES);

  if (required === false) {
    return schema.optional();
  }

  return schema.required();
}

/** Optional monetary field; empty/null/undefined passes through as undefined. */
function moneyAmountOptional(options = {}) {
  const { preserveNull = false, ...coerceOptions } = options;

  return Joi.any()
    .optional()
    .empty('')
    .allow(null)
    .custom((value, helpers) => {
      if (value === undefined) {
        return undefined;
      }
      if (value === null) {
        return preserveNull ? null : undefined;
      }
      return validateAndCoerceMoney(value, helpers, coerceOptions);
    })
    .messages(MONEY_MESSAGES);
}

/** Signed monetary amount (e.g. starting balance / credits). */
function signedMoneyAmount(options = {}) {
  return moneyAmount({ ...options, allowNegative: true });
}

function signedMoneyAmountOptional(options = {}) {
  return moneyAmountOptional({ ...options, allowNegative: true });
}

/** Whole-number quantity (no decimals, no scientific notation). */
function quantityAmount(options = {}) {
  const { required = true, ...coerceOptions } = options;

  let schema = Joi.any()
    .custom((value, helpers) => validateAndCoerceQuantity(value, helpers, coerceOptions))
    .messages(MONEY_MESSAGES);

  if (required === false) {
    schema = schema.optional().allow(null, '');
  }

  return required ? schema.required() : schema;
}

module.exports = {
  UNSIGNED_MONEY_STRING,
  SIGNED_MONEY_STRING,
  containsScientificNotation,
  roundMoney,
  validateAndCoerceMoney,
  validateAndCoerceQuantity,
  moneyAmount,
  moneyAmountOptional,
  signedMoneyAmount,
  signedMoneyAmountOptional,
  quantityAmount,
};
