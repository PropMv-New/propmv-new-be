/**
 * ------------------------------------------------------------------
 * File: application.validator.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * application.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');
const { INTERNATIONAL_PHONE_REGEX } = require('../../../../../shared/utils/phoneValidation.util');

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

const contactSchema = Joi.object({
  firstName: Joi.string().min(1).required(),
  lastName: Joi.string().min(1).required(),
  email: Joi.string().email().required(),
  phone: Joi.string().pattern(INTERNATIONAL_PHONE_REGEX).required(),
});

const employmentSchema = Joi.object({
  employer: Joi.string().required(),
  titleOrPosition: Joi.string().required(),
  startDate: Joi.date().required(),
  // endDate may be a date (past employment) or the string 'Present' for current jobs, or omitted/null
  endDate: Joi.alternatives().try(Joi.date(), Joi.string().valid('Present')).optional().allow(null),
  contact: contactSchema.required(),
});

const landlordContactSchema = Joi.object({
  name: Joi.string().required(),
  email: Joi.string().email().optional().allow('', null),
  phone: Joi.string().pattern(INTERNATIONAL_PHONE_REGEX).optional().allow('', null),
});

const rentalHistorySchema = Joi.object({
  streetAddress: Joi.string().required(),
  city: Joi.string().required(),
  state: Joi.string().required(),
  zip: Joi.string().required(),
  moveInDate: Joi.date().required(),
  // Current residence often has no move-out yet; allow null/empty/Present like employment endDate
  moveOutDate: Joi.alternatives()
    .try(
      Joi.date(),
      Joi.string().isoDate(),
      Joi.string().valid('Present'),
      Joi.valid(null, '')
    )
    .optional(),
  monthlyRent: Joi.number().required(),
  landlordOrManager: landlordContactSchema.required(),
});

const personalInformationSchema = Joi.object({
  firstName: Joi.string().required(),
  lastName: Joi.string().required(),
  mobileNumber: Joi.string().pattern(INTERNATIONAL_PHONE_REGEX).optional().allow('', null),
  email: Joi.string().email().required(),
  birthDate: Joi.date().required(),
});

const addressInformationSchema = Joi.object({
  addressLine1: Joi.string().required(),
  city: Joi.string().required(),
  state: Joi.string().required(),
  zip: Joi.string().required(),
});

const referencesSchema = Joi.object({
  firstName: Joi.string().optional().allow('', null),
  lastName: Joi.string().optional().allow('', null),
  mobileNumber: Joi.string().pattern(INTERNATIONAL_PHONE_REGEX).optional().allow('', null),
  email: Joi.string().email().optional().allow('', null),
  relation: Joi.string().optional().allow('', null),
});

const emergencyContactSchema = Joi.object({
  firstName: Joi.string().optional().allow('', null),
  lastName: Joi.string().optional().allow('', null),
  mobileNumber: Joi.string().pattern(INTERNATIONAL_PHONE_REGEX).optional().allow('', null),
  email: Joi.string().email().optional().allow('', null),
});

const createApplicationSchema = Joi.object({
  propertyId: Joi.string().pattern(objectIdRegex).required(),
  personalInformation: personalInformationSchema.required(),
  addressInformation: addressInformationSchema.required(),
  employmentHistory: Joi.array().items(employmentSchema).optional(),
  rentalHistory: Joi.array().items(rentalHistorySchema).optional(),
  references: referencesSchema.optional().allow(null),
  emergencyContact: emergencyContactSchema.optional().allow(null),
  screeningPropertyStatus: Joi.string().trim().max(500).optional().allow('', null),
  desiredMoveInDate: Joi.alternatives()
    .try(Joi.date(), Joi.string().isoDate(), Joi.valid(null, ''))
    .optional(),
  annualIncome: Joi.alternatives()
    .try(Joi.number(), Joi.valid(null, ''))
    .optional(),
});

const updateApplicationSchema = Joi.object({
  propertyId: Joi.string().pattern(objectIdRegex).optional(),
  personalInformation: personalInformationSchema.optional(),
  addressInformation: addressInformationSchema.optional(),
  employmentHistory: Joi.array().items(employmentSchema).optional(),
  rentalHistory: Joi.array().items(rentalHistorySchema).optional(),
  references: referencesSchema.optional(),
  emergencyContact: emergencyContactSchema.optional(),
  screeningPropertyStatus: Joi.string().trim().max(500).optional().allow('', null),
  desiredMoveInDate: Joi.alternatives()
    .try(Joi.date(), Joi.string().isoDate(), Joi.valid(null, ''))
    .optional(),
  annualIncome: Joi.alternatives()
    .try(Joi.number(), Joi.valid(null, ''))
    .optional(),
});

const idParamSchema = Joi.object({ id: Joi.string().pattern(objectIdRegex).required() });

const listQuerySchema = Joi.object({
  createdBy: Joi.string().pattern(objectIdRegex).optional(),
  propertyId: Joi.string().pattern(objectIdRegex).optional(),
  propertyIds: Joi.string().optional(), // comma-separated property IDs
  email: Joi.string().email().optional(),
  firstName: Joi.string().optional(),
  lastName: Joi.string().optional(),
  applicantName: Joi.string().optional(), // search in both firstName and lastName
  status: Joi.string().valid('submitted', 'pending', 'approved', 'rejected', 'expired', 'lease_created').optional(),
  pageNumber: Joi.number().integer().min(1).optional(),
  pageSize: Joi.number().integer().min(1).max(200).optional(),
});

const exportQuerySchema = Joi.object({
  createdBy: Joi.string().pattern(objectIdRegex).optional(),
  propertyId: Joi.string().pattern(objectIdRegex).optional(),
  propertyIds: Joi.string().optional(), // comma-separated property IDs
  email: Joi.string().email().optional(),
  firstName: Joi.string().optional(),
  lastName: Joi.string().optional(),
  applicantName: Joi.string().optional(), // search in both firstName and lastName
  status: Joi.string().valid('submitted', 'pending', 'approved', 'rejected', 'expired', 'lease_created').optional(),
  format: Joi.string().valid('csv', 'xlsx', 'excel', 'json').optional(),
});

const createBlankApplicationSchema = Joi.object({
  tenantId: Joi.string().pattern(objectIdRegex).required(),
  leaseId: Joi.string().pattern(objectIdRegex).optional(),
});

/** Public: tenant acknowledges lease invite (no screening / post-invite link). */
const leaseInviteAckSchema = Joi.object({
  leaseId: Joi.string().pattern(objectIdRegex).required(),
  tenantId: Joi.string().pattern(objectIdRegex).required(),
});

