/**
 * ------------------------------------------------------------------
 * File: depositRefundInvoice.service.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * invoice.controller
 * ------------------------------------------------------------------
 */

/**
 * Deposit Refund Invoice Generation Service
 *
 * Finds active leases ending in the current month, resolves each tenant's collected
 * deposit share, and creates one Miscellaneous invoice per lease with per-tenant line items.
 * Designed for cron invocation via POST /invoice/generate-deposit-refunds.
 */

const Invoice = require('../model/invoice.model');
const Lease = require('../../leasing/model/lease.model');
const User = require('../../../../../shared/modules/users/models/user.model');
const { LEASE_STATUSES, LEASE_TYPES } = require('../../../../../common/constants/lease');
const { INVOICE_TYPES } = require('../../../../../common/constants/invoice');
const { runInTransaction } = require('../../../../../common/helpers/transactionHelper');
const logger = require('../../../../../common/logger');
const { ClockService, DateUtil } = require('../../../../../common/date');
const { formatDateInAppTimezone } = require('../../../../../common/helpers/hoaBillingDates');
const {
  roundCurrency,
  getCurrentMonthRange,
  resolveTenantDepositRefunds,
  buildDepositRefundLineItems,
  buildDepositRefundInvoiceTitle,
} = require('./depositRefundInvoice.helpers');

async function loadTenantNameMap(lease, session) {
  const split = lease?.rentAndDepositDestribution?.split || [];
  const tenantIds = split.map((entry) => entry?.tenantId).filter(Boolean);
  if (!tenantIds.length) return {};

  const users = await User.find({
    _id: { $in: tenantIds },
    isDeleted: { $ne: true },
  })
    .select('firstName lastName')
    .session(session || null)
    .lean();

  return users.reduce((acc, user) => {
    acc[String(user._id)] = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Tenant';
    return acc;
  }, {});
}

async function findLeasesEndingInCurrentMonth(referenceDate = ClockService.now(), session = null) {
  const { start, end } = getCurrentMonthRange(referenceDate);
  const query = Lease.find({
    status: LEASE_STATUSES.ACTIVE,
    lease_type: LEASE_TYPES.FIXED_TERM,
    end_date: { $gte: start, $lt: end },
    isDeleted: { $ne: true },
    'depositDetails.amount': { $gt: 0 },
  })
    .populate('property_id', 'name')
    .lean();

  if (session) query.session(session);
  return query;
}

async function findDepositInvoiceForLease(leaseId, session) {
  return Invoice.findOne({
    lease_id: leaseId,
    type: INVOICE_TYPES.DEPOSIT,
    isDeleted: { $ne: true },
  })
    .sort({ createdAt: 1 })
    .session(session || null);
}

async function findExistingDepositRefundInvoice(leaseId, depositInvoiceId, session) {
  return Invoice.findOne({
    lease_id: leaseId,
    type: INVOICE_TYPES.MISCELLANEOUS,
    'metadata.isDepositRefund': true,
    'metadata.parentInvoiceId': depositInvoiceId,
    isDeleted: { $ne: true },
  }).session(session || null);
}

async function createDepositRefundInvoiceDoc(lease, depositInvoice, tenantRefunds, session) {
  const property = lease.property_id;
  if (!property?._id) {
    throw new Error('Property not found for lease');
  }

  const lineItems = buildDepositRefundLineItems(tenantRefunds, lease.end_date);
  const subAmount = roundCurrency(lineItems.reduce((sum, item) => sum + Number(item.amount || 0), 0));
  if (subAmount <= 0) {
    throw new Error('Calculated deposit refund amount must be greater than zero');
  }

  const tenantIds = tenantRefunds.map((row) => row.tenantId).filter(Boolean);
  const now = ClockService.now();
  const actorId = lease.createdBy || depositInvoice.createdBy || undefined;
  const title = buildDepositRefundInvoiceTitle(lease.end_date);

  const invoiceData = {
    type: INVOICE_TYPES.MISCELLANEOUS,
    lease_id: lease._id,
    propertyId: property._id,
    propertyName: property.name || '',
    unitId: lease.unitId,
    unit: lease.unitName || '',
    term: lease.leaseTerm || 'N/A',
    tenants: tenantIds,
    invoiceItemDetails: lineItems,
    subAmount,
    alreadyPaid: 0,
    balanceDue: subAmount,
    isPartialPaymentAllowed: Boolean(lease.rentAndDepositDestribution?.isPartialPaymentAllowed),
    dueDate: DateUtil.toUTC(lease.end_date) || DateUtil.startOfDayEST(lease.end_date),
    metadata: {
      isDepositRefund: true,
      parentInvoiceId: depositInvoice._id,
      parentInvoiceNumber: depositInvoice.invoiceId,
      generatedAt: now,
    },
    createdBy: actorId,
  };

  if (actorId) {
    invoiceData.comments = [{
      text: `${title} generated for lease ending ${formatDateInAppTimezone(lease.end_date)}. Source deposit invoice: ${depositInvoice.invoiceId || depositInvoice._id}.`,
      createdBy: actorId,
      createdAt: now,
    }];
  }

  const refundInvoice = new Invoice(invoiceData);
  await refundInvoice.validate();
  return refundInvoice.save({ session });
}

