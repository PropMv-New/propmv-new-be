/**
 * ------------------------------------------------------------------
 * File: email.controller.js
 * Module: Email Module
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * email.routes
 * ------------------------------------------------------------------
 */

const emailService = require('../service/email.service');
const logger = require('../../../../common/logger');
const { connectToDatabase } = require('../../../../database');
const { createUpload } = require('../../../../common/helpers/uploadHelper');
const { UPLOAD_EMAIL_SUBDIR } = require('../../../../common/constants/uploads');
const { EMAIL_STATUS } = require('../../../../common/constants/emailStatus');
const { multerNoteAttachmentFilter } = require('../../../../common/helpers/fileValidationHelper');
const { ClockService } = require('../../../../common/date');

function resolveRequestHoaId(req) {
  const raw =
    req.hoaContext?.hoaId ||
    req.headers?.['x-hoa-id'] ||
    req.query?.hoaId ||
    null;
  const hoaId = raw ? String(raw).trim() : '';
  return hoaId || null;
}

const listEmails = async (req, res) => {
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;
    const maxResults = parseInt(req.query.maxResults) || 50;
    const pageToken = req.query.pageToken || null;
    
    const result = await emailService.listEmails(userId, maxResults, pageToken);
    res.json({ 
      message: 'Emails fetched successfully',
      statuscode: 200,
      data: {
        count: result.emails.length,
        emails: result.emails,
        nextPageToken: result.nextPageToken
      }
    });
  } catch (err) {
    logger.error('List emails error:', err);
    
    if (err.message.includes('No email provider configured') || err.message.includes('IMAP configuration not found')) {
      return res.status(403).json({ 
        message: err.message,
        statuscode: 403,
        needsAuth: true 
      });
    }
    
    res.status(500).json({ 
      message: err.message || 'Failed to fetch emails',
      statuscode: 500
    });
  }
};

const listSentEmails = async (req, res) => {
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;
    const maxResults = parseInt(req.query.maxResults) || 50;
    const pageToken = req.query.pageToken || null;
    const hoaId = resolveRequestHoaId(req);
    
    const result = await emailService.listSentEmails(userId, maxResults, pageToken, hoaId);
    res.json({ 
      message: 'Sent emails fetched successfully',
      statuscode: 200,
      data: {
        count: result.emails.length,
        emails: result.emails,
        nextPageToken: result.nextPageToken
      }
    });
  } catch (err) {
    logger.error('List sent emails error:', err);
    
    if (err.message.includes('No email provider configured') || err.message.includes('IMAP configuration not found')) {
      return res.status(403).json({ 
        message: err.message,
        statuscode: 403,
        needsAuth: true 
      });
    }
    
    res.status(500).json({ 
      message: err.message || 'Failed to fetch sent emails',
      statuscode: 500
    });
  }
};

const revokeAccess = async (req, res) => {
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;
    const result = await gmailService.revokeAccess(userId);
    res.json(result);
  } catch (err) {
    logger.error('Revoke access error:', err);
    res.status(500).json({ message: err.message || 'Failed to revoke access' });
  }
};

const checkAccess = async (req, res) => {
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;
    const result = await emailService.checkAccess(userId);
    res.json({ 
      message: 'Email access checked successfully',
      statuscode: 200,
      data: result
    });
  } catch (err) {
    logger.error('Check access error:', err);
    res.status(500).json({ 
      message: err.message || 'Failed to check access',
      statuscode: 500
    });
  }
};

const getGmailUrl = async (req, res) => {
  try {
    const { messageId } = req.params;
    const gmailUrl = gmailService.getGmailUrl(messageId);
    res.json({ 
      message: 'Gmail URL generated',
      statuscode: 200,
      data: { gmailUrl }
    });
  } catch (err) {
    logger.error('Get Gmail URL error:', err);
    res.status(500).json({ 
      message: err.message || 'Failed to generate Gmail URL',
      statuscode: 500
    });
  }
};

