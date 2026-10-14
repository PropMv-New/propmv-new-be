/**
 * ------------------------------------------------------------------
 * File: quota.service.js
 * Module: Src Shared Modules Address Services
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * server, address.controller
 * ------------------------------------------------------------------
 */

const AddressApiUsage = require('../model/addressApiUsage.model');
const logger = require('../../../../common/logger');
const { ClockService, DateUtil } = require('../../../../common/date');

const DEFAULT_GOOGLE_MONTHLY_LIMIT = 10000;
const DEFAULT_SAFETY_BUFFER = 200;

/** Resolve the configured Google monthly request limit (defaults to 10,000). */
function getGoogleMonthlyLimit() {
  const raw = Number(process.env.ADDRESS_GOOGLE_MONTHLY_LIMIT);
  // Allow 0 for testing (forces immediate Mapbox fallback).
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_GOOGLE_MONTHLY_LIMIT;
}

/**
 * Requests held back from the Google limit as a safety margin.
 *
 * Google usage is reported by the browser after the fact, so the server's count
 * always trails reality slightly: clients cache the provider decision for 30s,
 * and a report can be lost (offline, blocked, 429). Switching a little early
 * keeps that drift on the free side of Google's billing threshold.
 */
function getSafetyBuffer() {
  const raw = Number(process.env.ADDRESS_GOOGLE_SAFETY_BUFFER);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return DEFAULT_SAFETY_BUFFER;
}

/** The count at which we actually stop using Google (never below 0). */
function getGoogleEffectiveLimit() {
  const limit = getGoogleMonthlyLimit();
  if (limit === 0) return 0;
  return Math.max(0, limit - getSafetyBuffer());
}

/** Current calendar month in UTC as YYYY-MM. */
function getCurrentPeriod(date = ClockService.now()) {
  const d = DateUtil.toUTC(date) || ClockService.now();
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

const EMPTY_USAGE = (provider, period) => ({
  provider,
  period,
  autocompleteCount: 0,
  resolveCount: 0,
  totalCount: 0,
});

/** Read usage counters for a provider in a given period (defaults to current month). */
async function getUsage(provider, period = getCurrentPeriod()) {
  const doc = await AddressApiUsage.findOne({ provider, period }).lean();
  return doc || EMPTY_USAGE(provider, period);
}

/**
 * Atomically increment usage counters for a provider.
 *
 * `totalCount` tracks BILLABLE units and is what the quota check gates on:
 *  - google: one unit per autocomplete *session* (a session token covers the
 *    keystrokes plus the Place Details call, and Google bills it once), so a
 *    'resolve' belongs to a session that was already counted and must not add
 *    to totalCount - it is recorded for observability only.
 *  - mapbox: one unit per request.
 *
 * @param {'google'|'mapbox'} provider
 * @param {'autocomplete'|'resolve'} type
 */
async function incrementUsage(provider, type = 'autocomplete', period = getCurrentPeriod()) {
  const inc = type === 'resolve'
    ? { resolveCount: 1 }
    : { autocompleteCount: 1, totalCount: 1 };

  return AddressApiUsage.findOneAndUpdate(
    { provider, period },
    { $inc: inc, $setOnInsert: { provider, period } },
    { upsert: true, new: true }
  );
}

/** Whether Google still has free quota left this month (minus the safety buffer). */
async function hasGoogleQuota(period = getCurrentPeriod()) {
  const usage = await getUsage('google', period);
  return (usage.totalCount || 0) < getGoogleEffectiveLimit();
}

/** Whether Mapbox is configured and usable as a fallback. */
function isMapboxConfigured() {
  return Boolean(process.env.MAPBOX_ACCESS_TOKEN);
}

let warnedUnconfiguredFallback = false;

/**
 * Decide which provider should serve the next request.
 * Google is primary; Mapbox is used ONLY once Google's monthly quota is exhausted.
 *
 * If Mapbox is not configured we stay on Google, because breaking address search
 * outright is worse than the alternative - but past the quota that means Google
 * starts BILLING, so it is warned about loudly rather than passed over silently.
 */
async function resolveActiveProvider() {
  const googleOk = await hasGoogleQuota();
  if (googleOk) return 'google';
  if (isMapboxConfigured()) return 'mapbox';

  if (!warnedUnconfiguredFallback) {
    warnedUnconfiguredFallback = true;
    logger.error(
      '[address] Google address quota is exhausted but MAPBOX_ACCESS_TOKEN is not set. ' +
        'Still serving Google, which is now BILLABLE. Set MAPBOX_ACCESS_TOKEN to enable failover.',
    );
  }
  return 'google';
}

/** Test helper: clears the one-shot warning latch. */
function resetQuotaWarningsForTests() {
  warnedUnconfiguredFallback = false;
}

/**
 * Startup check so a missing fallback token is caught at boot, not on the day the
 * quota runs out. Called from app.js.
 */
function verifyAddressFailoverConfig() {
  if (isMapboxConfigured()) return true;
  logger.warn(
    '[address] MAPBOX_ACCESS_TOKEN is not set - there is NO fallback once Google\'s ' +
      `monthly quota (${getGoogleMonthlyLimit()}) is spent, and Google will start charging.`,
  );
  return false;
}

module.exports = {
  getCurrentPeriod,
  getUsage,
  incrementUsage,
  hasGoogleQuota,
  isMapboxConfigured,
  resolveActiveProvider,
  getGoogleMonthlyLimit,
  getGoogleEffectiveLimit,
  getSafetyBuffer,
  verifyAddressFailoverConfig,
  resetQuotaWarningsForTests,
};
