/**
 * Free mailbox probe via SMTP RCPT TO against the recipient's MX.
 * Catches cases MX cannot (valid domain, nonexistent local-part) - e.g. Gmail 550 5.1.1 -
 * without consuming Hostinger/Mailchannels sending quota.
 *
 * Env:
 *   EMAIL_SMTP_RCPT_VERIFY_ENABLED     (default false)
 *   EMAIL_SMTP_RCPT_VERIFY_TIMEOUT_MS  (default 8000)
 *   EMAIL_SMTP_RCPT_VERIFY_CACHE_TTL_MS (default 86400000 = 24h)
 *   EMAIL_SMTP_RCPT_VERIFY_ON_ERROR    allow | reject (default allow)
 *   EMAIL_SMTP_RCPT_VERIFY_FROM        MAIL FROM address (default FROM_EMAIL / SMTP_PRIMARY_FROM)
 *   EMAIL_SMTP_RCPT_VERIFY_PORT        (default 25)
 *   EMAIL_SMTP_RCPT_VERIFY_MAX_MX      (default 2)
 *   EMAIL_SMTP_RCPT_VERIFY_STARTTLS   (default true)
 *   SMTP_TLS_REJECT_UNAUTHORIZED       (default true; set false only for diagnostics)
 *
 * Note: outbound port 25 must be open from the app host. If blocked, ON_ERROR=allow
 * keeps invites working and you should enable EMAIL_MAILBOX_VERIFY_* instead.
 */

const net = require('net');
const tls = require('tls');
const logger = require('../logger');

/** @type {Map<string, { ok: boolean, status: string, code?: number, expiresAt: number }>} */
const rcptCache = new Map();

/** @type {null | ((opts: object) => Promise<{ ok: boolean, status: string, code?: number, response?: string }>)} */
let probeOverride = null;
let warnedInsecureStartTls = false;

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

