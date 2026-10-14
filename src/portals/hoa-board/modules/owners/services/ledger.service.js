/**
 * ------------------------------------------------------------------
 * File: ledger.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * invoice.service, invoicePolicyTerm.service, ledger.controller, owner.service
 * ------------------------------------------------------------------
 */
const mongoose = require('mongoose');
const LedgerEntry = require('../models/ledgerEntry.model');
const Invoice = require('../../invoice/model/invoice.model');
const Property = require('../../property/model/property.model');
const logger = require('../../../../../common/logger');
const { INVOICE_STATUS, INVOICE_TYPES, HOA_UNIT_SCHEDULE_INVOICE_TYPES } = require('../../../../../common/constants/invoice');
const { ensureLateFeeInvoicesForUnit } = require('./unitLateFee.service');
const { ClockService, DateUtil } = require('../../../../../common/date');
const { resolvePropertyBillingTimezone } = require('../../../../../common/helpers/billingCalendar');
const {
  getDateKeyInTimeZone,
  billingCalendarDateKey,
  isDueDateOnOrBeforeToday,
  isDerivedInvoiceOverduePending,
  isPastDueOutstandingInvoice,
  getTodayAnchorInTimeZone,
  compareCalendarDateToToday,
  normalizeDateToStartOfDay,
  formatDateInAppTimezone,
} = require('../../../../../common/helpers/hoaBillingDates');
const { logActivity } = require('../../dashboard/service/activity.service');
const Expense = require('../../expense/model/expense.model');
const { allocateUniqueExpenseId } = require('../../expense/helpers/expenseId.helper');
const User = require('../../../../../shared/modules/users/models/user.model');
const { buildCreditAppliedPaymentTransaction } = require('../../invoice/helpers/invoiceCreditPayment.helper');
const { isInvoiceAutoCreditPaused } = require('../../invoice/helpers/invoiceAutoCredit.helper');
const { computeCollectableBalance } = require('../../invoice/helpers/invoiceWaive.helper');
const { recalculateInvoiceStatus } = require('../../invoice/helpers/invoicePaymentReversal.helper');
const {
  sumCreditAppliedOnInvoice,
  classifyPaymentTransaction,
  sumProcessingAmountOnInvoice,
  getInvoiceCollectableBalance,
} = require('../../invoice/helpers/invoicePaymentTransactions.helper');
const {
  ensureEntityNotesHaveCreator,
  resolveEntityNoteCreatorId,
} = require('../../../../../common/schemas/entityNote.schema');

const makeInvoiceId = () => `INV${Math.floor(100000 + Math.random() * 900000)}`;

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

/**
 * build Invoice Credit Application Bulk Ops
 *
 * Performs logic operations for buildInvoiceCreditApplicationBulkOps.
 *
 * @param applications - Request/input argument
 * @returns Operations result
 */
function buildInvoiceCreditApplicationBulkOps(applications) {
  if (!applications || applications.length === 0) return [];
  return applications.map(({ invoiceId, setFields, paymentTransaction }) => ({
    updateOne: {
      filter: { _id: toObjectId(invoiceId) || invoiceId },
      update: {
        $set: setFields,
        $push: { paymentTransactions: paymentTransaction },
      },
    },
  }));
}

async function bulkWriteInvoiceCreditApplications(applications, session) {
  const ops = buildInvoiceCreditApplicationBulkOps(applications);
  if (ops.length === 0) return;
  const opts = session ? { session } : {};
  await Invoice.bulkWrite(ops, opts);
}

async function bulkWriteLedgerRemainingCreditUpdates(updates, session) {
  if (!updates || updates.length === 0) return;
  const ops = updates.map(({ entryId, remainingCredit }) => ({
    updateOne: {
      filter: { _id: toObjectId(entryId) || entryId },
      update: { $set: { 'metadata.remainingCredit': remainingCredit } },
    },
  }));
  const opts = session ? { session } : {};
  await LedgerEntry.bulkWrite(ops, opts);
}

/**
 * build Ledger Credit Drain Updates
 *
 * Performs logic operations for buildLedgerCreditDrainUpdates.
 *
 * @param creditEntries - Request/input argument
 * @param consumedCredit - Request/input argument
 * @returns Operations result
 */
function buildLedgerCreditDrainUpdates(creditEntries, consumedCredit) {
  const updates = [];
  let toDrain = roundMoney(consumedCredit);

  for (const entry of creditEntries || []) {
    if (toDrain <= 0) break;
    if (entry.metadata?.source === 'invoice_overpayment') continue;

    const rc = Number(entry.metadata?.remainingCredit || 0);
    if (rc <= 0) continue;

    const drain = Math.min(toDrain, rc);
    const newRc = roundMoney(rc - drain);
    toDrain = roundMoney(toDrain - drain);
    updates.push({ entryId: entry._id, remainingCredit: newRc });
  }

  return updates;
}

/**
 * is Audit Only Credit Adjustment
 *
 * Performs logic operations for isAuditOnlyCreditAdjustment.
 *
 * @param entry - Request/input argument
 * @returns Operations result
 */
function isAuditOnlyCreditAdjustment(entry) {
  if (entry?.metadata?.source === 'credit_release_expense') return true;
  if (entry?.metadata?.remainingCredit === 0) return true;
  if (entry?.metadata?.creditBalanceBefore != null && entry?.metadata?.creditBalanceAfter != null) {
    return true;
  }
  return false;
}

/**
 * HOA calendar semantics: overdue only when due date is **before** today's calendar date (timezone).
 * Stored `Overdue` on an invoice whose due calendar day is still today (or future) is treated as **Due** (`Pending`).
 */
const getEffectiveInvoiceStatus = (invoice) => {
  if (!invoice) return INVOICE_STATUS.PENDING;
  const st = String(invoice.status || INVOICE_STATUS.PENDING);
  const dueCmp = compareCalendarDateToToday(invoice.dueDate, ClockService.now());

  if (st === String(INVOICE_STATUS.OVERDUE) && Number.isFinite(dueCmp) && dueCmp >= 0) {
    return INVOICE_STATUS.PENDING;
  }
  return isDerivedInvoiceOverduePending(invoice, INVOICE_STATUS.PENDING)
    ? INVOICE_STATUS.OVERDUE
    : invoice.status || INVOICE_STATUS.PENDING;
};

const roundMoney = (n) => Number((Number(n) || 0).toFixed(2));

/**
 * Active overpayment credit_stored rows on a unit, oldest first.
 * Used to stamp auto-applied credit with the originating payment group.
 */
async function findActiveOverpaymentCreditSources(unitId, session = null) {
  if (!unitId) return [];
  let q = Invoice.find({
    propertyId: unitId,
    isDeleted: { $ne: true },
  }).select('_id invoiceId paymentTransactions');
  if (session) q = q.session(session);
  const invoices = await q;
  const sources = [];
  for (const inv of invoices || []) {
    for (const tx of inv.paymentTransactions || []) {
      if (tx?.isDeleted === true) continue;
      if (classifyPaymentTransaction(tx) !== 'credit_stored') continue;
      sources.push({
        invoiceId: inv._id,
        invoiceNumber: inv.invoiceId || '',
        paymentGroupId: tx.paymentGroupId || '',
        amount: roundMoney(tx.amount || 0),
        paidAt: tx.paidAt,
      });
    }
  }
  const appliedByGroup = new Map();
  for (const inv of invoices || []) {
    for (const tx of inv.paymentTransactions || []) {
      if (tx?.isDeleted === true) continue;
      if (classifyPaymentTransaction(tx) !== 'credit_applied') continue;
      const groupId = String(tx.sourcePaymentGroupId || '').trim();
      if (!groupId) continue;
      appliedByGroup.set(
        groupId,
        roundMoney((appliedByGroup.get(groupId) || 0) + Number(tx.amount || 0)),
      );
    }
  }

  for (const source of sources) {
    const applied = appliedByGroup.get(source.paymentGroupId) || 0;
    source.amount = roundMoney(Math.max(0, source.amount - applied));
  }

  sources.sort((a, b) => {
    const aTime = a.paidAt ? new Date(a.paidAt).getTime() : 0;
    const bTime = b.paidAt ? new Date(b.paidAt).getTime() : 0;
    return aTime - bTime;
  });
  return sources.filter((source) => source.amount > 0.009);
}

/**
 * Consume credit sources FIFO and return one slice per originating payment.
 * Combined applications must not collapse onto the first source - reversal of
 * Payment 1 should only unwind Payment 1's portion.
 */
function takeCreditSourceSlices(sources, applyAmount) {
  let remaining = roundMoney(applyAmount);
  const slices = [];
  for (const source of sources || []) {
    if (remaining <= 0.009) break;
    if (!(source.amount > 0.009)) continue;
    const take = roundMoney(Math.min(source.amount, remaining));
    source.amount = roundMoney(source.amount - take);
    remaining = roundMoney(remaining - take);
    slices.push({
      amount: take,
      sourcePaymentGroupId: source.paymentGroupId || '',
      sourceInvoiceId: source.invoiceId,
      sourceInvoiceNumber: source.invoiceNumber || '',
    });
  }
  if (remaining > 0.009) {
    slices.push({ amount: remaining });
  }
  return slices;
}

function buildSlicedCreditAppliedTransactions({
  applyAmount,
  startingBalanceDue,
  paidAt,
  note,
  source,
  creditSources,
}) {
  const slices = takeCreditSourceSlices(creditSources, applyAmount);
  let balanceCursor = roundMoney(startingBalanceDue);
  return slices.map((slice) => {
    balanceCursor = roundMoney(balanceCursor - Number(slice.amount || 0));
    return buildCreditAppliedPaymentTransaction({
      amount: slice.amount,
      balanceAfter: balanceCursor,
      paidAt,
      note,
      source,
      sourcePaymentGroupId: slice.sourcePaymentGroupId,
      sourceInvoiceId: slice.sourceInvoiceId,
      sourceInvoiceNumber: slice.sourceInvoiceNumber,
    });
  });
}

const EMPTY_COLLECTION_STATS = {
  period: '',
  total: 0,
  collected: 0,
  processing: 0,
  comingDue: 0,
  collectionPct: 0,
};

function resolveInvoiceProcessingAmount(invoice) {
  const stored = Number(invoice?.processingAmount || 0);
  if (stored > 0) return stored;
  const effectiveStatus = getEffectiveInvoiceStatus(invoice);
  if (
    effectiveStatus === INVOICE_STATUS.PROCESSING
    || String(invoice?.status) === String(INVOICE_STATUS.PROCESSING)
  ) {
    return sumProcessingAmountOnInvoice(invoice);
  }
  return 0;
}

/**
 * Amount-collection KPIs for the property "Upcoming Invoices" card.
 * Processing includes any invoice with in-flight payments, regardless of due date.
 */
function computeCollectionStatsFromInvoices(invoices, now = ClockService.now()) {
  const anchorPlus30 = (() => {
    const a = getTodayAnchorInTimeZone();
    const d = a ? DateUtil.fromEpoch(a.getTime()) : DateUtil.fromEpoch(now.getTime());
    d.setUTCDate(d.getUTCDate() + 30);
    return d;
  })();

  const todayKeyCs = getDateKeyInTimeZone(now);
  const horizonKeyCs = getDateKeyInTimeZone(anchorPlus30);

  const todayInvoices = invoices.filter((i) => {
    const dk = billingCalendarDateKey(i.dueDate);
    return Boolean(dk && todayKeyCs && dk <= todayKeyCs);
  });

  const collectionTotal = todayInvoices.reduce((s, i) => s + Number(i.subAmount || 0), 0);
  const collectionCollected = todayInvoices.reduce((s, i) => s + Number(i.alreadyPaid || 0), 0);
  const collectionProcessing = invoices.reduce(
    (s, i) => s + resolveInvoiceProcessingAmount(i),
    0,
  );
  const collectionComingDue = invoices
    .filter((i) => {
      if (Number(i.balanceDue || 0) <= 0) return false;
      const dk = billingCalendarDateKey(i.dueDate);
      return Boolean(dk && todayKeyCs && horizonKeyCs && dk >= todayKeyCs && dk <= horizonKeyCs);
    })
    .reduce((s, i) => s + Number(i.balanceDue || 0), 0);
  const collectionPct = collectionTotal > 0
    ? Math.min((collectionCollected / collectionTotal) * 100, 100)
    : 0;

  return {
    period: formatDateInAppTimezone(now, { month: 'short', year: 'numeric' }),
    total: collectionTotal,
    collected: collectionCollected,
    processing: roundMoney(collectionProcessing),
    comingDue: collectionComingDue,
    collectionPct,
  };
}

const normalizeOwnerIdStrings = (values = []) => (
  [...new Set((Array.isArray(values) ? values : [values])
    .filter(Boolean)
    .map((value) => value.toString()))]
);

/**
 * Decide whether opening-balance ledger rows may contribute to displayed net/overdue.
 * Display balances must follow active invoices; ledger opening balance is only for
 * pre-invoice onboarding when active owners exist and billing has not started.
 */
async function resolveBillingInvoiceState(unitId, objId, activeInvoices, session, options = {}) {
  const activeCount = Array.isArray(activeInvoices) ? activeInvoices.length : 0;
  if (activeCount > 0) {
    return { hasGeneratedInvoices: true, includeOpeningInNet: false };
  }

  const propertyDoc = options.cachedProperty != null
    ? options.cachedProperty
    : await (() => {
      let propQuery = Property.findById(objId).select('hasGeneratedInvoices associatedOwnerIds');
      if (session) propQuery = propQuery.session(session);
      return propQuery.lean();
    })();

  if (propertyDoc?.hasGeneratedInvoices) {
    return { hasGeneratedInvoices: true, includeOpeningInNet: false };
  }

  const hasSoftDeletedInvoice = options.cachedHasSoftDeletedInvoice != null
    ? options.cachedHasSoftDeletedInvoice
    : await (() => {
      let softDeletedQuery = Invoice.exists({ propertyId: objId, isDeleted: true });
      if (session) softDeletedQuery = softDeletedQuery.session(session);
      return softDeletedQuery;
    })();
  if (hasSoftDeletedInvoice) {
    if (!options.readOnly) {
      await markPropertyHasGeneratedInvoices(objId, session);
    }
    return { hasGeneratedInvoices: true, includeOpeningInNet: false };
  }

  const cachedEntries = options.cachedEntries;
  const hasLedgerActivity = options.cachedHasLedgerActivity != null
    ? options.cachedHasLedgerActivity
    : cachedEntries != null
      ? cachedEntries.some((entry) => entry.type === 'payment' || entry.type === 'adjustment')
      : await (() => {
        let ledgerActivityQuery = LedgerEntry.exists({
          unitId: objId,
          type: { $in: ['payment', 'adjustment'] },
        });
        if (session) ledgerActivityQuery = ledgerActivityQuery.session(session);
        return ledgerActivityQuery;
      })();
  if (hasLedgerActivity) {
    if (!options.readOnly) {
      await markPropertyHasGeneratedInvoices(objId, session);
    }
    return { hasGeneratedInvoices: true, includeOpeningInNet: false };
  }

  const ownerIds = normalizeOwnerIdStrings(propertyDoc?.associatedOwnerIds || []);
  let hasActiveOwners = ownerIds.length > 0;
  if (hasActiveOwners) {
    const ownerOids = ownerIds.map((id) => toObjectId(id)).filter(Boolean);
    let ownerQuery = User.countDocuments({ _id: { $in: ownerOids }, isDeleted: { $ne: true } });
    if (session) ownerQuery = ownerQuery.session(session);
    hasActiveOwners = (await ownerQuery) > 0;
  }

  return {
    hasGeneratedInvoices: false,
    includeOpeningInNet: hasActiveOwners,
  };
}

async function markPropertyHasGeneratedInvoices(unitId, session) {
  const updateOpts = session ? { session } : {};
  await Property.findByIdAndUpdate(unitId, { $set: { hasGeneratedInvoices: true } }, updateOpts);
}

const PLACEHOLDER_OWNER_EMAIL = 'owner-contact-not-on-file@credit-expense.hoa';
const PLACEHOLDER_BOARD_EMAIL = 'board-contact-not-on-file@credit-expense.hoa';
/** Auto-created when last owner leaves or Start Fresh clears unapplied credit. */
const CREDIT_RELEASE_EXPENSE_CATEGORY = 'Credit release';

/** Booked dollars for one credit-release expense row (pending or paid). */
function resolveCreditReleaseExpenseBookedAmount(expenseRow) {
  const total = roundMoney(Number(expenseRow?.total || 0));
  if (total > 0) return total;

  const fromItems = roundMoney(
    (expenseRow?.expenseItems || []).reduce((sum, item) => {
      if (String(item?.category || '') !== CREDIT_RELEASE_EXPENSE_CATEGORY) return sum;
      return sum + Math.max(0, Number(item?.amount || 0));
    }, 0)
  );
  return fromItems;
}

/**
 * Persist a credit-release HOA expense inside the caller's session.
 * Uses `save()` so `total` is always set (insertMany from `create([doc])` skips pre-save).
 */
async function createCreditReleaseExpenseInSession(expensePayload, session) {
  if (!session) throw Object.assign(new Error('session is required'), { status: 500 });
  const payload = { ...expensePayload };
  if (!payload.total) {
    payload.total = resolveCreditReleaseExpenseBookedAmount(payload);
  }
  const expense = new Expense(payload);
  expense.expenseId =
    payload.expenseId ||
    (await allocateUniqueExpenseId({ session }));
  return expense.save({ session });
}

/**
 * display Name From User Doc
 *
 * Performs logic operations for displayNameFromUserDoc.
 *
 * @param u - Request/input argument
 * @returns Operations result
 */
function displayNameFromUserDoc(u) {
  if (!u) return '';
  return `${u.firstName || ''} ${u.lastName || ''}`.trim() || String(u.email || '').trim() || '';
}

async function loadUserContactForExpense(userId, session) {
  const fallback = { displayName: 'HOA board member', email: '', phone: '' };
  if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) return fallback;
  const oid = new mongoose.Types.ObjectId(userId);
  let q = User.findById(oid).select('firstName lastName email phone');
  if (session) q = q.session(session);
  const u = await q.lean();
  if (!u) return fallback;
  const displayName = displayNameFromUserDoc(u) || 'HOA board member';
  return {
    displayName: String(displayName).slice(0, 200),
    email: String(u.email || '').trim(),
    phone: String(u.phone || '').trim(),
  };
}

