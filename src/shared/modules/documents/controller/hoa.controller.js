/**
 * ------------------------------------------------------------------
 * File: hoa.controller.js
 * Module: Documents Module
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * documents.routes
 * ------------------------------------------------------------------
 */

const hoaDocumentsService = require('../service/hoa.service');
const responseHelper = require('../../../../common/helpers/responseHelper');
const { createUpload } = require('../../../../common/helpers/uploadHelper');
const { multerInvoiceDocFilter } = require('../../../../common/helpers/fileValidationHelper');
const { getRequestRole, resolveDocumentHoaContext } = require('../helpers/hoaDocumentContext');
const { getProfile } = require('../../../../common/constants/uploadFileTypes');
const { HOA_DOCUMENT_MAX_TOTAL_BYTES } = require('../helpers/hoaDocumentUploadLimits');

const invoiceDocMaxSize = getProfile('INVOICE_DOC').maxSizeBytes;

const { uploadSingle } = createUpload('attachment', 'hoa-documents', {
  maxCount: 1,
  maxSizeBytes: Math.min(invoiceDocMaxSize, HOA_DOCUMENT_MAX_TOTAL_BYTES),
  fileFilter: multerInvoiceDocFilter,
});

const getHOADocuments = async (req, res) => {
  try {
    const hoaContext = await resolveDocumentHoaContext(req);
    const actorUserId = req.user?.id || req.user?._id || req.userId || null;
    const documents = await hoaDocumentsService.getHOADocuments(await getRequestRole(req), hoaContext, {
      userId: actorUserId,
      email: req.user?.email,
    });
    return responseHelper.success(res, documents, 'HOA documents fetched successfully', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

const getHOADocumentsForOwner = async (req, res) => {
  try {
    const { ownerId } = req.params;
    const hoaContext = await resolveDocumentHoaContext(req);
    const result = await hoaDocumentsService.getHOADocumentsForOwner(ownerId, {
      role: await getRequestRole(req),
      hoaContext,
      viewer: { userId: req.user?.id || req.user?._id || req.userId || null, email: req.user?.email },
    });
    return responseHelper.success(res, result, 'Owner documents fetched successfully', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

const getHOADocumentsByCategory = async (req, res) => {
  try {
    const { categoryId } = req.params;
    const { pageNumber = 1, pageSize = 10, search = '', accessLevel = 'all', fileType = 'all', dateFilter = 'all', uploadedBy = '' } = req.query;
    const hoaContext = await resolveDocumentHoaContext(req);
    
    const documents = await hoaDocumentsService.getHOADocumentsByCategory(categoryId, {
      pageNumber: parseInt(pageNumber),
      pageSize: parseInt(pageSize),
      search,
      accessLevel,
      fileType,
      dateFilter,
      uploadedBy,
      role: await getRequestRole(req),
      hoaContext,
      viewer: { userId: req.user?.id || req.user?._id || req.userId || null, email: req.user?.email },
    });
    
    return responseHelper.success(res, documents, 'Documents fetched successfully', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

const uploadHOADocument = async (req, res) => {
  try {
    const {
      documentName,
      category,
      accessLevel,
      description,
      linkedOwnerId,
      uploadSource,
      allowCommunityBoardAccess,
      allowedOwnerIds,
      allowedBoardMemberIds,
      allResidents,
    } = req.body;
    const file = req.file;
    
    if (!file) {
      return responseHelper.error(res, 'File attachment is required', 400);
    }
    
    if (!documentName || !category || !accessLevel) {
      return responseHelper.error(res, 'Document name, category, and access level are required', 400);
    }
    
    const trimmedDescription = typeof description === 'string' ? description.trim() : '';
    if (!trimmedDescription) {
      return responseHelper.error(res, 'Document description is required.', 400);
    }

    const documentData = {
      name: documentName,
      category,
      accessLevel,
      description: trimmedDescription,
      file: {
        originalName: file.originalname,
        filename: file.filename,
        path: file.path,
        size: file.size,
        mimetype: file.mimetype
      },
      uploadedBy: req.user?.email || req.user?.name || 'Current User',
      uploadedById: req.user?.id || req.user?._id || null,
      linkedOwnerId: linkedOwnerId || undefined,
      uploadSource: uploadSource || undefined,
      allowCommunityBoardAccess:
        allowCommunityBoardAccess === true || allowCommunityBoardAccess === 'true',
      allowedOwnerIds,
      allowedBoardMemberIds,
      allResidents,
    };
    
    const hoaContext = await resolveDocumentHoaContext(req);
    const result = await hoaDocumentsService.uploadHOADocument(documentData, await getRequestRole(req), hoaContext);
    return responseHelper.success(res, result, 'Document uploaded successfully', 201);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

const updateHOADocument = async (req, res) => {
  try {
    const { documentId } = req.params;
    const {
      documentName,
      accessLevel,
      description,
      allowedOwnerIds,
      allowedBoardMemberIds,
      allowCommunityBoardAccess,
    } = req.body;

    if (!documentId) {
      return responseHelper.error(res, 'Document ID is required', 400);
    }

    const hasAny =
      documentName !== undefined ||
      accessLevel !== undefined ||
      description !== undefined ||
      allowedOwnerIds !== undefined ||
      allowedBoardMemberIds !== undefined ||
      allowCommunityBoardAccess !== undefined ||
      Boolean(req.file);
    if (!hasAny) {
      return responseHelper.error(res, 'Nothing to update', 400);
    }

    const actorUserId = req.user?.id || req.user?._id || null;
    const hoaContext = await resolveDocumentHoaContext(req);
    const payload = {
      name: documentName,
      accessLevel,
      description,
      allowedOwnerIds,
      allowedBoardMemberIds,
      allowCommunityBoardAccess,
    };

    if (req.file) {
      payload.file = {
        originalName: req.file.originalname,
        filename: req.file.filename,
        path: req.file.path,
        size: req.file.size,
        mimetype: req.file.mimetype,
      };
    }

    const result = await hoaDocumentsService.updateHOADocument(
      documentId,
      payload,
      { userId: actorUserId, email: req.user?.email },
      await getRequestRole(req),
      hoaContext
    );
    return responseHelper.success(res, result, 'Document updated successfully', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

const deleteHOADocument = async (req, res) => {
  try {
    const { documentId } = req.params;
    
    if (!documentId) {
      return responseHelper.error(res, 'Document ID is required', 400);
    }
    
    const actorUserId = req.user?.id || req.user?._id || null;
    const hoaContext = await resolveDocumentHoaContext(req);
    const result = await hoaDocumentsService.deleteHOADocument(
      documentId,
      { userId: actorUserId, email: req.user?.email },
      await getRequestRole(req),
      hoaContext
    );
    return responseHelper.success(res, result, 'Document deleted successfully', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

module.exports = {
  getHOADocuments,
  getHOADocumentsForOwner,
  getHOADocumentsByCategory,
  uploadHOADocument,
  updateHOADocument,
  deleteHOADocument,
  uploadSingle,
};
