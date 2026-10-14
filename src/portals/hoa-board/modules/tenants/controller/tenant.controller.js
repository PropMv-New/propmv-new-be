/**
 * ------------------------------------------------------------------
 * File: tenant.controller.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * tenants.routes
 * ------------------------------------------------------------------
 */

const tenantService = require('../service/tenant.service');
const responseHelper = require('../../../../../common/helpers/responseHelper');
const { createUpload } = require('../../../../../common/helpers/uploadHelper');
const { UPLOAD_TENANT_SUBDIR } = require('../../../../../common/constants/uploads');
const { multerImageFilter } = require('../../../../../common/helpers/fileValidationHelper');
const { logControllerStep, handleControllerError } = require('../../../../../common/helpers/controllerLogger');
const logger = require('../../../../../common/logger');

const path = require('path');
const fs = require('fs');

const { uploadArray, tempDir } = createUpload('documents', null, { maxCount: 10, maxSizeBytes: 20 * 1024 * 1024, defaultSubdir: UPLOAD_TENANT_SUBDIR, fileFilter: multerImageFilter });
const { uploadArray: uploadFile, tempDir: importTempDir } = createUpload('file', null, { maxCount: 1, maxSizeBytes: 5 * 1024 * 1024 });

function safeUnlink(filePath, allowedDir) {
  try {
    const resolved = path.resolve(String(filePath || ''));
    if (!resolved.startsWith(allowedDir + path.sep) && resolved !== allowedDir) return;
    fs.unlinkSync(resolved);
  } catch (_) { /* ignore */ }
}

