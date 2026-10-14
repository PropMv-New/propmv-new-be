/**
 * ------------------------------------------------------------------
 * File: invoicePaymentReversal.helper.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for invoicePaymentReversal.helper.
 *
 * Used By:
 * invoice.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Property = require('../../property/model/property.model');
const LedgerEntry = require('../../owners/models/ledgerEntry.model');
const Invoice = require('../model/invoice.model');
const { INVOICE_STATUS } = require('../../../../../common/constants/invoice');
const { getDateKeyInTimeZone, billingCalendarDateKey, formatDateInAppTimezone } = require('../../../../../common/helpers/hoaBillingDates');
const { ClockService, DateUtil } = require('../../../../../common/date');
const {
  roundMoney,
  classifyPaymentTransaction,
  recalculateInvoiceTotalsFromTransactions,
  sumCreditAppliedOnInvoice,
  sumCreditStoredOnInvoice,
} = require('./invoicePaymentTransactions.helper');
const { markInvoiceSkipAutoCredit } = require('./invoiceAutoCredit.helper');

async function adjustPropertyCreditPool(propertyId, delta, metadata, session = null) {
  const change = roundMoney(delta);
  if (!propertyId || change === 0) {
    return { creditBalanceBefore: null, creditBalanceAfter: null };
  }

  const opts = session ? { session } : {};
  let propQuery = Property.findById(propertyId).select('remainingCredit name');
  if (session) propQuery = propQuery.session(session);
  const propertyDoc = await propQuery;
  if (!propertyDoc) {
    throw Object.assign(new Error('Property not found for credit adjustment'), { status: 404 });
  }

  const creditBalanceBefore = roundMoney(Number(propertyDoc.remainingCredit || 0));
  const creditBalanceAfter = roundMoney(creditBalanceBefore + change);

  await Property.findByIdAndUpdate(
    propertyId,
    { $set: { remainingCredit: creditBalanceAfter } },
    opts
  );

  await new LedgerEntry({
    unitId: propertyId,
    type: 'adjustment',
    amount: -change,
    referenceId: metadata?.invoiceId,
    metadata: {
      ...metadata,
      // Property.remainingCredit is the canonical pool for these adjustments.
      // This ledger row is audit-only and must not be counted as a new unapplied credit source.
      remainingCredit: 0,
      creditBalanceBefore,
      creditBalanceAfter,
    },
  }).save(opts);

  return { creditBalanceBefore, creditBalanceAfter };
}

/**
 * recalculate Invoice Status
 *
 * Performs logic operations for recalculateInvoiceStatus.
 *
 * @param invoice - Request/input argument
 * @returns Operations result
 */
function recalculateInvoiceStatus(invoice) {
  const balanceDue = roundMoney(invoice.balanceDue || 0);
  const alreadyPaid = roundMoney(invoice.alreadyPaid || 0);
  const processingAmount = roundMoney(invoice.processingAmount || 0);

  if (processingAmount > 0) {
    invoice.status = INVOICE_STATUS.PROCESSING;
    invoice.paidOn = undefined;
    return;
  }

  if (balanceDue <= 0) {
    const waivedAmount = roundMoney(invoice.waivedAmount || 0);
    // Fully waived with no payment → Waived.
    // Mixed Paid + Waived (or any payment that clears the remainder) → Paid.
    // Must match credit auto-apply and Record Payment so both paths agree.
    if (waivedAmount > 0 && alreadyPaid <= 0) {
      invoice.status = INVOICE_STATUS.WAIVED;
      invoice.paidOn = undefined;
      return;
    }
    invoice.status = INVOICE_STATUS.PAID;
    return;
  }

  // Invoice is no longer fully settled - clear stale paid date from listing/detail.
  invoice.paidOn = undefined;

  if (alreadyPaid > 0) {
    invoice.status = INVOICE_STATUS.PARTIALLY_PAID;
    return;
  }

  const dueDateKey = billingCalendarDateKey(invoice.dueDate);
  const todayKey = getDateKeyInTimeZone(ClockService.now());
  if (dueDateKey && todayKey && dueDateKey < todayKey) {
    invoice.status = INVOICE_STATUS.OVERDUE;
  } else {
    invoice.status = INVOICE_STATUS.PENDING;
  }
}

/**
 * get Invoice Delete Credit Delta
 *
 * Performs logic operations for getInvoiceDeleteCreditDelta.
 *
 * @param invoice - Request/input argument
 * @returns Operations result
 */
function getInvoiceDeleteCreditDelta(invoice) {
  const creditApplied = sumCreditAppliedOnInvoice(invoice);
  const creditStored = sumCreditStoredOnInvoice(invoice);
  return {
    creditApplied,
    creditStored,
    netDelta: roundMoney(creditApplied - creditStored),
  };
}

/**
 * same Object Id
 *
 * Performs logic operations for sameObjectId.
 *
 * @param a - Request/input argument
 * @param b - Request/input argument
 * @returns Operations result
 */
function sameObjectId(a, b) {
  if (!a || !b) return false;
  return String(a) === String(b);
}

/**
 * same Instant
 *
 * Performs logic operations for sameInstant.
 *
 * @param a - Request/input argument
 * @param b - Request/input argument
 * @returns Operations result
 */
function sameInstant(a, b) {
  if (!a || !b) return false;
  const aTime = (DateUtil.toEpoch(a) ?? 0);
  const bTime = (DateUtil.toEpoch(b) ?? 0);
  return Number.isFinite(aTime) && Number.isFinite(bTime) && aTime === bTime;
}

/**
 * normalize Text
 *
 * Performs logic operations for normalizeText.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * transaction Matches Recorded Payment
 *
 * Performs logic operations for transactionMatchesRecordedPayment.
 *
 * @param tx - Request/input argument
 * @param paymentMeta - Request/input argument
 * @returns Operations result
 */
