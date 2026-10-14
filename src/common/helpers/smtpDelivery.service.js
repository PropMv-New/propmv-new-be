/**
 * System SMTP delivery with per-provider retry and primary → secondary failover.
 *
 * Used by emailHelper for all PropMv system emails (OTP, invites, invoices, etc.).
 * Does not replace per-user SMTP (email tab / smtp.service.js).
 *
 * Env (preferred):
 *   SMTP_PRIMARY_HOST / PORT / USER / PASSWORD [ / FROM ]
 *   SMTP_SECONDARY_HOST / PORT / USER / PASSWORD [ / FROM ]
 *   SMTP_MAX_RETRIES      (default 3) - attempts per provider for transient failures
 *   SMTP_RETRY_DELAY      (default 1000) - base backoff ms (1s → 2s → 4s)
 *
 * Legacy fallback (backward compatible):
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS → treated as primary
 */

const nodemailer = require('nodemailer');
const logger = require('../logger');

const TRANSIENT_NODE_CODES = new Set([
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ESOCKET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ECONNABORTED',
  'EDNS',
]);

/** SMTP response codes treated as permanent recipient / message rejection (no retry, no failover). */
const PERMANENT_RESPONSE_CODES = new Set([551, 553, 554]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envStr(...names) {
  for (const name of names) {
    const v = process.env[name];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/**
 * @returns {'transient'|'permanent'|'provider'}
 */
function classifySmtpError(error) {
  const responseCode = Number(error?.responseCode || 0);
  const code = String(error?.code || error?.errno || '').toUpperCase();
  const message = String(error?.message || error?.response || error || '');

  if (PERMANENT_RESPONSE_CODES.has(responseCode)) {
    return 'permanent';
  }

  // 550 needs careful classification - Zoho uses it for both account-level blocks
  // (unusual activity, rate limits) AND invalid recipients. Only treat as permanent
  // when the message clearly indicates an invalid recipient.
  if (responseCode === 550) {
    if (/unusual.sending|sending.activity|unblock|usage.policy|rate.?limit|too.many|blocked|suspended|quota/i.test(message)) {
      // Account-level block - no point retrying, Zoho won't unblock mid-request.
      // Classify as 'provider' so we fail fast without retries and without suppressing the recipient.
      return 'provider';
    }
    if (/user.unknown|mailbox.unavailable|no.such.user|does.not.exist|invalid.recipient|recipient.rejected|relay.access.denied/i.test(message)) {
      return 'permanent';
    }
    // Unknown 550 - treat as provider error (failover, no suppression)
    return 'provider';
  }

  // Explicit invalid-recipient phrasing with other 5xx
  if (
    responseCode >= 500 &&
    /invalid.*(recipient|address)|user unknown|mailbox unavailable|no such user|recipient rejected|relay access denied/i.test(
      message
    )
  ) {
    return 'permanent';
  }

  if (TRANSIENT_NODE_CODES.has(code)) {
    return 'transient';
  }

  // 4xx temporary SMTP / greylist / rate limit
  if ([421, 450, 451, 452].includes(responseCode)) {
    return 'transient';
  }

  if (
    /EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|temporary|try again|socket closed|dns|rate.?limit|greylist|too many/i.test(
      message
    )
  ) {
    return 'transient';
  }

  // Auth failures, TLS issues, generic SMTP errors → failover (do not burn retries on same provider)
  return 'provider';
}

function buildTransportConfig(provider) {
  const port = Number(provider.port);
  return {
    host: provider.host,
    port,
    secure: String(port) === '465',
    auth: {
      user: provider.user,
      pass: provider.pass,
    },
    connectionTimeout: envInt('SMTP_CONNECTION_TIMEOUT_MS', 15000),
    greetingTimeout: envInt('SMTP_GREETING_TIMEOUT_MS', 15000),
    socketTimeout: envInt('SMTP_SOCKET_TIMEOUT_MS', 120000),
    tls: {
      rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== 'false',
      servername: provider.host || undefined,
    },
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
  };
}

function loadProvidersFromEnv() {
  const providers = [];

  const primaryHost = envStr('SMTP_PRIMARY_HOST', 'SMTP_HOST');
  const primaryPort = envStr('SMTP_PRIMARY_PORT', 'SMTP_PORT');
  const primaryUser = envStr('SMTP_PRIMARY_USER', 'SMTP_USER');
  const primaryPass = envStr('SMTP_PRIMARY_PASSWORD', 'SMTP_PRIMARY_PASS', 'SMTP_PASS');
  const primaryFrom = envStr('SMTP_PRIMARY_FROM');

  if (primaryHost && primaryUser && primaryPass) {
    providers.push({
      name: 'Primary',
      host: primaryHost,
      port: primaryPort || '465',
      user: primaryUser,
      pass: primaryPass,
      from: primaryFrom || '',
    });
  }

  const secondaryHost = envStr('SMTP_SECONDARY_HOST');
  const secondaryPort = envStr('SMTP_SECONDARY_PORT');
  const secondaryUser = envStr('SMTP_SECONDARY_USER');
  const secondaryPass = envStr(
    'SMTP_SECONDARY_PASSWORD',
    'SMTP_SECONDARY_PASS'
  );
  const secondaryFrom = envStr('SMTP_SECONDARY_FROM');

  if (secondaryHost && secondaryUser && secondaryPass) {
    providers.push({
      name: 'Secondary',
      host: secondaryHost,
      port: secondaryPort || '587',
      user: secondaryUser,
      pass: secondaryPass,
      from: secondaryFrom || secondaryUser,
    });
  }

  return providers;
}

function applyProviderFrom(mailOptions, provider) {
  if (!provider.from) return mailOptions;
  const next = { ...mailOptions };
  const existing = mailOptions.from;
  if (existing && typeof existing === 'object' && existing.address) {
    next.from = { ...existing, address: provider.from };
  } else if (typeof existing === 'string' && existing.includes('<')) {
    next.from = existing.replace(/<[^>]+>/, `<${provider.from}>`);
  } else {
    const name = process.env.FROM_NAME || 'PropMv';
    next.from = { name, address: provider.from };
  }
  return next;
}

class SmtpDeliveryService {
  constructor() {
    /** @type {Map<string, import('nodemailer').Transporter>} */
    this._transporters = new Map();
  }

  getMaxRetries() {
    // Attempts per provider for transient failures (includes the first try).
    return Math.max(1, envInt('SMTP_MAX_RETRIES', 3));
  }

  getRetryDelayMs() {
    // Prefer SMTP_RETRY_DELAY; keep legacy SMTP_RETRY_BASE_DELAY_MS as alias.
    const delay = envInt('SMTP_RETRY_DELAY', NaN);
    if (Number.isFinite(delay)) return Math.max(0, delay);
    return Math.max(0, envInt('SMTP_RETRY_BASE_DELAY_MS', 1000));
  }

  getProviders() {
    return loadProvidersFromEnv();
  }

  _transporterKey(provider) {
    return `${provider.name}:${provider.host}:${provider.port}:${provider.user}`;
  }

  getTransporter(provider) {
    const key = this._transporterKey(provider);
    let transporter = this._transporters.get(key);
    if (!transporter) {
      transporter = nodemailer.createTransport(buildTransportConfig(provider));
      this._transporters.set(key, transporter);
    }
    return transporter;
  }

  recreateTransporter(provider) {
    const key = this._transporterKey(provider);
    const existing = this._transporters.get(key);
    try {
      if (existing && typeof existing.close === 'function') {
        existing.close();
      }
    } catch {
      // ignore close errors
    }
    const transporter = nodemailer.createTransport(buildTransportConfig(provider));
    this._transporters.set(key, transporter);
    return transporter;
  }

  _logAttempt({
    providerName,
    attempt,
    maxAttempts,
    responseCode,
    errorMessage,
    retryCount,
    elapsedMs,
    outcome,
  }) {
    const parts = [
      `[SMTP] provider=${providerName}`,
      `attempt=${attempt}/${maxAttempts}`,
      `retryCount=${retryCount}`,
      `elapsedMs=${elapsedMs}`,
      `outcome=${outcome}`,
    ];
    if (responseCode != null && responseCode !== '') {
      parts.push(`smtpCode=${responseCode}`);
    }
    if (errorMessage) {
      parts.push(`error=${errorMessage}`);
    }
    logger.info(parts.join(' | '));
  }

  /**
   * Send mail with per-provider retries and failover across configured providers.
   * @param {object} mailOptions nodemailer mail options
   * @returns {Promise<object>} nodemailer send info
   */
  async sendMail(mailOptions) {
    const startedAt = Date.now();
    const providers = this.getProviders();
    const maxRetries = this.getMaxRetries();
    const baseDelayMs = this.getRetryDelayMs();

    if (!providers.length) {
      const err = new Error('No SMTP providers configured');
      err.code = 'ESMTPCONFIG';
      throw err;
    }

    let lastError;
    let totalRetryCount = 0;

    for (let providerIndex = 0; providerIndex < providers.length; providerIndex++) {
      const provider = providers[providerIndex];
      const optionsForProvider = applyProviderFrom(mailOptions, provider);

      if (providerIndex > 0) {
        logger.warn(
          `Primary SMTP failed. Switching to Secondary SMTP.`
        );
      }

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const attemptStarted = Date.now();
        try {
          const transporter = this.getTransporter(provider);
          const info = await transporter.sendMail(optionsForProvider);
          const elapsedMs = Date.now() - startedAt;
          this._logAttempt({
            providerName: provider.name,
            attempt,
            maxAttempts: maxRetries,
            responseCode: info?.response || '',
            errorMessage: '',
            retryCount: totalRetryCount,
            elapsedMs,
            outcome: 'success',
          });
          logger.info(
            `[SMTP] Email sent via ${provider.name} SMTP` +
            ` (${provider.host}:${provider.port}) in ${elapsedMs}ms` +
            ` messageId=${info.messageId || ''}`
          );
          return info;
        } catch (error) {
          lastError = error;
          const classification = classifySmtpError(error);
          const responseCode = error?.responseCode || error?.code || '';
          const errorMessage = error?.message || String(error);
          const elapsedMs = Date.now() - startedAt;
          const retryCount = attempt - 1;
          totalRetryCount += 1;

          this._logAttempt({
            providerName: provider.name,
            attempt,
            maxAttempts: maxRetries,
            responseCode,
            errorMessage,
            retryCount,
            elapsedMs,
            outcome: `fail:${classification}`,
          });

          if (classification === 'permanent') {
            // Invalid recipient etc. - do not retry or failover; suppress future sends
            try {
              const {
                recordPermanentBounce,
                normalizeEmail,
              } = require('./emailRecipientValidation.service');
              const rawTo = mailOptions?.to;
              const toList = Array.isArray(rawTo) ? rawTo : [rawTo];
              for (const entry of toList) {
                const address =
                  typeof entry === 'string'
                    ? entry.replace(/.*<([^>]+)>.*/, '$1').split(',')[0].trim()
                    : entry?.address;
                if (!address) continue;
                await recordPermanentBounce(normalizeEmail(address), {
                  reason: 'permanent_bounce',
                  smtpResponse: String(responseCode || ''),
                  bounceReason: errorMessage,
                  source: 'smtp_sync',
                  context: `provider=${provider.name}`,
                  metadata: {
                    provider: provider.name,
                    classification: 'permanent',
                  },
                });
              }
            } catch (suppressErr) {
              logger.error(
                '[SMTP] Failed to record permanent bounce suppression:',
                suppressErr.message || suppressErr
              );
            }
            error.isPermanentBounce = true;
            throw error;
          }

          if (classification === 'transient' && attempt < maxRetries) {
            this.recreateTransporter(provider);
            const delay = baseDelayMs * Math.pow(2, attempt - 1);
            logger.info(
              `[SMTP] Transient failure on ${provider.name}; retrying in ${delay}ms` +
              ` (attempt ${attempt}/${maxRetries}, attemptElapsed=${Date.now() - attemptStarted}ms)`
            );
            await sleep(delay);
            continue;
          }

          // Non-transient provider failure, or transient retries exhausted → try next provider
          break;
        }
      }
    }

    const totalMs = Date.now() - startedAt;
    logger.error(
      `All SMTP providers failed to send email. totalRetries=${totalRetryCount} elapsedMs=${totalMs}` +
      (lastError ? ` lastError=${lastError.message || lastError}` : '')
    );
    throw lastError || new Error('All SMTP providers failed to send email.');
  }

  /**
   * Verify primary (and optionally secondary) SMTP connectivity at startup.
   */
  async verifyConfig({ includeSecondary = false } = {}) {
    const providers = this.getProviders();
    if (!providers.length) {
      logger.error('[SMTP] No providers configured for verification.');
      return false;
    }

    const toCheck = includeSecondary ? providers : providers.slice(0, 1);
    let allOk = true;
    for (const provider of toCheck) {
      try {
        await this.getTransporter(provider).verify();
        logger.info(
          `[SMTP] ${provider.name} configuration verified (${provider.host}:${provider.port}).`
        );
      } catch (error) {
        allOk = false;
        logger.error(
          `[SMTP] ${provider.name} verification failed:`,
          error.message
        );
      }
    }
    return allOk;
  }
}

const smtpDeliveryService = new SmtpDeliveryService();

module.exports = smtpDeliveryService;
module.exports.SmtpDeliveryService = SmtpDeliveryService;
module.exports.classifySmtpError = classifySmtpError;
module.exports.loadProvidersFromEnv = loadProvidersFromEnv;
module.exports.applyProviderFrom = applyProviderFrom;
