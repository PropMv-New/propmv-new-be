const os = require('os');
const pathModule = require('path');

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function sanitizeFilePath(filePath) {
  if (!filePath) return null;
  const resolved = pathModule.resolve(String(filePath));
  const allowed = [os.tmpdir(), '/tmp', '/var/folders'];
  if (!allowed.some((dir) => resolved.startsWith(dir))) {
    const err = new Error('Invalid file path');
    err.status = 400;
    throw err;
  }
  return resolved;
}

/**
 * ------------------------------------------------------------------
 * File: invoice.service.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * invoice.controller
 * ------------------------------------------------------------------
 */

// Helper to get lease context for controller hydration
async function getLeaseContextForInvoice(leaseId) {
  if (!leaseId) return null;
  const lease = await Lease.findOne({ _id: leaseId, isDeleted: { $ne: true } })
    .select('property_id unitId unitName leaseTerm rentAndDepositDestribution.split.tenantId rentAndDepositDestribution.split')
    .lean();
  return lease;
}

const Invoice = require('../model/invoice.model');
const Lease = require('../../leasing/model/lease.model');
const mongoose = require('mongoose');
const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
const s3Client = require('../../../../../integrations/s3');
const config = require('../../../../../config/default');
const fs = require('fs').promises;
const { getPagination } = require('../../../../../common/helpers/paginationHelper');
const { INVOICE_STATUS, GROUP_BY, INVOICE_TYPES } = require('../../../../../common/constants/invoice');
const { startOfDay } = require('../../../../../common/helpers/landlordInvoiceStatus.helper');
const { validateLandlordInvoicePayment } = require('../../../../../common/helpers/landlordInvoicePayment.helper');
const { assertPaymentDateOnOrAfterInvoiceGeneration } = require('../../../../../common/helpers/invoicePaymentDate.helper');
const { FREQUENCY_TYPES } = require('../../../../../common/constants/lease');
const Property = require('../../property/model/property.model');
const { findUnitSubdocument } = require('../../../../../common/helpers/propertyUnitReference');
const Event = require('../../../../../shared/modules/events/model/event.model');
const User = require('../../../../../shared/modules/users/models/user.model');
const emailHelper = require('../../../../../common/helpers/emailHelper');
const { buildPaymentReminderPreheader, buildInvoiceEmailPreheader, buildInvoiceUpdatedPreheader } = require('../../../../../common/helpers/emailDisplayHelper');
const { getDefaultFromName } = require('../../../../../common/helpers/communityEmailContext.service');
const {
  findPropertyIdsByCreatedBy,
  buildPropertyOwnerFilter,
  requireCreatedBy,
  resolveCreatedBy,
} = require('../../../../../shared/utils/creatorScope.util');
const { resolveLandlordInvoicePropertyIds, buildLandlordInvoiceDueDateFilter } = require('../../../../../shared/utils/landlordFinanceSummary.util');
const { LEASE_STATUSES } = require('../../../../../common/constants/lease');
const { formatMonthYearInAppTimezone, formatDateInAppTimezone, getDateKeyInTimeZone, parseAppYmd, APP_TIMEZONE, parseDateOnlyToNoonUtc, lastDayOfAppMonth, shiftAppYmdDays, parsePaymentTimestamp } = require('../../../../../common/helpers/hoaBillingDates');
const { ClockService, DateUtil } = require('../../../../../common/date');
// Inline small DB utility helpers (previously in invoiceDb.util.js)
const { runInTransaction } = require('../../../../../common/helpers/transactionHelper');
const logger = require('../../../../../common/logger');
const { StraddlePaymentService } = require('../../../../../shared/modules/payment/service/straddlePayment.service');
const { notify, EVENTS } = require('../../../../../integrations/notification');
const { enqueueOrRunInBackground } = require('../../../../../common/jobs/enqueue');
const { JOB_TYPES } = require('../../../../../common/jobs/constants');
const { buildJobIdempotencyKey } = require('../../../../../common/jobs/idempotency');

const straddlePaymentService = new StraddlePaymentService();

function getBusinessMonthYear(referenceDate = ClockService.now()) {
  const key = DateUtil.toEST(referenceDate);
  const p = parseAppYmd(key);
  if (!p) {
    const fallback = ClockService.now();
    return { month: fallback.getUTCMonth(), year: fallback.getUTCFullYear() };
  }
  return { month: p.m - 1, year: p.y };
}

function isDateInBusinessMonth(value, month, year) {
  const key = getDateKeyInTimeZone(value);
  if (!key) return false;
  const p = parseAppYmd(key);
  return Boolean(p && p.m - 1 === month && p.y === year);
}

/** YYYY-MM-DD calendar key for comparisons in app timezone. */
function calendarKey(value) {
  return getDateKeyInTimeZone(value);
}

function getCurrentAppMonthYear() {
  const { month, year } = getBusinessMonthYear();
  return { currentYear: year, currentMonth1: month + 1 };
}

/** Noon-UTC due date for calendar Y-M-D in app timezone (month is 1-based). */
function appCalendarDueDate(year, month1, day) {
  const clampedDay = Math.min(Math.max(1, Math.floor(Number(day) || 1)), lastDayOfAppMonth(year, month1));
  return parseDateOnlyToNoonUtc(
    `${year}-${String(month1).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`,
  );
}

function getAppWeekdayIndex(value) {
  const date = DateUtil.toUTC(value);
  if (!date) return -1;
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: APP_TIMEZONE, weekday: 'short' }).format(date);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[weekday] ?? -1;
}