async function loadVendorOwnersForExpense(ownerIds, session) {
  const ids = (ownerIds || []).map((id) => toObjectId(id)).filter(Boolean);
  const empty = {
    vendorLabel: 'Prior unit occupants',
    primaryEmail: '',
    primaryPhone: '',
    users: [],
  };
  if (ids.length === 0) return empty;
  let q = User.find({ _id: { $in: ids } }).select('firstName lastName email phone');
  if (session) q = q.session(session);
  const users = await q.lean();
  const names = users.map((u) => displayNameFromUserDoc(u)).filter(Boolean);
  const vendorLabel = names.length ? names.join(', ') : 'Prior unit occupants';
  let primaryEmail = '';
  let primaryPhone = '';
  for (const u of users) {
    const e = String(u.email || '').trim();
    const p = String(u.phone || '').trim();
    if (e && !primaryEmail) primaryEmail = e;
    if (p && !primaryPhone) primaryPhone = p;
    if (primaryEmail && primaryPhone) break;
  }
  return {
    vendorLabel: String(vendorLabel).slice(0, 200),
    primaryEmail,
    primaryPhone,
    users,
  };
}

/**
 * ensure Email Or Phone
 *
 * Performs logic operations for ensureEmailOrPhone.
 *
 * @param email - Request/input argument
 * @param phone - Request/input argument
 * @param placeholderEmail - Request/input argument
 * @returns Operations result
 */
function ensureEmailOrPhone(email, phone, placeholderEmail) {
  const e = String(email || '').trim();
  const p = String(phone || '').trim();
  if (e || p) return { email: e, phone: p };
  return { email: placeholderEmail, phone: '' };
}

/**
 * HOA credit-release expenses: vendor line = owner(s); payee[0] = board member contact; payee[1] = owner contact.
 * Ensures at least an email placeholder when both phone and email are missing (audit trail).
 *
 * @param {object} opts
 * @param {object} opts.unitDoc
 * @param {string|import('mongoose').Types.ObjectId} opts.unitId
 * @param {number} opts.creditReleasedExpense
 * @param {string} [opts.performedBy]
 * @param {import('mongoose').ClientSession} [opts.session]
 * @param {string[]} opts.vendorOwnerUserIds
 * @param {string} opts.expenseItemDescription
 */
async function buildUnappliedCreditReleaseExpensePayload(opts) {
  const {
    unitDoc,
    unitId,
    creditReleasedExpense,
    performedBy,
    session,
    vendorOwnerUserIds,
    expenseItemDescription,
  } = opts;

  const objId = mongoose.Types.ObjectId.isValid(unitId) ? new mongoose.Types.ObjectId(unitId) : unitId;
  const unitLabel =
    unitDoc.unitDetails && unitDoc.unitDetails[0] && unitDoc.unitDetails[0].unitName
      ? String(unitDoc.unitDetails[0].unitName)
      : 'Unit';
  const bankRef = unitDoc.depositBankAccountId ? String(unitDoc.depositBankAccountId) : '-';
  const propTitle = String(unitDoc.name || 'HOA Unit').slice(0, 200);

  const board = await loadUserContactForExpense(performedBy, session);
  const boardReach = ensureEmailOrPhone(board.email, board.phone, PLACEHOLDER_BOARD_EMAIL);

  const vendors = await loadVendorOwnersForExpense(vendorOwnerUserIds, session);
  const ownerReach = ensureEmailOrPhone(vendors.primaryEmail, vendors.primaryPhone, PLACEHOLDER_OWNER_EMAIL);

  const performedByOid =
    performedBy && mongoose.Types.ObjectId.isValid(String(performedBy))
      ? new mongoose.Types.ObjectId(String(performedBy))
      : undefined;

  const hoaIdRaw = unitDoc?.hoaId;
  const hoaIdOid =
    hoaIdRaw && mongoose.Types.ObjectId.isValid(String(hoaIdRaw))
      ? new mongoose.Types.ObjectId(String(hoaIdRaw))
      : undefined;

  return {
    taxableEntity: propTitle,
    bankAccount: bankRef,
    property: objId,
    unit: unitLabel.slice(0, 100),
    ...(hoaIdOid ? { hoaId: hoaIdOid } : {}),
    payees: [
      {
        name: board.displayName,
        contact: 'Unapplied resident credit (HOA)',
        email: boardReach.email || undefined,
        phone: boardReach.phone || undefined,
      },
      {
        name: vendors.vendorLabel,
        contact: 'Unapplied owner credit',
        email: ownerReach.email || undefined,
        phone: ownerReach.phone || undefined,
      },
    ],
    expenseItems: [
      {
        date: ClockService.now(),
        category: CREDIT_RELEASE_EXPENSE_CATEGORY,
        description: String(expenseItemDescription || '').slice(0, 500),
        amount: roundMoney(creditReleasedExpense),
      },
    ],
    vendorPaidTo: vendors.vendorLabel.slice(0, 200),
    notes: [
      { text: 'Unapplied owner credit', createdBy: performedByOid },
      { text: 'Unapplied resident credit (HOA)', createdBy: performedByOid },
    ],
    expenseDate: ClockService.now(),
    // Keep dueDate slightly ahead of wall clock so pre-save does not flip status to overdue.
    dueDate: new Date(ClockService.nowEpoch() + 60_000),
    status: 'pending',
    total: roundMoney(creditReleasedExpense),
    createdBy: performedByOid,
    hoaBoardMemberId: performedByOid,
  };
}

/**
 * Sum credit-release HOA expenses already booked for unit(s). Credit is consumed when the
 * expense is created (pending or paid) - paying the expense must not restore property credit.
 *
 * @returns {Promise<Map<string, number>>} propertyId string -> booked dollars
 */
async function sumBookedCreditReleaseExpenseByUnitIds(unitIds, session = null) {
  const objIds = (unitIds || []).map((id) => toObjectId(id)).filter(Boolean);
  const totals = new Map();
  if (objIds.length === 0) return totals;

  let q = Expense.find({
    property: { $in: objIds },
    isDeleted: { $ne: true },
    'expenseItems.category': CREDIT_RELEASE_EXPENSE_CATEGORY,
  }).select('property total expenseItems.category expenseItems.amount').lean();
  if (session) q = q.session(session);
  const rows = await q;

  for (const row of rows || []) {
    const key = String(row.property);
    const booked = resolveCreditReleaseExpenseBookedAmount(row);
    if (booked <= 0) continue;
    totals.set(key, roundMoney((totals.get(key) || 0) + booked));
  }
  return totals;
}

/** Reduce displayed credit pool by credit already booked on credit-release expenses. */
function applyBookedCreditReleaseOffset(creditPool, bookedCreditRelease) {
  const pool = roundMoney(creditPool);
  const booked = roundMoney(bookedCreditRelease);
  if (pool <= 0 || booked <= 0) return pool;
  return roundMoney(Math.max(0, pool - booked));
}

/**
 * When invoice generation computes a leftover credit pool, do not persist it if a
 * credit-release HOA expense already consumed that credit (owner removal / Start Fresh).
 */
async function resolvePropertyRemainingCreditAfterInvoiceGeneration(unitId, computedRemainingCredit, session = null) {
  const objId = toObjectId(unitId);
  if (!objId) return roundMoney(computedRemainingCredit || 0);

  const bookedMap = await sumBookedCreditReleaseExpenseByUnitIds([objId], session);
  const booked = roundMoney(bookedMap.get(String(objId)) || 0);
  if (booked > 0) return 0;
  return roundMoney(computedRemainingCredit || 0);
}

/**
 * Clear every ledger-side credit source when booking a credit-release expense.
 * Must run in the caller's MongoDB session alongside expense creation.
 */
async function drainLedgerCreditSourcesForRelease(unitId, creditReleasedExpense, performedBy, session) {
  if (!session) throw Object.assign(new Error('session is required'), { status: 500 });

  const objId = toObjectId(unitId) || unitId;
  const released = roundMoney(creditReleasedExpense);
  if (!objId || released <= 0) return;

  await Property.findByIdAndUpdate(
    objId,
    { $set: { remainingCredit: 0, startingBalance: 0 } },
    { session, new: true }
  );

  // All negative adjustments represent unapplied credit; zero remainingCredit so balance math
  // cannot re-infer credit via abs(amount) when metadata.remainingCredit was never set.
  await LedgerEntry.updateMany(
    { unitId: objId, type: 'adjustment', amount: { $lt: 0 } },
    { $set: { 'metadata.remainingCredit': 0 } },
    { session }
  );

  await LedgerEntry.updateMany(
    { unitId: objId, type: 'opening_balance' },
    { $set: { amount: 0 } },
    { session }
  );

  const recorderId =
    performedBy && mongoose.Types.ObjectId.isValid(String(performedBy))
      ? new mongoose.Types.ObjectId(String(performedBy))
      : undefined;

  await new LedgerEntry({
    unitId: objId,
    type: 'adjustment',
    amount: 0,
    metadata: {
      reason: `Unapplied resident credit of $${released.toFixed(2)} booked as HOA credit-release expense`,
      source: 'credit_release_expense',
      creditReleasedExpense: released,
      remainingCredit: 0,
      creditBalanceBefore: released,
      creditBalanceAfter: 0,
      createdBy: recorderId || null,
    },
  }).save({ session });
}

/**
 * Unapplied credit from a negative starting balance, inferred when Property.remainingCredit
 * is missing/0 in DB. Walks unit_schedule "Month N" RENT invoices in due-date order, FIFO, and
 * subtracts (from the pool) the portion of each past/current invoice that was alreadyPaid (credit applied at gen).
 * Matches generateUnitInvoices: credit only ever applies to invoices with dueDate <= "today" at the time; here we
 * use the same for each month up to the summary's today.
 */
function inferUnappliedScheduleCreditFromInvoices(invoices, _todayNormalized, initialPool) {
  const pool0 = roundMoney(Math.max(0, initialPool));
  if (pool0 <= 0) return 0;

  const monthSchedule = (invoices || [])
    .filter((inv) => {
      const t = (inv.term || '').trim();
      if (!t || !/^Month \d+$/i.test(t)) return false;
      if (!HOA_UNIT_SCHEDULE_INVOICE_TYPES.includes(String(inv.type || ''))) return false;
      if (inv.generatedFrom && inv.generatedFrom !== 'unit_schedule') return false;
      return true;
    })
    .sort((a, b) => {
      const da = (DateUtil.toEpoch(a.dueDate) ?? 0);
      const db = (DateUtil.toEpoch(b.dueDate) ?? 0);
      return da - db;
    });

  let pool = pool0;
  for (const inv of monthSchedule) {
    if (!isDueDateOnOrBeforeToday(inv.dueDate)) break;

    const sub = roundMoney(inv.subAmount);
    const paid = roundMoney(Math.max(0, inv.alreadyPaid));
    const take = roundMoney(Math.min(pool, sub, paid));
    pool = roundMoney(pool - take);
  }

  return roundMoney(Math.max(0, pool));
}

/**
 * infer Unapplied Credit From Invoices
 *
 * Performs logic operations for inferUnappliedCreditFromInvoices.
 *
 * @param invoices - Request/input argument
 * @param todayNormalized - Request/input argument
 * @param initialPool - Request/input argument
 * @returns Operations result
 */
function inferUnappliedCreditFromInvoices(invoices, todayNormalized, initialPool) {
  const pool0 = roundMoney(Math.max(0, initialPool));
  if (pool0 <= 0) return 0;

  const transactionApplied = roundMoney((invoices || []).reduce(
    (sum, invoice) => sum + Math.max(0, sumCreditAppliedOnInvoice(invoice)),
    0
  ));

  const legacyScheduleApplied = roundMoney((invoices || []).reduce((sum, invoice) => {
    if (sumCreditAppliedOnInvoice(invoice) > 0) return sum;

    const t = String(invoice.term || '').trim();
    if (!/^Month \d+$/i.test(t)) return sum;
    if (!HOA_UNIT_SCHEDULE_INVOICE_TYPES.includes(String(invoice.type || ''))) return sum;
    if (invoice.generatedFrom && invoice.generatedFrom !== 'unit_schedule') return sum;
    if (!isDueDateOnOrBeforeToday(invoice.dueDate)) return sum;

    const sub = roundMoney(invoice.subAmount);
    const paid = roundMoney(Math.max(0, invoice.alreadyPaid));
    return roundMoney(sum + Math.min(pool0, sub, paid));
  }, 0));

  const consumed = roundMoney(Math.min(pool0, transactionApplied + legacyScheduleApplied));
  return roundMoney(Math.max(0, pool0 - consumed));
}

/**
 * compute Effective Remaining Credit From Parts
 *
 * Property.remainingCredit is the canonical unapplied pool (opening leftovers +
 * overpayments + manual credit). Inference from invoices only backfills when the
 * pool was never persisted (legacy units with remainingCredit still 0).
 *
 * Do not clamp stored credit against opening-balance inference: after opening
 * credit is fully applied, inferred leftover is 0, and Math.min would zero out
 * a later overpayment that correctly lives on Property.remainingCredit.
 *
 * @param propertyDoc - Request/input argument
 * @param openingBalance - Request/input argument
 * @param invoices - Request/input argument
 * @param todayNormalized - Request/input argument
 * @returns Operations result
 */
function computeEffectiveRemainingCreditFromParts(propertyDoc, openingBalance, invoices, todayNormalized) {
  const storedRemainingCredit = roundMoney(Number(propertyDoc?.remainingCredit || 0) || 0);
  if (storedRemainingCredit > 0) {
    return storedRemainingCredit;
  }

  const initialCreditPool =
    openingBalance < 0
      ? roundMoney(Math.abs(openingBalance))
      : (Number(propertyDoc?.startingBalance) < 0
        ? roundMoney(Math.abs(Number(propertyDoc.startingBalance)))
        : 0);
  return inferUnappliedCreditFromInvoices(
    invoices,
    todayNormalized,
    initialCreditPool
  );
}

/** Sum of unapplied credit still held on negative adjustment ledger rows. */
function sumUnappliedLedgerAdjustmentCredit(entries) {
  return roundMoney((entries || []).reduce((sum, entry) => {
    if (entry.type !== 'adjustment') return sum;
    if (isAuditOnlyCreditAdjustment(entry)) return sum;
    const amount = Number(entry.amount || 0);
    if (amount >= 0) return sum;
    const remainingCredit = Number(entry.metadata?.remainingCredit);
    const unapplied = Number.isFinite(remainingCredit) ? remainingCredit : Math.abs(amount);
    return unapplied > 0 ? roundMoney(sum + unapplied) : sum;
  }, 0));
}

/** Ledger overpayment rows that mirror `Property.remainingCredit` (must not double-count). */
function sumMirroredOverpaymentLedgerCredit(entries) {
  return roundMoney((entries || []).reduce((sum, entry) => {
    if (entry.type !== 'adjustment') return sum;
    if (isAuditOnlyCreditAdjustment(entry)) return sum;
    if (entry.metadata?.source !== 'invoice_overpayment') return sum;
    const remainingCredit = Number(entry.metadata?.remainingCredit);
    const unapplied = Number.isFinite(remainingCredit)
      ? remainingCredit
      : Math.abs(Number(entry.amount || 0));
    return unapplied > 0 ? roundMoney(sum + unapplied) : sum;
  }, 0));
}

/**
 * Unified credit pool for display and net balance: Property.remainingCredit plus ledger-only
 * unapplied credit, without counting invoice overpayment twice.
 */
function computeAvailableCreditBalance(propertyDoc, entries, openingBalance, invoices, todayNormalized) {
  const propertyPool = computeEffectiveRemainingCreditFromParts(
    propertyDoc,
    openingBalance,
    invoices,
    todayNormalized
  );
  const ledgerPool = sumUnappliedLedgerAdjustmentCredit(entries);
  const overpaymentLedger = sumMirroredOverpaymentLedgerCredit(entries);
  const mirroredDuplicate = roundMoney(Math.min(propertyPool, overpaymentLedger));
  const fromLedgerAndProperty = roundMoney(
    propertyPool + Math.max(0, ledgerPool - mirroredDuplicate)
  );
  return roundMoney(fromLedgerAndProperty);
}

/** Portfolio list credit when only ledger/property aggregates are available. */
function computePortfolioCreditBalance(propertyRemainingCredit, ledgerCreditTotal, overpaymentLedgerCredit) {
  const propertyPool = roundMoney(propertyRemainingCredit);
  const ledgerPool = roundMoney(ledgerCreditTotal);
  const overpaymentLedger = roundMoney(overpaymentLedgerCredit);
  const mirroredDuplicate = roundMoney(Math.min(propertyPool, overpaymentLedger));
  return roundMoney(propertyPool + Math.max(0, ledgerPool - mirroredDuplicate));
}

/**
 * compute Net Balance With Credit Pool
 *
 * Performs logic operations for computeNetBalanceWithCreditPool.
 *
 * @returns Operations result
 */
function computeNetBalanceWithCreditPool({
  invoiceTotal,
  ledgerOnlyBalance,
  entries,
  propertyDoc,
  openingBalance,
  invoices,
  todayNormalized,
}) {
  const creditPool = computeAvailableCreditBalance(
    propertyDoc,
    entries,
    openingBalance,
    invoices,
    todayNormalized
  );
  const ledgerCreditCounted = sumUnappliedLedgerAdjustmentCredit(entries);
  const creditNotInLedgerBalance = roundMoney(Math.max(0, creditPool - ledgerCreditCounted));
  const netBalance = roundMoney(invoiceTotal + ledgerOnlyBalance - creditNotInLedgerBalance);
  return { creditPool, netBalance };
}

/**
 * Create an opening_balance ledger entry for a new unit.
 * Called once during unit creation - never again if invoices exist.
 */
async function createOpeningBalance(unitId, amount, balanceAsOf, session) {
  const entry = new LedgerEntry({
    unitId,
    type: 'opening_balance',
    amount: Number(amount) || 0,
    createdAt: balanceAsOf ? (DateUtil.toUTC(balanceAsOf) || ClockService.now()) : ClockService.now(),
    metadata: { source: 'unit_creation' }
  });
  const opts = session ? { session } : {};
  return entry.save(opts);
}

/**
 * Distribute a credit amount across open invoices (oldest-first).
 * Reduces balanceDue on each invoice, marking Paid or PartiallyPaid as appropriate.
 * Returns the remaining credit after all invoices are settled.
 */
