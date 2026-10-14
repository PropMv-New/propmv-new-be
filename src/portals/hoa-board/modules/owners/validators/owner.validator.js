/**
 * ------------------------------------------------------------------
 * File: owner.validator.js
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
const objectIdRegex = /^[0-9a-fA-F]{23,24}$/i;
const usPhoneRegex = /^(?:\+?1[-\s]?)?\(?\d{3}\)?[-\s.]?\d{3}[-\s.]?\d{4}$/;
const zipCodeRegex = /^\d{5}(-\d{4})?$/;
const stateCodeRegex = /^[A-Za-z]{2}$/;
const { personNameFieldJoi } = require('../../../../../shared/utils/personNameValidation.util');
const ownerNameField = (label) => personNameFieldJoi(label, { required: true, max: 100 });

const createOwnerSchema = Joi.object({
  firstName: ownerNameField('firstName'),
  lastName: ownerNameField('lastName'),
  email: Joi.string().trim().email().required().messages({
    'string.empty': 'email is required',
    'any.required': 'email is required',
    'string.email': 'email must be a valid email address',
  }),
  emailConfirm: Joi.string().trim().email().optional().allow('').messages({
    'string.email': 'emailConfirm must be a valid email address',
  }),
  phone: Joi.string().trim().pattern(usPhoneRegex).optional().allow('', null).empty('').messages({
    'string.pattern.base': 'phone must be a valid US phone number'
  }),
  isDifferentMailingAddress: Joi.boolean().optional().default(false),
  mailingAddress: Joi.object({
    line1: Joi.string().trim().max(100).optional().allow(''),
    line2: Joi.string().trim().max(100).optional().allow(''),
    city: Joi.string().trim().max(50).optional().allow(''),
    state: Joi.string().trim().uppercase().pattern(stateCodeRegex).optional().allow('').messages({
      'string.pattern.base': 'state must be a valid 2-letter US state code'
    }),
    zipCode: Joi.string().trim().pattern(zipCodeRegex).optional().allow('').messages({
      'string.pattern.base': 'zipCode must be a valid US zip code (12345 or 12345-6789)'
    })
  }).optional(),
  hasUnits: Joi.boolean().required().messages({
    'any.required': 'hasUnits is required'
  }),
  propertyIds: Joi.when('hasUnits', {
    is: true,
    then: Joi.array().items(Joi.string().pattern(objectIdRegex).messages({
      'string.pattern.base': 'propertyId must be a valid ObjectId'
    })).min(1).required().messages({
      'array.min': 'Select at least one property when hasUnits is true',
      'any.required': 'propertyIds is required when hasUnits is true'
    }),
    otherwise: Joi.array().items(Joi.string().pattern(objectIdRegex).messages({
      'string.pattern.base': 'propertyId must be a valid ObjectId'
    })).optional()
  }),
  unitIds: Joi.when('hasUnits', {
    is: true,
    then: Joi.array().items(Joi.string().pattern(objectIdRegex).messages({
      'string.pattern.base': 'unitId must be a valid ObjectId'
    })).min(1).optional(),
    otherwise: Joi.array().items(Joi.string().pattern(objectIdRegex)).optional()
  }),
  emergencyContact: Joi.object({
    firstName: personNameFieldJoi('Emergency contact first name', { required: true, max: 50 }).messages({
      'string.empty': 'Emergency contact first name cannot be empty',
      'string.pattern.base': 'Emergency contact first name contains invalid characters',
      'any.required': 'Emergency contact first name is required',
    }),
    lastName: personNameFieldJoi('Emergency contact last name', { required: false, max: 50 }).messages({
      'string.pattern.base': 'Emergency contact last name contains invalid characters',
    }),
    phone: Joi.string().trim().pattern(usPhoneRegex).optional().allow('').messages({
      'string.pattern.base': 'Emergency contact phone must be a valid US phone number, e.g. (555) 123-4567'
    }),
    email: Joi.string().trim().email().optional().allow('').messages({
      'string.email': 'Emergency contact email must be a valid email address'
    })
  }).optional().custom((value, helpers) => {
    const hasPhone = value.phone && value.phone.trim();
    const hasEmail = value.email && value.email.trim();
    if (!hasPhone && !hasEmail) {
      return helpers.error('emergencyContact.contactRequired');
    }
    return value;
  }).messages({
    'emergencyContact.contactRequired': 'Emergency contact requires at least a phone number or email address'
  }),
  sendInvite: Joi.boolean().optional().default(true),
  // Injected by hoaDataIsolation middleware before validation (HOA board portal)
  createdBy: Joi.any().optional(),
  hoaId: Joi.any().optional(),
  hoaBoardMemberId: Joi.any().optional(),
}).custom((value, helpers) => {
  if (value.isDifferentMailingAddress) {
    const mailingAddress = value.mailingAddress || {};
    if (!mailingAddress.line1) {
      return helpers.error('owner.mailingAddressRequired', { field: 'line1' });
    }
    if (!mailingAddress.city) {
      return helpers.error('owner.mailingAddressRequired', { field: 'city' });
    }
    if (!mailingAddress.state) {
      return helpers.error('owner.mailingAddressRequired', { field: 'state' });
    }
    if (!mailingAddress.zipCode) {
      return helpers.error('owner.mailingAddressRequired', { field: 'zipCode' });
    }
  }

  const sendInvite = value.sendInvite !== false;
  const requireConfirm = !['0', 'false', 'no', 'off'].includes(
    String(process.env.EMAIL_REQUIRE_EMAIL_CONFIRM || 'false').trim().toLowerCase()
  );
  const email = String(value.email || '').trim().toLowerCase();
  const emailConfirm = String(value.emailConfirm || '').trim().toLowerCase();

  if (sendInvite && requireConfirm && !emailConfirm) {
    return helpers.error('owner.emailConfirmRequired');
  }
  if (emailConfirm && emailConfirm !== email) {
    return helpers.error('owner.emailConfirmMismatch');
  }

  return value;
}).messages({
  'owner.mailingAddressRequired': 'mailingAddress.{{#field}} is required when isDifferentMailingAddress is true',
  'owner.emailConfirmRequired': 'Re-enter the email address to confirm before sending an invitation',
  'owner.emailConfirmMismatch': 'Email addresses do not match',
});

const idParamSchema = Joi.object({
  id: Joi.string().pattern(objectIdRegex).required().messages({
    'string.pattern.base': 'id must be a valid ObjectId',
    'any.required': 'id parameter is required'
  })
});

const deleteOwnerBodySchema = Joi.object({
  balanceSettlement: Joi.string()
    .valid('KEEP_AS_IS', 'MARK_PAID', 'WAIVE')
    .optional()
    .messages({ 'any.only': 'balanceSettlement must be KEEP_AS_IS, MARK_PAID, or WAIVE' }),
  paymentMethod: Joi.string()
    .valid('Cash', 'Check', 'Money Order', 'Other')
    .optional()
    .allow(null, '')
    .messages({ 'any.only': 'paymentMethod must be Cash, Check, Money Order, or Other' }),
  checkNumber: Joi.string().trim().max(100).optional().allow('', null),
  moneyOrderNumber: Joi.string().trim().max(100).optional().allow('', null),
}).default({});

module.exports = {
  createOwnerSchema,
  idParamSchema,
  deleteOwnerBodySchema,
};