function transactionMatchesRecordedPayment(tx, paymentMeta = {}) {
  if (!tx) return false;
  if (tx.isDeleted === true) return false;

  if (paymentMeta.paidAt && !sameInstant(tx.paidAt, paymentMeta.paidAt)) return false;
  if (paymentMeta.recordedBy && !sameObjectId(tx.recordedBy, paymentMeta.recordedBy)) return false;
  if (paymentMeta.paidBy && !sameObjectId(tx.paidBy, paymentMeta.paidBy)) return false;
  if (paymentMeta.checkNumber && normalizeText(tx.checkNumber) !== normalizeText(paymentMeta.checkNumber)) return false;
  if (paymentMeta.moneyOrderNumber && normalizeText(tx.moneyOrderNumber) !== normalizeText(paymentMeta.moneyOrderNumber)) return false;

  return true;
}

/**
 * transaction Matches Overpayment Allocation
 *
 * Performs logic operations for transactionMatchesOverpaymentAllocation.
 *
 * @param tx - Request/input argument
 * @param allocation - Request/input argument
 * @param paymentMeta - Request/input argument
 * @param primaryInvoiceNumber - Request/input argument
 * @returns Operations result
 */
function transactionMatchesOverpaymentAllocation(tx, allocation, paymentMeta = {}, primaryInvoiceNumber = '') {
  if (!transactionMatchesRecordedPayment(tx, paymentMeta)) return false;
  if (roundMoney(tx.amount || 0) !== roundMoney(allocation?.amount || 0)) return false;
  const note = normalizeText(tx.note);
  const primary = normalizeText(primaryInvoiceNumber);
  const isAllocationNote =
    note.includes('from overpayment on invoice')
    || note.includes('from payment on invoice');
  return isAllocationNote && (!primary || note.includes(primary));
}

async function findRecordedPaymentLedgerEntry({ invoice, tx, session = null }) {
  if (!invoice?.propertyId || !invoice?._id || !tx) return null;

  const query = {
    unitId: invoice.propertyId,
    type: 'payment',
    'metadata.source': 'invoice_payment',
    $or: [
      { referenceId: invoice._id },
      { 'metadata.overpaymentAllocatedToOtherInvoices.invoiceId': invoice._id },
    ],
  };

  let q = LedgerEntry.find(query).sort({ createdAt: -1 });
  if (session) q = q.session(session);
  const entries = await q.lean();

  return (entries || []).find((entry) => {
    const meta = entry.metadata || {};
    if (!transactionMatchesRecordedPayment(tx, meta)) return false;
    if (classifyPaymentTransaction(tx) === 'credit_stored') {
      return roundMoney(meta.overpaymentCreditStored || 0) === roundMoney(tx.amount || 0);
    }
    if ((meta.overpaymentAllocatedToOtherInvoices || []).some((allocation) => (
      sameObjectId(invoice._id, allocation.invoiceId)
      && transactionMatchesOverpaymentAllocation(tx, allocation, meta, meta.invoiceNumber)
    ))) {
      return true;
    }
    const ledgerAmount = roundMoney(Math.abs(Number(entry.amount || 0)));
    const txAmount = roundMoney(tx.amount || 0);
    const allocated = roundMoney((meta.overpaymentAllocatedToOtherInvoices || [])
      .reduce((sum, row) => sum + Number(row.amount || 0), 0));
    const stored = roundMoney(meta.overpaymentCreditStored || 0);
    return ledgerAmount === txAmount || roundMoney(txAmount + allocated + stored) === ledgerAmount;
  }) || null;
}

function recorderObjectId(userId) {
  return userId && mongoose.Types.ObjectId.isValid(String(userId))
    ? new mongoose.Types.ObjectId(String(userId))
    : undefined;
}

function softDeletePaymentTransaction(tx, userId) {
  if (!tx || tx.isDeleted === true) return false;
  tx.isDeleted = true;
  tx.deletedAt = ClockService.now();
  const deletedBy = recorderObjectId(userId);
  if (deletedBy) tx.deletedBy = deletedBy;
  return true;
}

function pushInvoiceEditHistory(invoice, changes, userId) {
  invoice.editHistory = invoice.editHistory || [];
  invoice.editHistory.push({
    changes: (changes || []).filter(Boolean),
    editedBy: recorderObjectId(userId),
    editedAt: ClockService.now(),
  });
}

function persistInvoiceTotals(invoice) {
  const totals = recalculateInvoiceTotalsFromTransactions(invoice);
  invoice.alreadyPaid = totals.alreadyPaid;
  invoice.processingAmount = totals.processingAmount;
  invoice.balanceDue = totals.balanceDue;
  recalculateInvoiceStatus(invoice);
}

function isAutoAppliedCreditTransaction(tx) {
  if (classifyPaymentTransaction(tx) !== 'credit_applied') return false;
  return normalizeText(tx.note).includes('automatically applied');
}

/**
 * Credit applied from another invoice's overpayment (stamped or legacy auto-apply).
 * These must not be deleted independently - reverse from the source payment.
 */
function isDownstreamCreditApplication(tx) {
  if (classifyPaymentTransaction(tx) !== 'credit_applied') return false;
  if (tx.sourcePaymentGroupId) return true;
  if (tx.sourceInvoiceId) return true;
  if (tx.sourceInvoiceNumber) return true;
  return isAutoAppliedCreditTransaction(tx);
}

function paymentGroupIdsMatch(left, right) {
  if (!left || !right) return false;
  return String(left) === String(right);
}

function isPrimaryPaymentStillActive(invoice, groupId) {
  return (invoice.paymentTransactions || []).some((row) => {
    if (row.isDeleted === true) return false;
    if (classifyPaymentTransaction(row) !== 'payment') return false;
    if (groupId && row.paymentGroupId) {
      return paymentGroupIdsMatch(row.paymentGroupId, groupId);
    }
    return true;
  });
}

