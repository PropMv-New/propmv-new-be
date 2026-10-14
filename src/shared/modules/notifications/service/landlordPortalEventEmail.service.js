/**
 * ------------------------------------------------------------------
 * File: landlordPortalEventEmail.service.js
 * Module: Src Shared Modules Notifications Service
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * maintenance.service
 * ------------------------------------------------------------------
 */
const mongoose = require('mongoose');
const Property = require('../../../../portals/landlord/modules/property/model/property.model');
const Lease = require('../../../../portals/landlord/modules/leasing/model/lease.model');
const User = require('../../users/models/user.model');
const Application = require('../../../../portals/landlord/modules/application/models/application.model');
const Invoice = require('../../../../portals/landlord/modules/invoice/model/invoice.model');
const Income = require('../../income/model/income.model');
const Expense = require('../../expense/model/expense.model');
const logger = require('../../../../common/logger');
const {
  notifyActionUpdateInBackground,
  isMaintenanceActionUpdatePayload,
} = require('./actionUpdateEmail.service');

/**
 * as Object Id
 *
 * Performs logic operations for asObjectId.
 *
 * @param id - Request/input argument
 * @returns Operations result
 */
function asObjectId(id) {
  if (!id) return null;
  const raw = typeof id === 'object' && id._id ? id._id : id;
  const s = String(raw);
  if (!mongoose.Types.ObjectId.isValid(s) || s.length !== 24) return null;
  return new mongoose.Types.ObjectId(s);
}

function asUserIdString(id) {
  if (!id) return '';
  if (typeof id === 'object' && id._id) return String(id._id);
  const s = String(id);
  return mongoose.Types.ObjectId.isValid(s) && s.length === 24 ? s : '';
}

/**
 * extract Tenant Ids From Lease
 *
 * Performs logic operations for extractTenantIdsFromLease.
 *
 * @param lease - Request/input argument
 * @returns Operations result
 */
function extractTenantIdsFromLease(lease) {
  const split = lease?.rentAndDepositDestribution?.split || [];
  return split
    .map((row) => row?.tenantId)
    .map((tid) => (tid && typeof tid === 'object' && tid._id ? tid._id : tid))
    .filter(Boolean)
    .map(String);
}

async function getUserIdsForProperty(propertyId) {
  const pid = asObjectId(propertyId);
  if (!pid) return [];
  const property = await Property.findOne({ _id: pid, isDeleted: { $ne: true } }).select('landlord_id').lean();
  const userIds = new Set();
  if (property?.landlord_id) {
    const lid = asObjectId(property.landlord_id);
    if (lid) userIds.add(String(lid));
  }

  const leases = await Lease.find({ property_id: pid, isDeleted: { $ne: true } })
    .select('rentAndDepositDestribution')
    .lean();
  for (const lease of leases) {
    for (const tid of extractTenantIdsFromLease(lease)) userIds.add(String(tid));
  }
  return [...userIds];
}

async function getUserIdsForLease(leaseId) {
  const lid = asObjectId(leaseId);
  if (!lid) return [];
  const lease = await Lease.findOne({ _id: lid, isDeleted: { $ne: true } }).select('property_id rentAndDepositDestribution').lean();
  if (!lease) return [];
  const safePid = asObjectId(lease.property_id);
  const userIds = new Set(safePid ? await getUserIdsForProperty(safePid) : []);
  for (const tid of extractTenantIdsFromLease(lease)) userIds.add(String(tid));
  return [...userIds];
}

async function getUserIdsForTenant(tenantId) {
  const tid = asObjectId(tenantId);
  if (!tid) return [];
  const user = await User.findOne({ _id: tid, isDeleted: { $ne: true } }).select('landlordId').lean();
  const ids = new Set([String(tid)]);
  if (user?.landlordId) {
    const safeLandlordId = asObjectId(user.landlordId);
    if (safeLandlordId) ids.add(String(safeLandlordId));
  }
  return [...ids];
}

