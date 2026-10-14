/**
 * ------------------------------------------------------------------
 * File: property.validator.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * property.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

const unitSchema = Joi.object({
  unitName: Joi.string().required(),
  unitType: Joi.string().required(),
  rentIncludes: Joi.array().items(Joi.string()).optional(),
  bedRooms: Joi.number().integer().min(0).optional(),
  bathRoom: Joi.number().integer().min(0).optional(),
  amenities: Joi.array().items(Joi.string()).optional(),
  squareFeet: Joi.number().required(),
}).custom((val, helpers) => {
  // If unitType indicates residential, enforce bedRooms and bathRoom.
  const ut = (val.unitType || '').toString().toLowerCase();
  if (ut && ut.includes('resid')) {
    if (typeof val.bedRooms === 'undefined' || val.bedRooms === null) return helpers.message('unitDetails[].bedRooms is required for residential units');
    if (typeof val.bathRoom === 'undefined' || val.bathRoom === null) return helpers.message('unitDetails[].bathRoom is required for residential units');
    // Amenities are optional.
  }
  return val;
});

const addressSchema = Joi.object({
  street: Joi.string().required(),
  line2: Joi.string().optional().allow(''),
  addressLine2: Joi.string().optional().allow(''),
  city: Joi.string().required(),
  state: Joi.string().required(),
  zip: Joi.string().required(),
  country: Joi.string().required(),
});

const bankAccountAddressSchema = Joi.object({
  street: Joi.string().required(),
  line2: Joi.string().optional().allow(''),
  addressLine2: Joi.string().optional().allow(''),
  city: Joi.string().required(),
  state: Joi.string().required(),
  zip: Joi.string().required(),
});

const bankAccountSchema = Joi.object({
  entityType: Joi.string().valid('individual', 'llc', 'corporation', 'partnership', 'trust').optional(),
  firstName: Joi.string().required(),
  lastName: Joi.string().required(),
  email: Joi.string().email().required(),
  phone: Joi.string().required().pattern(/^(?:\+?\d{1,3}[-\s]?)?\(?\d{3,4}\)?[-\s.]?\d{3,4}[-\s.]?\d{4,6}$/),
  dob: Joi.date().iso().required().custom((v, helpers) => {
    const now = new Date();
    const dob = new Date(v);
    const age = now.getFullYear() - dob.getFullYear() - (now < new Date(now.getFullYear(), dob.getMonth(), dob.getDate()) ? 1 : 0);
    if (age < 18) return helpers.message('bankAccount.dob must be a date representing age 18 or older');
    return v;
  }),
  ssn: Joi.string().required(),
  businessName: Joi.string().optional().allow(''),
  ein: Joi.string().optional().allow(''),
  itin: Joi.string().optional().allow(''),
  stateOfFormation: Joi.string().optional().allow(''),
  bankName: Joi.string().optional().allow(''),
  accountType: Joi.string().optional().allow(''),
  routingNumber: Joi.string().optional().allow(''),
  accountNumber: Joi.string().optional().allow(''),
  address: bankAccountAddressSchema.required(),
}).unknown(true);

const lateFeeSchema = Joi.object({
  lateFeeType: Joi.string().required(),
  feeAmount: Joi.number().min(0).required(),
  gracePeriod: Joi.number().min(0).required(),
  isRepeat: Joi.boolean().required(),
  applyTo: Joi.string().optional(),
  repeatEvery: Joi.number().integer().min(1).when('isRepeat', { is: true, then: Joi.required(), otherwise: Joi.optional() }),
  repeatEndAfter: Joi.number().integer().min(1).when('isRepeat', { is: true, then: Joi.required(), otherwise: Joi.optional() }),
  applicableScope: Joi.string().valid('none', 'all', 'specific').optional(),
  applicableUnits: Joi.array().items(Joi.string()).when('applicableScope', {
    is: 'specific',
    then: Joi.array().min(1).required(),
    otherwise: Joi.array().optional(),
  }),
  chargeEachUnpaidTenat: Joi.boolean().required(),
});

const createPropertySchema = Joi.object({
  name: Joi.string().required(),
  propertyType: Joi.string().required(),
  description: Joi.string().optional(),
  ownershipType: Joi.string().required(),
  propertyManager: Joi.string().optional(),
  address: addressSchema.required(),
  ownerName: Joi.string().required(),
  ownerEmail: Joi.string().email().required(),
  ownerPhone: Joi.string().required().pattern(/^(?:\+?\d{1,3}[-\s]?)?\(?\d{3,4}\)?[-\s.]?\d{3,4}[-\s.]?\d{4,6}$/),
  ownerType: Joi.string().required(),
  amenities: Joi.array().items(Joi.string()).optional(),
  unitDetails: Joi.array().items(unitSchema).min(1).required(),
  propertySettings: Joi.object({
    bankAccount: bankAccountSchema.optional(),
    lateFees: Joi.array().items(lateFeeSchema).optional(),
  }).optional(),
  status: Joi.string().optional(),
  billingTimezone: Joi.string().optional(),
  billingTimezoneSource: Joi.string().valid('zip_lookup', 'manual', 'default').optional(),
}).unknown(true);

// update allows partial updates but validates unitDetails if present
const updatePropertySchema = Joi.object({
  name: Joi.string().optional(),
  propertyType: Joi.string().optional(),
  description: Joi.string().optional(),
  ownershipType: Joi.string().optional(),
  propertyManager: Joi.string().optional(),
  address: Joi.object({
    street: Joi.string().required(),
    line2: Joi.string().optional().allow(''),
    addressLine2: Joi.string().optional().allow(''),
    city: Joi.string().required(),
    state: Joi.string().required(),
    zip: Joi.string().required(),
    country: Joi.string().required(),
  }).optional(),
  ownerName: Joi.string().optional(),
  ownerEmail: Joi.string().email().optional(),
  ownerPhone: Joi.string().optional().pattern(/^(?:\+?\d{1,3}[-\s]?)?\(?\d{3,4}\)?[-\s.]?\d{3,4}[-\s.]?\d{4,6}$/),
  ownerType: Joi.string().optional(),
  amenities: Joi.array().items(Joi.string()).optional(),
  unitDetails: Joi.array().items(unitSchema).min(1).optional(),
  propertySettings: Joi.object({
    bankAccount: bankAccountSchema.optional(),
    lateFees: Joi.array().items(lateFeeSchema).optional(),
  }).optional(),
  status: Joi.string().optional(),
  billingTimezone: Joi.string().optional(),
  billingTimezoneSource: Joi.string().valid('zip_lookup', 'manual', 'default').optional(),
}).unknown(true);

const idParamSchema = Joi.object({ id: Joi.string().pattern(objectIdRegex).required() });

const getPropertiesQuerySchema = Joi.object({
  pageNumber: Joi.number().integer().min(1).optional(),
  pageSize: Joi.number().integer().min(0).optional(),
  page: Joi.number().integer().min(1).optional(), // backward compatibility
  pagesize: Joi.number().integer().min(0).optional(), // backward compatibility
  sortBy: Joi.string().optional(),
  sortOrder: Joi.string().valid('asc','desc','ASC','DESC').optional(),
  order: Joi.string().valid('asc','desc','ASC','DESC').optional(),
  status: Joi.string().optional(),
  name: Joi.string().optional(),
  city: Joi.string().optional(),
  state: Joi.string().optional(),
  zip: Joi.string().optional(),
  billingTimezone: Joi.string().optional(),
  billingTimezoneSource: Joi.string().valid('zip_lookup', 'manual', 'default').optional(),
  numberOfUnits: Joi.number().integer().min(0).optional(),
  hasOpenMaintenance: Joi.boolean().optional(),
  rentStatus: Joi.string().optional(),
  maintenance: Joi.string().optional(),
  search: Joi.string().optional(),
  landlordId: Joi.string().pattern(objectIdRegex).optional(),
  /** Filter by board member who owns the property (maps to landlord_id on HOA properties) */
  createdBy: Joi.string().pattern(objectIdRegex).optional(),
  showArchived: Joi.boolean().optional(),
  /** Set by HOA board web app (axios) alongside landlordId */
  context: Joi.string().valid('hoa-board').optional(),
});

const listByLandlordQuerySchema = Joi.object({
  landlordId: Joi.string().pattern(objectIdRegex).required(),
  context: Joi.string().valid('hoa-board').optional(),
  page: Joi.number().integer().min(1).optional(),
  pageSize: Joi.number().integer().min(1).optional(),
});

const updatePropertyQuerySchema = Joi.object({
  landlordId: Joi.string().pattern(objectIdRegex).required(),
  propertyId: Joi.string().pattern(objectIdRegex).required(),
  context: Joi.string().valid('hoa-board').optional(),
});

const importQuerySchema = Joi.object({
  landlordId: Joi.string().pattern(objectIdRegex).required(),
  context: Joi.string().valid('hoa-board').optional(),
});

module.exports = {
  createPropertySchema,
  updatePropertySchema,
  idParamSchema,
  getPropertiesQuerySchema,
  listByLandlordQuerySchema,
  importQuerySchema,
  updatePropertyQuerySchema,
};
