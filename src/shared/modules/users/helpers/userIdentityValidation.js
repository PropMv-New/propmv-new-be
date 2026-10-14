/**
 * ------------------------------------------------------------------
 * File: userIdentityValidation.js
 * Module: Users Module
 *
 * Purpose:
 * Backend utility/module providing helper functions for userIdentityValidation.
 *
 * Used By:
 * ownerIdentityValidation, tenant.service, auth.controller, auth.service
 * ------------------------------------------------------------------
 */

const User = require('../models/user.model');

const DUPLICATE_EMAIL_MESSAGE = 'This email address is already associated with another account.';
const DUPLICATE_PHONE_MESSAGE = 'This phone number is already associated with another account.';

/**
 * normalize User Email
 *
 * Performs logic operations for normalizeUserEmail.
 *
 * @param email - Request/input argument
 * @returns Operations result
 */
function normalizeUserEmail(email) {
  if (!email || !String(email).trim()) return '';
  return String(email).trim().toLowerCase();
}

/**
 * normalize User Phone
 *
 * Performs logic operations for normalizeUserPhone.
 *
 * @param phone - Request/input argument
 * @returns Operations result
 */
function normalizeUserPhone(phone) {
  if (!phone || !String(phone).trim()) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

/** Unique placeholder so the real email can be reused after soft-delete (MongoDB unique index on email). */
function buildReleasedUserEmail(userId) {
  const id = String(userId).toLowerCase();
  return `deleted+${id}@deleted.propmv.internal`;
}

/** @deprecated Legacy helper - soft-deleted users now retain their email; partial unique index handles reuse. */
async function releaseUserIdentity(userId, session) {
  if (!userId) return;
  const releasedEmail = buildReleasedUserEmail(userId);
  const update = {
    $set: { email: releasedEmail },
    $unset: { refreshToken: '' },
  };
  if (session) {
    await User.findByIdAndUpdate(userId, update).session(session);
  } else {
    await User.findByIdAndUpdate(userId, update);
  }
}

/** Free email held by soft-deleted users created before identity release on delete. */
async function releaseStaleDeletedUserEmail(email, session) {
  const normalized = normalizeUserEmail(email);
  if (!normalized) return;
  const query = { email: normalized, isDeleted: true };
  const stale = session
    ? await User.find(query).select('_id').session(session).lean()
    : await User.find(query).select('_id').lean();
  await Promise.all(stale.map((row) => releaseUserIdentity(row._id, session)));
}

async function findUserByEmail(email, excludeUserId, session) {
  const normalized = normalizeUserEmail(email);
  if (!normalized) return null;
  const query = {
    email: normalized,
    isDeleted: { $ne: true },
    ...(excludeUserId ? { _id: { $ne: excludeUserId } } : {}),
  };
  return session ? User.findOne(query).session(session) : User.findOne(query);
}

async function findUserByPhone(phone, excludeUserId, session) {
  const normalized = normalizeUserPhone(phone);
  if (!normalized || normalized.length < 10) return null;

  const query = {
    isDeleted: { $ne: true },
    phone: { $exists: true, $nin: [null, ''] },
    ...(excludeUserId ? { _id: { $ne: excludeUserId } } : {}),
  };

  const candidates = session
    ? await User.find(query).select('_id phone').session(session).lean()
    : await User.find(query).select('_id phone').lean();

  return candidates.find((user) => normalizeUserPhone(user.phone) === normalized) || null;
}

async function assertUniqueUserEmail(email, excludeUserId, session) {
  const existing = await findUserByEmail(email, excludeUserId, session);
  if (existing) {
    const err = new Error(DUPLICATE_EMAIL_MESSAGE);
    err.status = 409;
    err.field = 'email';
    throw err;
  }
}

async function assertUniqueUserPhone(phone, excludeUserId, session) {
  const existing = await findUserByPhone(phone, excludeUserId, session);
  if (existing) {
    const err = new Error(DUPLICATE_PHONE_MESSAGE);
    err.status = 409;
    err.field = 'phone';
    throw err;
  }
}

/**
 * map User Persistence Error
 *
 * Performs logic operations for mapUserPersistenceError.
 *
 * @param error - Request/input argument
 * @returns Operations result
 */
function mapUserPersistenceError(error) {
  if (!error) return error;
  const message = String(error.message || '');

  if (/E11000 duplicate key/i.test(message) && /email/i.test(message)) {
    const err = new Error(DUPLICATE_EMAIL_MESSAGE);
    err.status = 409;
    err.field = 'email';
    return err;
  }

  if (/E11000 duplicate key/i.test(message) && /phone/i.test(message)) {
    const err = new Error(DUPLICATE_PHONE_MESSAGE);
    err.status = 409;
    err.field = 'phone';
    return err;
  }

  if (/Plan executor error|E11000 duplicate key|MongoServerError/i.test(message)) {
    const err = new Error(DUPLICATE_EMAIL_MESSAGE);
    err.status = 409;
    err.field = 'email';
    return err;
  }

  return error;
}

module.exports = {
  DUPLICATE_EMAIL_MESSAGE,
  DUPLICATE_PHONE_MESSAGE,
  normalizeUserEmail,
  normalizeUserPhone,
  buildReleasedUserEmail,
  releaseUserIdentity,
  releaseStaleDeletedUserEmail,
  findUserByEmail,
  findUserByPhone,
  assertUniqueUserEmail,
  assertUniqueUserPhone,
  mapUserPersistenceError,
};
