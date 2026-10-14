'use strict';

const { DEFAULT_BILLING_TIMEZONE } = require('./billingTimezone.constants');

/**
 * Resolve billingTimezone + source for property create/update payloads.
 * Current release: fixed to Eastern Time (not user-configurable).
 */
function resolvePropertyBillingTimezoneFields(_propertyData = {}, _existing = null) {
  return {
    billingTimezone: DEFAULT_BILLING_TIMEZONE,
    billingTimezoneSource: 'default',
  };
}

function backfillBillingTimezoneFromAddress(_property) {
  return {
    billingTimezone: DEFAULT_BILLING_TIMEZONE,
    billingTimezoneSource: 'default',
  };
}

module.exports = {
  resolvePropertyBillingTimezoneFields,
  backfillBillingTimezoneFromAddress,
};
