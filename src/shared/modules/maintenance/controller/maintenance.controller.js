/**
 * ------------------------------------------------------------------
 * File: maintenance.controller.js
 * Module: Maintenance Module
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * maintenance.routes
 * ------------------------------------------------------------------
 */

const responseHelper = require('../../../../common/helpers/responseHelper');
const maintenanceService = require('../service/maintenance.service');
const maintenanceExportService = require('../service/maintenanceExport.service');
const { resolveUserRoleName } = require('../../../../common/helpers/companyRoleHelper');
const { isHOABoardMemberRole } = require('../../../../common/helpers/hoaBoardRole');
const User = require('../../users/models/user.model');
const MaintenanceRequest = require('../model/maintenanceRequest.model');
const { normalizeUserId } = require('../../../../common/helpers/maintenanceEmailRecipients');
const { logControllerStep, handleControllerError } = require('../../../../common/helpers/controllerLogger');
const { isVendorRole, getVendorRoleRefs } = require('../../../../common/helpers/hoaVendorRole');
const { resolveCreatedBy } = require('../../../../shared/utils/creatorScope.util');
const { MAINTENANCE_REQUEST_STATUS } = require('../../../../common/constants/property');
const { resolveMaintenanceActorRoleName } = require('../helpers/vendorMaintenanceAccess.helper');

/**
 * actor User Id
 *
 * Performs logic operations for actorUserId.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function actorUserId(req) {
  return (req.user && (req.user._id || req.user.id)) || req.userId;
}

/** Pass HOA scope from middleware (board) or x-hoa-id header (owners) into list/export queries. */
function buildMaintenanceUserContext(req) {
  if (req.hoaContext) return req.hoaContext;
  const rawHoaId = req.headers['x-hoa-id'];
  const hoaId = rawHoaId ? String(rawHoaId).trim() : '';
  const roleName = resolveMaintenanceActorRoleName(req);
  const userId = actorUserId(req);
  if (!hoaId && !userId) return null;
  return {
    hoaId: hoaId || undefined,
    userId,
    roleName,
    isHOABoardMember: isHOABoardMemberRole(roleName),
    isVendor: isVendorRole(roleName),
  };
}

function isVendorRequestActor(req, userContext) {
  return Boolean(
    userContext?.isVendor
    || isVendorRole(userContext?.roleName || userContext?.role)
    || isVendorRole(resolveMaintenanceActorRoleName(req))
  );
}

async function createRequest(req, res) {
  logControllerStep(req, 'START', { action: 'createRequest' });
  try {
    const payload = req.body || {};
    const userId = actorUserId(req);
    const userContext = buildMaintenanceUserContext(req);
    const requiresHoaScope = Boolean(req.hoaContext || req.headers['x-hoa-id']);
    const created = await maintenanceService.createMaintenanceRequestWithDocuments(payload, {
      files: req.files || [],
      userId,
      uploadedBy: userId,
      userContext,
      requiresHoaScope,
    });
    return responseHelper.success(res, { request: created }, 'Maintenance request created', 201);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to create maintenance request', status);
  }
}

async function listRequests(req, res) {
  logControllerStep(req, 'START', { action: 'listRequests' });
  try {
    const userId = actorUserId(req);
    const isAdmin = req.user && req.user.isAdministrator;
    const companyId = req.user && req.user.companyId;
    const queryPayload = Object.assign({}, req.query || {});
    queryPayload.createdBy = isAdmin
      ? { userId, isAdministrator: true, companyId }
      : resolveCreatedBy(queryPayload, userId);
    const filter = maintenanceService.buildListFilterFromQuery(queryPayload || {}, userId);
    const pagination = maintenanceService.normalizeListPagination(req.query || {});
    const result = await maintenanceService.listMaintenanceRequests(filter, {
      ...pagination,
      userContext: buildMaintenanceUserContext(req),
    });
    return responseHelper.success(res, result, 'Maintenance requests fetched', 200);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to list maintenance requests', status);
  }
}