function findUnusedCreditStoredSibling(invoice, tx, groupId) {
  return (invoice.paymentTransactions || []).find((row) => {
    if (row.isDeleted === true) return false;
    if (sameObjectId(row._id, tx._id)) return false;
    if (classifyPaymentTransaction(row) !== 'credit_stored') return false;
    if (groupId && row.paymentGroupId && !paymentGroupIdsMatch(row.paymentGroupId, groupId)) {
      return false;
    }
    return true;
  }) || null;
}

function sumDownstreamCreditAppliedAmount(matches = []) {
  return roundMoney((matches || []).reduce((sum, row) => (
    roundMoney(sum + Number(row.amount || 0))
  ), 0));
}

function mapDownstreamApplicationPreview(matches = []) {
  return (matches || []).map((row) => ({
    invoiceId: String(row.invoice?._id || ''),
    invoiceNumber: String(row.invoice?.invoiceId || ''),
    amount: roundMoney(row.amount || 0),
  }));
}

function isPriorAllocationTransaction(tx) {
  if (!tx || tx.isDeleted === true) return false;
  return String(tx.fifoAllocationRole || '') === 'prior_allocation'
    || normalizeText(tx.note).includes('from payment on invoice');
}

function isSourcePaymentInGroup(tx) {
  if (!tx || tx.isDeleted === true) return false;
  const role = String(tx.fifoAllocationRole || '');
  if (role === 'recorded_only') return true;
  if (role !== 'self_allocation') return false;
  return classifyPaymentTransaction(tx) === 'payment';
}

function resolveInvoicePropertyId(invoice) {
  const ref = invoice?.propertyId;
  if (!ref) return null;
  if (typeof ref === 'object' && ref._id) return ref._id;
  return ref;
}

function mergeAllocationRows(rows = []) {
  const byKey = new Map();
  for (const row of rows || []) {
    const amount = roundMoney(row?.amount || 0);
    if (amount <= 0.009) continue;
    const invoiceNumber = String(row?.invoiceNumber || '').trim();
    const invoiceId = String(row?.invoiceId || '').trim();
    const key = invoiceId || invoiceNumber;
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) {
      existing.amount = roundMoney(existing.amount + amount);
      if (!existing.invoiceNumber && invoiceNumber) existing.invoiceNumber = invoiceNumber;
      if (!existing.invoiceId && invoiceId) existing.invoiceId = invoiceId;
    } else {
      byKey.set(key, {
        invoiceId,
        invoiceNumber: invoiceNumber || invoiceId,
        amount,
      });
    }
  }
  return [...byKey.values()];
}

function collectStoredRedirectAllocations(tx) {
  const stored = Array.isArray(tx?.fifoRedirectedAllocations) ? tx.fifoRedirectedAllocations : [];
  if (stored.length > 0) {
    return stored.map((row) => ({
      invoiceId: String(row?.invoiceId || ''),
      invoiceNumber: String(row?.invoiceNumber || row?.invoiceId || ''),
      amount: roundMoney(row?.amount || 0),
    }));
  }

  const redirectedAmount = roundMoney(tx?.fifoRedirectedAmount || 0);
  if (redirectedAmount <= 0.009) return [];

  return [{
    invoiceId: String(tx?.fifoRedirectedToInvoiceId || ''),
    invoiceNumber: String(tx?.fifoRedirectedToInvoiceNumber || tx?.fifoRedirectedToInvoiceId || ''),
    amount: redirectedAmount,
  }];
}

function sourcePaymentGroupIds(sourceInvoice) {
  const ids = new Set();
  for (const tx of sourceInvoice?.paymentTransactions || []) {
    if (!isSourcePaymentInGroup(tx)) continue;
    const groupId = String(tx.paymentGroupId || '').trim();
    if (groupId) ids.add(groupId);
  }
  return ids;
}

function allocationPointsToSourceInvoice(row, sourceInvoice, sourceGroupIds) {
  if (!row || row.isDeleted === true) return false;
  if (row.paymentGroupId && sourceGroupIds.has(String(row.paymentGroupId))) return true;
  if (sameObjectId(row.recordedAgainstInvoiceId, sourceInvoice?._id)) return true;

  const sourceNumber = normalizeText(sourceInvoice?.invoiceId);
  if (sourceNumber && normalizeText(row.recordedAgainstInvoiceNumber) === sourceNumber) return true;

  const note = normalizeText(row.note);
  if (sourceNumber && note.includes(`from payment on invoice #${sourceNumber}`)) return true;
  return false;
}

function recordedPaymentTotalFromSourceInvoice(sourceInvoice) {
  const seenGroups = new Set();
  let total = 0;
  for (const tx of sourceInvoice?.paymentTransactions || []) {
    if (!isSourcePaymentInGroup(tx)) continue;
    const groupKey = String(tx.paymentGroupId || tx._id || '').trim() || `anon-${total}`;
    if (seenGroups.has(groupKey)) continue;
    seenGroups.add(groupKey);
    const recorded = roundMoney(tx.recordedPaymentTotal || 0);
    const applied = roundMoney(tx.amount || 0);
    const redirected = roundMoney(tx.fifoRedirectedAmount || 0);
    total = roundMoney(total + (recorded > 0.009 ? recorded : applied + redirected));
  }
  return total;
}

/**
 * Source-payment delete guard: block Invoice B while any payment originally
 * recorded on B is still applied to other invoices (A/C/D/...).
 * Status (paid/overdue) is intentionally ignored - only live source records
 * and their allocations matter.
 */
