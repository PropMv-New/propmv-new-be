/**
 * ------------------------------------------------------------------
 * File: depositRefundInvoice.helpers.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for depositRefundInvoice.helpers.
 *
 * Used By:
 * depositRefundInvoice.service
 * ------------------------------------------------------------------
 */

const { INVOICE_TYPES } = require('../../../../../common/constants/invoice');
const { sumTenantPayments } = require('../../../../../common/helpers/landlordInvoicePayment.helper');
const { ClockService, DateUtil } = require('../../../../../common/date');
const { getDateKeyInTimeZone, parseDateOnlyToNoonUtc, parseAppYmd, formatDateInAppTimezone } = require('../../../../../common/helpers/hoaBillingDates');

const DEPOSIT_REFUND_LABEL = 'Deposit Refund';

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
 * Calendar month bounds [start, end) in app timezone for cron-style queries.
 */
function getCurrentMonthRange(referenceDate = ClockService.now()) {
  const start = DateUtil.startOfMonthEST(referenceDate);
  const key = getDateKeyInTimeZone(referenceDate);
  const p = parseAppYmd(key);
  if (!start || !p) {
    return { start: referenceDate, end: referenceDate };
  }
  const nextM = p.m === 12 ? 1 : p.m + 1;
  const nextY = p.m === 12 ? p.y + 1 : p.y;
  const end = parseDateOnlyToNoonUtc(`${nextY}-${String(nextM).padStart(2, '0')}-01`);
  return { start, end };
}

/**
 * format Lease End Label
 *
 * Performs logic operations for formatLeaseEndLabel.
 *
 * @param endDate - Request/input argument
 * @returns Operations result
 */
function formatLeaseEndLabel(endDate) {
  if (!endDate) return 'lease end';
  return formatDateInAppTimezone(endDate, { year: 'numeric', month: 'long', day: 'numeric' }) || 'lease end';
}

/**
 * Resolve one tenant's deposit share from lease split when payment history is unavailable.
 */
function resolveTenantDepositPortionFromSplit(entry, split, totalCollected, depositSubAmount) {
  const explicitDeposit = Number(entry?.depositAmount || 0);
  if (explicitDeposit > 0) return roundCurrency(explicitDeposit);

  const depositPct = Number(entry?.depositPercentage || 0);
  if (depositPct > 0 && totalCollected > 0) {
    return roundCurrency((totalCollected * depositPct) / 100);
  }
  if (depositPct > 0 && depositSubAmount > 0) {
    return roundCurrency((depositSubAmount * depositPct) / 100);
  }

  if (split.length > 0) return roundCurrency(totalCollected / split.length);
  return 0;
}

/**
 * Build per-tenant refund rows from deposit invoice payments and lease split.
 * Uses paymentHistory when present; otherwise falls back to split deposit amounts/percentages.
 */
function resolveTenantDepositRefunds(depositInvoice, lease, tenantNameById = {}) {
  const split = Array.isArray(lease?.rentAndDepositDestribution?.split)
    ? lease.rentAndDepositDestribution.split
    : [];
  if (!split.length) return [];

  const totalCollected = roundCurrency(depositInvoice?.alreadyPaid || 0);
  const depositSubAmount = roundCurrency(depositInvoice?.subAmount || 0);
  const hasPaymentHistory = Array.isArray(depositInvoice?.paymentHistory)
    && depositInvoice.paymentHistory.length > 0;

  const refunds = [];

  for (const entry of split) {
    const tenantId = entry?.tenantId;
    if (!tenantId) continue;

    let amount = 0;
    if (hasPaymentHistory) {
      amount = sumTenantPayments(depositInvoice, tenantId);
    } else if (totalCollected > 0) {
      amount = resolveTenantDepositPortionFromSplit(entry, split, totalCollected, depositSubAmount);
    } else {
      amount = resolveTenantDepositPortionFromSplit(entry, split, depositSubAmount, depositSubAmount);
    }

    amount = roundCurrency(amount);
    if (amount <= 0) continue;

    const tid = String(tenantId);
    refunds.push({
      tenantId,
      amount,
      tenantName: tenantNameById[tid] || 'Tenant',
    });
  }

  return refunds;
}

/**
 * One invoice per lease with a line item per tenant refund share.
 */
function buildDepositRefundLineItems(tenantRefunds, leaseEndDate) {
  const endLabel = formatLeaseEndLabel(leaseEndDate);

  const lineItems = tenantRefunds.map(({ tenantName, amount }) => {
    const label = `${DEPOSIT_REFUND_LABEL} - ${tenantName}`;
    return {
      invoiceItem: label,
      description: `Security deposit refund for ${tenantName} (lease ending ${endLabel})`,
      quantity: 1,
      rate: amount,
      amount,
    };
  });

  const expectedTotal = roundCurrency(tenantRefunds.reduce((sum, row) => sum + Number(row.amount || 0), 0));
  const sum = roundCurrency(lineItems.reduce((total, item) => total + Number(item.amount || 0), 0));
  const drift = roundCurrency(expectedTotal - sum);

  if (Math.abs(drift) >= 0.01 && lineItems.length > 0) {
    const last = lineItems[lineItems.length - 1];
    const patched = roundCurrency(Number(last.amount || 0) + drift);
    lineItems[lineItems.length - 1] = { ...last, amount: patched, rate: patched };
  }

  return lineItems;
}

/**
 * build Deposit Refund Invoice Title
 *
 * Performs logic operations for buildDepositRefundInvoiceTitle.
 *
 * @param leaseEndDate - Request/input argument
 * @returns Operations result
 */
function buildDepositRefundInvoiceTitle(leaseEndDate) {
  const endLabel = formatLeaseEndLabel(leaseEndDate);
  return `${DEPOSIT_REFUND_LABEL} (${endLabel})`;
}

module.exports = {
  DEPOSIT_REFUND_LABEL,
  INVOICE_TYPES,
  roundCurrency,
  getCurrentMonthRange,
  formatLeaseEndLabel,
  resolveTenantDepositPortionFromSplit,
  resolveTenantDepositRefunds,
  buildDepositRefundLineItems,
  buildDepositRefundInvoiceTitle,
};
