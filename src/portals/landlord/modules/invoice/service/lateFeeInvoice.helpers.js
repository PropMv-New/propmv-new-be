/**
 * ------------------------------------------------------------------
 * File: lateFeeInvoice.helpers.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for lateFeeInvoice.helpers.
 *
 * Used By:
 * lateFeeInvoice.service
 * ------------------------------------------------------------------
 */
const { INVOICE_TYPES, INVOICE_STATUS } = require('../../../../../common/constants/invoice');
const { ClockService } = require('../../../../../common/date');
const { getCalendarDaysLateInTimezone, resolvePropertyBillingTimezone } = require('../../../../../common/helpers/billingCalendar');
const { getDateKeyInTimeZone, parseDateOnlyToNoonUtc, shiftAppYmdDays } = require('../../../../../common/helpers/hoaBillingDates');

const LATE_FEE_INVOICE_TYPE = 'Late Fee';

/**
 * round Currency
 *
 * Performs logic operations for roundCurrency.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function roundCurrency(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

/**
 * normalize Late Fee Type
 *
 * Performs logic operations for normalizeLateFeeType.
 *
 * @param rawType - Request/input argument
 * @returns Operations result
 */
function normalizeLateFeeType(rawType) {
  const type = String(rawType || '').trim().toLowerCase();
  if (type === 'fixed' || type === 'flat-fee' || type === 'flat fee') return 'flat-fee';
  if (type === 'percentage' || type === 'percentage-total') return 'percentage-total';
  if (type === 'percentage-outstanding') return 'percentage-outstanding';
  return type || 'flat-fee';
}

/**
 * resolve Late Fee Rule Id
 *
 * Performs logic operations for resolveLateFeeRuleId.
 *
 * @param lateFee - Request/input argument
 * @param index - Request/input argument
 * @returns Operations result
 */
function resolveLateFeeRuleId(lateFee, index = 0) {
  if (lateFee?._id) return String(lateFee._id);
  return [
    'rule',
    index,
    normalizeLateFeeType(lateFee?.lateFeeType),
    Number(lateFee?.feeAmount || 0),
    Number(lateFee?.gracePeriod || 0),
    Boolean(lateFee?.isRepeat),
    Number(lateFee?.repeatEvery || 0),
  ].join(':');
}

/**
 * is Unit Applicable
 *
 * Performs logic operations for isUnitApplicable.
 *
 * @param lateFee - Request/input argument
 * @param unitName - Request/input argument
 * @returns Operations result
 */
function isUnitApplicable(lateFee, unitName) {
  if (!lateFee?.applicableScope || lateFee.applicableScope === 'all') return true;
  if (lateFee.applicableScope === 'none') return false;
  if (lateFee.applicableScope === 'specific') {
    return Array.isArray(lateFee.applicableUnits) && lateFee.applicableUnits.includes(unitName);
  }
  return true;
}

function getDaysPastDueInTimezone(dueDate, referenceDate = ClockService.now(), timeZone) {
  if (!dueDate) return 0;
  return getCalendarDaysLateInTimezone(dueDate, referenceDate, timeZone);
}

/**
 * is Eligible For Late Fee
 *
 * Performs logic operations for isEligibleForLateFee.
 *
 * @param invoice - Request/input argument
 * @param gracePeriodDays - Request/input argument
 * @param referenceDate - Request/input argument
 * @returns Operations result
 */
function isEligibleForLateFee(invoice, gracePeriodDays, referenceDate = ClockService.now(), timeZone) {
  if (!invoice || invoice.isDeleted) return false;
  if (invoice.type !== INVOICE_TYPES.RENT) return false;
  if (Number(invoice.balanceDue || 0) <= 0) return false;
  return getDaysPastDueInTimezone(invoice.dueDate, referenceDate, timeZone) >= Number(gracePeriodDays || 0);
}

/**
 * calculate Expected Late Fee Count
 *
 * Performs logic operations for calculateExpectedLateFeeCount.
 *
 * @param invoice - Request/input argument
 * @param lateFee - Request/input argument
 * @param referenceDate - Request/input argument
 * @returns Operations result
 */
