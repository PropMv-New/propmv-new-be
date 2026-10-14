/**
 * Pre-send recipient validation: syntax, normalize, MX, suppression list.
 *
 * Env:
 *   EMAIL_VALIDATE_SYNTAX      (default true)
 *   EMAIL_VALIDATE_MX          (default true)
 *   EMAIL_MX_TIMEOUT_MS        (default 3000)
 *   EMAIL_MX_CACHE_TTL_MS      (default 300000 = 5m)
 *   EMAIL_MX_ALLOW_A_FALLBACK  (default false) - if no MX, treat A/AAAA as deliverable
 *   EMAIL_MX_ON_LOOKUP_ERROR   (default reject) - reject | allow when DNS fails
 *   EMAIL_SUPPRESSION_ENABLED  (default true)
 *   EMAIL_VALIDATION_LOG       (default true)
 *   EMAIL_MAILBOX_VERIFY_*     see emailMailboxVerify.service.js
 *   EMAIL_SMTP_RCPT_VERIFY_*   see emailSmtpRcptVerify.service.js
 */

const dns = require('dns').promises;
const logger = require('../logger');
const { verifyMailbox, isEnabled: isMailboxVerifyEnabled } = require('./emailMailboxVerify.service');
const {
  verifyMailboxViaSmtpRcpt,
  isEnabled: isSmtpRcptVerifyEnabled,
} = require('./emailSmtpRcptVerify.service');
const { evaluateDomainHeuristics } = require('./emailDomainHeuristics.service');

const INVALID_RECIPIENT_MESSAGE =
  'This email address appears to be invalid or cannot receive emails. Please verify the address and try again.';
const NO_MX_MESSAGE =
  'This email address cannot receive emails. Please enter a valid email address.';

/** Practical address check (not full RFC 5322). Requires TLD length >= 2. */
const EMAIL_SYNTAX_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/i;

/** @type {Map<string, { ok: boolean, records: string[], expiresAt: number }>} */
const mxCache = new Map();

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isSyntaxValid(email) {
  const normalized = normalizeEmail(email);
  if (!normalized || normalized.length > 254) return false;
  if (!EMAIL_SYNTAX_RE.test(normalized)) return false;
  const [local, domain] = normalized.split('@');
  if (!local || !domain || local.length > 64) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  return true;
}

function extractDomain(email) {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf('@');
  if (at < 0) return '';
  return normalized.slice(at + 1);
}

