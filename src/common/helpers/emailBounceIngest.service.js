const logger = require('../logger');
/**
 * Parse SMTP DSN / bounce messages and suppress undeliverable recipients.
 * Used by IMAP bounce poller and optional webhook ingest.
 */

const { normalizeEmail, isSyntaxValid, recordPermanentBounce } =
  require('./emailRecipientValidation.service');

const EMAIL_IN_TEXT_RE =
  /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}/gi;

const PERMANENT_BOUNCE_HINT =
  /550|5\.1\.1|5\.1\.2|5\.1\.3|5\.2\.1|5\.4\.1|user unknown|does not exist|no such user|mailbox unavailable|recipient rejected|undeliverable|permanent failure|not a valid mailbox/i;

function extractEmailsFromText(text) {
  const raw = String(text || '');
  const found = raw.match(EMAIL_IN_TEXT_RE) || [];
  const unique = [];
  const seen = new Set();
  for (const e of found) {
    const n = normalizeEmail(e);
    if (!n || seen.has(n) || !isSyntaxValid(n)) continue;
    seen.add(n);
    unique.push(n);
  }
  return unique;
}

/**
 * Prefer Final-Recipient / Original-Recipient headers from DSN bodies.
 * Falls back only to Hostinger/Mailchannels "<email>: host ..." lines - not arbitrary
 * emails in the body (avoids suppressing third-party addresses mentioned in the DSN).
 */
function extractBounceRecipient(text) {
  const raw = String(text || '');
  const headerMatch = raw.match(
    /(?:Final-Recipient|Original-Recipient|X-Failed-Recipients)\s*:\s*(?:rfc822\s*;\s*)?([^\s>;]+)/i
  );
  if (headerMatch && headerMatch[1]) {
    const email = normalizeEmail(headerMatch[1].replace(/[<>]/g, ''));
    if (isSyntaxValid(email)) return email;
  }

  // Hostinger / Mailchannels style: "<bad@gmail.com>: host gmail-smtp-in..."
  const angleMatch = raw.match(/<([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})>\s*:\s*host/i);
  if (angleMatch && angleMatch[1]) {
    return normalizeEmail(angleMatch[1]);
  }

  // Explicit "To: user@..." failure lines sometimes appear without angle brackets
  const failedToMatch = raw.match(
    /(?:failed(?:\s+to)?(?:\s+deliver)?(?:\s+to)?|recipient)\s*[:=]\s*<?([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})>?/i
  );
  if (failedToMatch && failedToMatch[1]) {
    const email = normalizeEmail(failedToMatch[1]);
    if (isSyntaxValid(email) && !/^(mailer-daemon|postmaster|noreply|noreply)@/i.test(email)) {
      return email;
    }
  }

  return null;
}

function looksLikePermanentBounce(text) {
  return PERMANENT_BOUNCE_HINT.test(String(text || ''));
}

/**
 * Ingest a bounce notification payload (webhook or parsed IMAP message).
 * @returns {Promise<{ suppressed: boolean, email: string|null, reason: string }>}
 */
async function ingestBounceNotification({
  subject = '',
  text = '',
  html = '',
  raw = '',
  source = 'bounce_ingest',
  metadata = null,
} = {}) {
  const combined = [subject, text, html, raw].filter(Boolean).join('\n');
  if (!combined.trim()) {
    return { suppressed: false, email: null, reason: 'empty_payload' };
  }

  if (!looksLikePermanentBounce(combined)) {
    return { suppressed: false, email: null, reason: 'not_permanent_bounce' };
  }

  const email = extractBounceRecipient(combined);
  if (!email) {
    logger.warn('[BounceIngest] Permanent bounce detected but recipient could not be parsed');
    return { suppressed: false, email: null, reason: 'recipient_not_found' };
  }

  const smtpMatch = combined.match(/\b(55\d(?:[-\s]\d\.\d\.\d)?)\b/);
  const doc = await recordPermanentBounce(email, {
    reason: 'permanent_bounce',
    smtpResponse: smtpMatch ? smtpMatch[1] : '550',
    bounceReason: String(subject || 'Delivery Status Notification').slice(0, 500),
    source,
    context: 'async_bounce',
    metadata: {
      ...(metadata || {}),
      subject: String(subject || '').slice(0, 300),
    },
  });

  logger.warn(`[BounceIngest] Suppressed bounced recipient email=${email} source=${source}`);
  return {
    suppressed: Boolean(doc),
    email,
    reason: 'suppressed',
  };
}

module.exports = {
  extractEmailsFromText,
  extractBounceRecipient,
  looksLikePermanentBounce,
  ingestBounceNotification,
};
