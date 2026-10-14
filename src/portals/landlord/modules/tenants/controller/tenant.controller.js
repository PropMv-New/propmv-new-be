/**
 * ------------------------------------------------------------------
 * File: tenant.controller.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * tenants.routes
 * ------------------------------------------------------------------
 */

const tenantService = require('../service/tenant.service');

const tenantExportService = require('../service/tenantExport.service');

const responseHelper = require('../../../../../common/helpers/responseHelper');

const { createUpload } = require('../../../../../common/helpers/uploadHelper');

const { UPLOAD_TENANT_SUBDIR } = require('../../../../../common/constants/uploads');

const { multerImageFilter, multerImportFileFilter, assertUploadedFilesValid } = require('../../../../../common/helpers/fileValidationHelper');
const { logControllerStep, handleControllerError } = require('../../../../../common/helpers/controllerLogger');



const { uploadArray, tempDir } = createUpload('documents', null, {

  maxCount: 10,

  maxSizeBytes: 20 * 1024 * 1024,

  defaultSubdir: UPLOAD_TENANT_SUBDIR,

  fileFilter: multerImageFilter,

});

const { uploadArray: uploadFile, tempDir: importTempDir } = createUpload('file', null, {

  maxCount: 1,

  maxSizeBytes: 5 * 1024 * 1024,

  fileFilter: multerImportFileFilter,

});



/**
 * get Actor Id
 *
 * Performs logic operations for getActorId.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function getActorId(req) {

  return (req.user && (req.user._id || req.user.id)) || req.userId || null;

}



/**
 * handle Service Error
 *
 * Performs logic operations for handleServiceError.
 *
 * @param res - Request/input argument
 * @param err - Request/input argument
 * @returns Operations result
 */
function handleServiceError(res, err) {

  const status = err.status || 500;

  return responseHelper.error(res, err.message, status);

}



const createTenant = async (req, res) => {
  logControllerStep(req, 'START', { action: 'createTenant' });

  try {

    const userData = tenantService.mergeTenantScopeFromActor(req.body || {}, getActorId(req));

    const created = await tenantService.createTenant(userData);

    return responseHelper.success(

      res,

      { user: tenantService.sanitizeTenantUserForResponse(created) },

      'Tenant created',

      201

    );

  } catch (err) {

    return handleServiceError(res, err);

  }

};



const updateTenant = async (req, res) => {
  logControllerStep(req, 'START', { action: 'updateTenant' });

  try {

    const updated = await tenantService.updateTenant(req.params.id, req.body || {});

    return responseHelper.success(

      res,

      { user: tenantService.sanitizeTenantUserForResponse(updated) },

      'Tenant updated',

      200

    );

  } catch (err) {

    return handleServiceError(res, err);

  }

};



const listTenants = async (req, res) => {
  logControllerStep(req, 'START', { action: 'listTenants' });

  try {

    const filter = tenantService.mergeTenantScopeFromActor(req.query || {}, getActorId(req));

    const users = await tenantService.listTenants(filter);

    return responseHelper.success(res, { tenants: users }, 'Tenants fetched', 200);

  } catch (err) {

    return handleServiceError(res, err);

  }

};



const exportTenantsCsv = async (req, res) => {
  logControllerStep(req, 'START', { action: 'exportTenantsCsv' });

  try {

    const q = tenantService.mergeTenantScopeFromActor(req.query || {}, getActorId(req));

    const result = await tenantService.exportTenantsCsvService(q);

    const filename = result && result.filename ? result.filename : 'tenants_export.csv';

    const csv = result && result.csv ? result.csv : '';



    res.setHeader('Content-Type', 'text/csv;charset=utf-8');

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    return res.send(csv);

  } catch (err) {

    return handleServiceError(res, err);

  }

};



const getTenantById = async (req, res) => {
  logControllerStep(req, 'START', { action: 'getTenantById' });

  try {

    const user = await tenantService.getTenantById(req.params && req.params.id);

    return responseHelper.success(res, { tenant: user }, 'Tenant fetched', 200);

  } catch (err) {

    return handleServiceError(res, err);

  }

};



const deleteTenant = async (req, res) => {
  logControllerStep(req, 'START', { action: 'deleteTenant' });

  try {

    await tenantService.deleteTenant(req.params && req.params.id);

    return responseHelper.success(res, null, 'Tenant deleted', 200);

  } catch (err) {

    return handleServiceError(res, err);

  }

};



const uploadDocuments = async (req, res) => {
  logControllerStep(req, 'START', { action: 'uploadDocuments' });

  uploadArray(req, res, async function (err) {

    if (err) {

      return responseHelper.error(res, err.message || 'Upload failed', 400);

    }



    try {

      const tenantId = req.params && req.params.id;

      if (!tenantId) return responseHelper.error(res, 'tenantId is required as path param', 400);



      const files = req.files || [];

      if (!files || files.length === 0) {

        return responseHelper.error(

          res,

          'No files uploaded. Use form field "documents" to upload one or more files.',

          400

        );

      }

      if (files.length > 10) {

        return responseHelper.error(res, 'Too many files. Maximum 10 files are allowed in one request.', 400);

      }

      await assertUploadedFilesValid(files, 'IMAGE');



      const saved = await tenantService.uploadTenantDocuments(tenantId, files);

      return responseHelper.success(res, { saved }, 'Documents uploaded', 201);

    } catch (e) {

      if (req.files) {

        for (const f of req.files) {

          try {

            require('fs').unlinkSync(f.path);

          } catch (er) {

            /* ignore */

          }

        }

      }

      return handleServiceError(res, e);

    }

  });

};



