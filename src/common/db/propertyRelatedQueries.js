/**
 * ------------------------------------------------------------------
 * File: propertyRelatedQueries.js
 * Module: Src Common Db
 *
 * Purpose:
 * Backend utility/module providing helper functions for propertyRelatedQueries.
 *
 * Used By:
 * property.service
 * ------------------------------------------------------------------
 */

/**
 * Centralized Mongoose queries for property list/detail enrichment.
 */
const { toObjectId } = require('./mongooseHelpers');
const {
  extractTenantIds,
  findLeasesByPropertyId: queryLeasesByPropertyId,
  findLeasesByPropertyIds: queryLeasesByPropertyIds,
  leaseExistsForProperty: queryLeaseExistsForProperty,
} = require('./leaseQueryHelpers');

const HoaBoardInvoice = require('../../portals/hoa-board/modules/invoice/model/invoice.model');
const MaintenanceRequest = require('../../shared/modules/maintenance/model/maintenanceRequest.model');
const User = require('../../shared/modules/users/models/user.model');
const Listing = require('../../portals/landlord/modules/listing/models/listing.model');
const LedgerEntry = require('../../portals/hoa-board/modules/owners/models/ledgerEntry.model');
const HoaExpense = require('../../portals/hoa-board/modules/expense/model/expense.model');

async function findLeasesByPropertyId(propertyId, options = {}) {
  return queryLeasesByPropertyId(propertyId, options);
}

async function findLeasesByPropertyIds(propertyIds, options = {}) {
  return queryLeasesByPropertyIds(propertyIds, options);
}

async function leaseExistsForProperty(propertyId, unitName) {
  return queryLeaseExistsForProperty(propertyId, unitName);
}

/**
 * extract Tenant Ids From Leases
 *
 * Performs logic operations for extractTenantIdsFromLeases.
 *
 * @param leases - Request/input argument
 * @returns Operations result
 */
function extractTenantIdsFromLeases(leases = []) {
  return extractTenantIds(leases);
}

async function findOverdueInvoicesByPropertyIds(propertyIds, today, options = {}) {
  return HoaBoardInvoice.findOverdueByPropertyIds(propertyIds, today, options);
}

async function aggregateUnpaidSummaryByPropertyIds(propertyIds, today) {
  return HoaBoardInvoice.aggregateUnpaidSummaryByPropertyIds(propertyIds, today);
}

/**
 * build Unpaid Summary Maps
 *
 * Performs logic operations for buildUnpaidSummaryMaps.
 *
 * @param summary - Request/input argument
 * @returns Operations result
 */
function buildUnpaidSummaryMaps(summary = {}) {
  const overdueByProperty = {};
  const pastDueByProperty = {};
  const partiallyPaidByProperty = {};
  const unpaidTotalByProperty = {};
  const dueTodayByProperty = {};
  const overdueByPropertyUnit = {};

  for (const row of summary.byProperty || []) {
    const propId = row._id?.toString?.() || String(row._id);
    unpaidTotalByProperty[propId] = Number(row.totalDue || 0);
    pastDueByProperty[propId] = Number(row.pastDueAmount || 0);
    overdueByProperty[propId] = Number(row.overdueAmount || 0);
    partiallyPaidByProperty[propId] = Number(row.partiallyPaidAmount || 0);
    dueTodayByProperty[propId] = Number(row.dueTodayAmount || 0);
  }

  for (const row of summary.byPropertyUnit || []) {
    const propId = row._id?.propertyId?.toString?.() || String(row._id?.propertyId);
    const unit = row._id?.unit || '';
    overdueByPropertyUnit[`${propId}::${unit}`] = Number(row.overdueAmount || 0);
  }

  return {
    overdueByProperty,
    pastDueByProperty,
    partiallyPaidByProperty,
    unpaidTotalByProperty,
    dueTodayByProperty,
    overdueByPropertyUnit,
  };
}

async function findOverdueInvoicesByProperty(propertyId, today, options = {}) {
  return HoaBoardInvoice.findOverdueByProperty(propertyId, today, options);
}

async function sumOverdueBalanceByProperty(propertyId, today) {
  const invoices = await findOverdueInvoicesByProperty(propertyId, today);
  return invoices.reduce((sum, invoice) => sum + Number(invoice.balanceDue || 0), 0);
}

async function aggregateMaintenanceCountsByPropertyIds(propertyIds) {
  return MaintenanceRequest.aggregateCountsByPropertyIds(propertyIds);
}

async function aggregateMaintenanceCountsByProperty(propertyId) {
  return MaintenanceRequest.aggregateCountsByProperty(propertyId);
}

async function findMaintenanceByProperty(propertyId, options = {}) {
  const { lean = true } = options;
  let query = MaintenanceRequest.find({ property_id: toObjectId(propertyId) });
  return lean ? query.lean().exec() : query.exec();
}

