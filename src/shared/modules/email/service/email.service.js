/**
 * ------------------------------------------------------------------
 * File: email.service.js
 * Module: Email Module
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * email.controller
 * ------------------------------------------------------------------
 */
const smtpService = require('./smtp.service');
const imapService = require('./imap.service');
const EmailConfig = require('../model/emailConfig.model');
const { sendEmail: sendEmailHelper } = require('../../../../common/helpers/emailHelper');
const Email = require('../model/email.model');
const User = require('../../users/models/user.model');
const DocumentManager = require('../../documents/service/documentManager');
const documentManager = new DocumentManager();
const { EMAIL_STATUS, DELETABLE_STATUSES } = require('../../../../common/constants/emailStatus');
const { EMAIL_ORIGIN } = require('../../../../common/constants/emailOrigin');
const mongoose = require('mongoose');
const logger = require('../../../../common/logger');
const { ClockService } = require('../../../../common/date');
const { encryptEmailField, decryptEmailField } = require('../../../../common/helpers/cryptoHelper');
const { toObjectId } = require('../../../../common/db/mongooseHelpers');
const { buildPrivateRecipientPayload } = require('../utils/privateRecipientPayload');
const contactsService = require('../../../../common/services/contacts.service');

/**
 * to Object Ids
 *
 * Performs logic operations for toObjectIds.
 *
 * @param ids - Request/input argument
 * @returns Operations result
 */
function toObjectIds(ids = []) {
  const out = [];
  for (const raw of ids) {
    const id = String(raw || '').trim();
    if (!id || !mongoose.Types.ObjectId.isValid(id)) continue;
    out.push(new mongoose.Types.ObjectId(id));
  }
  return out;
}

/**
 * user Id Match Filter
 *
 * Performs logic operations for userIdMatchFilter.
 *
 * @param userId - Request/input argument
 * @returns Operations result
 */
function userIdMatchFilter(userId) {
  const uid = String(userId || '').trim();
  if (uid && mongoose.Types.ObjectId.isValid(uid)) {
    return { $or: [{ userId: new mongoose.Types.ObjectId(uid) }, { userId: uid }] };
  }
  return { userId: uid };
}

function normalizeHoaObjectId(hoaId) {
  const id = String(hoaId || '').trim();
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
  return new mongoose.Types.ObjectId(id);
}

/** When an HOA community is active, only return that community's outbound emails. */
function communityEmailFilter(hoaId) {
  const oid = normalizeHoaObjectId(hoaId);
  if (!oid) return {};
  return { hoaId: oid };
}

/** Email-tab lists should not include system/audit rows logged by emailHelper. */
function userGeneratedEmailFilter(userId, hoaId = null) {
  return {
    ...userIdMatchFilter(userId),
    ...communityEmailFilter(hoaId),
    origin: { $ne: EMAIL_ORIGIN.SYSTEM },
    isDeleted: { $ne: true },
  };
}

function normalizeAttachmentMetadata(list = []) {
  return (list || [])
    .map((att) => {
      if (!att || typeof att !== 'object') return null;
      const rawId =
        att.documentMetadataId?._id ||
        att.documentMetadataId?.id ||
        att.documentMetadataId ||
        att.id ||
        null;
      const id = String(rawId || '').trim();
      if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
      return {
        documentMetadataId: new mongoose.Types.ObjectId(id),
        filename: att.filename || att.originalName || 'attachment',
        originalName: att.originalName || att.filename || 'attachment',
        size: Number(att.size) || 0,
        mimetype: att.mimetype || att.contentType || 'application/octet-stream',
        uploadedAt: att.uploadedAt ? new Date(att.uploadedAt) : new Date(),
      };
    })
    .filter(Boolean);
}

async function resolveSenderEnvelopeAddress(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return process.env.FROM_EMAIL || null;
  try {
    const [user, smtpConfig] = await Promise.all([
      User.findById(uid).select('email').lean(),
      EmailConfig.findOne({ userId: uid, provider: 'smtp', isActive: true }).select('smtpUser').lean(),
    ]);
    return (
      String(user?.email || '').trim() ||
      String(smtpConfig?.smtpUser || '').trim() ||
      process.env.FROM_EMAIL ||
      null
    );
  } catch {
    return process.env.FROM_EMAIL || null;
  }
}