function envStr(...names) {
  for (const name of names) {
    const v = process.env[name];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function isEnabled() {
  return envBool('EMAIL_SMTP_RCPT_VERIFY_ENABLED', false);
}

function resolveTlsRejectUnauthorized({ log = true } = {}) {
  const rejectUnauthorized = envBool('SMTP_TLS_REJECT_UNAUTHORIZED', true);
  if (!rejectUnauthorized && log && !warnedInsecureStartTls) {
    warnedInsecureStartTls = true;
    logger.warn(
      '[EmailValidation] SMTP RCPT STARTTLS certificate verification disabled via SMTP_TLS_REJECT_UNAUTHORIZED=false'
    );
  }
  return rejectUnauthorized;
}

function resolveFromAddress() {
  return (
    envStr('EMAIL_SMTP_RCPT_VERIFY_FROM', 'FROM_EMAIL', 'SMTP_PRIMARY_FROM') ||
    'noreply@localhost'
  );
}

/**
 * @param {number} code
 * @returns {'accept'|'reject'|'temp'|'unknown'}
 */
function classifyRcptCode(code) {
  const n = Number(code);
  if (n === 250 || n === 251) return 'accept';
  if (n === 252) return 'unknown';
  if (n >= 550 && n <= 559) return 'reject';
  if (n === 521 || n === 553 || n === 554 || n === 501 || n === 503) return 'reject';
  if (n >= 500 && n <= 599) return 'reject';
  if (n >= 400 && n <= 499) return 'temp';
  return 'unknown';
}

/**
 * Read one complete SMTP reply (handles multiline 250-... / 250 ...).
 * @param {import('net').Socket} socket
 * @param {number} timeoutMs
 */
function readSmtpReply(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const lines = [];

    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };

    const timer = setTimeout(() => {
      cleanup();
      const err = new Error(`SMTP reply timed out after ${timeoutMs}ms`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);

    const onError = (err) => {
      cleanup();
      reject(err);
    };

    const onClose = () => {
      cleanup();
      const err = new Error('SMTP connection closed before reply');
      err.code = 'ECONNRESET';
      reject(err);
    };

    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const rawLine = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!rawLine) continue;
        lines.push(rawLine);
        const m = rawLine.match(/^(\d{3})([\s-])/);
        if (m && m[2] === ' ') {
          cleanup();
          resolve({
            code: Number(m[1]),
            lines: [...lines],
            text: lines.join('\n'),
          });
          return;
        }
      }
    };

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

function writeLine(socket, line) {
  socket.write(`${line}\r\n`);
}

/**
 * @param {import('net').Socket} socket
 * @param {string} email
 * @param {string} fromAddress
 * @param {number} timeoutMs
 * @param {boolean} useStartTls
 */
async function runRcptDialogue(socket, email, fromAddress, timeoutMs, useStartTls) {
  const banner = await readSmtpReply(socket, timeoutMs);
  if (banner.code >= 400) {
    return { ok: false, status: 'banner_error', code: banner.code, response: banner.text };
  }

  writeLine(socket, `EHLO propmv-verify`);
  let ehlo = await readSmtpReply(socket, timeoutMs);
  if (ehlo.code >= 400) {
    writeLine(socket, `HELO propmv-verify`);
    ehlo = await readSmtpReply(socket, timeoutMs);
  }

  let active = socket;
  const supportsStartTls =
    useStartTls &&
    ehlo.lines.some((l) => /\bSTARTTLS\b/i.test(l)) &&
    typeof socket !== 'undefined';

  if (supportsStartTls && !socket.encrypted) {
    writeLine(socket, 'STARTTLS');
    const tlsReply = await readSmtpReply(socket, timeoutMs);
    if (tlsReply.code === 220) {
      active = await new Promise((resolve, reject) => {
        const upgraded = tls.connect({
          socket,
          servername: socket.servername || undefined,
          rejectUnauthorized: resolveTlsRejectUnauthorized(),
        });
        upgraded.once('secureConnect', () => resolve(upgraded));
        upgraded.once('error', reject);
      });
      writeLine(active, `EHLO propmv-verify`);
      ehlo = await readSmtpReply(active, timeoutMs);
    }
  }

  writeLine(active, `MAIL FROM:<${fromAddress}>`);
  const mailFrom = await readSmtpReply(active, timeoutMs);
  if (mailFrom.code >= 400) {
    try {
      writeLine(active, 'QUIT');
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      status: 'mail_from_rejected',
      code: mailFrom.code,
      response: mailFrom.text,
    };
  }

  writeLine(active, `RCPT TO:<${email}>`);
  const rcpt = await readSmtpReply(active, timeoutMs);

  try {
    writeLine(active, 'QUIT');
    await readSmtpReply(active, Math.min(2000, timeoutMs)).catch(() => null);
  } catch {
    /* ignore */
  }
  try {
    active.destroy();
  } catch {
    /* ignore */
  }

  const kind = classifyRcptCode(rcpt.code);
  if (kind === 'accept') {
    return { ok: true, status: 'accept', code: rcpt.code, response: rcpt.text };
  }
  if (kind === 'reject') {
    return { ok: false, status: 'reject', code: rcpt.code, response: rcpt.text };
  }
  if (kind === 'temp') {
    return { ok: true, status: 'temp_allowed', code: rcpt.code, response: rcpt.text };
  }
  return { ok: true, status: 'unknown_allowed', code: rcpt.code, response: rcpt.text };
}

function connectPlain(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      const err = new Error(`SMTP connect timed out to ${host}:${port}`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.setTimeout(timeoutMs);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function probeMxHosts(email, mxHosts) {
  const timeoutMs = envInt('EMAIL_SMTP_RCPT_VERIFY_TIMEOUT_MS', 8000);
  const port = envInt('EMAIL_SMTP_RCPT_VERIFY_PORT', 25);
  const maxMx = envInt('EMAIL_SMTP_RCPT_VERIFY_MAX_MX', 2);
  const useStartTls = envBool('EMAIL_SMTP_RCPT_VERIFY_STARTTLS', true);
  const fromAddress = resolveFromAddress();
  const hosts = (Array.isArray(mxHosts) ? mxHosts : [])
    .map((h) => String(h || '').replace(/\.$/, '').toLowerCase())
    .filter(Boolean)
    .slice(0, Math.max(1, maxMx));

  if (hosts.length === 0) {
    return { ok: true, status: 'no_mx_skipped', skipped: true };
  }

  let lastError = null;
  for (const host of hosts) {
    let socket;
    try {
      socket = await connectPlain(host, port, timeoutMs);
      socket.servername = host;
      const result = await runRcptDialogue(socket, email, fromAddress, timeoutMs, useStartTls);
      if (result.status === 'reject') return result;
      if (result.ok) return result;
      lastError = result;
    } catch (err) {
      lastError = err;
      try {
        socket?.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  const onError = String(process.env.EMAIL_SMTP_RCPT_VERIFY_ON_ERROR || 'allow').toLowerCase();
  if (onError === 'reject') {
    return {
      ok: false,
      status: 'error',
      response: String(lastError?.message || lastError?.response || 'probe_failed'),
    };
  }
  return {
    ok: true,
    status: 'error_allowed',
    response: String(lastError?.message || lastError?.response || 'probe_failed'),
  };
}

/**
 * @param {string} email normalized address
 * @param {string[]} [mxHosts]
 */
async function verifyMailboxViaSmtpRcpt(email, mxHosts = []) {
  if (!isEnabled()) {
    return { ok: true, status: 'disabled', skipped: true };
  }

  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) {
    return { ok: false, status: 'invalid' };
  }

  const cacheTtl = envInt('EMAIL_SMTP_RCPT_VERIFY_CACHE_TTL_MS', 86400000);
  const cached = rcptCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      ok: cached.ok,
      status: cached.status,
      code: cached.code,
      fromCache: true,
    };
  }

  const result = probeOverride
    ? await probeOverride({ email: normalized, mxHosts })
    : await probeMxHosts(normalized, mxHosts);

  if (!result.skipped && result.status !== 'error_allowed' && result.status !== 'no_mx_skipped') {
    rcptCache.set(normalized, {
      ok: Boolean(result.ok),
      status: result.status || '',
      code: result.code,
      expiresAt: Date.now() + (result.ok ? cacheTtl : Math.min(cacheTtl, 3600000)),
    });
  }

  return result;
}

function clearSmtpRcptVerifyCache(email) {
  if (email == null || email === '') {
    rcptCache.clear();
    return;
  }
  rcptCache.delete(String(email).trim().toLowerCase());
}

/** Test hook - pass null to restore real probe. */
function setSmtpRcptProbeOverride(fn) {
  probeOverride = typeof fn === 'function' ? fn : null;
}

function logProductionEmailSafetyWarning() {
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  if (env !== 'production') return;
  const mailboxOn = envBool('EMAIL_MAILBOX_VERIFY_ENABLED', false);
  const rcptOn = isEnabled();
  if (!mailboxOn && !rcptOn) {
    logger.warn(
      '[EmailValidation] Production warning: neither EMAIL_SMTP_RCPT_VERIFY_ENABLED nor EMAIL_MAILBOX_VERIFY_ENABLED is on. ' +
      'Nonexistent Gmail locals can still bounce via Hostinger. Enable SMTP RCPT verify (free) or a mailbox API.'
    );
  }
  if (!String(process.env.EMAIL_BOUNCE_WEBHOOK_SECRET || '').trim()) {
    logger.warn(
      '[EmailValidation] Production warning: EMAIL_BOUNCE_WEBHOOK_SECRET is empty - bounce webhook / suppressions API are disabled.'
    );
  }
}

module.exports = {
  isEnabled,
  verifyMailboxViaSmtpRcpt,
  classifyRcptCode,
  clearSmtpRcptVerifyCache,
  setSmtpRcptProbeOverride,
  logProductionEmailSafetyWarning,
  resolveFromAddress,
  resolveTlsRejectUnauthorized,
};