function iterAppMonthDayKeys(year, month1) {
  const last = lastDayOfAppMonth(year, month1);
  const keys = [];
  for (let d = 1; d <= last; d += 1) {
    keys.push(`${year}-${String(month1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  return keys;
}

function isCalendarKeyInRange(key, startDate, endDate) {
  const startKey = calendarKey(startDate);
  if (!startKey || !key) return false;
  if (endDate === 'No last date') return key >= startKey;
  const endKey = calendarKey(endDate);
  if (!endKey) return false;
  return key >= startKey && key <= endKey;
}

function isCurrentAppMonthInRange(month1, year, startDate, endDate) {
  const currentMonthStartKey = `${year}-${String(month1).padStart(2, '0')}-01`;
  const startKey = calendarKey(startDate);
  if (!startKey) return false;
  if (endDate === 'No last date') return currentMonthStartKey >= startKey;
  const endKey = calendarKey(endDate);
  if (!endKey) return false;
  return currentMonthStartKey >= startKey && currentMonthStartKey <= endKey;
}

function parseFilterInstant(value, fieldName) {
  const parsed = DateUtil.toUTC(value);
  if (!parsed) throw new Error(`Invalid date format for ${fieldName}`);
  return parsed;
}

function buildExportFilenameTimestamp(referenceDate = ClockService.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(referenceDate);
  const pick = (type) => parts.find((p) => p.type === type)?.value || '00';
  return `${pick('year')}${pick('month')}${pick('day')}_${pick('hour')}${pick('minute')}${pick('second')}`;
}

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

const INVOICE_LIST_SELECT =
  'invoiceId propertyId unitId unit tenants dueDate paidOn status subAmount alreadyPaid balanceDue isPartialPaymentAllowed lease_id type';
const INVOICE_SUMMARY_SELECT = 'status subAmount balanceDue dueDate alreadyPaid paidOn';

/**
 * apply Invoice List Query
 *
 * Performs logic operations for applyInvoiceListQuery.
 *
 * @param query - Request/input argument
 * @returns Operations result
 */
function applyInvoiceListQuery(query) {
  return query
    .select(INVOICE_LIST_SELECT)
    .populate('propertyId', 'name unitDetails')
    .populate('tenants', 'firstName lastName');
}


/**
 * Apply payment excess to other open invoices on the same lease (oldest due date first).
 * Priority: 1) Overdue invoices, 2) Pending/Coming due invoices (only if due date is today), 3) Balance
 */
async function applyLandlordOverpaymentToLeaseInvoices(primaryInvoice, excessAmount, paymentMeta, session) {
  const excess = roundCurrency(excessAmount);
  if (excess <= 0 || !primaryInvoice?.lease_id) {
    return { appliedToOthers: 0, allocations: [], remainingCredit: 0 };
  }

  logger.info('[invoice.service] Applying landlord overpayment to other lease invoices', {
    primaryInvoiceId: String(primaryInvoice._id),
    leaseId: String(primaryInvoice.lease_id),
    excess,
  });

  const startOfToday = startOfDay(ClockService.now());
  const endOfToday = DateUtil.endOfDayEST(ClockService.now());

  // Step 1: Find overdue invoices (past due date with open balance)
  const overdueInvoices = await applySession(
    Invoice.find({
      _id: { $ne: primaryInvoice._id },
      lease_id: primaryInvoice.lease_id,
      isDeleted: { $ne: true },
      balanceDue: { $gt: 0 },
      dueDate: { $lt: startOfToday },
    }).sort({ dueDate: 1 }),
    session
  );

  let remaining = excess;
  const allocations = [];

  // Apply to overdue invoices first
  for (const target of overdueInvoices) {
    if (remaining <= 0) break;
    const balance = roundCurrency(target.balanceDue || 0);
    if (balance <= 0) continue;

    const applied = roundCurrency(Math.min(remaining, balance));
    target.alreadyPaid = roundCurrency(Number(target.alreadyPaid || 0) + applied);
    target.balanceDue = roundCurrency(Math.max(0, balance - applied));
    target.comments = Array.isArray(target.comments) ? target.comments : [];
    target.comments.push({
      text: `Overpayment of $${applied.toFixed(2)} applied from invoice ${primaryInvoice.invoiceId || primaryInvoice._id}.`,
      createdBy: paymentMeta.recordedBy || undefined,
      createdAt: ClockService.now(),
    });

    await target.save(session ? { session } : undefined);
    remaining = roundCurrency(remaining - applied);
    allocations.push({ invoiceId: String(target._id), invoiceNumber: target.invoiceId, applied, type: 'overdue' });
  }

  // Step 2: If still remaining, find pending/coming due invoices that are NOT paid and are due today
  // Only apply to invoices with due date = today (not future invoices)
  if (remaining > 0) {
    const pendingInvoices = await applySession(
      Invoice.find({
        _id: { $ne: primaryInvoice._id },
        lease_id: primaryInvoice.lease_id,
        isDeleted: { $ne: true },
        balanceDue: { $gt: 0 },
        dueDate: { $gte: startOfToday, $lt: endOfToday }, // Due exactly today
      }).sort({ dueDate: 1 }),
      session
    );

    for (const target of pendingInvoices) {
      if (remaining <= 0) break;
      const balance = roundCurrency(target.balanceDue || 0);
      if (balance <= 0) continue;

      const applied = roundCurrency(Math.min(remaining, balance));
      target.alreadyPaid = roundCurrency(Number(target.alreadyPaid || 0) + applied);
      target.balanceDue = roundCurrency(Math.max(0, balance - applied));
      target.comments = Array.isArray(target.comments) ? target.comments : [];
      target.comments.push({
        text: `Overpayment of $${applied.toFixed(2)} applied from invoice ${primaryInvoice.invoiceId || primaryInvoice._id}.`,
        createdBy: paymentMeta.recordedBy || undefined,
        createdAt: ClockService.now(),
      });

      await target.save(session ? { session } : undefined);
      remaining = roundCurrency(remaining - applied);
      allocations.push({ invoiceId: String(target._id), invoiceNumber: target.invoiceId, applied, type: 'pending' });
    }
  }

  // Step 3: If still remaining, add to tenant balance
  const creditTenantId = paymentMeta.paymentUserId
    || (primaryInvoice.tenants && primaryInvoice.tenants[0]);
  if (remaining > 0 && creditTenantId) {
    const tenantId = creditTenantId;
    const tenant = await applySession(User.findById(tenantId), session);

    if (tenant) {
      tenant.balance = roundCurrency((tenant.balance || 0) + remaining);
      await tenant.save(session ? { session } : undefined);
      logger.info('[invoice.service] Added remaining overpayment to tenant balance', {
        tenantId: String(tenantId),
        amount: remaining,
        newBalance: tenant.balance,
      });
      allocations.push({ type: 'balance', tenantId: String(tenantId), applied: remaining });
    }
  }

  return { appliedToOthers: roundCurrency(excess - remaining), allocations, remainingCredit: remaining };
}

async function loadLeaseTenantNameMap(lease, session) {
  const split = lease?.rentAndDepositDestribution?.split || [];
  const tenantIds = split.map((entry) => entry?.tenantId).filter(Boolean);
  if (!tenantIds.length) return {};

  const users = await applySession(
    User.find({ _id: { $in: tenantIds }, isDeleted: { $ne: true } }).select('firstName lastName'),
    session
  ).lean();

  return users.reduce((acc, user) => {
    acc[String(user._id)] = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Tenant';
    return acc;
  }, {});
}

/**
 * Resolve incoming payment patch, enforce partial-payment rules, and distribute overpayments.
 */
async function resolveLandlordPaymentPatch(invoice, patch, session) {
  const currentBalance = roundCurrency(invoice.balanceDue || 0);
  const currentPaid = roundCurrency(invoice.alreadyPaid || 0);

  let paymentAmount = 0;
  if (patch.paymentAmount != null && Number(patch.paymentAmount) > 0) {
    paymentAmount = roundCurrency(patch.paymentAmount);
  } else if (
    Object.prototype.hasOwnProperty.call(patch, 'alreadyPaid')
    && Number(patch.alreadyPaid) > currentPaid
  ) {
    paymentAmount = roundCurrency(Number(patch.alreadyPaid) - currentPaid);
  } else {
    return null;
  }

  const paymentType = patch.paymentType || patch.paymentMethod || 'Other';
  let lease = null;
  let tenantNameById = {};
  if (invoice.lease_id) {
    const safeLeaseId = toObjectId(invoice.lease_id);
    lease = await applySession(
      Lease.findOne({ _id: safeLeaseId, isDeleted: { $ne: true } })
        .select('rentAndDepositDestribution'),
      session
    ).lean();
    tenantNameById = await loadLeaseTenantNameMap(lease, session);
  }

  const validation = validateLandlordInvoicePayment(
    invoice,
    lease,
    paymentAmount,
    patch.paymentUserId,
    tenantNameById
  );
  if (!validation.ok) {
    const err = new Error(validation.message);
    err.status = validation.status || 400;
    throw err;
  }

  const resolvedPaidAt = patch.paidOn != null && patch.paidOn !== ''
    ? parsePaymentTimestamp(patch.paidOn)
    : ClockService.now();
  assertPaymentDateOnOrAfterInvoiceGeneration(resolvedPaidAt, invoice.createdAt);

  const isPartialAttempt = paymentAmount < currentBalance - 0.004;

  logger.info('[invoice.service] Processing landlord invoice payment', {
    invoiceId: String(invoice._id),
    paymentAmount,
    currentBalance,
    isPartialAttempt,
    isOverpayment: paymentAmount > currentBalance + 0.004,
  });

  delete patch.paymentAmount;

  const paymentMeta = {
    recordedBy: patch.updatedBy || invoice.updatedBy || invoice.createdBy,
    method: paymentType,
    paymentUserId: patch.paymentUserId,
  };

  if (paymentAmount > currentBalance + 0.004) {
    const appliedToPrimary = currentBalance;
    const excess = roundCurrency(paymentAmount - appliedToPrimary);
    patch.alreadyPaid = roundCurrency(currentPaid + appliedToPrimary);
    patch.balanceDue = 0;

    invoice.comments = Array.isArray(invoice.comments) ? invoice.comments : [];
    invoice.comments.push({
      text: `Payment received: $${paymentAmount.toFixed(2)}. Applied $${appliedToPrimary.toFixed(2)} to this invoice. Excess amount $${excess.toFixed(2)} will be allocated to other open invoices or added to tenant balance.`,
      createdBy: paymentMeta.recordedBy || undefined,
      createdAt: ClockService.now(),
    });

    const allocation = await applyLandlordOverpaymentToLeaseInvoices(invoice, excess, paymentMeta, session);

    // Add detailed allocation comment to the primary invoice
    if (allocation.allocations.length > 0) {
      const allocationDetails = allocation.allocations.map(alloc => {
        if (alloc.type === 'overdue') {
          return `- $${alloc.applied.toFixed(2)} to overdue invoice ${alloc.invoiceNumber || alloc.invoiceId}`;
        } else if (alloc.type === 'pending') {
          return `- $${alloc.applied.toFixed(2)} to pending invoice ${alloc.invoiceNumber || alloc.invoiceId}`;
        } else if (alloc.type === 'balance') {
          return `- $${alloc.applied.toFixed(2)} added to tenant balance (available for future invoices)`;
        }
        return `- $${alloc.applied.toFixed(2)} applied`;
      }).join('\n');

      invoice.comments.push({
        text: `Overpayment allocation:\n${allocationDetails}`,
        createdBy: paymentMeta.recordedBy || undefined,
        createdAt: ClockService.now(),
      });
    }

    return {
      paymentAmount,
      paymentDelta: appliedToPrimary,
      overpayment: allocation,
      paymentType,
    };
  }

  // ── FIFO chronological redirection ──────────────────────────────────────
  // If the user pays invoice B but invoice A has an earlier due date and is
  // still open, redirect the payment to invoice A first (oldest-first rule).
  // Record structured comments on both invoices so the activity timeline can
  // surface a clear "payment redirected" / "payment received from redirect" entry.
  if (invoice.lease_id) {
    const startOfToday = startOfDay(ClockService.now());
    const earlierOpenInvoices = await applySession(
      Invoice.find({
        _id: { $ne: invoice._id },
        lease_id: invoice.lease_id,
        isDeleted: { $ne: true },
        balanceDue: { $gt: 0 },
        dueDate: { $lt: invoice.dueDate },
      }).sort({ dueDate: 1 }),
      session
    );

    if (earlierOpenInvoices.length > 0) {
      // There are earlier unpaid invoices - redirect the payment to them first.
      let remaining = paymentAmount;
      const redirections = [];

      for (const earlier of earlierOpenInvoices) {
        if (remaining <= 0) break;
        const balance = roundCurrency(earlier.balanceDue || 0);
        if (balance <= 0) continue;
        const applied = roundCurrency(Math.min(remaining, balance));
        earlier.alreadyPaid = roundCurrency(Number(earlier.alreadyPaid || 0) + applied);
        earlier.balanceDue = roundCurrency(Math.max(0, balance - applied));

        // Record a structured comment on the earlier invoice so its activity
        // timeline shows it received funds from a payment on the later invoice.
        earlier.comments = Array.isArray(earlier.comments) ? earlier.comments : [];
        earlier.comments.push({
          text: `FIFO_RECEIVED:${JSON.stringify({
            amount: applied,
            fromInvoiceId: String(invoice._id),
            fromInvoiceNumber: invoice.invoiceId || String(invoice._id),
          })}`,
          createdBy: paymentMeta.recordedBy || undefined,
          createdAt: ClockService.now(),
        });
        await earlier.save(session ? { session } : undefined);

        remaining = roundCurrency(remaining - applied);
        redirections.push({
          invoiceId: String(earlier._id),
          invoiceNumber: earlier.invoiceId || String(earlier._id),
          dueDate: earlier.dueDate ? DateUtil.toISO(earlier.dueDate) : '',
          applied,
        });
      }

      if (redirections.length > 0) {
        // Record a structured comment on the current (later) invoice so its
        // activity timeline shows the payment was redirected.
        const primaryRedirection = redirections[0];
        const totalRedirected = roundCurrency(redirections.reduce((s, r) => s + r.applied, 0));
        const appliedToThisInvoice = roundCurrency(Math.max(0, paymentAmount - totalRedirected));

        invoice.comments = Array.isArray(invoice.comments) ? invoice.comments : [];
        invoice.comments.push({
          text: `FIFO_REDIRECT:${JSON.stringify({
            recordedAmount: paymentAmount,
            redirectedToInvoiceId: primaryRedirection.invoiceId,
            redirectedToInvoiceNumber: primaryRedirection.invoiceNumber,
            redirectedToDueDate: primaryRedirection.dueDate,
            redirectedAmount: totalRedirected,
            appliedToThisInvoice,
          })}`,
          createdBy: paymentMeta.recordedBy || undefined,
          createdAt: ClockService.now(),
        });

        // Apply any remaining amount to this invoice after redirections.
        patch.alreadyPaid = roundCurrency(currentPaid + appliedToThisInvoice);
        patch.balanceDue = roundCurrency(Math.max(0, currentBalance - appliedToThisInvoice));

        return {
          paymentAmount,
          paymentDelta: appliedToThisInvoice,
          overpayment: null,
          paymentType,
          fifoRedirections: redirections,
          mode: 'chronological',
          appliedToPrimary: appliedToThisInvoice,
          appliedToOtherInvoices: redirections.map((r) => ({
            invoiceId: r.invoiceId,
            invoiceNumber: r.invoiceNumber,
            amount: r.applied,
          })),
        };
      }
    }
  }
  // ── end FIFO redirection ─────────────────────────────────────────────────

  patch.alreadyPaid = roundCurrency(currentPaid + paymentAmount);
  patch.balanceDue = roundCurrency(Math.max(0, currentBalance - paymentAmount));
  return { paymentAmount, paymentDelta: paymentAmount, overpayment: null, paymentType };
}

/**
 * apply Session
 *
 * Performs logic operations for applySession.
 *
 * @param query - Request/input argument
 * @param session - Request/input argument
 * @returns Operations result
 */
function applySession(query, session) {
  if (session && query && typeof query.session === 'function') {
    return query.session(session);
  }
  return query;
}

/**
 * with Session
 *
 * Performs logic operations for withSession.
 *
 * @param options - Request/input argument
 * @param session - Request/input argument
 * @returns Operations result
 */
function withSession(options = {}, session) {
  if (!session) return options;
  return { ...options, session };
}

async function withInvoiceTransaction(fn, options = {}) {
  if (options.session) {
    return fn(options.session);
  }
  return runInTransaction(fn);
}

/**
 * NotFoundError
 *
 * Represents the Not Found Error controller/model class.
 */
class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

/**
 * create Bad Request Error
 *
 * Performs logic operations for createBadRequestError.
 *
 * @param message - Request/input argument
 * @returns Operations result
 */
function createBadRequestError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/**
 * normalize Invoice Payment Aliases
 *
 * Performs logic operations for normalizeInvoicePaymentAliases.
 *
 * @param target - Request/input argument
 * @returns Operations result
 */
function normalizeInvoicePaymentAliases(target = {}) {
  if (!target || typeof target !== 'object') return target;
  if (!target.paymentType && target.paymentMethod) {
    target.paymentType = target.paymentMethod;
  }
  if (!target.paymentMethod && target.paymentType) {
    target.paymentMethod = target.paymentType;
  }
  return target;
}

/**
 * to Tenant Id Array
 *
 * Performs logic operations for toTenantIdArray.
 *
 * @param list - Request/input argument
 * @returns Operations result
 */
function toTenantIdArray(list) {
  return Array.isArray(list) ? list.filter(Boolean) : [];
}

/**
 * normalize Tenant Ref Id
 *
 * Performs logic operations for normalizeTenantRefId.
 *
 * @param ref - Request/input argument
 * @returns Operations result
 */
function normalizeTenantRefId(ref) {
  if (ref == null) return null;
  if (typeof ref === 'object') {
    if (ref._id != null) return ref._id;
    if (ref.id != null) return ref.id;
  }
  return ref;
}

/**
 * get Tenant Ids From Lease Context
 *
 * Performs logic operations for getTenantIdsFromLeaseContext.
 *
 * @param lease - Request/input argument
 * @returns Operations result
 */
function getTenantIdsFromLeaseContext(lease) {
  if (!Array.isArray(lease?.rentAndDepositDestribution?.split)) {
    return [];
  }

  return lease.rentAndDepositDestribution.split
    .map((split) => normalizeTenantRefId(split && split.tenantId))
    .filter(Boolean);
}

async function loadInvoiceLeaseContext(leaseId, session) {
  if (!leaseId) return null;

  const lease = await applySession(
    Lease.findOne({ _id: leaseId, isDeleted: { $ne: true } }).select(
      'property_id unitId unitName leaseTerm rentAndDepositDestribution.split.tenantId'
    ),
    session
  ).lean();

  if (!lease) {
    throw new NotFoundError('Lease not found');
  }

  return lease;
}

async function loadInvoicePropertyContext(propertyId, session) {
  if (!propertyId) return null;

  const property = await applySession(
    Property.findOne({ _id: propertyId, isDeleted: { $ne: true } }).select('name unitDetails'),
    session
  ).lean();

  if (!property) {
    throw new NotFoundError('Property not found');
  }

  return property;
}

async function normalizeInvoicePersistenceTarget(target, session, options = {}) {

  const currentInvoice = options.currentInvoice || null;
  // Accept both leaseId and lease_id from payload
  const effectiveLeaseId = target.lease_id || target.leaseId || currentInvoice?.lease_id || currentInvoice?.leaseId || null;
  let lease = null;

  // If leaseId is provided, always hydrate propertyId/unit/unitId/term/tenants from lease context if missing or empty
  if (effectiveLeaseId) {
    lease = await loadInvoiceLeaseContext(effectiveLeaseId, session);
    // Fill missing or empty fields from lease context
    if (!target.propertyId || (typeof target.propertyId === 'string' && !target.propertyId.trim())) {
      if (lease?.property_id) target.propertyId = lease.property_id;
    }
    if (!target.term || (typeof target.term === 'string' && !target.term.trim())) {
      if (lease?.leaseTerm) target.term = lease.leaseTerm;
    }
    if (!target.unitId || (typeof target.unitId === 'string' && !target.unitId.toString().trim())) {
      if (lease?.unitId) target.unitId = lease.unitId;
    }
    if (!target.unit || (typeof target.unit === 'string' && !target.unit.trim())) {
      if (lease?.unitName) target.unit = lease.unitName;
    }
    const leaseTenantIds = getTenantIdsFromLeaseContext(lease);
    if ((!Array.isArray(target.tenants) || target.tenants.length === 0) && leaseTenantIds.length > 0) {
      target.tenants = leaseTenantIds;
    }
  }

  // Fallbacks from currentInvoice if still missing
  if (!target.propertyId && currentInvoice?.propertyId) {
    target.propertyId = currentInvoice.propertyId;
  }
  if (!target.term && currentInvoice?.term) {
    target.term = currentInvoice.term;
  }
  if (!target.unitId && currentInvoice?.unitId) {
    target.unitId = currentInvoice.unitId;
  }
  if (!target.unit && currentInvoice?.unit) {
    target.unit = currentInvoice.unit;
  }

  const currentTenantIds = toTenantIdArray(currentInvoice?.tenants);
  const leaseTenantIds = getTenantIdsFromLeaseContext(lease);
  if (!Array.isArray(target.tenants) || target.tenants.length === 0) {
    if (currentTenantIds.length > 0) {
      target.tenants = currentTenantIds;
    } else if (leaseTenantIds.length > 0) {
      target.tenants = leaseTenantIds;
    }
  }

  if (!target.propertyId) {
    logger.error('[INVOICE ERROR] propertyId is missing after hydration. Payload:', target);
    if (options.requireProperty) {
      throw createBadRequestError('propertyId is required');
    }
    return { lease, property: null };
  }

  const property = await loadInvoicePropertyContext(target.propertyId, session);
  target.propertyName = property.name || '';


  // If unitId or unit is present, validate and resolve
  if (target.unitId || target.unit) {
    const resolvedUnit = findUnitSubdocument(property.unitDetails, {
      unitId: target.unitId,
      unitName: target.unit,
    });
    if (!resolvedUnit) {
      logger.error('[INVOICE ERROR] Unit not found on property. propertyId:', target.propertyId, 'unitId:', target.unitId, 'unit:', target.unit);
      throw createBadRequestError(
        target.unitId
          ? 'unitId does not match any unit on this property'
          : `unit '${target.unit || ''}' not found on property`
      );
    }
    target.unitId = resolvedUnit._id;
    target.unit = resolvedUnit.unitName || '';
  } else if (lease?.unitId && lease?.unitName) {
    // If still missing, but lease context has unit info, fill it
    const resolvedUnit = findUnitSubdocument(property.unitDetails, {
      unitId: lease.unitId,
      unitName: lease.unitName,
    });
    if (resolvedUnit) {
      target.unitId = resolvedUnit._id;
      target.unit = resolvedUnit.unitName || '';
    } else {
      logger.error('[INVOICE ERROR] Unit from lease context not found on property. propertyId:', target.propertyId, 'lease.unitId:', lease.unitId, 'lease.unitName:', lease.unitName);
      throw createBadRequestError('Unit from lease context not found on property');
    }
  } else {
    logger.error('[INVOICE ERROR] unit is missing after hydration. Payload:', target);
    throw createBadRequestError('unit is required');
  }

  return { lease, property };
}

/**
 * Upload invoice document files to S3 and clean up temp files
 * @param {Array} files - Array of multer file objects
 * @returns {Array} - Array of uploaded document metadata
 */
const uploadFilesToS3 = async (files, userId = null) => {
  if (!files || files.length === 0) return [];

  const uploadedDocs = [];

  for (const file of files) {
    try {
      const filename = file.originalname || file.filename || `invoice-${ClockService.nowEpoch()}`;
      const contentType = file.mimetype || 'application/octet-stream';
      const s3Key = s3Client.getKey
        ? s3Client.getKey('invoice', filename, userId)
        : `invoice-documents/${ClockService.nowEpoch()}-${filename}`;

      const safeFilePath = sanitizeFilePath(file.path);
      const s3Result = await s3Client.upload({
        localFilePath: safeFilePath,
        key: s3Key,
        contentType,
      });

      const fileUrl = s3Result.Location
        || `https://${s3Client.bucket || process.env.S3_BUCKET}.s3.${s3Client.region || process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${s3Result.Key}`;

      uploadedDocs.push({
        filename: file.filename,
        originalName: file.originalname,
        key: s3Result.Key,
        url: fileUrl,
        size: file.size,
        mimetype: contentType,
      });
    } catch (uploadErr) {
      try {
        if (file.path) { try { await fs.unlink(sanitizeFilePath(file.path)); } catch (_) { } }
      } catch (cleanupErr) {
        // Ignore cleanup errors
      }
      const err = new Error(`Failed to upload file ${file.originalname}: ${uploadErr.message}`);
      err.status = uploadErr.status || 502;
      err.code = uploadErr.code;
      throw err;
    }
  }

  return uploadedDocs;
};

/**
 * Create events for invoice tenants
 * @param {Object} invoice - Saved invoice document
 */
const createInvoiceEvents = async (invoice, session = null) => {
  try {
    const safePropId = toObjectId(invoice.propertyId);
    const property = await applySession(
      Property.findOne({ _id: safePropId, isDeleted: { $ne: true } }),
      session
    ).lean();
    const propertyOwnerId = resolveCreatedBy(property);

    if (propertyOwnerId && invoice.tenants && invoice.tenants.length > 0) {
      const eventTitle = `${invoice.type} Invoice Generated`;
      const eventPropertyId = invoice.propertyId && invoice.propertyId._id
        ? invoice.propertyId._id
        : invoice.propertyId;
      const eventUnit = String(invoice.unit || '').trim();

      for (const tenantId of invoice.tenants) {
        const eventDoc = {
          event: eventTitle,
          from: propertyOwnerId,
          to: tenantId,
          notificationDate: ClockService.now(),
          propertyId: eventPropertyId,
          unit: eventUnit,
        };
        if (session) {
          await Event.create([eventDoc], { session });
        } else {
          await Event.create(eventDoc);
        }
      }
    }
  } catch (eventErr) {
    logger.error('Failed to create events:', eventErr);
    throw eventErr;
  }
};

/**
 * Send invoice email to all tenants for a given invoice document
 * Uses the `invoice-template.html` template (template name: 'invoice-template')
 * @param {Object} invoice - saved invoice document
 */
