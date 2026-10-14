/**
 * ------------------------------------------------------------------
 * File: invoice.controller.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * invoice.routes
 * ------------------------------------------------------------------
 */

const service = require('../service/invoice.service');
const lateFeeService = require('../service/lateFeeInvoice.service');
const depositRefundService = require('../service/depositRefundInvoice.service');
const logger = require('../../../../../common/logger');

// export helpers are now merged into invoice.service

function getActorId(req) {

  return req.userId || (req.user && (req.user._id || req.user.id)) || null;

}



/**
 * handle Error
 *
 * Performs logic operations for handleError.
 *
 * @param res - Request/input argument
 * @param err - Request/input argument
 * @param next - Request/input argument
 * @returns Operations result
 */
function handleError(res, err, next) {

  if (err && err.name === 'ValidationError') {

    return res.status(400).json({ message: 'Validation failed', errors: err.errors });

  }

  if (err && err.status) {

    return res.status(err.status).json({ message: err.message });

  }

  return next(err);

}



const createInvoice = async (req, res, next) => {
  try {
    // Hydrate propertyId and unit from lease context if missing
    let payload = { ...req.body };
    if ((!payload.propertyId || !payload.unit) && payload.leaseId) {
      try {
        const lease = await service.getLeaseContextForInvoice(payload.leaseId);
        if (lease) {
          if (!payload.propertyId && lease.property_id) payload.propertyId = lease.property_id;
          if (!payload.unitId && lease.unitId) payload.unitId = lease.unitId;
          if (!payload.unit && lease.unitName) payload.unit = lease.unitName;
          if (!payload.term && lease.leaseTerm) payload.term = lease.leaseTerm;
          if ((!Array.isArray(payload.tenants) || payload.tenants.length === 0) && lease.rentAndDepositDestribution?.split?.length > 0) {
            payload.tenants = lease.rentAndDepositDestribution.split.map(s => s.tenantId).filter(Boolean);
          }
        }
      } catch (e) {
        logger.error('Lease hydration error:', e);
      }
    }
    const created = await service.createInvoice(payload, getActorId(req), req.files);
    return res.status(201).json(created);
  } catch (err) {
    return handleError(res, err, next);
  }
};



const getInvoices = async (req, res, next) => {

  try {

    const result = await service.getInvoices(

      service.mergeInvoiceScopeFromActor(req.query || {}, getActorId(req))

    );

    return res.status(200).json(result);

  } catch (err) {

    return next(err);

  }

};



const getInvoiceById = async (req, res, next) => {

  try {

    const invoice = await service.getInvoiceById(req.params.id);

    return res.status(200).json(invoice);

  } catch (err) {

    return handleError(res, err, next);

  }

};



const updateInvoice = async (req, res, next) => {

  try {

    const updated = await service.updateInvoice(req.params.id, req.body, getActorId(req), req.files);
    return res.status(200).json(updated);

  } catch (err) {

    return handleError(res, err, next);

  }

};



const deleteInvoice = async (req, res, next) => {

  try {

    await service.deleteInvoice(req.params.id);

    return res.status(200).json({ message: 'Invoice deleted' });

  } catch (err) {

    return handleError(res, err, next);

  }

};



const getInvoiceStatistics = async (req, res, next) => {

  try {

    const statistics = await service.getInvoiceStatistics(

      service.mergeInvoiceScopeFromActor(req.query || {}, getActorId(req))

    );

    return res.status(200).json(statistics);

  } catch (err) {

    return next(err);

  }

};



const exportInvoicesCsv = async (req, res, next) => {

  try {

    const { filename, csv } = await service.exportInvoicesCsv(

      service.mergeInvoiceScopeFromActor(req.query || {}, getActorId(req))

    );

    res.setHeader('Content-Type', 'text/csv');

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    return res.status(200).send(csv);

  } catch (err) {

    return next(err);

  }

};



const generateAllRentAndDepositInvoices = async (req, res, next) => {

  try {

    const result = await service.generateAllRentAndDepositInvoicesService();

    return res.status(200).json(result);

  } catch (err) {

    return next(err);

  }

};



const generateAllAdditionalFeeInvoices = async (req, res, next) => {

  try {

    const result = await service.generateAllAdditionalFeeInvoicesService();

    return res.status(200).json(result);

  } catch (err) {

    return next(err);

  }

};



const addComment = async (req, res, next) => {

  try {

    const updated = await service.addComment(req.params.id, req.body.text, getActorId(req));
    return res.status(200).json(updated);

  } catch (err) {

    return handleError(res, err, next);

  }

};



const sendInvoiceReminder = async (req, res, next) => {

  try {

    const updated = await service.sendInvoiceReminder(req.params.id);

    return res.status(200).json(updated);

  } catch (err) {

    return handleError(res, err, next);

  }

};



const exportInvoices = async (req, res, next) => {

  try {

    const q = service.mergeInvoiceScopeFromActor(req.query || {}, getActorId(req));

    const format = q.format || 'csv';

    delete q.format;



  const result = await service.exportInvoices(q, format);

    const filename = result && result.filename ? result.filename : `income_export.${format}`;

    const content = result && result.content ? result.content : '';

    const contentType = result && result.contentType ? result.contentType : 'application/octet-stream';



    res.setHeader('Content-Type', contentType);

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    return res.send(content);

  } catch (err) {

    return next(err);

  }

};



/**
 * Generate late fee invoices for all overdue rent invoices
 * Designed to be called by cron job daily
 * POST /api/landlord/invoice/generate-late-fees
 */
const generateAllLateFeeInvoices = async (req, res, next) => {
  try {
    const result = await lateFeeService.generateAllLateFeeInvoices();
    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
};

/**
 * Generate deposit refund invoices for active leases ending in the current month.
 * Designed to be called by cron job (e.g. daily or at month start).
 * POST /api/landlord/invoice/generate-deposit-refunds
 */
const generateDepositRefundInvoices = async (req, res, next) => {
  try {
    const result = await depositRefundService.generateDepositRefundInvoices();
    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
};



/**
 * Generate late fee invoice for a specific overdue rent invoice
 * POST /api/landlord/invoice/:id/generate-late-fee
 */
const generateLateFeeForInvoice = async (req, res, next) => {
  try {
    const result = await lateFeeService.generateLateFeeForInvoice(req.params.id);
    if (!result.success) {
      return res.status(400).json(result);
    }
    return res.status(200).json(result);
  } catch (err) {
    return handleError(res, err, next);
  }
};



module.exports = {

  createInvoice,

  getInvoices,

  getInvoiceById,

  updateInvoice,

  deleteInvoice,

  getInvoiceStatistics,

  exportInvoicesCsv,

  exportInvoices,

  generateAllRentAndDepositInvoices,

  generateAllAdditionalFeeInvoices,

  addComment,

  sendInvoiceReminder,

  generateAllLateFeeInvoices,

  generateLateFeeForInvoice,

  generateDepositRefundInvoices,

};