async function processDepositRefundForLease(lease, session) {
  const depositInvoice = await findDepositInvoiceForLease(lease._id, session);
  if (!depositInvoice) {
    return { success: true, skipped: true, reason: 'No deposit invoice found' };
  }

  const collected = roundCurrency(depositInvoice.alreadyPaid || 0);
  if (collected <= 0) {
    return { success: true, skipped: true, reason: 'Deposit has not been collected' };
  }

  const existing = await findExistingDepositRefundInvoice(lease._id, depositInvoice._id, session);
  if (existing) {
    return {
      success: true,
      skipped: true,
      reason: 'Deposit refund invoice already exists',
      invoiceId: existing.invoiceId || String(existing._id),
    };
  }

  const tenantNameById = await loadTenantNameMap(lease, session);
  const tenantRefunds = resolveTenantDepositRefunds(depositInvoice, lease, tenantNameById);
  if (!tenantRefunds.length) {
    return { success: true, skipped: true, reason: 'No tenant deposit shares to refund' };
  }

  const saved = await createDepositRefundInvoiceDoc(
    lease,
    depositInvoice,
    tenantRefunds,
    session
  );

  return {
    success: true,
    generated: true,
    invoiceId: saved.invoiceId || String(saved._id),
    leaseId: String(lease._id),
    subAmount: saved.subAmount,
    lineItemCount: saved.invoiceItemDetails?.length || 0,
    tenantRefunds: tenantRefunds.map((row) => ({
      tenantId: String(row.tenantId),
      tenantName: row.tenantName,
      amount: row.amount,
    })),
  };
}

/**
 * Batch entry point for cron: process all active leases ending in the current month.
 */
async function generateDepositRefundInvoices(referenceDate = ClockService.now()) {
  logger.info('[depositRefundInvoice.service] Starting deposit refund invoice generation');

  try {
    const leases = await findLeasesEndingInCurrentMonth(referenceDate);
    if (!leases.length) {
      return {
        success: true,
        message: 'No active leases ending in the current month',
        processed: 0,
        generated: 0,
        skipped: 0,
        leases: [],
      };
    }

    const results = {
      processed: 0,
      generated: 0,
      skipped: 0,
      errors: [],
      leases: [],
    };

    for (const lease of leases) {
      try {
        const result = await runInTransaction(async (session) => processDepositRefundForLease(lease, session));
        results.processed += 1;

        if (result.generated) {
          results.generated += 1;
          results.leases.push({
            leaseId: String(lease._id),
            invoiceId: result.invoiceId,
            subAmount: result.subAmount,
            lineItemCount: result.lineItemCount,
            tenantRefunds: result.tenantRefunds,
          });
        } else if (result.skipped) {
          results.skipped += 1;
          results.leases.push({
            leaseId: String(lease._id),
            skipped: true,
            reason: result.reason,
            invoiceId: result.invoiceId,
          });
        }
      } catch (error) {
        results.errors.push({ leaseId: String(lease._id), error: error.message });
        logger.error('[depositRefundInvoice.service] Failed to process lease', {
          leaseId: String(lease._id),
          error: error.message,
        });
      }
    }

    return { success: true, ...results };
  } catch (error) {
    logger.error('[depositRefundInvoice.service] Batch generation failed', { error: error.message });
    return { success: false, error: error.message, processed: 0, generated: 0, skipped: 0 };
  }
}

module.exports = {
  generateDepositRefundInvoices,
  processDepositRefundForLease,
  findLeasesEndingInCurrentMonth,
  findDepositInvoiceForLease,
  findExistingDepositRefundInvoice,
  createDepositRefundInvoiceDoc,
  loadTenantNameMap,
};