const sendEmail = async (req, res) => {
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;
    const { to, subject, body, cc, bcc, attachments: rawAttachments } = req.body;
    const files = req.files || [];
    
    // Handle two scenarios:
    // 1. Files uploaded with the request (req.files)
    // 2. Pre-uploaded attachments (attachments metadata in body)
    let attachmentMetadata = [];
    
    let parsedAttachments = rawAttachments;
    if (typeof parsedAttachments === 'string') {
      try {
        parsedAttachments = JSON.parse(parsedAttachments);
      } catch {
        parsedAttachments = [];
      }
    }

    if (parsedAttachments && Array.isArray(parsedAttachments) && parsedAttachments.length > 0) {
      attachmentMetadata = parsedAttachments
        .map((att) => {
          if (!att || typeof att !== 'object') return null;
          const documentMetadataId =
            att.documentMetadataId?._id ||
            att.documentMetadataId?.id ||
            att.documentMetadataId ||
            att.id ||
            null;
          if (!documentMetadataId) return null;
          return {
            documentMetadataId: String(documentMetadataId),
            filename: att.filename || att.originalName || 'attachment',
            originalName: att.originalName || att.filename || 'attachment',
            size: att.size || 0,
            mimetype: att.mimetype || att.contentType || 'application/octet-stream',
            uploadedAt: att.uploadedAt || ClockService.now(),
          };
        })
        .filter(Boolean);
    }
    
    const result = await emailService.sendEmail(
      userId,
      { to, subject, body, cc, bcc },
      files,
      attachmentMetadata,
      resolveRequestHoaId(req)
    );
    res.json({ 
      message: 'Email sent successfully',
      statuscode: 200,
      data: result
    });
  } catch (err) {
    logger.error('Send email error:', err);
    
    if (err.message.includes('No email provider configured') || err.message.includes('SMTP configuration not found')) {
      return res.status(403).json({ 
        message: err.message,
        statuscode: 403,
        needsAuth: true 
      });
    }
    
    res.status(500).json({ 
      message: err.message || 'Failed to send email',
      statuscode: 500
    });
  }
};

const markAsRead = async (req, res) => {
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;
    const { emailId } = req.params;
    
    const result = await emailService.markAsRead(userId, emailId);
    res.json({ 
      message: 'Email marked as read',
      statuscode: 200,
      data: result
    });
  } catch (err) {
    logger.error('Mark as read error:', err);
    res.status(500).json({ 
      message: err.message || 'Failed to mark email as read',
      statuscode: 500
    });
  }
};

const getEmailDetail = async (req, res) => {
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;
    const { emailId } = req.params;
    
    const result = await emailService.getEmailDetail(userId, emailId, resolveRequestHoaId(req));
    res.json({ 
      message: 'Email detail fetched successfully',
      statuscode: 200,
      data: result
    });
  } catch (err) {
    logger.error('Get email detail error:', err);
    res.status(404).json({ 
      message: err.message || 'Email not found',
      statuscode: 404
    });
  }
};

const saveDraft = async (req, res) => {
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;
    const draftData = req.body;
    const files = req.files || [];
    
    const result = await emailService.saveDraft(userId, draftData, files, resolveRequestHoaId(req));
    res.json({ 
      message: 'Draft saved successfully',
      statuscode: 200,
      data: result
    });
  } catch (err) {
    logger.error('Save draft error:', err);
    res.status(500).json({ 
      message: err.message || 'Failed to save draft',
      statuscode: 500
    });
  }
};

const listDrafts = async (req, res) => {
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;
    
    const result = await emailService.listDrafts(userId, resolveRequestHoaId(req));
    res.json({ 
      message: 'Drafts fetched successfully',
      statuscode: 200,
      data: result
    });
  } catch (err) {
    logger.error('List drafts error:', err);
    res.status(500).json({ 
      message: err.message || 'Failed to fetch drafts',
      statuscode: 500
    });
  }
};

const deleteDraft = async (req, res) => {
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;
    const { draftId } = req.params;
    
    const result = await emailService.deleteDraft(userId, draftId);
    res.json({ 
      message: 'Draft deleted successfully',
      statuscode: 200,
      data: result
    });
  } catch (err) {
    logger.error('Delete draft error:', err);
    res.status(500).json({ 
      message: err.message || 'Failed to delete draft',
      statuscode: 500
    });
  }
};

const discardDraft = async (req, res) => {
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;
    const { draftId } = req.params;
    
    const result = await emailService.discardDraft(userId, draftId);
    res.json({ 
      message: 'Draft discarded successfully',
      statuscode: 200,
      data: result
    });
  } catch (err) {
    logger.error('Discard draft error:', err);
    res.status(500).json({ 
      message: 'Error',
      statuscode: 500,
      data: {
        message: `Failed to discard draft: ${err.message}`,
        statuscode: 500
      }
    });
  }
};

const bulkDiscardDrafts = async (req, res) => {
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;
    const { draftIds } = req.body;
    
    if (!draftIds || !Array.isArray(draftIds) || draftIds.length === 0) {
      return res.status(400).json({ 
        message: 'draftIds array is required',
        statuscode: 400
      });
    }
    
    const result = await emailService.bulkDiscardDrafts(userId, draftIds);
    res.json({ 
      message: 'Drafts discarded successfully',
      statuscode: 200,
      data: result
    });
  } catch (err) {
    logger.error('Bulk discard drafts error:', err);
    res.status(500).json({ 
      message: 'Error',
      statuscode: 500,
      data: {
        message: `Failed to discard drafts: ${err.message}`,
        statuscode: 500
      }
    });
  }
};

