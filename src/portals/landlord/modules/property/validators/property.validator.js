/**
 * ------------------------------------------------------------------
 * File: property.validator.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * property.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');
const logger = require('../../../../../common/logger');
const MSG = require('../messages/property.messages');
const {
  SIGNUP_PHONE_FORMAT_REGEX,
  SIGNUP_PHONE_JOI_MESSAGES,
  signupPhoneJoiCustom,
} = require('../../../../../shared/utils/phoneValidation.util');

const requiredPhoneSchema = Joi.string()
  .required()
  .pattern(SIGNUP_PHONE_FORMAT_REGEX)
  .min(10)
  .max(20)
  .custom(signupPhoneJoiCustom)
  .messages({
    ...SIGNUP_PHONE_JOI_MESSAGES,
    'any.required': 'Phone is required',
    'string.empty': 'Phone is required',
  });

const optionalPhoneSchema = Joi.string()
  .optional()
  .allow('', null)
  .custom((value, helpers) => {
    if (value == null || String(value).trim() === '') return value;
    return signupPhoneJoiCustom(value, helpers);
  })
  .messages(SIGNUP_PHONE_JOI_MESSAGES);

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

const unitSchema = Joi.object({
  unitName: Joi.string().required().messages({
    'any.required': MSG.UNIT_NAME_REQUIRED,
    'string.empty': MSG.UNIT_NAME_REQUIRED
  }),
  unitType: Joi.string().required().messages({
    'any.required': MSG.UNIT_TYPE_REQUIRED,
    'string.empty': MSG.UNIT_TYPE_REQUIRED
  }),
  rentIncludes: Joi.array().items(Joi.string()).optional(),
  bedRooms: Joi.alternatives().try(
    Joi.number().min(0).custom((value, helpers) => {
      // Allow increments of 0.5 (e.g., 1, 1.5, 2, 2.5) with no upper cap.
      if (value % 0.5 !== 0) {
        return helpers.message('Bedrooms must be in increments of 0.5');
      }
      return value;
    }),
    Joi.string().allow(''),
    Joi.valid(null)
  ).optional(),
  bathRoom: Joi.alternatives().try(
    Joi.number().min(0).custom((value, helpers) => {
      // Allow increments of 0.5 with no upper cap.
      if (value % 0.5 !== 0) {
        return helpers.message('Bathrooms must be in increments of 0.5');
      }
      return value;
    }),
    Joi.string().allow(''),
    Joi.valid(null)
  ).optional(),
  amenities: Joi.array().items(Joi.string()).optional(),
  squareFeet: Joi.number().min(1).required().messages({
    'any.required': MSG.SQUARE_FEET_REQUIRED,
    'number.base': MSG.SQUARE_FEET_REQUIRED,
    'number.min': 'Square feet must be greater than 0',
  }),
}).custom((val, helpers) => {
  const ut = (val.unitType || '').toString().toLowerCase();
  if (ut && ut.includes('resid')) {
    if (typeof val.bedRooms === 'undefined' || val.bedRooms === null || val.bedRooms === '') return helpers.message(MSG.BEDROOMS_REQUIRED);
    if (typeof val.bathRoom === 'undefined' || val.bathRoom === null || val.bathRoom === '') return helpers.message(MSG.BATHROOMS_REQUIRED);
    // Amenities are now optional for residential units
  }
  logger.debug('Validated unit schema fields', {
    unitName: val.unitName,
    unitType: val.unitType,
    bedRooms: val.bedRooms,
    bathRoom: val.bathRoom,
    squareFeet: val.squareFeet,
  });
  return val;
}).unknown(true);

const addressSchema = Joi.object({
  street: Joi.string().required().messages({
    'any.required': MSG.STREET_REQUIRED,
    'string.empty': MSG.STREET_REQUIRED
  }),
  line2: Joi.string().optional().allow('').pattern(/^[a-zA-Z0-9\s-]*$/).messages({
    'string.pattern.base': 'Address Line 2 can only contain letters, numbers, spaces, and hyphens'
  }),
  addressLine2: Joi.string().optional().allow('').pattern(/^[a-zA-Z0-9\s-]*$/).messages({
    'string.pattern.base': 'Address Line 2 can only contain letters, numbers, spaces, and hyphens'
  }),
  city: Joi.string().required().messages({
    'any.required': MSG.CITY_REQUIRED,
    'string.empty': MSG.CITY_REQUIRED
  }).pattern(/^[a-zA-Z\s'-]+$/).messages({
    'string.pattern.base': 'City can only contain letters, spaces, hyphens, and apostrophes'
  }),
  state: Joi.string().required().messages({
    'any.required': MSG.STATE_REQUIRED,
    'string.empty': MSG.STATE_REQUIRED
  }),
  zip: Joi.string().length(5).pattern(/^\d{5}$/).required().messages({
    'any.required': MSG.ZIP_REQUIRED,
    'string.empty': MSG.ZIP_REQUIRED,
    'string.length': 'Zip code must be exactly 5 digits',
    'string.pattern.base': 'Zip code must contain only digits'
  }),
  country: Joi.string().required().messages({
    'any.required': MSG.COUNTRY_REQUIRED,
    'string.empty': MSG.COUNTRY_REQUIRED
  }),
}).unknown(true);

const bankAccountAddressSchema = Joi.object({
  street: Joi.string().required().messages({
    'any.required': MSG.STREET_REQUIRED,
    'string.empty': MSG.STREET_REQUIRED
  }),
  line2: Joi.string().optional().allow('').pattern(/^[a-zA-Z0-9\s-]*$/).messages({
    'string.pattern.base': 'Address Line 2 can only contain letters, numbers, spaces, and hyphens'
  }),
  addressLine2: Joi.string().optional().allow('').pattern(/^[a-zA-Z0-9\s-]*$/).messages({
    'string.pattern.base': 'Address Line 2 can only contain letters, numbers, spaces, and hyphens'
  }),
  city: Joi.string().required().messages({
    'any.required': MSG.CITY_REQUIRED,
    'string.empty': MSG.CITY_REQUIRED
  }),
  state: Joi.string().required().messages({
    'any.required': MSG.STATE_REQUIRED,
    'string.empty': MSG.STATE_REQUIRED
  }),
  zip: Joi.string().length(5).pattern(/^\d{5}$/).required().messages({
    'any.required': MSG.ZIP_REQUIRED,
    'string.empty': MSG.ZIP_REQUIRED,
    'string.length': 'Zip code must be exactly 5 digits',
    'string.pattern.base': 'Zip code must contain only digits'
  }),
}).unknown(true);

const paymentBankAccountRef = Joi.string().min(1);

const bankAccountSchema = Joi.object({
  entityType: Joi.string().valid('individual', 'llc', 'corporation', 'partnership', 'trust').default('individual'),
  paymentBankAccountId: Joi.string().optional().allow('').messages({
    'string.base': 'paymentBankAccountId must be a string'
  }),
  // Individual/Trust fields - skipped when linked to Payment Settings bank account
  firstName: Joi.string().when('paymentBankAccountId', {
    is: paymentBankAccountRef,
    then: Joi.optional().allow(''),
    otherwise: Joi.when('entityType', {
      is: Joi.string().valid('individual', 'trust'),
      then: Joi.required(),
      otherwise: Joi.optional().allow('')
    })
  }),
  lastName: Joi.string().when('paymentBankAccountId', {
    is: paymentBankAccountRef,
    then: Joi.optional().allow(''),
    otherwise: Joi.when('entityType', {
      is: Joi.string().valid('individual', 'trust'),
      then: Joi.required(),
      otherwise: Joi.optional().allow('')
    })
  }),
  email: Joi.string().email().when('paymentBankAccountId', {
    is: paymentBankAccountRef,
    then: Joi.optional().allow(''),
    otherwise: Joi.when('entityType', {
      is: Joi.string().valid('individual', 'trust'),
      then: Joi.required(),
      otherwise: Joi.optional().allow('')
    })
  }),
  phone: optionalPhoneSchema.messages({
    'string.pattern.base': 'Phone must be a valid phone number',
  }),
  dob: Joi.date().iso().when('paymentBankAccountId', {
    is: paymentBankAccountRef,
    then: Joi.optional().allow(''),
    otherwise: Joi.when('entityType', {
      is: Joi.string().valid('individual', 'trust'),
      then: Joi.required().custom((v, helpers) => {
        const now = new Date();
        const dob = new Date(v);
        const age = now.getFullYear() - dob.getFullYear() - (now < new Date(now.getFullYear(), dob.getMonth(), dob.getDate()) ? 1 : 0);
        if (age < 18) return helpers.message(MSG.DOB_AGE_INVALID);
        return v;
      }),
      otherwise: Joi.optional().allow('')
    })
  }),
  ssn: Joi.string().pattern(/^\d{3}-\d{2}-\d{4}$/).when('paymentBankAccountId', {
    is: paymentBankAccountRef,
    then: Joi.optional().allow(''),
    otherwise: Joi.when('entityType', {
      is: Joi.string().valid('individual', 'trust'),
      then: Joi.required().messages({
        'any.required': 'SSN is required',
        'string.pattern.base': 'SSN must be in format XXX-XX-XXXX'
      }),
      otherwise: Joi.optional().allow('')
    })
  }),
  // Business Entity fields (LLC/Corporation/Partnership)
  businessName: Joi.string().pattern(/^[a-zA-Z\s'-]+$/).messages({
    'string.pattern.base': 'Business name can only contain letters, spaces, hyphens, and apostrophes'
  }).when('paymentBankAccountId', {
    is: paymentBankAccountRef,
    then: Joi.optional().allow(''),
    otherwise: Joi.when('entityType', {
      is: Joi.string().valid('llc', 'corporation', 'partnership'),
      then: Joi.required(),
      otherwise: Joi.optional().allow('')
    })
  }),
  ein: Joi.string().pattern(/^\d{2}-\d{7}$/).when('paymentBankAccountId', {
    is: paymentBankAccountRef,
    then: Joi.optional().allow(''),
    otherwise: Joi.when('entityType', {
      is: Joi.string().valid('llc', 'corporation', 'partnership'),
      then: Joi.required().messages({
        'any.required': 'EIN is required for business entities',
        'string.pattern.base': 'EIN must be in format XX-XXXXXXX'
      }),
      otherwise: Joi.optional().allow('')
    })
  }),
  itin: Joi.string().pattern(/^\d{3}-\d{2}-\d{4}$/).optional().allow('').messages({
    'string.pattern.base': 'ITIN must be in format 9XX-XX-XXXX'
  }),
  stateOfFormation: Joi.string().when('paymentBankAccountId', {
    is: paymentBankAccountRef,
    then: Joi.optional().allow(''),
    otherwise: Joi.when('entityType', {
      is: Joi.string().valid('llc', 'corporation', 'partnership'),
      then: Joi.required(),
      otherwise: Joi.optional().allow('')
    })
  }),
  // Bank details - required for all assignment modes
  bankName: Joi.string().required().messages({
    'any.required': 'Bank name is required',
    'string.empty': 'Bank name is required'
  }).pattern(/^[a-zA-Z0-9\s'-]+$/).messages({
    'string.pattern.base': 'Bank name can only contain letters, numbers, spaces, hyphens, and apostrophes'
  }),
  accountType: Joi.string().valid('checking', 'savings').required().messages({
    'any.required': 'Account type is required',
    'any.only': 'Account type must be either checking or savings'
  }),
  routingNumber: Joi.string().length(9).pattern(/^\d{9}$/).required().messages({
    'any.required': 'Routing number is required',
    'string.length': 'Routing number must be exactly 9 digits',
    'string.pattern.base': 'Routing number must contain only digits'
  }),
  accountNumber: Joi.string().required().messages({
    'any.required': 'Account number is required',
    'string.empty': 'Account number is required'
  }),
  address: Joi.when('paymentBankAccountId', {
    is: paymentBankAccountRef,
    then: bankAccountAddressSchema.optional(),
    otherwise: bankAccountAddressSchema.required(),
  }),
}).unknown(true);

const jointOwnerSchema = Joi.object({
  name: Joi.string().required().messages({
    'any.required': 'Joint owner name is required',
    'string.empty': 'Joint owner name is required'
  }),
  email: Joi.string().email().required().messages({
    'any.required': 'Joint owner email is required',
    'string.email': 'Joint owner email must be valid'
  }),
  phone: requiredPhoneSchema.messages({
    'any.required': 'Joint owner phone is required',
    'string.pattern.base': 'Phone must be a valid phone number',
  }),
  ownershipPercent: Joi.number().min(0).max(100).required().messages({
    'any.required': 'Ownership percentage is required',
    'number.min': 'Ownership percentage must be at least 0',
    'number.max': 'Ownership percentage cannot exceed 100'
  }),
  role: Joi.string().valid('primary', 'secondary').required().messages({
    'any.required': 'Role is required',
    'any.only': 'Role must be either primary or secondary'
  }),
  payoutPercent: Joi.number().min(0).max(100).required().messages({
    'any.required': 'Payout percentage is required',
    'number.min': 'Payout percentage must be at least 0',
    'number.max': 'Payout percentage cannot exceed 100'
  }),
}).unknown(true);

const lateFeeSchema = Joi.object({
  lateFeeType: Joi.string().required().messages({
    'any.required': 'Late fee type is required'
  }),
  feeAmount: Joi.number().min(0).required().custom((value, helpers) => {
    const parent = helpers.state.ancestors[0];
    const feeType = parent.lateFeeType;
    
    // For percentage types, validate max 100
    if (feeType && (feeType.includes('percentage') || feeType === 'percentage-total' || feeType === 'percentage-outstanding')) {
      if (value > 100) {
        return helpers.message('Fee percentage cannot exceed 100%');
      }
    }
    
    return value;
  }).messages({
    'any.required': 'Fee amount is required',
    'number.min': 'Fee amount must be at least 0'
  }),
  gracePeriod: Joi.number().min(0).required().messages({
    'any.required': 'Grace period is required',
    'number.min': 'Grace period must be at least 0'
  }),
  isRepeat: Joi.boolean().required().messages({
    'any.required': 'Repeat setting is required'
  }),
  applyTo: Joi.string().optional(),
  repeatEvery: Joi.number().integer().min(1).when('isRepeat', { 
    is: true, 
    then: Joi.required().messages({
      'any.required': 'Repeat frequency is required when repeat is enabled'
    }), 
    otherwise: Joi.optional() 
  }),
  repeatEndAfter: Joi.alternatives().try(
    Joi.number().integer().min(1),
    Joi.valid(null)
  ).when('isRepeat', { 
    is: true, 
    then: Joi.optional().allow(null).messages({
      'number.min': 'Repeat end period must be at least 1 day'
    }), 
    otherwise: Joi.optional() 
  }),
  applicableScope: Joi.string().valid('none', 'all', 'specific').optional(),
  applicableUnits: Joi.array().items(Joi.string()).when('applicableScope', {
    is: 'specific',
    then: Joi.array().min(1).required().messages({
      'any.required': 'At least one applicable unit is required',
      'array.min': 'At least one applicable unit is required',
    }),
    otherwise: Joi.array().optional(),
  }),
  chargeEachUnpaidTenat: Joi.boolean().required().messages({
    'any.required': 'Charge per tenant setting is required'
  }),
  isCommon: Joi.boolean().optional(),
}).unknown(true);

const createPropertySchema = Joi.object({
  createdBy: Joi.string().pattern(objectIdRegex).required().messages({
    'any.required': 'createdBy is required',
    'string.pattern.base': 'createdBy must be a valid user id'
  }),
  name: Joi.string().required().messages({
    'any.required': 'Property name is required',
    'string.empty': 'Property name is required'
  }).pattern(/^[a-zA-Z0-9\s'-]+$/).messages({
    'string.pattern.base': 'Property name can only contain letters, numbers, spaces, hyphens, and apostrophes'
  }),
  propertyType: Joi.string().required().messages({
    'any.required': 'Property type is required',
    'string.empty': 'Property type is required'
  }),
  description: Joi.string().optional().allow('', null),
  ownershipType: Joi.string().required().messages({
    'any.required': 'Ownership type is required',
    'string.empty': 'Ownership type is required'
  }),
  propertyManager: Joi.string().optional().allow(''),
  hasHOA: Joi.boolean().required().messages({
    'any.required': 'Please specify whether this property has an HOA',
    'boolean.base': 'HOA field must be true or false'
  }),
  address: addressSchema.required(),
  ownerName: Joi.string().required().messages({
    'any.required': 'Owner name is required',
    'string.empty': 'Owner name is required'
  }),
  ownerEmail: Joi.string().email().required().messages({
    'any.required': 'Owner email is required',
    'string.email': 'Owner email must be valid'
  }),
  ownerPhone: requiredPhoneSchema.messages({
    'any.required': 'Owner phone is required',
    'string.pattern.base': 'Owner phone must be a valid phone number',
  }),
  ownerType: Joi.string().required().messages({
    'any.required': 'Owner type is required'
  }),
  jointOwners: Joi.array().items(jointOwnerSchema).optional().custom((val, helpers) => {
    // If ownershipType is joint-ownership, validate total percentages
    const parent = helpers.state.ancestors[0];
    if (parent.ownershipType === 'joint-ownership' && val && val.length > 0) {
      const totalOwnership = val.reduce((sum, owner) => sum + owner.ownershipPercent, 0);
      const totalPayout = val.reduce((sum, owner) => sum + owner.payoutPercent, 0);
      if (totalOwnership !== 100) return helpers.message('jointOwners total ownershipPercent must equal 100%');
      if (totalPayout !== 100) return helpers.message('jointOwners total payoutPercent must equal 100%');
    }
    return val;
  }),
  amenities: Joi.array().items(Joi.string()).optional(),
  tags: Joi.array().items(Joi.string()).optional(),
  unitDetails: Joi.array().items(unitSchema).min(1).required().messages({
    'any.required': 'At least one unit is required',
    'array.min': 'At least one unit is required'
  }).custom((units, helpers) => {
    // Check for duplicate unit names (case-insensitive)
    const unitNames = units.map(u => (u.unitName || '').trim().toLowerCase()).filter(Boolean);
    const uniqueNames = new Set(unitNames);
    
    if (unitNames.length !== uniqueNames.size) {
      // Find the duplicate names
      const duplicates = unitNames.filter((name, index) => unitNames.indexOf(name) !== index);
      const uniqueDuplicates = [...new Set(duplicates)];
      return helpers.message(`Duplicate unit names found: ${uniqueDuplicates.join(', ')}. Each unit must have a unique name.`);
    }
    
    return units;
  }),
  propertySettings: Joi.object({
    bankAccountMode: Joi.string().valid('shared', 'per-unit').optional(),
    bankAccount: bankAccountSchema.required(),
    unitBankAccounts: Joi.array().items(Joi.object({
      unitName: Joi.string().required(),
      bankAccount: bankAccountSchema.required(),
    }).unknown(true)).optional(),
    lateFees: Joi.array().items(lateFeeSchema).optional(),
  }).required().unknown(true).messages({
    'any.required': 'Property settings are required'
  }),
  billingTimezone: Joi.string().optional(),
  billingTimezoneSource: Joi.string().valid('zip_lookup', 'manual', 'default').optional(),
}).unknown(true);

// update allows partial updates but validates unitDetails if present
const updatePropertySchema = Joi.object({
  name: Joi.string().optional().pattern(/^[a-zA-Z0-9\s'-]+$/).messages({
    'string.pattern.base': 'Property name can only contain letters, numbers, spaces, hyphens, and apostrophes'
  }),
  propertyType: Joi.string().optional(),
  description: Joi.string().optional().allow('', null),
  ownershipType: Joi.string().optional(),
  propertyManager: Joi.string().optional(),
  address: Joi.object({
    street: Joi.string().required(),
    line2: Joi.string().optional().allow('').pattern(/^[a-zA-Z0-9\s-]*$/).messages({
      'string.pattern.base': 'Address Line 2 can only contain letters, numbers, spaces, and hyphens'
    }),
    addressLine2: Joi.string().optional().allow('').pattern(/^[a-zA-Z0-9\s-]*$/).messages({
      'string.pattern.base': 'Address Line 2 can only contain letters, numbers, spaces, and hyphens'
    }),
    city: Joi.string().required().messages({}).pattern(/^[a-zA-Z\s'-]+$/).messages({
      'string.pattern.base': 'City can only contain letters, spaces, hyphens, and apostrophes'
    }),
    state: Joi.string().required(),
    zip: Joi.string().required(),
    country: Joi.string().required(),
  }).optional().unknown(true),
  ownerName: Joi.string().optional(),
  ownerEmail: Joi.string().email().optional(),
  ownerPhone: optionalPhoneSchema.messages({
    'string.pattern.base': 'Owner phone must be a valid phone number',
  }),
  ownerType: Joi.string().optional(),
  jointOwners: Joi.array().items(jointOwnerSchema).optional().custom((val, helpers) => {
    const parent = helpers.state.ancestors[0];
    if (parent.ownershipType === 'joint-ownership' && val && val.length > 0) {
      const totalOwnership = val.reduce((sum, owner) => sum + owner.ownershipPercent, 0);
      const totalPayout = val.reduce((sum, owner) => sum + owner.payoutPercent, 0);
      if (totalOwnership !== 100) return helpers.message('jointOwners total ownershipPercent must equal 100%');
      if (totalPayout !== 100) return helpers.message('jointOwners total payoutPercent must equal 100%');
    }
    return val;
  }),
  amenities: Joi.array().items(Joi.string()).optional(),
  tags: Joi.array().items(Joi.string()).optional(),
  unitDetails: Joi.array().items(unitSchema).min(1).optional().messages({
    'array.min': 'At least one unit is required'
  }).custom((units, helpers) => {
    // Check for duplicate unit names (case-insensitive)
    if (units && units.length > 0) {
      const unitNames = units.map(u => (u.unitName || '').trim().toLowerCase()).filter(Boolean);
      const uniqueNames = new Set(unitNames);
      
      if (unitNames.length !== uniqueNames.size) {
        // Find the duplicate names
        const duplicates = unitNames.filter((name, index) => unitNames.indexOf(name) !== index);
        const uniqueDuplicates = [...new Set(duplicates)];
        return helpers.message(`Duplicate unit names found: ${uniqueDuplicates.join(', ')}. Each unit must have a unique name.`);
      }
    }
    
    return units;
  }),
  propertySettings: Joi.object({
    bankAccountMode: Joi.string().valid('shared', 'per-unit').optional(),
    bankAccount: bankAccountSchema.optional(),
    unitBankAccounts: Joi.array().items(Joi.object({
      unitName: Joi.string().required(),
      bankAccount: bankAccountSchema.required(),
    }).unknown(true)).optional(),
    lateFees: Joi.array().items(lateFeeSchema).optional(),
  }).optional().unknown(true),
  billingTimezone: Joi.string().optional(),
  billingTimezoneSource: Joi.string().valid('zip_lookup', 'manual', 'default').optional(),
}).unknown(true);

const idParamSchema = Joi.object({ id: Joi.string().pattern(objectIdRegex).required() });

const getPropertiesQuerySchema = Joi.object({
  pageNumber: Joi.number().integer().min(1).optional(),
  pageSize: Joi.number().integer().min(0).optional(),
  page: Joi.number().integer().min(1).optional(),
  pagesize: Joi.number().integer().min(0).optional(),
  sortBy: Joi.string().optional(),
  order: Joi.string().valid('asc', 'desc', 'ASC', 'DESC').optional(),
  sortOrder: Joi.string().valid('asc', 'desc', 'ASC', 'DESC').optional(),
  status: Joi.string().optional(),
  name: Joi.string().optional(),
  city: Joi.string().optional(),
  state: Joi.string().optional(),
  zip: Joi.string().optional(),
  numberOfUnits: Joi.number().integer().min(0).optional(),
  hasOpenMaintenance: Joi.boolean().optional(),
  isArchived: Joi.boolean().optional(),
  rentStatus: Joi.string().optional(),
  maintenance: Joi.string().optional(),
  lease: Joi.string().optional(),
  search: Joi.string().optional(),
  format: Joi.string().valid('csv', 'xlsx', 'excel', 'json').optional(),
  includeArchived: Joi.boolean().optional(),
  createdBy: Joi.string().pattern(objectIdRegex).allow('').optional().messages({
    'string.pattern.base': 'createdBy must be a valid user id',
  }),
}).unknown(true);

// Removed listByLandlordQuerySchema (no longer needed)

const updatePropertyQuerySchema = Joi.object({
  propertyId: Joi.string().pattern(objectIdRegex).required(),
});

const importQuerySchema = Joi.object({});

const checkPropertyNameQuerySchema = Joi.object({
  name: Joi.string().trim().min(1).required().pattern(/^[a-zA-Z0-9\s'-]+$/).messages({
    'any.required': 'Property name is required',
    'string.empty': 'Property name is required',
    'string.pattern.base': 'Property name can only contain letters, numbers, spaces, hyphens, and apostrophes',
  }),
  excludePropertyId: Joi.string().pattern(objectIdRegex).optional(),
});

module.exports = {
  createPropertySchema,
  updatePropertySchema,
  idParamSchema,
  getPropertiesQuerySchema,
  importQuerySchema,
  updatePropertyQuerySchema,
  checkPropertyNameQuerySchema,
};