function summarizeSourcePaymentDeleteRestriction(sourceInvoice, otherInvoices = []) {
  const sourceTxs = (sourceInvoice?.paymentTransactions || []).filter((tx) => isSourcePaymentInGroup(tx));
  const sourceGroupIds = sourcePaymentGroupIds(sourceInvoice);
  const liveRows = [];

  for (const inv of otherInvoices || []) {
    for (const row of inv?.paymentTransactions || []) {
      if (!isPriorAllocationTransaction(row)) continue;
      if (!allocationPointsToSourceInvoice(row, sourceInvoice, sourceGroupIds)) continue;
      liveRows.push({
        invoiceId: String(inv._id || ''),
        invoiceNumber: String(inv.invoiceId || inv._id || ''),
        amount: roundMoney(row.amount || 0),
      });
    }
  }

  let allocations = mergeAllocationRows(liveRows);
  if (allocations.length === 0) {
    allocations = mergeAllocationRows(sourceTxs.flatMap(collectStoredRedirectAllocations));
  }

  if (allocations.length === 0) return null;

  const recordedFromSource = recordedPaymentTotalFromSourceInvoice(sourceInvoice);
  const allocationTotal = roundMoney(
    allocations.reduce((sum, row) => sum + Number(row.amount || 0), 0)
  );

  return {
    recordedPaymentTotal: recordedFromSource > 0.009 ? recordedFromSource : allocationTotal,
    allocations,
  };
}

const INVOICE_DELETE_PAYMENT_ALLOCATED = 'INVOICE_DELETE_PAYMENT_ALLOCATED';

function buildInvoiceDeleteRestrictionError(restriction) {
  return Object.assign(
    new Error('Cannot delete invoice while a recorded payment is applied to other invoices'),
    {
      status: 400,
      code: INVOICE_DELETE_PAYMENT_ALLOCATED,
      details: restriction,
    }
  );
}

async function findSourcePaymentAllocationsBlockingDelete(invoice, session = null) {
  const propertyId = resolveInvoicePropertyId(invoice);
  let otherInvoices = [];
  if (propertyId && invoice?._id) {
    let q = Invoice.find({
      _id: { $ne: invoice._id },
      propertyId,
      isDeleted: { $ne: true },
    }).select('invoiceId paymentTransactions');
    if (session) q = q.session(session);
    otherInvoices = await q.lean();
  }
  return summarizeSourcePaymentDeleteRestriction(invoice, otherInvoices);
}

async function findPriorAllocationSiblings({
  propertyId,
  paymentGroupId,
  excludeInvoiceId,
  session = null,
}) {
  if (!propertyId || !paymentGroupId) return [];

  let q = Invoice.find({
    _id: { $ne: excludeInvoiceId },
    propertyId,
    isDeleted: { $ne: true },
  });
  if (session) q = q.session(session);
  const invoices = await q;
  const matches = [];

  for (const inv of invoices || []) {
    for (const row of inv.paymentTransactions || []) {
      if (!isPriorAllocationTransaction(row)) continue;
      if (!paymentGroupIdsMatch(row.paymentGroupId, paymentGroupId)) continue;
      matches.push({
        invoice: inv,
        tx: row,
        amount: roundMoney(row.amount || 0),
      });
    }
  }

  return matches;
}

async function findSourcePaymentForGroup({
  propertyId,
  paymentGroupId,
  session = null,
}) {
  if (!propertyId || !paymentGroupId) return null;

  let q = Invoice.find({
    propertyId,
    isDeleted: { $ne: true },
  });
  if (session) q = q.session(session);
  const invoices = await q;

  for (const inv of invoices || []) {
    for (const row of inv.paymentTransactions || []) {
      if (!paymentGroupIdsMatch(row.paymentGroupId, paymentGroupId)) continue;
      if (!isSourcePaymentInGroup(row)) continue;
      return { invoice: inv, tx: row };
    }
  }

  return null;
}

function sumPriorAllocationAmount(matches = []) {
  return roundMoney((matches || []).reduce((sum, row) => (
    roundMoney(sum + Number(row.amount || 0))
  ), 0));
}

async function collectOriginalPaymentReversalContext({ invoice, tx, session = null }) {
  const groupId = tx.paymentGroupId || '';
  const selectedAmount = roundMoney(tx.amount || 0);
  const unusedStored = findUnusedCreditStoredSibling(invoice, tx, groupId);
  const recordedTotal = roundMoney(tx.recordedPaymentTotal || 0);
  const priorAllocations = groupId
    ? await findPriorAllocationSiblings({
      propertyId: invoice.propertyId,
      paymentGroupId: groupId,
      excludeInvoiceId: invoice._id,
      session,
    })
    : [];
  const priorAllocationAmount = sumPriorAllocationAmount(priorAllocations);
  const storedSiblingAmount = unusedStored ? roundMoney(unusedStored.amount || 0) : 0;
  const expectedOverpaymentCredit = roundMoney(
    Math.max(0, recordedTotal - selectedAmount - priorAllocationAmount)
  );
  const creditStoredAmount = storedSiblingAmount > 0.009
    ? storedSiblingAmount
    : expectedOverpaymentCredit;
  const originalPaymentTotal = roundMoney(
    recordedTotal > selectedAmount
      ? recordedTotal
      : selectedAmount + storedSiblingAmount
  );
  const downstream = creditStoredAmount > 0
    ? await findDownstreamCreditApplications({
      propertyId: invoice.propertyId,
      sourceInvoiceId: invoice._id,
      paymentGroupId: groupId,
      amount: creditStoredAmount,
      session,
    })
    : [];

  return {
    groupId,
    selectedAmount,
    unusedStored,
    expectedOverpaymentCredit,
    creditStoredAmount,
    originalPaymentTotal: originalPaymentTotal > 0 ? originalPaymentTotal : selectedAmount,
    downstream,
    downstreamAppliedAmount: sumDownstreamCreditAppliedAmount(downstream),
    priorAllocations,
    priorAllocationAmount: sumPriorAllocationAmount(priorAllocations),
  };
}