async function getRequest(req, res) {
  logControllerStep(req, 'START', { action: 'getRequest' });
  try {
    const userContext = buildMaintenanceUserContext(req);
    const item = await maintenanceService.getMaintenanceRequestById(req.params.id, {
      hoaContext: req.hoaContext,
      userContext,
      userId: actorUserId(req),
    });
    return responseHelper.success(res, { request: item }, 'Maintenance request fetched', 200);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to fetch maintenance request', status);
  }
}

async function updateRequest(req, res) {
  logControllerStep(req, 'START', { action: 'updateRequest' });
  try {
    const userId = actorUserId(req);
    const userContext = req.hoaContext || buildMaintenanceUserContext(req);
    const updated = await maintenanceService.updateMaintenanceRequestWithDocuments(req.params.id, req.body || {}, {
      files: req.files || [],
      userId,
      uploadedBy: userId,
      userContext,
    });
    return responseHelper.success(res, { request: updated }, 'Maintenance request updated', 200);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to update maintenance request', status);
  }
}

async function deleteRequest(req, res) {
  logControllerStep(req, 'START', { action: 'deleteRequest' });
  try {
    const userId = actorUserId(req);
    const userContext = req.hoaContext || buildMaintenanceUserContext(req);
    await maintenanceService.deleteMaintenanceRequest(req.params.id, { userId, userContext });
    return responseHelper.success(res, null, 'Maintenance request deleted', 200);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to delete maintenance request', status);
  }
}

async function uploadDocuments(req, res) {
  logControllerStep(req, 'START', { action: 'uploadDocuments' });
  try {
    const userId = actorUserId(req);
    if (!req.files || !req.files.length) {
      return responseHelper.error(res, 'No files uploaded', 400);
    }
    const userContext = req.hoaContext || buildMaintenanceUserContext(req);
    const updated = await maintenanceService.uploadDocuments(req.params.id, req.files, {
      uploadedBy: userId,
      userId,
      userContext,
    });
    return responseHelper.success(res, { request: updated }, 'Documents uploaded successfully', 201);
  } catch (error) {
    const status = error.status || 500;
    return responseHelper.error(res, error.message || 'Failed to process upload', status);
  }
}

async function getDocuments(req, res) {
  logControllerStep(req, 'START', { action: 'getDocuments' });
  try {
    const documents = await maintenanceService.getMaintenanceDocuments(req.params.id);
    return responseHelper.success(res, documents, 'Documents fetched successfully', 200);
  } catch (error) {
    const status = error.status || 500;
    return responseHelper.error(res, error.message || 'Failed to fetch documents', status);
  }
}

async function downloadDocument(req, res) {
  logControllerStep(req, 'START', { action: 'downloadDocument' });
  try {
    const { fileStream, fileName, contentType } = await maintenanceService.getDocumentFile(
      req.params.id,
      req.params.metadataId
    );
    const { sendBinaryDownload } = require('../../../../common/helpers/fileDownloadHelper');
    return await sendBinaryDownload(res, {
      stream: fileStream,
      fileName,
      contentType,
    });
  } catch (error) {
    const status = error.status || 500;
    return responseHelper.error(res, error.message || 'Failed to download document', status);
  }
}

async function resolveRequest(req, res) {
  logControllerStep(req, 'START', { action: 'resolveRequest' });
  try {
    const userId = actorUserId(req);
    const { comment } = req.body || {};
    const userContext = buildMaintenanceUserContext(req);
    const updated = await maintenanceService.resolveMaintenanceRequest(
      req.params.id,
      { comment, userId },
      { userId, userContext }
    );
    return responseHelper.success(res, { request: updated }, 'Maintenance request resolved', 200);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to resolve maintenance request', status);
  }
}

async function rejectRequest(req, res) {
  logControllerStep(req, 'START', { action: 'rejectRequest' });
  try {
    const userId = actorUserId(req);
    const { comment } = req.body || {};
    const userContext = buildMaintenanceUserContext(req);
    const updated = await maintenanceService.rejectMaintenanceRequest(
      req.params.id,
      { comment, userId },
      { userId, userContext }
    );
    return responseHelper.success(res, { request: updated }, 'Maintenance request rejected', 200);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to reject maintenance request', status);
  }
}