const sendInvoiceEmails = async (invoice) => {
  try {
    if (!invoice) return;

    logger.info('[invoice.service] sendInvoiceEmails:start', {
      invoiceId: String(invoice._id || ''),
      tenantCount: Array.isArray(invoice.tenants) ? invoice.tenants.length : 0,
    });

    // fetch related data for template
    const property = await Property.findOne({ _id: invoice.propertyId, isDeleted: { $ne: true } }).lean();
    const lease = invoice.lease_id ? await Lease.findOne({ _id: invoice.lease_id, isDeleted: { $ne: true } }) : null;

    // Resolve tenant ids from invoice or lease split when missing on legacy invoices.
    let tenantIds = Array.isArray(invoice.tenants) ? invoice.tenants.filter(Boolean) : [];
    if (tenantIds.length === 0 && lease) {
      tenantIds = getTenantIdsFromLeaseContext(lease);
      logger.info('[invoice.service] sendInvoiceEmails:resolved-tenants-from-lease', {
        invoiceId: String(invoice._id || ''),
        tenantCount: tenantIds.length,
      });
    }

    const tenants =
      tenantIds.length > 0
        ? await User.find({
          _id: { $in: tenantIds },
          isDeleted: { $ne: true },
          email: { $exists: true, $nin: [null, ''] },
        })
          .select('email firstName lastName')
          .lean()
        : [];

    if (tenants.length === 0) {
      logger.warn('[invoice.service] sendInvoiceEmails:no-tenant-emails', {
        invoiceId: String(invoice._id || ''),
      });
      return;
    }

    const landlordName = property ? String(resolveCreatedBy(property) || '') : '';

    // Build invoice line items for template
    const invoiceLines = (invoice.invoiceItemDetails || []).map(item => ({
      description: item.description || item.invoiceItem || '',
      period: item.period || (invoice.dueDate ? formatDateInAppTimezone(invoice.dueDate) : ''),
      amount: typeof item.amount === 'number' ? `$${item.amount.toFixed(2)}` : String(item.amount || '')
    }));

    // Basic formatted values
    const amountDue = typeof invoice.balanceDue === 'number' ? `$${invoice.balanceDue.toFixed(2)}` : String(invoice.balanceDue || '');
    const subTotal = typeof invoice.subAmount === 'number' ? `$${invoice.subAmount.toFixed(2)}` : String(invoice.subAmount || '');
    const adjustments = typeof (invoice.subAmount - invoice.balanceDue) === 'number' ? `$${(invoice.subAmount - invoice.balanceDue).toFixed(2)}` : '';
    const dueDate = invoice.dueDate ? formatDateInAppTimezone(invoice.dueDate) : '';

    // Build invoice URL - fallback to FRONTEND_BASE_URL if not provided
    const invoiceBase = process.env.INVOICE_BASE_URL || process.env.FRONTEND_BASE_URL || 'https://app.example.com';
    const safeInvoiceRef = String(invoice.invoiceId || '').trim();
    const invoiceUrl = safeInvoiceRef
      ? `${String(invoiceBase).replace(/\/\/$/, '')}/invoices/${encodeURIComponent(safeInvoiceRef)}`
      : `${String(invoiceBase).replace(/\/\/$/, '')}/invoices`;

    for (const t of tenants) {
      const payerName = `${t.firstName || ''} ${t.lastName || ''}`.trim() || 'Member';
      const data = {
        invoiceNumber: safeInvoiceRef || 'Pending Invoice',
        billingPeriod: invoice.dueDate ? formatMonthYearInAppTimezone(invoice.dueDate) : '',
        amountDue,
        dueDate,
        invoiceUrl,
        payerName,
        tenantName: payerName,
        tenantEmail: t.email,
        propertyAddress: property ? (property.address || property.name || '') : '',
        leaseId: '',
        leaseStart: lease ? (lease.start_date ? formatDateInAppTimezone(lease.start_date) : '') : '',
        leaseEnd: lease ? (lease.end_date ? formatDateInAppTimezone(lease.end_date) : '') : '',
        billedByName: landlordName,
        landlordName: landlordName,
        invoiceLines,
        subTotal,
        adjustments
      };

      try {
        await emailHelper.sendEmail('invoice', t.email, data, {
          template: 'invoice-template',
          subject: `Invoice #${safeInvoiceRef || 'pending'} - ${getDefaultFromName()}`,
          preheaderText: buildInvoiceEmailPreheader({
            invoiceNumber: safeInvoiceRef || 'Pending Invoice',
            outstandingBalance: amountDue,
            dueDate,
          }),
        });
        logger.info('[invoice.service] sendInvoiceEmails:sent', {
          invoiceId: String(invoice._id || ''),
          tenantEmail: t.email,
        });
      } catch (mailErr) {
        logger.error('[invoice.service] sendInvoiceEmails:failed', {
          invoiceId: String(invoice._id || ''),
          tenantEmail: t.email,
          error: mailErr.message,
        });
      }
    }
  } catch (err) {
    logger.error('[invoice.service] sendInvoiceEmails:error', { error: err.message });
  }
};

/**
 * Notify the tenant who received a recorded payment (runs asynchronously).
 */
function notifyPaymentRecordedInBackground(invoiceDoc, paymentEntry) {
  if (!invoiceDoc || !paymentEntry) return;

  const invoiceId = String(invoiceDoc._id);
  const tenantUserId = paymentEntry.userId;
  enqueueOrRunInBackground({
    jobType: JOB_TYPES.NOTIFY_IN_APP,
    entityType: 'Invoice',
    entityId: invoiceId,
    recipientId: tenantUserId || '',
    eventId: String(paymentEntry._id || paymentEntry.paidAt || paymentEntry.paymentAmount || ''),
    idempotencyKey: buildJobIdempotencyKey(
      'NOTIFY_PAYMENT_RECEIVED_LANDLORD',
      invoiceId,
      tenantUserId,
      paymentEntry._id || paymentEntry.paymentAmount,
      paymentEntry.paidAt
    ),
    payload: {
      handler: 'landlord_payment_received',
      invoiceId,
      tenantUserId: tenantUserId ? String(tenantUserId) : '',
      amount: paymentEntry.paymentAmount,
      unitName: invoiceDoc.unit || invoiceDoc.unitName || 'Unit',
      invoiceNumber: invoiceDoc.invoiceId || null,
    },
    run: async () => {
      if (!tenantUserId) return;
      const amount =
        typeof paymentEntry.paymentAmount === 'number'
          ? paymentEntry.paymentAmount.toFixed(2)
          : String(paymentEntry.paymentAmount || '0');
      await notify(
        EVENTS.PAYMENT_RECEIVED,
        { amount, unitName: invoiceDoc.unit || invoiceDoc.unitName || 'Unit' },
        String(tenantUserId),
        {
          invoiceId,
          invoiceNumber: invoiceDoc.invoiceId || null,
          paymentAmount: paymentEntry.paymentAmount,
        }
      );
    },
  });
}

/**
 * Notify all linked invoice members (tenants + property landlord/manager) after an invoice update.
 * Runs asynchronously so API responses stay fast.
 */
async function sendLandlordInvoiceUpdatedEmails(invoiceId) {
  if (!invoiceId) return { sent: 0 };

  try {
    logger.info('[invoice.service] notifyInvoiceUpdated:start', { invoiceId: String(invoiceId) });

      const invoice = await Invoice.findOne({ _id: invoiceId, isDeleted: { $ne: true } })
        .populate('tenants', 'firstName lastName email')
        .lean();
      if (!invoice) {
        logger.warn('[invoice.service] notifyInvoiceUpdated:invoice-not-found', { invoiceId: String(invoiceId) });
        return;
      }

      const property = invoice.propertyId
        ? await Property.findOne({ _id: invoice.propertyId, isDeleted: { $ne: true } })
          .select('name address landlord_id createdBy')
          .lean()
        : null;

      const lease = invoice.lease_id
        ? await Lease.findOne({ _id: invoice.lease_id, isDeleted: { $ne: true } }).lean()
        : null;

      let tenantIds = Array.isArray(invoice.tenants)
        ? invoice.tenants.map((t) => (t && t._id ? t._id : t)).filter(Boolean)
        : [];
      if (tenantIds.length === 0 && lease) {
        tenantIds = getTenantIdsFromLeaseContext(lease);
      }

      const tenantUsers =
        tenantIds.length > 0
          ? await User.find({
            _id: { $in: tenantIds },
            isDeleted: { $ne: true },
            email: { $exists: true, $nin: [null, ''] },
          })
            .select('email firstName lastName')
            .lean()
          : Array.isArray(invoice.tenants)
            ? invoice.tenants.filter((t) => t && t.email)
            : [];

      const landlordId = property?.landlord_id || property?.createdBy;
      const landlordUser = landlordId
        ? await User.findOne({ _id: landlordId, isDeleted: { $ne: true } })
          .select('email firstName lastName')
          .lean()
        : null;

      const recipientsByEmail = new Map();
      for (const tenant of tenantUsers) {
        if (!tenant?.email) continue;
        recipientsByEmail.set(String(tenant.email).trim().toLowerCase(), tenant);
      }
      if (landlordUser?.email) {
        recipientsByEmail.set(String(landlordUser.email).trim().toLowerCase(), landlordUser);
      }

      if (recipientsByEmail.size === 0) {
        logger.warn('[invoice.service] notifyInvoiceUpdated:no-recipients', { invoiceId: String(invoiceId) });
        return;
      }

      const invoiceLines = (invoice.invoiceItemDetails || []).map((item) => ({
        description: item.description || item.invoiceItem || '',
        period: item.period || (invoice.dueDate ? formatDateInAppTimezone(invoice.dueDate) : ''),
        amount: typeof item.amount === 'number' ? `$${item.amount.toFixed(2)}` : String(item.amount || ''),
      }));

      const amountDue =
        typeof invoice.balanceDue === 'number'
          ? `$${invoice.balanceDue.toFixed(2)}`
          : String(invoice.balanceDue || '');
      const subTotal =
        typeof invoice.subAmount === 'number'
          ? `$${invoice.subAmount.toFixed(2)}`
          : String(invoice.subAmount || '');
      const dueDate = invoice.dueDate ? formatDateInAppTimezone(invoice.dueDate) : '';
      const invoiceBase = process.env.INVOICE_BASE_URL || process.env.FRONTEND_BASE_URL || 'https://app.example.com';
      const safeInvoiceRef = String(invoice.invoiceId || '').trim();
      const invoiceUrl = safeInvoiceRef
        ? `${String(invoiceBase).replace(/\/$/, '')}/invoices/${encodeURIComponent(safeInvoiceRef)}`
        : `${String(invoiceBase).replace(/\/$/, '')}/invoices`;
      const landlordName = property ? String(resolveCreatedBy(property) || '') : '';

      for (const recipient of recipientsByEmail.values()) {
        const payerName = `${recipient.firstName || ''} ${recipient.lastName || ''}`.trim() || 'Member';
        const data = {
          invoiceNumber: safeInvoiceRef || 'Pending Invoice',
          billingPeriod: invoice.dueDate ? formatMonthYearInAppTimezone(invoice.dueDate) : '',
          amountDue,
          dueDate,
          invoiceUrl,
          payerName,
          tenantName: payerName,
          tenantEmail: recipient.email,
          propertyAddress: property ? property.address || property.name || '' : '',
          leaseId: '',
          leaseStart: lease?.start_date ? formatDateInAppTimezone(lease.start_date) : '',
          leaseEnd: lease?.end_date ? formatDateInAppTimezone(lease.end_date) : '',
          billedByName: landlordName,
          landlordName,
          invoiceLines,
          subTotal,
          adjustments: '',
        };

        try {
          await emailHelper.sendEmail('invoice-updated', recipient.email, data, {
            template: 'invoice-template',
            subject: `Invoice updated${safeInvoiceRef ? ` #${safeInvoiceRef}` : ''} - ${getDefaultFromName()}`,
            preheaderText: buildInvoiceUpdatedPreheader({
              invoiceNumber: safeInvoiceRef || 'Pending Invoice',
              amountDue,
              dueDate,
            }),
          });
          logger.info('[invoice.service] notifyInvoiceUpdated:sent', {
            invoiceId: String(invoiceId),
            recipientEmail: recipient.email,
          });
        } catch (mailErr) {
          logger.error('[invoice.service] notifyInvoiceUpdated:failed', {
            invoiceId: String(invoiceId),
            recipientEmail: recipient.email,
            error: mailErr.message,
          });
        }
      }

      logger.info('[invoice.service] notifyInvoiceUpdated:complete', {
        invoiceId: String(invoiceId),
        recipientCount: recipientsByEmail.size,
      });
      return { sent: recipientsByEmail.size };
    } catch (err) {
      logger.error('[invoice.service] notifyInvoiceUpdated:error', {
        invoiceId: String(invoiceId),
        error: err.message,
      });
      throw err;
    }
}

function notifyInvoiceUpdatedInBackground(invoiceId, eventSuffix = '') {
  if (!invoiceId) return;
  enqueueOrRunInBackground({
    jobType: JOB_TYPES.EMAIL_LANDLORD_INVOICE_UPDATED,
    entityType: 'Invoice',
    entityId: invoiceId,
    eventId: eventSuffix,
    idempotencyKey: buildJobIdempotencyKey('EMAIL_LANDLORD_INVOICE_UPDATED', invoiceId, eventSuffix),
    payload: { invoiceId: String(invoiceId) },
    run: () => sendLandlordInvoiceUpdatedEmails(invoiceId),
  });
}

const resolveUnitNameFromInvoiceDoc = (invoiceDoc) => {
  if (!invoiceDoc) return '';
  const storedUnit = invoiceDoc.unit || '';
  const property = invoiceDoc.propertyId;
  const details = property && Array.isArray(property.unitDetails) ? property.unitDetails : [];
  const safeUnitId = toObjectId(invoiceDoc.unitId);
  if (safeUnitId) {
    const sub = details.find((u) => u && u._id && String(u._id) === String(safeUnitId));
    if (sub && sub.unitName) return sub.unitName;
  }
  return storedUnit;
};

/** Map populated paymentHistory entries to the shape expected by the landlord invoice UI. */
function mapPaymentHistoryToPayments(paymentHistory) {
  if (!Array.isArray(paymentHistory)) return [];
  return paymentHistory.map((entry) => {
    const user = entry.userId;
    const payerName =
      user && typeof user === 'object'
        ? `${user.firstName || ''} ${user.lastName || ''}`.trim()
        : '';
    const paymentDate = entry.paymentDate ? DateUtil.toUTC(entry.paymentDate) : null;
    const recordedAt = entry.recordedAt ? DateUtil.toUTC(entry.recordedAt) : null;
    return {
      payer: payerName || 'Tenant',
      submittedOn: paymentDate ? DateUtil.toISO(paymentDate) : '',
      depositedOn: recordedAt ? DateUtil.toISO(recordedAt) : null,
      method: entry.paymentType || '',
      amount: entry.paymentAmount || 0,
    };
  });
}

/** Last payment date wins when partial payments are recorded (multiple paymentHistory rows). */
function resolveLastPaidOn(invoiceDoc) {
  if (!invoiceDoc) return undefined;
  if (invoiceDoc.paidOn) return invoiceDoc.paidOn;

  const history = invoiceDoc.paymentHistory;
  if (!Array.isArray(history) || history.length === 0) return undefined;

  let latest = null;
  history.forEach((entry) => {
    if (!entry?.paymentDate) return;
    const d = DateUtil.toUTC(entry.paymentDate);
    if (!d) return;
    if (!latest || d > latest) latest = d;
  });
  return latest || undefined;
}

/**
 * map Tenant Summary From Invoice
 *
 * Performs logic operations for mapTenantSummaryFromInvoice.
 *
 * @param inv - Request/input argument
 * @returns Operations result
 */
function mapTenantSummaryFromInvoice(inv) {
  if (!Array.isArray(inv?.tenants) || inv.tenants.length === 0) return [];
  return inv.tenants
    .map((t) => {
      if (!t) return null;
      if (typeof t === 'string' || typeof t === 'number') {
        return { _id: String(t), firstName: '', lastName: '', name: '' };
      }
      if (typeof t === 'object') {
        const id = t._id || t.id;
        if (!id) return null;
        const name = `${t.firstName || ''} ${t.lastName || ''}`.trim() || t.name || '';
        return {
          _id: id,
          firstName: t.firstName,
          lastName: t.lastName,
          name,
        };
      }
      return null;
    })
    .filter((t) => t && t._id);
}

/**
 * build Property Shared By
 *
 * Performs logic operations for buildPropertySharedBy.
 *
 * @param inv - Request/input argument
 * @returns Operations result
 */
