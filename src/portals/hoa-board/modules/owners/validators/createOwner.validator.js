/**
 * ------------------------------------------------------------------
 * File: createOwner.validator.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const Joi = require('joi');
const objectIdRegex = /^[0-9a-fA-F]{23,24}$/i;
const { optionalPersonNameFieldJoi } = require('../../../../../shared/utils/personNameValidation.util');

const createOwnerSchema = Joi.object({
  firstName: Joi.string().required(),
  lastName: Joi.string().required(),
  email: Joi.string().email().required(),
  emailConfirm: Joi.string().email().optional().allow(''),
  phone: Joi.string().trim().pattern(/^(?:\+?1[-\s]?)?\(?\d{3}\)?[-\s.]?\d{3}[-\s.]?\d{4}$/).optional().allow('', null).empty(''),
  mailingAddress: Joi.object({
    line1: Joi.string().optional(),
    line2: Joi.string().optional().allow(''),
    city: Joi.string().optional(),
    state: Joi.string().optional(),
    zipCode: Joi.string().pattern(/^\d{5}(-\d{4})?$/).optional()
  }).optional(),
  emergencyContact: Joi.object({
    firstName: optionalPersonNameFieldJoi('Emergency contact first name', { max: 50 }),
    lastName: optionalPersonNameFieldJoi('Emergency contact last name', { max: 50 }),
    phone: Joi.string().trim().max(20).optional().allow(''),
    email: Joi.string().email().optional().allow('')
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
  }),
  hasUnits: Joi.boolean().required(),
  propertyIds: Joi.when('hasUnits', {
    is: true,
    then: Joi.array().items(Joi.string().pattern(objectIdRegex)).min(1).required(),
    otherwise: Joi.array().items(Joi.string().pattern(objectIdRegex)).optional()
  }),
  unitIds: Joi.when('hasUnits', {
    is: true,
    then: Joi.array().items(Joi.string().pattern(objectIdRegex)).min(1).required(),
    otherwise: Joi.array().items(Joi.string().pattern(objectIdRegex)).optional()
  }),
  sendInvite: Joi.boolean().optional().default(true)
}).custom((value, helpers) => {
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
  'owner.emailConfirmRequired': 'Re-enter the email address to confirm before sending an invitation',
  'owner.emailConfirmMismatch': 'Email addresses do not match',
});

const createUnitSchema = Joi.object({
  title: Joi.string().optional().allow(''),
  address: Joi.object({
    line1: Joi.string().required(),
    line2: Joi.string().optional().allow(''),
    city: Joi.string().required(),
    state: Joi.string().required(),
    zipCode: Joi.string().pattern(/^\d{5}(-\d{4})?$/).required()
  }).required(),
  startingBalance: Joi.number().optional().default(0),
  balanceAsOf: Joi.date().iso().required(),
  depositBankAccountId: Joi.string().pattern(objectIdRegex).required(),
  tags: Joi.array().items(Joi.string()).optional().default([]),
  images: Joi.array().items(Joi.object({
    url: Joi.string().uri().required(),
    type: Joi.string().valid('uploaded', 'street_view').required()
  })).max(5).optional().default([]),
  includeStreetView: Joi.boolean().optional().default(false),
  ownerIds: Joi.array().items(Joi.string().pattern(objectIdRegex)).optional().default([])
});

const importSchema = Joi.object({
  // No specific query parameters required for import
});

const idParamSchema = Joi.object({
  id: Joi.string().pattern(objectIdRegex).required()
});

module.exports = {
  createOwnerSchema,
  createUnitSchema,
  importSchema,
  idParamSchema
};