/**
 * EmailService
 *
 * Represents the Email Service controller/model class.
 */
class EmailService {
  async getActiveProvider(userId) {
    const uid = toObjectId(userId);
    if (!uid) return null;
    const smtpConfig = await EmailConfig.findOne({ userId: uid, provider: 'smtp', isActive: true });
    return smtpConfig ? 'smtp' : null;
  }

  // Helper method to convert plain text to HTML preserving formatting
  _convertTextToHtml(text) {
    if (!text) return '';

    // Check if text is already HTML (contains HTML tags)
    const hasHtmlTags = /<[a-z][\s\S]*>/i.test(text);
    if (hasHtmlTags) {
      return text; // Already HTML, return as is
    }

    // Convert plain text to HTML preserving line breaks and spaces
    return text
      .replace(/&/g, '&amp;')           // Escape ampersands
      .replace(/</g, '&lt;')            // Escape less than
      .replace(/>/g, '&gt;')            // Escape greater than
      .replace(/"/g, '&quot;')          // Escape quotes
      .replace(/'/g, '&#039;')          // Escape single quotes
      .replace(/\n/g, '<br>')           // Convert line breaks to <br>
      .replace(/  /g, '&nbsp;&nbsp;')   // Convert double spaces to non-breaking spaces
      .replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;'); // Convert tabs to spaces
  }

  // Helper method to convert HTML back to plain text
  _convertHtmlToText(html) {
    if (!html) return '';

    return html
      .replace(/<br\s*\/?>/gi, '\n')    // Convert <br> to line breaks
      .replace(/<\/p>/gi, '\n\n')       // Convert </p> to double line breaks
      .replace(/<[^>]+>/g, '')          // Remove all HTML tags
      .replace(/&nbsp;/g, ' ')          // Convert &nbsp; to spaces
      .replace(/&amp;/g, '&')           // Unescape ampersands
      .replace(/&lt;/g, '<')            // Unescape less than
      .replace(/&gt;/g, '>')            // Unescape greater than
      .replace(/&quot;/g, '"')          // Unescape quotes
      .replace(/&#039;/g, "'")          // Unescape single quotes
      .trim();
  }

  async sendEmail(userId, emailData, files = [], preUploadedAttachments = [], hoaId = null) {
    let attachmentMetadata = [];
    if (files && files.length > 0) {
      const uploadedDocs = await documentManager.uploadAndCreateMetadata(files, {
        documentType: 'email',
        userId: userId,
      });
      attachmentMetadata = uploadedDocs.map(doc => ({
        documentMetadataId: doc._id,
        filename: doc.key,
        originalName: doc.originalName,
        size: doc.size,
        mimetype: doc.contentType,
        uploadedAt: ClockService.now(),
      }));
    }

    if (preUploadedAttachments && preUploadedAttachments.length > 0) {
      attachmentMetadata = [
        ...attachmentMetadata,
        ...normalizeAttachmentMetadata(preUploadedAttachments),
      ];
    } else {
      attachmentMetadata = normalizeAttachmentMetadata(attachmentMetadata);
    }

    const { to, subject, body, cc, bcc } = emailData;
    const hoaObjectId = normalizeHoaObjectId(hoaId);
    const contactsOptions = {
      contactPurpose: 'email',
      isHOA: true,
      ...(hoaObjectId ? { hoaId: String(hoaObjectId) } : {}),
    };
    await contactsService.assertCanEmailRecipients(userId, to, contactsOptions);
    if (cc) await contactsService.assertCanEmailRecipients(userId, cc, contactsOptions);
    if (bcc) await contactsService.assertCanEmailRecipients(userId, bcc, contactsOptions);

    const htmlBody = this._convertTextToHtml(body);

    // Persist immediately so the API can return quickly while SMTP runs
    const email = new Email({
      userId,
      ...(hoaObjectId ? { hoaId: hoaObjectId } : {}),
      origin: EMAIL_ORIGIN.USER,
      to: encryptEmailField(to),
      subject: encryptEmailField(subject),
      body: encryptEmailField(htmlBody),
      cc: encryptEmailField(cc),
      bcc: encryptEmailField(bcc),
      status: EMAIL_STATUS.SENDING,
      attachments: attachmentMetadata,
    });
    await email.save();

    let nodemailerAttachments = [];
    try {
      nodemailerAttachments = await this._prepareAttachmentsForSending(attachmentMetadata);
    } catch (prepError) {
      await Email.updateOne(
        { _id: email._id },
        { $set: { status: EMAIL_STATUS.FAILED, errorMessage: prepError.message } }
      );
      throw new Error('Failed to prepare attachments: ' + prepError.message);
    }

    return this._deliverQueuedEmail({
      emailId: email._id,
      userId,
      mailPayload: {
        to,
        subject,
        html: htmlBody,
        text: this._convertHtmlToText(htmlBody),
        cc,
        bcc,
        attachments: nodemailerAttachments,
        origin: EMAIL_ORIGIN.USER,
        userId,
        emailId: email._id,
        hoaId: hoaObjectId || undefined,
        senderUserId: userId,
      },
      htmlBody,
    });
  }

  /**
   * Deliver SMTP for an already-persisted email.
   * Returns quickly when delivery takes longer than the "quick" window (large attachments).
   */
  async _deliverQueuedEmail({ emailId, userId, mailPayload, htmlBody }) {
    const QUICK_MS = Number(process.env.EMAIL_SEND_QUICK_MS) || 6000;
    // Large attachments need more headroom before we treat the send as "queued"
    const hasAttachments =
      Array.isArray(mailPayload?.attachments) && mailPayload.attachments.length > 0;
    const waitMs = hasAttachments
      ? Number(process.env.EMAIL_SEND_ATTACHMENT_QUICK_MS) || Math.max(QUICK_MS, 20000)
      : QUICK_MS;

    const delivery = (async () => {
      // One SMTP message to all recipients; hide addresses from each other via BCC.
      // Persisted Email.to still keeps the full recipient list for Sent UI.
      const envelopeTo = await resolveSenderEnvelopeAddress(userId);
      const privateRecipients = buildPrivateRecipientPayload({
        to: mailPayload?.to,
        cc: mailPayload?.cc,
        bcc: mailPayload?.bcc,
        envelopeTo,
      });
      const smtpPayload = {
        ...mailPayload,
        to: privateRecipients.to || mailPayload?.to,
        cc: privateRecipients.cc,
        bcc: privateRecipients.bcc,
      };

      // emailHelper persists final status / messageId onto this OutboundEmail row
      await sendEmailHelper(smtpPayload);
      // Ensure body stays consistent even if helper log update is partial
      await Email.updateOne(
        { _id: emailId, ...userIdMatchFilter(userId) },
        {
          $set: {
            status: EMAIL_STATUS.SENT,
            sentAt: ClockService.now(),
            body: encryptEmailField(htmlBody),
            origin: EMAIL_ORIGIN.USER,
          },
          $unset: { errorMessage: 1 },
        }
      );
      return { ok: true };
    })().catch(async (error) => {
      logger.error('Send email delivery error:', error);
      try {
        await Email.updateOne(
          { _id: emailId, ...userIdMatchFilter(userId) },
          {
            $set: {
              status: EMAIL_STATUS.FAILED,
              origin: EMAIL_ORIGIN.USER,
              errorMessage: error.message || 'Email delivery failed. Please try again later.',
            },
          }
        );
      } catch (updateErr) {
        logger.error('Failed to mark email as failed:', updateErr);
      }
      return { ok: false, error };
    });

    const raced = await Promise.race([
      delivery.then((result) => ({ type: 'done', result })),
      new Promise((resolve) => setTimeout(() => resolve({ type: 'queued' }), waitMs)),
    ]);

    if (raced.type === 'queued') {
      // Keep delivery running in background; client should treat this as accepted
      return {
        success: true,
        queued: true,
        messageId: emailId.toString(),
        message: 'Email is being sent',
      };
    }

    if (!raced.result.ok) {
      throw new Error(
        'Failed to send email: ' + (raced.result.error?.message || 'Email delivery failed. Please try again later.')
      );
    }

    return {
      success: true,
      queued: false,
      messageId: emailId.toString(),
      message: 'Email sent successfully',
    };
  }

  async listEmails(userId, maxResults, pageToken) {
    // Try to use IMAP if configured, otherwise return empty list
    const provider = await this.getActiveProvider(userId);

    if (!provider) {
      return { emails: [], nextPageToken: null };
    }

    return await imapService.listEmails(userId, maxResults, pageToken);
  }

  async listSentEmails(userId, maxResults, pageToken, hoaId = null) {
    // Return sent emails from database
    try {
      const skip = pageToken ? parseInt(pageToken) : 0;
      const limit = maxResults || 50;

      const sentEmails = await Email.find({
        ...userGeneratedEmailFilter(userId, hoaId),
        status: { $in: [EMAIL_STATUS.SENT, EMAIL_STATUS.SENDING] },
      })
        .populate('attachments.documentMetadataId')
        .sort({ sentAt: -1, updatedAt: -1 })
        .skip(skip)
        .limit(limit + 1);

      const hasMore = sentEmails.length > limit;
      const emails = hasMore ? sentEmails.slice(0, limit) : sentEmails;

      return {
        emails: emails.map(email => {
          const decryptedBody = decryptEmailField(email.body);
          const textBody = this._convertHtmlToText(decryptedBody);
          return {
            id: email._id.toString(),
            from: process.env.FROM_EMAIL || 'noreply@propmv.com',
            to: decryptEmailField(email.to),
            subject: decryptEmailField(email.subject),
            date: (email.sentAt || email.updatedAt || email.createdAt).toISOString(),
            snippet: textBody.substring(0, 100),
            body: decryptedBody,
            textBody: textBody,
            unread: false,
            status: email.status,
            origin: email.origin || EMAIL_ORIGIN.USER,
            attachments: email.attachments || [],
          };
        }),
        nextPageToken: hasMore ? (skip + limit).toString() : null,
      };
    } catch (error) {
      logger.error('List sent emails error:', error);
      return { emails: [], nextPageToken: null };
    }
  }

  async checkAccess(userId) {
    // Always return true for sending capability since we use common email helper
    const provider = await this.getActiveProvider(userId);

    let imapWorking = false;
    if (provider) {
      const uid = toObjectId(userId);
      const config = uid ? await EmailConfig.findOne({ userId: uid, provider: 'smtp', isActive: true }) : null;

      // Test IMAP if configured
      if (config && config.imapHost) {
        try {
          await imapService.verifyImapConfig(config.imapHost, config.imapPort, config.smtpUser, config.smtpPassword);
          imapWorking = true;
        } catch (err) {
          logger.error('IMAP verification failed:', err.message);
        }
      }
    }

    return {
      hasAccess: true, // Always true since we can send via common helper
      provider: 'system',
      smtpWorking: true, // Always true
      imapWorking,
      capabilities: {
        canSend: true, // Always true
        canRead: imapWorking
      }
    };
  }

  async markAsRead(userId, emailId) {
    const provider = await this.getActiveProvider(userId);

    if (!provider) {
      // If no IMAP configured, just return success
      return { success: true };
    }

    return await imapService.markAsRead(userId, emailId);
  }

  async getEmailDetail(userId, emailId, hoaId = null) {
    // Try to get from IMAP first
    const provider = await this.getActiveProvider(userId);

    if (provider) {
      try {
        return await imapService.getEmailDetail(userId, emailId);
      } catch (error) {
        logger.error('IMAP get email detail error:', error);
      }
    }

    // Try to get from emails collection (sent/draft/failed)
    try {
      const safeEmailId = toObjectId(emailId);
      if (!safeEmailId) throw new Error('Email not found');
      const email = await Email.findOne({
        _id: safeEmailId,
        ...userIdMatchFilter(userId),
        ...communityEmailFilter(hoaId),
        isDeleted: { $ne: true },
      })
        .populate('attachments.documentMetadataId');
      if (email) {
        const decryptedBody = decryptEmailField(email.body);
        const textBody = this._convertHtmlToText(decryptedBody);
        return {
          id: email._id.toString(),
          from: process.env.FROM_EMAIL || 'noreply@propmv.com',
          to: decryptEmailField(email.to),
          subject: decryptEmailField(email.subject),
          date: email.sentAt ? email.sentAt.toISOString() : email.updatedAt.toISOString(),
          body: decryptedBody,
          textBody: textBody,
          unread: false,
          status: email.status,
          origin: email.origin || EMAIL_ORIGIN.USER,
          attachments: email.attachments || [],
        };
      }
    } catch (error) {
      logger.error('Get email detail error:', error);
    }

    throw new Error('Email not found');
  }

  async saveDraft(userId, draftData, files = [], hoaId = null) {
    try {
      const { id, to, subject, body, cc, bcc, attachments: existingAttachments } = draftData;
      const hoaObjectId = normalizeHoaObjectId(hoaId);

      // Upload new attachments if any
      let newAttachmentMetadata = [];
      if (files && files.length > 0) {
        const uploadedDocs = await documentManager.uploadAndCreateMetadata(files, {
          documentType: 'email',
          userId: userId,
        });
        newAttachmentMetadata = uploadedDocs.map(doc => ({
          documentMetadataId: doc._id,
          filename: doc.key,
          originalName: doc.originalName,
          size: doc.size,
          mimetype: doc.contentType,
          uploadedAt: ClockService.now(),
        }));
      }

      // Merge existing and new attachments (normalize IDs so send/prepare never fails)
      const allAttachments = normalizeAttachmentMetadata([
        ...(existingAttachments || []),
        ...newAttachmentMetadata,
      ]);

      // Check if there's any content to save (no mandatory fields)
      const hasContent = to || subject || body || cc || bcc || allAttachments.length > 0;

      if (!hasContent) {
        throw new Error('Draft must have at least one field with content');
      }

      if (id) {
        const safeId = toObjectId(id);
        if (!safeId) throw new Error('Invalid draft ID');
        const updateData = {
          to: encryptEmailField(to),
          subject: encryptEmailField(subject),
          body: encryptEmailField(body),
          cc: encryptEmailField(cc),
          bcc: encryptEmailField(bcc),
          attachments: allAttachments,
          origin: EMAIL_ORIGIN.USER,
          ...(hoaObjectId ? { hoaId: hoaObjectId } : {}),
        };
        // Update existing draft (or failed email before resend) in place - status unchanged
        const draft = await Email.findOneAndUpdate(
          {
            _id: safeId,
            ...userIdMatchFilter(userId),
            ...communityEmailFilter(hoaId),
            status: { $in: [EMAIL_STATUS.DRAFT, EMAIL_STATUS.FAILED] },
            isDeleted: { $ne: true },
          },
          updateData,
          { new: true }
        ).populate('attachments.documentMetadataId');
        if (!draft) {
          throw new Error('Draft not found');
        }
        return { success: true, draft };
      }

      const draft = new Email({
        userId,
        ...(hoaObjectId ? { hoaId: hoaObjectId } : {}),
        origin: EMAIL_ORIGIN.USER,
        to: encryptEmailField(to || ''),
        subject: encryptEmailField(subject || ''),
        body: encryptEmailField(body || ''),
        cc: encryptEmailField(cc || ''),
        bcc: encryptEmailField(bcc || ''),
        status: EMAIL_STATUS.DRAFT,
        attachments: allAttachments,
      });
      await draft.save();
      await draft.populate('attachments.documentMetadataId');
      return { success: true, draft };
    } catch (error) {
      logger.error('Save draft error:', error);
      throw new Error('Failed to save draft: ' + error.message);
    }
  }

  async listDrafts(userId, hoaId = null) {
    try {
      const drafts = await Email.find({
        ...userGeneratedEmailFilter(userId, hoaId),
        status: EMAIL_STATUS.DRAFT,
      })
        .populate('attachments.documentMetadataId')
        .sort({ updatedAt: -1 });
      return {
        drafts: drafts.map(draft => ({
          id: draft._id.toString(),
          _id: draft._id.toString(),
          to: decryptEmailField(draft.to) || '',
          cc: decryptEmailField(draft.cc) || '',
          bcc: decryptEmailField(draft.bcc) || '',
          subject: decryptEmailField(draft.subject) || '(No Subject)',
          body: decryptEmailField(draft.body) || '',
          status: EMAIL_STATUS.DRAFT,
          origin: draft.origin || EMAIL_ORIGIN.USER,
          updatedAt: draft.updatedAt.toISOString(),
          createdAt: draft.createdAt?.toISOString?.() || draft.updatedAt.toISOString(),
          attachments: draft.attachments || [],
        }))
      };
    } catch (error) {
      logger.error('List drafts error:', error);
      return { drafts: [] };
    }
  }

  async deleteDraft(userId, draftId) {
    try {
      const safeDraftId = toObjectId(draftId);
      if (!safeDraftId) throw new Error('Draft not found');
      // Soft delete draft by setting isDeleted flag
      const draft = await Email.findOneAndUpdate(
        { _id: safeDraftId, ...userIdMatchFilter(userId), status: EMAIL_STATUS.DRAFT, isDeleted: { $ne: true } },
        { isDeleted: true },
        { new: true }
      );

      if (!draft) {
        throw new Error('Draft not found');
      }

      return { success: true };
    } catch (error) {
      logger.error('Delete draft error:', error);
      throw new Error('Failed to delete draft: ' + error.message);
    }
  }

  async discardDraft(userId, draftId) {
    try {
      const ids = toObjectIds([draftId]);
      if (!ids.length) {
        return { success: true, deletedCount: 0 };
      }

      const result = await Email.updateOne(
        {
          _id: ids[0],
          ...userIdMatchFilter(userId),
          status: { $in: DELETABLE_STATUSES },
          isDeleted: { $ne: true },
        },
        { $set: { isDeleted: true } }
      );

      // Fallback: own document regardless of status (handles legacy rows)
      if (!result.modifiedCount && !result.matchedCount) {
        const fallback = await Email.updateOne(
          {
            _id: ids[0],
            ...userIdMatchFilter(userId),
            isDeleted: { $ne: true },
          },
          { $set: { isDeleted: true } }
        );
        return { success: true, deletedCount: fallback.modifiedCount || 0 };
      }

      return { success: true, deletedCount: result.modifiedCount || 0 };
    } catch (error) {
      logger.error('Discard draft error:', error);
      throw new Error('Failed to discard draft: ' + error.message);
    }
  }

  async bulkDiscardDrafts(userId, draftIds) {
    try {
      const ids = toObjectIds(draftIds);
      if (!ids.length) {
        return { success: true, deletedCount: 0 };
      }

      // Resolve ownership in application space so string/ObjectId userId mismatch can't skip deletes
      const candidates = await Email.find({
        _id: { $in: ids },
        isDeleted: { $ne: true },
      })
        .select('_id userId status')
        .lean();

      const uid = String(userId || '');
      const ownedIds = candidates
        .filter((row) => String(row.userId || '') === uid)
        .map((row) => row._id);

      if (!ownedIds.length) {
        logger.warn('[Email] bulkDiscardDrafts: no owned emails matched', {
          userId: uid,
          requested: ids.map(String),
          found: candidates.length,
        });
        return { success: true, deletedCount: 0 };
      }

      const result = await Email.updateMany(
        { _id: { $in: ownedIds }, isDeleted: { $ne: true } },
        { $set: { isDeleted: true } }
      );

      logger.info('[Email] bulkDiscardDrafts:', {
        userId: uid,
        requested: ids.length,
        owned: ownedIds.length,
        matched: result.matchedCount,
        modified: result.modifiedCount,
      });

      return {
        success: true,
        deletedCount: result.modifiedCount || 0,
      };
    } catch (error) {
      logger.error('Bulk discard drafts error:', error);
      throw new Error('Failed to discard drafts: ' + error.message);
    }
  }

  async sendDraft(userId, draftId) {
    const safeDraftId = toObjectId(draftId);
    if (!safeDraftId) throw new Error('Draft not found');
    const draft = await Email.findOne({
      _id: safeDraftId,
      ...userIdMatchFilter(userId),
      status: { $in: [EMAIL_STATUS.DRAFT, EMAIL_STATUS.FAILED, EMAIL_STATUS.SENDING] },
      isDeleted: { $ne: true },
      origin: { $ne: EMAIL_ORIGIN.SYSTEM },
    }).lean();

    if (!draft) {
      throw new Error('Draft not found');
    }

    const draftObjectId = safeDraftId;
    const attachmentSnapshot = normalizeAttachmentMetadata(draft.attachments || []);

    const htmlBody = this._convertTextToHtml(decryptEmailField(draft.body));

    await Email.updateOne(
      { _id: draftObjectId, ...userIdMatchFilter(userId) },
      {
        $set: {
          status: EMAIL_STATUS.SENDING,
          body: encryptEmailField(htmlBody),
          origin: EMAIL_ORIGIN.USER,
          attachments: attachmentSnapshot,
        },
        $unset: { errorMessage: 1 },
      }
    );

    let nodemailerAttachments = [];
    try {
      nodemailerAttachments = await this._prepareAttachmentsForSending(attachmentSnapshot);
    } catch (prepError) {
      await Email.updateOne(
        { _id: draftObjectId, ...userIdMatchFilter(userId) },
        { $set: { status: EMAIL_STATUS.FAILED, errorMessage: prepError.message } }
      );
      throw new Error('Failed to prepare attachments: ' + prepError.message);
    }

    return this._deliverQueuedEmail({
      emailId: draftObjectId,
      userId,
      mailPayload: {
        to: decryptEmailField(draft.to),
        subject: decryptEmailField(draft.subject),
        html: htmlBody,
        text: this._convertHtmlToText(htmlBody),
        cc: decryptEmailField(draft.cc),
        bcc: decryptEmailField(draft.bcc),
        attachments: nodemailerAttachments,
        origin: EMAIL_ORIGIN.USER,
        userId,
        emailId: draftObjectId,
      },
      htmlBody,
    });
  }

  async listFailedEmails(userId, hoaId = null) {
    try {
      const failedEmails = await Email.find({
        ...userGeneratedEmailFilter(userId, hoaId),
        status: EMAIL_STATUS.FAILED,
      })
        .populate('attachments.documentMetadataId')
        .sort({ updatedAt: -1 });
      return {
        emails: failedEmails.map(email => ({
          id: email._id.toString(),
          _id: email._id.toString(),
          to: decryptEmailField(email.to) || '',
          subject: decryptEmailField(email.subject) || '(No Subject)',
          body: decryptEmailField(email.body) || '',
          status: EMAIL_STATUS.FAILED,
          origin: email.origin || EMAIL_ORIGIN.USER,
          errorMessage: email.errorMessage || 'Unknown error',
          updatedAt: email.updatedAt.toISOString(),
          createdAt: email.createdAt?.toISOString?.() || email.updatedAt.toISOString(),
          attachments: email.attachments || [],
        }))
      };
    } catch (error) {
      logger.error('List failed emails error:', error);
      return { emails: [] };
    }
  }

  async _streamToBuffer(stream) {
    if (!stream) return Buffer.alloc(0);
    if (Buffer.isBuffer(stream)) return stream;
    // AWS SDK v3 SdkStreamMixin
    if (typeof stream.transformToByteArray === 'function') {
      return Buffer.from(await stream.transformToByteArray());
    }
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  // Helper method to prepare attachments for nodemailer.
  // Uses Buffers (not streams) so SMTP retries remain reliable.
  async _prepareAttachmentsForSending(attachmentMetadata) {
    if (!attachmentMetadata || attachmentMetadata.length === 0) {
      return [];
    }

    const nodemailerAttachments = [];
    const failures = [];

    for (const attachment of attachmentMetadata) {
      try {
        const metadataId = attachment.documentMetadataId?._id || attachment.documentMetadataId;
        if (!metadataId) {
          failures.push(attachment.originalName || attachment.filename || 'unknown');
          continue;
        }
        const { stream, fileName, contentType } = await documentManager.getStreamByMetadataId(metadataId);
        const content = await this._streamToBuffer(stream);
        if (!content || content.length < 1) {
          failures.push(
            `${attachment.originalName || attachment.filename || fileName || 'attachment'} (empty file)`
          );
          continue;
        }

        nodemailerAttachments.push({
          filename: attachment.originalName || fileName || 'attachment',
          content,
          contentType: attachment.mimetype || contentType || 'application/octet-stream',
          contentDisposition: 'attachment',
        });
      } catch (error) {
        logger.error('Failed to prepare attachment:', error.message);
        failures.push(
          `${attachment.originalName || attachment.filename || 'attachment'}: ${error.message || 'load failed'}`
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(`Could not load attachment(s): ${failures.join(', ')}`);
    }

    return nodemailerAttachments;
  }
}

module.exports = new EmailService();