/** Request application from prospective tenant - send screening email without lease creation */
const requestApplicationSchema = Joi.object({
  email: Joi.string().email().required(),
  screening: Joi.array().items(Joi.string().valid('application', 'credit', 'criminal')).optional().default([]),
  propertyName: Joi.string().optional(),
});

/** Submit screening application with createdBy (from request application flow) */
const submitApplicationWithCreatedBySchema = Joi.object({
  createdBy: Joi.string().pattern(objectIdRegex).required(),
  propertyId: Joi.string().pattern(objectIdRegex).optional(),
  personalInformation: personalInformationSchema.required(),
  addressInformation: addressInformationSchema.required(),
  employmentHistory: Joi.array().items(employmentSchema).optional(),
  rentalHistory: Joi.array().items(rentalHistorySchema).optional(),
  references: referencesSchema.optional().allow(null),
  emergencyContact: emergencyContactSchema.optional().allow(null),
  screeningPropertyStatus: Joi.string().trim().max(500).optional().allow('', null),
  desiredMoveInDate: Joi.alternatives()
    .try(Joi.date(), Joi.string().isoDate(), Joi.valid(null, ''))
    .optional(),
  annualIncome: Joi.alternatives()
    .try(Joi.number(), Joi.valid(null, ''))
    .optional(),
});

module.exports = {
  createApplicationSchema,
  updateApplicationSchema,
  idParamSchema,
  listQuerySchema,
  exportQuerySchema,
  createBlankApplicationSchema,
  leaseInviteAckSchema,
  requestApplicationSchema,
  submitApplicationWithCreatedBySchema,
};