function serializePaymentReversalPreview({
  kind,
  reversalMode,
  selectedAmount,
  originalPaymentTotal,
  creditStoredAmount = 0,
  downstream = [],
  priorAllocations = [],
}) {
  const downstreamApplications = mapDownstreamApplicationPreview(downstream);
  const downstreamAppliedAmount = sumDownstreamCreditAppliedAmount(downstream);
  const priorAllocationReversals = mapDownstreamApplicationPreview(priorAllocations);
  return {
    kind,
    reversalMode,
    selectedAmount: roundMoney(selectedAmount),
    originalPaymentTotal: roundMoney(originalPaymentTotal || selectedAmount),
    appliedToThisInvoice: roundMoney(selectedAmount),
    creditStoredAmount: roundMoney(creditStoredAmount),
    unusedCreditAmount: roundMoney(Math.max(0, Number(creditStoredAmount || 0) - downstreamAppliedAmount)),
    downstreamApplications,
    priorAllocationReversals,
    priorAllocationAmount: sumPriorAllocationAmount(priorAllocations),
  };
}

/**
 * Read-only preview of what reversing this payment/credit row will do.
 * Used by the invoice UI confirmation dialog.
 */
async function previewRecordedPaymentReversal({ invoice, tx, session = null }) {
  const kind = classifyPaymentTransaction(tx);
  const selectedAmount = roundMoney(tx.amount || 0);
  const isPriorAllocation = isPriorAllocationTransaction(tx);
  const groupId = tx.paymentGroupId || '';

  if (kind === 'credit_stored') {
    const groupId = tx.paymentGroupId || '';
    const downstream = await findDownstreamCreditApplications({
      propertyId: invoice.propertyId,
      sourceInvoiceId: invoice._id,
      paymentGroupId: groupId,
      amount: selectedAmount,
      session,
    });
    return serializePaymentReversalPreview({
      kind,
      reversalMode: 'credit_stored',
      selectedAmount,
      originalPaymentTotal: selectedAmount,
      creditStoredAmount: selectedAmount,
      downstream,
    });
  }

  if (kind === 'credit_applied') {
    if (isDownstreamCreditApplication(tx)) {
      const sourceLabel = tx.sourceInvoiceNumber
        ? `invoice ${tx.sourceInvoiceNumber}`
        : 'the source invoice';
      return {
        kind,
        reversalMode: 'credit_applied_blocked',
        selectedAmount,
        originalPaymentTotal: selectedAmount,
        creditStoredAmount: 0,
        unusedCreditAmount: 0,
        downstreamApplications: [],
        priorAllocationReversals: [],
        priorAllocationAmount: 0,
        blocked: true,
        message: `This credit was applied from an overpayment on ${sourceLabel}. Remove the original payment there to reverse this allocation.`,
      };
    }
    return serializePaymentReversalPreview({
      kind,
      reversalMode: 'credit_applied',
      selectedAmount,
      originalPaymentTotal: selectedAmount,
    });
  }

  if (isPriorAllocation) {
    if (groupId) {
      const source = await findSourcePaymentForGroup({
        propertyId: invoice.propertyId,
        paymentGroupId: groupId,
        session,
      });
      if (source) {
        const context = await collectOriginalPaymentReversalContext({
          invoice: source.invoice,
          tx: source.tx,
          session,
        });
        return serializePaymentReversalPreview({
          kind: 'payment',
          reversalMode: 'payment_allocation',
          selectedAmount: context.selectedAmount,
          originalPaymentTotal: context.originalPaymentTotal,
          creditStoredAmount: context.creditStoredAmount,
          downstream: context.downstream,
          priorAllocations: context.priorAllocations,
        });
      }
    }
    return serializePaymentReversalPreview({
      kind: 'payment',
      reversalMode: 'prior_allocation',
      selectedAmount,
      originalPaymentTotal: selectedAmount,
    });
  }

  if (kind === 'payment') {
    const context = await collectOriginalPaymentReversalContext({ invoice, tx, session });
    return serializePaymentReversalPreview({
      kind,
      reversalMode: 'payment_allocation',
      selectedAmount: context.selectedAmount,
      originalPaymentTotal: context.originalPaymentTotal,
      creditStoredAmount: context.creditStoredAmount,
      downstream: context.downstream,
      priorAllocations: context.priorAllocations,
    });
  }

  return serializePaymentReversalPreview({
    kind: kind || 'payment',
    reversalMode: 'payment_allocation',
    selectedAmount,
    originalPaymentTotal: selectedAmount,
  });
}

async function findDownstreamCreditApplications({
  propertyId,
  sourceInvoiceId,
  paymentGroupId,
  amount,
  session = null,
}) {
  const cap = roundMoney(amount);
  if (!propertyId || cap <= 0) return [];

  let q = Invoice.find({
    _id: { $ne: sourceInvoiceId },
    propertyId,
    isDeleted: { $ne: true },
  });
  if (session) q = q.session(session);
  const invoices = await q;
  const matches = [];
  let remaining = cap;

  for (const inv of invoices || []) {
    if (remaining <= 0) break;
    for (const currentTx of inv.paymentTransactions || []) {
      if (remaining <= 0) break;
      if (currentTx.isDeleted === true) continue;
      if (classifyPaymentTransaction(currentTx) !== 'credit_applied') continue;

      const stampedGroup = currentTx.sourcePaymentGroupId || '';
      if (!paymentGroupId || !paymentGroupIdsMatch(stampedGroup, paymentGroupId)) continue;

      const take = roundMoney(Math.min(remaining, currentTx.amount || 0));
      if (take <= 0) continue;
      matches.push({ invoice: inv, tx: currentTx, amount: take });
      remaining = roundMoney(remaining - take);
    }
  }

  return matches;
}