async function applyCreditToInvoices(
  unitId,
  creditAmount,
  session,
  reason,
  paymentMethod,
  checkNumber,
  moneyOrderNumber,
  recordedBy,
  appliedRecords = null
) {
  if (creditAmount <= 0) return 0;

  const objId = toObjectId(unitId);
  if (!objId) throw Object.assign(new Error('Invalid unitId'), { status: 400 });
  const opts = session ? { session } : {};

  // Fetch open invoices (calendar-due filtering in TZ; aligns with HOA Due / Coming Due semantics)
  const openInvoices = await Invoice.find(
    {
      propertyId: objId,
      status: { $in: [INVOICE_STATUS.PENDING, INVOICE_STATUS.PARTIALLY_PAID, INVOICE_STATUS.OVERDUE] },
      isDeleted: { $ne: true },
    },
    null,
    opts
  ).sort({ dueDate: 1 });

  const timezoneUnit = await Property.findOne({ _id: objId, isDeleted: { $ne: true } })
    .select('billingTimezone')
    .lean();
  const timezone = resolvePropertyBillingTimezone(timezoneUnit || {});

  let remaining = creditAmount;
  const chk = checkNumber != null && String(checkNumber).trim() ? String(checkNumber).trim() : '';
  const mo = moneyOrderNumber != null && String(moneyOrderNumber).trim() ? String(moneyOrderNumber).trim() : '';
  const recorder =
    recordedBy && mongoose.Types.ObjectId.isValid(recordedBy)
      ? new mongoose.Types.ObjectId(recordedBy)
      : null;

  for (const inv of openInvoices) {
    if (remaining <= 0) break;
    if (!isDueDateOnOrBeforeToday(inv.dueDate, ClockService.now(), timezone)) continue;
    if (isInvoiceAutoCreditPaused(inv)) continue;

    const collectable = computeCollectableBalance(inv);
    if (collectable <= 0) continue;

    const apply = Math.min(remaining, collectable);
    inv.alreadyPaid = Number(((inv.alreadyPaid || 0) + apply).toFixed(2));
    inv.balanceDue = Number((collectable - apply).toFixed(2));
    remaining = Number((remaining - apply).toFixed(2));

    if (inv.balanceDue <= 0) {
      inv.balanceDue = 0;
    }
    recalculateInvoiceStatus(inv);
    if (inv.status === INVOICE_STATUS.PAID) {
      inv.paidOn = ClockService.now();
    }

    inv.paymentTransactions = inv.paymentTransactions || [];
    const tx = {
      amount: apply,
      method: paymentMethod || 'Credit Adjustment',
      isManual: true,
      note: [
        reason || 'Applied from credit balance',
        chk ? `Check #${chk}` : null,
        mo ? `MO #${mo}` : null,
      ].filter(Boolean).join(' · '),
      balanceAfter: inv.balanceDue,
      paidAt: ClockService.now(),
    };
    if (chk) tx.checkNumber = chk;
    if (mo) tx.moneyOrderNumber = mo;
    if (recorder) tx.recordedBy = recorder;
    inv.paymentTransactions.push(tx);
    if (Array.isArray(appliedRecords)) {
      appliedRecords.push({
        invoiceId: inv._id,
        amount: apply,
        balanceAfter: inv.balanceDue,
        appliedAt: tx.paidAt,
        method: tx.method,
        note: tx.note,
      });
    }

    ensureEntityNotesHaveCreator(
      inv.comments,
      resolveEntityNoteCreatorId(recorder, inv.createdBy, inv.tenants?.[0])
    );
    await inv.save(opts);
  }

  return remaining;
}

/**
 * Waive outstanding balance on open invoices due today or earlier (owner-removal WAIVE).
 * Sets status Waived + waivedAmount / waiveHistory - does NOT mark Paid or inflate alreadyPaid.
 * Returns unused waive budget (same contract as applyCreditToInvoices).
 */
async function waiveOpenDueInvoicesForSettlement(
  unitId,
  waiveAmountBudget,
  session,
  reason,
  performedBy,
  appliedRecords = null
) {
  if (waiveAmountBudget <= 0) return 0;

  const objId = toObjectId(unitId);
  if (!objId) throw Object.assign(new Error('Invalid unitId'), { status: 400 });
  const opts = session ? { session } : {};

  const openInvoices = await Invoice.find(
    {
      propertyId: objId,
      status: { $in: [INVOICE_STATUS.PENDING, INVOICE_STATUS.PARTIALLY_PAID, INVOICE_STATUS.OVERDUE] },
      isDeleted: { $ne: true },
    },
    null,
    opts
  ).sort({ dueDate: 1 });

  let remaining = roundMoney(waiveAmountBudget);
  const waiveReason = String(reason || 'Outstanding balance waived during owner removal').trim();
  const recorder =
    performedBy && mongoose.Types.ObjectId.isValid(String(performedBy))
      ? new mongoose.Types.ObjectId(String(performedBy))
      : undefined;
  const waivedAt = ClockService.now();

  for (const inv of openInvoices) {
    if (remaining <= 0) break;
    if (!isDueDateOnOrBeforeToday(inv.dueDate)) continue;

    const balanceDue = roundMoney(inv.balanceDue || 0);
    if (balanceDue <= 0) continue;

    const waiveAmt = roundMoney(Math.min(remaining, balanceDue));
    if (waiveAmt <= 0) continue;

    inv.balanceDue = roundMoney(balanceDue - waiveAmt);
    inv.waivedAmount = roundMoney((inv.waivedAmount || 0) + waiveAmt);
    inv.waiveReason = waiveReason;
    inv.waivedAt = waivedAt;
    if (recorder) inv.waivedBy = recorder;
    if (recorder) inv.updatedBy = recorder;

    inv.waiveHistory = inv.waiveHistory || [];
    inv.waiveHistory.push({
      amount: waiveAmt,
      reason: waiveReason,
      invoiceItem: 'Owner removal waiver',
      lineItemDescription: waiveReason,
      waivedBy: recorder,
      waivedAt,
    });

    if (inv.balanceDue <= 0) {
      inv.balanceDue = 0;
      inv.status = INVOICE_STATUS.WAIVED;
    } else if (roundMoney(inv.alreadyPaid || 0) > 0) {
      inv.status = INVOICE_STATUS.PARTIALLY_PAID;
    }

    remaining = roundMoney(remaining - waiveAmt);

    if (Array.isArray(appliedRecords)) {
      appliedRecords.push({
        invoiceId: inv._id,
        amount: waiveAmt,
        balanceAfter: inv.balanceDue,
        appliedAt: waivedAt,
        method: 'Waived',
        note: waiveReason,
      });
    }

    ensureEntityNotesHaveCreator(
      inv.comments,
      resolveEntityNoteCreatorId(recorder, inv.createdBy, inv.tenants?.[0])
    );
    await inv.save(opts);
  }

  return remaining;
}

/**
 * Sum of `balanceDue` on open invoices that are calendar-due on or before today (same cohort as
 * `applyCreditToInvoices`). Portfolio-style `writeOffUsd` can be **zero** when the only balance is
 * **due today** (list UX defers "owed" until the day rolls); last-owner removal must still pay those
 * invoices through.
 */
async function sumBalanceDueOpenInvoicesDueOnOrBeforeToday(unitId, session) {
  const objId = toObjectId(unitId);
  if (!objId) throw Object.assign(new Error('Invalid unitId'), { status: 400 });
  const opts = session ? { session } : {};

  const openInvoices = await Invoice.find(
    {
      propertyId: objId,
      status: { $in: [INVOICE_STATUS.PENDING, INVOICE_STATUS.PARTIALLY_PAID, INVOICE_STATUS.OVERDUE] },
      isDeleted: { $ne: true },
    },
    { balanceDue: 1, dueDate: 1 },
    opts
  )
    .sort({ dueDate: 1 })
    .lean();

  let sum = 0;
  for (const inv of openInvoices) {
    if (!isDueDateOnOrBeforeToday(inv.dueDate)) continue;
    sum += Number(inv.balanceDue || 0);
  }
  return roundMoney(sum);
}

/**
 * Same positive "owed" amount the portfolio Properties table shows from a live balance summary -
 * aligns with PropMv-UI `propertyBalanceUtils.getBalanceFromSummary` (subtracts dues due **today**
 * from raw net while net is positive; handles net 0 + credit pool showing as advance credit).
 *
 * @returns {number} dollars to settle as write-off credit (≥ 0)
 */
function portfolioListedPositiveOwedUsd(rawNet, dueTodayAmount, remainingCreditPool) {
  const r = roundMoney(rawNet);
  const pool = roundMoney(remainingCreditPool);
  const dueTodayPortion = Math.max(0, Math.min(r, roundMoney(dueTodayAmount)));

  let net = r;
  if (net === 0 && pool > 0) {
    net = -pool;
  } else if (net > 0 && dueTodayPortion > 0) {
    net = Math.max(0, roundMoney(r - dueTodayPortion));
  }
  return net > 0 ? roundMoney(net) : 0;
}

/**
 * Recompute `/units/:balance` totals inside an existing Mongo session (no lazy side effects so it
 * matches uncommitted removals). Used only for portfolio-aligned settlement.
 */
async function computePortfolioWriteOffSettlementAmountUsd(unitId, session) {
  const objId = toObjectId(unitId);
  if (!objId) throw Object.assign(new Error('Invalid unitId'), { status: 400 });

  let qEntries = LedgerEntry.find({ unitId: objId }).sort({ createdAt: 1 });
  if (session) qEntries = qEntries.session(session);
  const entries = await qEntries.lean();

  let openingBalanceEntries = 0;
  let adjustments = 0;
  let payments = 0;
  for (const e of entries) {
    if (e.type === 'opening_balance') openingBalanceEntries += Number(e.amount || 0);
    else if (e.type === 'adjustment') adjustments += Number(e.amount || 0);
    else if (e.type === 'payment') payments += Number(e.amount || 0);
  }

  let qInvoices = Invoice.find({
    propertyId: objId,
    isDeleted: { $ne: true },
  })
    .select('status dueDate subAmount alreadyPaid balanceDue processingAmount term type generatedFrom paymentTransactions')
    .sort({ dueDate: 1 });
  if (session) qInvoices = qInvoices.session(session);
  const invoices = await qInvoices.lean();

  let invoiceTotal = 0;
  let dueTodayOutstanding = 0;

  const todayCalendarKey = getDateKeyInTimeZone(ClockService.now());

  for (const invoice of invoices) {
    const balanceDue = Number(invoice.balanceDue || 0);
    const invDueKey = billingCalendarDateKey(invoice.dueDate);
    const isFuture = Boolean(todayCalendarKey && invDueKey && invDueKey > todayCalendarKey);

    if (isFuture) continue;

    if (balanceDue > 0) {
      const isDueToday = Boolean(invDueKey && todayCalendarKey && invDueKey === todayCalendarKey);
      if (isDueToday) dueTodayOutstanding = roundMoney(dueTodayOutstanding + balanceDue);

      invoiceTotal += balanceDue;
    }
  }

  const billingState = await resolveBillingInvoiceState(unitId, objId, invoices, session);

  const unappliedCreditBalance = entries.reduce((sum, entry) => {
    if (entry.type !== 'adjustment') return sum;
    if (isAuditOnlyCreditAdjustment(entry)) return sum;
    const amount = Number(entry.amount || 0);
    if (amount >= 0) return sum;
    const remainingCredit = Number(entry.metadata?.remainingCredit);
    const unapplied = Number.isFinite(remainingCredit) ? remainingCredit : Math.abs(amount);
    return sum - unapplied;
  }, 0);

  const unappliedPaymentBalance = entries.reduce((sum, entry) => {
    if (entry.type !== 'payment') return sum;
    return entry.referenceId ? sum : sum + Number(entry.amount || 0);
  }, 0);

  const ledgerOnlyBalance =
    (billingState.includeOpeningInNet ? openingBalanceEntries : 0) +
    unappliedCreditBalance +
    unappliedPaymentBalance;

  let qProp = Property.findById(objId).select('remainingCredit startingBalance');
  if (session) qProp = qProp.session(session);
  const propertyDoc = await qProp.lean();

  const todayNormalized = getTodayAnchorInTimeZone() || DateUtil.startOfDayEST(ClockService.now());

  const { creditPool, netBalance: rawNet } = computeNetBalanceWithCreditPool({
    invoiceTotal,
    ledgerOnlyBalance,
    entries,
    propertyDoc,
    openingBalance: openingBalanceEntries,
    invoices,
    todayNormalized,
  });
  const dueTodayAmt = roundMoney(dueTodayOutstanding);
  const writeOffUsd = portfolioListedPositiveOwedUsd(rawNet, dueTodayAmt, creditPool);

  return {
    writeOffUsd,
    rawNet,
    dueTodayAmount: dueTodayAmt,
    remainingCreditEffective: creditPool,
    invoiceTotal: roundMoney(invoiceTotal),
  };
}

/**
 * When the **last owner** leaves a unit: write off invoices that are due now (credit adjustment +
 * ledger), then book the **effective unapplied credit pool** (`remainingCreditEffective` from
 * portfolio settlement - Property.remainingCredit plus inferred opening-balance / ledger credits)
 * as an HOA expense and clear all credit sources - same bookkeeping model as assigning a new owner
 * with Start Fresh, but synchronous on removal so the ownerless unit is financially settled without
 * dangling balances attributed to that ownership period.
 *
 * Must run inside the caller's MongoDB session alongside ownership mutations.
 *
 * @returns {Promise<{ invoicesWrittenOffTotal: number, creditReleasedExpense: number, expenseCreated: boolean }>}
 */
async function settleUnitFinancialsWhenLastOwnerRemoved(
  unitId,
  performedBy,
  session,
  removalPayment = null,
  options = {}
) {
  if (!session) throw Object.assign(new Error('session is required'), { status: 500 });

  const objId = mongoose.Types.ObjectId.isValid(unitId)
    ? new mongoose.Types.ObjectId(unitId)
    : unitId;

  const unitDoc = await Property.findById(objId).session(session);

  const settlementBasis = await computePortfolioWriteOffSettlementAmountUsd(unitId, session);
  const openDueInvoiceTotal = await sumBalanceDueOpenInvoicesDueOnOrBeforeToday(unitId, session);
  // Raw invoice `balanceDue` ignores Property.remainingCredit / inferred pool; portfolio `writeOffUsd`
  // matches list UX. Only blend in open-invoice totals when net is still positive - otherwise a credit
  // balance can leave invoices not yet auto-applied while `rawNet <= 0`, and max() would wrongly
  // demand a payment method.
  const totalDue =
    settlementBasis.rawNet > 0
      ? roundMoney(Math.max(settlementBasis.writeOffUsd, openDueInvoiceTotal))
      : 0;
  let invoicesWrittenOffTotal = 0;

  const balanceSettlement = options.balanceSettlement || 'MARK_PAID';

  if (totalDue > 0 && balanceSettlement !== 'KEEP_AS_IS') {
    let pm = '';
    let checkRef = null;
    let moRef = null;
    let invoiceReason = 'Last owner removed - outstanding dues recorded as paid';

    if (balanceSettlement === 'WAIVE') {
      pm = 'Waived';
      invoiceReason = 'Outstanding balance waived during owner removal';
    } else {
      pm =
        removalPayment && removalPayment.paymentMethod
          ? String(removalPayment.paymentMethod).trim()
          : '';
      if (!pm) {
        const err = new Error(
          'Payment method is required to settle outstanding dues when removing the last owner.'
        );
        err.status = 400;
        throw err;
      }
      if (pm === 'Check') {
        const cn =
          removalPayment.checkNumber != null ? String(removalPayment.checkNumber).trim() : '';
        if (!cn) {
          const err = new Error('Check number is required when payment method is Check.');
          err.status = 400;
          throw err;
        }
        checkRef = cn;
      }
      if (pm === 'Money Order') {
        const mon =
          removalPayment.moneyOrderNumber != null
            ? String(removalPayment.moneyOrderNumber).trim()
            : '';
        if (!mon) {
          const err = new Error(
            'Money order number is required when payment method is Money Order.'
          );
          err.status = 400;
          throw err;
        }
        moRef = mon;
      }
    }

    const appliedInvoices = [];
    let remainingAfterApply = 0;
    if (balanceSettlement === 'WAIVE') {
      remainingAfterApply = await waiveOpenDueInvoicesForSettlement(
        unitId,
        totalDue,
        session,
        invoiceReason,
        performedBy,
        appliedInvoices
      );
    } else {
      remainingAfterApply = await applyCreditToInvoices(
        unitId,
        totalDue,
        session,
        invoiceReason,
        pm,
        checkRef,
        moRef,
        performedBy,
        appliedInvoices
      );
    }
    invoicesWrittenOffTotal = roundMoney(totalDue - remainingAfterApply);
    const adjustmentAmount = roundMoney(-totalDue);
    const entry = new LedgerEntry({
      unitId: objId,
      type: 'adjustment',
      amount: adjustmentAmount,
      metadata: {
        reason: invoiceReason,
        paymentMethod: pm,
        balanceSettlement,
        createdBy: performedBy || null,
        appliedToInvoices: invoicesWrittenOffTotal,
        appliedInvoices,
        remainingCredit: remainingAfterApply,
        ...(checkRef ? { checkNumber: String(checkRef).trim() } : {}),
        ...(moRef ? { moneyOrderNumber: String(moRef).trim() } : {}),
      },
    });
    await entry.save({ session });

    if (balanceSettlement === 'WAIVE') {
      await logActivity({
        userId: performedBy || undefined,
        action: 'ADJUSTMENT',
        module: 'HOA Unit Ownership',
        entityType: 'Property',
        entityId: String(unitId),
        entityName: unitDoc?.name || undefined,
        description: 'Outstanding balance waived during owner removal',
        metadata: {
          unitId: String(unitId),
          waivedAmount: invoicesWrittenOffTotal,
          balanceSettlement,
        },
      });
    }
  }

  // Use the unified credit pool (Property.remainingCredit + inferred opening-balance /
  // ledger credits). Relying on Property.remainingCredit alone skips credit that the
  // UI already shows when remainingCredit is still 0 or only inferred.
  let creditReleasedExpense = roundMoney(
    Number(settlementBasis.remainingCreditEffective || 0) || 0
  );
  let expenseCreated = false;

  if (creditReleasedExpense > 0 && unitDoc) {
    const unitLabel =
      unitDoc.unitDetails && unitDoc.unitDetails[0] && unitDoc.unitDetails[0].unitName
        ? String(unitDoc.unitDetails[0].unitName)
        : 'Unit';
    const vendorIds = options.removedOwnerId ? [String(options.removedOwnerId)] : [];
    const expensePayload = await buildUnappliedCreditReleaseExpensePayload({
      unitDoc,
      unitId: objId,
      creditReleasedExpense,
      performedBy,
      session,
      vendorOwnerUserIds: vendorIds,
      expenseItemDescription: `Unapplied resident credit booked when the last owner was removed (${unitDoc.name || 'property'} / ${unitLabel}).`,
    });
    await createCreditReleaseExpenseInSession(expensePayload, session);

    await drainLedgerCreditSourcesForRelease(
      objId,
      creditReleasedExpense,
      performedBy,
      session
    );
    expenseCreated = true;
  }

  if (invoicesWrittenOffTotal > 0 || creditReleasedExpense > 0) {
    await logActivity({
      userId: performedBy || undefined,
      action: 'ADJUSTMENT',
      module: 'HOA Unit Ownership',
      entityType: 'Property',
      entityId: String(unitId),
      entityName: unitDoc?.name || undefined,
      description: 'Last owner removed - financial settlement (outstanding dues cleared where applicable; unapplied credit expensed)',
      metadata: {
        unitId: String(unitId),
        invoicesWrittenOffTotal,
        creditReleasedExpense,
        settlementPortfolioRawNet: settlementBasis.rawNet,
        settlementPortfolioDueToday: settlementBasis.dueTodayAmount,
        settlementPortfolioListedOwed: totalDue,
      },
    });
  }

  return {
    invoicesWrittenOffTotal,
    creditReleasedExpense,
    expenseCreated,
    settlementPortfolioListedOwed: totalDue,
    settlementPortfolioRawNet: settlementBasis.rawNet,
    settlementPortfolioDueToday: settlementBasis.dueTodayAmount,
  };
}

