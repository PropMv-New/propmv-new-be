/**
 * Persist outbound SMTP email logs from the common emailHelper.
 * Prefer updating an existing Email-tab record when emailId is provided;
 * otherwise create a new OutboundEmail row (system mail / legacy callers).
 */
const mongoose = require('mongoose');
const logger = require('../logger');
const { connectToDatabase } = require('../../database');
const { EMAIL_STATUS } = require('../constants/emailStatus');
const { EMAIL_ORIGIN } = require('../constants/emailOrigin');
const { encryptEmailField } = require('./cryptoHelper');

function toObjectIdOrNull(id) {
  if (!id) return null;
  const raw = String(id);
  if (!mongoose.Types.ObjectId.isValid(raw)) return null;
  return new mongoose.Types.ObjectId(raw);
}

function normalizeAddressList(value) {
  if (!value) return '';
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v : v?.address || ''))
      .map((s) => String(s || '').trim())
      .filter(Boolean)
      .join(', ');
  }
  return String(value).trim();
}

async function persistEmailLog({
  emailId = null,
  userId = null,
  origin = EMAIL_ORIGIN.SYSTEM,
  to,
  cc,
  bcc,
  subject,
  body,
  status,
  errorMessage = '',
  templateName = '',
  messageId = '',
  attachments = [],
} = {}) {
  try {
    await connectToDatabase();
    const Email = require('../../shared/modules/email/model/email.model');

    const payload = {
      origin: origin === EMAIL_ORIGIN.USER ? EMAIL_ORIGIN.USER : EMAIL_ORIGIN.SYSTEM,
      to: encryptEmailField(normalizeAddressList(to)),
      cc: encryptEmailField(normalizeAddressList(cc)) || undefined,
      bcc: encryptEmailField(normalizeAddressList(bcc)) || undefined,
      subject: encryptEmailField(subject || ''),
      body: encryptEmailField(body || ''),
      status,
      templateName: templateName || undefined,
      messageId: messageId || undefined,
      errorMessage: errorMessage || undefined,
    };

    if (status === EMAIL_STATUS.SENT) {
      payload.sentAt = new Date();
    }

    const existingId = toObjectIdOrNull(emailId);
    if (existingId) {
      const update = { $set: payload };
      if (status === EMAIL_STATUS.SENT) {
        update.$unset = { errorMessage: 1 };
      }
      await Email.updateOne({ _id: existingId }, update);
      return existingId.toString();
    }

    const uid = toObjectIdOrNull(userId);
    const doc = {
      ...payload,
      attachments: Array.isArray(attachments) ? attachments : [],
      isDeleted: false,
    };
    if (uid) {
      doc.userId = uid;
    }

    const created = await Email.create(doc);
    return created._id.toString();
  } catch (err) {
    // Logging must never break SMTP delivery for callers
    logger.error('[EmailLog] Failed to persist email log:', err.message || err);
    return null;
  }
}

module.exports = {
  persistEmailLog,
  normalizeAddressList,
};
