/**
 * ------------------------------------------------------------------
 * File: listing.validator.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * listing.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');
const { LISTING_STATUS, PAYMENT_FREQUENCY, LEASE_TYPE } = require('../../../../../common/constants/listing');

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

const imageSchema = Joi.object({
  isCover: Joi.boolean().default(false),
  resolution: Joi.string().optional(),
  documentMetaDataId: Joi.string().pattern(objectIdRegex).required()
});

const createListingSchema = Joi.object({
  propertyId: Joi.string().pattern(objectIdRegex).required(),
  // Accepted for backward compatibility but not persisted (derived from propertyId).
  propertyName: Joi.string().optional(),
  propertyType: Joi.string().optional(),
  address: Joi.string().optional(),
  city: Joi.string().optional(),
  state: Joi.string().optional(),
  zip: Joi.string().optional(),
  unitId: Joi.string().pattern(objectIdRegex).optional(),
  // unitName / bedrooms / bathrooms / area are used only to resolve or display; not persisted on Listing.
  unitName: Joi.string().when('unitId', {
    is: Joi.exist(),
    then: Joi.optional().allow(''),
    otherwise: Joi.required(),
  }),
  bedrooms: Joi.number().min(0).optional(),
  bathrooms: Joi.number().min(0).optional(),
  area: Joi.number().min(0).optional(),
  listingHeadline: Joi.string().required(),
  description: Joi.string().required(),
  rentalAmount: Joi.number().min(0).required(),
  securityDeposit: Joi.number().min(0).required(),
  paymentFrequency: Joi.string().valid(...Object.values(PAYMENT_FREQUENCY)).required(),
  availableDate: Joi.date().iso().required(),
  leaseType: Joi.string().valid(...Object.values(LEASE_TYPE)).required(),
  petPolicies: Joi.array().items(Joi.string()).default([]),
  utilitiesIncluded: Joi.array().items(Joi.string()).default([]),
  amenities: Joi.array().items(Joi.string()).default([]),
  virtualTourVideoUrl: Joi.string().uri().allow('').optional(),
  syndicationPlatforms: Joi.array().items(Joi.string()).default([]),
  isAcceptingApplications: Joi.boolean().default(true),
  status: Joi.string().valid(
    LISTING_STATUS.DRAFT,
    LISTING_STATUS.DRAFT_IN_PROGRESS,
    LISTING_STATUS.PUBLISHED,
    LISTING_STATUS.PUBLISH_IN_PROGRESS,
    LISTING_STATUS.PUBLISH_ERROR
  ).default(LISTING_STATUS.DRAFT)
}).custom((val, helpers) => {
  const hasUnit =
    (val.unitId && /^[0-9a-fA-F]{24}$/.test(String(val.unitId))) ||
    (val.unitName != null && String(val.unitName).trim() !== '');
  if (!hasUnit) return helpers.message('Either unitId or unitName is required');
  return val;
});

const updateListingSchema = Joi.object({
  propertyId: Joi.string().pattern(objectIdRegex).optional(),
  // Accepted for backward compatibility but not persisted (derived from propertyId).
  propertyName: Joi.string().optional(),
  propertyType: Joi.string().optional(),
  address: Joi.string().optional(),
  city: Joi.string().optional(),
  state: Joi.string().optional(),
  zip: Joi.string().optional(),
  unitId: Joi.string().pattern(objectIdRegex).optional(),
  unitName: Joi.string().optional(),
  bedrooms: Joi.number().min(0).optional(),
  bathrooms: Joi.number().min(0).optional(),
  area: Joi.number().min(0).optional(),
  // ↑ accepted for compatibility; service ignores these (derived from property unit).
  listingHeadline: Joi.string().optional(),
  description: Joi.string().optional(),
  rentalAmount: Joi.number().min(0).optional(),
  securityDeposit: Joi.number().min(0).optional(),
  paymentFrequency: Joi.string().valid(...Object.values(PAYMENT_FREQUENCY)).optional(),
  availableDate: Joi.date().iso().optional(),
  leaseType: Joi.string().valid(...Object.values(LEASE_TYPE)).optional(),
  petPolicies: Joi.array().items(Joi.string()).optional(),
  utilitiesIncluded: Joi.array().items(Joi.string()).optional(),
  amenities: Joi.array().items(Joi.string()).optional(),
  virtualTourVideoUrl: Joi.string().uri().allow('').optional(),
  syndicationPlatforms: Joi.array().items(Joi.string()).optional(),
  isAcceptingApplications: Joi.boolean().optional(),
  status: Joi.string()
    .valid(
      LISTING_STATUS.DRAFT,
      LISTING_STATUS.DRAFT_IN_PROGRESS,
      LISTING_STATUS.PUBLISHED,
      LISTING_STATUS.PUBLISH_IN_PROGRESS,
      LISTING_STATUS.PUBLISH_ERROR,
      LISTING_STATUS.ACTIVE,
      LISTING_STATUS.INACTIVE
    )
    .optional(),
  documentsToDelete: Joi.array().items(Joi.string().pattern(objectIdRegex)).optional()
});

const idParamSchema = Joi.object({
  id: Joi.string().pattern(objectIdRegex).required()
});

const listListingsQuerySchema = Joi.object({
  pageNumber: Joi.number().integer().min(1).optional(),
  pageSize: Joi.number().integer().min(0).optional(),
  page: Joi.number().integer().min(1).optional(),
  createdBy: Joi.string().pattern(objectIdRegex).optional(),
  propertyId: Joi.string().optional(),
  status: Joi.string()
    .valid(
      LISTING_STATUS.DRAFT,
      LISTING_STATUS.DRAFT_IN_PROGRESS,
      LISTING_STATUS.PUBLISHED,
      LISTING_STATUS.PUBLISH_IN_PROGRESS,
      LISTING_STATUS.PUBLISH_ERROR,
      LISTING_STATUS.ACTIVE,
      LISTING_STATUS.INACTIVE
    )
    .optional(),
  city: Joi.string().optional(),
  state: Joi.string().optional(),
  unitName: Joi.string().optional(),
  leaseType: Joi.string().valid(...Object.values(LEASE_TYPE)).optional(),
  isAcceptingApplications: Joi.boolean().optional(),
  availableFrom: Joi.date().iso().optional(),
  availableTo: Joi.date().iso().optional(),
  minRent: Joi.number().min(0).optional(),
  maxRent: Joi.number().min(0).optional(),
  sortBy: Joi.string().optional(),
  order: Joi.string().valid('asc', 'desc', 'ASC', 'DESC').optional()
});

const listingStatusActionSchema = Joi.object({
  comment: Joi.string().allow('').optional(),
  syndicationPlatforms: Joi.array().items(Joi.string()).optional(),
  removeFromPlatforms: Joi.array().items(Joi.string()).optional(),
});

module.exports = {
  createListingSchema,
  updateListingSchema,
  idParamSchema,
  listListingsQuerySchema,
  listingStatusActionSchema,
};