function buildPropertySharedBy(inv) {
  const propertyName = inv.propertyId?.name || '';
  const tenantNames = (inv.tenants || [])
    .map((t) => `${t.firstName || ''} ${t.lastName || ''}`.trim())
    .filter(Boolean)
    .join(', ');
  return tenantNames ? `${propertyName} - ${tenantNames}` : propertyName;
}

const {
  aggregateFinanceSummary,
  normalizeDashboardBucket,
  resolveDashboardBucketStatusFilter,
} = require('../../../../../shared/utils/invoiceFinanceBuckets');

/** Aggregate summary totals aligned with dashboard finance stats. */
function computeLandlordSummaryFromInvoices(invoices) {
  return aggregateFinanceSummary(invoices);
}

/**
 * build List Meta
 *
 * Performs logic operations for buildListMeta.
 *
 * @param total - Request/input argument
 * @param page - Request/input argument
 * @param limit - Request/input argument
 * @returns Operations result
 */
function buildListMeta(total, page, limit) {
  const pageSize = limit || 0;
  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  return { total, page, pageSize, totalPages };
}

/**
 * user Display Name
 *
 * Performs logic operations for userDisplayName.
 *
 * @param userRef - Request/input argument
 * @returns Operations result
 */
function userDisplayName(userRef) {
  if (!userRef) return 'System';
  if (typeof userRef === 'string') return userRef;
  const first = userRef.firstName || '';
  const last = userRef.lastName || '';
  const name = `${first} ${last}`.trim();
  return name || userRef.email || 'User';
}

/**
 * Build HOA-compatible activity timeline for landlord invoice detail views.
 * Uses comments, payment history, and document uploads already stored on the invoice.
 */
function buildLandlordActivityTimeline(plain) {
  const timeline = [];

  if (plain.createdAt) {
    timeline.push({
      kind: 'created',
      at: DateUtil.toISO(plain.createdAt),
      createdBy: userDisplayName(plain.createdBy),
    });
  }

  for (const tx of plain.paymentHistory || []) {
    const paidAt = tx.paymentDate || tx.recordedAt || tx.paidAt;
    if (!paidAt) continue;
    timeline.push({
      kind: 'payment',
      at: DateUtil.toISO(tx.recordedAt || paidAt),
      paidOn: DateUtil.toISO(paidAt),
      amount: Number(tx.paymentAmount || tx.amount || 0),
      method: tx.paymentType || tx.method || '',
      note: tx.notes || tx.note || '',
      checkNumber: tx.checkNumber || undefined,
      moneyOrderNumber: tx.moneyOrderNumber || undefined,
      recordedBy: userDisplayName(tx.recordedBy),
      paidBy: userDisplayName(tx.userId),
    });
  }

  // Emit FIFO-redirection entries from comments so the activity timeline
  // clearly shows when a payment made to this invoice was redirected to an
  // earlier-due invoice (or vice-versa - when this invoice received funds
  // from a payment originally recorded against a later invoice).
  const FIFO_REDIRECT_PREFIX = 'FIFO_REDIRECT:';
  const FIFO_RECEIVED_PREFIX = 'FIFO_RECEIVED:';

  for (const c of plain.comments || []) {
    if (!c.createdAt) continue;
    const text = String(c.text || '');

    if (text.startsWith(FIFO_REDIRECT_PREFIX)) {
      // Payment recorded on this invoice was redirected to an earlier invoice.
      try {
        const payload = JSON.parse(text.slice(FIFO_REDIRECT_PREFIX.length));
        timeline.push({
          kind: 'payment_redirected',
          at: DateUtil.toISO(c.createdAt),
          recordedAmount: Number(payload.recordedAmount || 0),
          redirectedToInvoiceId: payload.redirectedToInvoiceId || '',
          redirectedToInvoiceNumber: payload.redirectedToInvoiceNumber || '',
          redirectedToDueDate: payload.redirectedToDueDate || '',
          redirectedAmount: Number(payload.redirectedAmount || 0),
          appliedToThisInvoice: Number(payload.appliedToThisInvoice || 0),
          author: userDisplayName(c.createdBy),
          detail: `$${Number(payload.recordedAmount || 0).toFixed(2)} was recorded against this invoice, but $${Number(payload.redirectedAmount || 0).toFixed(2)} was applied to Invoice ${payload.redirectedToInvoiceNumber || payload.redirectedToInvoiceId} (due ${payload.redirectedToDueDate || 'earlier'}).`,
        });
      } catch (_) {
        // Fallback: treat as a plain note
        timeline.push({ kind: 'note', at: DateUtil.toISO(c.createdAt), text, author: userDisplayName(c.createdBy) });
      }
      continue;
    }

    if (text.startsWith(FIFO_RECEIVED_PREFIX)) {
      // This invoice received funds from a payment recorded against a later invoice.
      try {
        const payload = JSON.parse(text.slice(FIFO_RECEIVED_PREFIX.length));
        timeline.push({
          kind: 'payment_received_from_redirect',
          at: DateUtil.toISO(c.createdAt),
          amount: Number(payload.amount || 0),
          fromInvoiceId: payload.fromInvoiceId || '',
          fromInvoiceNumber: payload.fromInvoiceNumber || '',
          author: userDisplayName(c.createdBy),
          detail: `$${Number(payload.amount || 0).toFixed(2)} was applied to this invoice from a payment recorded against Invoice ${payload.fromInvoiceNumber || payload.fromInvoiceId} (which had a later due date). This invoice had an earlier due date and was unpaid.`,
        });
      } catch (_) {
        timeline.push({ kind: 'note', at: DateUtil.toISO(c.createdAt), text, author: userDisplayName(c.createdBy) });
      }
      continue;
    }

    if (text.includes('Payment reminder sent')) {
      timeline.push({
        kind: 'reminder',
        at: DateUtil.toISO(c.createdAt),
        legacy: true,
        detail: text,
        sentBy: userDisplayName(c.createdBy),
      });
      continue;
    }
    timeline.push({
      kind: 'note',
      at: DateUtil.toISO(c.createdAt),
      text,
      author: userDisplayName(c.createdBy),
    });
  }

  for (const doc of plain.documents || []) {
    const uploadedAt = doc.uploadedAt || doc.createdAt;
    if (!uploadedAt) continue;
    const meta = doc.metadataId && typeof doc.metadataId === 'object' ? doc.metadataId : null;
    timeline.push({
      kind: 'attachment',
      at: DateUtil.toISO(uploadedAt),
      fileName: meta?.originalName || doc.originalName || 'Attachment',
      uploadedBy: userDisplayName(doc.uploadedBy || plain.updatedBy),
    });
  }

  timeline.sort((a, b) => (DateUtil.toEpoch(b.at) ?? 0) - (DateUtil.toEpoch(a.at) ?? 0));
  logger.info('[invoice.service] buildLandlordActivityTimeline entries:', timeline.length);
  return timeline;
}

const toInvoiceResponse = (invoiceDoc) => {
  if (!invoiceDoc) return invoiceDoc;
  const plain = typeof invoiceDoc.toObject === 'function' ? invoiceDoc.toObject() : { ...invoiceDoc };
  const derivedUnit = resolveUnitNameFromInvoiceDoc(invoiceDoc);
  const propertyName =
    (invoiceDoc.propertyId && typeof invoiceDoc.propertyId === 'object' && invoiceDoc.propertyId.name) ||
    plain.propertyName ||
    '';

  // Extract tenant balance if tenants are populated
  let tenantBalance = 0;
  if (Array.isArray(plain.tenants) && plain.tenants.length > 0) {
    const firstTenant = plain.tenants[0];
    if (firstTenant && typeof firstTenant === 'object' && 'balance' in firstTenant) {
      tenantBalance = firstTenant.balance || 0;
    }
  }

  return {
    ...plain,
    propertyName,
    unit: derivedUnit || plain.unit || '',
    paidOn: resolveLastPaidOn(invoiceDoc) || plain.paidOn,
    remindersSent: plain.remindersSent || 0,
    reminders: plain.remindersSent || 0,
    payments: mapPaymentHistoryToPayments(plain.paymentHistory),
    tenantBalance,
  };
};

async function attachLeasePaymentSettings(response, invoiceDoc) {
  const leaseId = invoiceDoc?.lease_id;
  if (!leaseId || !response) return response;

  const lease = await Lease.findOne({ _id: leaseId, isDeleted: { $ne: true } })
    .select('rentAndDepositDestribution.isAllTenantsEquallyResponsible rentAndDepositDestribution.split')
    .lean();
  if (!lease?.rentAndDepositDestribution) return response;

  response.isAllTenantsEquallyResponsible =
    lease.rentAndDepositDestribution.isAllTenantsEquallyResponsible !== false;
  response.tenantRentSplit = (lease.rentAndDepositDestribution.split || []).map((entry) => ({
    tenantId: String(entry.tenantId),
    rentPercentage: Number(entry.rentPercentage || 0),
  }));
  return response;
}

async function hydrateInvoiceById(invoiceId) {
  const hydrated = await Invoice.findOne({ _id: invoiceId, isDeleted: { $ne: true } })
    .populate('propertyId')
    .populate('tenants', 'firstName lastName email phone address balance')
    .populate('documents.metadataId')
    .populate('paymentHistory.userId', 'firstName lastName email')
    .populate('paymentHistory.recordedBy', 'firstName lastName');
  return toInvoiceResponse(hydrated);
}

/**
 * Compute the sum of remaining balances on open invoices for the same lease
 * that have an earlier due date than the given invoice.
 * This is used to show a warning in the UI when recording a payment.
 */
async function computePriorOutstandingBalance(invoice) {
  if (!invoice?.lease_id || !invoice?.dueDate) return 0;
  const startOfToday = startOfDay(ClockService.now());
  const earlierInvoices = await Invoice.find({
    _id: { $ne: invoice._id },
    lease_id: invoice.lease_id,
    isDeleted: { $ne: true },
    balanceDue: { $gt: 0 },
    dueDate: { $lt: invoice.dueDate },
  }).select('balanceDue').lean();
  return roundCurrency(earlierInvoices.reduce((sum, inv) => sum + Number(inv.balanceDue || 0), 0));
}

/**
 * Persist invoice + metadata + events inside an existing transaction.
 * @returns {import('mongoose').Document} saved invoice document
 */
const createInvoiceInSession = async (data, userId, uploadedDocs, session) => {
  const payload = { ...data };
  if (userId) payload.createdBy = userId;
  const formNote = payload.notes != null ? String(payload.notes).trim() : '';
  if (payload.leaseId && !payload.lease_id) {
    payload.lease_id = payload.leaseId;
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'invoiceDetails')) {
    delete payload.invoiceDetails;
  }
  await normalizeInvoicePersistenceTarget(payload, session, { requireProperty: true });
  if (Object.prototype.hasOwnProperty.call(payload, 'notes')) {
    delete payload.notes;
  }

  if (Array.isArray(uploadedDocs) && uploadedDocs.length > 0) {
    const cfg = config;
    const bucketName = (cfg.s3 && cfg.s3.bucket) || process.env.S3_BUCKET || 'mock-bucket';
    const region = (cfg.s3 && cfg.s3.region) || process.env.AWS_REGION || 'mock-region';
    const createdMetadata = [];

    for (const d of uploadedDocs) {
      const metaDocs = await DocumentMetadata.create(
        [
          {
            key: d.key,
            s3Location: d.url,
            bucketName,
            region,
            size: d.size || 0,
            contentType: d.mimetype || 'application/octet-stream',
            originalName: d.originalName || d.filename,
          },
        ],
        { session }
      );
      createdMetadata.push(metaDocs[0]);
    }

    payload.documents = createdMetadata.map((md) => ({
      metadataId: md._id,
      originalName: md.originalName,
      uploadedAt: ClockService.now(),
      uploadedBy: userId,
    }));
  }

  const invoicePayload = { ...payload };
  const actorId = payload.createdBy || userId || undefined;
  if (formNote && !actorId) {
    throw createBadRequestError('Unable to resolve the invoice actor for notes');
  }
  if (formNote) {
    invoicePayload.comments = Array.isArray(invoicePayload.comments) ? invoicePayload.comments : [];
    invoicePayload.comments.push({
      text: formNote,
      createdBy: actorId,
      createdAt: ClockService.now(),
    });
  }

  const invoice = new Invoice(invoicePayload);
  await invoice.validate();
  const saved = await invoice.save({ session });
  await createInvoiceEvents(saved, session);
  return saved;
};

/**
 * Create a new invoice with optional file attachments (transactional).
 */
const createInvoice = async (data, userId, files, options = {}) => {
  const runPostCommitSideEffects = !options.session;
  let s3KeysForCleanup = [];
  let uploadedDocs = [];

  try {
    if (files && files.length > 0) {
      uploadedDocs = await uploadFilesToS3(files, userId);
      s3KeysForCleanup = uploadedDocs.map((d) => d.key).filter(Boolean);
    }

    const saved = await withInvoiceTransaction(
      (session) => createInvoiceInSession(data, userId, uploadedDocs, session),
      options
    );

    if (runPostCommitSideEffects) {
      try {
        await sendInvoiceEmails(saved);
      } catch (emailErr) {
        logger.error('Failed to send invoice emails after creation:', emailErr.message);
      }
    }

    return hydrateInvoiceById(saved._id);
  } catch (err) {
    for (const key of s3KeysForCleanup) {
      try {
        await s3Client.delete({ key });
      } catch (cleanupErr) {
        logger.error('Failed to cleanup S3 object after invoice create failure:', cleanupErr.message);
      }
    }
    throw err;
  }
};

/**
 * Get invoices with filters, pagination, and grouping options
 * @param {Object} query - Query parameters including filters, pagination, and groupBy
 * @returns {Object} - { data: [], meta: { total, page, pageSize }, landlordSummary: { collectedAmount, outstandingAmount, overdueAmount, collectionRate } }
 */