const sendDraft = async (req, res) => {
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;
    const { draftId } = req.params;
    
    const result = await emailService.sendDraft(userId, draftId);
    res.json({ 
      message: 'Draft sent successfully',
      statuscode: 200,
      data: result
    });
  } catch (err) {
    logger.error('Send draft error:', err);
    res.status(500).json({ 
      message: err.message || 'Failed to send draft',
      statuscode: 500
    });
  }
};

const listFailedEmails = async (req, res) => {
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;
    
    const result = await emailService.listFailedEmails(userId, resolveRequestHoaId(req));
    res.json({ 
      message: 'Failed emails fetched successfully',
      statuscode: 200,
      data: result
    });
  } catch (err) {
    logger.error('List failed emails error:', err);
    res.status(500).json({ 
      message: err.message || 'Failed to fetch failed emails',
      statuscode: 500
    });
  }
};

const uploadAttachment = async (req, res) => {
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;
    
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ 
        message: 'No files uploaded',
        statuscode: 400
      });
    }

    // Use DocumentManager to upload files
    const DocumentManager = require('../../documents/service/documentManager');
    const documentManager = new DocumentManager();
    
    const uploadedDocs = await documentManager.uploadAndCreateMetadata(req.files, {
      documentType: 'email-attachments',
      ownerId: userId,
      userId,
    });

    const attachments = uploadedDocs.map(doc => ({
      documentMetadataId: String(doc._id),
      filename: doc.key,
      originalName: doc.originalName,
      size: doc.size,
      mimetype: doc.contentType,
      uploadedAt: ClockService.now(),
    }));

    res.json({ 
      message: 'Attachments uploaded successfully',
      statuscode: 200,
      data: { attachments }
    });
  } catch (err) {
    logger.error('Upload attachment error:', err);
    res.status(500).json({ 
      message: err.message || 'Failed to upload attachments',
      statuscode: 500
    });
  }
};

const downloadAttachment = async (req, res) => {
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;
    const { emailId, attachmentId } = req.params;
    
    // Verify email belongs to user
    const Email = require('../model/email.model');
    const email = await Email.findOne({ _id: emailId, userId, isDeleted: { $ne: true } });
    if (!email) {
      return res.status(404).json({ 
        message: 'Email not found',
        statuscode: 404
      });
    }

    // Find attachment in email
    const attachment = email.attachments.find(att => att.documentMetadataId.toString() === attachmentId);
    if (!attachment) {
      return res.status(404).json({ 
        message: 'Attachment not found',
        statuscode: 404
      });
    }

    // Use DocumentManager to get file stream
    const DocumentManager = require('../../documents/service/documentManager');
    const documentManager = new DocumentManager();
    
    const { stream, fileName, contentType } = await documentManager.getStreamByMetadataId(attachmentId);
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    stream.pipe(res);
  } catch (err) {
    logger.error('Download attachment error:', err);
    res.status(500).json({ 
      message: err.message || 'Failed to download attachment',
      statuscode: 500
    });
  }
};

const deleteAttachment = async (req, res) => {
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;
    const { emailId, attachmentId } = req.params;
    
    // Verify email belongs to user and is a draft
    const Email = require('../model/email.model');
    const email = await Email.findOne({ _id: emailId, userId, status: EMAIL_STATUS.DRAFT, isDeleted: { $ne: true } });
    if (!email) {
      return res.status(404).json({ 
        message: 'Draft email not found',
        statuscode: 404
      });
    }

    // Find and remove attachment from email
    const attachmentIndex = email.attachments.findIndex(att => att.documentMetadataId.toString() === attachmentId);
    if (attachmentIndex === -1) {
      return res.status(404).json({ 
        message: 'Attachment not found',
        statuscode: 404
      });
    }

    email.attachments.splice(attachmentIndex, 1);
    await email.save();

    // Delete document metadata (best effort)
    try {
      const DocumentManager = require('../../documents/service/documentManager');
      const documentManager = new DocumentManager();
      await documentManager.deleteMetadata(attachmentId);
    } catch (deleteErr) {
      logger.warn('Failed to delete document metadata:', deleteErr.message);
    }

    res.json({ 
      message: 'Attachment deleted successfully',
      statuscode: 200,
      data: { success: true }
    });
  } catch (err) {
    logger.error('Delete attachment error:', err);
    res.status(500).json({ 
      message: err.message || 'Failed to delete attachment',
      statuscode: 500
    });
  }
};

module.exports = {
  listEmails,
  listSentEmails,
  checkAccess,
  sendEmail,
  markAsRead,
  getEmailDetail,
  saveDraft,
  listDrafts,
  deleteDraft,
  discardDraft,
  bulkDiscardDrafts,
  sendDraft,
  listFailedEmails,
  uploadAttachment,
  downloadAttachment,
  deleteAttachment,
  emailUploadMiddleware: createUpload('attachments', UPLOAD_EMAIL_SUBDIR, { 
    maxCount: 10,
    maxSizeBytes: 25 * 1024 * 1024,
    fileFilter: multerNoteAttachmentFilter,
  }).uploadArray
};