function sanitizeFilename(name) {
  return String(name || 'export.csv').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

const createTenant = async (req, res) => {
  logControllerStep(req, 'START', { action: 'createTenant' });
  try {
    const userData = req.body || {};
    const actorUserId = req.user?.id || req.user?._id || null;
    const created = await tenantService.createTenant(userData, { userId: actorUserId });

    let payload;
    if (created && created.toSafeJSON) {
      payload = created.toSafeJSON();
    } else {
      const obj = created.toObject ? created.toObject() : created;
      delete obj.password;
      payload = obj;
    }
    return responseHelper.success(res, { user: payload }, 'Tenant created', 201);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

const updateTenant = async (req, res) => {
  logControllerStep(req, 'START', { action: 'updateTenant' });
  try {
    const tenantId = req.params.id;
    const userData = req.body || {};
    const actorUserId = req.user?.id || req.user?._id || null;
    const updated = await tenantService.updateTenant(tenantId, userData, { userId: actorUserId });

    let payload;
    if (updated && updated.toSafeJSON) {
      payload = updated.toSafeJSON();
    } else {
      const obj = updated.toObject ? updated.toObject() : updated;
      delete obj.password;
      payload = obj;
    }
    return responseHelper.success(res, { user: payload }, 'Tenant updated', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

const listTenants = async (req, res) => {
  logControllerStep(req, 'START', { action: 'listTenants' });
  try {
    const filter = req.query || {};
    const users = await tenantService.listTenants(filter);
    return responseHelper.success(res, { tenants: users }, 'Tenants fetched', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

const exportTenantsCsv = async (req, res) => {
  logControllerStep(req, 'START', { action: 'exportTenantsCsv' });
  try {
    const q = Object.assign({}, req.query || {});
    const result = await tenantService.exportTenantsCsvService(q);
    const filename = sanitizeFilename(result && result.filename ? result.filename : 'tenants_export.csv');
    const csv = result && result.csv ? result.csv : '';

    res.setHeader('Content-Type', 'text/csv;charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csv);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

const getTenantById = async (req, res) => {
  logControllerStep(req, 'START', { action: 'getTenantById' });
  try {
    const tenantId = req.params && req.params.id;
    const user = await tenantService.getTenantById(tenantId);
    return responseHelper.success(res, { tenant: user }, 'Tenant fetched', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

const deleteTenant = async (req, res) => {
  logControllerStep(req, 'START', { action: 'deleteTenant' });
  try {
    const tenantId = req.params && req.params.id;
    const actorUserId = req.user?.id || req.user?._id || null;
    await tenantService.deleteTenant(tenantId, { userId: actorUserId });
    return responseHelper.success(res, null, 'Tenant deleted', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
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
      if (!files || files.length === 0) return responseHelper.error(res, 'No files uploaded. Use form field "documents" to upload one or more files.', 400);
      if (files.length > 10) return responseHelper.error(res, 'Too many files. Maximum 10 files are allowed in one request.', 400);
      const saved = await tenantService.uploadTenantDocuments(tenantId, files);
      return responseHelper.success(res, { saved }, 'Documents uploaded', 201);
    } catch (e) {
      if (req.files) {
        for (const f of req.files) safeUnlink(f.path, tempDir);
      }
      const status = e.status || 500;
      return responseHelper.error(res, e.message, status);
    }
  });
};

const setupTenant = async (req, res) => {
  logControllerStep(req, 'START', { action: 'setupTenant' });
  try {
    const actorUserId = req.user?.id || req.user?._id || null;
    const result = await tenantService.setupTenant(req.body || {}, { userId: actorUserId });
    return responseHelper.success(res, result, 'Tenant and lease created', 201);
  } catch (err) {
    return handleControllerError(req, res, err, null, 'setupTenant');
  }
};

const updateSetupTenant = async (req, res) => {
  logControllerStep(req, 'START', { action: 'updateSetupTenant' });
  try {
    const actorUserId = req.user?.id || req.user?._id || null;
    const result = await tenantService.updateSetupTenant(req.body || {}, { userId: actorUserId });
    return responseHelper.success(res, result, 'Tenant setup updated successfully', 200);
  } catch (err) {
    return handleControllerError(req, res, err, null, 'updateSetupTenant');
  }
};

const updateTenantSetup = async (req, res) => {
  logControllerStep(req, 'START', { action: 'updateTenantSetup' });
  try {
    const tenantId = req.params.id;
    const actorUserId = req.user?.id || req.user?._id || null;
    const result = await tenantService.updateTenantSetup(tenantId, req.body || {}, { userId: actorUserId });
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
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

const importTenantsCsv = async (req, res) => {
  logControllerStep(req, 'START', { action: 'importTenantsCsv' });
  const landlordId = req.query && req.query.landlordId;
  if (!landlordId) return responseHelper.error(res, 'landlordId is required as query param', 400);

  uploadFile(req, res, async function (err) {
    if (err) return responseHelper.error(res, err.message || 'Upload failed', 400);

    try {
      const files = req.files || [];
      if (!files || files.length === 0) return responseHelper.error(res, 'No file uploaded. Use form field "file" to upload CSV.', 400);
      const f = files[0];
      const safePath = path.resolve(String(f.path || ''));
      if (!safePath.startsWith(importTempDir + path.sep) && safePath !== importTempDir) {
        return responseHelper.error(res, 'Invalid upload path', 400);
      }
      const result = await tenantService.importTenantsFromCsv(safePath, landlordId);

      safeUnlink(safePath, importTempDir);

      return responseHelper.success(res, result, 'Import completed', 200);
    } catch (e) {
      if (req.files) {
        for (const f of req.files) safeUnlink(f.path, importTempDir);
      }
      const status = e.status || 500;
      return responseHelper.error(res, e.message, status);
    }
  });
};

const listTenantsWithDetails = async (req, res) => {
  logControllerStep(req, 'START', { action: 'listTenantsWithDetails' });
  try {
    const filter = req.query || {};
    const pagination = {
      pageNumber: req.query.pageNumber,
      pageSize: req.query.pageSize
    };
    const result = await tenantService.listTenantsWithDetails(filter, pagination);
    return responseHelper.success(res, result, 'Tenants fetched successfully', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

const archiveTenant = async (req, res) => {
  logControllerStep(req, 'START', { action: 'archiveTenant' });
  try {
    const tenantId = req.params.id;
    const actorUserId = req.user?.id || req.user?._id || null;
    const result = await tenantService.archiveTenant(tenantId, { userId: actorUserId });
    return responseHelper.success(res, { tenant: result }, 'Tenant archived successfully', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

const unarchiveTenant = async (req, res) => {
  logControllerStep(req, 'START', { action: 'unarchiveTenant' });
  try {
    const tenantId = req.params.id;
    const actorUserId = req.user?.id || req.user?._id || null;
    const result = await tenantService.unarchiveTenant(tenantId, { userId: actorUserId });
    return responseHelper.success(res, { tenant: result }, 'Tenant unarchived successfully', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

const getTenantDetails = async (req, res) => {
  logControllerStep(req, 'START', { action: 'getTenantDetails' });
  try {
    const { leaseId, tenantId } = req.query;
    const result = await tenantService.getTenantDetailsService(leaseId, tenantId);
    logControllerStep(req, 'END', { action: 'getTenantDetails', leaseId, tenantId, success: true });
    return responseHelper.success(res, result, 'Tenant details fetched successfully', 200);
  } catch (err) {
    return handleControllerError(req, res, err, null, 'getTenantDetails');
  }
};

const getTenantNames = async (req, res) => {
  logControllerStep(req, 'START', { action: 'getTenantNames' });
  try {
    const { landlordId, text } = req.query;
    if (!landlordId) {
      return responseHelper.error(res, 'landlordId is required', 400);
    }
    const names = await tenantService.getTenantNames(landlordId, text);
    return responseHelper.success(res, { tenants: names }, 'Tenant names fetched successfully', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

module.exports = {
  createTenant,
  updateTenant,
  listTenants,
  exportTenantsCsv,
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
  getTenantNames
};