/**
 * **Change ownership → reset unit balance:** mark due/overdue items paid (with board-recorded payment method),
 * mirror-ledger adjust, and expense unapplied credit like last-owner removal - run while prior owners still
 * appear on the unit so invoice `save()` validation passes.
 */
async function settleUnitFinancialsForOwnershipBalanceReset(
  unitId,
  performedBy,
  session,
  removalPayment = null,
  options = {}
) {
  if (!session) throw Object.assign(new Error('session is required'), { status: 500 });

  const objId = mongoose.Types.ObjectId.isValid(unitId)
    ? new mongoose.Types.ObjectId(unitId)
    : unitId;

  const settlementBasis = await computePortfolioWriteOffSettlementAmountUsd(unitId, session);
  const openDueInvoiceTotal = await sumBalanceDueOpenInvoicesDueOnOrBeforeToday(unitId, session);
  // Same rule as last-owner removal: open-invoice sums ignore Property/inferred credit in DB; avoid
  // requiring a board-recorded payment when portfolio `rawNet` is already zero or credit.
  const totalDue =
    settlementBasis.rawNet > 0
      ? roundMoney(Math.max(settlementBasis.writeOffUsd, openDueInvoiceTotal))
      : 0;
  let invoicesWrittenOffTotal = 0;

  if (totalDue > 0) {
    const pm =
      removalPayment && removalPayment.paymentMethod
        ? String(removalPayment.paymentMethod).trim()
        : '';
    if (!pm) {
      const err = new Error(
        'Payment method is required to settle outstanding dues when resetting the unit balance during ownership change.'
      );
      err.status = 400;
      throw err;
    }
    if (pm === 'Check') {
      const cn =
        removalPayment.checkNumber != null ? String(removalPayment.checkNumber).trim() : '';
      if (!cn) {
        const err = new Error('Check number is required when payment method is Check.');
        err.status = 400;
        throw err;
      }
    }
    if (pm === 'Money Order') {
      const mon =
        removalPayment.moneyOrderNumber != null
          ? String(removalPayment.moneyOrderNumber).trim()
          : '';
      if (!mon) {
        const err = new Error(
          'Money order number is required when payment method is Money Order.'
        );
        err.status = 400;
        throw err;
      }
    }

    const invoiceReason = 'Ownership transfer - unit balance reset; outstanding dues recorded as paid';
    const checkRef = pm === 'Check' ? removalPayment.checkNumber : null;
    const moRef = pm === 'Money Order' ? removalPayment.moneyOrderNumber : null;

    const appliedInvoices = [];
    const remainingAfterApply = await applyCreditToInvoices(
      unitId,
      totalDue,
      session,
      invoiceReason,
      pm,
      checkRef,
      moRef,
      performedBy,
      appliedInvoices
    );
    invoicesWrittenOffTotal = roundMoney(totalDue - remainingAfterApply);
    const adjustmentAmount = roundMoney(-totalDue);
    const entry = new LedgerEntry({
      unitId: objId,
      type: 'adjustment',
      amount: adjustmentAmount,
      metadata: {
        reason: invoiceReason,
        paymentMethod: pm,
        createdBy: performedBy || null,
        appliedToInvoices: invoicesWrittenOffTotal,
        appliedInvoices,
        remainingCredit: remainingAfterApply,
        context: 'ownership_balance_reset',
        ...(checkRef ? { checkNumber: String(checkRef).trim() } : {}),
        ...(moRef ? { moneyOrderNumber: String(moRef).trim() } : {}),
      },
    });
    await entry.save({ session });
  }

  const unitDoc = await Property.findById(objId).session(session);
  // Same unified pool as last-owner removal - Property.remainingCredit alone misses
  // inferred / ledger-only credit shown on the unit balance UI.
  let creditReleasedExpense = roundMoney(
    Number(settlementBasis.remainingCreditEffective || 0) || 0
  );
  let expenseCreated = false;

  if (creditReleasedExpense > 0 && unitDoc) {
    const unitLabel =
      unitDoc.unitDetails && unitDoc.unitDetails[0] && unitDoc.unitDetails[0].unitName
        ? String(unitDoc.unitDetails[0].unitName)
        : 'Unit';
    const vendorIds = Array.isArray(options.priorOwnerIds) ? options.priorOwnerIds.map(String) : [];
    const expensePayload = await buildUnappliedCreditReleaseExpensePayload({
      unitDoc,
      unitId: objId,
      creditReleasedExpense,
      performedBy,
      session,
      vendorOwnerUserIds: vendorIds,
      expenseItemDescription: `Unapplied resident credit booked during ownership balance reset (${unitDoc.name || 'property'} / ${unitLabel}).`,
    });
    await createCreditReleaseExpenseInSession(expensePayload, session);

    await drainLedgerCreditSourcesForRelease(
      objId,
      creditReleasedExpense,
      performedBy,
      session
    );
    expenseCreated = true;
  }

  if (invoicesWrittenOffTotal > 0 || creditReleasedExpense > 0) {
    await logActivity({
      userId: performedBy || undefined,
      action: 'ADJUSTMENT',
      module: 'HOA Unit Ownership',
      entityType: 'Property',
      entityId: String(unitId),
      entityName: unitDoc?.name || undefined,
      description:
        'Ownership change - unit balance reset (outstanding dues cleared where applicable; unapplied credit expensed)',
      metadata: {
        unitId: String(unitId),
        invoicesWrittenOffTotal,
        creditReleasedExpense,
        settlementPortfolioRawNet: settlementBasis.rawNet,
        settlementPortfolioDueToday: settlementBasis.dueTodayAmount,
        settlementPortfolioListedOwed: totalDue,
        context: 'ownership_balance_reset',
      },
    });
  }

  return {
    invoicesWrittenOffTotal,
    creditReleasedExpense,
    expenseCreated,
    settlementPortfolioListedOwed: totalDue,
    settlementPortfolioRawNet: settlementBasis.rawNet,
    settlementPortfolioDueToday: settlementBasis.dueTodayAmount,
  };
}

/**
 * Apply any stored unapplied credit from ledger entries to invoices that are
 * now due (dueDate <= today). Called lazily on every balance fetch so no cron
 * job is needed - credit is consumed the first time the balance is read after
 * an invoice's due date arrives.
 */
async function applyStoredCreditToNewlyDueInvoices(unitId) {
  const objId = toObjectId(unitId);
  if (!objId) return { modified: false };

  // Sum all unapplied credit from adjustment entries
  const creditEntries = await LedgerEntry.find({
    unitId: objId,
    type: 'adjustment',
    amount: { $lt: 0 },
    'metadata.remainingCredit': { $gt: 0 }
  }).lean();

  if (creditEntries.length === 0) return { modified: false };

  // Invoice overpayment credit lives on Property.remainingCredit; skip mirrored ledger rows.
  let availableCredit = creditEntries.reduce((sum, e) => {
    if (e.metadata?.source === 'invoice_overpayment') return sum;
    const rc = Number(e.metadata?.remainingCredit);
    return sum + (Number.isFinite(rc) ? rc : 0);
  }, 0);

  if (availableCredit <= 0) return { modified: false };

  const timezoneUnit = await Property.findOne({ _id: objId, isDeleted: { $ne: true } })
    .select('billingTimezone')
    .lean();
  const timezone = resolvePropertyBillingTimezone(timezoneUnit || {});

  // Find invoices that are due on-or-before today (property TZ) but still have a balance - oldest first
  const candidates = await Invoice.find({
    propertyId: objId,
    status: { $in: [INVOICE_STATUS.PENDING, INVOICE_STATUS.PARTIALLY_PAID, INVOICE_STATUS.OVERDUE] },
    isDeleted: { $ne: true },
    balanceDue: { $gt: 0 }
  }).sort({ dueDate: 1, createdAt: 1, _id: 1 });

  const dueInvoices = candidates.filter(
    (inv) => isDueDateOnOrBeforeToday(inv.dueDate, ClockService.now(), timezone) && !isInvoiceAutoCreditPaused(inv)
  );

  if (dueInvoices.length === 0) return { modified: false };

  const creditSources = await findActiveOverpaymentCreditSources(objId, null);

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    let remaining = availableCredit;
    const appliedInvoices = [];
    const invoiceApplications = [];

    for (const inv of dueInvoices) {
      if (remaining <= 0) break;
      const collectable = computeCollectableBalance(inv);
      if (collectable <= 0) continue;
      const apply = Math.min(remaining, collectable);
      const alreadyPaid = Number(((inv.alreadyPaid || 0) + apply).toFixed(2));
      let balanceDue = Number((collectable - apply).toFixed(2));
      remaining = Number((remaining - apply).toFixed(2));

      if (balanceDue <= 0) {
        balanceDue = 0;
      }
      inv.alreadyPaid = alreadyPaid;
      inv.balanceDue = balanceDue;
      recalculateInvoiceStatus(inv);
      const status = inv.status;
      const paidOn = status === INVOICE_STATUS.PAID ? ClockService.now() : undefined;
      if (paidOn) inv.paidOn = paidOn;

      const creditTxs = buildSlicedCreditAppliedTransactions({
        applyAmount: apply,
        startingBalanceDue: collectable,
        paidAt: ClockService.now(),
        source: 'stored_ledger_credit',
        creditSources,
      });
      appliedInvoices.push({
        invoiceId: inv._id,
        amount: apply,
        balanceAfter: balanceDue,
        appliedAt: ClockService.now(),
        method: 'Credit Adjustment',
        source: 'stored_ledger_credit',
      });

      const setFields = {
        alreadyPaid,
        balanceDue,
        status,
        ...(paidOn ? { paidOn } : {}),
      };
      for (const paymentTransaction of creditTxs) {
        invoiceApplications.push({
          invoiceId: inv._id,
          setFields,
          paymentTransaction,
        });
      }
    }

    const consumed = Number((availableCredit - remaining).toFixed(2));
    if (consumed > 0) {
      await bulkWriteInvoiceCreditApplications(invoiceApplications, session);

      const ledgerUpdates = buildLedgerCreditDrainUpdates(creditEntries, consumed);
      await bulkWriteLedgerRemainingCreditUpdates(ledgerUpdates, session);

      await new LedgerEntry({
        unitId: objId,
        type: 'adjustment',
        amount: 0,
        metadata: {
          reason: 'Auto-applied stored credit to due invoices',
          source: 'stored_ledger_credit_application',
          appliedToInvoices: consumed,
          appliedInvoices,
          remainingCredit: remaining,
        },
      }).save({ session });
    }

    await session.commitTransaction();
    return { modified: consumed > 0, appliedCount: invoiceApplications.length, appliedInvoices };
  } catch (err) {
    await session.abortTransaction();
    // Non-fatal - balance summary will still return correct data
    logger.error('[applyStoredCreditToNewlyDueInvoices] error:', err.message);
    return { modified: false };
  } finally {
    session.endSession();
  }
}

/**
 * Apply `Property.remainingCredit` to open invoices that are calendar-due **today or earlier** only
 * (future due dates keep full balance until the due day). Creates `paymentTransactions` entries and
 * reduces `remainingCredit`; PAID vs PARTIALLY_PAID follows applied amount vs balanceDue.
 *
 * @param {string|import('mongoose').Types.ObjectId} unitId
 * @param {{ session?: import('mongoose').ClientSession }} [options] - participate in an existing transaction
 */
async function applyPropertyRemainingCreditToDueInvoices(unitId, options = {}) {
  const externalSession = options && options.session;
  const objId = toObjectId(unitId) || (unitId instanceof mongoose.Types.ObjectId ? unitId : null);
  if (!objId) return { modified: false };

  const applyPool = async (session) => {
    const opts = session ? { session } : {};

    let qProp = Property.findById(objId).select('remainingCredit billingTimezone');
    if (session) qProp = qProp.session(session);
    const propertyDoc = await qProp;
    if (!propertyDoc) return { modified: false };

    let pool = roundMoney(Number(propertyDoc.remainingCredit || 0));
    if (pool <= 0) return { modified: false };
    const startingPool = pool;
    const appliedInvoices = [];
    const invoiceApplications = [];

    const safeObjId = toObjectId(objId) || objId;
    let qInv = Invoice.find({
      propertyId: safeObjId,
      status: {
        $in: [INVOICE_STATUS.PENDING, INVOICE_STATUS.PARTIALLY_PAID, INVOICE_STATUS.OVERDUE],
      },
      isDeleted: { $ne: true },
      balanceDue: { $gt: 0 },
    }).sort({ dueDate: 1 });
    if (session) qInv = qInv.session(session);
    const candidates = await qInv;

    const timezone = resolvePropertyBillingTimezone(propertyDoc);
    const dueInvoices = candidates.filter(
      (inv) => isDueDateOnOrBeforeToday(inv.dueDate, ClockService.now(), timezone) && !isInvoiceAutoCreditPaused(inv)
    );
    if (dueInvoices.length === 0) return { modified: false };

    const creditSources = await findActiveOverpaymentCreditSources(safeObjId, session);

    for (const inv of dueInvoices) {
      if (pool <= 0) break;
      const collectable = computeCollectableBalance(inv);
      if (collectable <= 0) continue;

      const apply = roundMoney(Math.min(pool, collectable));
      if (apply <= 0) continue;

      const creditBalanceBefore = roundMoney(pool);
      const alreadyPaid = roundMoney(Number(inv.alreadyPaid || 0) + apply);
      let nextBalanceDue = roundMoney(collectable - apply);
      pool = roundMoney(pool - apply);

      if (nextBalanceDue <= 0) {
        nextBalanceDue = 0;
      }

      const priorStatus = inv.status;
      // Same Paid vs Waived rule as Record Payment (recalculateInvoiceStatus).
      inv.alreadyPaid = alreadyPaid;
      inv.balanceDue = nextBalanceDue;
      recalculateInvoiceStatus(inv);
      const status = inv.status;
      const paidOn = status === INVOICE_STATUS.PAID ? ClockService.now() : undefined;
      if (paidOn) inv.paidOn = paidOn;

      const creditTxs = buildSlicedCreditAppliedTransactions({
        applyAmount: apply,
        startingBalanceDue: collectable,
        paidAt: paidOn || ClockService.now(),
        note: `Credit automatically applied to ${priorStatus === INVOICE_STATUS.OVERDUE ? 'overdue' : 'open'} invoice · Applied $${apply.toFixed(2)} from available credit balance`,
        source: 'property_remaining_credit',
        creditSources,
      });
      appliedInvoices.push({
        invoiceId: inv._id,
        amount: apply,
        balanceAfter: nextBalanceDue,
        appliedAt: ClockService.now(),
        method: 'Credit Adjustment',
        source: 'property_remaining_credit',
        creditBalanceBefore,
        creditBalanceAfter: pool,
      });

      const setFields = {
        alreadyPaid,
        balanceDue: nextBalanceDue,
        status,
        ...(paidOn ? { paidOn } : {}),
      };
      for (const paymentTransaction of creditTxs) {
        invoiceApplications.push({
          invoiceId: inv._id,
          setFields,
          paymentTransaction,
        });
      }
    }

    if (invoiceApplications.length === 0) {
      return { modified: false };
    }

    await bulkWriteInvoiceCreditApplications(invoiceApplications, session);
    await Property.findByIdAndUpdate(safeObjId, { $set: { remainingCredit: roundMoney(pool) } }, opts);
    const consumed = roundMoney(startingPool - pool);
    if (consumed > 0) {
      await new LedgerEntry({
        unitId: safeObjId,
        type: 'adjustment',
        amount: 0,
        metadata: {
          reason: 'Auto-applied available credit balance to due invoices',
          source: 'property_remaining_credit_application',
          appliedToInvoices: consumed,
          appliedInvoices,
          creditBalanceBefore: startingPool,
          remainingCredit: pool,
        },
      }).save(opts);
    }

    return { modified: true, appliedCount: invoiceApplications.length, appliedInvoices };
  };

  if (externalSession) {
    return applyPool(externalSession);
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const result = await applyPool(session);
    await session.commitTransaction();
    return result || { modified: false };
  } catch (err) {
    await session.abortTransaction();
    logger.error('[applyPropertyRemainingCreditToDueInvoices] error:', err.message);
    return { modified: false };
  } finally {
    session.endSession();
  }
}

/** Ledger unapplied adjustment credits, then `Property.remainingCredit` - same order as lazy balance refresh. */
async function applyAllUnappliedCreditToDueInvoices(unitId) {
  const storedResult = await applyStoredCreditToNewlyDueInvoices(unitId);
  const propertyResult = await applyPropertyRemainingCreditToDueInvoices(unitId);
  return {
    modified: Boolean(storedResult?.modified || propertyResult?.modified),
    appliedCount: (storedResult?.appliedCount || 0) + (propertyResult?.appliedCount || 0),
    appliedInvoices: [
      ...(storedResult?.appliedInvoices || []),
      ...(propertyResult?.appliedInvoices || []),
    ],
  };
}