async function unapplyInvoiceCreditTransaction({
  invoice,
  tx,
  userId,
  session = null,
  editChanges,
  pauseAutoCredit = true,
}) {
  softDeletePaymentTransaction(tx, userId);
  if (pauseAutoCredit) markInvoiceSkipAutoCredit(invoice);
  persistInvoiceTotals(invoice);
  pushInvoiceEditHistory(invoice, editChanges, userId);
  await invoice.save({ session });
}

/**
 * Reverse the selected payment/credit allocation.
 * Removing the original recorded payment also reverses sibling stored credit
 * and any later auto-applied credit funded by that payment, and clears that
 * overpayment from Property.remainingCredit.
 * Removing stored credit independently unapplies downstream credit applications
 * and removes the stored amount from the owner credit balance, while leaving
 * the original invoice payment in place.
 */
async function reverseRecordedPaymentGroup({ invoice, tx, userId, session = null }) {
  const kind = classifyPaymentTransaction(tx);
  const groupId = tx.paymentGroupId || tx.sourcePaymentGroupId || '';
  const invoiceLabel = invoice.invoiceId || String(invoice._id);
  const paidAtLabel = formatDateInAppTimezone(tx.paidAt || ClockService.nowEpoch(), {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  });
  const removedTransactions = [];
  const affectedInvoices = [];
  let creditEffect = null;
  let ledgerReverseAmount = 0;

  const trackRemoved = (currentInvoice, currentTx, currentKind) => {
    removedTransactions.push({
      invoiceId: currentInvoice._id,
      invoiceNumber: currentInvoice.invoiceId,
      amount: roundMoney(currentTx.amount || 0),
      method: currentTx.method || '',
      kind: currentKind,
      paidAt: currentTx.paidAt,
    });
  };

  if (kind === 'credit_stored') {
    const storedAmount = roundMoney(tx.amount || 0);
    const primaryStillActive = isPrimaryPaymentStillActive(invoice, groupId);
    const downstream = await findDownstreamCreditApplications({
      propertyId: invoice.propertyId,
      sourceInvoiceId: invoice._id,
      paymentGroupId: groupId,
      amount: storedAmount,
      session,
    });

    let restoredFromInvoices = 0;
    for (const row of downstream) {
      const unapplied = roundMoney(row.tx.amount || 0);
      restoredFromInvoices = roundMoney(restoredFromInvoices + unapplied);
      creditEffect = await reversePaymentTransactionCreditEffects({
        invoice: row.invoice,
        tx: row.tx,
        userId,
        session,
      }) || creditEffect;
      await unapplyInvoiceCreditTransaction({
        invoice: row.invoice,
        tx: row.tx,
        userId,
        session,
        pauseAutoCredit: primaryStillActive,
        editChanges: [
          'Credit Application Removed',
          `$${unapplied.toFixed(2)} automatically applied credit was reversed because the source overpayment credit on invoice ${invoiceLabel} was removed.`,
          primaryStillActive
            ? 'Automatic reapplication is paused for this invoice until Apply Credit is used.'
            : 'Invoice totals were recalculated.',
        ],
      });
      trackRemoved(row.invoice, row.tx, 'credit_applied');
      affectedInvoices.push(row.invoice);
    }

    // Always remove this overpayment credit from Property.remainingCredit so the
    // unit no longer shows owner credit after the storage row is deleted.
    creditEffect = await reversePaymentTransactionCreditEffects({
      invoice,
      tx,
      userId,
      session,
    }) || creditEffect;

    softDeletePaymentTransaction(tx, userId);
    persistInvoiceTotals(invoice);
    pushInvoiceEditHistory(invoice, [
      'Overpayment Credit Removed',
      `$${storedAmount.toFixed(2)} stored overpayment credit was removed from Payments Received.`,
      restoredFromInvoices > 0.009
        ? `$${restoredFromInvoices.toFixed(2)} previously auto-applied to other invoices was unapplied.`
        : null,
      'Overpayment credit was removed from the owner credit balance.',
      primaryStillActive
        ? 'The original invoice payment was not reversed.'
        : null,
    ], userId);
    await invoice.save({ session });
    trackRemoved(invoice, tx, kind);
    affectedInvoices.unshift(invoice);

    return {
      ledgerEntry: null,
      removedTransactions,
      creditEffect,
      totalRemoved: storedAmount,
      affectedInvoices,
      reversalMode: 'credit_stored',
    };
  }

  if (kind === 'credit_applied') {
    return null;
  }

  if (kind === 'payment' || isPriorAllocationTransaction(tx)) {
    const selectedAmount = roundMoney(tx.amount || 0);
    const isPriorAllocation = isPriorAllocationTransaction(tx);

    if (isPriorAllocation && groupId) {
      const source = await findSourcePaymentForGroup({
        propertyId: invoice.propertyId,
        paymentGroupId: groupId,
        session,
      });
      if (source) {
        return reverseRecordedPaymentGroup({
          invoice: source.invoice,
          tx: source.tx,
          userId,
          session,
        });
      }
    }

    const ledgerEntry = isPriorAllocation
      ? null
      : await findRecordedPaymentLedgerEntry({ invoice, tx, session });

    softDeletePaymentTransaction(tx, userId);

    if (isPriorAllocation) {
      trackRemoved(invoice, tx, kind);
      creditEffect = await adjustPropertyCreditPool(
        invoice.propertyId,
        selectedAmount,
        {
          reason: `Unapplied $${selectedAmount.toFixed(2)} allocation from invoice ${invoiceLabel}; returned to available credit`,
          paymentMethod: 'Credit Adjustment',
          source: `Invoice ${invoiceLabel} Allocation Unapplied`,
          invoiceId: invoice._id,
          invoiceNumber: invoice.invoiceId,
          createdBy: recorderObjectId(userId),
        },
        session
      );
      persistInvoiceTotals(invoice);
      pushInvoiceEditHistory(invoice, [
        'Payment Allocation Removed',
        `$${selectedAmount.toFixed(2)} applied from a payment recorded on another invoice was unapplied.`,
        creditEffect?.creditBalanceBefore != null && creditEffect?.creditBalanceAfter != null
          ? `Available credit restored: $${creditEffect.creditBalanceBefore.toFixed(2)} -> $${creditEffect.creditBalanceAfter.toFixed(2)}.`
          : `$${selectedAmount.toFixed(2)} returned to available credit.`,
        'The original payment on the source invoice was not reversed.',
      ], userId);
      await invoice.save({ session });
      affectedInvoices.push(invoice);
      return {
        ledgerEntry: null,
        removedTransactions,
        creditEffect,
        totalRemoved: selectedAmount,
        affectedInvoices,
        reversalMode: 'prior_allocation',
      };
    }

    const context = await collectOriginalPaymentReversalContext({ invoice, tx, session });
    const {
      unusedStored,
      expectedOverpaymentCredit,
      originalPaymentTotal,
      downstream,
      downstreamAppliedAmount,
      priorAllocations,
      priorAllocationAmount,
    } = context;
    let unusedStoredAmount = 0;
    removedTransactions.push({
      invoiceId: invoice._id,
      invoiceNumber: invoice.invoiceId,
      amount: originalPaymentTotal,
      method: tx.method || '',
      kind,
      paidAt: tx.paidAt,
    });

    for (const row of priorAllocations) {
      const reversedAmount = roundMoney(row.tx.amount || 0);
      softDeletePaymentTransaction(row.tx, userId);
      persistInvoiceTotals(row.invoice);
      pushInvoiceEditHistory(row.invoice, [
        'Payment Allocation Removed',
        `$${reversedAmount.toFixed(2)} applied from payment recorded on invoice ${invoiceLabel} was reversed because the original payment was removed.`,
        'Invoice totals were recalculated.',
      ], userId);
      await row.invoice.save({ session });
      trackRemoved(row.invoice, row.tx, 'payment');
      affectedInvoices.push(row.invoice);
    }

    for (const row of downstream) {
      const unapplied = roundMoney(row.tx.amount || 0);
      creditEffect = await reversePaymentTransactionCreditEffects({
        invoice: row.invoice,
        tx: row.tx,
        userId,
        session,
      }) || creditEffect;
      await unapplyInvoiceCreditTransaction({
        invoice: row.invoice,
        tx: row.tx,
        userId,
        session,
        pauseAutoCredit: false,
        editChanges: [
          'Credit Application Removed',
          `$${unapplied.toFixed(2)} automatically applied credit was reversed because the original payment on invoice ${invoiceLabel} was removed.`,
          'Invoice totals were recalculated.',
        ],
      });
      trackRemoved(row.invoice, row.tx, 'credit_applied');
      affectedInvoices.push(row.invoice);
    }

    if (unusedStored) {
      unusedStoredAmount = roundMoney(unusedStored.amount || 0);
      let propQuery = Property.findById(invoice.propertyId).select('remainingCredit');
      if (session) propQuery = propQuery.session(session);
      const propertyDoc = await propQuery;
      const pool = roundMoney(Number(propertyDoc?.remainingCredit || 0));
      const subtractAmount = roundMoney(Math.min(pool, unusedStoredAmount));
      if (subtractAmount > 0.009) {
        if (subtractAmount + 0.009 >= unusedStoredAmount) {
          creditEffect = await reversePaymentTransactionCreditEffects({
            invoice,
            tx: unusedStored,
            userId,
            session,
          }) || creditEffect;
        } else {
          creditEffect = await adjustPropertyCreditPool(
            invoice.propertyId,
            -subtractAmount,
            {
              reason: `Removed $${subtractAmount.toFixed(2)} overpayment credit from deleted payment on invoice ${invoiceLabel}`,
              paymentMethod: 'Credit Adjustment',
              source: `Invoice ${invoiceLabel} Payment Deleted`,
              invoiceId: invoice._id,
              invoiceNumber: invoice.invoiceId,
              paymentGroupId: groupId,
              createdBy: recorderObjectId(userId),
            },
            session
          ) || creditEffect;
        }
      }
      softDeletePaymentTransaction(unusedStored, userId);
      trackRemoved(invoice, unusedStored, 'credit_stored');
      ledgerReverseAmount = roundMoney(selectedAmount + unusedStoredAmount);
    } else {
      ledgerReverseAmount = selectedAmount;
    }

    if (ledgerReverseAmount <= 0 && originalPaymentTotal > 0) {
      ledgerReverseAmount = originalPaymentTotal;
    } else if (priorAllocationAmount > 0) {
      ledgerReverseAmount = roundMoney(Math.max(ledgerReverseAmount, originalPaymentTotal));
    }

    if (expectedOverpaymentCredit > 0 && !unusedStored) {
      const poolCreditToReclaim = expectedOverpaymentCredit;
      if (poolCreditToReclaim > 0.009) {
        let propQuery = Property.findById(invoice.propertyId).select('remainingCredit');
        if (session) propQuery = propQuery.session(session);
        const propertyDoc = await propQuery;
        const pool = roundMoney(Number(propertyDoc?.remainingCredit || 0));
        const reclaimAmount = roundMoney(Math.min(pool, poolCreditToReclaim));
        if (reclaimAmount > 0.009) {
          creditEffect = await adjustPropertyCreditPool(
            invoice.propertyId,
            -reclaimAmount,
            {
              reason: `Reclaimed $${reclaimAmount.toFixed(2)} unused credit from removed payment on invoice ${invoiceLabel}`,
              paymentMethod: 'Credit Adjustment',
              source: `Invoice ${invoiceLabel} Payment Deleted`,
              invoiceId: invoice._id,
              invoiceNumber: invoice.invoiceId,
              paymentGroupId: groupId,
              createdBy: recorderObjectId(userId),
            },
            session
          ) || creditEffect;
        }
      }
    }

    persistInvoiceTotals(invoice);
    pushInvoiceEditHistory(invoice, [
      'Payment Removed',
      `A recorded payment of $${originalPaymentTotal.toFixed(2)} on ${paidAtLabel} was removed.`,
      `$${selectedAmount.toFixed(2)} allocated to this invoice was reversed.`,
      priorAllocationAmount > 0.009
        ? `$${priorAllocationAmount.toFixed(2)} previously applied to earlier invoices was reversed.`
        : null,
      unusedStoredAmount > 0.009
        ? `$${unusedStoredAmount.toFixed(2)} overpayment credit generated from this payment was reversed.`
        : null,
      downstreamAppliedAmount > 0.009
        ? `$${downstreamAppliedAmount.toFixed(2)} previously auto-applied to other invoices was unapplied.`
        : null,
      'Invoice totals and credit balances were recalculated.',
    ], userId);
    await invoice.save({ session });
    affectedInvoices.unshift(invoice);

    if (ledgerReverseAmount > 0) {
      await new LedgerEntry({
        unitId: invoice.propertyId,
        type: 'payment',
        amount: ledgerReverseAmount,
        referenceId: invoice._id,
        metadata: {
          reason: `Payment allocation removed from invoice ${invoiceLabel}`,
          source: 'invoice_payment_deleted',
          reversedLedgerEntryId: ledgerEntry?._id,
          removedTransactions,
          remainingCredit: 0,
          createdBy: recorderObjectId(userId),
        },
      }).save(session ? { session } : {});
    }

    return {
      ledgerEntry,
      removedTransactions,
      creditEffect,
      totalRemoved: originalPaymentTotal || ledgerReverseAmount || selectedAmount,
      affectedInvoices,
      reversalMode: 'payment_allocation',
    };
  }

  return null;
}

