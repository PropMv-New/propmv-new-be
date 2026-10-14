/**
 * ------------------------------------------------------------------
 * File: invoice.controller.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * invoice.routes
 * ------------------------------------------------------------------
 */

const service = require('../service/invoice.service');
const Lease = require('../../leasing/model/lease.model');
const logger = require('../../../../../common/logger');
const { logControllerStep, handleControllerError } = require('../../../../../common/helpers/controllerLogger');
const responseHelper = require('../../../../../common/helpers/responseHelper');
const { LEASE_STATUSES } = require('../../../../../common/constants/lease');
const { ClockService, DateUtil } = require('../../../../../common/date');

const normalizeInvoicePayloadAliases = (payload = {}) => {
  const normalized = { ...payload };
  if (!Array.isArray(normalized.tenants) || normalized.tenants.length === 0) {
    if (Array.isArray(normalized.hoaOwnerIds) && normalized.hoaOwnerIds.length > 0) {
      normalized.tenants = normalized.hoaOwnerIds;
    }
  }
  if (typeof normalized.isAllTenantSelected === 'undefined' && typeof normalized.isAllHoaOwnerSelected === 'boolean') {
    normalized.isAllTenantSelected = normalized.isAllHoaOwnerSelected;
  }
  if (!normalized.createdBy && normalized.hoaBoardMemberId) {
    normalized.createdBy = normalized.hoaBoardMemberId;
  }
  return normalized;
};

const normalizeInvoiceQueryAliases = (query = {}) => {
  const normalized = { ...query };
  // hoaOwnerId is handled separately in the service (property-scope filter)
  // Only map it to ownerId if there is no dedicated hoaOwnerId handling needed
  if (!normalized.ownerId && !normalized.tenantId && normalized.hoaOwnerId) {
    // Keep hoaOwnerId as-is so the service can use it for property-scope filtering
    // normalized.ownerId = normalized.hoaOwnerId; // intentionally NOT mapping
  }
  if (!normalized.createdBy && normalized.hoaBoardMemberId) {
    normalized.createdBy = normalized.hoaBoardMemberId;
  }
  return normalized;
};

const createInvoice = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'createInvoice' });
  try {
    const payload = normalizeInvoicePayloadAliases(req.body);
    const created = await service.createInvoice(payload, req.userId, req.files);
    if (created && created.asyncJob) {
      return res.status(202).json(created);
    }
    return res.status(201).json(created);
  } catch (err) {
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ message: 'Validation failed', errors: err.errors });
    }
    if (err && err.status) {
      return res.status(err.status).json({ message: err.message });
    }
    next(err);
  }
};

const getInvoiceGenerationJobStatus = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'getInvoiceGenerationJobStatus' });
  try {
    const status = await service.getPolicyTermJobStatus(req.params.jobId, req.userId);
    return res.status(200).json(status);
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};

const getInvoices = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'getInvoices' });
  try {
    const query = normalizeInvoiceQueryAliases(req.query);
    const result = await service.getInvoices(query, req.hoaContext || null);
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
};

const getInvoiceById = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'getInvoiceById' });
  try {
    const invoice = await service.getInvoiceById(req.params.id, {
      userId: req.userId || req.user?._id || req.user?.id,
      role: req.user?.role,
      hoaId: req.hoaContext?.hoaId,
    });
    return res.status(200).json(invoice);
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};

const getInvoicePaymentTransactions = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'getInvoicePaymentTransactions' });
  try {
    const invoice = await service.getInvoiceById(req.params.id, {
      userId: req.userId || req.user?._id || req.user?.id,
      role: req.user?.role,
      hoaId: req.hoaContext?.hoaId,
    });
    
    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found' });
    }
    
    const { enrichInvoicePaymentTransactions } = require('../helpers/enrichInvoicePaymentTransactions.helper');
    const paymentTransactions = invoice.paymentTransactions || [];
    const enrichedTransactions = await enrichInvoicePaymentTransactions(
      invoice._id,
      paymentTransactions,
    );

    return res.status(200).json({
      ...invoice,
      paymentTransactions: enrichedTransactions
    });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};

const updateInvoice = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'updateInvoice' });
  try {
    const updates = normalizeInvoicePayloadAliases(req.body);
    const updated = await service.updateInvoice(req.params.id, updates, req.userId, req.files);
    return res.status(200).json(updated);
  } catch (err) {
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ message: 'Validation failed', errors: err.errors });
    }
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};

const deleteInvoice = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'deleteInvoice' });
  try {
    const userId = req.userId || req.user?._id || req.user?.id;
    await service.deleteInvoice(req.params.id, userId);
    return responseHelper.success(res, null, 'Invoice deleted', 200);
  } catch (err) {
    if (err && err.status) {
      const data = err.code
        ? {
            code: err.code,
            ...(err.details && typeof err.details === 'object' ? err.details : {}),
          }
        : (err.details || null);
      return responseHelper.error(res, err.message, err.status, data);
    }
    next(err);
  }
};

const getInvoiceStatistics = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'getInvoiceStatistics' });
  try {
    const query = normalizeInvoiceQueryAliases(req.query);
    const statistics = await service.getInvoiceStatistics(query, req.hoaContext || null);
    return res.status(200).json(statistics);
  } catch (err) {
    next(err);
  }
};

const getInvoiceSummaryStats = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'getInvoiceSummaryStats' });
  try {
    const query = normalizeInvoiceQueryAliases(req.query);
    const summaryStats = await service.getInvoiceSummaryStats(query, req.hoaContext || null);
    return res.status(200).json(summaryStats);
  } catch (err) {
    next(err);
  }
};

const exportInvoicesCsv = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'exportInvoicesCsv' });
  try {
    const query = normalizeInvoiceQueryAliases(req.query);
    const { filename, csv } = await service.exportInvoicesCsv(query, req.hoaContext || null);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    next(err);
  }
};