function createValidationError(message, code = 'EMAIL_UNDELIVERABLE') {
  const err = new Error(message || INVALID_RECIPIENT_MESSAGE);
  err.status = 400;
  err.code = code;
  err.field = 'email';
  err.isEmailValidationError = true;
  return err;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label || 'operation'} timed out after ${ms}ms`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function lookupMx(domain) {
  const timeoutMs = envInt('EMAIL_MX_TIMEOUT_MS', 3000);
  const cacheTtl = envInt('EMAIL_MX_CACHE_TTL_MS', 300000);
  const cached = mxCache.get(domain);
  if (cached && cached.expiresAt > Date.now()) {
    return { ok: cached.ok, records: cached.records, fromCache: true };
  }

  try {
    const mx = await withTimeout(dns.resolveMx(domain), timeoutMs, 'MX lookup');
    const records = (Array.isArray(mx) ? mx : [])
      .filter((r) => r && r.exchange)
      .sort((a, b) => (a.priority || 0) - (b.priority || 0))
      .map((r) => String(r.exchange).toLowerCase());

    if (records.length > 0) {
      const result = { ok: true, records, fromCache: false };
      mxCache.set(domain, { ok: true, records, expiresAt: Date.now() + cacheTtl });
      return result;
    }
  } catch (err) {
    const code = String(err?.code || '');
    // ENODATA / ENOTFOUND = no MX; other errors handled below
    if (!['ENODATA', 'ENOTFOUND', 'ETIMEOUT', 'ETIMEDOUT'].includes(code) && code) {
      // fall through to A fallback / policy
      if (!envBool('EMAIL_MX_ALLOW_A_FALLBACK', false)) {
        const onError = String(process.env.EMAIL_MX_ON_LOOKUP_ERROR || 'reject').toLowerCase();
        if (onError === 'allow') {
          return { ok: true, records: [], fromCache: false, lookupError: code || err.message };
        }
        const result = { ok: false, records: [], fromCache: false, lookupError: code || err.message };
        mxCache.set(domain, { ok: false, records: [], expiresAt: Date.now() + Math.min(cacheTtl, 60000) });
        return result;
      }
    }
  }

  if (envBool('EMAIL_MX_ALLOW_A_FALLBACK', false)) {
    try {
      const a = await withTimeout(dns.resolve4(domain), timeoutMs, 'A lookup');
      if (Array.isArray(a) && a.length > 0) {
        const result = { ok: true, records: [`a:${a[0]}`], fromCache: false };
        mxCache.set(domain, { ok: true, records: result.records, expiresAt: Date.now() + cacheTtl });
        return result;
      }
    } catch {
      // ignore
    }
    try {
      const aaaa = await withTimeout(dns.resolve6(domain), timeoutMs, 'AAAA lookup');
      if (Array.isArray(aaaa) && aaaa.length > 0) {
        const result = { ok: true, records: [`aaaa:${aaaa[0]}`], fromCache: false };
        mxCache.set(domain, { ok: true, records: result.records, expiresAt: Date.now() + cacheTtl });
        return result;
      }
    } catch {
      // ignore
    }
  }

  const result = { ok: false, records: [], fromCache: false };
  mxCache.set(domain, { ok: false, records: [], expiresAt: Date.now() + Math.min(cacheTtl, 60000) });
  return result;
}

async function persistValidationLog(entry) {
  if (!envBool('EMAIL_VALIDATION_LOG', true)) return;
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      logger.info(
        `[EmailValidation] ${entry.result} email=${entry.normalizedEmail}` +
        (entry.message ? ` msg=${entry.message}` : '')
      );
      return;
    }
    const EmailValidationLog = require('../models/emailValidationLog.model');
    await EmailValidationLog.create(entry);
  } catch (err) {
    logger.error('[EmailValidation] Failed to persist log:', err.message || err);
  }
}

async function isSuppressed(email) {
  if (!envBool('EMAIL_SUPPRESSION_ENABLED', true)) return false;
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) return false;
    const EmailSuppression = require('../models/emailSuppression.model');
    const normalized = normalizeEmail(email);
    if (!normalized || !isSyntaxValid(normalized)) return false;
    const row = await EmailSuppression.findOne({ email: { $eq: normalized } }).select('_id').lean();
    return Boolean(row);
  } catch (err) {
    logger.error('[EmailValidation] Suppression lookup failed:', err.message || err);
    return false;
  }
}

/**
 * Record a permanent bounce so future sends are blocked.
 */
async function recordPermanentBounce(email, details = {}) {
  if (!envBool('EMAIL_SUPPRESSION_ENABLED', true)) return null;
  const normalized = normalizeEmail(email);
  if (!normalized || !isSyntaxValid(normalized)) return null;

  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      logger.warn(
        `[EmailValidation] Permanent bounce (DB unavailable) email=${normalized}` +
        (details.smtpResponse ? ` smtp=${details.smtpResponse}` : '')
      );
      return null;
    }
    const EmailSuppression = require('../models/emailSuppression.model');
    const doc = await EmailSuppression.findOneAndUpdate(
      { email: normalized },
      {
        $set: {
          email: normalized,
          reason: details.reason || 'permanent_bounce',
          smtpResponse: String(details.smtpResponse || details.response || '').slice(0, 1000),
          bounceReason: String(details.bounceReason || details.message || '').slice(0, 1000),
          source: details.source || 'smtp',
          metadata: details.metadata || null,
          suppressedAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await persistValidationLog({
      email: String(email || ''),
      normalizedEmail: normalized,
      syntaxValid: true,
      domain: extractDomain(normalized),
      mxValid: null,
      suppressed: true,
      result: 'fail_suppressed',
      bounceReason: doc.bounceReason || '',
      smtpResponse: doc.smtpResponse || '',
      message: 'Recorded permanent bounce / suppression',
      context: details.context || 'smtp_permanent',
    });

    logger.warn(
      `[EmailValidation] Permanent bounce suppressed email=${normalized}` +
      (doc.smtpResponse ? ` smtp=${doc.smtpResponse}` : '')
    );
    return doc;
  } catch (err) {
    logger.error('[EmailValidation] Failed to record bounce:', err.message || err);
    return null;
  }
}

/**
 * Validate that an address is safe to attempt SMTP delivery.
 * @returns {Promise<{ email: string, domain: string, mxRecords: string[] }>}
 */
async function assertEmailCanReceive(email, options = {}) {
  const raw = String(email || '');
  const normalized = normalizeEmail(raw);
  const context = options.context || '';
  const skipMx = options.skipMx === true || !envBool('EMAIL_VALIDATE_MX', true);
  const skipSyntax = options.skipSyntax === true || !envBool('EMAIL_VALIDATE_SYNTAX', true);
  const skipSuppression = options.skipSuppression === true;
  const skipMailbox =
    options.skipMailbox === true ||
    (!isMailboxVerifyEnabled() && options.forceMailboxVerify !== true);
  const skipSmtpRcpt =
    options.skipSmtpRcpt === true ||
    (!isSmtpRcptVerifyEnabled() && options.forceSmtpRcptVerify !== true);

  const baseLog = {
    email: raw,
    normalizedEmail: normalized,
    syntaxValid: false,
    domain: extractDomain(normalized),
    mxValid: null,
    mxRecords: undefined,
    suppressed: false,
    result: 'fail_other',
    bounceReason: '',
    smtpResponse: '',
    message: '',
    context,
    metadata: options.metadata || null,
    mailboxStatus: '',
  };

  if (!skipSyntax && !isSyntaxValid(normalized)) {
    baseLog.result = 'fail_syntax';
    baseLog.message = INVALID_RECIPIENT_MESSAGE;
    await persistValidationLog(baseLog);
    throw createValidationError(INVALID_RECIPIENT_MESSAGE, 'EMAIL_INVALID_SYNTAX');
  }
  baseLog.syntaxValid = true;

  if (!skipSuppression && (await isSuppressed(normalized))) {
    baseLog.suppressed = true;
    baseLog.result = 'fail_suppressed';
    baseLog.message = INVALID_RECIPIENT_MESSAGE;
    baseLog.bounceReason = 'address_on_suppression_list';
    await persistValidationLog(baseLog);
    throw createValidationError(INVALID_RECIPIENT_MESSAGE, 'EMAIL_SUPPRESSED');
  }

  const heuristics = evaluateDomainHeuristics(normalized);
  if (!heuristics.ok) {
    baseLog.result = heuristics.code === 'EMAIL_DISPOSABLE_DOMAIN' ? 'fail_other' : 'fail_syntax';
    baseLog.message = heuristics.message;
    baseLog.bounceReason = heuristics.code;
    baseLog.metadata = {
      ...(baseLog.metadata || {}),
      suggestion: heuristics.suggestion || null,
    };
    await persistValidationLog(baseLog);
    const err = createValidationError(heuristics.message, heuristics.code);
    if (heuristics.suggestion) err.suggestion = heuristics.suggestion;
    throw err;
  }

  let mxRecords = [];
  if (!skipMx) {
    const domain = extractDomain(normalized);
    const mx = await lookupMx(domain);
    mxRecords = mx.records || [];
    baseLog.mxValid = mx.ok;
    baseLog.mxRecords = mxRecords.slice(0, 10);
    if (!mx.ok) {
      baseLog.result = 'fail_mx';
      baseLog.message = NO_MX_MESSAGE;
      baseLog.bounceReason = mx.lookupError
        ? `mx_lookup_error:${mx.lookupError}`
        : 'no_mx_records';
      await persistValidationLog(baseLog);
      throw createValidationError(NO_MX_MESSAGE, 'EMAIL_NO_MX');
    }
  }

  // Free RCPT probe against recipient MX (blocks nonexistent Gmail locals before Hostinger send)
  if (!skipSmtpRcpt) {
    const rcpt = await verifyMailboxViaSmtpRcpt(normalized, mxRecords);
    if (!rcpt.skipped && !rcpt.ok) {
      baseLog.result = 'fail_mailbox';
      baseLog.mailboxStatus = rcpt.status || 'smtp_rcpt_reject';
      baseLog.message = INVALID_RECIPIENT_MESSAGE;
      baseLog.bounceReason = `smtp_rcpt:${rcpt.status || 'reject'}:${rcpt.code || ''}`;
      baseLog.smtpResponse = String(rcpt.response || '').slice(0, 1000);
      await persistValidationLog(baseLog);
      await recordPermanentBounce(normalized, {
        reason: 'smtp_rcpt_reject',
        bounceReason: baseLog.bounceReason,
        smtpResponse: baseLog.smtpResponse,
        source: 'smtp_rcpt_verify',
        context: context || 'smtp_rcpt_verify',
        metadata: { code: rcpt.code, status: rcpt.status },
      });
      throw createValidationError(INVALID_RECIPIENT_MESSAGE, 'EMAIL_SMTP_RCPT_REJECT');
    }
    if (rcpt.status && !rcpt.skipped) {
      baseLog.mailboxStatus = baseLog.mailboxStatus || `smtp_rcpt:${rcpt.status}`;
    }
    if (rcpt.status === 'error_allowed') {
      logger.error(
        `[EmailValidation] SMTP RCPT probe failed open for ${normalized} (status=error_allowed). ` +
        'Outbound :25 may be blocked - enable EMAIL_MAILBOX_VERIFY_* or fix network before relying on this for Hostinger protection.'
      );
    }
  }

  if (!skipMailbox) {
    const mailbox = await verifyMailbox(normalized);
    baseLog.mailboxStatus = mailbox.status || baseLog.mailboxStatus || '';
    if (!mailbox.skipped && !mailbox.ok) {
      baseLog.result = 'fail_mailbox';
      baseLog.message = INVALID_RECIPIENT_MESSAGE;
      baseLog.bounceReason = `mailbox_verify:${mailbox.status || 'invalid'}`;
      await persistValidationLog(baseLog);
      // Also suppress so we do not re-check / re-attempt SMTP for known-bad mailboxes
      await recordPermanentBounce(normalized, {
        reason: 'mailbox_verify_failed',
        bounceReason: baseLog.bounceReason,
        source: 'mailbox_verify',
        context: context || 'mailbox_verify',
        metadata: { provider: mailbox.provider, status: mailbox.status },
      });
      throw createValidationError(INVALID_RECIPIENT_MESSAGE, 'EMAIL_MAILBOX_INVALID');
    }
  }

  baseLog.result = 'pass';
  baseLog.message = 'ok';
  await persistValidationLog(baseLog);

  return {
    email: normalized,
    domain: extractDomain(normalized),
    mxRecords,
  };
}

/** Clear in-memory MX cache (tests). */
function clearMxCache() {
  mxCache.clear();
}

module.exports = {
  INVALID_RECIPIENT_MESSAGE,
  NO_MX_MESSAGE,
  normalizeEmail,
  isSyntaxValid,
  extractDomain,
  lookupMx,
  isSuppressed,
  recordPermanentBounce,
  assertEmailCanReceive,
  createValidationError,
  clearMxCache,
  EMAIL_SYNTAX_RE,
};