async function reversePaymentTransactionCreditEffects({
  invoice,
  tx,
  userId,
  session = null,
}) {
  const amount = roundMoney(tx?.amount || 0);
  if (amount <= 0) return null;

  const kind = classifyPaymentTransaction(tx);
  const invoiceLabel = invoice.invoiceId || String(invoice._id);
  const recorderId =
    userId && mongoose.Types.ObjectId.isValid(String(userId))
      ? new mongoose.Types.ObjectId(String(userId))
      : undefined;

  if (kind === 'credit_stored') {
    return adjustPropertyCreditPool(
      invoice.propertyId,
      -amount,
      {
        reason: `Removed overpayment credit from deleted payment on invoice ${invoiceLabel}`,
        paymentMethod: 'Credit Adjustment',
        source: `Invoice ${invoiceLabel} Payment Deleted`,
        invoiceId: invoice._id,
        invoiceNumber: invoice.invoiceId,
        deletedPaymentAmount: amount,
        deletedPaymentMethod: tx.method,
        createdBy: recorderId,
      },
      session
    );
  }

  if (kind === 'credit_returned') {
    return adjustPropertyCreditPool(
      invoice.propertyId,
      -amount,
      {
        reason: `Reversed credit return from deleted payment on invoice ${invoiceLabel}`,
        paymentMethod: 'Credit Adjustment',
        source: `Invoice ${invoiceLabel} Payment Deleted`,
        invoiceId: invoice._id,
        invoiceNumber: invoice.invoiceId,
        deletedPaymentAmount: amount,
        deletedPaymentMethod: tx.method,
        createdBy: recorderId,
      },
      session
    );
  }

  if (kind === 'credit_applied') {
    return adjustPropertyCreditPool(
      invoice.propertyId,
      amount,
      {
        reason: `Returned applied credit from deleted payment on invoice ${invoiceLabel}`,
        paymentMethod: 'Credit Adjustment',
        source: `Invoice ${invoiceLabel} Payment Deleted`,
        invoiceId: invoice._id,
        invoiceNumber: invoice.invoiceId,
        deletedPaymentAmount: amount,
        deletedPaymentMethod: tx.method,
        createdBy: recorderId,
      },
      session
    );
  }

  return null;
}

