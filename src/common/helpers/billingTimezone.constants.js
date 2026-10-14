'use strict';

const { TIMEZONE } = require('../date');

/** Curated US IANA timezones for property billing (late fees, due-date calendar). */
const US_BILLING_TIMEZONES = Object.freeze([
  { iana: 'America/New_York', label: 'Eastern Time (ET)' },
  { iana: 'America/Chicago', label: 'Central Time (CT)' },
  { iana: 'America/Denver', label: 'Mountain Time (MT)' },
  { iana: 'America/Phoenix', label: 'Arizona (no DST)' },
  { iana: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
  { iana: 'America/Anchorage', label: 'Alaska Time (AKT)' },
  { iana: 'Pacific/Honolulu', label: 'Hawaii Time (HST)' },
]);

const US_BILLING_TIMEZONE_IANAS = US_BILLING_TIMEZONES.map((row) => row.iana);

const DEFAULT_BILLING_TIMEZONE = TIMEZONE.BUSINESS;

/** US state/territory code → primary billing timezone (zip lookup fallback). */
const US_STATE_DEFAULT_TIMEZONE = Object.freeze({
  AL: 'America/Chicago',
  AK: 'America/Anchorage',
  AZ: 'America/Phoenix',
  AR: 'America/Chicago',
  CA: 'America/Los_Angeles',
  CO: 'America/Denver',
  CT: 'America/New_York',
  DE: 'America/New_York',
  DC: 'America/New_York',
  FL: 'America/New_York',
  GA: 'America/New_York',
  HI: 'Pacific/Honolulu',
  ID: 'America/Denver',
  IL: 'America/Chicago',
  IN: 'America/New_York',
  IA: 'America/Chicago',
  KS: 'America/Chicago',
  KY: 'America/New_York',
  LA: 'America/Chicago',
  ME: 'America/New_York',
  MD: 'America/New_York',
  MA: 'America/New_York',
  MI: 'America/New_York',
  MN: 'America/Chicago',
  MS: 'America/Chicago',
  MO: 'America/Chicago',
  MT: 'America/Denver',
  NE: 'America/Chicago',
  NV: 'America/Los_Angeles',
  NH: 'America/New_York',
  NJ: 'America/New_York',
  NM: 'America/Denver',
  NY: 'America/New_York',
  NC: 'America/New_York',
  ND: 'America/Chicago',
  OH: 'America/New_York',
  OK: 'America/Chicago',
  OR: 'America/Los_Angeles',
  PA: 'America/New_York',
  RI: 'America/New_York',
  SC: 'America/New_York',
  SD: 'America/Chicago',
  TN: 'America/Chicago',
  TX: 'America/Chicago',
  UT: 'America/Denver',
  VT: 'America/New_York',
  VA: 'America/New_York',
  WA: 'America/Los_Angeles',
  WV: 'America/New_York',
  WI: 'America/Chicago',
  WY: 'America/Denver',
  PR: 'America/New_York',
  VI: 'America/New_York',
  GU: 'Pacific/Guam',
});

function isValidBillingTimezone(value) {
  if (!value || typeof value !== 'string') return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function getBillingTimezoneLabel(iana) {
  const row = US_BILLING_TIMEZONES.find((entry) => entry.iana === iana);
  if (row) return row.label;
  if (!iana) return 'Eastern Time (ET)';
  return iana.replace(/_/g, ' ');
}

function resolveBillingTimezone(value) {
  if (isValidBillingTimezone(value)) return String(value).trim();
  return DEFAULT_BILLING_TIMEZONE;
}

/** Mongo filter for properties whose billingTimezone matches (null/blank = default Eastern). */
function buildTimezonePropertyFilter(timezone) {
  const resolved = resolveBillingTimezone(timezone);
  if (resolved === DEFAULT_BILLING_TIMEZONE) {
    return {
      $or: [
        { billingTimezone: resolved },
        { billingTimezone: { $exists: false } },
        { billingTimezone: null },
        { billingTimezone: '' },
      ],
    };
  }
  return { billingTimezone: resolved };
}

module.exports = {
  US_BILLING_TIMEZONES,
  US_BILLING_TIMEZONE_IANAS,
  US_STATE_DEFAULT_TIMEZONE,
  DEFAULT_BILLING_TIMEZONE,
  isValidBillingTimezone,
  getBillingTimezoneLabel,
  resolveBillingTimezone,
  buildTimezonePropertyFilter,
};
