const { ClockService } = require('../../../../../common/date');
const { INVOICE_STATUS } = require('../../../../../common/constants/invoice');
const { recalculateInvoiceStatus } = require('./invoicePaymentReversal.helper');
const { roundMoney } = require('./invoicePaymentTransactions.helper');

function isActiveWaiveHistoryEntry(entry) {
  return Boolean(entry) && entry.reversed !== true;
}

function getActiveWaivedLineItemIndices(invoice) {
  return new Set(
    (invoice?.waiveHistory || [])
      .filter(isActiveWaiveHistoryEntry)
      .map((entry) => entry.lineItemIndex)
      .filter((index) => Number.isInteger(index) && index >= 0)
  );
}

/**
 * Effective waived dollars: denormalized field, else sum of active waiveHistory.
 * Status "Waived" alone is not enough - prefer history when the scalar was cleared.
 */
function getEffectiveWaivedAmount(invoice) {
  const fromField = roundMoney(invoice?.waivedAmount || 0);
  if (fromField > 0) return fromField;

  const fromHistory = roundMoney(
    (invoice?.waiveHistory || [])
      .filter(isActiveWaiveHistoryEntry)
      .reduce((sum, entry) => sum + roundMoney(entry?.amount || 0), 0)
  );
  return fromHistory;
}

function invoiceHasActiveWaiver(invoice) {
  if (!invoice) return false;
  if (getEffectiveWaivedAmount(invoice) > 0) return true;
  return String(invoice.status || '') === String(INVOICE_STATUS.WAIVED);
}

/**
 * Balance that can still be collected after payments, processing, and waivers.
 * Caps stored balanceDue so a stale remaining cannot ignore an active waive.
 */
function computeCollectableBalance(invoice) {
  const storedBalance = roundMoney(invoice?.balanceDue || 0);
  if (storedBalance <= 0) return 0;

  const waivedAmount = getEffectiveWaivedAmount(invoice);
  const subAmount = roundMoney(invoice?.subAmount || 0);
  if (subAmount <= 0) {
    return roundMoney(Math.max(0, storedBalance - waivedAmount));
  }

  const identityBalance = roundMoney(Math.max(
    0,
    subAmount
    - roundMoney(invoice?.alreadyPaid || 0)
    - roundMoney(invoice?.processingAmount || 0)
    - waivedAmount
  ));

  return roundMoney(Math.min(storedBalance, identityBalance));
}

function computeWaiveIdentityBalance({
  subAmount = 0,
  alreadyPaid = 0,
  processingAmount = 0,
  waivedAmount = 0,
} = {}) {
  return roundMoney(Math.max(
    0,
    roundMoney(subAmount)
    - roundMoney(alreadyPaid)
    - roundMoney(processingAmount)
    - roundMoney(waivedAmount)
  ));
}

/**
 * Description/metadata edits often send remaining = totalDue - totalPaid,
 * which ignores waivedAmount and would reopen a waived invoice.
 * Recompute balanceDue from the waive identity unless a payment is being recorded.
 */
function applyNonPaymentWaiveBalanceGuard(invoice, updates, { hasPaymentIntent = false } = {}) {
  if (hasPaymentIntent || !invoice || !updates) return updates;
  if (!invoiceHasActiveWaiver(invoice)) return updates;

  const waivedAmount = getEffectiveWaivedAmount(invoice);
  // Keep denormalized field in sync when only history still carries the waiver.
  if (roundMoney(invoice.waivedAmount || 0) <= 0 && waivedAmount > 0) {
    updates.waivedAmount = waivedAmount;
  }

  const nextSub = updates.subAmount !== undefined
    ? roundMoney(updates.subAmount)
    : roundMoney(invoice.subAmount || 0);
  const nextPaid = updates.alreadyPaid !== undefined
    ? roundMoney(updates.alreadyPaid)
    : roundMoney(invoice.alreadyPaid || 0);
  const processingAmount = roundMoney(invoice.processingAmount || 0);
  updates.balanceDue = computeWaiveIdentityBalance({
    subAmount: nextSub,
    alreadyPaid: nextPaid,
    processingAmount,
    waivedAmount,
  });
  return updates;
}