async function getUserIdsForApplication(applicationId) {
  const aid = asObjectId(applicationId);
  if (!aid) return [];
  const app = await Application.findOne({ _id: aid, isDeleted: { $ne: true } }).select('property_id tenant_id lease_id').lean();
  if (!app) return [];
  const ids = new Set();
  const appPid = asObjectId(app.property_id);
  const appLid = asObjectId(app.lease_id);
  const appTid = asObjectId(app.tenant_id);
  if (appPid) (await getUserIdsForProperty(appPid)).forEach((id) => ids.add(id));
  if (appLid) (await getUserIdsForLease(appLid)).forEach((id) => ids.add(id));
  if (appTid) ids.add(String(appTid));
  return [...ids];
}

async function getUserIdsForInvoice(invoiceId) {
  const iid = asObjectId(invoiceId);
  if (!iid) return [];
  const invoice = await Invoice.findOne({ _id: iid, isDeleted: { $ne: true } }).select('leaseId propertyId').lean();
  if (!invoice) return [];
  const invLid = asObjectId(invoice.leaseId);
  const invPid = asObjectId(invoice.propertyId);
  if (invLid) return getUserIdsForLease(invLid);
  if (invPid) return getUserIdsForProperty(invPid);
  return [];
}

async function getUserIdsForIncome(incomeId) {
  const iid = asObjectId(incomeId);
  if (!iid) return [];
  const income = await Income.findOne({ _id: iid, isDeleted: { $ne: true } }).select('propertyId').lean();
  const incPid = asObjectId(income?.propertyId);
  return incPid ? getUserIdsForProperty(incPid) : [];
}

async function getUserIdsForExpense(expenseId) {
  const eid = asObjectId(expenseId);
  if (!eid) return [];
  const expense = await Expense.findOne({ _id: eid, isDeleted: { $ne: true } }).select('propertyId').lean();
  const expPid = asObjectId(expense?.propertyId);
  return expPid ? getUserIdsForProperty(expPid) : [];
}

async function resolveTargetUserIds(target = {}) {
  const ids = new Set((target.userIds || []).map(asUserIdString).filter(Boolean));
  if (target.propertyId) (await getUserIdsForProperty(target.propertyId)).forEach((id) => ids.add(id));
  if (target.leaseId) (await getUserIdsForLease(target.leaseId)).forEach((id) => ids.add(id));
  if (target.tenantId) (await getUserIdsForTenant(target.tenantId)).forEach((id) => ids.add(id));
  if (target.applicationId) (await getUserIdsForApplication(target.applicationId)).forEach((id) => ids.add(id));
  if (target.invoiceId) (await getUserIdsForInvoice(target.invoiceId)).forEach((id) => ids.add(id));
  if (target.incomeId) (await getUserIdsForIncome(target.incomeId)).forEach((id) => ids.add(id));
  if (target.expenseId) (await getUserIdsForExpense(target.expenseId)).forEach((id) => ids.add(id));
  return [...ids];
}

/**
 * notify Landlord Portal Event In Background
 *
 * Performs logic operations for notifyLandlordPortalEventInBackground.
 *
 * @returns Operations result
 */
function notifyLandlordPortalEventInBackground({
  target = {},
  eventKey = '',
  eventMessage,
  actorUserId = null,
  entityType = '',
  entityId = '',
  metadata = {},
}) {
  if (!isMaintenanceActionUpdatePayload({ entityType, eventKey })) {
    return;
  }
  setImmediate(async () => {
    try {
      const userIds = await resolveTargetUserIds(target);
      if (userIds.length === 0) return;
      notifyActionUpdateInBackground({
        userIds,
        eventKey,
        eventMessage,
        actorUserId,
        entityType,
        entityId,
        metadata,
      });
    } catch (err) {
      logger.error('[LandlordPortalEventEmail] recipient resolution failed:', err.message);
    }
  });
}

module.exports = {
  notifyLandlordPortalEventInBackground,
  resolveTargetUserIds,
};
