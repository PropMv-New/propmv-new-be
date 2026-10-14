/**
 * ------------------------------------------------------------------
 * File: lease.controller.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * lease.routes
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const leaseService = require('../service/lease.service');
const { createUpload } = require('../../../../../common/helpers/uploadHelper');
const { UPLOAD_LEASE_SUBDIR } = require('../../../../../common/constants/uploads');
const { multerPdfFilter } = require('../../../../../common/helpers/fileValidationHelper');
const logger = require('../../../../../common/logger');
const { logControllerStep, handleControllerError } = require('../../../../../common/helpers/controllerLogger');

const noteUpload = createUpload('attachments', null, {
  maxCount: 10,
  maxSizeBytes: 20 * 1024 * 1024,
  defaultSubdir: UPLOAD_LEASE_SUBDIR || 'lease-documents',
  allowedExtensions: ['.jpg', '.jpeg', '.png', '.pdf', '.doc', '.docx', '.txt', '.xlsx', '.xls']
});

const { uploadArray } = createUpload('file', null, { maxCount: 10, maxSizeBytes: 10 * 1024 * 1024, defaultSubdir: UPLOAD_LEASE_SUBDIR, fileFilter: multerPdfFilter });

const addNoteToLease = async (req, res) => {
  logControllerStep(req, 'START', { action: 'addNoteToLease' });
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
      const updated = await leaseService.addNoteToLeaseService(leaseId, description, files);
      return res.status(201).json(updated);
    } catch (e) {
      if (req.files) {
        for (const f of req.files) {
          try { require('fs').unlinkSync(f.path); } catch (ignore) {}
        }
      }
      const status = e.status || 500;
      res.status(status).json({ message: e.message });
    }
  });
};

const createLease = async (req, res) => {
  logControllerStep(req, 'START', { action: 'createLease' });
  try {
    logger.info('Creating HOA lease', { userId: req.user?._id });
    const leaseData = req.body || {};
    // Normalize includeDamageReport if sent as string/checkbox
    if (typeof leaseData.includeDamageReport !== 'boolean') {
      const v = leaseData.includeDamageReport;
      leaseData.includeDamageReport = (v === true || v === 'true' || v === '1' || v === 1 || v === 'on');
    }
    const saved = await leaseService.createLeaseService(leaseData);
    logger.info('HOA lease created successfully', { leaseId: saved._id });
    return res.status(201).json(saved);
  } catch (err) {
    logger.error('Failed to create HOA lease', { error: err.message, userId: req.user?._id });
    const status = err.status || 500;
    return res.status(status).json({ message: err.message });
  }
};

const getLeaseById = async (req, res) => {
  logControllerStep(req, 'START', { action: 'getLeaseById' });
  try {
    const id = req.params && req.params.id;
    logger.debug('Fetching HOA lease by ID', { leaseId: id, userId: req.user?._id });
    const lease = await leaseService.getLeaseByIdService(id);
    res.json(lease);
  } catch (err) {
    logger.error('Failed to fetch HOA lease', { leaseId: req.params?.id, error: err.message });
    const status = err.status || 500;
    res.status(status).json({ message: err.message });
  }
};

const listLeases = async (req, res) => {
  logControllerStep(req, 'START', { action: 'listLeases' });
  try {
    const q = Object.assign({}, req.query || {});
    const data = await leaseService.listLeasesService(q);
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const listLeasesByLandlord = async (req, res) => {
  logControllerStep(req, 'START', { action: 'listLeasesByLandlord' });
  try {
    const { landlordId, status, propertyId, from, to } = req.query || {};
  // Prefer `pageNumber` query param; fall back to `page` for backward compatibility
  const rawPageNumber = typeof req.query.pageNumber !== 'undefined' ? req.query.pageNumber : req.query.page;
  const rawPageSize = req.query.pageSize;
  const parsedPageNumber = rawPageNumber ? parseInt(rawPageNumber, 10) : undefined;
  const parsedPageSize = rawPageSize ? parseInt(rawPageSize, 10) : undefined;
  const data = await leaseService.listLeasesByLandlordService({ landlordId, status, propertyId, from, to, pageNumber: parsedPageNumber, pageSize: parsedPageSize });
    return res.json(data);
  } catch (err) {
    const statusCode = err.status || 500;
    return res.status(statusCode).json({ message: err.message });
  }
};

const updateLease = async (req, res) => {
  logControllerStep(req, 'START', { action: 'updateLease' });
  try {
    const leaseId = req.params && req.params.id;
    logger.info('Updating HOA lease', { leaseId, userId: req.user?._id });
    const leaseData = req.body || {};
    if (typeof leaseData.includeDamageReport !== 'boolean') {
      const v = leaseData.includeDamageReport;
      leaseData.includeDamageReport = (v === true || v === 'true' || v === '1' || v === 1 || v === 'on');
    }
    const updated = await leaseService.updateLeaseService(leaseId, leaseData);
    logger.info('HOA lease updated successfully', { leaseId });
    res.json(updated);
  } catch (err) {
    logger.error('Failed to update HOA lease', { leaseId: req.params?.id, error: err.message });
    const status = err.status || 500;
    res.status(status).json({ message: err.message });
  }
};

const deleteLease = async (req, res) => {
  logControllerStep(req, 'START', { action: 'deleteLease' });
  try {
    const leaseId = req.params && req.params.id;
    await leaseService.deleteLeaseService(leaseId);
    res.json({ message: 'Lease deleted successfully' });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ message: err.message });
  }
};

const uploadDocument = async (req, res) => {
  logControllerStep(req, 'START', { action: 'uploadDocument' });
  const leaseId = req.params && req.params.id;
  uploadArray(req, res, async function (err) {
    if (err) return res.status(400).json({ message: err.message || 'Upload failed' });

    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ message: 'No files uploaded' });
    }

    try {
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
      const status = e.status || 500;
      return res.status(status).json({ message: e.message || 'Failed to upload documents' });
    }
  });
};

const terminateLease = async (req, res) => {
  logControllerStep(req, 'START', { action: 'terminateLease' });
  try {
    const { id } = req.params;
    const terminatedLease = await leaseService.terminateLeaseService(id);
    return res.status(200).json({
      message: 'Lease terminated successfully',
      statusCode: 200,
      data: terminatedLease
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ message: err.message });
  }
};

const getLeaseByTenant = async (req, res) => {
  logControllerStep(req, 'START', { action: 'getLeaseByTenant' });
  try {
    const { tenantId, propertyId, unit } = req.query;
    const lease = await leaseService.getLeaseByTenantService({ tenantId, propertyId, unit });
    res.json(lease);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ message: err.message });
  }
};

const renewLease = async (req, res) => {
  logControllerStep(req, 'START', { action: 'renewLease' });
  try {
    const leaseId = req.params && req.params.id;
    const { type, ...leaseData } = req.body;
    logger.info('Renewing HOA lease', { leaseId, renewType: type, userId: req.user?._id });
    
    let result;
    if (type === 'Renew And Extend') {
      result = await leaseService.updateLeaseService(leaseId, leaseData);
    } else if (type === 'Renew With New Lease') {
      result = await leaseService.createLeaseService(leaseData);
    }
    
    logger.info('HOA lease renewed successfully', { leaseId, renewType: type });
    res.json(result);
  } catch (err) {
    logger.error('Failed to renew HOA lease', { leaseId: req.params?.id, error: err.message });
    const status = err.status || 500;
    res.status(status).json({ message: err.message });
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
  renewLease
};
