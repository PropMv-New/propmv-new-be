/**
 * ------------------------------------------------------------------
 * File: invoice.routes.js
 * Module: Landlord Portal
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * landlord
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../../../../../middleware/auth');
const authorize = require('../../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../../middleware/lockCheck');
const controller = require('../controller/invoice.controller');
const { validateQuery, validateParams, validateBody } = require('../../../../../middleware/requestValidator');
const { validateMultipart } = require('../../../../../middleware/multipartValidator');
const { createUpload } = require('../../../../../common/helpers/uploadHelper');
const { multerInvoiceDocFilter } = require('../../../../../common/helpers/fileValidationHelper');
const { UPLOAD_INVOICE_SUBDIR } = require('../../../../../common/constants/uploads');
const { createInvoiceSchema, updateInvoiceSchema, idParamSchema, listQuerySchema, addCommentSchema, exportQuerySchema } = require('../validators/invoice.validator');

// Create multer middleware for temporary file staging
const { uploadArray, tempDir } = createUpload('documents', UPLOAD_INVOICE_SUBDIR, {
  maxCount: 10,
  maxSizeBytes: 50 * 1024 * 1024, // 50MB
  fileFilter: multerInvoiceDocFilter
});

// All endpoints are prefixed by /api/v1/income (mounted automatically)

// Create invoice with multipart/form-data (data field + files)
router.post('/',
  authMiddleware, authorize, lockCheckMiddleware,
  uploadArray,
  validateMultipart(createInvoiceSchema, { fileFilter: multerInvoiceDocFilter, contentProfile: 'INVOICE_DOC', parseJsonData: true }),
  controller.createInvoice
);

// Export invoices as CSV with filters
router.get('/export', authMiddleware, authorize, lockCheckMiddleware, validateQuery(listQuerySchema), controller.exportInvoicesCsv);

// Export invoices in multiple formats (CSV, Excel, JSON)
router.get('/export-multi', authMiddleware, authorize, lockCheckMiddleware, validateQuery(exportQuerySchema), controller.exportInvoices);

// Get invoice statistics with filters
router.get('/statistics', authMiddleware, authorize, lockCheckMiddleware, validateQuery(listQuerySchema), controller.getInvoiceStatistics);

// List invoices (query: propertyId, createdBy, unit, tenantId, paymentMethod, invoiceId, invoiceType, status, startDate, endDate, sentOn, paidOn, groupBy, pageNumber, pageSize, leaseId, minAmount, maxAmount, isPartialPaymentAllowed)
router.get('/', authMiddleware, authorize, lockCheckMiddleware, validateQuery(listQuerySchema), controller.getInvoices);

// Get single invoice
router.get('/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), controller.getInvoiceById);

// Update invoice with multipart/form-data (data field + files)
router.put('/:id',
  authMiddleware, authorize, lockCheckMiddleware,
  validateParams(idParamSchema),
  uploadArray,
  validateMultipart(updateInvoiceSchema, { fileFilter: multerInvoiceDocFilter, contentProfile: 'INVOICE_DOC', parseJsonData: true }),
  controller.updateInvoice
);

// Delete invoice
router.delete('/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), controller.deleteInvoice);

// Add comment to invoice
router.post('/:id/comments', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), validateBody(addCommentSchema), controller.addComment);

// Send payment reminder for invoice
router.post('/:id/remind', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), controller.sendInvoiceReminder);

// Generate rent and deposit invoices for all active leases
router.post('/generate-rent-deposit',
  authMiddleware, authorize, lockCheckMiddleware,
  controller.generateAllRentAndDepositInvoices
);

// Generate all additional fee invoices for all active leases
router.post('/generate-additional-fees',
  authMiddleware, authorize, lockCheckMiddleware,
  controller.generateAllAdditionalFeeInvoices
);

// Generate late fee invoices for all overdue rent invoices (for cron job)
router.post('/generate-late-fees',
  authMiddleware, authorize, lockCheckMiddleware,
  controller.generateAllLateFeeInvoices
);

// Generate deposit refund invoices for leases ending in the current month (for cron job)
router.post('/generate-deposit-refunds',
  authMiddleware, authorize, lockCheckMiddleware,
  controller.generateDepositRefundInvoices
);

// Generate late fee invoice for a specific overdue rent invoice
router.post('/:id/generate-late-fee',
  authMiddleware, authorize, lockCheckMiddleware,
  validateParams(idParamSchema),
  controller.generateLateFeeForInvoice
);

module.exports = router;
