/**
 * Resolves dynamic From/Reply-To envelope for HOA community-generated emails.
 *
 * From address always uses FROM_EMAIL (e.g. noreply@propmv.com).
 * From name uses the community name when available.
 * Reply-To prefers the acting sender, then HOA board contact, then REPLY_TO env.
 *
 * Env:
 *   COMMUNITY_EMAIL_CONTEXT_TIMEOUT_MS  (default 2000) - max wait for HOA/User lookups
 *   COMMUNITY_EMAIL_CONTEXT_CACHE_TTL_MS (default 300000 = 5m) - per-hoaId contact cache
 */

const mongoose = require('mongoose');
const User = require('../../shared/modules/users/models/user.model');
const HOA = require('../../portals/hoa-board/modules/hoa/model/hoa.model');
const HOAMembership = require('../../portals/hoa-board/modules/hoa/model/hoaMembership.model');
const logger = require('../logger');

const DEFAULT_LOOKUP_TIMEOUT_MS = 2000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

/** @type {Map<string, { expiresAt: number, value: object | null }>} */
const hoaContactCache = new Map();

function envPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function withLookupTimeout(promise, label) {
  const timeoutMs = envPositiveInt(
    'COMMUNITY_EMAIL_CONTEXT_TIMEOUT_MS',
    DEFAULT_LOOKUP_TIMEOUT_MS
  );
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(
        `${label || 'Community email context lookup'} timed out after ${timeoutMs}ms`
      );
      err.code = 'ECOMMUNITY_EMAIL_CONTEXT_TIMEOUT';
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function getCachedHoaContact(hoaId) {
  const key = String(hoaId);
  const entry = hoaContactCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    hoaContactCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCachedHoaContact(hoaId, value) {
  const ttlMs = envPositiveInt(
    'COMMUNITY_EMAIL_CONTEXT_CACHE_TTL_MS',
    DEFAULT_CACHE_TTL_MS
  );
  hoaContactCache.set(String(hoaId), {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

function clearCommunityEmailContextCacheForTests() {
  hoaContactCache.clear();
}

function getDefaultFromAddress() {
  return (
    process.env.FROM_EMAIL ||
    process.env.SMTP_PRIMARY_FROM ||
    process.env.SUPPORT_TEAM_EMAIL ||
    'noreply@propmv.com'
  ).trim();
}

function getDefaultFromName() {
  return (process.env.FROM_NAME || 'PropMv').trim();
}

function getDefaultReplyToAddress() {
  return (
    process.env.REPLY_TO_EMAIL ||
    process.env.REPLY_TO ||
    process.env.SUPPORT_TEAM_EMAIL ||
    'support@propmv.com'
  ).trim();
}

function getDefaultReplyToName() {
  return (process.env.REPLY_TO_NAME || process.env.FROM_NAME || 'PropMv').trim();
}

function displayName(user) {
  if (!user) return '';
  const name = `${user.firstName || ''} ${user.lastName || ''}`.trim();
  return name || String(user.email || '').split('@')[0] || '';
}

function formatReplyTo({ name, email }) {
  const address = String(email || '').trim();
  if (!address) return null;
  const label = String(name || '').trim();
  if (label) return { name: label, address };
  return address;
}

function isCommunityContext({ hoaId, communityName }) {
  return Boolean(hoaId || String(communityName || '').trim());
}

async function loadUserContact(userId) {
  if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) return null;
  try {
    const user = await withLookupTimeout(
      User.findById(userId).select('email firstName lastName isDeleted').lean(),
      'User.findById'
    );
    if (!user || user.isDeleted || !user.email) return null;
    return { name: displayName(user), email: String(user.email).trim() };
  } catch (err) {
    logger.warn(
      `[communityEmailContext] User contact lookup failed for ${userId}: ${err.message}`
    );
    return null;
  }
}

async function resolveHoaBoardContactInner(hoaId) {
  const hoa = await Promise.resolve(HOA.findById(hoaId).select('name createdBy').lean());
  if (!hoa) return null;

  const adminMembership = await HOAMembership.findOne({
    hoaId,
    status: 'active',
    role: 'admin',
    userId: { $ne: null },
  })
    .sort({ createdAt: 1 })
    .select('userId')
    .lean();

  if (adminMembership?.userId) {
    const admin = await loadUserContact(adminMembership.userId);
    if (admin) {
      return { communityName: hoa.name, contact: admin };
    }
  }

  if (hoa.createdBy) {
    const creator = await loadUserContact(hoa.createdBy);
    if (creator) {
      return { communityName: hoa.name, contact: creator };
    }
  }

  const memberMembership = await HOAMembership.findOne({
    hoaId,
    status: 'active',
    userId: { $ne: null },
  })
    .sort({ createdAt: 1 })
    .select('userId')
    .lean();

  if (memberMembership?.userId) {
    const member = await loadUserContact(memberMembership.userId);
    if (member) {
      return { communityName: hoa.name, contact: member };
    }
  }

  return { communityName: hoa.name, contact: null };
}

/**
 * Resolve HOA board reply-to contact with timeout, cache, and safe fallback.
 * On timeout/DB error returns null so callers fall back to env-based reply-to.
 */
async function resolveHoaBoardContact(hoaId) {
  if (!hoaId || !mongoose.Types.ObjectId.isValid(String(hoaId))) return null;

  const cached = getCachedHoaContact(hoaId);
  if (cached !== undefined) return cached;

  try {
    const result = await withLookupTimeout(
      resolveHoaBoardContactInner(hoaId),
      'resolveHoaBoardContact'
    );
    setCachedHoaContact(hoaId, result);
    return result;
  } catch (err) {
    logger.warn(
      `[communityEmailContext] HOA contact lookup failed for ${hoaId}: ${err.message}`
    );
    return null;
  }
}

/**
 * Resolve the HOA community display name for email subjects and branding.
 * Uses a direct HOA name lookup so subjects stay correct even when board contact resolution times out.
 */
async function resolveCommunityName(hoaId, communityNameHint = '') {
  const hint = String(communityNameHint || '').trim();
  if (hint) return hint;
  if (!hoaId || !mongoose.Types.ObjectId.isValid(String(hoaId))) return '';

  try {
    const hoa = await withLookupTimeout(
      HOA.findById(hoaId).select('name').lean(),
      'resolveCommunityName'
    );
    return hoa?.name ? String(hoa.name).trim() : '';
  } catch (err) {
    logger.warn(
      `[communityEmailContext] Community name lookup failed for ${hoaId}: ${err.message}`
    );
    const cached = getCachedHoaContact(hoaId);
    if (cached?.communityName) return String(cached.communityName).trim();
    return '';
  }
}

/** Append community name to transactional email subjects for HOA owner notifications. */
function buildCommunityEmailSubject(base, communityName) {
  const subjectBase = String(base || '').trim();
  const name = String(communityName || '').trim();
  if (!subjectBase) return name;
  if (!name) return subjectBase;
  return `${subjectBase} - ${name}`;
}

/**
 * Build from/reply-to envelope for a community email.
 * Returns null when the send is not community-scoped.
 */
async function resolveCommunityEmailEnvelope({
  hoaId = null,
  communityName = null,
  senderUserId = null,
  replyTo = null,
  fromName = null,
} = {}) {
  const trimmedCommunityName = String(communityName || '').trim();
  if (!isCommunityContext({ hoaId, communityName: trimmedCommunityName })) {
    return null;
  }

  const fromAddress = getDefaultFromAddress();
  let resolvedCommunityName = trimmedCommunityName;
  let boardContact = null;

  if (hoaId) {
    const hoaContext = await resolveHoaBoardContact(hoaId);
    if (hoaContext) {
      resolvedCommunityName = resolvedCommunityName || hoaContext.communityName || '';
      boardContact = hoaContext.contact;
    }
  }

  const resolvedFromName =
    String(fromName || '').trim() ||
    resolvedCommunityName ||
    getDefaultFromName();

  const senderContact = senderUserId ? await loadUserContact(senderUserId) : null;

  let resolvedReplyTo = replyTo || null;
  if (!resolvedReplyTo) {
    if (senderContact?.email) {
      resolvedReplyTo = formatReplyTo(senderContact);
    } else if (boardContact?.email) {
      resolvedReplyTo = formatReplyTo(boardContact);
    } else {
      resolvedReplyTo = formatReplyTo({
        name: getDefaultReplyToName(),
        email: getDefaultReplyToAddress(),
      });
    }
  }

  return {
    from: { name: resolvedFromName, address: fromAddress },
    replyTo: resolvedReplyTo,
    communityName: resolvedCommunityName || null,
  };
}

/**
 * Apply community envelope to nodemailer mail options when context is present.
 * DB lookup failures/timeouts never block the send - env reply-to is used instead.
 */
async function applyCommunityEnvelope(mailOptions, context = {}) {
  const envelope = await resolveCommunityEmailEnvelope(context);
  if (!envelope) return mailOptions;

  const next = { ...mailOptions, from: envelope.from };
  if (!context.replyTo && envelope.replyTo) {
    next.replyTo = envelope.replyTo;
  }
  return next;
}

module.exports = {
  applyCommunityEnvelope,
  resolveCommunityEmailEnvelope,
  resolveHoaBoardContact,
  resolveCommunityName,
  buildCommunityEmailSubject,
  getDefaultFromAddress,
  getDefaultFromName,
  getDefaultReplyToAddress,
  formatReplyTo,
  isCommunityContext,
  clearCommunityEmailContextCacheForTests,
};