function calculateExpectedLateFeeCount(invoice, lateFee, referenceDate = ClockService.now(), timeZone) {
  if (!lateFee.isRepeat) {
    return isEligibleForLateFee(invoice, lateFee.gracePeriod || 0, referenceDate, timeZone) ? 1 : 0;
  }

  const daysPastDue = getDaysPastDueInTimezone(invoice.dueDate, referenceDate, timeZone);
  const daysAfterGrace = daysPastDue - Number(lateFee.gracePeriod || 0);
  if (daysAfterGrace <= 0) return 0;

  const repeatEveryDays = Math.max(1, Number(lateFee.repeatEvery || 1));
  const occurrences = Math.floor(daysAfterGrace / repeatEveryDays) + 1;

  if (lateFee.repeatEndAfter != null && lateFee.repeatEndAfter > 0) {
    return Math.min(occurrences, lateFee.repeatEndAfter);
  }
  return occurrences;
}

/**
 * generate Late Fee Title
 *
 * Performs logic operations for generateLateFeeTitle.
 *
 * @param rentInvoice - Request/input argument
 * @param count - Request/input argument
 * @returns Operations result
 */
function generateLateFeeTitle(rentInvoice, count) {
  const rentTitle = rentInvoice.invoiceId || `Invoice ${rentInvoice._id}`;
  return `Late Fee ${rentTitle} - ${count}`;
}

/**
 * count Unpaid Tenants
 *
 * Performs logic operations for countUnpaidTenants.
 *
 * @param rentInvoice - Request/input argument
 * @param lease - Request/input argument
 * @returns Operations result
 */
function countUnpaidTenants(rentInvoice, lease) {
  const tenants = Array.isArray(rentInvoice?.tenants) ? rentInvoice.tenants : [];
  if (tenants.length === 0) return 1;

  const equallyResponsible = lease?.rentAndDepositDestribution?.isAllTenantsEquallyResponsible !== false;
  if (equallyResponsible) {
    return tenants.length;
  }

  const split = lease?.rentAndDepositDestribution?.split || [];
  if (!split.length) return tenants.length;
  return split.filter((entry) => entry?.tenantId).length || tenants.length;
}

/**
 * calculate Late Fee Amount
 *
 * Performs logic operations for calculateLateFeeAmount.
 *
 * @param rentInvoice - Request/input argument
 * @param lateFee - Request/input argument
 * @param lease - Request/input argument
 * @returns Operations result
 */
function calculateLateFeeAmount(rentInvoice, lateFee, lease) {
  const feeType = normalizeLateFeeType(lateFee.lateFeeType);
  let amount = 0;

  if (feeType === 'flat-fee') {
    amount = Number(lateFee.feeAmount || 0);
  } else if (feeType === 'percentage-total') {
    amount = (Number(rentInvoice.subAmount || 0) * Number(lateFee.feeAmount || 0)) / 100;
  } else if (feeType === 'percentage-outstanding') {
    amount = (Number(rentInvoice.balanceDue || 0) * Number(lateFee.feeAmount || 0)) / 100;
  } else {
    amount = Number(lateFee.feeAmount || 0);
  }

  amount = roundCurrency(amount);

  if (lateFee.chargeEachUnpaidTenat) {
    amount = roundCurrency(amount * countUnpaidTenants(rentInvoice, lease));
  }

  return amount;
}

/**
 * build Late Fee Description
 *
 * Performs logic operations for buildLateFeeDescription.
 *
 * @param lateFee - Request/input argument
 * @param amount - Request/input argument
 * @returns Operations result
 */
function buildLateFeeDescription(lateFee, amount) {
  const feeType = normalizeLateFeeType(lateFee.lateFeeType);
  if (feeType === 'flat-fee') {
    return `Flat late fee of $${amount.toFixed(2)}`;
  }
  if (feeType === 'percentage-total') {
    return `Late fee (${Number(lateFee.feeAmount || 0)}% of invoice total)`;
  }
  if (feeType === 'percentage-outstanding') {
    return `Late fee (${Number(lateFee.feeAmount || 0)}% of outstanding balance)`;
  }
  return 'Late payment fee';
}

