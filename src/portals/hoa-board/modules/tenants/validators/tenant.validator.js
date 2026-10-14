/**
 * ------------------------------------------------------------------
 * File: tenant.validator.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * owner.routes, tenants.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');
const objectIdRegex = /^[0-9a-fA-F]{23,24}$/i;
const { TENANT_STATUSES } = require('../../../../../common/constants/tenant');
const { personNameFieldJoi } = require('../../../../../shared/utils/personNameValidation.util');

// Mirror lease model validations here for the setup tenant endpoint so the request is validated
// before attempting to create the Lease. We keep the source of truth in the Mongoose model
// but reproduce equivalent Joi checks to fail fast on bad input.
const { LEASE_TYPES, LEASE_STATUSES } = require('../../../../../common/constants/lease');

const createTenantSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(), // may be encrypted depending on client
  phone: Joi.string().pattern(/^(?:\+?1[-\s]?)?\(?\d{3}\)?[-\s.]?\d{3}[-\s.]?\d{4}$/).required(),
  firstName: personNameFieldJoi('First name'),
  lastName: personNameFieldJoi('Last name'),
  address: Joi.string().required(),
  state: Joi.string().required(),
  zipCode: Joi.string().pattern(/^\d{5}(-\d{4})?$/).required(),
  landlordId: Joi.string().pattern(objectIdRegex).required(),
});

const updateTenantSchema = Joi.object({
  email: Joi.string().email().optional(),
  password: Joi.string().optional(),
  phone: Joi.string().pattern(/^(?:\+?1[-\s]?)?\(?\d{3}\)?[-\s.]?\d{3}[-\s.]?\d{4}$/).optional(),
  firstName: personNameFieldJoi('First name', { required: false }),
  lastName: personNameFieldJoi('Last name', { required: false }),
  address: Joi.string().optional(),
  state: Joi.string().optional(),
  zipCode: Joi.string().pattern(/^\d{5}(-\d{4})?$/).optional(),
  landlordId: Joi.string().pattern(objectIdRegex).optional(),
});

const importTenantsQuerySchema = Joi.object({ landlordId: Joi.string().pattern(objectIdRegex).required() });

// param id schema for routes with :id
const idParamSchema = Joi.object({ id: Joi.string().pattern(objectIdRegex).required() });

// Schema for list/export endpoints with pagination
const listTenantsQuerySchema = Joi.object({
  landlordId: Joi.string().pattern(objectIdRegex).required(),
  pageNumber: Joi.number().integer().min(1).optional(),
  page: Joi.number().integer().min(1).optional(),
  pageSize: Joi.number().integer().min(0).optional(),
  text: Joi.string().optional()
});

const setupTenantSchema = Joi.object({
  tenants: Joi.array().items(Joi.object({
    key: Joi.string().required(),
    email: Joi.string().email().required(),
    phone: Joi.string().pattern(/^(?:\+?1[-\s]?)?\(?\d{3}\)?[-\s.]?\d{3}[-\s.]?\d{4}$/).optional().allow('', null),
    password: Joi.string().optional(),
    firstName: personNameFieldJoi('First name'),
    lastName: personNameFieldJoi('Last name'),
    address: Joi.string().optional(),
    state: Joi.string().optional(),
    zipCode: Joi.string().optional(),
  })).min(1).required(),
  lease: Joi.object({
    property_id: Joi.string().pattern(objectIdRegex).required(),
    unitName: Joi.string().allow('').optional(),
    leaseTerm: Joi.string().required(),
    lease_type: Joi.string().valid(...Object.values(LEASE_TYPES)).required(),
    start_date: Joi.date().required(),
    end_date: Joi.when('lease_type', { is: LEASE_TYPES.FIXED_TERM, then: Joi.date().required(), otherwise: Joi.date().optional().allow(null, '') }),
    switchMonthToMonth: Joi.when('lease_type', { is: LEASE_TYPES.FIXED_TERM, then: Joi.boolean().required(), otherwise: Joi.boolean().optional() }),
    auto_renew: Joi.boolean().optional(),

    rentDetails: Joi.object({
      frequency: Joi.string().required(),
      amount: Joi.number().min(0).required(),
      dueOne: Joi.string().optional(),
      dueTwo: Joi.string().when('frequency', { is: 'bi-monthly', then: Joi.required(), otherwise: Joi.optional() }),
      dueWeekday: Joi.number().min(0).max(6).when('frequency', { is: Joi.alternatives().try('weekly', 'bi-weekly'), then: Joi.required(), otherwise: Joi.optional() }),
      semiAnnualDates: Joi.array().items(
        Joi.object({
          month: Joi.number().min(1).max(12).required(),
          day: Joi.number().min(1).max(31).required()
        })
      ).when('frequency', { is: 'semi-annually', then: Joi.required(), otherwise: Joi.optional() }),
      firstRentalInvoiceDue: Joi.date().iso().required(),
    }).required(),

    // Whether to include damage report with the lease
    includeDamageReport: Joi.boolean().optional(),

    depositDetails: Joi.object({
      amount: Joi.number().min(0).optional(),
      due: Joi.alternatives().conditional('amount', { is: Joi.number().greater(0), then: Joi.date().iso().required(), otherwise: Joi.date().iso().optional().allow(null, '') }),
      isDepositAlreadyCollected: Joi.boolean().required(),
    }).optional(),

    additionalFees: Joi.object({
      items: Joi.array().items(Joi.object({
        name: Joi.string().required(),
        description: Joi.string().required(),
        quantity: Joi.number().min(0).required(),
        rate: Joi.number().min(0).required(),
        amount: Joi.number().min(0).required(),
      })).optional().default([]),
      notes: Joi.string().optional().allow('').default(''),
      totalAmount: Joi.number().min(0).optional().default(0),
      alreadyPaid: Joi.number().min(0).optional().default(0),
      balanceAmount: Joi.number().min(0).optional().default(0),
      isRecurringInvoice: Joi.boolean().optional().default(false),
      lineItemOnRentalInvoice: Joi.boolean().optional().default(false),
      dueDate: Joi.string().optional().allow('').default(''),
      frequency: Joi.string().optional().default('Monthly'),
      dueOnDate: Joi.number().min(1).max(31).when('frequency', { is: Joi.alternatives().try('monthly', 'Monthly'), then: Joi.optional(), otherwise: Joi.optional() }),
      dueOnDate2: Joi.number().min(1).max(31).when('frequency', { is: Joi.alternatives().try('bi-monthly', 'Bi-Monthly'), then: Joi.optional(), otherwise: Joi.optional() }),
      dueWeekday: Joi.number().min(0).max(6).when('frequency', { is: Joi.alternatives().try('weekly', 'Weekly', 'bi-weekly', 'Bi-Weekly'), then: Joi.optional(), otherwise: Joi.optional() }),
      semiAnnualDates: Joi.array().items(
        Joi.object({
          month: Joi.number().min(1).max(12).required(),
          day: Joi.number().min(1).max(31).required()
        })
      ).optional(),
      customDates: Joi.array().items(Joi.string()).when('frequency', { is: Joi.alternatives().try('custom', 'Custom'), then: Joi.optional(), otherwise: Joi.optional() }),
      startDate: Joi.string().optional().allow('').default(''),
      endDate: Joi.string().optional().allow('').default(''),
    }).optional(),

    rentAndDepositDestribution: Joi.object({
      isAllTenantsEquallyResponsible: Joi.boolean().required(),
      isPartialPaymentAllowed: Joi.boolean().required(),
      rentDistributionType: Joi.string().required(),
      securityDepositDestributionType: Joi.string().required(),
      split: Joi.array().items(
        Joi.object({
          key: Joi.string().required(),
          rentAmount: Joi.number().min(0).required(),
          rentPercentage: Joi.number().min(0).max(100).required(),
          depositAmount: Joi.number().min(0).required(),
          depositPercentage: Joi.number().min(0).max(100).required(),
        })
      ).required(),
    }).required(),

    documents: Joi.array().items(Joi.object({ metadataId: Joi.string().pattern(objectIdRegex).required() })).optional(),

    status: Joi.string().valid(...Object.values(LEASE_STATUSES)).optional(),
  }).required()
});

const updateSetupTenantSchema = Joi.object({
  tenants: Joi.array().items(Joi.object({
    id: Joi.string().pattern(objectIdRegex).optional(), // for existing tenants
    key: Joi.string().required(),
    email: Joi.string().email().optional(),
    phone: Joi.string().pattern(/^(?:\+?1[-\s]?)?\(?\d{3}\)?[-\s.]?\d{3}[-\s.]?\d{4}$/).optional().allow('', null),
    password: Joi.string().optional(),
    firstName: personNameFieldJoi('First name', { required: false }),
    lastName: personNameFieldJoi('Last name', { required: false }),
    address: Joi.string().optional(),
    state: Joi.string().optional(),
    zipCode: Joi.string().optional(),
  })).min(1).optional(),
  lease: Joi.object({
    leaseId: Joi.string().pattern(objectIdRegex).required(), // required for updates
    property_id: Joi.string().pattern(objectIdRegex).optional(),
    unitName: Joi.string().allow('').optional(),
    leaseTerm: Joi.string().optional(),
    lease_type: Joi.string().valid(...Object.values(LEASE_TYPES)).optional(),
    start_date: Joi.date().iso().optional(),
    end_date: Joi.date().iso().optional().allow(null, ''),
    switchMonthToMonth: Joi.boolean().optional(),
    auto_renew: Joi.boolean().optional(),

    rentDetails: Joi.object({
      frequency: Joi.string().optional(),
      amount: Joi.number().min(0).optional(),
      dueOne: Joi.string().optional(),
      firstRentalInvoiceDue: Joi.date().iso().optional(),
    }).optional(),

    depositDetails: Joi.object({
      amount: Joi.number().min(0).optional(),
      due: Joi.date().iso().optional().allow(null, ''),
      isDepositAlreadyCollected: Joi.boolean().optional(),
    }).optional(),

    additionalFees: Joi.object({
      items: Joi.array().items(Joi.object({
        name: Joi.string().required(),
        description: Joi.string().required(),
        quantity: Joi.number().min(0).required(),
        rate: Joi.number().min(0).required(),
        amount: Joi.number().min(0).required(),
      })).optional(),
      notes: Joi.string().optional(),
      totalAmount: Joi.number().min(0).optional(),
      alreadyPaid: Joi.number().min(0).optional(),
      balanceAmount: Joi.number().min(0).optional(),
      isRecurringInvoice: Joi.boolean().optional(),
      lineItemOnRentalInvoice: Joi.boolean().optional(),
      dueDate: Joi.date().iso().optional().allow(null, ''),
      frequency: Joi.string().optional(),
      startDate: Joi.date().iso().optional().allow(null, ''),
      endDate: Joi.date().iso().optional().allow(null, ''),
    }).optional(),

    rentAndDepositDestribution: Joi.object({
      isAllTenantsEquallyResponsible: Joi.boolean().optional(),
      isPartialPaymentAllowed: Joi.boolean().optional(),
      rentDistributionType: Joi.string().optional(),
      securityDepositDestributionType: Joi.string().optional(),
      split: Joi.array().items(
        Joi.object({
          key: Joi.string().optional(),
          tenantId: Joi.string().pattern(objectIdRegex).optional(),
          rentAmount: Joi.number().min(0).optional(),
          rentPercentage: Joi.number().min(0).max(100).optional(),
          depositAmount: Joi.number().min(0).optional(),
          depositPercentage: Joi.number().min(0).max(100).optional(),
        })
      ).optional(),
    }).optional(),

    documents: Joi.array().items(Joi.object({ metadataId: Joi.string().pattern(objectIdRegex).required() })).optional(),
    status: Joi.string().valid(...Object.values(LEASE_STATUSES)).optional(),
  }).optional()
});

const resendInviteSchema = Joi.object({
  propertyId: Joi.string().pattern(objectIdRegex).required(),
  tenantId: Joi.string().pattern(objectIdRegex).required(),
});

// Schema for tenant details query parameters
const tenantDetailsQuerySchema = Joi.object({
  leaseId: Joi.string().pattern(objectIdRegex).optional(),
  tenantId: Joi.string().pattern(objectIdRegex).required()
});

// Schema for tenant listing with details endpoint
const listTenantsWithDetailsQuerySchema = Joi.object({
  tenantId: Joi.string().pattern(objectIdRegex).optional(),
  propertyId: Joi.string().pattern(objectIdRegex).optional(),
  unit: Joi.alternatives().try(
    Joi.string(),
    Joi.array().items(Joi.string())
  ).optional(),
  status: Joi.string().valid(...Object.values(TENANT_STATUSES)).optional(),
  landlordId: Joi.string().pattern(objectIdRegex).required(),
  pageNumber: Joi.number().integer().min(1).optional(),
  pageSize: Joi.number().integer().min(0).optional()
});

module.exports = {
  createTenantSchema,
  updateTenantSchema,
  importTenantsQuerySchema,
  setupTenantSchema,
  updateSetupTenantSchema,
  idParamSchema,
  listTenantsQuerySchema,
  resendInviteSchema,
  listTenantsWithDetailsQuerySchema,
  tenantDetailsQuerySchema,
};