// API: Generate rent and deposit invoices for all active leases
const generateAllRentAndDepositInvoices = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'generateAllRentAndDepositInvoices' });
  try {
  const activeLeases = await Lease.find({ status: LEASE_STATUSES.ACTIVE });
    const results = [];
    for (const lease of activeLeases) {
      // Use deposit due date from lease if available, else today
      const depositDueDate = lease.depositDetails?.due || new Date();
      const invoices = await service.generateRentAndDepositInvoices(lease._id, depositDueDate);
      results.push({ leaseId: lease._id, invoices });
    }
    return res.status(200).json({ leases: results });
  } catch (err) {
    next(err);
  }
};

// API: Generate all additional fee invoices for all active leases
const generateAllAdditionalFeeInvoices = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'generateAllAdditionalFeeInvoices' });
  try {
  const activeLeases = await Lease.find({ status: LEASE_STATUSES.ACTIVE });
    const results = [];
    for (const lease of activeLeases) {
      const invoices = await service.generateInvoicesFromLease(lease._id);
      results.push({ leaseId: lease._id, invoices });
    }
    return res.status(200).json({ leases: results });
  } catch (err) {
    next(err);
  }
};

const addComment = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'addComment' });
  try {
    const updated = await service.addComment(req.params.id, req.body.text, req.userId);
    return res.status(200).json(updated);
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};

const parseNoteFormBooleans = (body = {}) => {
  const parsed = {
    description: body.description ?? body.text,
    title: body.title,
    reminder: body.reminder,
    removeAttachmentIds: body.removeAttachmentIds,
  };
  if (body.isPinned !== undefined) {
    parsed.isPinned = body.isPinned === 'true' || body.isPinned === true;
  }
  if (body.isImportant !== undefined) {
    parsed.isImportant = body.isImportant === 'true' || body.isImportant === true;
  }
  return parsed;
};

const addInvoiceNote = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'addInvoiceNote' });
  try {
    const files = req.files || [];
    if (files.length > 10) {
      return res.status(400).json({ message: 'Maximum 10 attachments allowed.' });
    }
    const updated = await service.addInvoiceNote(
      req.params.id,
      parseNoteFormBooleans(req.body),
      req.userId,
      files,
    );
    return res.status(201).json(updated);
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};

const updateInvoiceNote = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'updateInvoiceNote' });
  try {
    const files = req.files || [];
    if (files.length > 10) {
      return res.status(400).json({ message: 'Maximum 10 attachments allowed.' });
    }
    const noteData = (req.headers['content-type'] || '').includes('multipart/form-data')
      ? parseNoteFormBooleans(req.body)
      : req.body;
    const updated = await service.updateInvoiceNote(
      req.params.id,
      req.params.noteId,
      noteData,
      req.userId,
      files,
    );
    return res.status(200).json(updated);
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};

const deleteInvoiceNote = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'deleteInvoiceNote' });
  try {
    const updated = await service.deleteInvoiceNote(req.params.id, req.params.noteId, req.userId);
    return res.status(200).json(updated);
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};

const sendReminder = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'sendReminder' });
  try {
    const result = await service.sendPaymentReminder(req.params.id, req.body, req.userId);
    return res.status(200).json({ message: 'Reminder sent successfully', data: result });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};

const waiveInvoiceBalance = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'waiveInvoiceBalance' });
  try {
    const updated = await service.waiveInvoiceBalance(req.params.id, req.body, req.userId);
    return res.status(200).json(updated);
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};

const reverseWaiveInvoiceBalance = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'reverseWaiveInvoiceBalance' });
  try {
    const updated = await service.reverseWaiveInvoiceBalance(req.params.id, req.userId);
    return res.status(200).json(updated);
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};

const deleteInvoicePayment = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'deleteInvoicePayment' });
  try {
    const updated = await service.deleteInvoicePayment(req.params.id, req.params.paymentId, req.userId);
    return res.status(200).json(updated);
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};

const previewInvoicePaymentReversal = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'previewInvoicePaymentReversal' });
  try {
    const preview = await service.previewInvoicePaymentReversal(req.params.id, req.params.paymentId);
    return res.status(200).json(preview);
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};

const previewInvoicePaymentAllocation = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'previewInvoicePaymentAllocation' });
  try {
    const allocateFutureInvoices = typeof req.query.allocateFutureInvoices === 'boolean'
      ? req.query.allocateFutureInvoices
      : undefined;
    const preview = await service.previewInvoicePaymentAllocation(req.params.id, req.query.amount, {
      userId: req.userId || req.user?._id || req.user?.id,
      role: req.user?.role,
      allocateFutureInvoices,
    });
    return res.status(200).json(preview);
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};

const applyCreditToInvoice = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'applyCreditToInvoice' });
  try {
    const updated = await service.applyCreditToInvoice(req.params.id, req.userId);
    return res.status(200).json(updated);
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};

module.exports = {
  createInvoice,
  getInvoiceGenerationJobStatus,
  getInvoices,
  getInvoiceById,
  getInvoicePaymentTransactions,
  updateInvoice,
  deleteInvoice,
  deleteInvoicePayment,
  previewInvoicePaymentReversal,
  previewInvoicePaymentAllocation,
  applyCreditToInvoice,
  getInvoiceStatistics,
  getInvoiceSummaryStats,
  exportInvoicesCsv,
  generateAllRentAndDepositInvoices,
  generateAllAdditionalFeeInvoices,
  addComment,
  addInvoiceNote,
  updateInvoiceNote,
  deleteInvoiceNote,
  sendReminder,
  waiveInvoiceBalance,
  reverseWaiveInvoiceBalance,
};
