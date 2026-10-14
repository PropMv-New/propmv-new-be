'use strict';

const {
  US_STATE_DEFAULT_TIMEZONE,
  DEFAULT_BILLING_TIMEZONE,
  isValidBillingTimezone,
} = require('./billingTimezone.constants');

/**
 * Split-state overrides by 3-digit ZIP prefix (approximate; user can override in UI).
 * Sources: USPS primary zones for multi-TZ states.
 */
const ZIP3_TIMEZONE_OVERRIDES = Object.freeze({
  '590': 'America/Denver',
  '591': 'America/Denver',
  '597': 'America/Denver',
  '598': 'America/Denver',
  '599': 'America/Denver',
  '677': 'America/Denver',
  '678': 'America/Chicago',
  '679': 'America/Chicago',
  '739': 'America/Chicago',
  '790': 'America/Chicago',
  '791': 'America/Chicago',
  '792': 'America/Chicago',
  '793': 'America/Chicago',
  '794': 'America/Chicago',
  '795': 'America/Chicago',
  '796': 'America/Chicago',
  '797': 'America/Chicago',
  '798': 'America/Denver',
  '799': 'America/Denver',
  '813': 'America/Denver',
  '814': 'America/Denver',
  '815': 'America/Denver',
  '816': 'America/Denver',
  '820': 'America/Denver',
  '821': 'America/Denver',
  '822': 'America/Denver',
  '823': 'America/Denver',
  '824': 'America/Denver',
  '825': 'America/Denver',
  '826': 'America/Denver',
  '827': 'America/Denver',
  '828': 'America/Denver',
  '829': 'America/Denver',
  '830': 'America/Denver',
  '831': 'America/Denver',
  '850': 'America/Phoenix',
  '851': 'America/Phoenix',
  '852': 'America/Phoenix',
  '853': 'America/Phoenix',
  '855': 'America/Phoenix',
  '856': 'America/Phoenix',
  '857': 'America/Phoenix',
  '859': 'America/Phoenix',
  '860': 'America/Phoenix',
  '863': 'America/Phoenix',
  '864': 'America/Phoenix',
  '865': 'America/Phoenix',
  '889': 'America/Los_Angeles',
  '890': 'America/Los_Angeles',
  '891': 'America/Los_Angeles',
  '893': 'America/Los_Angeles',
  '894': 'America/Los_Angeles',
  '895': 'America/Los_Angeles',
  '897': 'America/Los_Angeles',
  '898': 'America/Los_Angeles',
  '961': 'America/Los_Angeles',
  '976': 'America/Los_Angeles',
  '977': 'America/Los_Angeles',
  '978': 'America/Los_Angeles',
  '979': 'America/Denver',
  '993': 'America/Los_Angeles',
  '994': 'America/Los_Angeles',
  '995': 'America/Anchorage',
  '996': 'America/Anchorage',
  '997': 'America/Anchorage',
  '998': 'America/Anchorage',
  '999': 'America/Anchorage',
});

function normalizeZip(zip) {
  const digits = String(zip || '').replace(/\D/g, '');
  if (digits.length < 5) return null;
  return digits.slice(0, 5);
}

function normalizeState(state) {
  const code = String(state || '').trim().toUpperCase();
  return code.length === 2 ? code : null;
}

/**
 * Resolve billing timezone from US zip (+ optional state fallback).
 * @returns {string|null} IANA timezone or null if lookup impossible
 */
function lookupTimezoneFromZip(zip, state) {
  const normalizedZip = normalizeZip(zip);
  if (normalizedZip) {
    const zip3 = normalizedZip.slice(0, 3);
    const override = ZIP3_TIMEZONE_OVERRIDES[zip3];
    if (override && isValidBillingTimezone(override)) return override;
  }

  const stateCode = normalizeState(state);
  if (stateCode && US_STATE_DEFAULT_TIMEZONE[stateCode]) {
    return US_STATE_DEFAULT_TIMEZONE[stateCode];
  }

  return null;
}

function lookupTimezoneFromAddress(address = {}) {
  return lookupTimezoneFromZip(address.zip || address.zipCode, address.state);
}

function lookupTimezoneOrDefault(zip, state) {
  return lookupTimezoneFromZip(zip, state) || DEFAULT_BILLING_TIMEZONE;
}

module.exports = {
  lookupTimezoneFromZip,
  lookupTimezoneFromAddress,
  lookupTimezoneOrDefault,
  normalizeZip,
};