/**
 * build Invoice Payment Transaction
 *
 * Performs logic operations for buildInvoicePaymentTransaction.
 *
 * @returns Operations result
 */
function buildInvoicePaymentTransaction({
  amount,
  method,
  note,
  checkNumber,
  moneyOrderNumber,
  balanceAfter,
  paidAt,
  recordedAt,
  recordedBy,
  paidBy,
  paymentGroupId,
  recordedPaymentTotal,
  recordedAgainstInvoiceId,
  recordedAgainstInvoiceNumber,
  fifoAllocationRole,
  fifoRedirectedAmount,
  fifoRedirectedToInvoiceId,
  fifoRedirectedToInvoiceNumber,
  fifoRedirectedToDueDate,
  fifoRedirectedAllocations,
}) {
  const tx = {
    amount: roundMoney(amount),
    method: method || '',
    isManual: true,
    note: note || '',
    balanceAfter: roundMoney(balanceAfter),
    paidAt: paidAt instanceof Date ? paidAt : (DateUtil.toUTC(paidAt) || ClockService.now()),
    recordedAt: recordedAt instanceof Date
      ? recordedAt
      : (DateUtil.toUTC(recordedAt || paidAt) || ClockService.now()),
  };
  const chk = checkNumber != null && String(checkNumber).trim() ? String(checkNumber).trim() : '';
  const mo = moneyOrderNumber != null && String(moneyOrderNumber).trim() ? String(moneyOrderNumber).trim() : '';
  if (chk) tx.checkNumber = chk;
  if (mo) tx.moneyOrderNumber = mo;
  if (recordedBy && mongoose.Types.ObjectId.isValid(recordedBy)) {
    tx.recordedBy = new mongoose.Types.ObjectId(recordedBy);
  }
  if (paidBy && mongoose.Types.ObjectId.isValid(paidBy)) {
    tx.paidBy = new mongoose.Types.ObjectId(paidBy);
  }
  if (paymentGroupId) tx.paymentGroupId = String(paymentGroupId);
  if (recordedPaymentTotal != null && Number(recordedPaymentTotal) > 0) {
    tx.recordedPaymentTotal = roundMoney(recordedPaymentTotal);
  }
  if (recordedAgainstInvoiceId && mongoose.Types.ObjectId.isValid(String(recordedAgainstInvoiceId))) {
    tx.recordedAgainstInvoiceId = new mongoose.Types.ObjectId(String(recordedAgainstInvoiceId));
  }
  if (recordedAgainstInvoiceNumber) {
    tx.recordedAgainstInvoiceNumber = String(recordedAgainstInvoiceNumber);
  }
  if (fifoAllocationRole) tx.fifoAllocationRole = fifoAllocationRole;
  if (fifoRedirectedAmount != null && Number(fifoRedirectedAmount) > 0) {
    tx.fifoRedirectedAmount = roundMoney(fifoRedirectedAmount);
  }
  if (fifoRedirectedToInvoiceId && mongoose.Types.ObjectId.isValid(String(fifoRedirectedToInvoiceId))) {
    tx.fifoRedirectedToInvoiceId = new mongoose.Types.ObjectId(String(fifoRedirectedToInvoiceId));
  }
  if (fifoRedirectedToInvoiceNumber) {
    tx.fifoRedirectedToInvoiceNumber = String(fifoRedirectedToInvoiceNumber);
  }
  if (fifoRedirectedToDueDate) {
    tx.fifoRedirectedToDueDate = fifoRedirectedToDueDate instanceof Date
      ? fifoRedirectedToDueDate
      : (DateUtil.toUTC(fifoRedirectedToDueDate) || undefined);
  }
  if (Array.isArray(fifoRedirectedAllocations) && fifoRedirectedAllocations.length > 0) {
    tx.fifoRedirectedAllocations = fifoRedirectedAllocations.map((row) => ({
      invoiceId: row.invoiceId && mongoose.Types.ObjectId.isValid(String(row.invoiceId))
        ? new mongoose.Types.ObjectId(String(row.invoiceId))
        : undefined,
      invoiceNumber: row.invoiceNumber ? String(row.invoiceNumber) : '',
      amount: roundMoney(row.amount || 0),
    })).filter((row) => row.amount > 0.009);
  }
  return tx;
}

const CHRONOLOGICAL_PAYMENT_STATUSES = new Set([
  String(INVOICE_STATUS.PENDING),
  String(INVOICE_STATUS.OVERDUE),
  String(INVOICE_STATUS.PARTIALLY_PAID),
  'Due',
]);

const SEQUENTIAL_BLOCKING_STATUSES = new Set([
  ...CHRONOLOGICAL_PAYMENT_STATUSES,
  String(INVOICE_STATUS.PROCESSING),
]);

function invoiceEffectiveOpenBalance(invoice) {
  return getInvoiceCollectableBalance(invoice);
}

/** FIFO blockers use denormalized balanceDue unless payment rows are loaded. */
function invoiceSequentialBlockBalance(invoice) {
  if (!invoice) return 0;
  if (Array.isArray(invoice.paymentTransactions) && invoice.paymentTransactions.length > 0) {
    return getInvoiceCollectableBalance(invoice);
  }
  return roundMoney(Math.max(0, Number(invoice.balanceDue || 0)));
}

function isOpenAllocatableInvoice(invoice) {
  if (!invoice || invoiceEffectiveOpenBalance(invoice) <= 0) return false;
  return CHRONOLOGICAL_PAYMENT_STATUSES.has(String(invoice.status || ''));
}

function isSequentialBlockingInvoice(invoice) {
  if (!invoice || invoiceSequentialBlockBalance(invoice) <= 0) return false;
  return SEQUENTIAL_BLOCKING_STATUSES.has(String(invoice.status || ''));
}

function isChronologicalPaymentOutstandingInvoice(invoice, referenceDate = ClockService.now()) {
  if (!isOpenAllocatableInvoice(invoice)) return false;

  const status = String(invoice.status || '');
  if (status === String(INVOICE_STATUS.OVERDUE)) return true;
  return isDueDateOnOrBeforeToday(invoice.dueDate, referenceDate);
}

function invoiceDueSortValue(invoice) {
  const due = invoice?.dueDate ? new Date(invoice.dueDate).getTime() : NaN;
  return Number.isFinite(due) ? due : Number.MAX_SAFE_INTEGER;
}

/**
 * True when another open invoice on the unit is due before `invoice` (FIFO predecessor).
 * Allocatable statuses only (excludes Processing) - used for payment distribution.
 */
function isOlderOpenInvoice(candidate, invoice) {
  if (!isOpenAllocatableInvoice(candidate)) return false;
  if (String(candidate._id) === String(invoice._id)) return false;

  const candidateDue = invoiceDueSortValue(candidate);
  const invoiceDue = invoiceDueSortValue(invoice);
  if (candidateDue < invoiceDue) return true;
  if (candidateDue > invoiceDue) return false;

  const candidateCreated = candidate.createdAt ? new Date(candidate.createdAt).getTime() : 0;
  const invoiceCreated = invoice.createdAt ? new Date(invoice.createdAt).getTime() : 0;
  if (candidateCreated !== invoiceCreated) return candidateCreated < invoiceCreated;
  return String(candidate._id) < String(invoice._id);
}

/**
 * Earlier calendar due date only (not same-due siblings).
 * Board Record Payment may settle these before the selected invoice; leftover becomes credit
 * and must not prepay later-due (future) invoices.
 */
function isEarlierDueOpenInvoice(candidate, invoice) {
  if (!isOpenAllocatableInvoice(candidate)) return false;
  if (String(candidate._id) === String(invoice._id)) return false;
  return invoiceDueSortValue(candidate) < invoiceDueSortValue(invoice);
}

/**
 * Whether cash from a recorded payment may be applied to `candidate`.
 * - allocateFutureInvoices true: all open invoices (owner Pay Now FIFO, including future prepay)
 * - false (board Record Payment): selected invoice + older open invoices only (due date, then
 *   createdAt, then _id). Later-due (future) invoices and same-due newer siblings are skipped;
 *   leftover becomes credit instead of prepaying futures.
 */
function canAllocateRecordedPaymentCash(candidate, primaryInvoice, allocateFutureInvoices = false) {
  if (!candidate || !primaryInvoice) return false;
  const isPrimary = String(candidate._id) === String(primaryInvoice._id);
  if (isPrimary) {
    return isOpenAllocatableInvoice(candidate) || invoiceEffectiveOpenBalance(candidate) > 0;
  }
  if (!isOpenAllocatableInvoice(candidate)) return false;
  if (allocateFutureInvoices) return true;
  return isOlderOpenInvoice(candidate, primaryInvoice);
}

/**
 * True when an older invoice still has remaining balance, including in-flight Processing.
 * Used to block skipping ahead while an older invoice is unpaid or partially processing.
 */
function isOlderSequentialBlockingInvoice(candidate, invoice) {
  if (!isSequentialBlockingInvoice(candidate)) return false;
  if (String(candidate._id) === String(invoice._id)) return false;

  const candidateDue = invoiceDueSortValue(candidate);
  const invoiceDue = invoiceDueSortValue(invoice);
  if (candidateDue < invoiceDue) return true;
  if (candidateDue > invoiceDue) return false;

  const candidateCreated = candidate.createdAt ? new Date(candidate.createdAt).getTime() : 0;
  const invoiceCreated = invoice.createdAt ? new Date(invoice.createdAt).getTime() : 0;
  if (candidateCreated !== invoiceCreated) return candidateCreated < invoiceCreated;
  return String(candidate._id) < String(invoice._id);
}

/**
 * Sum of open allocatable balances for a unit (owner outstanding ceiling).
 */
async function getUnitOutstandingBalance(unitId, session = null) {
  if (!unitId) return 0;
  const objId = toObjectId(unitId) || (unitId instanceof mongoose.Types.ObjectId ? unitId : null);
  if (!objId) return 0;
  let query = Invoice.find({
    propertyId: objId,
    status: { $in: Array.from(CHRONOLOGICAL_PAYMENT_STATUSES) },
    isDeleted: { $ne: true },
    balanceDue: { $gt: 0 },
  }).select('balanceDue');
  if (session) query = query.session(session);
  const rows = await query.lean();
  return roundMoney((rows || []).reduce((sum, row) => sum + Number(row.balanceDue || 0), 0));
}

/**
 * Batch unit outstanding ceiling for invoice list responses (propertyId -> sum of balanceDue).
 */
async function getUnitOutstandingBalanceMap(propertyIds = [], session = null) {
  const objIds = [...new Set(
    (propertyIds || [])
      .map((id) => toObjectId(id) || (id instanceof mongoose.Types.ObjectId ? id : null))
      .filter(Boolean),
  )];
  if (objIds.length === 0) return new Map();

  let query = Invoice.find({
    propertyId: { $in: objIds },
    status: { $in: Array.from(CHRONOLOGICAL_PAYMENT_STATUSES) },
    isDeleted: { $ne: true },
    balanceDue: { $gt: 0 },
  }).select('propertyId balanceDue');
  if (session) query = query.session(session);
  const rows = await query.lean();

  const map = new Map();
  for (const row of rows || []) {
    const key = String(row.propertyId);
    map.set(key, roundMoney((map.get(key) || 0) + Number(row.balanceDue || 0)));
  }
  return map;
}

/**
 * Board manual record-payment: overpayment is allowed.
 * Any amount beyond open invoice balances is stored as owner credit
 * (Property.remainingCredit) via processInvoiceOverpayment.
 * Kept for API compatibility - no ceiling enforcement.
 */
async function assertBoardRecordPaymentWithinOutstanding(unitId, paymentAmount, session = null) {
  const amount = roundMoney(paymentAmount);
  if (!(amount > 0)) return true;
  return true;
}

/**
 * Enforce owner online-payment rules:
 * - amount must not exceed the primary invoice open balance (each charge maps to one invoice)
 * - amount must not exceed unit outstanding across all generated unpaid invoices
 * - no skipping older unpaid invoices (sequential FIFO), including Processing
 *
 * @param {object} [options]
 * @param {Map<string, number>|Record<string, number>} [options.batchCoveredBalances]
 *   Amounts already allocated to older invoices in the same multi-invoice Pay Total
 *   batch. Those balances no longer block FIFO for later legs in the same request.
 * @param {string[]} [options.coveredInvoiceIds]
 *   Invoice IDs already charged earlier in the same batch execute loop.
 */
async function assertOwnerOnlinePaymentAllowed(invoice, paymentAmount, session = null, options = {}) {
  if (!invoice) {
    throw Object.assign(new Error('Invoice not found'), { status: 404, statusCode: 404 });
  }
  const amount = roundMoney(paymentAmount);
  if (!(amount > 0)) {
    throw Object.assign(new Error('Payment amount must be positive'), { status: 400, statusCode: 400 });
  }

  const openBalance = getInvoiceCollectableBalance(invoice);
  if (openBalance <= 0) {
    throw Object.assign(new Error('Invoice has no remaining balance'), { status: 400, statusCode: 400 });
  }
  if (amount + 0.009 < openBalance) {
    const { assertHoaAcceptsPartialPaymentForInvoice } = require('../../hoa-settings/helpers/hoaPartialPaymentPolicy.helper');
    await assertHoaAcceptsPartialPaymentForInvoice(invoice, amount, openBalance);
  }
  if (amount > openBalance + 0.009) {
    throw Object.assign(
      new Error('Payment amount cannot exceed this invoice balance.'),
      { status: 400, statusCode: 400 }
    );
  }

  if (!invoice.propertyId) return true;

  const objId = toObjectId(invoice.propertyId) || (invoice.propertyId instanceof mongoose.Types.ObjectId ? invoice.propertyId : null);
  if (!objId) return true;

  let query = Invoice.find({
    _id: { $ne: invoice._id },
    propertyId: objId,
    status: { $in: Array.from(SEQUENTIAL_BLOCKING_STATUSES) },
    isDeleted: { $ne: true },
  }).select('_id dueDate createdAt status balanceDue subAmount alreadyPaid processingAmount waivedAmount paymentTransactions');
  if (session) query = query.session(session);
  const candidateRows = await query.lean();
  const candidates = (candidateRows || []).filter(
    (row) => invoiceEffectiveOpenBalance(row) > 0
  );

  const coveredIds = new Set(
    (options.coveredInvoiceIds || []).map((id) => String(id)).filter(Boolean)
  );
  const batchCoveredBalances = normalizeBatchCoveredBalances(options.batchCoveredBalances);

  // Block skipping older invoices that still have remaining balance, including
  // partial Processing (cash in-flight with balanceDue > 0). Fully Processing
  // invoices (balanceDue = 0) are not sequential blockers. Amounts already
  // allocated earlier in the same multi-invoice batch also clear the blocker.
  const hasOlder = (candidates || []).some((candidate) => {
    if (!isOlderSequentialBlockingInvoice(candidate, invoice)) return false;
    const candidateId = String(candidate._id);
    if (coveredIds.has(candidateId)) return false;
    const coveredAmt = batchCoveredBalances.get(candidateId) || 0;
    if (coveredAmt > 0) {
      const remainingAfterBatch = roundMoney(invoiceEffectiveOpenBalance(candidate) - coveredAmt);
      if (remainingAfterBatch <= 0.009) return false;
    }
    return true;
  });
  if (hasOlder) {
    throw Object.assign(
      new Error(
        'Pay the oldest unpaid invoice first. Payments are applied in order from oldest to newest.'
      ),
      { status: 400, statusCode: 400 }
    );
  }

  // Unit ceiling = primary + other generated open allocatable invoices
  // (Pending/Overdue/Partial/Due), including futures. Processing is not
  // allocatable (in-flight cash) and is not included in the payable ceiling.
  const unitOutstanding = roundMoney(
    openBalance + (candidates || [])
      .filter((row) => isOpenAllocatableInvoice(row))
      .reduce((sum, row) => sum + invoiceEffectiveOpenBalance(row), 0)
  );
  if (amount > unitOutstanding + 0.009) {
    throw Object.assign(
      new Error('Payment amount cannot exceed your total outstanding generated invoice balance.'),
      { status: 400, statusCode: 400 }
    );
  }

  return true;
}

function normalizeBatchCoveredBalances(raw) {
  const map = new Map();
  if (!raw) return map;
  if (raw instanceof Map) {
    for (const [key, value] of raw.entries()) {
      const amount = roundMoney(Number(value) || 0);
      if (key && amount > 0) map.set(String(key), amount);
    }
    return map;
  }
  if (typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      const amount = roundMoney(Number(value) || 0);
      if (key && amount > 0) map.set(String(key), amount);
    }
  }
  return map;
}

function toAllocationInvoiceId(invoice) {
  return invoice?._id != null ? invoice._id : invoice;
}

/**
 * Sort open invoices oldest → newest (dueDate, createdAt, _id).
 */
function sortInvoicesFifo(invoices = []) {
  return [...(invoices || [])].sort((a, b) => {
    const dueDiff = invoiceDueSortValue(a) - invoiceDueSortValue(b);
    if (dueDiff !== 0) return dueDiff;
    const aCreated = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bCreated = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (aCreated !== bCreated) return aCreated - bCreated;
    return String(a?._id || '').localeCompare(String(b?._id || ''));
  });
}

/**
 * Ensure the selected (primary) invoice participates in allocation when it still
 * has remaining balance but is excluded from allocatable statuses (Processing).
 * Inserted at its FIFO position so Pay Remaining Balance clears that invoice
 * before cash walks to younger open invoices.
 */
function mergePrimaryIntoOpenInvoices(openInvoices = [], primaryInvoice) {
  if (!primaryInvoice || invoiceEffectiveOpenBalance(primaryInvoice) <= 0) {
    return openInvoices || [];
  }
  const primaryId = String(primaryInvoice._id || '');
  if (!primaryId) return openInvoices || [];
  if ((openInvoices || []).some((inv) => String(inv?._id) === primaryId)) {
    return openInvoices || [];
  }
  return sortInvoicesFifo([...(openInvoices || []), primaryInvoice]);
}