const getInvoices = async (query) => {
  const { propertyId, unit, unitId, tenantId, paymentMethod, invoiceId, invoiceType, status, startDate, endDate, sentOn, paidOn, groupBy, pageNumber, pageSize, leaseId, minAmount, maxAmount, isPartialPaymentAllowed, dashboardBucket, dashboardStatus } = query;
  const resolvedDashboardBucket =
    normalizeDashboardBucket(dashboardBucket) ||
    normalizeDashboardBucket(dashboardStatus);
  const dashboardStatusFilter = resolveDashboardBucketStatusFilter(resolvedDashboardBucket);
  const createdBy = resolveCreatedBy(query);

  // Build filter object based on provided query parameters
  const filter = {};
  let scopedPropertyIds = [];

  if (createdBy) {
    const ownerId = requireCreatedBy({ createdBy });
    scopedPropertyIds = await resolveLandlordInvoicePropertyIds(ownerId, { tenantId: tenantId || undefined });
    if (!scopedPropertyIds.length) {
      const respPage = pageNumber ? parseInt(pageNumber, 10) : 1;
      const respPageSize = pageSize ? parseInt(pageSize, 10) : 0;
      return { data: [], meta: { total: 0, page: respPage, pageSize: respPageSize }, landlordSummary: { collectedAmount: 0, outstandingAmount: 0, overdueAmount: 0, collectionRate: 0 } };
    }
  }

  // Property and owner validation and filtering
  if (propertyId) {
    if (scopedPropertyIds.length > 0 && !scopedPropertyIds.some((id) => String(id) === String(propertyId))) {
      const respPage = pageNumber ? parseInt(pageNumber, 10) : 1;
      const respPageSize = pageSize ? parseInt(pageSize, 10) : 0;
      return { data: [], meta: { total: 0, page: respPage, pageSize: respPageSize }, landlordSummary: { collectedAmount: 0, outstandingAmount: 0, overdueAmount: 0, collectionRate: 0 } };
    }
    filter.propertyId = propertyId;
  } else if (scopedPropertyIds.length > 0) {
    filter.propertyId = { $in: scopedPropertyIds };
  }

  // Additional filters
  if (unitId) filter.unitId = unitId;
  if (unit && !unitId) {
    const scopePropIds = filter.propertyId?.$in
      ? filter.propertyId.$in
      : (filter.propertyId ? [filter.propertyId] : []);
    const propFilter = scopePropIds.length > 0 ? { _id: { $in: scopePropIds }, isDeleted: { $ne: true } } : { isDeleted: { $ne: true } };
    const propsForUnits = await Property.find(propFilter).select('unitDetails').lean();
    const q = String(unit).trim().toLowerCase();
    const matchedUnitIds = (propsForUnits || []).flatMap((p) =>
      (p.unitDetails || [])
        .filter((u) => u && u.unitName && String(u.unitName).toLowerCase() === q)
        .map((u) => u._id)
    );
    if (matchedUnitIds.length === 0) {
      const respPage = pageNumber ? parseInt(pageNumber, 10) : 1;
      const respPageSize = pageSize ? parseInt(pageSize, 10) : 0;
      return { data: [], meta: { total: 0, page: respPage, pageSize: respPageSize }, landlordSummary: { collectedAmount: 0, outstandingAmount: 0, overdueAmount: 0, collectionRate: 0 } };
    }
    filter.unitId = { $in: matchedUnitIds };
  }
  if (tenantId) filter.tenants = tenantId;
  if (paymentMethod) filter.paymentMethod = paymentMethod;
  if (invoiceId) filter._id = invoiceId;
  if (invoiceType) filter.type = invoiceType;
  if (dashboardStatusFilter) {
    filter.status = dashboardStatusFilter;
  } else if (status) {
    const statuses = String(status)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
  }
  if (leaseId) filter.lease_id = leaseId;
  if (typeof isPartialPaymentAllowed === 'boolean') filter.isPartialPaymentAllowed = isPartialPaymentAllowed;
  // Amount range filter
  if (minAmount !== undefined || maxAmount !== undefined) {
    filter.subAmount = {};
    if (minAmount !== undefined) filter.subAmount.$gte = minAmount;
    if (maxAmount !== undefined) filter.subAmount.$lte = maxAmount;
  }

  // Date range filter on dueDate (both startDate and endDate must be present)
  if (startDate && endDate) {
    const dueDateFilter = buildLandlordInvoiceDueDateFilter(startDate, endDate);
    if (!dueDateFilter.dueDate) {
      throw new Error('Invalid date format for startDate or endDate');
    }
    Object.assign(filter, dueDateFilter);
  }

  // Filter by invoice sent date (createdAt)
  if (sentOn) {
    filter.createdAt = parseFilterInstant(sentOn, 'sentOn');
  }

  // Filter by payment date
  if (paidOn) {
    filter.paidOn = parseFilterInstant(paidOn, 'paidOn');
  }

  // Calculate pagination offset and limit
  const { offset, limit, page } = getPagination({ page: pageNumber, pageSize });

  // Determine sorting: support sortBy and sortOrder from query; default to dueDate ascending
  let sort = { dueDate: 1 }; // ascending dueDate by default
  if (query.sortBy) {
    const dir = String(query.sortOrder || 'asc').toLowerCase() === 'desc' ? -1 : 1;
    // Map known frontend sort keys to DB fields if necessary
    const sortFieldMap = {
      dueDate: 'dueDate',
      createdAt: 'createdAt',
      amount: 'subAmount',
      paidOn: 'paidOn'
    };
    const field = sortFieldMap[query.sortBy] || query.sortBy;
    sort = { [field]: dir };
  }

  // Fetch invoices and total count in parallel
  let invoices, total;
  let summarySourceInvoices = null;
  const baseFilter = { ...filter, isDeleted: { $ne: true } };
  try {
    const summaryPromise = createdBy
      ? Invoice.find(baseFilter).select(INVOICE_SUMMARY_SELECT).lean()
      : Promise.resolve(null);
    [invoices, total, summarySourceInvoices] = await Promise.all([
      applyInvoiceListQuery(Invoice.find(baseFilter))
        .sort(sort)
        .skip(offset)
        .limit(limit || 0)
        .lean(),
      Invoice.countDocuments(baseFilter),
      summaryPromise,
    ]);
  } catch (error) {
    throw new Error(`Database error while fetching invoices: ${error.message}`);
  }

  // Enrich tenant names when populate returned bare ObjectId refs (legacy activation invoices).
  const missingTenantIds = new Set();
  invoices.forEach((inv) => {
    (inv.tenants || []).forEach((t) => {
      if (!t) return;
      const id = t._id || t;
      const hasName = `${t.firstName || ''} ${t.lastName || ''}`.trim() || t.name;
      if (id && !hasName) missingTenantIds.add(String(id));
    });
  });
  if (missingTenantIds.size > 0) {
    const tenantUsers = await User.find({ _id: { $in: [...missingTenantIds] }, isDeleted: { $ne: true } })
      .select('firstName lastName')
      .lean();
    const nameById = tenantUsers.reduce((acc, user) => {
      acc[String(user._id)] = {
        firstName: user.firstName || '',
        lastName: user.lastName || '',
      };
      return acc;
    }, {});
    invoices.forEach((inv) => {
      inv.tenants = (inv.tenants || []).map((t) => {
        if (!t) return t;
        const id = String(t._id || t);
        const existingName = `${t.firstName || ''} ${t.lastName || ''}`.trim();
        if (existingName || !nameById[id]) return t;
        return {
          ...t,
          firstName: nameById[id].firstName,
          lastName: nameById[id].lastName,
        };
      });
    });
  }

  // Calculate owner summary using the same filter as the list (respects date/property/bucket filters).
  let landlordSummary = {
    collectedAmount: 0,
    processingAmount: 0,
    overdueAmount: 0,
    comingDueAmount: 0,
    totalAmount: 0,
    outstandingAmount: 0,
    collectionRate: 0,
  };
  if (createdBy && summarySourceInvoices) {
    try {
      landlordSummary = computeLandlordSummaryFromInvoices(summarySourceInvoices);
      logger.step('INVOICE_SUMMARY', 'Landlord invoice summary computed', {
        createdBy: String(createdBy),
        count: summarySourceInvoices.length,
        collectionRate: landlordSummary.collectionRate,
      });
    } catch (error) {
      logger.error('[invoice.service] getInvoices:landlord-summary-error', { error: error.message });
    }
  }

  const mapListRow = (inv, propertySharedByOverride) => ({
    _id: inv._id,
    id: inv._id,
    invoiceId: inv.invoiceId,
    propertySharedBy: propertySharedByOverride ?? buildPropertySharedBy(inv),
    tenants: mapTenantSummaryFromInvoice(inv),
    dueOn: inv.dueDate,
    paidOn: resolveLastPaidOn(inv) || inv.paidOn,
    status: inv.status,
    unit: resolveUnitNameFromInvoiceDoc(inv),
    amount: inv.subAmount,
    paid: inv.status === INVOICE_STATUS.PAID ? inv.subAmount : inv.alreadyPaid,
    balance: inv.balanceDue,
    isPartialPaymentAllowed: inv.isPartialPaymentAllowed,
  });

  // Format response based on groupBy option
  let data;

  if (groupBy === GROUP_BY.PROPERTY) {
    // Group by Property: Show property name in propertySharedBy
    data = invoices.map((inv) =>
      mapListRow(inv, inv.propertyId?.name || '')
    );
  } else if (groupBy === GROUP_BY.TENANT) {
    // Group by Tenant: Create separate record for each tenant per property
    data = [];
    invoices.forEach((inv) => {
      const tenantSummaries = mapTenantSummaryFromInvoice(inv);
      if (tenantSummaries.length === 0) {
        data.push(mapListRow(inv));
        return;
      }
      tenantSummaries.forEach((tenant) => {
        data.push(mapListRow(inv, tenant.name || ''));
      });
    });
  } else {
    // No grouping (NA): Show both property and tenant names
    data = invoices.map((inv) => mapListRow(inv));
  }

  return { data, meta: buildListMeta(total, page, limit), landlordSummary };
};

/**
 * Get invoice by ID
 * @param {String} id - Invoice ID
 * @returns {Object} - Invoice document
 */
const getInvoiceById = async (id) => {
  const invoice = await Invoice.findOne({ _id: id, isDeleted: { $ne: true } })
    .populate('documents.metadataId', 'originalName contentType size key')
    .populate('propertyId', 'name address unitDetails createdBy landlord_id')
    .populate('tenants', 'firstName lastName email phone address balance')
    .populate('paymentHistory.userId', 'firstName lastName email')
    .populate('paymentHistory.recordedBy', 'firstName lastName')
    .populate('comments.createdBy', 'firstName lastName email')
    .populate('createdBy', 'firstName lastName email')
    .lean();
  if (!invoice) throw new NotFoundError('Invoice not found');
  const response = toInvoiceResponse(invoice);
  await attachLeasePaymentSettings(response, invoice);
  response.activityTimeline = buildLandlordActivityTimeline(response);
  response.priorOutstandingBalance = await computePriorOutstandingBalance(invoice);

  // Fetch Straddle payment data for this invoice
  try {
    const paymentData = await straddlePaymentService.getInvoicePaymentData(id);
    if (paymentData && paymentData.transactions.length > 0) {
      response.straddlePayments = {
        transactions: paymentData.transactions,
        statuses: paymentData.paymentStatuses,
        summary: straddlePaymentService.getPaymentStatusSummary(paymentData.paymentStatuses)
      };
    }
  } catch (err) {
    logger.error('[invoice.service] Failed to fetch Straddle payment data', {
      invoiceId: id,
      error: err.message
    });
    // Don't fail the request if Straddle data fetch fails
    response.straddlePayments = null;
  }

  return response;
};

const updateInvoiceInSession = async (id, updates, userId, uploadedDocs, session) => {
  const patch = { ...updates };
  normalizeInvoicePaymentAliases(patch);
  const formNote = patch.notes != null ? String(patch.notes).trim() : '';
  const documentIdsToDelete = Array.isArray(patch.documentToDelete)
    ? [...new Set(patch.documentToDelete.map((idToDelete) => String(idToDelete)).filter(Boolean))]
    : [];
  const paymentIdsToDelete = Array.isArray(patch.deletePaymentIds)
    ? new Set(patch.deletePaymentIds.map(String).filter(Boolean))
    : new Set();
  if (patch.leaseId && !patch.lease_id) {
    patch.lease_id = patch.leaseId;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'invoiceDetails')) {
    delete patch.invoiceDetails;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'documentToDelete')) {
    delete patch.documentToDelete;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'deletePaymentIds')) {
    delete patch.deletePaymentIds;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'notes')) {
    delete patch.notes;
  }

  const invoice = await applySession(Invoice.findOne({ _id: id, isDeleted: { $ne: true } }), session);
  if (!invoice) throw new NotFoundError('Invoice not found');
  await normalizeInvoicePersistenceTarget(patch, session, {
    currentInvoice: invoice,
    requireProperty: true,
  });

  if (userId) patch.updatedBy = userId;
  const paymentResolution = await resolveLandlordPaymentPatch(invoice, patch, session);
  const isPaymentUpdate =
    paymentResolution != null
    || (Object.prototype.hasOwnProperty.call(patch, 'alreadyPaid') && patch.alreadyPaid !== invoice.alreadyPaid);
  const actorId = patch.updatedBy || invoice.updatedBy || invoice.createdBy || userId || undefined;
  if (formNote && !isPaymentUpdate && !actorId) {
    throw createBadRequestError('Unable to resolve the invoice actor for notes');
  }

  if (isPaymentUpdate && patch.alreadyPaid > invoice.alreadyPaid) {
    const paymentAmount = paymentResolution?.paymentAmount ?? (patch.alreadyPaid - invoice.alreadyPaid);
    invoice.paymentHistory = Array.isArray(invoice.paymentHistory) ? invoice.paymentHistory : [];
    invoice.paymentHistory.push({
      userId: patch.paymentUserId || (invoice.tenants && invoice.tenants[0]) || actorId,
      paymentDate: patch.paidOn ? (DateUtil.toUTC(patch.paidOn) || ClockService.now()) : ClockService.now(),
      paymentType: paymentResolution?.paymentType || patch.paymentType || 'Other',
      paymentAmount,
      checkNumber: patch.checkNumber || undefined,
      moneyOrderNumber: patch.moneyOrderNumber || undefined,
      notes: formNote || patch.paymentNotes || undefined,
      recordedBy: actorId,
      recordedAt: ClockService.now(),
      isManual: patch.isManual !== false,
    });
  }

  if (documentIdsToDelete.length > 0) {
    const docIdsToDelete = new Set(documentIdsToDelete);
    invoice.documents = (Array.isArray(invoice.documents) ? invoice.documents : []).filter((doc) => {
      const metadataId = doc && doc.metadataId != null ? String(doc.metadataId) : '';
      return !docIdsToDelete.has(metadataId);
    });
  }

  if (paymentIdsToDelete.size > 0) {
    invoice.paymentHistory = (Array.isArray(invoice.paymentHistory) ? invoice.paymentHistory : []).filter((entry) => {
      return !paymentIdsToDelete.has(String(entry._id));
    });
    // Recalculate alreadyPaid and balanceDue from remaining payment history
    const totalPaid = invoice.paymentHistory.reduce((sum, entry) => sum + roundCurrency(entry.paymentAmount || 0), 0);
    const subAmt = roundCurrency(invoice.subAmount || 0);
    invoice.alreadyPaid = roundCurrency(Math.min(totalPaid, subAmt));
    invoice.balanceDue = roundCurrency(Math.max(0, subAmt - invoice.alreadyPaid));
    // Override with caller-supplied values if provided (they already account for deletions)
    if (Object.prototype.hasOwnProperty.call(patch, 'alreadyPaid')) {
      invoice.alreadyPaid = roundCurrency(patch.alreadyPaid);
      delete patch.alreadyPaid;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'balanceDue')) {
      invoice.balanceDue = roundCurrency(patch.balanceDue);
      delete patch.balanceDue;
    }
  }

  delete patch.paymentUserId;
  delete patch.paymentMethod;
  delete patch.paymentType;
  delete patch.checkNumber;
  delete patch.moneyOrderNumber;
  delete patch.paymentNotes;
  delete patch.paymentNote;
  delete patch.isManual;

  if (Array.isArray(uploadedDocs) && uploadedDocs.length > 0) {
    const cfg = config;
    const bucketName = (cfg.s3 && cfg.s3.bucket) || process.env.S3_BUCKET || 'mock-bucket';
    const region = (cfg.s3 && cfg.s3.region) || process.env.AWS_REGION || 'mock-region';

    invoice.documents = invoice.documents || [];
    for (const d of uploadedDocs) {
      const metaDocs = await DocumentMetadata.create(
        [
          {
            key: d.key,
            s3Location: d.url,
            bucketName,
            region,
            size: d.size || 0,
            contentType: d.mimetype || 'application/octet-stream',
            originalName: d.originalName || d.filename,
          },
        ],
        { session }
      );
      const md = metaDocs[0];
      invoice.documents.push({
        metadataId: md._id,
        originalName: md.originalName,
        uploadedAt: ClockService.now(),
        uploadedBy: userId,
      });
    }
  }

  Object.assign(invoice, patch);
  if (formNote && !isPaymentUpdate) {
    invoice.comments = Array.isArray(invoice.comments) ? invoice.comments : [];
    invoice.comments.push({
      text: formNote,
      createdBy: actorId,
      createdAt: ClockService.now(),
    });
  }
  if (patch.paidOn) {
    invoice.paidOn = DateUtil.toUTC(patch.paidOn) || ClockService.now();
  }

  await invoice.validate();
  return invoice.save({ session });
};

/**
 * Update an existing invoice (transactional).
 */