async function addComment(req, res) {
  logControllerStep(req, 'START', { action: 'addComment' });
  try {
    const userId = actorUserId(req);
    const { text, attachments } = req.body || {};
    if (!userId) {
      return responseHelper.error(res, 'User authentication failed', 401);
    }
    if (!text || !text.trim()) {
      return responseHelper.error(res, 'Comment text is required', 400);
    }
    const updated = await maintenanceService.addComment(
      req.params.id,
      { author: userId, text: text.trim(), attachments: Array.isArray(attachments) ? attachments : [] },
      { userId, userContext: buildMaintenanceUserContext(req) }
    );
    return responseHelper.success(res, { request: updated }, 'Comment added successfully', 201);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to add comment', status);
  }
}

async function addNote(req, res) {
  logControllerStep(req, 'START', { action: 'addNote' });
  try {
    const userId = actorUserId(req);
    const { content } = req.body || {};
    if (!userId) {
      return responseHelper.error(res, 'User authentication failed', 401);
    }
    if (!content || !content.trim()) {
      return responseHelper.error(res, 'Note content is required', 400);
    }
    const updated = await maintenanceService.addNote(
      req.params.id,
      { author: userId, content: content.trim() },
      { userId, userContext: req.hoaContext || buildMaintenanceUserContext(req) }
    );
    return responseHelper.success(res, { request: updated }, 'Note added successfully', 201);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to add note', status);
  }
}

async function updateNote(req, res) {
  logControllerStep(req, 'START', { action: 'updateNote' });
  try {
    const userId = actorUserId(req);
    const { content } = req.body || {};
    if (!userId) {
      return responseHelper.error(res, 'User authentication failed', 401);
    }
    if (!content || !content.trim()) {
      return responseHelper.error(res, 'Note content is required', 400);
    }
    const updated = await maintenanceService.updateMaintenanceNote(
      req.params.id,
      req.params.noteId,
      { content: content.trim() },
      { userId, userContext: req.hoaContext || buildMaintenanceUserContext(req) }
    );
    return responseHelper.success(res, { request: updated }, 'Note updated successfully', 200);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to update note', status);
  }
}

async function deleteNote(req, res) {
  logControllerStep(req, 'START', { action: 'deleteNote' });
  try {
    const userId = actorUserId(req);
    if (!userId) {
      return responseHelper.error(res, 'User authentication failed', 401);
    }
    const updated = await maintenanceService.deleteMaintenanceNote(
      req.params.id,
      req.params.noteId,
      { userId, userContext: req.hoaContext || buildMaintenanceUserContext(req) }
    );
    return responseHelper.success(res, { request: updated }, 'Note deleted successfully', 200);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to delete note', status);
  }
}

async function getComments(req, res) {
  logControllerStep(req, 'START', { action: 'getComments' });
  try {
    const userId = actorUserId(req);
    const comments = await maintenanceService.getComments(req.params.id, {
      userId,
      userContext: buildMaintenanceUserContext(req),
    });
    return responseHelper.success(res, { comments }, 'Comments fetched successfully', 200);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to fetch comments', status);
  }
}

async function exportMaintenance(req, res) {
  logControllerStep(req, 'START', { action: 'exportMaintenance' });
  try {
    const userId = actorUserId(req);
    const isAdmin = req.user && req.user.isAdministrator;
    const companyId = req.user && req.user.companyId;
    const queryPayload = Object.assign({}, req.query || {});
    const format = queryPayload.format || 'csv';
    delete queryPayload.format;
    // Match listRequests: do not force createdBy when HOA list scopes are present
    queryPayload.createdBy = isAdmin
      ? { userId, isAdministrator: true, companyId }
      : resolveCreatedBy(queryPayload, userId);
    const filter = maintenanceService.buildListFilterFromQuery(queryPayload, userId);
    const pagination = maintenanceService.normalizeListPagination(req.query || {});
    const result = await maintenanceExportService.exportMaintenance(
      { ...filter, ...pagination },
      format,
      { userContext: buildMaintenanceUserContext(req) },
    );
    const filename = result && result.filename ? result.filename : `maintenance_export.${format}`;
    const content = result && result.content ? result.content : '';
    const contentType = result && result.contentType ? result.contentType : 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(content);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to export maintenance requests', status);
  }
}