const setupTenant = async (req, res) => {
  logControllerStep(req, 'START', { action: 'setupTenant' });

  try {

    const result = await tenantService.setupTenant(req.body || {}, {

      inviterUserId: getActorId(req),

    });

    return responseHelper.success(res, result, 'Tenant and lease created', 201);

  } catch (err) {

    return handleControllerError(req, res, err, null, 'setupTenant');

  }

};



const updateSetupTenant = async (req, res) => {
  logControllerStep(req, 'START', { action: 'updateSetupTenant' });

  try {

    const result = await tenantService.updateSetupTenant(req.body || {}, {
      actorId: req.user?._id || req.user?.id || null,
    });

    return responseHelper.success(res, result, 'Tenant setup updated successfully', 200);

  } catch (err) {

    return handleControllerError(req, res, err, null, 'updateSetupTenant');

  }

};



const updateTenantSetup = async (req, res) => {
  logControllerStep(req, 'START', { action: 'updateTenantSetup' });

  try {

    const result = await tenantService.updateTenantSetup(req.params.id, req.body || {});

    return responseHelper.success(res, result, 'Tenant setup updated', 200);

  } catch (err) {

    return handleControllerError(req, res, err, null, 'updateTenantSetup');

  }

};



const resendInvite = async (req, res) => {
  logControllerStep(req, 'START', { action: 'resendInvite' });

  try {

    const { propertyId, tenantId } = req.body || {};

    await tenantService.resendInviteService(propertyId, tenantId);

    return responseHelper.success(res, null, 'Invite email sent', 200);

  } catch (err) {

    return handleServiceError(res, err);

  }

};



const importTenantsCsv = async (req, res) => {
  logControllerStep(req, 'START', { action: 'importTenantsCsv' });

  const createdBy = tenantService.mergeTenantScopeFromActor(req.query || {}, getActorId(req)).createdBy;

  if (!createdBy) return responseHelper.error(res, 'createdBy is required as query param', 400);



  uploadFile(req, res, async function (err) {

    if (err) return responseHelper.error(res, err.message || 'Upload failed', 400);



    try {

      const files = req.files || [];

      if (!files || files.length === 0) {

        return responseHelper.error(res, 'No file uploaded. Use form field "file" to upload CSV.', 400);

      }

      await assertUploadedFilesValid(files, 'IMPORT');

      const f = files[0];

      const result = await tenantService.importTenantsFromCsv(f.path, createdBy);



      try {

        require('fs').unlinkSync(f.path);

      } catch (ignore) {

        /* ignore */

      }



      return responseHelper.success(res, result, 'Import completed', 200);

    } catch (e) {

      if (req.files) {

        for (const f of req.files) {

          try {

            require('fs').unlinkSync(f.path);

          } catch (ignore) {

            /* ignore */

          }

        }

      }

      return handleServiceError(res, e);

    }

  });

};



const listTenantsWithDetails = async (req, res) => {
  logControllerStep(req, 'START', { action: 'listTenantsWithDetails' });

  try {

    const filter = tenantService.mergeTenantScopeFromActor(req.query || {}, getActorId(req));

    const pagination = {

      pageNumber: req.query.pageNumber,

      pageSize: req.query.pageSize,

    };

    const result = await tenantService.listTenantsWithDetails(filter, pagination);

    return responseHelper.success(res, result, 'Tenants fetched successfully', 200);

  } catch (err) {

    return handleServiceError(res, err);

  }

};



const archiveTenant = async (req, res) => {
  logControllerStep(req, 'START', { action: 'archiveTenant' });

  try {

    const result = await tenantService.archiveTenant(req.params.id);

    return responseHelper.success(res, { tenant: result }, 'Tenant archived successfully', 200);

  } catch (err) {

    return handleServiceError(res, err);

  }

};



const unarchiveTenant = async (req, res) => {
  logControllerStep(req, 'START', { action: 'unarchiveTenant' });

  try {

    const result = await tenantService.unarchiveTenant(req.params.id);

    return responseHelper.success(res, { tenant: result }, 'Tenant unarchived successfully', 200);

  } catch (err) {

    return handleServiceError(res, err);

  }

};



const getTenantDetails = async (req, res) => {
  logControllerStep(req, 'START', { action: 'getTenantDetails' });
  try {

    const { leaseId, tenantId } = req.query;

    const createdBy = tenantService.mergeTenantScopeFromActor(req.query || {}, getActorId(req)).createdBy;

    const result = await tenantService.getTenantDetailsService(leaseId, tenantId, createdBy);

    logControllerStep(req, 'END', { action: 'getTenantDetails', leaseId, tenantId, success: true });

    return responseHelper.success(res, result, 'Tenant details fetched successfully', 200);

  } catch (err) {

    return handleControllerError(req, res, err, null, 'getTenantDetails');

  }

};



