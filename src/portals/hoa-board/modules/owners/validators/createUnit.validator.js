/**
 * ------------------------------------------------------------------
 * File: createUnit.validator.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * owner.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');
const { validateAndCoerceMoney } = require('../../../../../common/validators/money.schema');
const { ClockService, DateUtil } = require('../../../../../common/date');
const { optionalPersonNameFieldJoi } = require('../../../../../shared/utils/personNameValidation.util');
const objectIdRegex = /^[0-9a-fA-F]{24}$/;

const MIN_STARTING_BALANCE = -5000;
const MAX_STARTING_BALANCE = 1000000;

const normalizeStartingBalanceInput = (value, helpers) => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = validateAndCoerceMoney(value, helpers, { allowNegative: true });
  if (typeof n !== 'number') return n;
  if (n < MIN_STARTING_BALANCE) {
    return MIN_STARTING_BALANCE;
  }
  if (n > MAX_STARTING_BALANCE) {
    return helpers.error('startingBalance.dueLimit');
  }
  return n;
};

const emergencyContactSchema = Joi.object({
  name: Joi.string().trim().max(100).optional().allow('').messages({
    'string.max': 'emergency contact name cannot exceed 100 characters'
  }),
  firstName: optionalPersonNameFieldJoi('Emergency contact first name', { max: 50 }),
  lastName: optionalPersonNameFieldJoi('Emergency contact last name', { max: 50 }),
  phone: Joi.string().trim().pattern(/^\d{10}$/).optional().allow('').messages({
    'string.pattern.base': 'emergency contact phone must be exactly 10 digits'
  }),
  email: Joi.string().email().optional().allow('').messages({
    'string.email': 'emergency contact email must be valid'
  })
}).optional().custom((value, helpers) => {
  const hasFirstName = value.firstName && value.firstName.trim();
  const hasPhone = value.phone && value.phone.trim();
  const hasEmail = value.email && value.email.trim();

  if (hasFirstName && !hasPhone && !hasEmail) {
    return helpers.error('emergencyContact.contactRequired');
  }
  if (!hasFirstName && (hasPhone || hasEmail)) {
    return helpers.error('emergencyContact.firstNameRequired');
  }
  return value;
}).messages({
  'emergencyContact.contactRequired': 'Emergency contact phone or email is required when first name is provided',
  'emergencyContact.firstNameRequired': 'Emergency contact first name is required when phone or email is provided'
});

const addressSchema = Joi.object({
  line1: Joi.string().trim().min(1).max(100).required().messages({
    'string.empty': 'address line1 cannot be empty',
    'string.min': 'address line1 is required',
    'string.max': 'address line1 cannot exceed 100 characters',
    'any.required': 'address line1 is required'
  }),
  line2: Joi.string().trim().max(100).optional().allow('').messages({
    'string.max': 'address line2 cannot exceed 100 characters'
  }),
  city: Joi.string().trim().min(1).max(50).required().messages({
    'string.empty': 'city cannot be empty',
    'string.min': 'city is required',
    'string.max': 'city cannot exceed 50 characters',
    'any.required': 'city is required'
  }),
  state: Joi.string().trim().min(1).max(50).required().messages({
    'string.empty': 'state cannot be empty',
    'string.min': 'state is required',
    'string.max': 'state cannot exceed 50 characters',
    'any.required': 'state is required'
  }),
  zipCode: Joi.string().pattern(/^\d{5}(-\d{4})?$/).required().messages({
    'string.pattern.base': 'zipCode must be a valid US zip code (12345 or 12345-6789)',
    'any.required': 'zipCode is required'
  })
});

const unitTitleNotSameAsCity = (value, helpers) => {
  const title = String(value || '').trim();
  const city = String(helpers?.state?.ancestors?.[0]?.address?.city || '').trim();
  if (title && city && title.toLowerCase() === city.toLowerCase()) {
    return helpers.error('title.sameAsCity');
  }
  return value;
};

const unitSchemaBase = {
  propertyName: Joi.string().trim().min(1).max(100).required().messages({
    'string.empty': 'propertyName is required',
    'string.min': 'propertyName is required',
    'string.max': 'propertyName cannot exceed 100 characters',
    'any.required': 'propertyName is required'
  }),
  title: Joi.string().trim().min(1).max(100).required().custom(unitTitleNotSameAsCity).messages({
    'string.empty': 'title is required',
    'string.min': 'title is required',
    'string.max': 'title cannot exceed 100 characters',
    'any.required': 'title is required',
    'title.sameAsCity': 'Unit Number cannot be the same as City. Please enter a valid unit number.',
  }),
  description: Joi.string().trim().max(500).optional().allow('').messages({
    'string.max': 'description cannot exceed 500 characters'
  }),
  emergencyContact: emergencyContactSchema,
  address: addressSchema.required().messages({
    'any.required': 'address is required'
  }),
  // Multipart form sends numbers as strings (e.g. "-500", "100") - coerce to numbers
  startingBalance: Joi.alternatives()
    .try(Joi.number(), Joi.string().trim())
    .optional()
    .custom(normalizeStartingBalanceInput)
    .messages({
      'any.invalid': 'startingBalance must be a valid number',
      'money.scientific': 'startingBalance must be a valid amount without scientific notation',
      'money.format': 'startingBalance must be a valid amount',
      'startingBalance.dueLimit': 'startingBalance cannot exceed 1000000 (maximum due amount of 1000000)',
    }),
  balanceAsOf: Joi.when('startingBalance', {
    is: Joi.exist(),
    then: Joi.alternatives()
      .try(
        Joi.string().pattern(/^\d{4}-\d{2}-\d{2}/),
        Joi.date().iso()
      )
      .required()
      .custom((value, helpers) => {
        if (value == null) return value;
        const s = typeof value === 'string' ? value.trim() : '';
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) {
          return helpers.error('date.format');
        }
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      })
      .messages({
        'date.format': 'balanceAsOf must be a valid date',
        'any.required': 'balanceAsOf is required when startingBalance is provided',
      }),
    otherwise: Joi.alternatives()
      .try(
        Joi.string().pattern(/^\d{4}-\d{2}-\d{2}/),
        Joi.date().iso()
      )
      .optional()
      .allow(null, '')
      .custom((value) => {
        if (value == null || value === '') return undefined;
        const s = typeof value === 'string' ? value.trim() : '';
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return undefined;
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      })
      .messages({
        'date.format': 'balanceAsOf must be a valid date',
      }),
  }),
  monthlyRecurringFee: Joi.when('startingBalance', {
    is: Joi.exist(),
    then: Joi.alternatives()
      .try(Joi.number(), Joi.string().trim())
      .required()
      .custom((value, helpers) => {
        const n = validateAndCoerceMoney(value, helpers, { min: 0, positive: true });
        if (typeof n !== 'number') return n;
        if (n <= 0) return helpers.error('number.greater');
        return n;
      })
      .messages({
        'number.greater': 'monthlyRecurringFee must be greater than 0',
        'any.required': 'monthlyRecurringFee is required when startingBalance is provided',
      }),
    otherwise: Joi.alternatives()
      .try(Joi.number(), Joi.string().trim())
      .optional()
      .custom((value, helpers) => {
        if (value == null || value === '') return undefined;
        const n = validateAndCoerceMoney(value, helpers, { min: 0 });
        if (typeof n !== 'number') return n;
        return n;
      })
      .messages({
        'number.base': 'monthlyRecurringFee must be a number',
        'number.min': 'monthlyRecurringFee cannot be negative',
      }),
  }),
  paymentTerm: Joi.when('startingBalance', {
    is: Joi.exist(),
    then: Joi.alternatives()
      .try(Joi.number().valid(12, 24, 36, 60), Joi.string().valid('12', '24', '36', '60'))
      .required()
      .custom((value, helpers) => {
        const n = Number(value);
        if (![12, 24, 36, 60].includes(n)) {
          return helpers.error('any.only');
        }
        return n;
      })
      .messages({
        'any.only': 'paymentTerm must be one of: 12 (1 year), 24 (2 years), 36 (3 years), 60 (5 years)',
        'any.required': 'paymentTerm is required when startingBalance is provided',
      }),
    otherwise: Joi.alternatives()
      .try(Joi.number().valid(12, 24, 36, 60), Joi.string().valid('12', '24', '36', '60'))
      .optional()
      .custom((v) => (v == null || v === '' ? undefined : Number(v)))
      .messages({
        'any.only': 'paymentTerm must be one of: 12 (1 year), 24 (2 years), 36 (3 years), 60 (5 years)',
      }),
  }),
  // HOA Settings → Payment Term → Due day of month (1–31); drives first scheduled fee invoice date
  paymentDueDay: Joi.when('startingBalance', {
    is: Joi.exist(),
    then: Joi.alternatives()
      .try(Joi.number().integer().min(1).max(31), Joi.string().pattern(/^(?:[1-9]|[12]\d|3[01])$/))
      .required()
      .custom((value, helpers) => {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 31) {
          return helpers.error('any.invalid');
        }
        return n;
      })
      .messages({
        'any.required': 'paymentDueDay is required when startingBalance is provided (from HOA Payment Term)',
        'any.invalid': 'paymentDueDay must be an integer from 1 to 31',
      }),
    otherwise: Joi.alternatives()
      .try(Joi.number().integer().min(1).max(31), Joi.string().pattern(/^(?:[1-9]|[12]\d|3[01])$/))
      .optional()
      .custom((v) => (v == null || v === '' ? undefined : Number(v)))
      .messages({
        'any.invalid': 'paymentDueDay must be an integer from 1 to 31',
      }),
  }),
  depositBankAccountId: Joi.string().pattern(objectIdRegex).required().messages({
    'string.pattern.base': 'depositBankAccountId must be a valid ObjectId',
    'any.required': 'depositBankAccountId is required'
  }),
  depositBankAccountName: Joi.string().trim().max(200).optional().allow('', null).messages({
    'string.max': 'depositBankAccountName cannot exceed 200 characters'
  }),
  tags: Joi.array().items(Joi.string().trim().max(50)).optional().default([]).messages({
    'string.max': 'each tag cannot exceed 50 characters'
  }),
  boardMemberId: Joi.string().pattern(objectIdRegex).optional().messages({
    'string.pattern.base': 'boardMemberId must be a valid ObjectId'
  }),
  associatedOwnerIds: Joi.array().items(Joi.string().pattern(objectIdRegex).messages({
    'string.pattern.base': 'associatedOwnerId must be a valid ObjectId'
  })).optional().default([]),
  ownerIds: Joi.array().items(Joi.string().pattern(objectIdRegex).messages({
    'string.pattern.base': 'ownerId must be a valid ObjectId'
  })).optional().default([]),
  // Injected by hoaDataIsolation on POST (HOA board portal)
  createdBy: Joi.any().optional(),
  hoaId: Joi.any().optional(),
  hoaBoardMemberId: Joi.any().optional(),
  billingTimezone: Joi.string().trim().optional(),
  billingTimezoneSource: Joi.string().valid('zip_lookup', 'manual', 'default').optional(),
};

const createUnitSchema = Joi.object(unitSchemaBase);

const addOwnerSchema = Joi.object({
  ownerId: Joi.string().pattern(objectIdRegex).required().messages({
    'string.pattern.base': 'ownerId must be a valid ObjectId',
    'any.required': 'ownerId is required'
  }),
  startDate: Joi.date().iso().required().messages({
    'date.format': 'startDate must be a valid ISO date',
    'any.required': 'startDate is required'
  }),
  financialHandling: Joi.string().valid('FRESH', 'INCLUDE_BALANCE').required().messages({
    'any.only': 'financialHandling must be either FRESH or INCLUDE_BALANCE',
    'any.required': 'financialHandling is required'
  }),
  createdBy: Joi.any().optional(),
  hoaId: Joi.any().optional(),
  hoaBoardMemberId: Joi.any().optional(),
});

const removeOwnerSchema = Joi.object({
  ownerId: Joi.string().pattern(objectIdRegex).required().messages({
    'string.pattern.base': 'ownerId must be a valid ObjectId',
    'any.required': 'ownerId is required'
  }),
  effectiveDate: Joi.date().iso().required().messages({
    'date.format': 'effectiveDate must be a valid ISO date',
    'any.required': 'effectiveDate is required'
  }),
  balanceSettlement: Joi.string()
    .valid('KEEP_AS_IS', 'MARK_PAID', 'WAIVE')
    .optional()
    .messages({ 'any.only': 'balanceSettlement must be KEEP_AS_IS, MARK_PAID, or WAIVE' }),
  paymentMethod: Joi.string()
    .valid('Cash', 'Check', 'Money Order', 'Other')
    .optional()
    .messages({ 'any.only': 'paymentMethod must be Cash, Check, Money Order, or Other' }),
  checkNumber: Joi.string().trim().max(100).optional().allow('', null),
  moneyOrderNumber: Joi.string().trim().max(100).optional().allow('', null),
  createdBy: Joi.any().optional(),
  hoaId: Joi.any().optional(),
  hoaBoardMemberId: Joi.any().optional(),
});

const changeOwnershipSchema = Joi.object({
  newOwnerIds: Joi.array().items(
    Joi.string().pattern(objectIdRegex).messages({
      'string.pattern.base': 'newOwnerId must be a valid ObjectId'
    })
  ).min(1).required().messages({
    'array.min': 'At least one new owner is required',
    'any.required': 'newOwnerIds is required'
  }),
  effectiveDate: Joi.date().iso().required().messages({
    'date.format': 'effectiveDate must be a valid ISO date',
    'any.required': 'effectiveDate is required'
  }),
  balanceHandling: Joi.string().valid('MIGRATE', 'RESET').required(),
  chargeHandling: Joi.string().valid('KEEP', 'CONSOLIDATE').required(),
  futureCharges: Joi.string().valid('KEEP', 'CLEAR').required(),
  templateHandling: Joi.string().valid('KEEP', 'REMOVE').required(),
  paymentMethod: Joi.string()
    .valid('Cash', 'Check', 'Money Order', 'Other')
    .optional()
    .allow(null, '')
    .messages({ 'any.only': 'paymentMethod must be Cash, Check, Money Order, or Other' }),
  checkNumber: Joi.string().trim().max(100).optional().allow('', null),
  moneyOrderNumber: Joi.string().trim().max(100).optional().allow('', null),
  createdBy: Joi.any().optional(),
  hoaId: Joi.any().optional(),
  hoaBoardMemberId: Joi.any().optional(),
});

const updateUnitSchema = Joi.object({
  ...unitSchemaBase,
  startingBalance: Joi.alternatives()
    .try(Joi.number(), Joi.string().trim())
    .optional()
    .custom(normalizeStartingBalanceInput)
    .messages({
      'any.invalid': 'startingBalance must be a valid number',
      'money.scientific': 'startingBalance must be a valid amount without scientific notation',
      'money.format': 'startingBalance must be a valid amount',
      'startingBalance.dueLimit': 'startingBalance cannot exceed 1000000 (maximum due amount of 1000000)',
    }),
  balanceAsOf: Joi.date().iso().optional().messages({
    'date.format': 'balanceAsOf must be a valid ISO date'
  }),
  monthlyRecurringFee: Joi.number().min(0).optional().messages({
    'number.base': 'monthlyRecurringFee must be a number',
    'number.min': 'monthlyRecurringFee cannot be negative'
  }),
  paymentTerm: Joi.number().valid(12, 24, 36, 60).optional().messages({
    'any.only': 'paymentTerm must be one of: 12 (1 year), 24 (2 years), 36 (3 years), 60 (5 years)'
  }),
  propertyName: Joi.string().trim().min(1).max(100).optional().messages({
    'string.empty': 'propertyName is required',
    'string.min': 'propertyName is required',
    'string.max': 'propertyName cannot exceed 100 characters'
  }),
  title: Joi.string().trim().min(1).max(100).optional().custom(unitTitleNotSameAsCity).messages({
    'string.empty': 'Unit Number is required',
    'string.min': 'Unit Number is required',
    'string.max': 'Unit Number cannot exceed 100 characters',
    'title.sameAsCity': 'Unit Number cannot be the same as City. Please enter a valid unit number.',
  }),
  address: addressSchema.optional(),
  depositBankAccountId: Joi.string().pattern(objectIdRegex).optional().messages({
    'string.pattern.base': 'depositBankAccountId must be a valid ObjectId'
  }),
  depositBankAccountName: Joi.string().trim().max(200).optional().allow('', null).messages({
    'string.max': 'depositBankAccountName cannot exceed 200 characters'
  }),
  tags: Joi.array().items(Joi.string().trim().max(50)).optional().messages({
    'string.max': 'each tag cannot exceed 50 characters'
  }),
  associatedOwnerIds: Joi.array().items(Joi.string().pattern(objectIdRegex).messages({
    'string.pattern.base': 'associatedOwnerId must be a valid ObjectId'
  })).optional(),
  ownerIds: Joi.array().items(Joi.string().pattern(objectIdRegex).messages({
    'string.pattern.base': 'ownerId must be a valid ObjectId'
  })).optional()
}).min(1);

const reassignDepositBankSchema = Joi.object({
  fromBankAccountId: Joi.string().pattern(objectIdRegex).required().messages({
    'string.pattern.base': 'fromBankAccountId must be a valid ObjectId',
    'any.required': 'fromBankAccountId is required',
  }),
  toBankAccountId: Joi.string().pattern(objectIdRegex).required().messages({
    'string.pattern.base': 'toBankAccountId must be a valid ObjectId',
    'any.required': 'toBankAccountId is required',
  }),
  toBankAccountName: Joi.string().trim().min(1).max(200).required().messages({
    'string.empty': 'toBankAccountName is required',
    'any.required': 'toBankAccountName is required',
  }),
});

const ownershipEventLogParamSchema = Joi.object({
  id: Joi.string().pattern(objectIdRegex).required().messages({
    'string.pattern.base': 'Unit id must be a valid ObjectId',
    'any.required': 'Unit id is required',
  }),
  logId: Joi.string().pattern(objectIdRegex).required().messages({
    'string.pattern.base': 'logId must be a valid ObjectId',
    'any.required': 'logId is required',
  }),
});

module.exports = {
  createUnitSchema,
  updateUnitSchema,
  addOwnerSchema,
  removeOwnerSchema,
  changeOwnershipSchema,
  reassignDepositBankSchema,
  ownershipEventLogParamSchema,
};