async function getActiveTenantsByProperty(req, res) {
  logControllerStep(req, 'START', { action: 'getActiveTenantsByProperty' });
  try {
    const { property_id, unitName, unitId } = req.query || {};
    if (!property_id) {
      return res.status(400).json({ message: 'property_id is required' });
    }
    const tenants = await maintenanceService.getActiveTenantsByPropertyService(property_id, {
      unitId,
      unitName,
    });
    return res.json({
      message: 'Active tenants retrieved successfully',
      statuscode: 200,
      data: tenants,
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ message: err.message });
  }
}

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

/**
 * Ticket creation stores any vendor chosen from the HOA vendor picker.
 * Details-page assignment must accept that same vendor, including vendors
 * whose associatedHoaIds were not backfilled.
 */
async function selectedUserIsVendor(vendor) {
  const roleName = await resolveUserRoleName(vendor);
  if (isVendorRole(roleName)) return true;
  if (!vendor?.companyRoleId) return false;
  try {
    const refs = await getVendorRoleRefs();
    return Boolean(refs?.roleId) && String(vendor.companyRoleId) === String(refs.roleId);
  } catch (_) {
    return false;
  }
}

async function assignVendor(req, res) {
  logControllerStep(req, 'START', { action: 'assignVendor' });
  try {
    const vendorId = req.body?.vendorId != null ? String(req.body.vendorId).trim() : '';
    if (!vendorId || !OBJECT_ID_PATTERN.test(vendorId)) {
      return responseHelper.error(res, 'vendorId is required', 400);
    }

    const hoaContext = req.hoaContext || null;
    if (hoaContext?.hoaId) {
      const vendor = await User.findOne({ _id: vendorId, isDeleted: { $ne: true } })
        .select('companyRoleId companyId')
        .lean();
      if (!vendor) {
        return responseHelper.error(res, 'Vendor not found', 404);
      }
      if (!(await selectedUserIsVendor(vendor))) {
        return responseHelper.error(res, 'Selected user is not a vendor', 400);
      }
    }

    const userId = actorUserId(req);
    const userContext = req.hoaContext || buildMaintenanceUserContext(req);
    if (isVendorRequestActor(req, userContext)) {
      return responseHelper.error(res, 'Vendors cannot assign or change ticket vendors', 403);
    }

    const existing = await MaintenanceRequest.findOne({
      _id: req.params.id,
      isDeleted: { $ne: true },
    })
      .select('assignedTo')
      .lean();
    if (!existing) {
      return responseHelper.error(res, 'Maintenance request not found', 404);
    }
    const currentAssignedId = normalizeUserId(existing.assignedTo);
    if (currentAssignedId && String(currentAssignedId) === String(vendorId)) {
      return responseHelper.error(res, 'This vendor is already assigned to the ticket', 400);
    }

    const updated = await maintenanceService.updateMaintenanceRequest(
      req.params.id,
      { assignedTo: vendorId, status: MAINTENANCE_REQUEST_STATUS.IN_PROGRESS },
      { userId, userContext }
    );
    return responseHelper.success(res, { request: updated }, 'Vendor assigned to maintenance ticket', 200);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to assign vendor', status);
  }
}

module.exports = {
  createRequest,
  listRequests,
  getRequest,
  updateRequest,
  deleteRequest,
  resolveRequest,
  rejectRequest,
  uploadDocuments,
  getDocuments,
  downloadDocument,
  addComment,
  getComments,
  addNote,
  updateNote,
  deleteNote,
  exportMaintenance,
  getActiveTenantsByProperty,
  assignVendor,
};
