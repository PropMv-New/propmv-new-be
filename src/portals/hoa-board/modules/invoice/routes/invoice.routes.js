/**
 * ------------------------------------------------------------------
 * File: invoice.routes.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../../../../../middleware/auth');
const authorize = require('../../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../../middleware/lockCheck');
const csrfProtection = require('../../../../../middleware/csrfProtection');
const { activityLogger, ActivityPatterns } = require('../../../../../middleware/activityLogger');
const controller = require('../controller/invoice.controller');
const { validateQuery, validateParams, validateBody } = require('../../../../../common/middleware/requestValidator');
const { validateMultipart, validateUploadedFiles } = require('../../../../../common/middleware/multipartValidator');
const { createUpload } = require('../../../../../common/helpers/uploadHelper');
const { multerInvoiceDocFilter } = require('../../../../../common/helpers/fileValidationHelper');
const { UPLOAD_INVOICE_SUBDIR } = require('../../../../../common/constants/uploads');
const { getProfile } = require('../../../../../common/constants/uploadFileTypes');
const { HOA_DOCUMENT_MAX_TOTAL_BYTES } = require('../../../../../shared/modules/documents/helpers/hoaDocumentUploadLimits');
const { createInvoiceSchema, updateInvoiceSchema, idParamSchema, listQuerySchema, addCommentSchema, noteIdParamSchema, paymentIdParamSchema, entityNotePayloadSchema, updateEntityNoteSchema, sendReminderSchema, waiveInvoiceSchema, reverseWaiveInvoiceSchema, generateBulkInvoicesSchema, allocationPreviewQuerySchema } = require('../validators/invoice.validator');

const hoaDocumentUploadMaxBytes = Math.min(
  getProfile('INVOICE_DOC').maxSizeBytes,
  HOA_DOCUMENT_MAX_TOTAL_BYTES,
);

// Create multer middleware for temporary file staging
const { uploadArray, tempDir } = createUpload('documents', UPLOAD_INVOICE_SUBDIR, {
  maxCount: 10,
  maxSizeBytes: hoaDocumentUploadMaxBytes,
  fileFilter: multerInvoiceDocFilter
});

const { uploadArray: noteUploadArray } = createUpload('attachments', UPLOAD_INVOICE_SUBDIR, {
  maxCount: 10,
  maxSizeBytes: hoaDocumentUploadMaxBytes,
  fileFilter: multerInvoiceDocFilter,
});

// All endpoints are prefixed by /api/v1/income (mounted automatically)

// Create invoice with multipart/form-data (data field + files)
router.post('/',
  csrfProtection, authMiddleware, authorize, lockCheckMiddleware,
  uploadArray,
  validateMultipart(createInvoiceSchema, { fileFilter: multerInvoiceDocFilter, contentProfile: 'INVOICE_DOC', parseJsonData: true }),
  controller.createInvoice,
  activityLogger(ActivityPatterns.invoiceCreated(
    (req) => req.body.propertyId,
    (req) => req.body.subAmount
  ))
);

// Export invoices as CSV with filters
router.get('/export', authMiddleware, authorize, lockCheckMiddleware, validateQuery(listQuerySchema), controller.exportInvoicesCsv);

// Poll async policy-term invoice generation job status
router.get('/generation/:jobId/status', authMiddleware, authorize, lockCheckMiddleware, controller.getInvoiceGenerationJobStatus);

// Get invoice statistics with filters
router.get('/statistics', authMiddleware, authorize, lockCheckMiddleware, validateQuery(listQuerySchema), controller.getInvoiceStatistics);

// Listing KPI cards: duration/scope aggregates (ignores status / pagination)
router.get('/summary-stats', authMiddleware, authorize, lockCheckMiddleware, validateQuery(listQuerySchema), controller.getInvoiceSummaryStats);

// List invoices (query: propertyId, hoaOwnerId, …; leaseId deprecated - removal 2027-01-01, use propertyId + hoaOwnerIds)
router.get('/', authMiddleware, authorize, lockCheckMiddleware, validateQuery(listQuerySchema), controller.getInvoices);

// Get single invoice
router.get('/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), controller.getInvoiceById);

// Get invoice with payment transactions enriched with Straddle webhook data
router.get('/:id/payment-transactions', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), controller.getInvoicePaymentTransactions);

// Update invoice with multipart/form-data (data field + files)
router.put('/:id',
  csrfProtection, authMiddleware, authorize, lockCheckMiddleware,
  validateParams(idParamSchema),
  uploadArray,
  validateMultipart(updateInvoiceSchema, { fileFilter: multerInvoiceDocFilter, contentProfile: 'INVOICE_DOC', parseJsonData: true }),
  controller.updateInvoice
);

// Delete invoice
router.delete('/:id', 
  csrfProtection,
  authMiddleware, 
  authorize, 
  lockCheckMiddleware, 
  validateParams(idParamSchema), 
  controller.deleteInvoice,
  activityLogger({
    type: 'invoice',
    title: 'Invoice Deleted',
    description: (req) => `Invoice deleted`,
    isHOAActivity: true
  })
);

// Add comment to invoice (legacy)
router.post('/:id/comments', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), validateBody(addCommentSchema), controller.addComment);

function optionalNoteUploadUpdate(req, res, next) {
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) {
    return noteUploadArray(req, res, (err) => {
      if (err) return next(err);
      return validateUploadedFiles({
        fileFilter: multerInvoiceDocFilter,
        contentProfile: 'INVOICE_DOC',
      })(req, res, next);
    });
  }
  return validateBody(updateEntityNoteSchema)(req, res, next);
}

// Structured invoice notes
router.post('/:id/notes', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), noteUploadArray, validateUploadedFiles({ fileFilter: multerInvoiceDocFilter, contentProfile: 'INVOICE_DOC' }), controller.addInvoiceNote);
router.put('/:id/notes/:noteId', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateParams(noteIdParamSchema), optionalNoteUploadUpdate, controller.updateInvoiceNote);
router.delete('/:id/notes/:noteId', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateParams(noteIdParamSchema), controller.deleteInvoiceNote);

router.get('/:id/allocation-preview', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), validateQuery(allocationPreviewQuerySchema), controller.previewInvoicePaymentAllocation);

router.get('/:id/payments/:paymentId/reversal-preview', authMiddleware, authorize, lockCheckMiddleware, validateParams(paymentIdParamSchema), controller.previewInvoicePaymentReversal);

router.delete('/:id/payments/:paymentId', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateParams(paymentIdParamSchema), controller.deleteInvoicePayment);

router.post('/:id/apply-credit', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), controller.applyCreditToInvoice);

// Send payment reminder email
router.post('/:id/send-reminder', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), validateBody(sendReminderSchema), controller.sendReminder);

// Waive outstanding invoice balance
router.post('/:id/waive', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), validateBody(waiveInvoiceSchema), controller.waiveInvoiceBalance);

// Reverse a waived invoice balance
router.post('/:id/unwaive', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), validateBody(reverseWaiveInvoiceSchema), controller.reverseWaiveInvoiceBalance);

// Generate rent and deposit invoices for all active leases
router.post('/generate-rent-deposit',
  csrfProtection, authMiddleware, authorize, lockCheckMiddleware,
  validateBody(generateBulkInvoicesSchema),
  controller.generateAllRentAndDepositInvoices
);

// Generate all additional fee invoices for all active leases
router.post('/generate-additional-fees',
  csrfProtection, authMiddleware, authorize, lockCheckMiddleware,
  validateBody(generateBulkInvoicesSchema),
  controller.generateAllAdditionalFeeInvoices
);

module.exports = router;
