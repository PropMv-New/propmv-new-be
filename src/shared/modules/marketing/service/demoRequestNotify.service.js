const logger = require('../../../../common/logger');
const { sendEmail } = require('../../../../common/helpers/emailHelper');
const { markNotified } = require('./demoRequest.service');

const TEAM_NOTIFICATION_SUBJECT_PREFIX =
  process.env.EMAIL_SUBJECT_DEMO_REQUEST_TEAM || 'Demo request';

const REQUESTER_ACK_SUBJECT =
  process.env.EMAIL_SUBJECT_DEMO_REQUEST_ACK || 'Your PropMv demo request';

/** Where internal demo notifications land. */
const teamInbox = () =>
  process.env.DEMO_REQUEST_NOTIFY_EMAIL ||
  process.env.SUPPORT_EMAIL ||
  'support@propmv.com';

const esc = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Display US numbers as +1 (234) 567-8901; otherwise return escaped raw value. */
function formatPhoneForEmail(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return '';

  const digits = raw.replace(/\D/g, '');
  let national = digits;
  if (digits.length === 11 && digits.startsWith('1')) {
    national = digits.slice(1);
  }

  if (national.length === 10 && /^[2-9]\d{2}[2-9]\d{6}$/.test(national)) {
    return `+1 (${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
  }

  return esc(raw);
}

function buildDemoRequestTemplateData(doc) {
  const requesterName = String(doc.name || '').trim();
  const firstName = requesterName.split(/\s+/)[0] || 'there';
  const preferredSlot = [doc.preferredDate, doc.preferredTime].filter(Boolean).join(', ');
  const requesterPhone = formatPhoneForEmail(doc.phone);
  const source = String(doc.source || 'website').trim() || 'website';

  return {
    userName: esc(firstName),
    requesterName: esc(requesterName),
    requesterEmail: esc(doc.email),
    requesterPhone,
    role: esc(doc.role),
    propertyCount: esc(doc.propertyCount),
    preferredDate: esc(doc.preferredDate),
    preferredTime: esc(doc.preferredTime),
    preferredSlot: esc(preferredSlot),
    hasPreferredSlot: Boolean(preferredSlot),
    message: esc(doc.message),
    hasMessage: Boolean(String(doc.message || '').trim()),
    source: esc(source),
    hasPhone: Boolean(requesterPhone),
    hasRole: Boolean(String(doc.role || '').trim()),
    hasPropertyCount: Boolean(String(doc.propertyCount || '').trim()),
    hasPreferredDate: Boolean(String(doc.preferredDate || '').trim()),
    hasPreferredTime: Boolean(String(doc.preferredTime || '').trim()),
  };
}

function buildTeamSubject(doc) {
  const name = String(doc.name || '').trim() || 'Unknown';
  const propertySuffix = doc.propertyCount ? ` (${doc.propertyCount})` : '';
  return `${TEAM_NOTIFICATION_SUBJECT_PREFIX} - ${name}${propertySuffix}`;
}

/** Notify the team using the shared PropMv email template. */
async function sendTeamNotification(doc) {
  const data = buildDemoRequestTemplateData(doc);

  return sendEmail('demo-request-team-notification', teamInbox(), data, {
    subject: buildTeamSubject(doc),
    preheaderText: `New demo request from ${String(doc.name || '').trim() || 'a prospect'}.`,
    replyTo: doc.email,
  });
}

/** Acknowledge to the prospect using the shared PropMv email template. */
async function sendRequesterAcknowledgement(doc) {
  const data = buildDemoRequestTemplateData(doc);

  return sendEmail('demo-request-acknowledgement', doc.email, data, {
    subject: REQUESTER_ACK_SUBJECT,
    preheaderText:
      'We received your PropMv demo request and will contact you shortly to schedule a time.',
  });
}

/**
 * Fire both emails without blocking the response. A prospect should never see
 * a failed submission because our mail provider was slow - the lead is already
 * saved by the time this runs.
 */
function notifyDemoRequestInBackground(doc) {
  (async () => {
    try {
      await sendTeamNotification(doc);
      await markNotified(doc._id);
    } catch (err) {
      logger.error('[Marketing] demo request team notification failed:', err.message);
    }
    try {
      await sendRequesterAcknowledgement(doc);
    } catch (err) {
      logger.error('[Marketing] demo request acknowledgement failed:', err.message);
    }
  })();
}

module.exports = { sendTeamNotification, sendRequesterAcknowledgement, notifyDemoRequestInBackground };