const updateInvoice = async (id, updates, userId, files, options = {}) => {
  let s3KeysForCleanup = [];
  let uploadedDocs = [];

  try {
    if (files && files.length > 0) {
      uploadedDocs = await uploadFilesToS3(files, userId);
      s3KeysForCleanup = uploadedDocs.map((d) => d.key).filter(Boolean);
    }

    const safeInvoiceId = toObjectId(id);
    const priorInvoice = await Invoice.findOne({ _id: safeInvoiceId, isDeleted: { $ne: true } })
      .select('alreadyPaid paymentHistory')
      .lean();

    let capturedPaymentResolution = null;
    const wrappedSession = async (session) => {
      const result = await updateInvoiceInSession(id, updates, userId, uploadedDocs, session);
      // Capture payment resolution from the session closure via a side-channel
      // by re-reading the invoice's last comment for FIFO metadata.
      return result;
    };

    const saved = await withInvoiceTransaction(
      wrappedSession,
      options
    );

    const priorPaid = roundCurrency(priorInvoice?.alreadyPaid || 0);
    const newPaid = roundCurrency(saved.alreadyPaid || 0);
    if (newPaid > priorPaid && Array.isArray(saved.paymentHistory) && saved.paymentHistory.length > 0) {
      const latestPayment = saved.paymentHistory[saved.paymentHistory.length - 1];
      notifyPaymentRecordedInBackground(saved, latestPayment);
    }

    const hydrated = await hydrateInvoiceById(saved._id);
    // Notify linked landlord + tenants asynchronously after a successful invoice update.
    if (options.notify !== false) {
      notifyInvoiceUpdatedInBackground(saved._id, saved.updatedAt);
    }

    // Attach paymentAllocation to the response so the frontend can show
    // FIFO-redirection details in Recent Activity / toast messages.
    // Read the FIFO_REDIRECT comment from the saved invoice to build the allocation.
    const fifoComment = Array.isArray(saved.comments)
      ? saved.comments.slice().reverse().find((c) => String(c.text || '').startsWith('FIFO_REDIRECT:'))
      : null;
    if (fifoComment) {
      try {
        const fifoPayload = JSON.parse(String(fifoComment.text).slice('FIFO_REDIRECT:'.length));
        hydrated.paymentAllocation = {
          mode: 'chronological',
          paymentAmount: fifoPayload.recordedAmount,
          appliedToPrimary: fifoPayload.appliedToThisInvoice,
          appliedToOtherInvoices: [{
            invoiceId: fifoPayload.redirectedToInvoiceId,
            invoiceNumber: fifoPayload.redirectedToInvoiceNumber,
            amount: fifoPayload.redirectedAmount,
          }],
          primaryStatus: hydrated.status,
          primaryBalanceDue: hydrated.balanceDue,
        };
      } catch (_) { /* ignore parse errors */ }
    }

    return hydrated;
  } catch (err) {
    for (const key of s3KeysForCleanup) {
      try {
        await s3Client.delete({ key });
      } catch (cleanupErr) {
        logger.error('Failed to cleanup S3 object after invoice update failure:', cleanupErr.message);
      }
    }
    throw err;
  }
};

/**
 * Soft delete an invoice by ID (sets isDeleted = true)
 * @param {String} id - Invoice ID
 * @returns {Object} - Soft deleted invoice
 */
const deleteInvoiceInSession = async (id, session) => {
  const opts = { new: true };
  if (session) opts.session = session;

  const safeDeleteId = toObjectId(id);
  const existing = await Invoice.findOne({ _id: safeDeleteId, isDeleted: { $ne: true } });
  if (!existing) throw new NotFoundError('Invoice not found');

  if (existing.status === INVOICE_STATUS.PAID) {
    throw Object.assign(
      new Error(`Invoice ${existing.invoiceId || id} (status: ${existing.status}) cannot be deleted`),
      { status: 400, invoiceId: existing.invoiceId || String(id), currentStatus: existing.status }
    );
  }

  const invoice = await Invoice.findOneAndUpdate(
    { _id: id, isDeleted: { $ne: true } },
    { isDeleted: true },
    opts
  );
  if (!invoice) throw new NotFoundError('Invoice not found');
  return invoice;
};

const deleteInvoice = async (id, options = {}) => {
  return withInvoiceTransaction((session) => deleteInvoiceInSession(id, session), options);
};

/**
 * Get invoice statistics with same filters as getInvoices
 * @param {Object} query - Query parameters (same as getInvoices)
 * @returns {Object} - Statistics object
 */
const getInvoiceStatistics = async (query) => {
  const { propertyId, unit, unitId, tenantId, paymentMethod, invoiceId, invoiceType, status, startDate, endDate, sentOn, paidOn, leaseId, minAmount, maxAmount, isPartialPaymentAllowed } = query;
  const createdBy = resolveCreatedBy(query);

  // Build filter object (same logic as getInvoices)
  const filter = {};
  let scopedPropertyIds = [];

  if (createdBy) {
    const ownerId = requireCreatedBy({ createdBy });
    scopedPropertyIds = await resolveLandlordInvoicePropertyIds(ownerId, { tenantId: tenantId || undefined });
    if (!scopedPropertyIds.length) {
      return { totalInvoiceAmount: 0, totalOpenInvoice: 0, overdue: 0, partiallyPaid: 0, fullyPaid: 0 };
    }
  }

  // Property and owner validation and filtering
  if (propertyId) {
    if (scopedPropertyIds.length > 0 && !scopedPropertyIds.some((id) => String(id) === String(propertyId))) {
      return { totalInvoiceAmount: 0, totalOpenInvoice: 0, overdue: 0, partiallyPaid: 0, fullyPaid: 0 };
    }
    filter.propertyId = propertyId;
  } else if (scopedPropertyIds.length > 0) {
    filter.propertyId = { $in: scopedPropertyIds };
  }

  // Additional filters
  if (unitId) filter.unitId = unitId;
  if (unit && !unitId) {
    const scopePropIds = filter.propertyId?.$in
      ? filter.propertyId.$in
      : (filter.propertyId ? [filter.propertyId] : []);
    const safeScopePropIds = scopePropIds.map(toObjectId).filter(Boolean);
    const propFilter = safeScopePropIds.length > 0 ? { _id: { $in: safeScopePropIds }, isDeleted: { $ne: true } } : { isDeleted: { $ne: true } };
    const propsForUnits = await Property.find(propFilter).select('unitDetails').lean();
    const q = String(unit).trim().toLowerCase();
    const matchedUnitIds = (propsForUnits || []).flatMap((p) =>
      (p.unitDetails || [])
        .filter((u) => u && u.unitName && String(u.unitName).toLowerCase() === q)
        .map((u) => u._id)
    );
    if (matchedUnitIds.length === 0) {
      return { totalInvoiceAmount: 0, totalOpenInvoice: 0, overdue: 0, partiallyPaid: 0, fullyPaid: 0 };
    }
    filter.unitId = { $in: matchedUnitIds };
  }
  if (tenantId) filter.tenants = tenantId;
  if (paymentMethod) filter.paymentMethod = paymentMethod;
  if (invoiceId) filter._id = invoiceId;
  if (invoiceType) filter.type = invoiceType;
  if (status) {
    const statuses = String(status)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
  }
  if (leaseId) filter.lease_id = leaseId;
  if (typeof isPartialPaymentAllowed === 'boolean') filter.isPartialPaymentAllowed = isPartialPaymentAllowed;
  // Amount range filter
  if (minAmount !== undefined || maxAmount !== undefined) {
    filter.subAmount = {};
    if (minAmount !== undefined) filter.subAmount.$gte = minAmount;
    if (maxAmount !== undefined) filter.subAmount.$lte = maxAmount;
  }

  if (startDate && endDate) {
    Object.assign(filter, buildLandlordInvoiceDueDateFilter(startDate, endDate));
  }
  if (sentOn) filter.createdAt = parseFilterInstant(sentOn, 'sentOn');
  if (paidOn) filter.paidOn = parseFilterInstant(paidOn, 'paidOn');

  // Fetch matching invoices with summary fields only
  const invoices = await Invoice.find({ ...filter, isDeleted: { $ne: true } })
    .select('status balanceDue alreadyPaid subAmount')
    .lean();

  // Calculate statistics
  const statistics = {
    totalInvoiceAmount: 0,
    totalOpenInvoice: 0,
    overdue: 0,
    partiallyPaid: 0,
    fullyPaid: 0
  };

  invoices.forEach(inv => {
    // Total Invoice Amount: sum of all balanceDue
    statistics.totalInvoiceAmount += inv.balanceDue || 0;

    // Total Open Invoice: balanceDue of Pending status invoices
    if (inv.status === INVOICE_STATUS.PENDING) {
      statistics.totalOpenInvoice += inv.balanceDue || 0;
    }

    // Overdue: balanceDue of Overdue status invoices
    if (inv.status === INVOICE_STATUS.OVERDUE) {
      statistics.overdue += inv.balanceDue || 0;
    }

    // Partially Paid: alreadyPaid of Partially Paid status invoices
    if (inv.status === INVOICE_STATUS.PARTIALLY_PAID) {
      statistics.partiallyPaid += inv.alreadyPaid || 0;
    }

    // Fully Paid: subAmount of Paid status invoices
    if (inv.status === INVOICE_STATUS.PAID) {
      statistics.fullyPaid += inv.subAmount || 0;
    }
  });

  return statistics;
};

/**
 * Export invoices as CSV with same filters as getInvoices
 * @param {Object} query - Query parameters (same as getInvoices)
 * @returns {Object} - { filename, csv }
 */
const exportInvoicesCsv = async (query) => {
  const { groupBy } = query;

  // Reuse getInvoices function to get consistent data
  const result = await getInvoices(query);
  const data = result.data;

  // Generate CSV from the data
  const headers = ['Property/Shared By', 'Due On', 'Paid On', 'ID', 'Status', 'Unit', 'Amount', 'Paid', 'Balance'];
  if (groupBy === GROUP_BY.TENANT) headers.splice(1, 0, 'Property');

  const csvEscape = (val) => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const rows = [headers.join(',')];
  data.forEach(row => {
    const values = [
      csvEscape(row.propertySharedBy),
      ...(groupBy === GROUP_BY.TENANT ? [csvEscape(row.property)] : []),
      csvEscape(row.dueOn ? DateUtil.toISO(row.dueOn).split('T')[0] : ''),
      csvEscape(row.paidOn ? DateUtil.toISO(row.paidOn).split('T')[0] : ''),
      csvEscape(row.id),
      csvEscape(row.status),
      csvEscape(row.unit),
      csvEscape(row.amount),
      csvEscape(row.paid),
      csvEscape(row.balance)
    ];
    rows.push(values.join(','));
  });

  const csv = rows.join('\n');
  const timestamp = getDateKeyInTimeZone(ClockService.now()) || DateUtil.toISO(ClockService.now()).split('T')[0];
  const filename = `invoices_export_${timestamp}.csv`;

  return { filename, csv };
};

/**
 * Generate invoices from lease additional fees
 * @param {String} leaseId - Lease ID
 * @returns {Array} - Array of created invoices
 */

// Helper for non-recurring invoice
const handleNonRecurringInvoice = async (fee, lease, leaseId, options = {}) => {
  const saved = await createInvoice({
    type: INVOICE_TYPES.OTHER,
    lease_id: leaseId,
    propertyId: lease.property_id._id,
    unit: lease.unitName,
    unitId: lease.unitId,
    term: lease.term || 'N/A',
    tenants: lease.rentAndDepositDestribution.split.map(s => s.tenantId),
    invoiceItemDetails: fee.items.map(item => ({
      invoiceItem: item.name,
      description: item.description,
      quantity: item.quantity,
      rate: item.rate,
      amount: item.amount
    })),
    subAmount: fee.totalAmount,
    alreadyPaid: fee.alreadyPaid || 0,
    balanceDue: fee.balanceAmount,
    isPartialPaymentAllowed: lease.rentAndDepositDestribution.isPartialPaymentAllowed,
    dueDate: fee.dueDate
  }, undefined, undefined, options);

  if (!options.session) {
    try {
      await sendInvoiceEmails(saved);
    } catch (err) {
      logger.error('Error sending invoice email for non-recurring invoice:', err.message);
    }
  }

  return saved;
};

// Helper for recurring invoice with lineItemOnRentalInvoice = true
const handleRecurringLineItemOnRentalInvoice = async (
  fee,
  lease,
  leaseId,
  currentMonth1,
  currentYear,
  options = {}
) => {
  if (!isCurrentAppMonthInRange(currentMonth1, currentYear, fee.startDate, fee.endDate)) {
    return null;
  }

  const persist = async (session) => {
    const safeLeaseIdForRent = toObjectId(leaseId);
    const rentInvoice = await applySession(
      Invoice.findOne({
        lease_id: safeLeaseIdForRent,
        type: INVOICE_TYPES.RENT,
        status: { $nin: [INVOICE_STATUS.PAID] },
        isDeleted: { $ne: true },
      }),
      session
    );
    if (!rentInvoice) return null;

    fee.items.forEach((item) => {
      rentInvoice.invoiceItemDetails.push({
        invoiceItem: item.name,
        description: item.description,
        quantity: item.quantity,
        rate: item.rate,
        amount: item.amount,
      });
    });
    rentInvoice.subAmount += fee.totalAmount;
    rentInvoice.alreadyPaid += fee.alreadyPaid || 0;
    rentInvoice.balanceDue += fee.balanceAmount;
    await rentInvoice.save({ session });
    return rentInvoice;
  };

  return withInvoiceTransaction(persist, options);
};

// Helper for recurring invoice with lineItemOnRentalInvoice = false
const handleRecurringSeparateInvoices = async (
  fee,
  lease,
  leaseId,
  currentMonth1,
  currentYear,
  options = {}
) => {
  const invoices = [];
  const generatedDates = await generateDatesForFrequency(fee.frequency, fee, leaseId, currentMonth1, currentYear);
  for (const date of generatedDates) {
    if (isDateInRange(date, fee.startDate, fee.endDate)) {
      const invoice = await createInvoice({
        type: INVOICE_TYPES.OTHER,
        lease_id: leaseId,
        propertyId: lease.property_id._id,
        unit: lease.unitName,
        unitId: lease.unitId,
        term: lease.term || 'N/A',
        tenants: lease.rentAndDepositDestribution.split.map(s => s.tenantId),
        invoiceItemDetails: fee.items.map(item => ({
          invoiceItem: item.name,
          description: item.description,
          quantity: item.quantity,
          rate: item.rate,
          amount: item.amount
        })),
        subAmount: fee.totalAmount,
        alreadyPaid: fee.alreadyPaid || 0,
        balanceDue: fee.balanceAmount,
        isPartialPaymentAllowed: lease.rentAndDepositDestribution.isPartialPaymentAllowed,
        dueDate: date
      }, undefined, undefined, options);
      invoices.push(invoice);
      if (!options.session) {
        try {
          await sendInvoiceEmails(invoice);
        } catch (err) {
          logger.error('Error sending invoice email for recurring separate invoice:', err.message);
        }
      }
    }
  }
  return invoices;
};

const generateInvoicesFromLease = async (leaseId, options = {}) => {
  const lease = await Lease.findOne({ _id: leaseId, isDeleted: { $ne: true } }).populate('property_id');
  if (!lease) throw new NotFoundError('Lease not found');

  const runGeneration = async (session) => {
    const nestedOptions = { session };
    const createdInvoices = [];
    const { currentYear, currentMonth1 } = getCurrentAppMonthYear();

    for (const fee of lease.additionalFees || []) {
      if (!fee.isRecurringInvoice) {
        createdInvoices.push(await handleNonRecurringInvoice(fee, lease, leaseId, nestedOptions));
      } else if (fee.isRecurringInvoice && fee.lineItemOnRentalInvoice) {
        const rentInvoice = await handleRecurringLineItemOnRentalInvoice(
          fee,
          lease,
          leaseId,
          currentMonth1,
          currentYear,
          nestedOptions
        );
        if (rentInvoice) createdInvoices.push(rentInvoice);
      } else if (fee.isRecurringInvoice && !fee.lineItemOnRentalInvoice) {
        const invoices = await handleRecurringSeparateInvoices(
          fee,
          lease,
          leaseId,
          currentMonth1,
          currentYear,
          nestedOptions
        );
        createdInvoices.push(...invoices);
      }
    }

    return createdInvoices;
  };

  const created = await withInvoiceTransaction(runGeneration, options);

  if (!options.session) {
    for (const inv of created) {
      try {
        await sendInvoiceEmails(inv);
      } catch (err) {
        logger.error('Error sending invoice email after lease fee generation:', err.message);
      }
    }
  }

  return created;
};

const isDateInRange = (date, startDate, endDate) => {
  const key = calendarKey(date);
  if (!key) return false;
  return isCalendarKeyInRange(key, startDate, endDate);
};

