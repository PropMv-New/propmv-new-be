/**
 * Poll system IMAP inbox for bounce / DSN messages and suppress bad recipients.
 *
 * Env:
 *   EMAIL_BOUNCE_IMAP_ENABLED   (default false)
 *   EMAIL_BOUNCE_IMAP_HOST      (default imap.hostinger.com)
 *   EMAIL_BOUNCE_IMAP_PORT      (default 993)
 *   EMAIL_BOUNCE_IMAP_USER      (default SMTP_PRIMARY_USER)
 *   EMAIL_BOUNCE_IMAP_PASSWORD  (default SMTP_PRIMARY_PASSWORD)
 *   EMAIL_BOUNCE_IMAP_MAILBOX   (default INBOX)
 *   EMAIL_BOUNCE_IMAP_POLL_MS   (default 300000 = 5m)
 *   EMAIL_BOUNCE_IMAP_MARK_SEEN (default true)
 *   EMAIL_BOUNCE_IMAP_LOOKBACK_DAYS (default 14) - also scan recent mail, not only UNSEEN
 *   EMAIL_BOUNCE_IMAP_MAX_MESSAGES (default 100) - cap per poll
 */

const Imap = require('imap');
const logger = require('../logger');
const { simpleParser } = require('mailparser');
const { ingestBounceNotification } = require('./emailBounceIngest.service');

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

/**
 * Replace any occurrence of a known secret value in a string with "[REDACTED]".
 * Used to prevent mailbox passwords leaking into logs via error messages.
 */
function redactSecret(str, ...secrets) {
  let out = String(str || '');
  for (const s of secrets) {
    if (s && s.length >= 4) {
      out = out.split(s).join('[REDACTED]');
    }
  }
  return out;
}

function getImapConfig() {
  const user = envStr('EMAIL_BOUNCE_IMAP_USER', 'SMTP_PRIMARY_USER', 'SMTP_USER');
  const password = envStr(
    'EMAIL_BOUNCE_IMAP_PASSWORD',
    'SMTP_PRIMARY_PASSWORD',
    'SMTP_PRIMARY_PASS',
    'SMTP_PASS'
  );
  const host = envStr('EMAIL_BOUNCE_IMAP_HOST') || 'imap.hostinger.com';
  const port = envInt('EMAIL_BOUNCE_IMAP_PORT', 993);
  return { user, password, host, port };
}

function providerKeyFor(cfg, mailbox) {
  return `${cfg.host}:${cfg.port}:${cfg.user}:${mailbox}`;
}

function openImap() {
  const cfg = getImapConfig();
  if (!cfg.user || !cfg.password || !cfg.host) {
    const err = new Error('Bounce IMAP is not fully configured');
    err.code = 'EBOUNCEIMAPCONFIG';
    throw err;
  }
  return new Imap({
    user: cfg.user,
    password: cfg.password,
    host: cfg.host,
    port: cfg.port,
    tls: true,
    tlsOptions: { rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== 'false' },
  });
}

function imapSearch(imap, criteria) {
  return new Promise((resolve, reject) => {
    imap.search(criteria, (err, results) => {
      if (err) return reject(err);
      resolve(results || []);
    });
  });
}

function formatImapDate(date) {
  // IMAP SINCE uses e.g. 17-Jul-2026
  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).replace(/ /g, '-');
}

async function collectCandidateUids(imap) {
  const lookbackDays = envInt('EMAIL_BOUNCE_IMAP_LOOKBACK_DAYS', 14);
  const maxMessages = envInt('EMAIL_BOUNCE_IMAP_MAX_MESSAGES', 100);

  const unseenRaw = await imapSearch(imap, ['UNSEEN']);
  const unseenSet = new Set((unseenRaw || []).map((uid) => Number(uid)));

  /** @type {number[]} */
  let lookbackIds = [];
  if (lookbackDays > 0) {
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
    const sinceStr = formatImapDate(since);
    try {
      const recent = await imapSearch(imap, [['SINCE', sinceStr]]);
      lookbackIds = (recent || [])
        .map((uid) => Number(uid))
        .filter((uid) => Number.isFinite(uid) && !unseenSet.has(uid));
    } catch (err) {
      logger.warn('[BounceImap] SINCE search failed, continuing with UNSEEN only:', err.message);
    }
  }

  // UNSEEN first (newest first - active bounces), then oldest lookback to drain history
  // instead of always re-scanning the same newest N messages.
  const unseenNewestFirst = Array.from(unseenSet)
    .filter((uid) => Number.isFinite(uid))
    .sort((a, b) => b - a);
  const lookbackOldestFirst = lookbackIds.sort((a, b) => a - b);

  const result = [];
  for (const uid of unseenNewestFirst) {
    if (result.length >= maxMessages) break;
    result.push(uid);
  }
  for (const uid of lookbackOldestFirst) {
    if (result.length >= maxMessages) break;
    result.push(uid);
  }
  return result;
}

