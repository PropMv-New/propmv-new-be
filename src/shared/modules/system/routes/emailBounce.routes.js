const express = require('express');
const crypto = require('crypto');
const responseHelper = require('../../../../common/helpers/responseHelper');
const { ingestBounceNotification } = require('../../../../common/helpers/emailBounceIngest.service');
const { pollBounceMailboxOnce } = require('../../../../common/helpers/emailBounceImapPoller.service');
const {
  recordPermanentBounce,
  normalizeEmail,
  isSyntaxValid,
} = require('../../../../common/helpers/emailRecipientValidation.service');

const router = express.Router();
// CSRF is not applied here: these are server-to-server webhook/ops endpoints
// authenticated via assertBounceWebhookAuth (shared secret). They are also
// listed in EXEMPT_PREFIXES in csrfProtection.js for the global middleware.

function secretsEqual(provided, expected) {
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length !== b.length) {
    // Keep roughly constant work when lengths differ
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function assertBounceWebhookAuth(req) {
  const secret = String(process.env.EMAIL_BOUNCE_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    const err = new Error('Bounce webhook is not configured (EMAIL_BOUNCE_WEBHOOK_SECRET)');
    err.status = 503;
    throw err;
  }
  // Header only - never accept query/body secrets (access-log leakage risk)
  const provided =
    req.get('x-bounce-webhook-secret') ||
    req.get('x-webhook-secret') ||
    '';
  if (!secretsEqual(String(provided).trim(), secret)) {
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }
}

/**
 * POST /api/v1/system/email-bounces
 * Ingest a bounce / DSN notification (from Hostinger forwarding, Zapier, etc.)
 */
router.post('/email-bounces', async (req, res) => {
  try {
    assertBounceWebhookAuth(req);
    const body = req.body || {};
    const result = await ingestBounceNotification({
      subject: body.subject || body.Subject || '',
      text: body.text || body.body || body.message || '',
      html: body.html || '',
      raw: body.raw || '',
      source: body.source || 'bounce_webhook',
      metadata: { path: req.originalUrl },
    });
    return responseHelper.success(res, result, result.suppressed ? 'Bounce suppressed' : 'Bounce ignored', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, err.status || 500);
  }
});

/**
 * POST /api/v1/system/email-bounces/poll
 * Manually trigger one IMAP bounce poll cycle (ops / debugging).
 */
router.post('/email-bounces/poll', async (req, res) => {
  try {
    assertBounceWebhookAuth(req);
    const result = await pollBounceMailboxOnce();
    return responseHelper.success(res, result, 'Bounce IMAP poll completed', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, err.status || 500);
  }
});

/**
 * GET /api/v1/system/email-suppressions?limit=50
 */
router.get('/email-suppressions', async (req, res) => {
  try {
    assertBounceWebhookAuth(req);
    const EmailSuppression = require('../../../../common/models/emailSuppression.model');
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const rows = await EmailSuppression.find({})
      .sort({ suppressedAt: -1 })
      .limit(limit)
      .lean();
    return responseHelper.success(res, { suppressions: rows, count: rows.length }, 'OK', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, err.status || 500);
  }
});

/**
 * POST /api/v1/system/email-suppressions
 * Body: { email, reason? }
 * Manually suppress an address (ops).
 */
router.post('/email-suppressions', async (req, res) => {
  try {
    assertBounceWebhookAuth(req);
    const email = normalizeEmail(req.body?.email || '');
    if (!email || !isSyntaxValid(email)) {
      return responseHelper.error(res, 'A valid email is required', 400);
    }
    const doc = await recordPermanentBounce(email, {
      reason: req.body?.reason || 'manual_suppress',
      bounceReason: req.body?.bounceReason || 'manual',
      source: 'manual',
      context: 'ops_api',
    });
    return responseHelper.success(res, { suppression: doc }, 'Email suppressed', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, err.status || 500);
  }
});

/**
 * POST /api/v1/system/email-suppressions/remove
 * Body: { email }
 * Remove an address from the suppression list (ops - e.g. after RCPT false positive).
 */
router.post('/email-suppressions/remove', async (req, res) => {
  try {
    assertBounceWebhookAuth(req);
    const email = normalizeEmail(req.body?.email || '');
    if (!email || !isSyntaxValid(email)) {
      return responseHelper.error(res, 'A valid email is required', 400);
    }
    const EmailSuppression = require('../../../../common/models/emailSuppression.model');
    const result = await EmailSuppression.deleteOne({ email });
    try {
      const { clearSmtpRcptVerifyCache } = require('../../../../common/helpers/emailSmtpRcptVerify.service');
      clearSmtpRcptVerifyCache(email);
    } catch {
      /* ignore */
    }
    return responseHelper.success(
      res,
      { email, removed: result.deletedCount > 0 },
      result.deletedCount > 0 ? 'Email unsuppressed' : 'Email was not on the suppression list',
      200
    );
  } catch (err) {
    return responseHelper.error(res, err.message, err.status || 500);
  }
});

module.exports = router;
