/**
 * ------------------------------------------------------------------
 * File: quoteEstimate.validator.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * quoteEstimate.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');

const PROPERTY_TYPES = ['SINGLE_FAMILY', 'DUPLEX', 'TRIPLEX', 'QUADPLEX', 'APARTMENT_BUILDING', 'MOBILE_HOME', 'OTHER'];

const US_STATE_ABBREVS = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
  'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
  'DC','PR','VI','GU','MP','AS',
];

// ── Primary insured - all fields optional ────────────────────────────────────
const primaryInsuredSchema = Joi.object({
  first_name: Joi.string().max(100).optional().allow(null, ''),
  last_name: Joi.string().max(100).optional().allow(null, ''),
  email: Joi.string().email().optional().allow(null, ''),
  phone_number: Joi.string().max(32).optional().allow(null, ''),
  date_of_birth: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional().allow(null, '').messages({
    'string.pattern.base': 'date_of_birth must be in YYYY-MM-DD format',
  }),
  company_name: Joi.string().max(256).optional().allow(null, ''),
  mailing_address: Joi.object({
    street_address: Joi.string().optional().allow(null, ''),
    city: Joi.string().optional().allow(null, ''),
    state: Joi.string().optional().allow(null, ''),
    zip_code: Joi.string().optional().allow(null, ''),
    county: Joi.string().optional().allow(null, ''),
    lat: Joi.number().optional().allow(null),
    lng: Joi.number().optional().allow(null),
  }).optional().allow(null),
});

// ── Address - all fields optional for quote estimate ─────────────────────────
const quoteAddressSchema = Joi.object({
  street_address: Joi.string().optional().allow(null, ''),
  city: Joi.string().optional().allow(null, ''),
  // When provided, state must be a 2-letter US abbreviation
  state: Joi.string().uppercase().valid(...US_STATE_ABBREVS).optional().allow(null, '').messages({
    'any.only': 'address.state must be a 2-letter US state abbreviation (e.g. TX, CA)',
  }),
  zip_code: Joi.string().pattern(/^\d{5}(-\d{4})?$/).optional().allow(null, '').messages({
    'string.pattern.base': 'address.zip_code must be a valid US zip code (e.g. 78701)',
  }),
  county: Joi.string().optional().allow(null, ''),
  lat: Joi.number().min(-90).max(90).optional().allow(null),
  lng: Joi.number().min(-180).max(180).optional().allow(null),
});

// ── Property details - all fields optional for quote estimate ─────────────────
const quotePropertyDetailsSchema = Joi.object({
  property_type: Joi.string().valid(...PROPERTY_TYPES).optional().allow(null).messages({
    'any.only': `property_type must be one of: ${PROPERTY_TYPES.join(', ')}`,
  }),
  size_sqft: Joi.number().integer().min(1).optional().allow(null),
  year_built: Joi.number().integer().min(1800).max(new Date().getFullYear() + 1).optional().allow(null).messages({
    'number.min': 'year_built must be a valid year (1800 or later)',
    'number.max': 'year_built cannot be in the future',
  }),
  number_of_units: Joi.number().integer().min(1).optional().allow(null),
  replacement_value: Joi.number().integer().min(5000).optional().allow(null).messages({
    'number.min': 'replacement_value must be at least $5,000',
  }),
  stories: Joi.number().integer().min(1).optional().allow(null),
  land_value: Joi.number().integer().min(1).optional().allow(null),
  occupancy_type: Joi.string().valid('fix_and_flip', 'rental').optional().allow(null),
});

// ── Property - property_id required, address required, everything else optional
const quotePropertySchema = Joi.object({
  property_id: Joi.string().required().messages({
    'any.required': 'property_id is required for each property',
    'string.empty': 'property_id cannot be empty',
  }),
  current_premium: Joi.number().integer().min(1).optional().allow(null),
  address: quoteAddressSchema.required().messages({
    'any.required': 'address is required for each property',
  }),
  property_details: quotePropertyDetailsSchema.optional().allow(null),
  property_metadata: Joi.object({
    extra: Joi.string().max(1024).optional().allow(null, ''),
  }).optional().allow(null),
});

// ── Top-level request schema ──────────────────────────────────────────────────
const createQuoteEstimateSchema = Joi.object({
  properties: Joi.array().items(quotePropertySchema).min(1).required().messages({
    'any.required': 'properties array is required',
    'array.min': 'At least one property is required',
  }),
  primary_insured: primaryInsuredSchema.optional().allow(null),
  metadata: Joi.object({
    extra: Joi.string().max(1024).optional().allow(null, ''),
  }).optional().allow(null),
});

const createInstantQuoteEstimateSchema = createQuoteEstimateSchema.keys({
  properties: Joi.array().items(quotePropertySchema).length(1).required().messages({
    'any.required': 'properties array is required',
    'array.length': 'Instant quote estimate requires exactly one property',
  }),
});

// ── Pagination / param schemas ────────────────────────────────────────────────
const paginationQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).optional(),
  pageSize: Joi.number().integer().min(1).max(100).optional(),
});

const objectIdParamSchema = Joi.object({
  id: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required().messages({
    'any.required': 'id param is required',
    'string.pattern.base': 'id must be a valid ObjectId',
  }),
});

module.exports = {
  createQuoteEstimateSchema,
  createInstantQuoteEstimateSchema,
  paginationQuerySchema,
  objectIdParamSchema,
};