/**
 * After Object.assign, re-assert waive identity on the invoice document itself so a
 * stale client remaining cannot leave the invoice open for auto-credit.
 */
function syncInvoiceBalanceWithActiveWaive(invoice, { hasPaymentIntent = false } = {}) {
  if (hasPaymentIntent || !invoice || !invoiceHasActiveWaiver(invoice)) return invoice;

  const waivedAmount = getEffectiveWaivedAmount(invoice);
  if (roundMoney(invoice.waivedAmount || 0) <= 0 && waivedAmount > 0) {
    invoice.waivedAmount = waivedAmount;
  }

  invoice.balanceDue = computeWaiveIdentityBalance({
    subAmount: invoice.subAmount,
    alreadyPaid: invoice.alreadyPaid,
    processingAmount: invoice.processingAmount,
    waivedAmount,
  });

  recalculateInvoiceStatus(invoice);
  return invoice;
}

/**
 * After reversing a waiver, add the reversed dollars back onto remaining, but never
 * exceed unpaid principal (sub - paid - processing). That blocks the $90+$100→$190
 * stack when remaining was wrongly restored before reverse.
 */
function restoreBalanceAfterWaiveReversal(invoice, reverseAmount) {
  const restored = roundMoney((invoice.balanceDue || 0) + roundMoney(reverseAmount || 0));
  const subAmount = roundMoney(invoice.subAmount || 0);
  if (subAmount <= 0) return restored;

  const maxOutstanding = roundMoney(Math.max(
    0,
    subAmount
    - roundMoney(invoice.alreadyPaid || 0)
    - roundMoney(invoice.processingAmount || 0)
  ));
  return roundMoney(Math.min(restored, maxOutstanding));
}

/**
 * Reverse all active waivers on an invoice: restore outstanding balance,
 * clear waivedAmount, mark waiveHistory entries reversed, and recalculate status.
 */
function applyInvoiceWaiveReversal(invoice, { userId = null, now = null } = {}) {
  const reverseAmount = getEffectiveWaivedAmount(invoice);
  if (reverseAmount <= 0) {
    throw Object.assign(new Error('Invoice has no waived amount to reverse'), { status: 400 });
  }

  const previousStatus = invoice.status;
  const reversedAt = now || ClockService.now();

  invoice.balanceDue = restoreBalanceAfterWaiveReversal(invoice, reverseAmount);
  invoice.waivedAmount = 0;
  invoice.waivedBy = null;
  invoice.waivedAt = null;
  invoice.waiveReason = '';

  invoice.waiveHistory = invoice.waiveHistory || [];
  for (const entry of invoice.waiveHistory) {
    if (!isActiveWaiveHistoryEntry(entry)) continue;
    entry.reversed = true;
    entry.reversedBy = userId;
    entry.reversedAt = reversedAt;
  }

  invoice.waiveReversalHistory = invoice.waiveReversalHistory || [];
  const reversalEntry = {
    amount: reverseAmount,
    reversedBy: userId,
    reversedAt,
    previousStatus,
    newStatus: previousStatus,
  };
  invoice.waiveReversalHistory.push(reversalEntry);

  recalculateInvoiceStatus(invoice);
  reversalEntry.newStatus = invoice.status;

  return {
    reverseAmount,
    previousStatus,
    newStatus: invoice.status,
    reversedAt,
  };
}

module.exports = {
  isActiveWaiveHistoryEntry,
  getActiveWaivedLineItemIndices,
  getEffectiveWaivedAmount,
  invoiceHasActiveWaiver,
  computeCollectableBalance,
  applyNonPaymentWaiveBalanceGuard,
  syncInvoiceBalanceWithActiveWaive,
  applyInvoiceWaiveReversal,
};