async function releaseInvoiceCreditsBeforeDelete(invoice, userId, session = null) {
  const { creditApplied, creditStored, netDelta } = getInvoiceDeleteCreditDelta(invoice);

  if (netDelta === 0) return null;

  const invoiceLabel = invoice.invoiceId || String(invoice._id);
  const recorderId =
    userId && mongoose.Types.ObjectId.isValid(String(userId))
      ? new mongoose.Types.ObjectId(String(userId))
      : undefined;

  return adjustPropertyCreditPool(
    invoice.propertyId,
    netDelta,
    {
      reason: `Invoice ${invoiceLabel} deleted; credit balance adjusted`,
      paymentMethod: 'Credit Adjustment',
      source: `Invoice ${invoiceLabel} Deleted`,
      invoiceId: invoice._id,
      invoiceNumber: invoice.invoiceId,
      creditAppliedReleased: creditApplied,
      creditStoredRemoved: creditStored,
      createdBy: recorderId,
    },
    session
  );
}

module.exports = {
  adjustPropertyCreditPool,
  reversePaymentTransactionCreditEffects,
  reverseRecordedPaymentGroup,
  previewRecordedPaymentReversal,
  releaseInvoiceCreditsBeforeDelete,
  recalculateInvoiceTotalsFromTransactions,
  recalculateInvoiceStatus,
  getInvoiceDeleteCreditDelta,
  isDownstreamCreditApplication,
  isPriorAllocationTransaction,
  summarizeSourcePaymentDeleteRestriction,
  findSourcePaymentAllocationsBlockingDelete,
  buildInvoiceDeleteRestrictionError,
  INVOICE_DELETE_PAYMENT_ALLOCATED,
};