const generateDatesForFrequency = async (frequency, fee, leaseId, currentMonth1, currentYear) => {
  const dates = [];

  if (!frequency) {
    logger.warn('⚠️ Warning: generateDatesForFrequency called with undefined frequency. Fee object:', fee);
    return dates;
  }

  const normalizedFrequency = String(frequency).toLowerCase().trim();

  switch (normalizedFrequency) {
    case 'monthly': {
      const day = parseInt(fee.dueOnDate || fee.dueOn, 10);
      if (day && !isNaN(day)) {
        dates.push(appCalendarDueDate(currentYear, currentMonth1, day));
      }
      break;
    }

    case 'semi-annually': {
      if (fee.semiAnnualDates && Array.isArray(fee.semiAnnualDates)) {
        fee.semiAnnualDates.forEach(dateConfig => {
          const month1 = parseInt(dateConfig.month, 10);
          const day = parseInt(dateConfig.day, 10);
          if (!isNaN(month1) && !isNaN(day)) {
            dates.push(appCalendarDueDate(currentYear, month1, day));
          }
        });
      }
      break;
    }

    case 'bi-monthly': {
      const day1 = parseInt(fee.dueOnDate, 10);
      const day2 = parseInt(fee.dueOnDate2, 10);
      if (day1 && !isNaN(day1)) {
        dates.push(appCalendarDueDate(currentYear, currentMonth1, day1));
      }
      if (day2 && !isNaN(day2)) {
        dates.push(appCalendarDueDate(currentYear, currentMonth1, day2));
      }
      break;
    }

    case 'weekly': {
      const weekDay = fee.dueWeekday !== undefined ? parseInt(fee.dueWeekday, 10) : (fee.dayOfWeek !== undefined ? getDayOfWeek(fee.dayOfWeek) : -1);
      if (weekDay !== -1 && !isNaN(weekDay)) {
        for (const ymd of iterAppMonthDayKeys(currentYear, currentMonth1)) {
          if (getAppWeekdayIndex(ymd) === weekDay) {
            dates.push(parseDateOnlyToNoonUtc(ymd));
          }
        }
      }
      break;
    }

    case 'bi-weekly': {
      const biWeeklyDay = fee.dueWeekday !== undefined ? parseInt(fee.dueWeekday, 10) : (fee.dayOfWeek !== undefined ? getDayOfWeek(fee.dayOfWeek) : -1);
      if (biWeeklyDay !== -1 && !isNaN(biWeeklyDay)) {
        for (const ymd of iterAppMonthDayKeys(currentYear, currentMonth1)) {
          if (getAppWeekdayIndex(ymd) !== biWeeklyDay) continue;
          const dueDate = parseDateOnlyToNoonUtc(ymd);
          const prevWeekStart = parseDateOnlyToNoonUtc(shiftAppYmdDays(ymd, -7));
          const prevWeekEnd = DateUtil.endOfDayEST(shiftAppYmdDays(ymd, -1));
          try {
            const existingInvoice = await Invoice.findOne({
              lease_id: leaseId,
              type: INVOICE_TYPES.OTHER,
              dueDate: { $gte: prevWeekStart, $lte: prevWeekEnd },
              isDeleted: { $ne: true }
            });
            if (!existingInvoice) {
              dates.push(dueDate);
            }
          } catch (err) {
            logger.error('Error checking bi-weekly invoice existence:', err);
            dates.push(dueDate);
          }
        }
      }
      break;
    }

    case 'custom': {
      if (fee.customDates && Array.isArray(fee.customDates)) {
        fee.customDates.forEach(dateStr => {
          const customDate = DateUtil.toUTC(dateStr);
          if (customDate) {
            dates.push(customDate);
          }
        });
      }
      break;
    }

    default: {
      logger.warn(`⚠️ Warning: Unknown frequency type "${normalizedFrequency}" for additional fee. Fee object:`, fee);
      break;
    }
  }

  return dates;
};

const getDayOfWeek = (dayName) => {
  if (!dayName || typeof dayName !== 'string') return -1;
  const days = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  const normalizedDay = dayName.toLowerCase().trim();
  return days.hasOwnProperty(normalizedDay) ? days[normalizedDay] : -1;
};

/**
 * Generate invoices for both Rent and Deposit based on lease ID
 * @param {String} leaseId - Lease ID
 * @param {Date} depositDueDate - Due date for deposit invoice
 * @returns {Array} - Array of created invoices
 */
const generateRentAndDepositInvoices = async (leaseId, depositDueDate) => {
  // Input validation
  if (!leaseId || typeof leaseId !== 'string') {
    throw new Error('Valid lease ID is required');
  }
  if (!depositDueDate || !DateUtil.toUTC(depositDueDate)) {
    throw new Error('Valid deposit due date is required');
  }
  const normalizedDepositDueDate = DateUtil.toUTC(depositDueDate);

  let lease;
  try {
    const safeLeaseIdForFetch = toObjectId(leaseId);
    lease = await Lease.findOne({ _id: safeLeaseIdForFetch, isDeleted: { $ne: true } }).populate('property_id');
  } catch (error) {
    throw new Error(`Database error while fetching lease: ${error.message}`);
  }

  if (!lease) throw new NotFoundError('Lease not found');
  if (!lease.property_id) throw new Error('Property not found for lease');
  if (!lease.rentAndDepositDestribution?.split?.length) {
    throw new Error('No tenants found in lease');
  }

  const createdInvoices = [];
  const { currentYear, currentMonth1 } = getCurrentAppMonthYear();
  const leaseStartKey = calendarKey(lease.start_date);
  const leaseEndKey = calendarKey(lease.end_date);

  // Generate Deposit Invoice
  if (lease.depositDetails?.amount > 0) {
    try {
      const depositInvoice = await createInvoice({
        type: INVOICE_TYPES.DEPOSIT,
        lease_id: leaseId,
        propertyId: lease.property_id._id,
        unit: lease.unitName,
        unitId: lease.unitId,
        term: lease.term || 'N/A',
        tenants: lease.rentAndDepositDestribution.split.map(s => s.tenantId),
        invoiceItemDetails: [{
          invoiceItem: INVOICE_TYPES.DEPOSIT,
          description: INVOICE_TYPES.DEPOSIT,
          quantity: 1,
          rate: lease.depositDetails.amount,
          amount: lease.depositDetails.amount
        }],
        subAmount: lease.depositDetails.amount,
        alreadyPaid: 0,
        balanceDue: lease.depositDetails.amount,
        isPartialPaymentAllowed: lease.rentAndDepositDestribution.isPartialPaymentAllowed,
        dueDate: normalizedDepositDueDate
      });
      createdInvoices.push(depositInvoice);
      try {
        await sendInvoiceEmails(depositInvoice);
      } catch (err) {
        logger.error('Error sending invoice email for deposit invoice:', err.message);
      }
    } catch (error) {
      throw new Error(`Failed to create deposit invoice: ${error.message}`);
    }
  }

  // Generate Rent Invoices
  if (!lease.rentDetails?.frequency || !lease.rentDetails?.amount) {
    return createdInvoices;
  }

  try {
    const rentDates = await generateRentDates(
      lease.rentDetails,
      currentMonth1,
      currentYear,
      leaseStartKey,
      leaseEndKey,
      leaseId
    );

    for (const rentDate of rentDates) {
      const monthYear = formatMonthYearInAppTimezone(rentDate, { month: 'short' });

      const rentInvoice = await createInvoice({
        type: INVOICE_TYPES.RENT,
        lease_id: leaseId,
        propertyId: lease.property_id._id,
        unit: lease.unitName,
        unitId: lease.unitId,
        term: lease.term || 'N/A',
        tenants: lease.rentAndDepositDestribution.split.map(s => s.tenantId),
        invoiceItemDetails: [{
          invoiceItem: INVOICE_TYPES.RENT,
          description: `${INVOICE_TYPES.RENT} ${monthYear}`,
          quantity: 1,
          rate: lease.rentDetails.amount,
          amount: lease.rentDetails.amount
        }],
        subAmount: lease.rentDetails.amount,
        alreadyPaid: 0,
        balanceDue: lease.rentDetails.amount,
        isPartialPaymentAllowed: lease.rentAndDepositDestribution.isPartialPaymentAllowed,
        dueDate: rentDate
      });
      createdInvoices.push(rentInvoice);
      try {
        await sendInvoiceEmails(rentInvoice);
      } catch (err) {
        logger.error('Error sending invoice email for rent invoice:', err.message);
      }
    }
  } catch (error) {
    throw new Error(`Failed to generate rent invoices: ${error.message}`);
  }

  return createdInvoices;
};

/**
 * Generate rent dates based on frequency
 */
const generateRentDates = async (rentDetails, currentMonth1, currentYear, leaseStartKey, leaseEndKey, leaseId) => {
  if (!rentDetails?.frequency) {
    throw new Error('Invalid rent details: frequency is required');
  }

  const frequency = rentDetails.frequency.toLowerCase();
  const rentDates = [];
  const isInLeaseRange = (dueDate) => {
    const key = calendarKey(dueDate);
    if (!key || !leaseStartKey || !leaseEndKey) return false;
    return key >= leaseStartKey && key <= leaseEndKey;
  };

  try {
    switch (frequency) {
      case FREQUENCY_TYPES.MONTHLY: {
        if (!rentDetails.dueOne) {
          throw new Error('dueOne is required for monthly frequency');
        }
        const day = parseInt(rentDetails.dueOne, 10);
        if (isNaN(day) || day < 1 || day > 31) {
          throw new Error('Invalid day for monthly frequency');
        }
        const monthlyDate = appCalendarDueDate(currentYear, currentMonth1, day);
        if (isInLeaseRange(monthlyDate)) {
          rentDates.push(monthlyDate);
        }
        break;
      }

      case FREQUENCY_TYPES.BI_MONTHLY: {
        if (!rentDetails.dueOne || !rentDetails.dueTwo) {
          throw new Error('Both dueOne and dueTwo are required for bi-monthly frequency');
        }
        const day1 = parseInt(rentDetails.dueOne, 10);
        const day2 = parseInt(rentDetails.dueTwo, 10);
        if (isNaN(day1) || day1 < 1 || day1 > 31 || isNaN(day2) || day2 < 1 || day2 > 31) {
          throw new Error('Invalid days for bi-monthly frequency');
        }

        [day1, day2].forEach(day => {
          const biMonthlyDate = appCalendarDueDate(currentYear, currentMonth1, day);
          if (isInLeaseRange(biMonthlyDate)) {
            rentDates.push(biMonthlyDate);
          }
        });
        break;
      }

      case FREQUENCY_TYPES.WEEKLY: {
        if (rentDetails.dueWeekday === undefined || rentDetails.dueWeekday === null) {
          throw new Error('dueWeekday is required for weekly frequency');
        }
        const weekDay = rentDetails.dueWeekday;
        if (weekDay < 0 || weekDay > 6) {
          throw new Error('Invalid weekday for weekly frequency (must be 0-6)');
        }

        for (const ymd of iterAppMonthDayKeys(currentYear, currentMonth1)) {
          if (getAppWeekdayIndex(ymd) !== weekDay) continue;
          const dueDate = parseDateOnlyToNoonUtc(ymd);
          if (isInLeaseRange(dueDate)) {
            rentDates.push(dueDate);
          }
        }
        break;
      }

      case FREQUENCY_TYPES.BI_WEEKLY: {
        if (rentDetails.dueWeekday === undefined || rentDetails.dueWeekday === null) {
          throw new Error('dueWeekday is required for bi-weekly frequency');
        }
        const biWeeklyDay = rentDetails.dueWeekday;
        if (biWeeklyDay < 0 || biWeeklyDay > 6) {
          throw new Error('Invalid weekday for bi-weekly frequency (must be 0-6)');
        }

        for (const ymd of iterAppMonthDayKeys(currentYear, currentMonth1)) {
          if (getAppWeekdayIndex(ymd) !== biWeeklyDay) continue;
          const dueDate = parseDateOnlyToNoonUtc(ymd);
          if (!isInLeaseRange(dueDate)) continue;

          const prevWeekStart = parseDateOnlyToNoonUtc(shiftAppYmdDays(ymd, -7));

          const existingInvoice = await Invoice.findOne({
            lease_id: leaseId,
            type: INVOICE_TYPES.RENT,
            dueDate: { $gte: prevWeekStart, $lt: dueDate },
            isDeleted: { $ne: true }
          });

          if (!existingInvoice) {
            rentDates.push(dueDate);
          }
        }
        break;
      }

      case FREQUENCY_TYPES.SEMI_ANNUALLY: {
        if (!rentDetails.semiAnnualDates || !Array.isArray(rentDetails.semiAnnualDates) || rentDetails.semiAnnualDates.length !== 2) {
          throw new Error('semiAnnualDates array with 2 dates is required for semi-annually frequency');
        }

        rentDetails.semiAnnualDates.forEach(dateConfig => {
          const month1 = parseInt(dateConfig.month, 10);
          const day = parseInt(dateConfig.day, 10);
          if (isNaN(month1) || month1 < 1 || month1 > 12 || isNaN(day) || day < 1 || day > 31) {
            throw new Error('Invalid month or day in semiAnnualDates');
          }
          const semiAnnualDate = appCalendarDueDate(currentYear, month1, day);
          if (isInLeaseRange(semiAnnualDate)) {
            rentDates.push(semiAnnualDate);
          }
        });
        break;
      }

      case FREQUENCY_TYPES.CUSTOM: {
        if (rentDetails.firstRentalInvoiceDue) {
          const customDate = DateUtil.toUTC(rentDetails.firstRentalInvoiceDue);
          if (customDate && isInLeaseRange(customDate)) {
            rentDates.push(customDate);
          }
        }
        break;
      }

      default:
        throw new Error(`Unsupported frequency: ${frequency}`);
    }
  } catch (error) {
    throw new Error(`Error generating rent dates: ${error.message}`);
  }

  return rentDates;
};
/**
 * Generate invoices from lease using firstRentalInvoiceDue and deposit due date logic
 * - Rent: generate only if rentDetails.firstRentalInvoiceDue falls within current month
 * - Deposit: generate only if depositDetails.due falls within current month
 * @param {String} leaseId
 * @returns {Array} created invoices
 */
const generateInvoicesFromLeaseDueDates = async (leaseId) => {
  if (!leaseId || typeof leaseId !== 'string') throw new Error('Valid lease ID is required');
  const safeLeaseIdForDueDates = toObjectId(leaseId);
  if (!safeLeaseIdForDueDates) throw Object.assign(new Error('Invalid lease ID'), { status: 400 });

  const lease = await Lease.findOne({ _id: safeLeaseIdForDueDates, isDeleted: { $ne: true } }).populate('property_id');
  if (!lease) throw new NotFoundError('Lease not found');
  if (!lease.property_id) throw new Error('Property not found for lease');
  if (!lease.rentAndDepositDestribution?.split?.length) throw new Error('No tenants found in lease');

  const created = [];
  const { month: currentMonth, year: currentYear } = getBusinessMonthYear();

  // Helper to test if a date is in current month/year (business timezone)
  const isInCurrentMonth = (d) => isDateInBusinessMonth(d, currentMonth, currentYear);

  // Deposit: only generate if deposit due date is in current month
  try {
    if (isInCurrentMonth(lease.depositDetails?.due)) {
      const depositAmount = lease.depositDetails?.amount || 0;
      const depositInvoice = await createInvoice({
        type: INVOICE_TYPES.DEPOSIT,
        lease_id: leaseId,
        propertyId: lease.property_id._id,
        unit: lease.unitName,
        unitId: lease.unitId,
        term: lease.term || 'N/A',
        tenants: lease.rentAndDepositDestribution.split.map(s => s.tenantId),
        invoiceItemDetails: [{
          invoiceItem: INVOICE_TYPES.DEPOSIT,
          description: INVOICE_TYPES.DEPOSIT,
          quantity: 1,
          rate: depositAmount,
          amount: depositAmount
        }],
        subAmount: depositAmount,
        alreadyPaid: 0,
        balanceDue: depositAmount,
        isPartialPaymentAllowed: lease.rentAndDepositDestribution.isPartialPaymentAllowed,
        dueDate: DateUtil.toUTC(lease.depositDetails.due)
      });
      created.push(depositInvoice);
      try {
        await sendInvoiceEmails(depositInvoice);
      } catch (err) {
        logger.error('Error sending invoice email for deposit invoice (dueDates):', err.message);
      }
    }
  } catch (err) {
    throw new Error(`Failed to create deposit invoice: ${err.message}`);
  }

  // Rent: only generate if firstRentalInvoiceDue exists and falls within current month
  try {
    const firstDue = lease.rentDetails?.firstRentalInvoiceDue;
    if (firstDue && isInCurrentMonth(firstDue)) {
      const monthYear = formatMonthYearInAppTimezone(firstDue, { month: 'short' });

      const rentInvoice = await createInvoice({
        type: INVOICE_TYPES.RENT,
        lease_id: leaseId,
        propertyId: lease.property_id._id,
        unit: lease.unitName,
        unitId: lease.unitId,
        term: lease.term || 'N/A',
        tenants: lease.rentAndDepositDestribution.split.map(s => s.tenantId),
        invoiceItemDetails: [{
          invoiceItem: INVOICE_TYPES.RENT,
          description: `${INVOICE_TYPES.RENT} ${monthYear}`,
          quantity: 1,
          rate: lease.rentDetails.amount,
          amount: lease.rentDetails.amount
        }],
        subAmount: lease.rentDetails.amount,
        alreadyPaid: 0,
        balanceDue: lease.rentDetails.amount,
        isPartialPaymentAllowed: lease.rentAndDepositDestribution.isPartialPaymentAllowed,
        dueDate: DateUtil.toUTC(firstDue)
      });
      created.push(rentInvoice);
      try {
        await sendInvoiceEmails(rentInvoice);
      } catch (err) {
        logger.error('Error sending invoice email for rent invoice (dueDates):', err.message);
      }
    }
  } catch (err) {
    throw new Error(`Failed to create rent invoice: ${err.message}`);
  }

  return created;
};

