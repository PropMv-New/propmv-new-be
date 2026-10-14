/**
 * ------------------------------------------------------------------
 * File: lease.controller.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * lease.routes, template.routes
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const leaseService = require('../service/lease.service');
const leaseExportService = require('../service/leaseExport.service');
const { createUpload } = require('../../../../../common/helpers/uploadHelper');
const { UPLOAD_LEASE_SUBDIR } = require('../../../../../common/constants/uploads');
const { multerPdfFilter, multerNoteAttachmentFilter, assertUploadedFilesValid } = require('../../../../../common/helpers/fileValidationHelper');
const { cleanupUploadedFiles } = require('../../../../../middleware/multipartValidator');
const { LEASE_STATUSES } = require('../../../../../common/constants/lease');
const { resolveCreatedBy } = require('../../../../../shared/utils/creatorScope.util');
const responseHelper = require('../../../../../common/helpers/responseHelper');
const logger = require('../../../../../common/logger');

const noteUpload = createUpload('attachments', null, {
  maxCount: 10,
  maxSizeBytes: 20 * 1024 * 1024,
  defaultSubdir: UPLOAD_LEASE_SUBDIR || 'lease-documents',
  fileFilter: multerNoteAttachmentFilter,
});

const { uploadArray } = createUpload('file', null, { maxCount: 10, maxSizeBytes: 10 * 1024 * 1024, defaultSubdir: UPLOAD_LEASE_SUBDIR, fileFilter: multerPdfFilter });

const addNoteToLease = async (req, res) => {
  noteUpload.uploadArray(req, res, async function (err) {
    if (err) {
      return res.status(400).json({ message: err.message || 'Upload failed' });
    }
    try {
      const leaseId = req.params && req.params.id;
      const description = req.body && req.body.description;
      const files = req.files || [];
      if (!description) return res.status(400).json({ message: 'description is required' });
      if (files.length > 10) return res.status(400).json({ message: 'Maximum 10 attachments allowed.' });
      await assertUploadedFilesValid(files, 'NOTE_ATTACHMENT');
      const updated = await leaseService.addNoteToLeaseService(leaseId, description, files);
      return res.status(201).json(updated);
    } catch (e) {
      cleanupUploadedFiles(req.files);
      const status = e.status || 500;
      res.status(status).json({ message: e.message });
    }
  });
};

const createLease = async (req, res) => {
  try {
    logger.info('Creating new lease', { userId: req.user?._id });
    const leaseData = req.body || {};
    // Normalize insurance fields coming from clients (strings like 'true'/'false', '1', '0', or checkbox 'on')
    if (typeof leaseData.requireInsurance !== 'boolean') {
      const v = leaseData.requireInsurance;
      leaseData.requireInsurance = (v === true || v === 'true' || v === '1' || v === 1 || v === 'on');
    }
    // Normalize includeDamageReport similarly (UI sends booleans or string/checkbox values)
    if (typeof leaseData.includeDamageReport !== 'boolean') {
      const v2 = leaseData.includeDamageReport;
      leaseData.includeDamageReport = (v2 === true || v2 === 'true' || v2 === '1' || v2 === 1 || v2 === 'on');
    }
    if (leaseData.insuranceTenantsIds && !Array.isArray(leaseData.insuranceTenantsIds)) {
      // allow comma separated lists or single id
      if (typeof leaseData.insuranceTenantsIds === 'string') {
        leaseData.insuranceTenantsIds = leaseData.insuranceTenantsIds.split(',').map(s => String(s).trim()).filter(Boolean);
      } else {
        leaseData.insuranceTenantsIds = [String(leaseData.insuranceTenantsIds)];
      }
    }
    const options = {};
    if (req.user) {
      options.user = req.user;
    }
    const saved = await leaseService.createLeaseService(leaseData, options);
    logger.info('Lease created successfully', { leaseId: saved._id });
    return res.status(201).json(saved);
  } catch (err) {
    logger.error('Failed to create lease', { error: err.message, userId: req.user?._id });
    const status = err.status || 500;
    return res.status(status).json({ message: err.message });
  }
};

const getLeaseById = async (req, res) => {
  try {
    const id = req.params && req.params.id;
    logger.debug('Fetching lease by ID', { leaseId: id, userId: req.user?._id });
    const lease = await leaseService.getLeaseByIdService(id);
    res.json(lease);
  } catch (err) {
    logger.error('Failed to fetch lease by ID', { leaseId: req.params?.id, error: err.message });
    const status = err.status || 500;
    res.status(status).json({ message: err.message });
  }
};

const listLeases = async (req, res) => {
  try {
    logger.debug('Listing leases', { query: req.query, userId: req.user?._id });
    const q = Object.assign({}, req.query || {});
    const data = await leaseService.listLeasesService(q);
    res.json(data);
  } catch (err) {
    logger.error('Failed to list leases', { error: err.message });
    res.status(500).json({ message: err.message });
  }
};

const listLeasesByLandlord = async (req, res) => {
  try {
    logger.debug('Listing leases by landlord', { status: req.query?.status, userId: req.user?._id });
    const { status, propertyId, from, to, search } = req.query || {};
    const actorId = req.user && (req.user._id || req.user.id);
    const isAdmin = !!(req.user && req.user.isAdministrator);
    const companyId = req.user?.companyId || null;
    const createdBy = isAdmin
      ? { userId: actorId, isAdministrator: true, companyId }
      : resolveCreatedBy(req.query || {}, actorId);
    // Prefer `pageNumber` query param; fall back to `page` for backward compatibility
    const rawPageNumber = typeof req.query.pageNumber !== 'undefined' ? req.query.pageNumber : req.query.page;
    const rawPageSize = req.query.pageSize;
    const parsedPageNumber = rawPageNumber ? parseInt(rawPageNumber, 10) : undefined;
    const parsedPageSize = rawPageSize ? parseInt(rawPageSize, 10) : undefined;
    const data = await leaseService.listLeasesByLandlordService({
      createdBy,
      status,
      propertyId,
      from,
      to,
      search,
      pageNumber: parsedPageNumber,
      pageSize: parsedPageSize,
    });
    logger.info('Leases listed successfully', { total: data.total, page: data.page });
    return responseHelper.success(res, data, 'Leases fetched successfully', 200);
  } catch (err) {
    logger.error('Failed to list leases by landlord', { error: err.message, userId: req.user?._id });
    const statusCode = err.status || 500;
    return res.status(statusCode).json({ message: err.message });
  }
};

const updateLease = async (req, res) => {
  try {
    const leaseId = req.params && req.params.id;
    logger.info('Updating lease', { leaseId, userId: req.user?._id });
    const leaseData = req.body || {};
    // Normalize insurance fields similar to create
    if (typeof leaseData.requireInsurance !== 'boolean') {
      const v = leaseData.requireInsurance;
      leaseData.requireInsurance = (v === true || v === 'true' || v === '1' || v === 1 || v === 'on');
    }
    if (typeof leaseData.includeDamageReport !== 'boolean') {
      const v2 = leaseData.includeDamageReport;
      leaseData.includeDamageReport = (v2 === true || v2 === 'true' || v2 === '1' || v2 === 1 || v2 === 'on');
    }
    if (leaseData.insuranceTenantsIds && !Array.isArray(leaseData.insuranceTenantsIds)) {
      if (typeof leaseData.insuranceTenantsIds === 'string') {
        leaseData.insuranceTenantsIds = leaseData.insuranceTenantsIds.split(',').map(s => String(s).trim()).filter(Boolean);
      } else {
        leaseData.insuranceTenantsIds = [String(leaseData.insuranceTenantsIds)];
      }
    }
    const options = {};
    if (req.user) {
      options.user = req.user;
    }
    const updated = await leaseService.updateLeaseService(leaseId, leaseData, options);
    logger.info('Lease updated successfully', { leaseId });
    res.json(updated);
  } catch (err) {
    logger.error('Failed to update lease', { leaseId: req.params?.id, error: err.message, userId: req.user?._id });
    const status = err.status || 500;
    res.status(status).json({ message: err.message });
  }
};

const deleteLease = async (req, res) => {
  try {
    const leaseId = req.params && req.params.id;
    logger.info('Deleting lease', { leaseId, userId: req.user?._id });
    await leaseService.deleteLeaseService(leaseId);
    logger.info('Lease deleted successfully', { leaseId });
    res.json({ message: 'Lease deleted successfully' });
  } catch (err) {
    logger.error('Failed to delete lease', { leaseId: req.params?.id, error: err.message });
    const status = err.status || 500;
    res.status(status).json({ message: err.message });
  }
};

const uploadDocument = async (req, res) => {
  const leaseId = req.params && req.params.id;
  uploadArray(req, res, async function (err) {
    if (err) return res.status(400).json({ message: err.message || 'Upload failed' });

    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ message: 'No files uploaded' });
    }

    try {
      await assertUploadedFilesValid(files, 'PDF');
      const results = [];
      for (const file of files) {
        const updated = await leaseService.uploadLeaseDocumentService(leaseId, file, { uploadedBy: (req.user && req.user._id) || undefined });
        results.push(updated);
      }
      return res.status(201).json({ 
        message: `${files.length} document${files.length > 1 ? 's' : ''} uploaded and attached to lease`, 
        statuscode: 201, 
        data: results 
      });
    } catch (e) {
      cleanupUploadedFiles(files);
      const status = e.status || 500;
      return res.status(status).json({ message: e.message || 'Failed to upload documents' });
    }
  });
};

const terminateLease = async (req, res) => {
  try {
    const { id } = req.params;
    const { comment } = req.body || {};
    const actorId = req.user && (req.user._id || req.user.id);
    logger.info('Terminating lease', { leaseId: id, userId: actorId });
    const terminatedLease = await leaseService.terminateLeaseWithCommentService(id, {
      comment: comment || '',
      actorId,
    });
    logger.info('Lease terminated successfully', { leaseId: id });
    return res.status(200).json({
      message: 'Lease terminated successfully',
      statusCode: 200,
      data: terminatedLease
    });
  } catch (err) {
    logger.error('Failed to terminate lease', { leaseId: req.params?.id, error: err.message });
    const status = err.status || 500;
    return res.status(status).json({ message: err.message });
  }
};

const getLeaseByTenant = async (req, res) => {
  try {
    const { tenantId, propertyId, unit, unitId } = req.query;
    const lease = await leaseService.getLeaseByTenantService({ tenantId, propertyId, unit, unitId });
    res.json(lease);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ message: err.message });
  }
};

const renewLease = async (req, res) => {
  try {
    const leaseId = req.params && req.params.id;
    const { type, ...leaseData } = req.body;
    logger.info('Renewing lease', { leaseId, renewType: type, userId: req.user?._id });

    const result = await leaseService.renewLeaseService(leaseId, { type, leaseData });
    logger.info('Lease renewed successfully', { leaseId, renewType: type });
    
    res.json(result);
  } catch (err) {
    logger.error('Failed to renew lease', { leaseId: req.params?.id, error: err.message, userId: req.user?._id });
    const status = err.status || 500;
    res.status(status).json({ message: err.message });
  }
};

const exportLeases = async (req, res) => {
  try {
    logger.info('Exporting leases', { format: req.query?.format, userId: req.user?._id });
    const q = Object.assign({}, req.query || {});
    const format = q.format || 'csv';
    
    // Remove format from query before passing to service
    delete q.format;

    const result = await leaseExportService.exportLeases(q, format);
    const filename = result && result.filename ? result.filename : `leases_export.${format}`;
    const content = result && result.content ? result.content : '';
    const contentType = result && result.contentType ? result.contentType : 'application/octet-stream';

    logger.info('Leases exported successfully', { format, filename });
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(content);
  } catch (err) {
    logger.error('Failed to export leases', { error: err.message, format: req.query?.format });
    const status = err.status || 500;
    return res.status(status).json({ message: err.message });
  }
};

const checkTenureAvailability = async (req, res) => {
  try {
    const result = await leaseService.checkTenureAvailabilityService(req.query || {});
    return res.status(200).json({
      message: 'Tenure availability fetched successfully',
      statuscode: 200,
      data: result,
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ message: err.message });
  }
};

// Lease Activation functions
const { activateLeaseService, approveLeaseService } = require('../service/leaseActivation.service');

const mapInvoiceResponse = (result) => ({
  lease: result.lease,
  invoicesGenerated: result.invoices.length,
  invoices: result.invoices.map((inv) => ({
    _id: inv._id,
    invoiceId: inv.invoiceId,
    type: inv.type,
    dueDate: inv.dueDate,
    amount: inv.subAmount,
    status: inv.status,
  })),
});

const activateLease = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await activateLeaseService(id);

    return res.status(200).json({
      message: 'Lease activated successfully',
      statusCode: 200,
      data: mapInvoiceResponse(result),
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ message: err.message });
  }
};

const approveLease = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await approveLeaseService(id);

    return res.status(200).json({
      message: 'Lease approved successfully',
      statusCode: 200,
      data: mapInvoiceResponse(result),
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ message: err.message });
  }
};

// Lease Management functions
const leaseManagementService = require('../service/leaseManagement.service');

const processLeaseLifecycle = async (req, res) => {
  try {
    logger.info('Starting lease lifecycle processing');
    
    const result = await leaseManagementService.processLeaseLifecycleService();
    
    logger.info('Lease lifecycle processing completed', result);
    
    return res.status(200).json({
      message: 'Lease lifecycle processed successfully',
      statusCode: 200,
      data: result,
    });
  } catch (err) {
    logger.error('Failed to process lease lifecycle', { error: err.message });
    const status = err.status || 500;
    return res.status(status).json({ message: err.message });
  }
};

// Template functions
const LeaseTemplateService = require('../service/template.service');
const { uploadArray: templateUpload, tempDir } = createUpload('template', 'lease-templates', {
  maxCount: 1,
  fileFilter: multerPdfFilter,
  maxSizeBytes: 10 * 1024 * 1024
});

const createTemplate = async (req, res, next) => {
  try {
    const { createdBy } = req.params;
    const { templateName, description, templateType } = req.body || {};
    if (!req.file) {
      return responseHelper.error(res, 'PDF file is required', 400);
    }

    const template = await LeaseTemplateService.createTemplate(createdBy, req.file, { templateName, description, templateType });
    return responseHelper.success(res, template);
  } catch (error) {
    next(error);
  }
};

const getTemplateById = async (req, res, next) => {
  try {
    const { templateId } = req.params;
    const template = await LeaseTemplateService.getTemplateById(templateId);
    if (!template) {
      return responseHelper.error(res, 'Template not found', 404);
    }
    return responseHelper.success(res, template);
  } catch (error) {
    next(error);
  }
};

const getTemplatesByLandlord = async (req, res, next) => {
  try {
    const { createdBy } = req.params;
    if (!createdBy) {
      return responseHelper.error(res, 'createdBy is required', 400);
    }

    const { templateName, templateType, pageNumber, pageSize } = req.query;
    
    const result = await LeaseTemplateService.getTemplatesByCreatedBy(createdBy, {
      templateName,
      templateType,
      pageNumber,
      pageSize
    });

    return responseHelper.success(res, result);
  } catch (error) {
    next(error);
  }
};

const downloadTemplate = async (req, res, next) => {
  try {
    const { templateId } = req.params;
    const file = await LeaseTemplateService.getTemplateFile(templateId);
    const { stream, mimeType, filename, size } = file;

    res.setHeader('Content-Type', mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename || 'file') }"`);
    if (typeof size === 'number') res.setHeader('Content-Length', String(size));

    stream.on('error', (err) => next(err));
    stream.pipe(res);
  } catch (error) {
    const status = error.status || (error.message && error.message.includes('not found') ? 404 : 500);
    return responseHelper.error(res, error.message, status);
  }
};

const updateTemplate = async (req, res, next) => {
  try {
    const { templateId, createdBy } = req.params;
    const { templateName, description, templateType } = req.body || {};

    const template = await LeaseTemplateService.updateTemplate(templateId, createdBy, req.file, { templateName, description, templateType });
    return responseHelper.success(res, template);
  } catch (error) {
    next(error);
  }
};

const deleteTemplate = async (req, res, next) => {
  try {
    const { templateId, createdBy } = req.params;
    const template = await LeaseTemplateService.deleteTemplate(templateId, createdBy);
    return responseHelper.success(res, template);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  addNoteToLease,
  createLease,
  getLeaseById,
  listLeases,
  listLeasesByLandlord,
  updateLease,
  deleteLease,
  uploadDocument,
  terminateLease,
  getLeaseByTenant,
  renewLease,
  exportLeases,
  checkTenureAvailability,
  activateLease,
  approveLease,
  processLeaseLifecycle,
  createTemplate,
  getTemplateById,
  getTemplatesByLandlord,
  downloadTemplate,
  updateTemplate,
  deleteTemplate,
};