function fetchMessageSource(imap, uid) {
  return new Promise((resolve, reject) => {
    const f = imap.fetch(uid, { bodies: '', markSeen: false });
    let raw = Buffer.alloc(0);
    f.on('message', (msg) => {
      msg.on('body', (stream) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => {
          raw = Buffer.concat(chunks);
        });
      });
    });
    f.once('error', reject);
    f.once('end', () => resolve(raw));
  });
}

function markSeen(imap, uid) {
  return new Promise((resolve, reject) => {
    imap.addFlags(uid, '\\Seen', (err) => (err ? reject(err) : resolve()));
  });
}

async function wasAlreadyProcessed(providerKey, messageUid) {
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) return false;
    const EmailBounceProcessed = require('../models/emailBounceProcessed.model');
    const row = await EmailBounceProcessed.findOne({
      providerKey,
      messageUid: String(messageUid),
    })
      .select('_id')
      .lean();
    return Boolean(row);
  } catch {
    return false;
  }
}

async function markProcessed({
  providerKey,
  messageUid,
  messageId,
  recipientEmail,
  subject,
  suppressed,
}) {
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) return;
    const EmailBounceProcessed = require('../models/emailBounceProcessed.model');
    await EmailBounceProcessed.findOneAndUpdate(
      { providerKey, messageUid: String(messageUid) },
      {
        $set: {
          providerKey,
          messageUid: String(messageUid),
          messageId: String(messageId || '').slice(0, 300),
          recipientEmail: String(recipientEmail || ''),
          subject: String(subject || '').slice(0, 300),
          suppressed: Boolean(suppressed),
          processedAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    logger.warn('[BounceImap] Failed to mark processed:', err.message || err);
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label || 'IMAP operation'} timed out after ${ms}ms`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * One poll cycle.
 * @returns {Promise<{ scanned: number, suppressed: number, skippedExisting?: number }>}
 */
async function pollBounceMailboxOnce() {
  if (!envBool('EMAIL_BOUNCE_IMAP_ENABLED', false)) {
    return { scanned: 0, suppressed: 0, skipped: true };
  }

  const timeoutMs = envInt('EMAIL_BOUNCE_IMAP_TIMEOUT_MS', 90000);
  return withTimeout(pollBounceMailboxOnceInner(), timeoutMs, 'IMAP bounce poll');
}

async function pollBounceMailboxOnceInner() {
  const mailbox = envStr('EMAIL_BOUNCE_IMAP_MAILBOX') || 'INBOX';
  const markSeenFlag = envBool('EMAIL_BOUNCE_IMAP_MARK_SEEN', true);
  const cfg = getImapConfig();
  const pKey = providerKeyFor(cfg, mailbox);
  const imap = openImap();
  const connectTimeoutMs = envInt('EMAIL_BOUNCE_IMAP_CONNECT_TIMEOUT_MS', 20000);

  const { password: _imapPassword } = getImapConfig();
  try {
    await withTimeout(
      new Promise((resolve, reject) => {
        imap.once('ready', resolve);
        imap.once('error', reject);
        imap.connect();
      }),
      connectTimeoutMs,
      'IMAP connect'
    );
  } catch (connectErr) {
    try {
      imap.destroy();
    } catch {
      /* ignore */
    }
    connectErr.message = redactSecret(connectErr.message, _imapPassword);
    throw connectErr;
  }

  try {
    await withTimeout(
      new Promise((resolve, reject) => {
        imap.openBox(mailbox, false, (err) => (err ? reject(err) : resolve()));
      }),
      connectTimeoutMs,
      'IMAP openBox'
    );

    const uids = await collectCandidateUids(imap);
    let suppressed = 0;
    let skippedExisting = 0;
    let scannedBounces = 0;

    for (const uid of uids) {
      try {
        if (await wasAlreadyProcessed(pKey, uid)) {
          skippedExisting += 1;
          continue;
        }

        const rawBuf = await fetchMessageSource(imap, uid);
        const parsed = await simpleParser(rawBuf);
        const subject = parsed.subject || '';
        const text = parsed.text || '';
        const html = typeof parsed.html === 'string' ? parsed.html : '';
        const from = String(parsed.from?.text || '').toLowerCase();
        const messageId = parsed.messageId || '';

        const looksBounce =
          /mailer-daemon|postmaster|mail delivery|undeliverable|delivery status|returned to sender/i.test(
            subject
          ) ||
          /mailer-daemon|postmaster/i.test(from) ||
          /550|5\.1\.1|does not exist|undeliverable|user unknown/i.test(`${subject}\n${text}`);

        if (!looksBounce) {
          // Mark non-bounce candidates in lookback so we don't re-parse forever
          if (envInt('EMAIL_BOUNCE_IMAP_LOOKBACK_DAYS', 14) > 0) {
            await markProcessed({
              providerKey: pKey,
              messageUid: uid,
              messageId,
              recipientEmail: '',
              subject,
              suppressed: false,
            });
          }
          continue;
        }

        scannedBounces += 1;
        const result = await ingestBounceNotification({
          subject,
          text,
          html,
          raw: rawBuf.toString('utf8').slice(0, 20000),
          source: 'bounce_imap',
          metadata: { uid, mailbox },
        });

        if (result.suppressed) suppressed += 1;

        await markProcessed({
          providerKey: pKey,
          messageUid: uid,
          messageId,
          recipientEmail: result.email || '',
          subject,
          suppressed: Boolean(result.suppressed),
        });

        if (markSeenFlag) {
          await markSeen(imap, uid);
        }
      } catch (msgErr) {
        const { password: _pw } = getImapConfig();
        logger.warn(`[BounceImap] Failed processing uid=${uid}:`, redactSecret(msgErr.message || String(msgErr), _pw));
      }
    }

    logger.info(
      `[BounceImap] poll complete candidates=${uids.length} bounceCandidates=${scannedBounces}` +
      ` suppressed=${suppressed} skippedExisting=${skippedExisting} mailbox=${mailbox}`
    );
    return {
      scanned: uids.length,
      bounceCandidates: scannedBounces,
      suppressed,
      skippedExisting,
    };
  } finally {
    try {
      imap.end();
    } catch {
      // ignore
    }
  }
}

let pollTimer = null;
let pollInFlight = false;
let consecutiveAuthFailures = 0;
const MAX_CONSECUTIVE_AUTH_FAILURES = 3;

function startBounceImapPoller() {
  if (!envBool('EMAIL_BOUNCE_IMAP_ENABLED', false)) {
    logger.info('[BounceImap] Poller disabled (EMAIL_BOUNCE_IMAP_ENABLED!=true)');
    return { started: false };
  }

  const intervalMs = Math.max(60000, envInt('EMAIL_BOUNCE_IMAP_POLL_MS', 300000));
  if (pollTimer) {
    return { started: true, alreadyRunning: true, intervalMs };
  }

  const run = async () => {
    if (pollInFlight) return;
    if (consecutiveAuthFailures >= MAX_CONSECUTIVE_AUTH_FAILURES) {
      logger.warn(
        `[BounceImap] Poller suspended after ${consecutiveAuthFailures} consecutive auth failures. ` +
        'Fix EMAIL_BOUNCE_IMAP_PASSWORD or disable EMAIL_BOUNCE_IMAP_ENABLED.'
      );
      stopBounceImapPoller();
      return;
    }
    pollInFlight = true;
    try {
      await pollBounceMailboxOnce();
      consecutiveAuthFailures = 0;
    } catch (err) {
      const msg = String(err.message || err).toLowerCase();
      if (msg.includes('authentication failed') || msg.includes('invalid credentials') || msg.includes('login failed')) {
        consecutiveAuthFailures += 1;
        logger.warn(
          `[BounceImap] Auth failure ${consecutiveAuthFailures}/${MAX_CONSECUTIVE_AUTH_FAILURES}: ${err.message}. ` +
          'Ensure IMAP access is enabled in Zoho Mail settings and the password is correct.'
        );
      } else {
        logger.warn('[BounceImap] Poll failed:', err.message || err);
      }
    } finally {
      pollInFlight = false;
    }
  };

  // Initial delayed run so DB/SMTP startup settles
  setTimeout(run, 15000);
  pollTimer = setInterval(run, intervalMs);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();

  logger.info(`[BounceImap] Poller started intervalMs=${intervalMs}`);
  return { started: true, intervalMs };
}

function stopBounceImapPoller() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

module.exports = {
  pollBounceMailboxOnce,
  startBounceImapPoller,
  stopBounceImapPoller,
  getImapConfig,
};
