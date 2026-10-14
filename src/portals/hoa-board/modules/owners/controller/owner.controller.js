const path = require('path');

/**
 * ------------------------------------------------------------------
 * File: owner.controller.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * owner.routes
 * ------------------------------------------------------------------
 */
const ownerService = require('../service/owner.service');
const responseHelper = require('../../../../../common/helpers/responseHelper');
const { createUpload } = require('../../../../../common/helpers/uploadHelper');
const { ClockService, DateUtil } = require('../../../../../common/date');
const {
  notifyOwnerCreatedInAppInBackground,
  notifyOwnerUpdatedInAppInBackground,
  notifyOwnerArchivedInAppInBackground,
  notifyOwnerDeletedInAppInBackground,
} = require('../../../../../common/helpers/hoaEntityNotify.helper');
const { logControllerStep, handleControllerError } = require('../../../../../common/helpers/controllerLogger');

const noteUpload = createUpload('attachments', null, { maxCount: 10, maxSizeBytes: 10 * 1024 * 1024 });
const { uploadArray: importUpload } = createUpload('file', null, { maxCount: 1, maxSizeBytes: 10 * 1024 * 1024 });

/**
 * Returns true only when resolvedPath stays within the OS temp/upload directory,
 * preventing path traversal via crafted filenames (CWE-22).
 */
function isSafeUploadPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const resolved = path.resolve(filePath);
  const allowedRoots = [
    path.resolve(require('os').tmpdir()),
    path.resolve('uploads'),
  ];
  return allowedRoots.some((root) => resolved.startsWith(root + path.sep) || resolved === root);
}

const stripTenantOnlyFields = (payload = {}) => {
  const sanitized = { ...payload };
  delete sanitized.tenantId;
  delete sanitized.tenantStatus;
  delete sanitized.rent;
  delete sanitized.roommates;
  delete sanitized.leaseId;
  delete sanitized.leaseStart;
  delete sanitized.leaseEnd;
  delete sanitized.screening;
  return sanitized;
};

const listOwners = async (req, res) => {
  logControllerStep(req, 'START', { action: 'listOwners' });
  try {
    const { pageNumber = 1, pageSize = 10, sortBy = 'createdAt', sortOrder = 'desc', search = '', showArchived = 'false', accountStatusGroup = '', accountStatus = '', property = '', propertyId = '', unitId = '', unitName = '', ownerId = '', ownerStatus = '', paymentStatus = '', feesExpiringThisYear = 'false' } = req.query;
    const userId = req.user?._id || req.user?.id;
    const owners = await ownerService.listOwners({
      pageNumber: parseInt(pageNumber),
      pageSize: parseInt(pageSize),
      sortBy,
      sortOrder,
      userId,
      hoaContext: req.hoaContext || null,
      search,
      showArchived: showArchived === 'true' || showArchived === true,
      accountStatusGroup,
      accountStatus,
      property,
      propertyId,
      unitId,
      unitName,
      ownerId,
      ownerStatus,
      paymentStatus,
      feesExpiringThisYear: feesExpiringThisYear === 'true' || feesExpiringThisYear === true,
    });
    return responseHelper.success(res, owners, 'Owners fetched successfully', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status, null, err.errors || null);
  }
};

const listOwnersPicker = async (req, res) => {
  logControllerStep(req, 'START', { action: 'listOwnersPicker' });
  try {
    const { search = '', limit = 50, propertyId = '', unitId = '', unitName = '' } = req.query;
    const userId = req.user?._id || req.user?.id;
    const rows = await ownerService.listOwnersPicker({
      search,
      limit: parseInt(limit, 10) || 50,
      userId,
      hoaContext: req.hoaContext || null,
      propertyId: propertyId || null,
      unitId: unitId || null,
      unitName: unitName || null,
    });
    return responseHelper.success(res, { data: rows }, 'Owner picker fetched successfully', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status, null, err.errors || null);
  }
};