/**
 * Pure FIFO allocation plan used by both preview and processInvoiceOverpayment.
 * Open invoices must already be sorted oldest → newest (dueDate, createdAt, _id).
 * When primary has remaining balance but is not in the open set (e.g. Processing),
 * it is merged in at its FIFO position so explicit Pay targets that invoice first.
 */
function planInvoicePaymentAllocation({
  openInvoices = [],
  primaryInvoice,
  paymentAmount,
  allocateFutureInvoices = false,
} = {}) {
  const payAmount = roundMoney(paymentAmount);
  let remaining = payAmount;
  const lines = [];
  const primaryId = String(primaryInvoice?._id || '');
  const candidates = mergePrimaryIntoOpenInvoices(openInvoices, primaryInvoice);

  const consider = (inv, { forcePrimary = false } = {}) => {
    if (!inv || remaining <= 0) return;

    const isPrimary = String(inv._id) === primaryId;
    if (!forcePrimary) {
      if (!canAllocateRecordedPaymentCash(inv, primaryInvoice, allocateFutureInvoices)) return;
    } else if (!isOpenAllocatableInvoice(inv) && !isPrimary) {
      return;
    } else if (
      !isPrimary
      && !canAllocateRecordedPaymentCash(inv, primaryInvoice, allocateFutureInvoices)
    ) {
      return;
    }

    const outstanding = invoiceEffectiveOpenBalance(inv);
    if (outstanding <= 0) return;

    const alreadyApplied = lines
      .filter((line) => String(line.invoiceId) === String(inv._id))
      .reduce((sum, line) => sum + Number(line.paymentApplied || 0), 0);
    const outstandingLeft = roundMoney(outstanding - alreadyApplied);
    if (outstandingLeft <= 0) return;

    const applied = roundMoney(Math.min(remaining, outstandingLeft));
    if (applied <= 0) return;

    remaining = roundMoney(remaining - applied);
    const existing = lines.find((line) => String(line.invoiceId) === String(inv._id));
    if (existing) {
      existing.paymentApplied = roundMoney(existing.paymentApplied + applied);
      existing.remaining = roundMoney(outstanding - existing.paymentApplied);
      return;
    }

    lines.push({
      invoiceId: toAllocationInvoiceId(inv),
      invoiceNumber: inv.invoiceId || String(inv._id),
      dueDate: inv.dueDate || null,
      status: inv.status || '',
      outstandingBalance: outstanding,
      paymentApplied: applied,
      remaining: roundMoney(outstanding - applied),
      isPrimary,
    });
  };

  for (const inv of candidates) {
    if (remaining <= 0) break;
    consider(inv);
  }

  if (remaining > 0 && primaryInvoice && invoiceEffectiveOpenBalance(primaryInvoice) > 0) {
    consider(primaryInvoice, { forcePrimary: true });
  }

  const remainingCredit = remaining > 0.009 ? remaining : 0;
  return {
    invoices: lines.filter((line) => Number(line.paymentApplied || 0) > 0.009),
    totalPayment: payAmount,
    totalApplied: roundMoney(payAmount - remainingCredit),
    remainingCredit,
  };
}

async function loadOpenAllocatableInvoicesForUnit(unitId, session = null) {
  const objId = toObjectId(unitId) || (unitId instanceof mongoose.Types.ObjectId ? unitId : null);
  if (!objId) return [];

  let openQuery = Invoice.find({
    propertyId: objId,
    status: { $in: Array.from(CHRONOLOGICAL_PAYMENT_STATUSES) },
    isDeleted: { $ne: true },
  })
    .select('_id invoiceId dueDate createdAt status balanceDue subAmount alreadyPaid processingAmount waivedAmount paymentTransactions')
    .sort({ dueDate: 1, createdAt: 1, _id: 1 });
  if (session) openQuery = openQuery.session(session);
  const rows = await openQuery.lean();
  return (rows || []).filter((inv) => invoiceEffectiveOpenBalance(inv) > 0);
}

function isPersistableInvoice(invoice) {
  return Boolean(invoice && typeof invoice.save === 'function');
}

async function loadPersistableInvoiceById(invoiceId, unitId, session = null) {
  let query = Invoice.findOne({
    _id: invoiceId,
    propertyId: unitId,
    isDeleted: { $ne: true },
  });
  if (session) query = query.session(session);
  return query;
}

/**
 * Read-only payment allocation preview. Uses the same filters, sort, and walk
 * as processInvoiceOverpayment so the UI cannot diverge from persisted allocation.
 */
async function previewInvoicePaymentAllocation({
  unitId,
  primaryInvoiceId,
  paymentAmount,
  allocateFutureInvoices = false,
  session = null,
} = {}) {
  const payAmount = roundMoney(paymentAmount);
  if (!(payAmount > 0)) {
    throw Object.assign(new Error('Payment amount must be positive'), { status: 400, statusCode: 400 });
  }

  const objId = toObjectId(unitId) || (unitId instanceof mongoose.Types.ObjectId ? unitId : null);
  if (!objId) {
    throw Object.assign(new Error('Invalid unitId'), { status: 400, statusCode: 400 });
  }

  const safePrimaryId = toObjectId(primaryInvoiceId) || primaryInvoiceId;
  let primaryQuery = Invoice.findOne({
    _id: safePrimaryId,
    propertyId: objId,
    isDeleted: { $ne: true },
  }).select('_id invoiceId dueDate createdAt status balanceDue alreadyPaid processingAmount waivedAmount subAmount propertyId paymentTransactions');
  if (session) primaryQuery = primaryQuery.session(session);
  const primary = await primaryQuery.lean();
  if (!primary) {
    throw Object.assign(new Error('Invoice not found'), { status: 404, statusCode: 404 });
  }

  const openInvoices = await loadOpenAllocatableInvoicesForUnit(objId, session);
  const openRows = openInvoices || [];

  const plan = planInvoicePaymentAllocation({
    openInvoices: openRows,
    primaryInvoice: primary,
    paymentAmount: payAmount,
    allocateFutureInvoices,
  });

  // Older unpaid = earlier allocatable invoices, OR earlier partial-Processing
  // invoices still carrying balanceDue (sequential blockers).
  const hasOlderUnpaidInvoices = (openRows || []).some((inv) => (
    isOlderOpenInvoice(inv, primary) || isOlderSequentialBlockingInvoice(inv, primary)
  ));
  const startedFromOldest = !hasOlderUnpaidInvoices;

  return {
    primaryInvoiceId: primary._id,
    primaryInvoiceNumber: primary.invoiceId || String(primary._id),
    startedFromOldest,
    hasOlderUnpaidInvoices,
    explanation: hasOlderUnpaidInvoices
      ? 'Your payment will be applied to outstanding invoices starting with the oldest unpaid invoice. Therefore, the payment may be applied to older invoices first, then this invoice.'
      : 'Your payment will be applied to outstanding invoices in order from oldest to newest.',
    invoices: plan.invoices,
    totalPayment: plan.totalPayment,
    totalApplied: plan.totalApplied,
    remainingCredit: plan.remainingCredit,
  };
}

/**
 * Apply a payment against an invoice account:
 * 1) allocate across open invoices oldest-first (FIFO by due date)
 * 2) store any leftover on Property.remainingCredit (+ audit ledger adjustment)
 * `primaryInvoiceId` is the invoice the payment was recorded against (for ledger linkage).
 *
 * @param {boolean} [allocateFutureInvoices=false] When false (board Record Payment), settle
 *   older open invoices (FIFO) then the selected primary; leftover becomes credit. Later-due
 *   (future) invoices are not prepaid during this payment step. Owner Pay Now passes true.
 */
async function processInvoiceOverpayment({
  unitId,
  primaryInvoiceId,
  paymentAmount,
  paymentMeta = {},
  session = null,
  allocateFutureInvoices = false,
}) {
  const opts = session ? { session } : {};
  const objId = toObjectId(unitId) || (unitId instanceof mongoose.Types.ObjectId ? unitId : null);
  if (!objId) throw Object.assign(new Error('Invalid unitId'), { status: 400 });
  const payAmount = roundMoney(paymentAmount);
  if (payAmount <= 0) {
    throw Object.assign(new Error('paymentAmount must be positive'), { status: 400 });
  }

  const safePrimaryId = toObjectId(primaryInvoiceId) || primaryInvoiceId;
  let primaryQuery = Invoice.findOne({
    _id: safePrimaryId,
    propertyId: objId,
    isDeleted: { $ne: true },
  });
  if (session) primaryQuery = primaryQuery.session(session);
  let primary = await primaryQuery;
  if (!primary) throw Object.assign(new Error('Invoice not found'), { status: 404 });

  const {
    method = '',
    note = '',
    checkNumber = '',
    moneyOrderNumber = '',
    paidBy = null,
    recordedBy = null,
    paidAt = ClockService.now(),
    recordedAt = null,
  } = paymentMeta;

  const recorder = recordedBy && mongoose.Types.ObjectId.isValid(String(recordedBy))
    ? new mongoose.Types.ObjectId(String(recordedBy))
    : null;
  const payer = paidBy && mongoose.Types.ObjectId.isValid(String(paidBy))
    ? new mongoose.Types.ObjectId(String(paidBy))
    : null;
  const paidAtDate = paidAt instanceof Date ? paidAt : (DateUtil.toUTC(paidAt) || ClockService.now());
  const recordedAtDate = recordedAt instanceof Date ? recordedAt : (DateUtil.toUTC(recordedAt || paidAtDate) || paidAtDate);

  let remaining = payAmount;
  const primaryInvoiceNumber = primary.invoiceId || String(primary._id);
  const appliedOther = [];
  let applyPrimary = 0;
  const allocationReferenceDate = ClockService.now();
  const paymentGroupId = `${String(safePrimaryId)}-${Date.now()}`;

  const openInvoices = await loadOpenAllocatableInvoicesForUnit(objId, session);
  const allocationPlan = planInvoicePaymentAllocation({
    openInvoices,
    primaryInvoice: primary,
    paymentAmount: payAmount,
    allocateFutureInvoices,
  });

  // Stamp FIFO redirect metadata onto the primary self_allocation row at insert
  // time. Post-save in-place subdoc patches are unreliable in Mongoose, and when
  // they drop, Activity Timeline falls back to a plain/overpayment entry that
  // omits amounts applied to earlier invoices (common when payment >= balance).
  const plannedOtherLines = (allocationPlan.invoices || []).filter((line) => !line.isPrimary);
  const plannedPrimaryRedirectMeta = plannedOtherLines.length > 0
    ? {
      fifoRedirectedAmount: roundMoney(
        plannedOtherLines.reduce((sum, row) => sum + Number(row.paymentApplied || 0), 0)
      ),
      fifoRedirectedToInvoiceId: plannedOtherLines[0].invoiceId,
      fifoRedirectedToInvoiceNumber:
        plannedOtherLines[0].invoiceNumber || String(plannedOtherLines[0].invoiceId),
      fifoRedirectedToDueDate: plannedOtherLines[0].dueDate || undefined,
      fifoRedirectedAllocations: plannedOtherLines.map((row) => ({
        invoiceId: row.invoiceId,
        invoiceNumber: row.invoiceNumber || String(row.invoiceId),
        amount: roundMoney(row.paymentApplied || 0),
      })),
    }
    : null;

  const applyToInvoice = async (inv, { forcePrimary = false, exactApply = null } = {}) => {
    if (!inv || remaining <= 0) return false;

    const isPrimary = String(inv._id) === String(primary._id);
    if (!forcePrimary) {
      if (!canAllocateRecordedPaymentCash(inv, primary, allocateFutureInvoices)) {
        return false;
      }
    } else if (!isOpenAllocatableInvoice(inv) && !isPrimary) {
      return false;
    } else if (
      !isPrimary
      && !canAllocateRecordedPaymentCash(inv, primary, allocateFutureInvoices)
    ) {
      return false;
    }

    const balanceDue = roundMoney(Number(inv.balanceDue || 0));
    if (balanceDue <= 0) return false;

    const apply = exactApply != null
      ? roundMoney(Math.min(exactApply, remaining, balanceDue))
      : roundMoney(Math.min(remaining, balanceDue));
    if (apply <= 0) return false;

    const statusBeforeApply = String(inv.status || '');
    inv.alreadyPaid = roundMoney(Number(inv.alreadyPaid || 0) + apply);
    inv.balanceDue = roundMoney(balanceDue - apply);
    remaining = roundMoney(remaining - apply);

    if (inv.balanceDue <= 0) {
      inv.balanceDue = 0;
    }
    recalculateInvoiceStatus(inv);
    if (inv.status === INVOICE_STATUS.PAID) {
      inv.paidOn = paidAtDate;
    }

    const allocationLabel = isPrimary
      ? 'selected invoice'
      : (statusBeforeApply.toLowerCase() === String(INVOICE_STATUS.OVERDUE).toLowerCase()
        ? 'overdue invoice'
        : 'open invoice');

    inv.paymentTransactions = inv.paymentTransactions || [];
    inv.paymentTransactions.push(buildInvoicePaymentTransaction({
      amount: apply,
      method: isPrimary ? method : (method || 'Payment Allocation'),
      note: isPrimary
        ? (note || `Payment recorded for invoice #${primaryInvoiceNumber}`)
        : `Applied $${apply.toFixed(2)} from payment on invoice #${primaryInvoiceNumber} (${allocationLabel})`,
      checkNumber,
      moneyOrderNumber,
      balanceAfter: inv.balanceDue,
      paidAt: paidAtDate,
      recordedAt: recordedAtDate,
      recordedBy: recorder,
      paidBy: payer,
      paymentGroupId,
      recordedPaymentTotal: payAmount,
      recordedAgainstInvoiceId: primary._id,
      recordedAgainstInvoiceNumber: primaryInvoiceNumber,
      fifoAllocationRole: isPrimary ? 'self_allocation' : 'prior_allocation',
      ...(isPrimary && plannedPrimaryRedirectMeta ? plannedPrimaryRedirectMeta : {}),
    }));

    if (isPrimary) {
      applyPrimary = roundMoney(applyPrimary + apply);
      primary = inv;
    } else {
      appliedOther.push({
        invoiceId: inv._id,
        invoiceNumber: inv.invoiceId,
        amount: apply,
        balanceAfter: inv.balanceDue,
        dueDate: inv.dueDate,
      });
    }

    await inv.save(opts);
    return true;
  };

  const invoiceById = new Map();
  for (const inv of openInvoices || []) {
    invoiceById.set(String(inv._id), inv);
  }
  invoiceById.set(String(primary._id), primary);

  for (const line of allocationPlan.invoices) {
    if (remaining <= 0) break;
    let inv = invoiceById.get(String(line.invoiceId));
    // Preview/list scans use lean() objects. Those cannot persist payment rows.
    if (!isPersistableInvoice(inv)) {
      inv = await loadPersistableInvoiceById(line.invoiceId, objId, session);
      if (inv) invoiceById.set(String(inv._id), inv);
    }
    if (!inv) continue;
    await applyToInvoice(inv, { forcePrimary: true, exactApply: line.paymentApplied });
  }

  // Keep the mongoose document we actually applied to. Do not replace it with
  // the lean copy from the open-invoice scan - that drops save() and undoes
  // the in-memory payment just recorded on `primary`.
  const appliedPrimary = invoiceById.get(String(primary._id));
  if (isPersistableInvoice(appliedPrimary)) {
    primary = appliedPrimary;
  } else if (!isPersistableInvoice(primary)) {
    const reloadedPrimary = await loadPersistableInvoiceById(primary._id, objId, session);
    if (reloadedPrimary) {
      primary = reloadedPrimary;
      invoiceById.set(String(reloadedPrimary._id), reloadedPrimary);
    }
  }

  let creditStored = 0;
  if (remaining > 0) {
    creditStored = remaining;

    let propQuery = Property.findById(objId).select('remainingCredit name');
    if (session) propQuery = propQuery.session(session);
    const propertyDoc = await propQuery;
    const poolBefore = roundMoney(Number(propertyDoc?.remainingCredit || 0));
    const poolAfter = roundMoney(poolBefore + creditStored);

    await Property.findByIdAndUpdate(objId, { $set: { remainingCredit: poolAfter } }, opts);

    await new LedgerEntry({
      unitId: objId,
      type: 'adjustment',
      amount: -creditStored,
      metadata: {
        reason: `Overpayment of $${creditStored.toFixed(2)} stored as credit balance`,
        source: 'invoice_overpayment',
        // Canonical pool is Property.remainingCredit; ledger row is audit-only.
        remainingCredit: 0,
        primaryInvoiceId: primary._id,
        primaryInvoiceNumber,
        paymentMethod: method || null,
        paidBy: payer || null,
        recordedBy: recorder || null,
      },
    }).save(opts);

    primary.paymentTransactions = primary.paymentTransactions || [];
    primary.paymentTransactions.push(buildInvoicePaymentTransaction({
      amount: creditStored,
      method: 'Credit Balance',
      note: `Overpayment of $${creditStored.toFixed(2)} stored as credit balance`,
      checkNumber: '',
      moneyOrderNumber: '',
      balanceAfter: roundMoney(primary.balanceDue || 0),
      paidAt: paidAtDate,
      recordedAt: recordedAtDate,
      recordedBy: recorder,
      paidBy: payer,
      paymentGroupId,
      recordedPaymentTotal: payAmount,
      recordedAgainstInvoiceId: primary._id,
      recordedAgainstInvoiceNumber: primaryInvoiceNumber,
    }));
  }

  if (appliedOther.length > 0) {
    const redirectedTotal = roundMoney(
      appliedOther.reduce((sum, row) => sum + Number(row.amount || 0), 0)
    );
    const firstRedirect = appliedOther[0];
    const fifoRedirectedAllocations = appliedOther.map((row) => ({
      invoiceId: row.invoiceId,
      invoiceNumber: row.invoiceNumber || String(row.invoiceId),
      amount: roundMoney(row.amount || 0),
    }));
    for (const tx of primary.paymentTransactions || []) {
      if (tx.paymentGroupId !== paymentGroupId) continue;
      if (tx.fifoAllocationRole !== 'self_allocation') continue;
      tx.fifoRedirectedAmount = redirectedTotal;
      tx.fifoRedirectedToInvoiceId = firstRedirect.invoiceId;
      tx.fifoRedirectedToInvoiceNumber = firstRedirect.invoiceNumber || String(firstRedirect.invoiceId);
      if (firstRedirect.dueDate) tx.fifoRedirectedToDueDate = firstRedirect.dueDate;
      tx.fifoRedirectedAllocations = fifoRedirectedAllocations;
    }

    if (applyPrimary <= 0) {
      primary.paymentTransactions = primary.paymentTransactions || [];
      primary.paymentTransactions.push(buildInvoicePaymentTransaction({
        amount: 0,
        method: method || 'Payment',
        note: `Payment of $${payAmount.toFixed(2)} recorded; applied to prior outstanding invoices first`,
        checkNumber,
        moneyOrderNumber,
        balanceAfter: roundMoney(primary.balanceDue || 0),
        paidAt: paidAtDate,
        recordedAt: recordedAtDate,
        recordedBy: recorder,
        paidBy: payer,
        paymentGroupId,
        recordedPaymentTotal: payAmount,
        recordedAgainstInvoiceId: primary._id,
        recordedAgainstInvoiceNumber: primaryInvoiceNumber,
        fifoAllocationRole: 'recorded_only',
        fifoRedirectedAmount: redirectedTotal,
        fifoRedirectedToInvoiceId: firstRedirect.invoiceId,
        fifoRedirectedToInvoiceNumber: firstRedirect.invoiceNumber || String(firstRedirect.invoiceId),
        fifoRedirectedToDueDate: firstRedirect.dueDate,
        fifoRedirectedAllocations,
      }));
    }

    // In-place nested subdoc mutations (self_allocation redirect fields) are not
    // always detected by Mongoose when no array push occurs - common when cash
    // spills onto the recording invoice after older invoices are paid first.
    if (typeof primary.markModified === 'function') {
      primary.markModified('paymentTransactions');
    }
  }

  if (appliedOther.length > 0) {
    await new LedgerEntry({
      unitId: objId,
      type: 'adjustment',
      amount: 0,
      metadata: {
        reason: 'Overpayment allocated to additional open invoices',
        source: 'invoice_overpayment_allocation',
        primaryInvoiceId: primary._id,
        primaryInvoiceNumber,
        appliedInvoices: appliedOther,
        totalAllocated: roundMoney(appliedOther.reduce((sum, row) => sum + Number(row.amount || 0), 0)),
      },
    }).save(opts);
  }

  await recordPayment(objId, payAmount, primary._id, {
    source: 'invoice_payment',
    invoiceId: primary._id,
    invoiceNumber: primaryInvoiceNumber,
    paymentMethod: method,
    paymentNotes: note,
    checkNumber: checkNumber || undefined,
    moneyOrderNumber: moneyOrderNumber || undefined,
    paidBy: payer || undefined,
    recordedBy: recorder || undefined,
    balanceAfter: primary.balanceDue,
    paidAt: paidAtDate,
    paymentGroupId,
    overpaymentCreditStored: creditStored,
    overpaymentAllocatedToOtherInvoices: appliedOther,
  }, session);

  // When cash never touches the selected invoice (common for future invoices with
  // prior outstanding balances), leave an audit trail on that invoice.
  if (applyPrimary <= 0 && appliedOther.length > 0) {
    const allocatedTotal = roundMoney(
      appliedOther.reduce((sum, row) => sum + Number(row.amount || 0), 0)
    );
    const allocatedLabels = appliedOther
      .map((row) => row.invoiceNumber || String(row.invoiceId))
      .filter(Boolean)
      .join(', ');
    const auditChanges = [
      'Payment Applied to Oldest Outstanding Invoices',
      `Payment of $${payAmount.toFixed(2)} was applied to prior outstanding invoices first` +
      (allocatedLabels ? ` (${allocatedLabels})` : '') +
      `.`,
      `$${allocatedTotal.toFixed(2)} applied to older open invoices.`,
      'This invoice was left unchanged until prior balances are cleared.',
    ];
    if (creditStored > 0) {
      auditChanges.push(`$${creditStored.toFixed(2)} stored as credit balance.`);
    }
    primary.editHistory = primary.editHistory || [];
    primary.editHistory.push({
      changes: auditChanges,
      editedBy: recorder || undefined,
      editedAt: recordedAtDate,
    });
  }

  await primary.save(opts);

  return {
    primaryInvoiceId: primary._id,
    paymentAmount: payAmount,
    appliedToPrimary: applyPrimary,
    appliedToOtherInvoices: appliedOther,
    creditStored,
    primaryBalanceDue: primary.balanceDue,
    primaryAlreadyPaid: primary.alreadyPaid,
    primaryStatus: primary.status,
  };
}