async function distinctPropertyIdsWithOpenMaintenance(propertyIds, openStatuses) {
  return MaintenanceRequest.distinctOpenPropertyIds(propertyIds, openStatuses);
}

async function findOpenMaintenanceByProperty(propertyId, limit = 3) {
  return MaintenanceRequest.findOpenByProperty(propertyId, limit);
}

async function countMaintenanceByProperty(propertyId) {
  return MaintenanceRequest.countForProperty(propertyId);
}

async function findActiveListingsByPropertyIds(propertyIds, options = {}) {
  return Listing.findActiveByPropertyIds(propertyIds, options);
}

async function findActiveListingByProperty(propertyId, unitName) {
  return Listing.findActiveByProperty(propertyId, unitName);
}

async function findCreditAdjustmentsByUnitIds(unitIds) {
  return LedgerEntry.findCreditAdjustmentsByUnitIds(unitIds);
}

async function findUsersByPropertyId(propertyId, options = {}) {
  return User.findByPropertyId(propertyId, options);
}

async function findUsersByPropertyIds(propertyIds, options = {}) {
  return User.findByPropertyIds(propertyIds, options);
}

async function findUsersByIds(userIds, options = {}) {
  return User.findActiveByIds(userIds, options);
}

async function countInvoicesByProperty(propertyId) {
  return HoaBoardInvoice.countForProperty(propertyId);
}

async function countExpensesByProperty(propertyId) {
  return HoaExpense.countForProperty(propertyId);
}

async function findInvoicesForPropertyDetail(propertyId, options = {}) {
  return HoaBoardInvoice.findForPropertyDetail(propertyId, options);
}

async function findFeeInvoicesForProperty(propertyId, options = {}) {
  return HoaBoardInvoice.findFeeSummaryRows(propertyId, options);
}

async function findOverdueRentInvoicesByLeaseIds(leaseIds, options = {}) {
  return HoaBoardInvoice.findOverdueRentByLeaseIds(leaseIds, options);
}

async function countPropertyReferences(propertyId) {
  const [invoiceCount, expenseCount, maintenanceCount] = await Promise.all([
    countInvoicesByProperty(propertyId),
    countExpensesByProperty(propertyId),
    countMaintenanceByProperty(propertyId),
  ]);
  return { invoiceCount, expenseCount, maintenanceCount };
}

async function bulkFetchPropertyListData(propertyIds, today) {
  const [
    allLeases,
    allMaintenanceCounts,
    allListings,
    unpaidSummary,
    creditEntries,
  ] = await Promise.all([
    findLeasesByPropertyIds(propertyIds),
    aggregateMaintenanceCountsByPropertyIds(propertyIds),
    findActiveListingsByPropertyIds(propertyIds),
    aggregateUnpaidSummaryByPropertyIds(propertyIds, today),
    findCreditAdjustmentsByUnitIds(propertyIds),
  ]);

  return {
    allLeases,
    allMaintenanceCounts,
    allListings,
    unpaidSummary,
    creditEntries,
  };
}

/** HOA unit list enrichment - no leases or landlord listings. */
async function bulkFetchHoaPropertyListData(propertyIds, today) {
  const [
    allMaintenanceCounts,
    unpaidSummary,
  ] = await Promise.all([
    aggregateMaintenanceCountsByPropertyIds(propertyIds),
    aggregateUnpaidSummaryByPropertyIds(propertyIds, today),
  ]);

  return {
    allMaintenanceCounts,
    unpaidSummary,
  };
}

const OPEN_MAINTENANCE_STATUSES = ['open', 'submitted', 'inprogress'];

module.exports = {
  OPEN_MAINTENANCE_STATUSES,
  extractTenantIdsFromLeases,
  findLeasesByPropertyId,
  findLeasesByPropertyIds,
  leaseExistsForProperty,
  findOverdueInvoicesByPropertyIds,
  aggregateUnpaidSummaryByPropertyIds,
  buildUnpaidSummaryMaps,
  findOverdueInvoicesByProperty,
  sumOverdueBalanceByProperty,
  aggregateMaintenanceCountsByPropertyIds,
  aggregateMaintenanceCountsByProperty,
  findMaintenanceByProperty,
  distinctPropertyIdsWithOpenMaintenance,
  findOpenMaintenanceByProperty,
  countMaintenanceByProperty,
  findActiveListingsByPropertyIds,
  findActiveListingByProperty,
  findCreditAdjustmentsByUnitIds,
  findUsersByPropertyId,
  findUsersByPropertyIds,
  findUsersByIds,
  countInvoicesByProperty,
  countExpensesByProperty,
  findInvoicesForPropertyDetail,
  findFeeInvoicesForProperty,
  findOverdueRentInvoicesByLeaseIds,
  countPropertyReferences,
  bulkFetchPropertyListData,
  bulkFetchHoaPropertyListData,
};