const createOwner = async (req, res) => {
  logControllerStep(req, 'START', { action: 'createOwner' });
  try {
    const ownerData = req.body || {};
    const userId = req.user?._id || req.user?.id;
    const created = await ownerService.createOwner(ownerData, {
      userId,
      triggerInvite: true,
      hoaContext: req.hoaContext || null,
    });

    let payload;
    if (created && created.toSafeJSON) {
      payload = created.toSafeJSON();
    } else {
      const obj = created.toObject ? created.toObject() : created;
      delete obj.password;
      payload = obj;
    }
    const invitationMeta = created?._invitationMeta || {};
    const message = invitationMeta.invitationQueued
      ? 'Owner created successfully. Invitation email is being sent.'
      : invitationMeta.invitationSent
        ? 'Owner created successfully'
        : invitationMeta.invitationError
          ? 'Owner created, but the invitation email could not be sent'
          : 'Owner created successfully';

    setImmediate(() => {
      notifyOwnerCreatedInAppInBackground(created, userId, req.hoaContext?.hoaId);
    });
    return responseHelper.success(
      res,
      {
        owner: stripTenantOnlyFields(payload),
        invitationQueued: Boolean(invitationMeta.invitationQueued),
        invitationSent: Boolean(invitationMeta.invitationSent),
        invitationError: invitationMeta.invitationError || null,
      },
      message,
      201
    );
  } catch (err) {
    const status = err.status || 500;
    const fieldErrors =
      err.field || err.isEmailValidationError
        ? [{ field: err.field || 'email', message: err.message }]
        : err.errors || null;
    return responseHelper.error(res, err.message, status, null, fieldErrors);
  }
};

