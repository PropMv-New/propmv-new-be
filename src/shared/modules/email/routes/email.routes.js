/**
 * ------------------------------------------------------------------
 * File: email.routes.js
 * Module: Email Module
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * hoa-board, landlord
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const emailController = require('../controller/email.controller');
const emailContactsController = require('../controller/emailContacts.controller');
const smtpConfigController = require('../controller/smtpConfig.controller');
const authMiddleware = require('../../../../middleware/auth');
const { hoaDataIsolation } = require('../../../../middleware/hoaDataIsolation');
const csrfProtection = require('../../../../middleware/csrfProtection');
const authorize = require('../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../middleware/lockCheck');
const { validateQuery, validateBody } = require('../../../../middleware/requestValidator');
const { validateUploadedFiles } = require('../../../../middleware/multipartValidator');
const { multerNoteAttachmentFilter } = require('../../../../common/helpers/fileValidationHelper');
const { listEmailsSchema, sendEmailSchema, configureSmtpSchema } = require('../validators/email.validator');

// GET /api/v1/email/list - List all emails from IMAP
router.get('/list', authMiddleware, authorize, lockCheckMiddleware, validateQuery(listEmailsSchema), emailController.listEmails);

// GET /api/v1/email/sent - List sent emails
router.get('/sent', authMiddleware, authorize, lockCheckMiddleware, validateQuery(listEmailsSchema), emailController.listSentEmails);

// POST /api/v1/email/send - Send email via SMTP
router.post('/send', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, emailController.emailUploadMiddleware, validateUploadedFiles({ fileFilter: multerNoteAttachmentFilter, contentProfile: 'NOTE_ATTACHMENT' }), validateBody(sendEmailSchema), emailController.sendEmail);

// GET /api/v1/email/contacts - Get email contacts (tenants/landlord)
router.get('/contacts', authMiddleware, hoaDataIsolation, authorize, lockCheckMiddleware, emailContactsController.getEmailContacts);

// GET /api/v1/email/check-access - Check if user has configured SMTP/IMAP
router.get('/check-access', authMiddleware, authorize, lockCheckMiddleware, emailController.checkAccess);

// POST /api/v1/email/mark-read/:emailId - Mark email as read
router.post('/mark-read/:emailId', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, emailController.markAsRead);

// GET /api/v1/email/:emailId - Get email detail
router.get('/:emailId', authMiddleware, authorize, lockCheckMiddleware, emailController.getEmailDetail);

// Draft Email Routes
// POST /api/v1/email/draft/save - Save draft email
router.post('/draft/save', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, emailController.emailUploadMiddleware, validateUploadedFiles({ fileFilter: multerNoteAttachmentFilter, contentProfile: 'NOTE_ATTACHMENT' }), emailController.saveDraft);

// GET /api/v1/email/draft/list - List draft emails
router.get('/draft/list', authMiddleware, authorize, lockCheckMiddleware, emailController.listDrafts);

// GET /api/v1/email/failed/list - List failed emails
router.get('/failed/list', authMiddleware, authorize, lockCheckMiddleware, emailController.listFailedEmails);

// DELETE /api/v1/email/draft/:draftId - Delete draft email
router.delete('/draft/:draftId', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, emailController.deleteDraft);

// POST /api/v1/email/draft/bulk-discard - Bulk soft-delete sent/draft/failed emails
// IMPORTANT: declare before `/draft/:draftId/...` so "bulk-discard" is not treated as an id
router.post('/draft/bulk-discard', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, emailController.bulkDiscardDrafts);

// POST /api/v1/email/draft/:draftId/discard - Soft-delete one email (sent/draft/failed)
router.post('/draft/:draftId/discard', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, emailController.discardDraft);

// POST /api/v1/email/draft/:draftId/send - Send draft email
router.post('/draft/:draftId/send', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, emailController.sendDraft);

// POST /api/v1/email/upload-attachments - Upload email attachments
router.post('/upload-attachments', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, emailController.emailUploadMiddleware, validateUploadedFiles({ fileFilter: multerNoteAttachmentFilter, contentProfile: 'NOTE_ATTACHMENT' }), emailController.uploadAttachment);

// GET /api/v1/email/:emailId/attachment/:attachmentId/download - Download email attachment
router.get('/:emailId/attachment/:attachmentId/download', authMiddleware, authorize, lockCheckMiddleware, emailController.downloadAttachment);

// DELETE /api/v1/email/:emailId/attachment/:attachmentId - Delete email attachment from draft
router.delete('/:emailId/attachment/:attachmentId', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, emailController.deleteAttachment);

// SMTP Configuration Routes
// POST /api/v1/email/smtp/test - Test SMTP settings without saving
router.post('/smtp/test', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, smtpConfigController.testSmtp);

// POST /api/v1/email/smtp/configure - Configure SMTP settings (auto-detects if host/port not provided)
router.post('/smtp/configure', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateBody(configureSmtpSchema), smtpConfigController.configureSmtp);

// GET /api/v1/email/smtp/config - Get SMTP configuration
router.get('/smtp/config', authMiddleware, authorize, lockCheckMiddleware, smtpConfigController.getSmtpConfig);

// DELETE /api/v1/email/smtp/config - Delete SMTP configuration
router.delete('/smtp/config', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, smtpConfigController.deleteSmtpConfig);

module.exports = router;