/**
 * Add comment to an invoice
 * @param {String} id - Invoice ID
 * @param {String} text - Comment text
 * @param {String} userId - User ID adding the comment
 * @returns {Object} - Updated invoice
 */
const addCommentInSession = async (id, text, userId, session) => {
  const safeCommentInvoiceId = toObjectId(id);
  if (!safeCommentInvoiceId) throw Object.assign(new Error('Invalid invoice ID'), { status: 400 });
  const invoice = await applySession(Invoice.findOne({ _id: safeCommentInvoiceId, isDeleted: { $ne: true } }), session);
  if (!invoice) throw new NotFoundError('Invoice not found');

  invoice.comments = Array.isArray(invoice.comments) ? invoice.comments : [];
  invoice.comments.push({ text, createdBy: userId });
  return invoice.save({ session });
};

const addComment = async (id, text, userId, options = {}) => {
  return withInvoiceTransaction((session) => addCommentInSession(id, text, userId, session), options);
};

/**
 * Build payment-reminder template payload for landlord invoice reminders.
 */
function buildLandlordPaymentReminderEmailData(invoice, tenantUser) {
  const payerName = `${tenantUser.firstName || ''} ${tenantUser.lastName || ''}`.trim() || 'Tenant';
  const invoiceNumber = invoice.invoiceId || String(invoice._id);
  const invoiceBase = process.env.INVOICE_BASE_URL || process.env.FRONTEND_BASE_URL || 'https://app.example.com';
  const viewUrl = `${String(invoiceBase).replace(/\/$/, '')}/income/${invoice._id}`;
  const formatMoney = (value) =>
    typeof value === 'number' ? `$${value.toFixed(2)}` : String(value || '');

  return {
    recipientName: payerName,
    ownerName: payerName,
    invoiceType: invoice.type || 'Invoice',
    invoiceNumber,
    propertyName: invoice.propertyName || 'N/A',
    unitNumber: invoice.unit || 'N/A',
    invoiceDescription: invoice.type || 'Invoice',
    invoiceAmount: formatMoney(invoice.subAmount),
    outstandingBalance: formatMoney(invoice.balanceDue),
    dueDate: invoice.dueDate ? formatDateInAppTimezone(invoice.dueDate) : 'N/A',
    invoiceStatus: invoice.status || 'Pending',
    customMessage: '',
    hasCustomMessage: false,
    senderCompany: getDefaultFromName(),
    senderPhone: '',
    senderEmail: '',
    paymentUrl: viewUrl,
    viewInvoiceUrl: viewUrl,
    paymentHistoryUrl: viewUrl,
    downloadInvoiceUrl: viewUrl,
  };
}

/**
 * Send reminder email for an invoice by ID
 * @param {String} id - Invoice ID
 * @returns {Object} - Invoice document
 */
const sendInvoiceReminder = async (id) => {
  logger.info('[invoice.service] sendInvoiceReminder:start', { invoiceId: String(id) });

  const invoice = await Invoice.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!invoice) throw new NotFoundError('Invoice not found');

  // No-op for fully paid invoices to avoid sending misleading reminders.
  if (invoice.status === INVOICE_STATUS.PAID || Number(invoice.balanceDue || 0) <= 0) {
    const err = new Error('Cannot send reminder for a fully paid invoice');
    err.status = 400;
    throw err;
  }

  // Backfill tenant refs from lease when legacy activation stored an empty tenants array.
  let tenantIds = Array.isArray(invoice.tenants)
    ? invoice.tenants.map((t) => normalizeTenantRefId(t)).filter(Boolean)
    : [];
  if (tenantIds.length === 0 && invoice.lease_id) {
    const lease = await Lease.findOne({ _id: invoice.lease_id, isDeleted: { $ne: true } })
      .select('rentAndDepositDestribution.split.tenantId')
      .lean();
    tenantIds = getTenantIdsFromLeaseContext(lease);
    if (tenantIds.length > 0) {
      invoice.tenants = tenantIds;
    }
  }

  const tenantsWithEmail =
    tenantIds.length > 0
      ? await User.find({
        _id: { $in: tenantIds },
        isDeleted: { $ne: true },
        email: { $exists: true, $nin: [null, ''] },
      })
        .select('email firstName lastName')
        .lean()
      : [];

  if (tenantsWithEmail.length === 0) {
    logger.warn('[invoice.service] sendInvoiceReminder:no-tenant-emails', { invoiceId: String(id) });
    const err = new Error('No tenant email addresses found for this invoice');
    err.status = 400;
    throw err;
  }

  const invoiceNumber = invoice.invoiceId || String(invoice._id);
  const reminderSubject = `Payment reminder: Invoice ${invoiceNumber}`;

  await Promise.all(
    tenantsWithEmail.map(async (tenant) => {
      const emailData = buildLandlordPaymentReminderEmailData(invoice, tenant);
      await emailHelper.sendEmail('payment-reminder', tenant.email, emailData, {
        subject: reminderSubject,
        template: 'payment-reminder',
        preheaderText: buildPaymentReminderPreheader({
          invoiceNumber: emailData.invoiceNumber,
          outstandingBalance: emailData.outstandingBalance,
          dueDate: emailData.dueDate,
        }),
      });
    })
  );

  invoice.remindersSent = (invoice.remindersSent || 0) + 1;
  invoice.comments = Array.isArray(invoice.comments) ? invoice.comments : [];
  invoice.comments.push({
    text: `Payment reminder sent to ${tenantsWithEmail.map((t) => t.email).join(', ')}.`,
    isSystem: true,
    createdAt: ClockService.now(),
  });
  await invoice.save();

  logger.info('[invoice.service] sendInvoiceReminder:success', {
    invoiceId: String(id),
    remindersSent: invoice.remindersSent,
  });

  return hydrateInvoiceById(invoice._id);
};

/**
 * Generate rent + deposit invoices for all active leases (batch; each lease uses its own transaction).
 */
const generateAllRentAndDepositInvoicesService = async () => {
  const activeLeases = await Lease.find({ status: LEASE_STATUSES.ACTIVE, isDeleted: { $ne: true } });
  const results = [];
  for (const lease of activeLeases) {
    const depositDueDate = DateUtil.toUTC(lease.depositDetails?.due) || DateUtil.startOfDayEST(ClockService.now());
    const invoices = await generateRentAndDepositInvoices(lease._id, depositDueDate);
    results.push({ leaseId: lease._id, invoices });
  }
  return { leases: results };
};

/**
 * Generate additional-fee invoices for all active leases (one transaction per lease).
 */
const generateAllAdditionalFeeInvoicesService = async () => {
  const activeLeases = await Lease.find({ status: LEASE_STATUSES.ACTIVE, isDeleted: { $ne: true } });
  const results = [];
  for (const lease of activeLeases) {
    const invoices = await generateInvoicesFromLease(lease._id);
    results.push({ leaseId: lease._id, invoices });
  }
  return { leases: results };
};

/**
 * merge Invoice Scope From Actor
 *
 * Performs logic operations for mergeInvoiceScopeFromActor.
 *
 * @param payload - Request/input argument
 * @param actorId - Request/input argument
 * @returns Operations result
 */
function mergeInvoiceScopeFromActor(payload = {}, actorId) {
  return Object.assign({}, payload, {
    createdBy: resolveCreatedBy(payload, actorId),
  });
}
/* -------------------------------------------------------------------------- */
/* Export helpers (merged from invoiceExport.service.js)                       */
/* -------------------------------------------------------------------------- */
const ExcelJS = require('exceljs');
const { resolveCreatedBy: resolveCb } = require('../../../../../shared/utils/creatorScope.util');

async function exportInvoicesAsCSV(filters = {}) {
  const result = await getInvoices(filters);
  const data = (result && result.data) || [];

  if (!data || data.length === 0) {
    return { filename: `income_export_${ClockService.nowEpoch()}.csv`, content: 'No invoices found', contentType: 'text/csv' };
  }

  const headers = ['propertySharedBy', 'dueOn', 'paidOn', 'invoiceId', 'status', 'unit', 'amount', 'paid', 'balance'];

  /**
   * csv Escape
   *
   * Performs logic operations for csvEscape.
   *
   * @param val - Request/input argument
   * @returns Operations result
   */
  function csvEscape(val) {
    if (val === null || typeof val === 'undefined') return '""';
    if (typeof val === 'object') {
      try { val = JSON.stringify(val); } catch { val = String(val); }
    }
    let s = String(val);
    if (/^[+\-=@]/.test(s.charAt(0))) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  const rows = [headers.join(',')];
  for (const rowObj of data) {
    const mapped = {
      propertySharedBy: rowObj.propertySharedBy || '',
      dueOn: rowObj.dueOn ? DateUtil.toISO(rowObj.dueOn).split('T')[0] : '',
      paidOn: rowObj.paidOn ? DateUtil.toISO(rowObj.paidOn).split('T')[0] : '',
      invoiceId: rowObj.invoiceId || '',
      status: rowObj.status || '',
      unit: rowObj.unit || '',
      amount: rowObj.amount || 0,
      paid: rowObj.paid || 0,
      balance: rowObj.balance || 0
    };
    const row = headers.map(h => csvEscape(mapped[h]));
    rows.push(row.join(','));
  }

  const csv = rows.join('\n');
  const ownerId = resolveCb(filters || {}) || 'all';
  const ts = buildExportFilenameTimestamp();
  const filename = `income_${ownerId}_${ts}.csv`;

  return { filename, content: csv, contentType: 'text/csv' };
}

async function exportInvoicesAsExcel(filters = {}) {
  const result = await getInvoices(filters);
  const data = (result && result.data) || [];

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Income');

  worksheet.columns = [
    { header: 'Property/Tenant', key: 'propertySharedBy', width: 40 },
    { header: 'Due Date', key: 'dueOn', width: 15 },
    { header: 'Paid Date', key: 'paidOn', width: 15 },
    { header: 'Invoice ID', key: 'invoiceId', width: 25 },
    { header: 'Status', key: 'status', width: 15 },
    { header: 'Unit', key: 'unit', width: 15 },
    { header: 'Amount', key: 'amount', width: 15 },
    { header: 'Paid', key: 'paid', width: 15 },
    { header: 'Balance', key: 'balance', width: 15 }
  ];

  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE0E0E0' }
  };

  for (const rowObj of data) {
    worksheet.addRow({
      propertySharedBy: rowObj.propertySharedBy || '',
      dueOn: rowObj.dueOn ? DateUtil.toISO(rowObj.dueOn).split('T')[0] : '',
      paidOn: rowObj.paidOn ? DateUtil.toISO(rowObj.paidOn).split('T')[0] : '',
      invoiceId: rowObj.invoiceId || '',
      status: rowObj.status || '',
      unit: rowObj.unit || '',
      amount: rowObj.amount || 0,
      paid: rowObj.paid || 0,
      balance: rowObj.balance || 0
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const ownerId = resolveCb(filters || {}) || 'all';
  const ts = buildExportFilenameTimestamp();
  const filename = `income_${ownerId}_${ts}.xlsx`;

  return { filename, content: buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}

async function exportInvoicesAsJSON(filters = {}) {
  const result = await getInvoices(filters);
  const data = (result && result.data) || [];

  const exportData = data.map(rowObj => ({
    propertySharedBy: rowObj.propertySharedBy || '',
    dueOn: rowObj.dueOn || '',
    paidOn: rowObj.paidOn || '',
    invoiceId: rowObj.invoiceId || '',
    status: rowObj.status || '',
    unit: rowObj.unit || '',
    amount: rowObj.amount || 0,
    paid: rowObj.paid || 0,
    balance: rowObj.balance || 0
  }));

  const json = JSON.stringify({ invoices: exportData, total: data.length, exportedAt: DateUtil.toISO(ClockService.now()) }, null, 2);
  const ownerId = resolveCb(filters || {}) || 'all';
  const ts = buildExportFilenameTimestamp();
  const filename = `income_${ownerId}_${ts}.json`;

  return { filename, content: json, contentType: 'application/json' };
}

async function exportInvoices(filters = {}, format = 'csv') {
  const formatLower = String(format).toLowerCase();
  switch (formatLower) {
    case 'xlsx':
    case 'excel':
      return await exportInvoicesAsExcel(filters);
    case 'json':
      return await exportInvoicesAsJSON(filters);
    case 'csv':
    default:
      return await exportInvoicesAsCSV(filters);
  }
}

/**
 * Get all invoice payment data for a lease (includes Straddle transactions)
 * @param {String} leaseId - Lease ID
 * @returns {Object} - Payment data for all lease invoices
 */
const getLeasePaymentData = async (leaseId) => {
  try {
    // Fetch all invoices for this lease
    const safeLeaseIdForPayments = toObjectId(leaseId);
    if (!safeLeaseIdForPayments) throw Object.assign(new Error('Invalid lease ID'), { status: 400 });
    const invoices = await Invoice.find({
      lease_id: safeLeaseIdForPayments,
      isDeleted: { $ne: true }
    })
      .select('_id invoiceId status subAmount alreadyPaid balanceDue dueDate')
      .lean();

    if (!invoices || invoices.length === 0) {
      return {
        invoices: [],
        straddlePayments: {
          transactions: [],
          statuses: [],
          summary: { totalTransactions: 0, latestStatus: null, allStatuses: [] }
        }
      };
    }

    // Fetch Straddle payment data for the lease
    const leasePaymentData = await straddlePaymentService.getLeasePaymentData(leaseId);

    // Also fetch individual invoice payment data
    const invoicePaymentDataPromises = invoices.map(inv =>
      straddlePaymentService.getInvoicePaymentData(inv._id)
    );
    const invoicePaymentDataList = await Promise.all(invoicePaymentDataPromises);

    // Combine all payment statuses
    const allStatuses = [
      ...leasePaymentData.paymentStatuses,
      ...invoicePaymentDataList.flatMap(data => data.paymentStatuses)
    ];

    return {
      invoices: invoices.map((inv, idx) => ({
        ...inv,
        straddlePayments: invoicePaymentDataList[idx]
      })),
      straddlePayments: {
        transactions: leasePaymentData.transactions,
        statuses: allStatuses,
        summary: straddlePaymentService.getPaymentStatusSummary(allStatuses)
      }
    };
  } catch (err) {
    logger.error('[invoice.service] Failed to fetch lease payment data', {
      leaseId,
      error: err.message
    });
    throw err;
  }
};

module.exports = {
  createInvoice,
  getInvoices,
  getInvoiceById,
  updateInvoice,
  deleteInvoice,
  getInvoiceStatistics,
  exportInvoicesCsv,
  exportInvoices,
  generateInvoicesFromLease,
  generateRentAndDepositInvoices,
  generateInvoicesFromLeaseDueDates,
  generateAllRentAndDepositInvoicesService,
  generateAllAdditionalFeeInvoicesService,
  addComment,
  sendInvoiceReminder,
  mergeInvoiceScopeFromActor,
  withInvoiceTransaction,
  getLeaseContextForInvoice,
  getLeasePaymentData,
  sendLandlordInvoiceUpdatedEmails,
};