const getOwnerById = async (req, res) => {
  logControllerStep(req, 'START', { action: 'getOwnerById' });
  try {
    const ownerId = req.params && req.params.id;
    const owner = await ownerService.getOwnerById(ownerId, {
      include: req.query?.include,
      hoaContext: req.hoaContext,
      role: req.userRoleName || req.user?.role,
      viewer: {
        userId: req.user?.id || req.user?._id || req.userId || req.hoaContext?.userId || null,
        email: req.user?.email,
      },
    });
    return responseHelper.success(res, { owner }, 'Owner fetched successfully', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

const updateOwner = async (req, res) => {
  logControllerStep(req, 'START', { action: 'updateOwner' });
  try {
    const ownerId = req.params && req.params.id;
    const ownerData = req.body || {};
    const userId = req.user?._id || req.user?.id;
    const updated = await ownerService.updateOwner(ownerId, ownerData, {
      userId,
      hoaContext: req.hoaContext || null,
    });
    setImmediate(() => {
      notifyOwnerUpdatedInAppInBackground(updated, userId, req.hoaContext?.hoaId);
    });
    return responseHelper.success(res, { owner: updated }, 'Owner updated successfully', 200);
  } catch (err) {
    const status = err.status || 500;
    const fieldErrors =
      err.field || err.isEmailValidationError
        ? [{ field: err.field || 'email', message: err.message }]
        : null;
    return responseHelper.error(res, err.message, status, null, fieldErrors);
  }
};

const resendOwnerInvite = async (req, res) => {
  logControllerStep(req, 'START', { action: 'resendOwnerInvite' });
  try {
    const ownerId = req.params && req.params.id;
    const userId = req.user?._id || req.user?.id;
    const result = await ownerService.resendOwnerInvite(ownerId, { userId, hoaContext: req.hoaContext || null });
    return responseHelper.success(res, result, 'Invitation email sent', 200);
  } catch (err) {
    const status = err.status || 500;
    const fieldErrors =
      err.field || err.isEmailValidationError
        ? [{ field: err.field || 'email', message: err.message }]
        : null;
    return responseHelper.error(res, err.message, status, null, fieldErrors);
  }
};

const importOwners = async (req, res) => {
  logControllerStep(req, 'START', { action: 'importOwners' });
  const userId = req.user?._id || req.user?.id;

  importUpload(req, res, async function (err) {
    if (err) return responseHelper.error(res, err.message || 'Upload failed', 400);
    try {
      const files = req.files || [];
      if (!files || files.length === 0) return responseHelper.error(res, 'No file uploaded. Use form field "file" to upload CSV or JSON.', 400);

      const f = files[0];
      let fileForService = f;
      if (f && f.path && !f.buffer) {
        if (!isSafeUploadPath(f.path)) {
          return responseHelper.error(res, 'Invalid upload path', 400);
        }
        try {
          const fs = require('fs');
          const buf = fs.readFileSync(f.path);
          fileForService = Object.assign({}, f, { buffer: buf });
        } catch (readErr) {
          try { if (isSafeUploadPath(f.path)) require('fs').unlinkSync(f.path); } catch (ignore) {}
          return responseHelper.error(res, 'Failed to read uploaded file', 400);
        }
      }

      const result = await ownerService.importOwnersFromFile(
        fileForService,
        userId,
        req.hoaContext || null
      );
      try { if (f && f.path && isSafeUploadPath(f.path)) require('fs').unlinkSync(f.path); } catch (ignore) {}
      return responseHelper.success(res, result, 'Import completed', 200);
    } catch (err) {
      if (req.files) {
        for (const f of req.files) { try { if (isSafeUploadPath(f.path)) require('fs').unlinkSync(f.path); } catch (ignore) {} }
      }
      const status = err.status || 500;
      return responseHelper.error(res, err.message, status);
    }
  });
};

const exportOwners = async (req, res) => {
  logControllerStep(req, 'START', { action: 'exportOwners' });
  try {
    const {
      format = 'csv',
      search = '',
      showArchived = 'false',
      accountStatusGroup = '',
      accountStatus = '',
      property = '',
      propertyId = '',
      unitId = '',
      unitName = '',
      ownerId = '',
      ownerStatus = '',
      paymentStatus = '',
      feesExpiringThisYear = 'false',
    } = req.query;
    if (!['csv', 'xlsx', 'json'].includes(format)) {
      return responseHelper.error(res, 'Invalid format. Must be csv, xlsx, or json', 400);
    }
    const userId = req.user?._id || req.user?.id;
    const { content, mimeType, extension } = await ownerService.exportOwners(
      userId,
      format,
      req.hoaContext || null,
      {
        search,
        showArchived: showArchived === 'true' || showArchived === true,
        accountStatusGroup,
        accountStatus,
        property,
        propertyId,
        unitId,
        unitName,
        ownerId,
        ownerStatus,
        paymentStatus,
        feesExpiringThisYear: feesExpiringThisYear === 'true' || feesExpiringThisYear === true,
      },
    );
    const timestamp = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="owners_export_${timestamp}.${extension}"`);
    return res.send(content);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

const downloadOwnerTemplate = async (req, res) => {
  logControllerStep(req, 'START', { action: 'downloadOwnerTemplate' });
  try {
    const { format = 'csv' } = req.query;
    if (!['csv', 'xlsx', 'json'].includes(format)) {
      return responseHelper.error(res, 'Invalid format. Must be csv, xlsx, or json', 400);
    }
    const { content, mimeType, extension } = await ownerService.downloadOwnerTemplate(format);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="owners_import_template.${extension}"`);
    return res.send(content);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

const archiveOwner = async (req, res) => {
  logControllerStep(req, 'START', { action: 'archiveOwner' });
  try {
    const ownerId = req.params && req.params.id;
    const userId = req.user?._id || req.user?.id;
    const archived = await ownerService.archiveOwner(ownerId, { userId });
    setImmediate(() => {
      const ownerName = `${archived?.firstName || ''} ${archived?.lastName || ''}`.trim() || 'Owner';
      notifyOwnerArchivedInAppInBackground({
        ownerUserId: ownerId,
        ownerName,
        hoaId: req.hoaContext?.hoaId,
      }, userId);
    });
    return responseHelper.success(res, { owner: archived }, 'Owner archived successfully', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

const deleteOwner = async (req, res) => {
  logControllerStep(req, 'START', { action: 'deleteOwner' });
  try {
    const ownerId = req.params && req.params.id;
    const userId = req.user?._id || req.user?.id;
    const result = await ownerService.deleteOwner(ownerId, {
      userId,
      deletePayload: req.body || {},
    });
    setImmediate(() => {
      notifyOwnerDeletedInAppInBackground({
        ownerUserId: ownerId,
        ownerName: result?.ownerName || 'Owner',
        hoaId: result?.hoaId || req.hoaContext?.hoaId,
      }, userId);
    });
    return responseHelper.success(res, result, 'Owner deleted successfully', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

const getOwnerDeletePreview = async (req, res) => {
  logControllerStep(req, 'START', { action: 'getOwnerDeletePreview' });
  try {
    const ownerId = req.params && req.params.id;
    const userId = req.user?._id || req.user?.id;
    const preview = await ownerService.getOwnerDeletePreview(ownerId, { userId });
    return responseHelper.success(res, { preview }, 'Delete preview loaded', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

const addNoteToOwner = async (req, res) => {
  logControllerStep(req, 'START', { action: 'addNoteToOwner' });
  noteUpload.uploadArray(req, res, async function (err) {
    if (err) return res.status(400).json({ message: err.message || 'Upload failed' });
    try {
      const ownerId = req.params.id;
      const { description, title, isPinned, isImportant, reminder } = req.body;
      const files = req.files || [];
      if (!description && files.length === 0) {
        return res.status(400).json({ message: 'description or at least one attachment is required' });
      }
      if (files.length > 10) return res.status(400).json({ message: 'Maximum 10 attachments allowed.' });
      
      const parsedData = {
        description: description || (files.length > 0 ? 'Attachment added.' : ''),
        title,
        isPinned: isPinned === 'true' || isPinned === true,
        isImportant: isImportant === 'true' || isImportant === true,
        reminder
      };
      
      const updated = await ownerService.addNoteToOwner(ownerId, parsedData, files, req.userId);
      const notesOnly = Array.isArray(updated?.notes) ? updated.notes : [];
      return res.status(201).json({ notes: notesOnly });
    } catch (e) {
      if (req.files) {
        for (const f of req.files) {
          try { if (isSafeUploadPath(f.path)) require('fs').unlinkSync(f.path); } catch (ignore) {}
        }
      }
      const status = e.status || 500;
      res.status(status).json({ message: e.message });
    }
  });
};

const updateNoteInOwner = async (req, res) => {
  logControllerStep(req, 'START', { action: 'updateNoteInOwner' });
  noteUpload.uploadArray(req, res, async function (err) {
    if (err) return res.status(400).json({ message: err.message || 'Upload failed' });
    try {
      const ownerId = req.params.id;
      const noteId = req.params.noteId;
      const { description, title, isPinned, isImportant, reminder, removeAttachmentIds } = req.body;
      const files = req.files || [];
      if (files.length > 10) return res.status(400).json({ message: 'Maximum 10 attachments allowed.' });

      const parsedData = {
        description,
        title,
        reminder,
        removeAttachmentIds,
      };
      if (isPinned !== undefined) {
        parsedData.isPinned = isPinned === 'true' || isPinned === true;
      }
      if (isImportant !== undefined) {
        parsedData.isImportant = isImportant === 'true' || isImportant === true;
      }

      const updated = await ownerService.updateNoteInOwner(ownerId, noteId, parsedData, req.userId, files);
      const notesOnly = Array.isArray(updated?.notes) ? updated.notes : [];
      return res.status(200).json({ notes: notesOnly });
    } catch (e) {
      if (req.files) {
        for (const f of req.files) {
          try { if (isSafeUploadPath(f.path)) require('fs').unlinkSync(f.path); } catch (ignore) {}
        }
      }
      const status = e.status || 500;
      res.status(status).json({ message: e.message });
    }
  });
};

const deleteNoteFromOwner = async (req, res) => {
  logControllerStep(req, 'START', { action: 'deleteNoteFromOwner' });
  try {
    const ownerId = req.params.id;
    const noteId = req.params.noteId;
    
    const updated = await ownerService.deleteNoteFromOwner(ownerId, noteId, req.userId);
    const notesOnly = Array.isArray(updated?.notes) ? updated.notes : [];
    return res.status(200).json({ notes: notesOnly });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ message: e.message });
  }
};

module.exports = {
  listOwners,
  listOwnersPicker,
  createOwner,
  getOwnerById,
  updateOwner,
  resendOwnerInvite,
  importOwners,
  exportOwners,
  downloadOwnerTemplate,
  archiveOwner,
  deleteOwner,
  getOwnerDeletePreview,
  addNoteToOwner,
  updateNoteInOwner,
  deleteNoteFromOwner
};
