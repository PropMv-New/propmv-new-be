/**
 * ------------------------------------------------------------------
 * File: paymentManagement.controller.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * paymentManagement.routes
 * ------------------------------------------------------------------
 */

const paymentManagementService = require('../service/paymentManagement.service');
const { resolveCreatedBy, resolveCreatorScope, buildPropertyOwnerFilterWithScope } = require('../../../../../shared/utils/creatorScope.util');
const { ValidationError } = require('../../../../../common/exceptions');

/**
 * resolve Actor Id
 *
 * Performs logic operations for resolveActorId.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function resolveActorId(req) {
  return req.user && (req.user._id || req.user.id);
}

/**
 * is Administrator
 *
 * Performs logic operations for isAdministrator.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function isAdministrator(req) {
  return !!(req.user && req.user.isAdministrator);
}

/**
 * get Company Id
 *
 * Performs logic operations for getCompanyId.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function getCompanyId(req) {
  return req.user && req.user.companyId;
}

/**
 * Get payment management data
 */
const getPaymentManagement = async (req, res) => {
  const q = Object.assign({}, req.query || {});
  
  // Normalize pagination params
  if (typeof q.pagesize !== 'undefined' && typeof q.pageSize === 'undefined') {
    q.pageSize = q.pagesize;
  }
  if (typeof q.pageNumber !== 'undefined') q.pageNumber = Number(q.pageNumber);
  if (typeof q.pagesize !== 'undefined') q.pagesize = Number(q.pagesize);

  // Resolve createdBy
  const actorId = resolveActorId(req);
  q.createdBy = resolveCreatedBy(q, actorId);
  
  if (!q.createdBy) {
    throw new ValidationError('createdBy is required');
  }

  // Check if user is Administrator and get company-wide scope
  const isAdmin = isAdministrator(req);
  const companyId = getCompanyId(req);
  
  // Pass administrator context to service
  q.isAdministrator = isAdmin;
  q.companyId = companyId;

  const result = await paymentManagementService.getPaymentManagementService(q);
  return res.json(result);
};

/**
 * Get payment summary/overview
 */
const getPaymentSummary = async (req, res) => {
  const createdBy = resolveCreatedBy(req.query || {}, resolveActorId(req));
  
  if (!createdBy) {
    throw new ValidationError('createdBy is required');
  }

  const result = await paymentManagementService.getPaymentSummaryService(createdBy);
  return res.json(result);
};

/**
 * Assign landlord to a property
 */
const assignLandlord = async (req, res) => {
  const propertyId = req.params && req.params.propertyId;
  const landlordData = req.body;
  const createdBy = resolveActorId(req);

  if (!propertyId) {
    throw new ValidationError('propertyId is required');
  }
  if (!createdBy) {
    throw new ValidationError('User authentication required');
  }

  const result = await paymentManagementService.assignLandlordService(
    propertyId,
    landlordData,
    createdBy
  );
  
  return res.json(result);
};

/**
 * Get payment management detail for a specific property
 */
const getPaymentManagementDetail = async (req, res) => {
  const propertyId = req.params && req.params.propertyId;
  const createdBy = resolveActorId(req);

  if (!propertyId) {
    throw new ValidationError('propertyId is required');
  }
  if (!createdBy) {
    throw new ValidationError('User authentication required');
  }

  const result = await paymentManagementService.getPaymentManagementDetailService(
    propertyId,
    createdBy
  );
  
  return res.json(result);
};

/**
 * Record payment made to landlord
 */
const recordPaymentToLandlord = async (req, res) => {
  const propertyId = req.params && req.params.propertyId;
  const createdBy = resolveActorId(req);
  const paymentData = req.body;

  if (!propertyId) {
    throw new ValidationError('propertyId is required');
  }
  if (!createdBy) {
    throw new ValidationError('User authentication required');
  }

  const result = await paymentManagementService.recordPaymentToLandlordService(
    propertyId,
    paymentData,
    createdBy
  );

  return res.json(result);
};

/**
 * Get payment history for a property
 */
const getPaymentHistoryForProperty = async (req, res) => {
  const propertyId = req.params && req.params.propertyId;
  const createdBy = resolveActorId(req);

  if (!propertyId) {
    throw new ValidationError('propertyId is required');
  }
  if (!createdBy) {
    throw new ValidationError('User authentication required');
  }

  const result = await paymentManagementService.getPaymentHistoryForPropertyService(
    propertyId,
    createdBy
  );

  return res.json(result);
};

/**
 * Get payment settings for all properties
 */
const getPaymentSettings = async (req, res) => {
  const createdBy = resolveActorId(req);
  if (!createdBy) throw new ValidationError('User authentication required');
  const result = await paymentManagementService.getPaymentSettingsService(createdBy);
  return res.json(result);
};

/**
 * Upsert payment settings for a property
 */
const upsertPaymentSettings = async (req, res) => {
  const propertyId = req.body && req.body.propertyId;
  const percentageCut = req.body && req.body.percentageCut;
  const createdBy = resolveActorId(req);

  if (!propertyId) throw new ValidationError('propertyId is required');
  if (percentageCut === undefined || percentageCut === null) throw new ValidationError('percentageCut is required');
  if (!createdBy) throw new ValidationError('User authentication required');

  const result = await paymentManagementService.upsertPaymentSettingsService(
    propertyId,
    Number(percentageCut),
    createdBy
  );
  return res.json(result);
};

const { wrapController } = require('../../../../../common/helpers/asyncHandler');

module.exports = wrapController({
  getPaymentManagement,
  getPaymentSummary,
  assignLandlord,
  getPaymentManagementDetail,
  recordPaymentToLandlord,
  getPaymentHistoryForProperty,
  getPaymentSettings,
  upsertPaymentSettings,
});
