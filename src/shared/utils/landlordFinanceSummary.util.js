/**
 * ------------------------------------------------------------------
 * File: landlordFinanceSummary.util.js
 * Module: Src Shared Utils
 *
 * Purpose:
 * Backend utility/module providing helper functions for landlordFinanceSummary.util.
 *
 * Used By:
 * dashboard.service, invoice.service
 * ------------------------------------------------------------------
 */

const Invoice = require('../../portals/landlord/modules/invoice/model/invoice.model');
const Property = require('../../portals/landlord/modules/property/model/property.model');
const {
  findPropertyIdsByCreatedBy,
  buildPropertyOwnerFilter,
  requireCreatedBy,
} = require('./creatorScope.util');
const { aggregateFinanceSummary } = require('./invoiceFinanceBuckets');
const { dateOnlyKeyFromStoredInstant } = require('../../common/helpers/hoaBillingDates');

const INVOICE_FINANCE_SUMMARY_SELECT = 'status subAmount balanceDue dueDate alreadyPaid paidOn';

const EMPTY_FINANCE_SUMMARY = {
  collectedAmount: 0,
  processingAmount: 0,
  overdueAmount: 0,
  comingDueAmount: 0,
  totalAmount: 0,
  outstandingAmount: 0,
  collectionRate: 0,
};

/**
 * Active properties plus soft-deleted properties that still have non-deleted invoices
 * in scope (preserves paid/partial/due/overdue history after unit or lease removal).
 */
async function resolveLandlordInvoicePropertyIds(createdBy, { tenantId } = {}) {
  const activeIds = await findPropertyIdsByCreatedBy(Property, createdBy);
  const invoiceMatch = { isDeleted: { $ne: true } };
  if (tenantId) {
    invoiceMatch.tenants = tenantId;
  }

  let historicalCandidates;
  if (tenantId) {
    historicalCandidates = await Invoice.distinct('propertyId', invoiceMatch);
  } else if (activeIds.length > 0) {
    historicalCandidates = await Invoice.distinct('propertyId', {
      ...invoiceMatch,
      propertyId: { $nin: activeIds },
    });
  } else {
    historicalCandidates = await Invoice.distinct('propertyId', invoiceMatch);
  }

  if (!historicalCandidates.length) return activeIds;

  const ownerFilter = buildPropertyOwnerFilter(createdBy);
  const historicalProps = await Property.find({
    _id: { $in: historicalCandidates },
    ...ownerFilter,
  })
    .select('_id')
    .lean();

  const merged = new Map();
  for (const id of activeIds) merged.set(String(id), id);
  for (const p of historicalProps) merged.set(String(p._id), p._id);

  return Array.from(merged.values());
}

const YMD_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Resolve calendar YMD for due-date filtering (matches invoice listing query params). */
function resolveLandlordInvoiceDueDateYmd(value) {
  if (!value) return null;
  if (typeof value === 'string' && YMD_ONLY_PATTERN.test(value.trim())) {
    return value.trim();
  }
  return dateOnlyKeyFromStoredInstant(value);
}

/** Same due-date filter semantics as landlord invoice listing (`getInvoices`). */
function buildLandlordInvoiceDueDateFilter(startDate, endDate) {
  if (!startDate || !endDate) return {};

  const startKey = resolveLandlordInvoiceDueDateYmd(startDate);
  const endKey = resolveLandlordInvoiceDueDateYmd(endDate);
  if (startKey && endKey) {
    // `new Date('YYYY-MM-DD')` parses as UTC midnight - same as getInvoices.
    const start = new Date(`${startKey}T00:00:00.000Z`);
    const end = new Date(`${endKey}T00:00:00.000Z`);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      return { dueDate: { $gte: start, $lte: end } };
    }
  }

  const start = startDate instanceof Date ? startDate : new Date(startDate);
  const end = endDate instanceof Date ? endDate : new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return {};
  }
  return { dueDate: { $gte: start, $lte: end } };
}

/**
 * build Landlord Invoice Base Filter
 *
 * Performs logic operations for buildLandlordInvoiceBaseFilter.
 *
 * @param propertyIds - Request/input argument
 * @param options - Request/input argument
 * @returns Operations result
 */
function buildLandlordInvoiceBaseFilter(propertyIds, { startDate, endDate } = {}) {
  if (!propertyIds || propertyIds.length === 0) return null;
  return {
    propertyId: { $in: propertyIds },
    isDeleted: { $ne: true },
    ...buildLandlordInvoiceDueDateFilter(startDate, endDate),
  };
}

/**
 * Fetch invoices in landlord finance scope - aligned with income listing filters.
 */
async function fetchLandlordInvoicesForFinanceSummary(createdBy, { startDate, endDate, tenantId } = {}) {
  const ownerId = requireCreatedBy({ createdBy });
  const propertyIds = await resolveLandlordInvoicePropertyIds(ownerId, { tenantId });
  const filter = buildLandlordInvoiceBaseFilter(propertyIds, { startDate, endDate });
  if (!filter) return [];

  return Invoice.find(filter).select(INVOICE_FINANCE_SUMMARY_SELECT).lean();
}

/**
 * Build finance summary totals using the same invoice scope and bucketing as the income listing.
 */
async function buildLandlordFinanceSummary(createdBy, { startDate, endDate, tenantId } = {}) {
  const invoices = await fetchLandlordInvoicesForFinanceSummary(createdBy, {
    startDate,
    endDate,
    tenantId,
  });
  if (!invoices.length) return { ...EMPTY_FINANCE_SUMMARY };
  return aggregateFinanceSummary(invoices);
}

module.exports = {
  INVOICE_FINANCE_SUMMARY_SELECT,
  EMPTY_FINANCE_SUMMARY,
  resolveLandlordInvoicePropertyIds,
  buildLandlordInvoiceDueDateFilter,
  buildLandlordInvoiceBaseFilter,
  fetchLandlordInvoicesForFinanceSummary,
  buildLandlordFinanceSummary,
};