/**
 * Apply a manual balance adjustment.
 *
 * Negative amount (credit): distributes across open invoices oldest-first,
 *   then stores the ledger entry with the full original amount.
 * Positive amount (charge): creates a new Pending invoice dated today,
 *   associated with the unit's owners, then stores the ledger entry.
 */
async function applyBalanceAdjustment(unitId, amount, reason, createdBy, dueDate, paymentMethod, checkNumber, moneyOrderNumber) {
  if (!unitId) throw Object.assign(new Error('unitId is required'), { status: 400 });
  if (typeof amount !== 'number' || !isFinite(amount)) {
    throw Object.assign(new Error('amount must be a finite number'), { status: 400 });
  }
  if (!reason || !reason.trim()) throw Object.assign(new Error('reason is required'), { status: 400 });

  const unit = await Property.findOne({ _id: unitId, isDeleted: { $ne: true } }).lean();
  if (!unit) {
    throw Object.assign(new Error('Unit not found'), { status: 404 });
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    let remainingCredit = 0;
    let appliedInvoices = [];

    if (amount < 0) {
      // Credit: apply to open invoices oldest-first
      remainingCredit = await applyCreditToInvoices(
        unitId,
        Math.abs(amount),
        session,
        reason,
        paymentMethod,
        checkNumber,
        moneyOrderNumber,
        createdBy,
        appliedInvoices
      );
    } else if (amount > 0) {
      // Charge: create a real invoice so it appears in the invoice list
      const ownerIds = (unit.associatedOwnerIds || []);
      if (ownerIds.length === 0) {
        throw Object.assign(
          new Error('Cannot create a charge invoice: no owners are associated with this unit.'),
          { status: 400 }
        );
      }

      let uniqueInvoiceId;
      for (let i = 0; i < 5; i++) {
        const candidate = makeInvoiceId();
        const exists = await Invoice.exists({ invoiceId: candidate });
        if (!exists) { uniqueInvoiceId = candidate; break; }
      }
      if (!uniqueInvoiceId) uniqueInvoiceId = makeInvoiceId();

      const adjustmentDue =
        dueDate ? (DateUtil.toUTC(dueDate) || DateUtil.startOfDayEST(ClockService.now())) : getTodayAnchorInTimeZone() || DateUtil.startOfDayEST(ClockService.now());

      const chargeInvoice = new Invoice({
        invoiceId: uniqueInvoiceId,
        type: INVOICE_TYPES.FEES,
        status: INVOICE_STATUS.PENDING,
        propertyId: unitId,
        propertyName: unit.name,
        unit: (unit.unitDetails && unit.unitDetails[0] ? unit.unitDetails[0].unitName : unit.name) || 'Unit',
        term: reason.trim(),
        tenants: ownerIds,
        invoiceItemDetails: [{
          invoiceItem: 'Adjustment Charge',
          description: reason.trim(),
          quantity: 1,
          rate: amount,
          amount,
        }],
        subAmount: amount,
        alreadyPaid: 0,
        balanceDue: amount,
        isPartialPaymentAllowed: true,
        dueDate: adjustmentDue,
        generatedFrom: 'manual',
        createdBy: createdBy || undefined,
      });
      await chargeInvoice.save({ session });
    }

    const entry = new LedgerEntry({
      unitId,
      type: 'adjustment',
      amount,
      metadata: {
        reason: reason.trim(),
        paymentMethod: paymentMethod || null,
        checkNumber: checkNumber || null,
        moneyOrderNumber: moneyOrderNumber || null,
        createdBy: createdBy || null,
        appliedToInvoices: amount < 0 ? Math.abs(amount) - remainingCredit : 0,
        appliedInvoices,
        remainingCredit,
      },
    });
    await entry.save({ session });

    await session.commitTransaction();
    session.endSession();

    await logActivity({
      userId: createdBy || undefined,
      action: 'ADJUSTMENT',
      module: 'HOA Unit Balance',
      entityType: 'Property',
      entityId: unitId,
      entityName: unit.name,
      description: `${amount >= 0 ? 'Charge adjustment' : 'Credit adjustment'}: ${reason.trim()}`,
      metadata: {
        amount,
        remainingCredit,
        unitId: String(unitId),
      },
    });

    return entry;
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

/**
 * Record a payment against a unit.
 * amount should be negative (reduces balance).
 * Optionally links to an invoice via referenceId.
 */
async function recordPayment(unitId, amount, referenceId, metadata, session) {
  if (!unitId) throw Object.assign(new Error('unitId is required'), { status: 400 });
  const entry = new LedgerEntry({
    unitId,
    type: 'payment',
    amount: -Math.abs(Number(amount)), // always negative
    referenceId: referenceId || undefined,
    metadata: metadata || {}
  });
  const opts = session ? { session } : {};
  return entry.save(opts);
}

/**
 * Calculate the current balance for a unit.
 *
 * netBalance = SUM(ledger_entries.amount) + SUM(unpaid invoice balanceDue)
 */
async function calculateUnitBalance(unitId) {
  if (!unitId) throw Object.assign(new Error('unitId is required'), { status: 400 });

  const objId = toObjectId(unitId);
  if (!objId) throw Object.assign(new Error('Invalid unitId'), { status: 400 });
  await applyAllUnappliedCreditToDueInvoices(unitId);
  await ensureLateFeeInvoicesForUnit(unitId);

  const [ledgerAgg] = await LedgerEntry.aggregate([
    { $match: { unitId: objId } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);
  const ledgerSum = ledgerAgg ? ledgerAgg.total : 0;

  const invoices = await Invoice.find({
    propertyId: objId,
    isDeleted: { $ne: true }
  })
    .select('status dueDate subAmount alreadyPaid balanceDue processingAmount term type generatedFrom paymentTransactions')
    .sort({ dueDate: 1 })
    .lean();

  const billingState = await resolveBillingInvoiceState(unitId, objId, invoices);
  if (invoices.length > 0 && !billingState.hasGeneratedInvoices) {
    await markPropertyHasGeneratedInvoices(unitId);
    billingState.hasGeneratedInvoices = true;
    billingState.includeOpeningInNet = false;
  }

  const [invoiceAgg] = await Invoice.aggregate([
    {
      $match: {
        propertyId: objId,
        status: { $in: [INVOICE_STATUS.PENDING, INVOICE_STATUS.PARTIALLY_PAID, INVOICE_STATUS.OVERDUE] },
        isDeleted: { $ne: true }
      }
    },
    { $group: { _id: null, total: { $sum: '$balanceDue' } } }
  ]);
  const unpaidInvoices = invoiceAgg ? invoiceAgg.total : 0;

  const [obAgg] = await LedgerEntry.aggregate([
    { $match: { unitId: objId, type: 'opening_balance' } },
    { $group: { _id: null, t: { $sum: '$amount' } } }
  ]);
  const openingBalance = obAgg ? obAgg.t : 0;

  const ledgerEntries = await LedgerEntry.find({ unitId: objId }).lean();
  const unappliedCreditBalance = ledgerEntries.reduce((sum, entry) => {
    if (entry.type !== 'adjustment') return sum;
    const amount = Number(entry.amount || 0);
    if (amount >= 0) return sum;
    const remainingCredit = Number(entry.metadata?.remainingCredit);
    const unapplied = Number.isFinite(remainingCredit) ? remainingCredit : Math.abs(amount);
    return sum - unapplied;
  }, 0);
  const unappliedPaymentBalance = ledgerEntries.reduce((sum, entry) => {
    if (entry.type !== 'payment') return sum;
    return entry.referenceId ? sum : sum + Number(entry.amount || 0);
  }, 0);

  const ledgerOnlyBalance =
    (billingState.includeOpeningInNet ? openingBalance : 0) +
    unappliedCreditBalance +
    unappliedPaymentBalance;

  const todayNormalized = getTodayAnchorInTimeZone() || DateUtil.startOfDayEST(ClockService.now());

  const propertyDoc = await Property.findById(objId).select('remainingCredit startingBalance hasGeneratedInvoices').lean();
  const { creditPool, netBalance } = computeNetBalanceWithCreditPool({
    invoiceTotal: unpaidInvoices,
    ledgerOnlyBalance,
    entries: ledgerEntries,
    propertyDoc,
    openingBalance,
    invoices,
    todayNormalized,
  });

  return {
    ledgerSum,
    unpaidInvoices,
    ledgerOnlyBalance,
    netBalance,
    remainingCredit: creditPool,
  };
}

/**
 * Get a full balance summary breakdown for a unit.
 */
async function getBalanceSummary(unitId, options = {}) {
  if (!unitId) throw Object.assign(new Error('unitId is required'), { status: 400 });
  const readOnly = options.readOnly === true;

  const objId = toObjectId(unitId);
  if (!objId) throw Object.assign(new Error('Invalid unitId'), { status: 400 });

  // Apply stored credit + late fees only on write paths (payments, adjustments), not list reads.
  if (!readOnly) {
    await applyAllUnappliedCreditToDueInvoices(unitId);
    await ensureLateFeeInvoicesForUnit(unitId);
  }

  const entries = options._cachedEntries != null
    ? options._cachedEntries
    : await LedgerEntry.find({ unitId: objId }).sort({ createdAt: 1 }).lean();

  let openingBalance = 0;
  let adjustments = 0;
  let payments = 0;

  for (const e of entries) {
    if (e.type === 'opening_balance') openingBalance += e.amount;
    else if (e.type === 'adjustment') adjustments += e.amount;
    else if (e.type === 'payment') payments += e.amount;
  }

  const invoices = options._cachedInvoices != null
    ? options._cachedInvoices
    : await Invoice.find({
      propertyId: objId,
      isDeleted: { $ne: true }
    })
      .select('status dueDate subAmount alreadyPaid balanceDue waivedAmount processingAmount term type generatedFrom paymentTransactions')
      .sort({ dueDate: 1 })
      .lean();

  let invoiceTotal = 0;
  let overdueAmount = 0;
  let partiallyPaidAmount = 0;
  let totalInvoiced = 0;
  let paidInvoiceAmount = 0;
  let paidInvoiceCount = 0;
  let unpaidInvoiceCount = 0;
  let overdueInvoiceCount = 0;
  let pendingInvoiceCount = 0;
  let partiallyPaidInvoiceCount = 0;
  let dueTodayOutstanding = 0;

  const todayNormalized = getTodayAnchorInTimeZone() || DateUtil.startOfDayEST(ClockService.now());

  const todayCalendarKey = getDateKeyInTimeZone(ClockService.now());

  for (const invoice of invoices) {
    const effectiveStatus = getEffectiveInvoiceStatus(invoice);
    const subAmount = Number(invoice.subAmount || 0);
    const alreadyPaid = Number(invoice.alreadyPaid || 0);
    const waivedAmount = Number(invoice.waivedAmount || 0);
    const balanceDue = Number(invoice.balanceDue || 0);
    const invDueKey = billingCalendarDateKey(invoice.dueDate);
    const isFuture = Boolean(todayCalendarKey && invDueKey && invDueKey > todayCalendarKey);

    totalInvoiced += subAmount;
    paidInvoiceAmount += Math.min(subAmount, alreadyPaid + waivedAmount);

    // Future invoices are excluded from all outstanding/overdue counts
    if (isFuture) continue;

    if (balanceDue > 0) {
      const isDueToday = Boolean(invDueKey && todayCalendarKey && invDueKey === todayCalendarKey);
      if (isDueToday) dueTodayOutstanding = roundMoney(dueTodayOutstanding + balanceDue);

      invoiceTotal += balanceDue;
      unpaidInvoiceCount += 1;

      if (effectiveStatus === INVOICE_STATUS.OVERDUE) {
        if (!isDueToday) {
          overdueInvoiceCount += 1;
          overdueAmount += balanceDue;
        } else {
          pendingInvoiceCount += 1;
        }
      } else if (effectiveStatus === INVOICE_STATUS.PARTIALLY_PAID) {
        partiallyPaidInvoiceCount += 1;
        const isPastDue = isPastDueOutstandingInvoice(invoice);
        if (isPastDue) {
          overdueInvoiceCount += 1;
          overdueAmount += balanceDue;
        } else {
          partiallyPaidAmount += balanceDue;
          pendingInvoiceCount += 1;
        }
      } else if (
        effectiveStatus === INVOICE_STATUS.PROCESSING
        || String(invoice.status) === String(INVOICE_STATUS.PROCESSING)
      ) {
        if (isPastDueOutstandingInvoice(invoice)) {
          overdueInvoiceCount += 1;
          overdueAmount += balanceDue;
        } else if (isDueToday) {
          pendingInvoiceCount += 1;
        } else {
          pendingInvoiceCount += 1;
        }
      } else if (effectiveStatus === INVOICE_STATUS.PENDING) {
        pendingInvoiceCount += 1;
      }
    } else {
      paidInvoiceCount += 1;
    }
  }

  const billingState = await resolveBillingInvoiceState(unitId, objId, invoices, null, {
    readOnly,
    cachedProperty: options._cachedProperty,
    cachedEntries: entries,
    cachedHasSoftDeletedInvoice: options._cachedHasSoftDeletedInvoice,
    cachedHasLedgerActivity: options._cachedHasLedgerActivity,
  });
  if (invoices.length > 0 && !billingState.hasGeneratedInvoices && !readOnly) {
    await markPropertyHasGeneratedInvoices(unitId);
    billingState.hasGeneratedInvoices = true;
    billingState.includeOpeningInNet = false;
  }
  const hasGeneratedInvoices = billingState.hasGeneratedInvoices;

  let collectionStats = EMPTY_COLLECTION_STATS;
  if (!options.skipCollectionStats) {
    collectionStats = computeCollectionStatsFromInvoices(invoices);
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Unapplied credit adjustments (negative entries whose remainingCredit > 0)
  const unappliedCreditBalance = entries.reduce((sum, entry) => {
    if (entry.type !== 'adjustment') return sum;
    if (isAuditOnlyCreditAdjustment(entry)) return sum;
    const amount = Number(entry.amount || 0);
    if (amount >= 0) return sum; // positive adjustments are now invoices - don't double-count
    const remainingCredit = Number(entry.metadata?.remainingCredit);
    const unapplied = Number.isFinite(remainingCredit) ? remainingCredit : Math.abs(amount);
    return sum - unapplied; // negative = reduces balance
  }, 0);

  const unappliedPaymentBalance = entries.reduce((sum, entry) => {
    if (entry.type !== 'payment') return sum;
    return entry.referenceId ? sum : sum + Number(entry.amount || 0);
  }, 0);

  // Opening balance only contributes before billing starts for units with active owners.
  // Unapplied credits and payments always contribute regardless.
  const ledgerOnlyBalance =
    (billingState.includeOpeningInNet ? openingBalance : 0) +
    unappliedCreditBalance +
    unappliedPaymentBalance;

  // Credit pool left from negative starting balance (FIFO to monthly fees) - stored on Property when not yet applied.
  const propertyDoc = options._cachedProperty != null
    ? options._cachedProperty
    : await Property.findById(objId).select('remainingCredit startingBalance hasGeneratedInvoices').lean();
  const { creditPool, netBalance: rawNetBalance } = computeNetBalanceWithCreditPool({
    invoiceTotal,
    ledgerOnlyBalance,
    entries,
    propertyDoc,
    openingBalance,
    invoices,
    todayNormalized,
  });

  let bookedCreditRelease = 0;
  if (options._cachedCreditReleaseBooked != null) {
    bookedCreditRelease = roundMoney(options._cachedCreditReleaseBooked);
  } else {
    const bookedMap = await sumBookedCreditReleaseExpenseByUnitIds([objId]);
    bookedCreditRelease = roundMoney(bookedMap.get(String(objId)) || 0);
  }
  const remainingCredit = applyBookedCreditReleaseOffset(creditPool, bookedCreditRelease);
  let creditPoolReduction = roundMoney(Math.max(0, creditPool - remainingCredit));
  let netBalance = roundMoney(rawNetBalance + creditPoolReduction);
  // When credit was booked as a credit-release HOA expense, net must not read as advance
  // credit after the expense is marked paid (pool offset alone can leave rawNet negative).
  if (bookedCreditRelease > 0 && remainingCredit === 0 && netBalance < 0) {
    netBalance = roundMoney(Math.min(0, netBalance + bookedCreditRelease));
    if (netBalance === 0) {
      creditPoolReduction = roundMoney(Math.max(creditPoolReduction, bookedCreditRelease));
    }
  }
  const status = netBalance > 0 ? 'due' : netBalance < 0 ? 'advance' : 'settled';

  return {
    openingBalance,
    adjustments,
    invoiceTotal,
    overdueAmount,
    partiallyPaidAmount,
    payments,
    ledgerOnlyBalance,
    remainingCredit,
    totalInvoiced,
    paidInvoiceAmount,
    invoiceCount: invoices.length,
    paidInvoiceCount,
    unpaidInvoiceCount,
    overdueInvoiceCount,
    partiallyPaidInvoiceCount,
    pendingInvoiceCount,
    /** Outstanding invoice balance tied to dues whose calendar due date equals today - excluded from listing "past due" UX until the day rolls. */
    dueTodayAmount: roundMoney(dueTodayOutstanding),
    hasGeneratedInvoices,
    netBalance,
    status,
    entries: options.omitEntries ? [] : entries,
    collectionStats,
  };
}

/**
 * Soft-delete invoices that are due in the future (calendar day after today) and still owe a balance,
 * excluding partially paid rows (so payment history on those invoices is preserved when a unit is removed).
 * Past/current (including overdue, paid, and partial) invoices are left unchanged for visibility.
 *
 * @param {string|import('mongoose').Types.ObjectId} propertyId - Unit / property id
 * @param {string|import('mongoose').Types.ObjectId} [deletedBy]
 * @param {import('mongoose').ClientSession} [session]
 * @returns {Promise<{ modifiedCount?: number, matchedCount?: number }>}
 */
async function softDeleteFutureUnpaidInvoices(propertyId, deletedBy, session) {
  if (!propertyId) throw Object.assign(new Error('propertyId is required'), { status: 400 });

  const objId = toObjectId(propertyId);
  if (!objId) throw Object.assign(new Error('Invalid propertyId'), { status: 400 });

  let invQuery = Invoice.find({
    propertyId: objId,
    isDeleted: { $ne: true }
  }).select('_id dueDate balanceDue status alreadyPaid');
  if (session) invQuery = invQuery.session(session);
  const invoices = await invQuery.lean();

  const todayKeyDel = getDateKeyInTimeZone(ClockService.now());
  const ids = [];
  for (const inv of invoices) {
    const dk = billingCalendarDateKey(inv.dueDate);
    const isFuture = Boolean(dk && todayKeyDel && dk > todayKeyDel);
    const balanceDue = Number(inv.balanceDue || 0);
    const alreadyPaid = Number(inv.alreadyPaid || 0);
    const isPartiallyPaidStatus = inv.status === INVOICE_STATUS.PARTIALLY_PAID;
    const isPartiallyPaidByAmounts = alreadyPaid > 0 && balanceDue > 0;
    if (isFuture && balanceDue > 0 && !isPartiallyPaidStatus && !isPartiallyPaidByAmounts) {
      ids.push(inv._id);
    }
  }

  if (ids.length === 0) {
    return { modifiedCount: 0, matchedCount: 0 };
  }

  const updateOpts = session ? { session } : {};
  return Invoice.updateMany(
    { _id: { $in: ids } },
    {
      $set: {
        isDeleted: true,
        deletedAt: ClockService.now(),
        ...(deletedBy ? { deletedBy } : {})
      }
    },
    updateOpts
  );
}

/**
 * Soft-delete future pending invoices on units solely owned by a deleted owner.
 * Paid, partially paid, due, and overdue invoices are preserved. No settlement is performed.
 */
async function softDeleteFutureUnpaidInvoicesForDeletedOwner(ownerId, deletedBy, session, options = {}) {
  if (!ownerId) throw Object.assign(new Error('ownerId is required'), { status: 400 });

  const ownerOid = toObjectId(ownerId);
  if (!ownerOid) throw Object.assign(new Error('Invalid ownerId'), { status: 400 });

  const propertyIdSet = new Set(
    (Array.isArray(options.propertyIds) ? options.propertyIds : [])
      .filter(Boolean)
      .map((id) => String(id))
  );

  let propertyQuery = Property.find({
    associatedOwnerIds: ownerOid,
    isDeleted: { $ne: true },
  }).select('_id associatedOwnerIds');
  if (session) propertyQuery = propertyQuery.session(session);
  const properties = await propertyQuery.lean();
  for (const prop of properties) {
    propertyIdSet.add(String(prop._id));
  }

  let modifiedCount = 0;
  for (const propertyId of propertyIdSet) {
    let prop = properties.find((row) => String(row._id) === propertyId);
    if (!prop) {
      const safePropId = toObjectId(propertyId);
      if (!safePropId) continue;
      let singleQuery = Property.findOne({
        _id: safePropId,
        isDeleted: { $ne: true },
      }).select('_id associatedOwnerIds');
      if (session) singleQuery = singleQuery.session(session);
      prop = await singleQuery.lean();
    }
    if (!prop) continue;

    const otherOwnerIds = (prop.associatedOwnerIds || []).filter(
      (id) => String(id) !== String(ownerOid)
    );

    let isSoleOwnerUnit = otherOwnerIds.length === 0;
    if (!isSoleOwnerUnit) {
      const otherOwnerOids = otherOwnerIds.map((id) => toObjectId(id)).filter(Boolean);
      let othersQuery = User.countDocuments({
        _id: { $in: otherOwnerOids },
        isDeleted: { $ne: true },
      });
      if (session) othersQuery = othersQuery.session(session);
      const activeOtherOwners = await othersQuery;
      isSoleOwnerUnit = activeOtherOwners === 0;
    }

    if (!isSoleOwnerUnit) continue;

    const result = await softDeleteFutureUnpaidInvoices(prop._id, deletedBy, session);
    modifiedCount += Number(result.modifiedCount || 0);
  }

  return { modifiedCount, propertyCount: propertyIdSet.size };
}

/**
 * Get all ledger entries for a unit (audit trail).
 */
async function getLedgerEntries(unitId) {
  if (!unitId) throw Object.assign(new Error('unitId is required'), { status: 400 });
  return LedgerEntry.find({ unitId }).sort({ createdAt: 1 }).lean();
}

/**
 * Portfolio list balance fields aligned with GET /units/:id/balance and PropMv-UI
 * `propertyBalanceUtils.getDisplayBalance` / `getBalanceFromSummary`.
 */
function portfolioDisplayBalanceFromSummary(summary) {
  if (!summary) {
    return {
      pastDueAmount: 0,
      creditBalance: 0,
      netBalance: 0,
      dueTodayAmount: 0,
    };
  }

  const pastDueAmount = roundMoney(Math.max(0, Number(summary.overdueAmount || 0)));
  const dueTodayAmount = roundMoney(Math.max(0, Number(summary.dueTodayAmount || 0)));
  const pool = roundMoney(Number(summary.remainingCredit || 0));
  let net = roundMoney(Number(summary.netBalance || 0));

  if (net === 0 && pool > 0 && pastDueAmount === 0) {
    net = -pool;
  }

  const credit =
    net < 0
      ? Math.max(pool, Math.abs(net))
      : Math.max(pool, roundMoney(pastDueAmount - Math.max(0, net)));

  return {
    pastDueAmount,
    creditBalance: roundMoney(credit),
    netBalance: net,
    dueTodayAmount,
  };
}

/**
 * Batch balance summaries for property/unit list views (read-only, no late-fee side effects).
 */
const BATCH_BILLING_FLAGS_TTL_MS = Number(process.env.LEDGER_BATCH_FLAGS_TTL_MS || 30_000);
const BATCH_BILLING_FLAGS_CACHE_MAX = 64;
/** @type {Map<string, { at: number, softDeletedSet: Set<string>, ledgerActivitySet: Set<string> }>} */
const batchBillingFlagsCache = new Map();

/**
 * Batched soft-deleted invoice + ledger-activity flags for resolveBillingInvoiceState.
 * Uses short TTL in-memory cache (same request / rapid list pagination) and $group
 * aggregations instead of separate distinct() round-trips per flag type.
 */
async function getBatchBillingFlags(unitObjIds) {
  if (!unitObjIds || unitObjIds.length === 0) {
    return { softDeletedSet: new Set(), ledgerActivitySet: new Set() };
  }

  const cacheKey = unitObjIds.map(String).sort().join(',');
  const cached = batchBillingFlagsCache.get(cacheKey);
  if (cached && ClockService.nowEpoch() - cached.at < BATCH_BILLING_FLAGS_TTL_MS) {
    return { softDeletedSet: cached.softDeletedSet, ledgerActivitySet: cached.ledgerActivitySet };
  }

  const LedgerEntryModel = mongoose.models.LedgerEntry
    || require('../models/ledgerEntry.model');

  const [softDeletedRows, ledgerActivityRows] = await Promise.all([
    Invoice.aggregate([
      { $match: { propertyId: { $in: unitObjIds }, isDeleted: true } },
      { $group: { _id: '$propertyId' } },
    ]),
    LedgerEntryModel.aggregate([
      { $match: { unitId: { $in: unitObjIds }, type: { $in: ['payment', 'adjustment'] } } },
      { $group: { _id: '$unitId' } },
    ]),
  ]);

  const softDeletedSet = new Set((softDeletedRows || []).map((row) => String(row._id)));
  const ledgerActivitySet = new Set((ledgerActivityRows || []).map((row) => String(row._id)));

  batchBillingFlagsCache.set(cacheKey, {
    at: ClockService.nowEpoch(),
    softDeletedSet,
    ledgerActivitySet,
  });
  if (batchBillingFlagsCache.size > BATCH_BILLING_FLAGS_CACHE_MAX) {
    const oldestKey = batchBillingFlagsCache.keys().next().value;
    if (oldestKey) batchBillingFlagsCache.delete(oldestKey);
  }

  return { softDeletedSet, ledgerActivitySet };
}

async function getBalanceSummariesBatch(unitIds, options = { readOnly: true }) {
  const uniqueIds = [...new Set((unitIds || []).map((id) => String(id)).filter(Boolean))];
  if (uniqueIds.length === 0) return {};

  const objIds = uniqueIds
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  if (objIds.length === 0) return {};

  const readOnly = options.readOnly !== false;
  const summaryOptions = readOnly
    ? { readOnly: true, skipCollectionStats: true, omitEntries: true }
    : { readOnly: false };

  const LedgerEntryModel = mongoose.models.LedgerEntry
    || require('../models/ledgerEntry.model');

  const [balanceEntries, allInvoices, allProperties, billingFlags, creditReleaseByUnit] = await Promise.all([
    LedgerEntryModel.findEntriesForBalanceByUnitIds(objIds),
    Invoice.find({ propertyId: { $in: objIds }, isDeleted: { $ne: true } })
      .select('propertyId status dueDate subAmount alreadyPaid balanceDue waivedAmount processingAmount term type generatedFrom paymentTransactions')
      .sort({ dueDate: 1 })
      .lean(),
    Property.find({ _id: { $in: objIds } })
      .select('remainingCredit startingBalance hasGeneratedInvoices associatedOwnerIds')
      .lean(),
    readOnly ? getBatchBillingFlags(objIds) : Promise.resolve({ softDeletedSet: new Set(), ledgerActivitySet: new Set() }),
    sumBookedCreditReleaseExpenseByUnitIds(objIds),
  ]);

  const { softDeletedSet, ledgerActivitySet } = billingFlags;

  const entriesByUnit = new Map();
  for (const entry of balanceEntries) {
    const key = String(entry.unitId);
    if (!entriesByUnit.has(key)) entriesByUnit.set(key, []);
    entriesByUnit.get(key).push(entry);
  }

  const invoicesByUnit = new Map();
  for (const invoice of allInvoices) {
    const key = String(invoice.propertyId);
    if (!invoicesByUnit.has(key)) invoicesByUnit.set(key, []);
    invoicesByUnit.get(key).push(invoice);
  }

  const propertyByUnit = new Map(allProperties.map((p) => [String(p._id), p]));

  const summaries = {};
  // Cached batch path is CPU-bound per unit; compute in parallel to avoid head-of-line blocking.
  await Promise.all(
    uniqueIds.map(async (id) => {
      summaries[id] = await getBalanceSummary(id, {
        ...summaryOptions,
        _cachedEntries: entriesByUnit.get(id) || [],
        _cachedInvoices: invoicesByUnit.get(id) || [],
        _cachedProperty: propertyByUnit.get(id) || null,
        _cachedHasSoftDeletedInvoice: softDeletedSet.has(id),
        _cachedHasLedgerActivity: ledgerActivitySet.has(id),
        _cachedCreditReleaseBooked: creditReleaseByUnit.get(id) || 0,
      });
    })
  );
  return summaries;
}

function expenseDocIsCreditRelease(expenseDoc) {
  return (expenseDoc?.expenseItems || []).some(
    (item) => String(item?.category || '') === CREDIT_RELEASE_EXPENSE_CATEGORY
  );
}

/**
 * Paying a credit-release HOA expense must not restore property credit.
 * Re-assert ledger/property drain when stale credit remains after mark-as-paid.
 */
async function ensureCreditReleaseExpenseSettledOnPaid(unitId, bookedAmount, performedBy) {
  const objId = toObjectId(unitId);
  if (!objId) return;

  const released = roundMoney(bookedAmount);
  if (released <= 0) return;

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const propertyDoc = await Property.findById(objId)
      .select('remainingCredit startingBalance')
      .session(session)
      .lean();
    if (!propertyDoc) {
      await session.commitTransaction();
      return;
    }

    const propertyPool = roundMoney(Number(propertyDoc.remainingCredit || 0));
    const bookedMap = await sumBookedCreditReleaseExpenseByUnitIds([objId], session);
    const bookedOnUnit = roundMoney(bookedMap.get(String(objId)) || 0);

    if (propertyPool > 0 || bookedOnUnit > 0) {
      const drainAmount = roundMoney(Math.max(propertyPool, bookedOnUnit, released));
      await drainLedgerCreditSourcesForRelease(objId, drainAmount, performedBy, session);
    }

    await session.commitTransaction();
  } catch (err) {
    await session.abortTransaction();
    logger.warn('[ensureCreditReleaseExpenseSettledOnPaid] failed:', err.message);
  } finally {
    session.endSession();
  }
}

module.exports = {
  portfolioDisplayBalanceFromSummary,
  computePortfolioCreditBalance,
  computeAvailableCreditBalance,
  buildLedgerCreditDrainUpdates,
  isChronologicalPaymentOutstandingInvoice,
  isOlderOpenInvoice,
  getUnitOutstandingBalance,
  getUnitOutstandingBalanceMap,
  assertBoardRecordPaymentWithinOutstanding,
  assertOwnerOnlinePaymentAllowed,
  planInvoicePaymentAllocation,
  previewInvoicePaymentAllocation,
  markPropertyHasGeneratedInvoices,
  createOpeningBalance,
  applyBalanceAdjustment,
  applyStoredCreditToNewlyDueInvoices,
  applyPropertyRemainingCreditToDueInvoices,
  applyAllUnappliedCreditToDueInvoices,
  processInvoiceOverpayment,
  takeCreditSourceSlices,
  findActiveOverpaymentCreditSources,
  buildSlicedCreditAppliedTransactions,
  recordPayment,
  calculateUnitBalance,
  getBalanceSummary,
  getBalanceSummariesBatch,
  getLedgerEntries,
  softDeleteFutureUnpaidInvoices,
  softDeleteFutureUnpaidInvoicesForDeletedOwner,
  buildUnappliedCreditReleaseExpensePayload,
  createCreditReleaseExpenseInSession,
  drainLedgerCreditSourcesForRelease,
  ensureCreditReleaseExpenseSettledOnPaid,
  expenseDocIsCreditRelease,
  resolveCreditReleaseExpenseBookedAmount,
  applyBookedCreditReleaseOffset,
  resolvePropertyRemainingCreditAfterInvoiceGeneration,
  sumBookedCreditReleaseExpenseByUnitIds,
  computePortfolioWriteOffSettlementAmountUsd,
  settleUnitFinancialsWhenLastOwnerRemoved,
  settleUnitFinancialsForOwnershipBalanceReset,
  waiveOpenDueInvoicesForSettlement,
  computeCollectionStatsFromInvoices,
  resolveInvoiceProcessingAmount,
};