const getTenantNames = async (req, res) => {
  logControllerStep(req, 'START', { action: 'getTenantNames' });

  try {

    const { text } = req.query;

    const createdBy = tenantService.mergeTenantScopeFromActor(req.query || {}, getActorId(req)).createdBy;

    if (!createdBy) {

      return responseHelper.error(res, 'createdBy is required', 400);

    }

    const names = await tenantService.getTenantNames(createdBy, text);

    return responseHelper.success(res, { tenants: names }, 'Tenant names fetched successfully', 200);

  } catch (err) {

    return handleServiceError(res, err);

  }

};



const exportTenants = async (req, res) => {
  logControllerStep(req, 'START', { action: 'exportTenants' });

  try {

    const q = tenantService.mergeTenantScopeFromActor(req.query || {}, getActorId(req));

    const format = q.format || 'csv';

    const includeArchived = q.includeArchived === 'true' || q.includeArchived === true;



    delete q.format;

    delete q.includeArchived;

    if (includeArchived) {

      q.includeArchived = true;

    }



    const result = await tenantExportService.exportTenants(q, format);

    const filename = result && result.filename ? result.filename : `tenants_export.${format}`;

    const content = result && result.content ? result.content : '';

    const contentType = result && result.contentType ? result.contentType : 'application/octet-stream';



    res.setHeader('Content-Type', contentType);

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    return res.send(content);

  } catch (err) {

    return handleServiceError(res, err);

  }

};



const getTenantByEmail = async (req, res) => {
  logControllerStep(req, 'START', { action: 'getTenantByEmail' });

  try {

    const { email } = req.query;

    if (!email) {

      return responseHelper.error(res, 'Email query parameter is required', 400);

    }

    const result = await tenantService.getTenantByEmail(email);

    return responseHelper.success(res, result, 'Tenant lookup completed', 200);

  } catch (err) {

    return handleServiceError(res, err);

  }

};



const sendApplicationInvitation = async (req, res) => {
  logControllerStep(req, 'START', { action: 'sendApplicationInvitation' });

  try {

    const result = await tenantService.sendApplicationInvitation(req.body || {}, {

      inviterUserId: getActorId(req),

    });

    return responseHelper.success(res, result, result.message || 'Lease created successfully. Invitation emails are being sent.', 201);

  } catch (err) {

    return handleControllerError(req, res, err, null, 'sendApplicationInvitation');

  }

};



const acknowledgeLeaseInvite = async (req, res) => {
  logControllerStep(req, 'START', { action: 'acknowledgeLeaseInvite' });

  try {

    const { leaseId, tenantId } = req.body || {};

    const result = await tenantService.acknowledgeLeaseInviteForTenant(leaseId, tenantId);

    return responseHelper.success(res, result, 'Lease invite acknowledged', 200);

  } catch (err) {

    return handleServiceError(res, err);

  }

};



const getLeaseOnboardingStatus = async (req, res) => {
  logControllerStep(req, 'START', { action: 'getLeaseOnboardingStatus' });

  try {

    const { leaseId } = req.params || {};

    const result = await tenantService.getLeaseOnboardingStatusService(leaseId);

    return responseHelper.success(res, result, 'Lease onboarding status fetched successfully', 200);

  } catch (err) {

    return handleServiceError(res, err);

  }

};



const resendLeaseTenantCommunication = async (req, res) => {
  logControllerStep(req, 'START', { action: 'resendLeaseTenantCommunication' });

  try {

    const { leaseId, tenantId, channel } = req.body || {};

    const result = await tenantService.resendLeaseTenantCommunicationService(leaseId, tenantId, channel);

    return responseHelper.success(res, result, 'Communication email sent successfully', 200);

  } catch (err) {

    return handleServiceError(res, err);

  }

};



const getScreeningContext = async (req, res) => {
  logControllerStep(req, 'START', { action: 'getScreeningContext' });

  try {

    const { leaseId, tenantId } = req.params || {};

    const result = await tenantService.getScreeningContextService(leaseId, tenantId);

    return responseHelper.success(res, result, 'OK', 200);

  } catch (err) {

    return handleServiceError(res, err);

  }

};



module.exports = {

  createTenant,

  updateTenant,

  listTenants,

  exportTenantsCsv,

  exportTenants,

  getTenantById,

  deleteTenant,

  uploadDocuments,

  setupTenant,

  updateSetupTenant,

  updateTenantSetup,

  resendInvite,

  importTenantsCsv,

  listTenantsWithDetails,

  archiveTenant,

  unarchiveTenant,

  getTenantDetails,

  getTenantNames,

  getTenantByEmail,

  sendApplicationInvitation,

  getLeaseOnboardingStatus,

  resendLeaseTenantCommunication,

  acknowledgeLeaseInvite,

  getScreeningContext,

};