/**
 * build Late Fee Line Items
 *
 * Performs logic operations for buildLateFeeLineItems.
 *
 * @param title - Request/input argument
 * @param description - Request/input argument
 * @param amount - Request/input argument
 * @param lease - Request/input argument
 * @param tenantNameById - Request/input argument
 * @returns Operations result
 */
function buildLateFeeLineItems(title, description, amount, lease, tenantNameById = {}) {
  const distribution = lease?.rentAndDepositDestribution;
  const equallyResponsible = distribution?.isAllTenantsEquallyResponsible !== false;
  const split = Array.isArray(distribution?.split) ? distribution.split : [];

  if (equallyResponsible || !split.length) {
    return [{
      invoiceItem: title,
      description,
      quantity: 1,
      rate: amount,
      amount,
    }];
  }

  const lineItems = split.map((entry, idx) => {
    const pct = Number(entry?.rentPercentage || 0);
    const baseAmount = pct > 0
      ? (amount * pct) / 100
      : amount / split.length;
    const lineAmount = roundCurrency(baseAmount);
    const tenantName = tenantNameById[String(entry?.tenantId || '')] || `Tenant ${idx + 1}`;
    const label = `${title} - ${tenantName}`;
    return {
      invoiceItem: label,
      description: `${description} (${tenantName})`,
      quantity: 1,
      rate: lineAmount,
      amount: lineAmount,
    };
  });

  const sum = lineItems.reduce((total, item) => total + Number(item.amount || 0), 0);
  const drift = roundCurrency(amount - sum);
  if (Math.abs(drift) >= 0.01 && lineItems.length > 0) {
    const last = lineItems[lineItems.length - 1];
    const patched = roundCurrency(Number(last.amount || 0) + drift);
    lineItems[lineItems.length - 1] = { ...last, amount: patched, rate: patched };
  }

  return lineItems;
}

/**
 * resolve Late Fee Tenants
 *
 * Performs logic operations for resolveLateFeeTenants.
 *
 * @param rentInvoice - Request/input argument
 * @param lease - Request/input argument
 * @returns Operations result
 */
function resolveLateFeeTenants(rentInvoice, lease) {
  const rentTenants = Array.isArray(rentInvoice?.tenants) ? rentInvoice.tenants : [];
  const equallyResponsible = lease?.rentAndDepositDestribution?.isAllTenantsEquallyResponsible !== false;
  if (equallyResponsible) return rentTenants;

  const split = lease?.rentAndDepositDestribution?.split || [];
  const splitTenantIds = split.map((entry) => entry?.tenantId).filter(Boolean);
  return splitTenantIds.length ? splitTenantIds : rentTenants;
}

/**
 * compute Late Fee Due Date
 *
 * Performs logic operations for computeLateFeeDueDate.
 *
 * @param rentInvoice - Request/input argument
 * @param lateFee - Request/input argument
 * @param count - Request/input argument
 * @returns Operations result
 */
function computeLateFeeDueDate(rentInvoice, lateFee, count, timeZone) {
  const tz = resolvePropertyBillingTimezone({ billingTimezone: timeZone });
  const key = getDateKeyInTimeZone(rentInvoice.dueDate, tz);
  if (!key) return ClockService.now();
  let ymd = shiftAppYmdDays(key, Number(lateFee.gracePeriod || 0));
  if (lateFee.isRepeat && count > 1) {
    const repeatEveryDays = Math.max(1, Number(lateFee.repeatEvery || 1));
    ymd = shiftAppYmdDays(ymd, repeatEveryDays * (count - 1));
  }
  return parseDateOnlyToNoonUtc(ymd) || ClockService.now();
}

module.exports = {
  LATE_FEE_INVOICE_TYPE,
  roundCurrency,
  normalizeLateFeeType,
  resolveLateFeeRuleId,
  isUnitApplicable,
  isEligibleForLateFee,
  calculateExpectedLateFeeCount,
  generateLateFeeTitle,
  calculateLateFeeAmount,
  buildLateFeeDescription,
  buildLateFeeLineItems,
  resolveLateFeeTenants,
  computeLateFeeDueDate,
  countUnpaidTenants,
};
