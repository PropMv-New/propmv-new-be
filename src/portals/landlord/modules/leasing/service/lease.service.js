/**
 * ------------------------------------------------------------------
 * File: lease.service.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * lease.controller, leaseAutoApproval.service, leaseExport.service, leaseInvoiceSync.service
 * ------------------------------------------------------------------
 */
const mongoose = require('mongoose');

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

const Lease = require('../model/lease.model');
const Invoice = require('../../invoice/model/invoice.model');
const User = require('../../../../../shared/modules/users/models/user.model');
const { LEASE_STATUSES, LEASE_TYPES, FREQUENCY_TYPES } = require('../../../../../common/constants/lease');
const { INVOICE_TYPES, INVOICE_STATUS } = require('../../../../../common/constants/invoice');
const Property = require('../../property/model/property.model');
const { formatDateInAppTimezone } = require('../../../../../common/helpers/hoaBillingDates');
const {
  resolveUnitForPropertyId,
  leaseReferencesSameUnit,
  resolvedUnitNameForLease,
} = require('../../../../../common/helpers/propertyUnitReference');
const { seedLeaseTenantInviteAcksForLease } = require('./leaseTenantInviteAck.service');
const { runInTransaction, createOne } = require('./leaseDb.util');
const {
  findPropertyIdsByCreatedBy,
} = require('../../../../../shared/utils/creatorScope.util');
const logger = require('../../../../../common/logger');
const { syncInvoicesAfterLeaseEdit } = require('./leaseInvoiceSync.service');
const { findPaginatedLeasesForLandlordList } = require('../../../../../common/db/leaseQueryHelpers');
const { ClockService, DateUtil, MS_PER_DAY } = require('../../../../../common/date');
const {
  getDateKeyInTimeZone,
  parseDateOnlyToNoonUtc,
  isDueDateOnOrBeforeToday,
} = require('../../../../../common/helpers/hoaBillingDates');
const {
  toStoredLeaseDate,
  addYearsToStoredDate,
  assertSemiAnnualFeeDatesInTenure,
} = require('../helpers/leaseDate.helpers');

/**
 * start Of Today
 *
 * Performs logic operations for startOfToday.
 *
 * @returns Operations result
 */
function startOfToday() {
  return DateUtil.startOfDayEST(ClockService.now());
}

/**
 * start Of Day
 *
 * Performs logic operations for startOfDay.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function startOfDay(value) {
  return DateUtil.startOfDayEST(value) ?? DateUtil.toUTC(value);
}

/**
 * lease Start On Or Before Today
 *
 * Performs logic operations for leaseStartOnOrBeforeToday.
 *
 * @param startDate - Request/input argument
 * @returns Operations result
 */
function leaseStartOnOrBeforeToday(startDate) {
  if (!startDate) return false;
  return isDueDateOnOrBeforeToday(startDate, ClockService.now());
}

function isMongoObjectIdString(value) {
  const str = String(value ?? '').trim();
  return mongoose.Types.ObjectId.isValid(str) && str.length === 24;
}

/** Resolve generatedInvoices.tenantId (may be a client temp key) to lease tenant ObjectIds. */
function resolveInvoiceTenantsForGeneratedRow(row, leaseTenantIds, tenantNameById = {}) {
  const leaseTenants = (leaseTenantIds || [])
    .map((t) => (t != null ? String(t) : ''))
    .filter(Boolean);

  if (!row?.tenantId) return leaseTenants;

  const raw = String(row.tenantId).trim();
  if (isMongoObjectIdString(raw) && leaseTenants.includes(raw)) {
    return [raw];
  }

  const wantName = String(row.tenantName || '').trim().toLowerCase();
  if (wantName) {
    const match = leaseTenants.find(
      (tid) => String(tenantNameById[tid] || '').trim().toLowerCase() === wantName
    );
    if (match) return [match];
  }

  if (leaseTenants.length === 1) return leaseTenants;

  logger.warn('[lease] unresolved generatedInvoices.tenantId; attaching all lease tenants', {
    templateTenantId: raw || null,
    templateTenantName: row.tenantName || null,
    leaseTenantCount: leaseTenants.length,
  });
  return leaseTenants;
}

/**
 * normalize Generated Invoices
 *
 * Performs logic operations for normalizeGeneratedInvoices.
 *
 * @param list - Request/input argument
 * @returns Operations result
 */
function normalizeGeneratedInvoices(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr
    .map((row) => {
      const due = row && row.dueDate ? toStoredLeaseDate(row.dueDate) : null;
      // Normalize status to match INVOICE_STATUS constants (title case)
      let normalizedStatus = INVOICE_STATUS.PENDING;
      if (row?.status) {
        const statusStr = String(row.status).toLowerCase();
        if (statusStr === 'pending') normalizedStatus = INVOICE_STATUS.PENDING;
        else if (statusStr === 'paid') normalizedStatus = INVOICE_STATUS.PAID;
        else if (statusStr === 'partially paid' || statusStr === 'partially_paid') normalizedStatus = INVOICE_STATUS.PARTIALLY_PAID;
        else if (statusStr === 'overdue') normalizedStatus = INVOICE_STATUS.OVERDUE;
        else if (statusStr === 'processing') normalizedStatus = INVOICE_STATUS.PROCESSING;
      }
      const entry = {
        type: String(row?.type || '').toLowerCase(),
        description: String(row?.description || '').trim(),
        amount: Number(row?.amount || 0),
        dueDate: due && !Number.isNaN(due.getTime()) ? (getDateKeyInTimeZone(due) || '') : '',
        frequency: row?.frequency ? String(row.frequency).toLowerCase() : '',
        status: normalizedStatus,
        feeId: row?.feeId ? String(row.feeId) : '',
        feeName: row?.feeName ? String(row.feeName) : '',
      };
      // Preserve tenantId/tenantName for individual-responsibility invoices
      if (row?.tenantId) entry.tenantId = String(row.tenantId);
      if (row?.tenantName) entry.tenantName = String(row.tenantName);
      return entry;
    })
    .filter((row) => row.type && row.description && row.amount >= 0 && row.dueDate)
    .sort((a, b) =>
      a.dueDate.localeCompare(b.dueDate) ||
      a.type.localeCompare(b.type) ||
      a.description.localeCompare(b.description) ||
      a.amount - b.amount
    );
}

/**
 * has Generated Invoices Changed
 *
 * Performs logic operations for hasGeneratedInvoicesChanged.
 *
 * @param currentList - Request/input argument
 * @param nextList - Request/input argument
 * @returns Operations result
 */
function hasGeneratedInvoicesChanged(currentList, nextList) {
  return JSON.stringify(normalizeGeneratedInvoices(currentList)) !== JSON.stringify(normalizeGeneratedInvoices(nextList));
}

/**
 * get Tenant Id Set From Split
 *
 * Performs logic operations for getTenantIdSetFromSplit.
 *
 * @param split - Request/input argument
 * @returns Operations result
 */
function getTenantIdSetFromSplit(split) {
  const items = Array.isArray(split) ? split : [];
  return new Set(
    items
      .map((s) => (s && s.tenantId != null ? String(s.tenantId) : ''))
      .filter(Boolean)
  );
}

/**
 * get Tenant Delta
 *
 * Performs logic operations for getTenantDelta.
 *
 * @param existingSplit - Request/input argument
 * @param nextSplit - Request/input argument
 * @returns Operations result
 */
function getTenantDelta(existingSplit, nextSplit) {
  const current = getTenantIdSetFromSplit(existingSplit);
  const next = getTenantIdSetFromSplit(nextSplit);
  const added = [];
  const removed = [];
  for (const id of next) {
    if (!current.has(id)) added.push(id);
  }
  for (const id of current) {
    if (!next.has(id)) removed.push(id);
  }
  return { added, removed };
}

/**
 * is Eligible Lease Status For Pending Future Invoice Refresh
 *
 * Performs logic operations for isEligibleLeaseStatusForPendingFutureInvoiceRefresh.
 *
 * @param status - Request/input argument
 * @returns Operations result
 */
function isEligibleLeaseStatusForPendingFutureInvoiceRefresh(status) {
  const normalized = String(status || '').trim().toLowerCase();
  return (
    normalized === String(LEASE_STATUSES.ACTIVE).toLowerCase() ||
    normalized === String(LEASE_STATUSES.APPROVED).toLowerCase()
  );
}

/**
 * has Invoice Impacting Changes
 *
 * Performs logic operations for hasInvoiceImpactingChanges.
 *
 * @param existingLease - Request/input argument
 * @param leaseData - Request/input argument
 * @returns Operations result
 */
function hasInvoiceImpactingChanges(existingLease, leaseData) {
  const nextStartDate = leaseData.start_date ? toStoredLeaseDate(leaseData.start_date) : existingLease.start_date;
  const nextEndDate = typeof leaseData.end_date !== 'undefined'
    ? (leaseData.end_date ? toStoredLeaseDate(leaseData.end_date) : null)
    : existingLease.end_date;

  const currentStart = existingLease.start_date ? toStoredLeaseDate(existingLease.start_date) : null;
  const currentEnd = existingLease.end_date ? toStoredLeaseDate(existingLease.end_date) : null;

  const tenureChanged =
    String(existingLease.lease_type || '') !== String(leaseData.lease_type || existingLease.lease_type || '') ||
    String(getDateKeyInTimeZone(currentStart) || '') !== String(getDateKeyInTimeZone(nextStartDate) || '') ||
    String(getDateKeyInTimeZone(currentEnd) || '') !== String(getDateKeyInTimeZone(nextEndDate) || '');

  const currentRentAmount = Number(existingLease?.rentDetails?.amount || 0);
  const nextRentAmount = Number(
    typeof leaseData?.rentDetails?.amount !== 'undefined'
      ? leaseData.rentDetails.amount
      : currentRentAmount
  );
  const rentAmountChanged = currentRentAmount !== nextRentAmount;

  const currentDepositAmount = Number(existingLease?.depositDetails?.amount || 0);
  const nextDepositAmount = Number(
    typeof leaseData?.depositDetails?.amount !== 'undefined'
      ? leaseData.depositDetails.amount
      : currentDepositAmount
  );
  const depositAmountChanged = currentDepositAmount !== nextDepositAmount;

  const currentAdditionalFees = JSON.stringify(existingLease.additionalFees || []);
  const nextAdditionalFees = JSON.stringify(
    typeof leaseData.additionalFees !== 'undefined' ? (leaseData.additionalFees || []) : (existingLease.additionalFees || [])
  );
  const additionalFeesChanged = currentAdditionalFees !== nextAdditionalFees;

  const currentTenantIds = getTenantIdSetFromSplit(existingLease?.rentAndDepositDestribution?.split);
  const nextTenantIds = getTenantIdSetFromSplit(
    typeof leaseData?.rentAndDepositDestribution?.split !== 'undefined'
      ? leaseData.rentAndDepositDestribution.split
      : existingLease?.rentAndDepositDestribution?.split
  );
  let tenantsChanged = currentTenantIds.size !== nextTenantIds.size;
  if (!tenantsChanged) {
    for (const id of currentTenantIds) {
      if (!nextTenantIds.has(id)) {
        tenantsChanged = true;
        break;
      }
    }
  }

  return tenureChanged || rentAmountChanged || depositAmountChanged || additionalFeesChanged || tenantsChanged;
}

async function generateUniqueInvoiceId(_session) {
  const { generateLandlordInvoiceNumber } = require('../../invoice/helpers/invoiceId.helper');
  return generateLandlordInvoiceNumber();
}

/**
 * map Generated Type To Invoice Type
 *
 * Performs logic operations for mapGeneratedTypeToInvoiceType.
 *
 * @param type - Request/input argument
 * @returns Operations result
 */
function mapGeneratedTypeToInvoiceType(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'rent') return INVOICE_TYPES.RENT;
  if (t === 'deposit') return INVOICE_TYPES.DEPOSIT;
  return INVOICE_TYPES.OTHER;
}

async function recreatePendingFutureInvoicesFromGenerated(leaseDoc, generatedInvoices, options = {}) {
  const session = options.session;
  const today = startOfToday();
  const leaseId = leaseDoc._id;
  const normalizeDay = (d) => getDateKeyInTimeZone(d) || '';
  const normalizeText = (v) => String(v || '').trim().toLowerCase();
  const existingInvoiceIdentity = (inv) => {
    const type = String(inv?.type || '').toLowerCase();
    const day = normalizeDay(inv?.dueDate);
    const desc = normalizeText(inv?.invoiceItemDetails?.[0]?.description || inv?.invoiceItemDetails?.[0]?.invoiceItem || '');
    return `${type}|${day}|${desc}`;
  };
  const templateIdentity = (row, mappedType) => {
    const type = String(mappedType || '').toLowerCase();
    const day = normalizeDay(row?.dueDate);
    const desc = normalizeText(row?.description || '');
    return `${type}|${day}|${desc}`;
  };

  const pendingFutureFilter = {
    lease_id: leaseId,
    status: INVOICE_STATUS.PENDING,
    dueDate: { $gte: today },
  };

  // Protect already-processed future/today invoices (Paid/Partially Paid/etc)
  // from being recreated with a duplicate "same item" invoice.
  const nonPendingFutureFilter = {
    lease_id: leaseId,
    status: { $ne: INVOICE_STATUS.PENDING },
    dueDate: { $gte: today },
  };
  const protectedInvoices = session
    ? await Invoice.find({ ...nonPendingFutureFilter, isDeleted: { $ne: true } })
        .select('type dueDate invoiceItemDetails')
        .session(session)
        .lean()
    : await Invoice.find({ ...nonPendingFutureFilter, isDeleted: { $ne: true } })
        .select('type dueDate invoiceItemDetails')
        .lean();
  const protectedIdentities = new Set((protectedInvoices || []).map(existingInvoiceIdentity));

  const deleteResult = session
    ? await Invoice.deleteMany(pendingFutureFilter).session(session)
    : await Invoice.deleteMany(pendingFutureFilter);

  const leaseEnd = leaseDoc?.end_date ? startOfDay(leaseDoc.end_date) : null;
  const templates = normalizeGeneratedInvoices(generatedInvoices).filter((row) => {
    const d = toStoredLeaseDate(row.dueDate);
    if (!d || Number.isNaN(d.getTime()) || d < today) return false;
    if (leaseEnd && d > leaseEnd) return false;
    return true;
  });

  const tenantIds = Array.isArray(leaseDoc?.rentAndDepositDestribution?.split)
    ? leaseDoc.rentAndDepositDestribution.split
        .map((s) => (s && s.tenantId != null ? toObjectId(s.tenantId) : null))
        .filter(Boolean)
    : [];

  const tenantUsers = tenantIds.length
    ? (session
      ? await User.find({ _id: { $in: tenantIds }, isDeleted: { $ne: true } }).select('firstName lastName').session(session).lean()
      : await User.find({ _id: { $in: tenantIds }, isDeleted: { $ne: true } }).select('firstName lastName').lean())
    : [];
  const tenantNameById = tenantUsers.reduce((acc, t) => {
    acc[String(t._id)] = `${t.firstName || ''} ${t.lastName || ''}`.trim() || `Tenant ${String(t._id)}`;
    return acc;
  }, {});

  const buildRentLineItemsFromSplit = (totalAmount) => {
    const split = Array.isArray(leaseDoc?.rentAndDepositDestribution?.split)
      ? leaseDoc.rentAndDepositDestribution.split
      : [];
    if (!split.length) {
      return [{
        invoiceItem: INVOICE_TYPES.RENT,
        description: INVOICE_TYPES.RENT,
        quantity: 1,
        rate: totalAmount,
        amount: totalAmount,
      }];
    }

    const lineItems = split.map((entry, idx) => {
      const pct = Number(entry?.rentPercentage || 0);
      const baseAmount = pct > 0 ? (totalAmount * pct) / 100 : totalAmount / split.length;
      const amount = Number(baseAmount.toFixed(2));
      const tid = String(entry?.tenantId || '');
      const tenantName = tenantNameById[tid] || `Tenant ${idx + 1}`;
      const label = `${INVOICE_TYPES.RENT} - ${tenantName}`;
      return {
        invoiceItem: label,
        description: label,
        quantity: 1,
        rate: amount,
        amount,
      };
    });

    const sum = lineItems.reduce((s, li) => s + Number(li.amount || 0), 0);
    const drift = Number((Number(totalAmount) - sum).toFixed(2));
    if (Math.abs(drift) >= 0.01 && lineItems.length > 0) {
      const last = lineItems[lineItems.length - 1];
      const patched = Number((Number(last.amount || 0) + drift).toFixed(2));
      lineItems[lineItems.length - 1] = { ...last, amount: patched, rate: patched };
    }
    return lineItems;
  };

  let createdCount = 0;
  let skippedProtectedCount = 0;
  for (const row of templates) {
    const mappedType = mapGeneratedTypeToInvoiceType(row.type);
    const nextIdentity = templateIdentity(row, mappedType);
    if (protectedIdentities.has(nextIdentity)) {
      skippedProtectedCount += 1;
      continue;
    }

    // For individual-responsibility invoices the template carries a tenantId;
    // assign only that tenant when it resolves to a real lease user ObjectId.
    const invoiceTenants = resolveInvoiceTenantsForGeneratedRow(row, tenantIds, tenantNameById);

    const invoiceData = {
      invoiceId: await generateUniqueInvoiceId(session),
      type: mappedType,
      lease_id: leaseId,
      propertyId: leaseDoc.property_id,
      unitId: leaseDoc.unitId,
      term: leaseDoc.leaseTerm || 'N/A',
      tenants: invoiceTenants,
      // Use the exact description and amount from the stored template so the
      // generated invoice matches exactly what was shown on the UI.
      invoiceItemDetails:
        mappedType === INVOICE_TYPES.RENT && !row.tenantId
          ? buildRentLineItemsFromSplit(row.amount)
          : [{
              invoiceItem: row.description,
              description: row.description,
              quantity: 1,
              rate: row.amount,
              amount: row.amount,
            }],
      subAmount: row.amount,
      alreadyPaid: 0,
      balanceDue: row.amount,
      isPartialPaymentAllowed: !!leaseDoc?.rentAndDepositDestribution?.isPartialPaymentAllowed,
      dueDate: toStoredLeaseDate(row.dueDate),
    };

    const invoice = new Invoice(invoiceData);
    if (session) await invoice.save({ session });
    else await invoice.save();
    createdCount += 1;
  }

  return {
    deletedPendingCount: deleteResult?.deletedCount || 0,
    skippedProtectedCount,
    createdCount,
  };
}

async function regenerateFuturePendingInvoicesForLease(leaseId, options = {}) {
  if (!leaseId) {
    const err = new Error('leaseId is required');
    err.status = 400;
    throw err;
  }
  if (!options.session) {
    return runInTransaction((session) =>
      regenerateFuturePendingInvoicesForLease(leaseId, { ...options, session })
    );
  }
  const session = options.session;
  const leaseOid = toObjectId(leaseId);
  if (!leaseOid) { const err = new Error('leaseId must be a valid ObjectId'); err.status = 400; throw err; }
  const lease = session
    ? await Lease.findOne({ _id: leaseOid, isDeleted: { $ne: true } }).session(session)
    : await Lease.findOne({ _id: leaseOid, isDeleted: { $ne: true } });
  if (!lease) {
    const err = new Error('Lease not found');
    err.status = 404;
    throw err;
  }
  const templates = Array.isArray(lease.generatedInvoices) ? lease.generatedInvoices : [];
  if (!templates.length) {
    return { deletedPendingCount: 0, skippedProtectedCount: 0, createdCount: 0 };
  }
  return recreatePendingFutureInvoicesFromGenerated(lease, templates, options);
}

// Request-level input-shape validation for create/update is handled by Joi middleware
// in routes. Service assumes the payload has correct shape and required fields.

/**
 * Build invoice summary from lease data for UI display and invoice generation reference
 */
function buildInvoiceSummary(leaseData) {
  const summary = {
    rent: null,
    deposit: null,
    additionalCharges: [],
    totalMonthlyAmount: 0,
    totalOneTimeAmount: 0
  };

  // Build rent invoice summary
  if (leaseData.rentDetails) {
    summary.rent = {
      dueDate: leaseData.rentDetails.firstRentalInvoiceDue ? toStoredLeaseDate(leaseData.rentDetails.firstRentalInvoiceDue) : null,
      amount: leaseData.rentDetails.amount || 0,
      frequency: leaseData.rentDetails.frequency || 'monthly',
      description: `Rent - ${leaseData.rentDetails.frequency || 'monthly'}`
    };
    if (summary.rent.frequency === 'monthly') {
      summary.totalMonthlyAmount += summary.rent.amount;
    }
  }

  // Build deposit invoice summary
  if (leaseData.depositDetails && leaseData.depositDetails.amount > 0) {
    summary.deposit = {
      dueDate: leaseData.depositDetails.due ? toStoredLeaseDate(leaseData.depositDetails.due) : null,
      amount: leaseData.depositDetails.amount || 0,
      description: 'Security Deposit'
    };
    summary.totalOneTimeAmount += summary.deposit.amount;
  }

  // Build additional charges summary
  if (leaseData.additionalFees && Array.isArray(leaseData.additionalFees)) {
    for (const fee of leaseData.additionalFees) {
      const charge = {
        name: fee.items && fee.items[0] ? fee.items[0].name : 'Additional Charge',
        dueDate: fee.dueDate ? toStoredLeaseDate(fee.dueDate) : (fee.startDate ? toStoredLeaseDate(fee.startDate) : null),
        frequency: fee.frequency || 'one-time',
        amount: fee.totalAmount || 0,
        description: fee.items && fee.items[0] ? fee.items[0].description : 'Additional Charge',
        startDate: fee.startDate ? toStoredLeaseDate(fee.startDate) : null,
        endDate: fee.endDate ? toStoredLeaseDate(fee.endDate) : null,
        isRecurringInvoice: fee.isRecurringInvoice || false,
        lineItemOnRentalInvoice: fee.lineItemOnRentalInvoice || false
      };
      
      summary.additionalCharges.push(charge);
      
      // Add to totals
      if (fee.isRecurringInvoice && fee.frequency === 'monthly') {
        summary.totalMonthlyAmount += charge.amount;
      } else if (!fee.isRecurringInvoice) {
        summary.totalOneTimeAmount += charge.amount;
      }
    }
  }

  return summary;
}

async function createLeaseService(leaseData, options = {}) {
  logger.info('Creating lease service', { propertyId: leaseData.property_id, unitName: leaseData.unitName });
  if (!options.session) {
    return runInTransaction((session) => createLeaseService(leaseData, { session }));
  }

  // Validate and normalize additionalFees early
  if (leaseData.additionalFees && Array.isArray(leaseData.additionalFees)) {
    leaseData.additionalFees = leaseData.additionalFees.map(fee => {
      const normalizedFee = { ...fee };
      
      // Ensure frequency is set (don't default to monthly, keep as provided)
      if (normalizedFee.frequency) {
        normalizedFee.frequency = String(normalizedFee.frequency).toLowerCase();
      }
      
      // Normalize isRecurringInvoice to boolean
      if (typeof normalizedFee.isRecurringInvoice === 'string') {
        normalizedFee.isRecurringInvoice = normalizedFee.isRecurringInvoice.toLowerCase() === 'true';
      }
      
      // Normalize lineItemOnRentalInvoice to boolean
      if (typeof normalizedFee.lineItemOnRentalInvoice === 'string') {
        normalizedFee.lineItemOnRentalInvoice = normalizedFee.lineItemOnRentalInvoice.toLowerCase() === 'true';
      }
      
      return normalizedFee;
    });
  }
  
  // Validate payment frequency specific fields
  if (leaseData.rentDetails) {
    const { frequency, dueOne, dueTwo, dueWeekday, semiAnnualDates } = leaseData.rentDetails;
    
    // Validate bi-monthly requires dueTwo
    if (frequency === FREQUENCY_TYPES.BI_MONTHLY && !dueTwo) {
      const err = new Error('rentDetails.dueTwo is required for bi-monthly frequency');
      err.status = 400;
      throw err;
    }
    
    // Validate weekly/bi-weekly requires dueWeekday
    if ([FREQUENCY_TYPES.WEEKLY, FREQUENCY_TYPES.BI_WEEKLY].includes(frequency) && (dueWeekday === undefined || dueWeekday === null)) {
      const err = new Error('rentDetails.dueWeekday is required for weekly/bi-weekly frequency');
      err.status = 400;
      throw err;
    }
    
    // Validate dueWeekday is between 0-6
    if ([FREQUENCY_TYPES.WEEKLY, FREQUENCY_TYPES.BI_WEEKLY].includes(frequency) && (dueWeekday < 0 || dueWeekday > 6)) {
      const err = new Error('rentDetails.dueWeekday must be between 0 (Sunday) and 6 (Saturday)');
      err.status = 400;
      throw err;
    }
    
    // Validate semi-annually requires exactly 2 dates
    if (frequency === FREQUENCY_TYPES.SEMI_ANNUALLY) {
      if (!semiAnnualDates || !Array.isArray(semiAnnualDates) || semiAnnualDates.length !== 2) {
        const err = new Error('rentDetails.semiAnnualDates must contain exactly 2 payment dates for semi-annually frequency');
        err.status = 400;
        throw err;
      }
      
      // Validate each date has valid month and day
      for (const date of semiAnnualDates) {
        if (!date.month || date.month < 1 || date.month > 12) {
          const err = new Error('rentDetails.semiAnnualDates month must be between 1 and 12');
          err.status = 400;
          throw err;
        }
        if (!date.day || date.day < 1 || date.day > 31) {
          const err = new Error('rentDetails.semiAnnualDates day must be between 1 and 31');
          err.status = 400;
          throw err;
        }
      }
    }
  }
  
  if (leaseData.additionalFees && Array.isArray(leaseData.additionalFees) && leaseData.start_date) {
    assertSemiAnnualFeeDatesInTenure(
      leaseData.additionalFees,
      toStoredLeaseDate(leaseData.start_date),
      leaseData.end_date ? toStoredLeaseDate(leaseData.end_date) : null
    );
  }
  
  // Validate rent and deposit split percentages total to 100%
  if (leaseData.rentAndDepositDestribution && leaseData.rentAndDepositDestribution.split) {
    const totalRentPercent = leaseData.rentAndDepositDestribution.split.reduce((sum, s) => sum + (s.rentPercentage || 0), 0);
    const totalDepositPercent = leaseData.rentAndDepositDestribution.split.reduce((sum, s) => sum + (s.depositPercentage || 0), 0);
    
    if (Math.abs(totalRentPercent - 100) > 0.01) {
      const err = new Error(`Rent percentages must total 100% (currently ${totalRentPercent.toFixed(1)}%)`);
      err.status = 400;
      throw err;
    }
    
    if (Math.abs(totalDepositPercent - 100) > 0.01) {
      const err = new Error(`Deposit percentages must total 100% (currently ${totalDepositPercent.toFixed(1)}%)`);
      err.status = 400;
      throw err;
    }
  }
  
  // Input shape/required-field validation for create is performed by Joi middleware
  // (validateBody(createLeaseSchema)). Service assumes payload shape/required
  // fields are valid and focuses on business rules (uniqueness/conflict checks,
  // tenant existence, DB transactions, etc.).
  // On create, only SUBMITTED is allowed. Use the canonical LEASE_STATUSES constant.
  let statusValue = LEASE_STATUSES.SUBMITTED;
  if (typeof leaseData.status !== 'undefined' && leaseData.status !== null && leaseData.status !== '') {
    const s = String(leaseData.status).toLowerCase();
    const normalized = s.charAt(0).toUpperCase() + s.slice(1);
    if (normalized !== LEASE_STATUSES.SUBMITTED) {
      const err = new Error(`status must be ${LEASE_STATUSES.SUBMITTED} on create`);
      err.status = 400;
      logger.error(' Lease creation error - invalid status:', err.message);
      throw err;
    }
    statusValue = normalized;
  }

  // Resolve stable unit id + canonical name from property (unitId preferred over unitName).
  const resolvedUnit = await resolveUnitForPropertyId(
    leaseData.property_id,
    { unitId: leaseData.unitId, unitName: leaseData.unitName },
    options
  );
  leaseData.unitId = resolvedUnit.unitId;
  leaseData.unitName = resolvedUnit.unitName;

  // Validate tenant users (if rentAndDepositDestribution.split provided): ensure users exist and are not soft-deleted
  if (leaseData.rentAndDepositDestribution && Array.isArray(leaseData.rentAndDepositDestribution.split) && leaseData.rentAndDepositDestribution.split.length > 0) {
    const User = require('../../../../../shared/modules/users/models/user.model');
    const tenantIds = leaseData.rentAndDepositDestribution.split
      .map((s) => s && s.tenantId)
      .filter(id => id && mongoose.Types.ObjectId.isValid(id)); // Only validate ObjectIds

    if (tenantIds.length > 0) {
      const query = { _id: { $in: tenantIds } };
      // Use session if provided (from parent transaction); otherwise query committed state
      let users;
      if (options.session) {
        users = await User.find({ ...query, isDeleted: { $ne: true } }).session(options.session).lean();
      } else {
        users = await User.find({ ...query, isDeleted: { $ne: true } }).lean();
      }
      const foundIds = users.map((u) => String(u._id));
      const missing = tenantIds.filter((id) => !foundIds.includes(String(id)));
      const deleted = users.filter((u) => u.isDeleted).map((u) => String(u._id));
      const problems = [];
      if (missing.length) problems.push(`tenant user(s) not found: ${missing.join(', ')}`);
      if (deleted.length) problems.push(`tenant user(s) deleted: ${deleted.join(', ')}`);
      
      // Get owner phone to validate tenant phone numbers
      const createdBy = leaseData.created_by || (options.user && (options.user._id || options.user.id));
      const createdByOid = toObjectId(createdBy);
      if (createdByOid) {
        const owner = options.session
          ? await User.findOne({ _id: createdByOid, isDeleted: { $ne: true } }).session(options.session).select('phone').lean()
          : await User.findOne({ _id: createdByOid, isDeleted: { $ne: true } }).select('phone').lean();
        
        if (owner && owner.phone) {
          const normalizePhone = (phone) => String(phone || '').replace(/[^0-9]/g, '');
          const ownerPhoneNormalized = normalizePhone(owner.phone);
          
          for (const tenantUser of users) {
            if (tenantUser.phone) {
              const tenantPhoneNormalized = normalizePhone(tenantUser.phone);
              if (ownerPhoneNormalized && tenantPhoneNormalized && ownerPhoneNormalized === tenantPhoneNormalized) {
                problems.push(`tenant phone number cannot be the same as the owner's phone number`);
                break;
              }
            }
          }
        }
      }
      
      if (problems.length) {
        const err = new Error(problems.join('; '));
        err.status = 400;
        throw err;
      }
    }
  }

  // Build invoice summary for UI display and future reference
  const invoiceSummary = buildInvoiceSummary(leaseData);

  // Handle linkedLease field - frontend may send linkedTo or linkedLease
  const linkedLeaseId = leaseData.linkedLease || leaseData.linkedTo || undefined;
  if (linkedLeaseId) {
    logger.info('Creating lease with linkedLease field', { 
      linkedLease: linkedLeaseId, 
      linkedLeaseType: typeof linkedLeaseId 
    });
  }

  const doc = new Lease({
    property_id: leaseData.property_id,
    unitId: leaseData.unitId,
    unitName: leaseData.unitName,
    leaseTerm: leaseData.leaseTerm,
    lease_type: leaseData.lease_type,
    start_date: toStoredLeaseDate(leaseData.start_date),
    end_date: leaseData.end_date ? toStoredLeaseDate(leaseData.end_date) : undefined,
    switchMonthToMonth: leaseData.switchMonthToMonth,
    auto_renew: leaseData.auto_renew,
    rentDetails: leaseData.rentDetails || {},
    depositDetails: leaseData.depositDetails || {},
    additionalFees: leaseData.additionalFees,
    rentAndDepositDestribution: leaseData.rentAndDepositDestribution || {},
    invoiceSummary: invoiceSummary,
    // Normalize incoming generatedInvoices so statuses and dates match application constants
    generatedInvoices: normalizeGeneratedInvoices(leaseData.generatedInvoices),
    requireInsurance: typeof leaseData.requireInsurance !== 'undefined' ? leaseData.requireInsurance : false,
    includeDamageReport: typeof leaseData.includeDamageReport !== 'undefined' ? leaseData.includeDamageReport : false,
    insuranceTenantsIds: Array.isArray(leaseData.insuranceTenantsIds) ? leaseData.insuranceTenantsIds : [],
    linkedLease: linkedLeaseId, // Set linkedLease if provided (from renewal or frontend)
    status: statusValue,
  });

  if (options.session) {
    const docs = await Lease.create([doc], { session: options.session });
    logger.info('Lease created successfully', { leaseId: docs[0]._id });
    return docs[0].toObject();
  }

  const saved = await doc.save();
  logger.info('Lease created successfully', { leaseId: saved._id });
  return saved.toObject();
}

async function getLeaseByIdService(id) {
  logger.debug('Fetching lease by ID', { leaseId: id });
  if (!id) {
    const err = new Error('leaseId is required');
    err.status = 400;
    throw err;
  }
  const lease = await Lease.findOne({ _id: id, isDeleted: { $ne: true } })
    .populate('property_id', 'name address unitDetails')
    .lean();
  if (!lease) {
    logger.warn('Lease not found', { leaseId: id });
    const err = new Error('Lease not found');
    err.status = 404;
    throw err;
  }

  const prop = lease.property_id && typeof lease.property_id === 'object' ? lease.property_id : null;
  if (prop && prop.unitDetails) {
    const name = resolvedUnitNameForLease(lease, prop);
    if (name) lease.unitName = name;
  }
  
  // Manually populate tenant details since tenantId is Mixed type
  if (lease.rentAndDepositDestribution && lease.rentAndDepositDestribution.split) {
    const User = require('../../../../../shared/modules/users/models/user.model');
    const tenantIds = lease.rentAndDepositDestribution.split
      .map(split => toObjectId(split.tenantId))
      .filter(Boolean);
    
    if (tenantIds.length > 0) {
      const tenantUsers = await User.find({ _id: { $in: tenantIds }, isDeleted: { $ne: true } })
        .select('firstName lastName email phone')
        .lean();
      
      lease.rentAndDepositDestribution.split = lease.rentAndDepositDestribution.split.map(split => {
        const tenantUser = tenantUsers.find(user => String(user._id) === String(split.tenantId));
        const tenantDetails = {
          _id: split.tenantId,
          firstName: tenantUser?.firstName,
          lastName: tenantUser?.lastName,
          email: tenantUser?.email,
          phone: tenantUser?.phone,
          rentAmount: split.rentAmount,
          rentPercentage: split.rentPercentage,
          depositAmount: split.depositAmount,
          depositPercentage: split.depositPercentage
        };
        
        return {
          ...split,
          tenantId: split.tenantId, // Keep the ID for backward compatibility
          tenantDetails // Add full tenant details
        };
      });
    } else {
      // If no valid tenant IDs, still add tenantDetails structure
      lease.rentAndDepositDestribution.split = lease.rentAndDepositDestribution.split.map(split => ({
        ...split,
        tenantDetails: {
          _id: split.tenantId,
          firstName: null,
          lastName: null,
          email: null,
          phone: null,
          rentAmount: split.rentAmount,
          rentPercentage: split.rentPercentage,
          depositAmount: split.depositAmount,
          depositPercentage: split.depositPercentage
        }
      }));
    }
  }
  
  return lease;
}

async function listLeasesService(query = {}) {
  const filter = { isDeleted: { $ne: true } };
  if (query.property_id) { const oid = toObjectId(query.property_id); if (oid) filter.property_id = oid; }
  if (query.unitId) { const oid = toObjectId(query.unitId); if (oid) filter.unitId = oid; }
  if (query.unitName) filter.unitName = query.unitName;
  if (query.status) filter.status = query.status;

  // Get standardized pagination parameters
  const { getPagination } = require('../../../../../common/helpers/paginationHelper');
  const { pageNumber = 1, pageSize } = query;
  const { offset, limit: effectiveLimit, page, pageSize: effectivePageSize } = getPagination({
    page: pageNumber,
    pageSize
  });

  // Execute paginated query
  const [leases, total] = await Promise.all([
    Lease.find(filter)
      .sort('-createdAt')
      .skip(offset)
      .limit(effectiveLimit)
      .lean(),
    Lease.countDocuments(filter)
  ]);

  return {
    data: leases,
    total,
    page,
    pageSize: effectivePageSize
  };
}

async function updateLeaseService(id, leaseData, options = {}) {
  logger.info('Updating lease service', { leaseId: id });
  if (!id) {
    const err = new Error('leaseId is required');
    err.status = 400;
    throw err;
  }

  if (!options.session) {
    return runInTransaction((session) => updateLeaseService(id, leaseData, { session }));
  }

  // Validate and normalize additionalFees early
  if (leaseData.additionalFees && Array.isArray(leaseData.additionalFees)) {
    leaseData.additionalFees = leaseData.additionalFees.map(fee => {
      const normalizedFee = { ...fee };
      
      // Ensure frequency is set (don't default to monthly, keep as provided)
      if (normalizedFee.frequency) {
        normalizedFee.frequency = String(normalizedFee.frequency).toLowerCase();
      }
      
      // Normalize isRecurringInvoice to boolean
      if (typeof normalizedFee.isRecurringInvoice === 'string') {
        normalizedFee.isRecurringInvoice = normalizedFee.isRecurringInvoice.toLowerCase() === 'true';
      }
      
      // Normalize lineItemOnRentalInvoice to boolean
      if (typeof normalizedFee.lineItemOnRentalInvoice === 'string') {
        normalizedFee.lineItemOnRentalInvoice = normalizedFee.lineItemOnRentalInvoice.toLowerCase() === 'true';
      }
      
      return normalizedFee;
    });
  }

  // Validate payment frequency specific fields if rentDetails is being updated
  if (leaseData.rentDetails) {
    const { frequency, dueOne, dueTwo, dueWeekday, semiAnnualDates } = leaseData.rentDetails;
    
    // Validate bi-monthly requires dueTwo
    if (frequency === FREQUENCY_TYPES.BI_MONTHLY && !dueTwo) {
      const err = new Error('rentDetails.dueTwo is required for bi-monthly frequency');
      err.status = 400;
      throw err;
    }
    
    // Validate weekly/bi-weekly requires dueWeekday
    if ([FREQUENCY_TYPES.WEEKLY, FREQUENCY_TYPES.BI_WEEKLY].includes(frequency) && (dueWeekday === undefined || dueWeekday === null)) {
      const err = new Error('rentDetails.dueWeekday is required for weekly/bi-weekly frequency');
      err.status = 400;
      throw err;
    }
    
    // Validate dueWeekday is between 0-6
    if ([FREQUENCY_TYPES.WEEKLY, FREQUENCY_TYPES.BI_WEEKLY].includes(frequency) && (dueWeekday < 0 || dueWeekday > 6)) {
      const err = new Error('rentDetails.dueWeekday must be between 0 (Sunday) and 6 (Saturday)');
      err.status = 400;
      throw err;
    }
    
    // Validate semi-annually requires exactly 2 dates
    if (frequency === FREQUENCY_TYPES.SEMI_ANNUALLY) {
      if (!semiAnnualDates || !Array.isArray(semiAnnualDates) || semiAnnualDates.length !== 2) {
        const err = new Error('rentDetails.semiAnnualDates must contain exactly 2 payment dates for semi-annually frequency');
        err.status = 400;
        throw err;
      }
      
      // Validate each date has valid month and day
      for (const date of semiAnnualDates) {
        if (!date.month || date.month < 1 || date.month > 12) {
          const err = new Error('rentDetails.semiAnnualDates month must be between 1 and 12');
          err.status = 400;
          throw err;
        }
        if (!date.day || date.day < 1 || date.day > 31) {
          const err = new Error('rentDetails.semiAnnualDates day must be between 1 and 31');
          err.status = 400;
          throw err;
        }
      }
    }
  }
  
  if (leaseData.additionalFees && Array.isArray(leaseData.additionalFees)) {
    const opts = {};
    if (options.session) opts.session = options.session;
    const idOid = toObjectId(id);
    if (!idOid) { const err = new Error('leaseId must be a valid ObjectId'); err.status = 400; throw err; }
    const existingLease = await Lease.findOne({ _id: idOid, isDeleted: { $ne: true } }, null, opts);

    if (existingLease) {
      assertSemiAnnualFeeDatesInTenure(
        leaseData.additionalFees,
        toStoredLeaseDate(leaseData.start_date || existingLease.start_date),
        (leaseData.end_date || existingLease.end_date)
          ? toStoredLeaseDate(leaseData.end_date || existingLease.end_date)
          : null
      );
    }
  }
  
  // Validate rent and deposit split percentages total to 100% if being updated
  if (leaseData.rentAndDepositDestribution && leaseData.rentAndDepositDestribution.split) {
    const totalRentPercent = leaseData.rentAndDepositDestribution.split.reduce((sum, s) => sum + (s.rentPercentage || 0), 0);
    const totalDepositPercent = leaseData.rentAndDepositDestribution.split.reduce((sum, s) => sum + (s.depositPercentage || 0), 0);
    
    if (Math.abs(totalRentPercent - 100) > 0.01) {
      const err = new Error(`Rent percentages must total 100% (currently ${totalRentPercent.toFixed(1)}%)`);
      err.status = 400;
      throw err;
    }
    
    if (Math.abs(totalDepositPercent - 100) > 0.01) {
      const err = new Error(`Deposit percentages must total 100% (currently ${totalDepositPercent.toFixed(1)}%)`);
      err.status = 400;
      throw err;
    }
  }

  // Validate tenant users (if rentAndDepositDestribution.split provided): ensure users exist and are not soft-deleted
  if (leaseData.rentAndDepositDestribution && Array.isArray(leaseData.rentAndDepositDestribution.split) && leaseData.rentAndDepositDestribution.split.length > 0) {
    const User = require('../../../../../shared/modules/users/models/user.model');
    const tenantIds = leaseData.rentAndDepositDestribution.split
      .map((s) => s && toObjectId(s.tenantId))
      .filter(Boolean);

    if (tenantIds.length > 0) {
      const query = { _id: { $in: tenantIds } };
      const users = options.session
        ? await User.find({ ...query, isDeleted: { $ne: true } }).session(options.session).lean()
        : await User.find({ ...query, isDeleted: { $ne: true } }).lean();
      const foundIds = users.map((u) => String(u._id));
      const missing = tenantIds.filter((id) => !foundIds.includes(String(id)));
      const deleted = users.filter((u) => u.isDeleted).map((u) => String(u._id));
      const problems = [];
      if (missing.length) problems.push(`tenant user(s) not found: ${missing.join(', ')}`);
      if (deleted.length) problems.push(`tenant user(s) deleted: ${deleted.join(', ')}`);

      const createdBy = leaseData.created_by || (options.user && (options.user._id || options.user.id));
      const createdByOid = toObjectId(createdBy);
      if (createdByOid) {
        const owner = options.session
          ? await User.findOne({ _id: createdByOid, isDeleted: { $ne: true } }).session(options.session).select('phone').lean()
          : await User.findOne({ _id: createdByOid, isDeleted: { $ne: true } }).select('phone').lean();

        if (owner && owner.phone) {
          const normalizePhone = (phone) => String(phone || '').replace(/[^0-9]/g, '');
          const ownerPhoneNormalized = normalizePhone(owner.phone);
          for (const tenantUser of users) {
            if (tenantUser.phone) {
              const tenantPhoneNormalized = normalizePhone(tenantUser.phone);
              if (ownerPhoneNormalized && tenantPhoneNormalized && ownerPhoneNormalized === tenantPhoneNormalized) {
                problems.push(`tenant phone number cannot be the same as the owner's phone number`);
                break;
              }
            }
          }
        }
      }

      if (problems.length) {
        const err = new Error(problems.join('; '));
        err.status = 400;
        throw err;
      }
    }
  }

  // Validate status if provided: must be a known status (model enum)
  if (typeof leaseData.status !== 'undefined' && leaseData.status !== null && leaseData.status !== '') {
    const s = String(leaseData.status).toLowerCase();
    const normalized = s.charAt(0).toUpperCase() + s.slice(1);
    const allowed = Object.values(LEASE_STATUSES);
    if (!allowed.includes(normalized)) {
      const err = new Error(`status must be one of: ${allowed.join(', ')}`);
      err.status = 400;
      throw err;
    }
    // overwrite with normalized
    leaseData.status = normalized;
  }

  const opts = {};
  if (options.session) opts.session = options.session;

  const updateLeaseOid = toObjectId(id);
  if (!updateLeaseOid) { const err = new Error('leaseId must be a valid ObjectId'); err.status = 400; throw err; }
  const lease = await Lease.findOne({ _id: updateLeaseOid, isDeleted: { $ne: true } }, null, opts);
  if (!lease) {
    const err = new Error('Lease not found');
    err.status = 404;
    throw err;
  }

  // Snapshot before in-place mutation - used by post-edit invoice sync for before/after comparisons.
  const leaseSnapshotBeforeUpdate = lease.toObject();

  // Business rule: Only one ACTIVE lease should exist for a given property unit.
  const finalStatus = typeof leaseData.status !== 'undefined' && leaseData.status !== null && leaseData.status !== '' ? leaseData.status : lease.status;
  const finalPropertyId = typeof leaseData.property_id !== 'undefined' && leaseData.property_id !== null ? leaseData.property_id : lease.property_id;
  const mergedUnitId = typeof leaseData.unitId !== 'undefined' ? leaseData.unitId : lease.unitId;
  const mergedUnitName = typeof leaseData.unitName !== 'undefined' ? leaseData.unitName : lease.unitName;

  const resolvedUnit = await resolveUnitForPropertyId(
    finalPropertyId,
    { unitId: mergedUnitId, unitName: mergedUnitName },
    options
  );
  leaseData.unitId = resolvedUnit.unitId;
  leaseData.unitName = resolvedUnit.unitName;

  // Conflict check removed - frontend handles lease creation validation

  const isEligibleLeaseForInvoiceRefresh = isEligibleLeaseStatusForPendingFutureInvoiceRefresh(lease.status);
  const invoiceImpactingChanges = hasInvoiceImpactingChanges(lease, leaseData);
  const generatedInvoicesProvided = Array.isArray(leaseData.generatedInvoices);
  const nextGeneratedInvoices = generatedInvoicesProvided ? (leaseData.generatedInvoices || []) : (lease.generatedInvoices || []);
  const tenantDelta = getTenantDelta(
    lease?.rentAndDepositDestribution?.split,
    typeof leaseData?.rentAndDepositDestribution?.split !== 'undefined'
      ? leaseData.rentAndDepositDestribution.split
      : lease?.rentAndDepositDestribution?.split
  );
  const hasAddedTenants = tenantDelta.added.length > 0;
  const generatedScheduleChanged = hasGeneratedInvoicesChanged(
    lease.generatedInvoices || [],
    nextGeneratedInvoices
  );
  const shouldRegenerateFuturePendingInvoices =
    isEligibleLeaseForInvoiceRefresh &&
    generatedScheduleChanged &&
    Array.isArray(nextGeneratedInvoices) &&
    nextGeneratedInvoices.length > 0 &&
    !hasAddedTenants;

  // update allowed fields (expecting full body similar to create)
  lease.property_id = leaseData.property_id;
  lease.unitId = leaseData.unitId;
  lease.unitName = leaseData.unitName;
  lease.leaseTerm = typeof leaseData.leaseTerm !== 'undefined' ? leaseData.leaseTerm : lease.leaseTerm;
  lease.lease_type = leaseData.lease_type;
  lease.start_date = leaseData.start_date ? toStoredLeaseDate(leaseData.start_date) : lease.start_date;
  lease.end_date = typeof leaseData.end_date !== 'undefined' ? (leaseData.end_date ? toStoredLeaseDate(leaseData.end_date) : null) : lease.end_date;
  lease.switchMonthToMonth = typeof leaseData.switchMonthToMonth !== 'undefined' ? leaseData.switchMonthToMonth : lease.switchMonthToMonth;
  lease.auto_renew = typeof leaseData.auto_renew !== 'undefined' ? leaseData.auto_renew : lease.auto_renew;
  lease.rentDetails = typeof leaseData.rentDetails !== 'undefined' ? leaseData.rentDetails : lease.rentDetails;
  lease.depositDetails = typeof leaseData.depositDetails !== 'undefined' ? leaseData.depositDetails : lease.depositDetails;
  lease.additionalFees = typeof leaseData.additionalFees !== 'undefined' ? leaseData.additionalFees : lease.additionalFees;
  lease.rentAndDepositDestribution = typeof leaseData.rentAndDepositDestribution !== 'undefined' ? leaseData.rentAndDepositDestribution : lease.rentAndDepositDestribution;
  // Normalize generatedInvoices to ensure status values align with INVOICE_STATUS constants
  lease.generatedInvoices = typeof leaseData.generatedInvoices !== 'undefined'
    ? normalizeGeneratedInvoices(leaseData.generatedInvoices)
    : lease.generatedInvoices;
  // Update insurance fields
  lease.requireInsurance = typeof leaseData.requireInsurance !== 'undefined' ? leaseData.requireInsurance : lease.requireInsurance;
  lease.insuranceTenantsIds = typeof leaseData.insuranceTenantsIds !== 'undefined' ? leaseData.insuranceTenantsIds : lease.insuranceTenantsIds;
  if (typeof leaseData.status !== 'undefined') lease.status = leaseData.status;

  const wasActive =
    String(leaseSnapshotBeforeUpdate.status).toLowerCase() ===
    String(LEASE_STATUSES.ACTIVE).toLowerCase();
  const wasApproved =
    String(leaseSnapshotBeforeUpdate.status).toLowerCase() ===
    String(LEASE_STATUSES.APPROVED).toLowerCase();
  const requestedStatus =
    typeof leaseData.status !== 'undefined' && leaseData.status !== null && leaseData.status !== ''
      ? leaseData.status
      : leaseSnapshotBeforeUpdate.status;
  const requestedStatusLower = String(requestedStatus).toLowerCase();
  const isActiveLeaseContext =
    wasActive ||
    wasApproved ||
    requestedStatusLower === String(LEASE_STATUSES.ACTIVE).toLowerCase() ||
    requestedStatusLower === String(LEASE_STATUSES.APPROVED).toLowerCase();

  if (isActiveLeaseContext) {
    lease.status = leaseStartOnOrBeforeToday(lease.start_date)
      ? LEASE_STATUSES.ACTIVE
      : LEASE_STATUSES.APPROVED;
  }

  const saved = await lease.save(opts);

  // Same as create flow: ensure each invite-path tenant has an ack row (upsert, idempotent).
  // Updates that add tenants were missing this, so acknowledge/onboarding could not find rows.
  await seedLeaseTenantInviteAcksForLease(saved, options);

  let regenerationResult = null;
  if (shouldRegenerateFuturePendingInvoices) {
    logger.info('Regenerating future pending invoices', { leaseId: id });
    regenerationResult = await recreatePendingFutureInvoicesFromGenerated(saved, nextGeneratedInvoices, options);
  }

  const isEligibleForSync = isEligibleLeaseForInvoiceRefresh;
  const tenantsChanged = tenantDelta.added.length > 0 || tenantDelta.removed.length > 0;
  const partialPaymentChanged =
    !!leaseSnapshotBeforeUpdate?.rentAndDepositDestribution?.isPartialPaymentAllowed !==
    !!saved?.rentAndDepositDestribution?.isPartialPaymentAllowed;
  if (
    isEligibleForSync &&
    (invoiceImpactingChanges || tenantsChanged || regenerationResult || partialPaymentChanged)
  ) {
    logger.info('Running post-edit invoice sync', { leaseId: id, tenantsChanged, invoiceImpactingChanges });
    await syncInvoicesAfterLeaseEdit(
      leaseSnapshotBeforeUpdate,
      saved.toObject ? saved.toObject() : saved,
      {
        tenantDelta,
        regenerationResult,
        actorId: options.actorId || null,
      },
      options
    );
  }

  logger.info('Lease updated successfully', { leaseId: id });
  return saved.toObject();
}

async function deleteLeaseService(id, options = {}) {
  if (!id) {
    const err = new Error('leaseId is required');
    err.status = 400;
    throw err;
  }

  if (!options.session) {
    return runInTransaction((session) => deleteLeaseService(id, { session }));
  }

  const opts = {};
  if (options.session) opts.session = options.session;

  const deleted = await Lease.findByIdAndUpdate(id, { isDeleted: true }, { ...opts, new: true });
  if (!deleted) {
    const err = new Error('Lease not found');
    err.status = 404;
    throw err;
  }

  return deleted.toObject();
}

/**
 * Terminates a lease by updating its status to Terminated
 * @param {string} id - The ID of the lease to terminate
 * @param {Object} options - Additional options like session for transactions
 * @returns {Promise<Object>} The updated lease object
 */
async function terminateLeaseService(id, options = {}) {
  if (!id) {
    const err = new Error('leaseId is required');
    err.status = 400;
    throw err;
  }

  if (!options.session) {
    return runInTransaction((session) => terminateLeaseService(id, { session }));
  }

  const opts = {};
  if (options.session) opts.session = options.session;

  // Find and update the lease status to Terminated
  const terminateLeaseOid = toObjectId(id);
  if (!terminateLeaseOid) { const err = new Error('leaseId must be a valid ObjectId'); err.status = 400; throw err; }
  const lease = await Lease.findOne({ _id: terminateLeaseOid, isDeleted: { $ne: true } }, null, opts);
  if (!lease) {
    const err = new Error('Lease not found');
    err.status = 404;
    throw err;
  }

  // Can terminate Active, Approved (future start), or Expired leases
  if (
    lease.status !== LEASE_STATUSES.ACTIVE &&
    lease.status !== LEASE_STATUSES.EXPIRED &&
    lease.status !== LEASE_STATUSES.APPROVED
  ) {
    const err = new Error('Only Active, Approved, or Expired leases can be terminated');
    err.status = 400;
    throw err;
  }

  lease.status = LEASE_STATUSES.TERMINATED;
  const updated = await lease.save(opts);
  return updated.toObject();
}

/**
 * Terminate a lease and optionally append a termination comment in one transaction.
 */
async function terminateLeaseWithCommentService(leaseId, { comment = '', actorId = null } = {}, options = {}) {
  if (!leaseId) {
    const err = new Error('leaseId is required');
    err.status = 400;
    throw err;
  }

  const execute = async (session) => {
    const txnOpts = { session };
    if (comment && String(comment).trim()) {
      await addCommentToLeaseService(leaseId, String(comment).trim(), 'terminate', actorId, txnOpts);
    }
    return terminateLeaseService(leaseId, txnOpts);
  };

  if (options.session) {
    return execute(options.session);
  }
  return runInTransaction(execute);
}

/**
 * Renew a lease (extend in place or terminate old + create new) atomically.
 */
async function renewLeaseService(leaseId, { type, leaseData = {} } = {}, options = {}) {
  logger.info('Renewing lease', { leaseId, type });
  if (!leaseId) {
    const err = new Error('leaseId is required');
    err.status = 400;
    throw err;
  }
  if (!type) {
    const err = new Error('renew type is required');
    err.status = 400;
    throw err;
  }

  const execute = async (session) => {
    const txnOpts = { session };
    if (type === 'Renew And Extend') {
      logger.info('Renewing and extending lease', { leaseId });
      return updateLeaseService(leaseId, leaseData, txnOpts);
    }
    if (type === 'Renew With New Lease') {
      logger.info('Renewing with new lease', { leaseId });
      
      // Convert leaseId to ObjectId if it's a string
      const linkedLeaseId = mongoose.Types.ObjectId.isValid(leaseId) 
        ? (typeof leaseId === 'string' ? new mongoose.Types.ObjectId(leaseId) : leaseId)
        : leaseId;
      
      logger.info('Setting linkedLease field', { linkedLeaseId, leaseIdType: typeof linkedLeaseId });
      
      await terminateLeaseService(leaseId, txnOpts);
      const newLeaseData = { ...leaseData };
      
      // Set linkedLease field to reference the expired lease
      newLeaseData.linkedLease = linkedLeaseId;
      
      logger.info('New lease data prepared', { hasLinkedLease: !!newLeaseData.linkedLease });
      
      if (newLeaseData.depositDetails) {
        newLeaseData.depositDetails = { ...newLeaseData.depositDetails, isDepositAlreadyCollected: false };
      }
      const pendingInvoices = (newLeaseData.generatedInvoices || []).filter(inv => inv.status !== 'Paid' && inv.status !== 'paid');
      newLeaseData.generatedInvoices = pendingInvoices;
      return createLeaseService(newLeaseData, txnOpts);
    }
    const err = new Error(`Unsupported renew type: ${type}`);
    err.status = 400;
    throw err;
  };

  if (options.session) {
    return execute(options.session);
  }
  return runInTransaction(execute);
}

async function addCommentToLeaseService(leaseId, text, action = 'comment', createdBy = null, options = {}) {
  if (!leaseId) throw Object.assign(new Error('leaseId is required'), { status: 400 });
  if (!text || !String(text).trim()) throw Object.assign(new Error('comment text is required'), { status: 400 });
  const safeCommentLeaseId = toObjectId(leaseId);
  if (!safeCommentLeaseId) throw Object.assign(new Error('Invalid leaseId'), { status: 400 });

  if (!options.session) {
    return runInTransaction((session) =>
      addCommentToLeaseService(leaseId, text, action, createdBy, { session })
    );
  }

  const opts = {};
  if (options.session) opts.session = options.session;
  const lease = await Lease.findOne({ _id: safeCommentLeaseId, isDeleted: { $ne: true } }, null, opts);
  if (!lease) throw Object.assign(new Error('Lease not found'), { status: 404 });
  lease.comments = lease.comments || [];
  lease.comments.push({
    text: String(text).trim(),
    action,
    createdBy: createdBy || undefined,
    createdAt: ClockService.now(),
  });
  await lease.save(opts);
  return lease;
}

// Add a note to a lease, with file uploads
async function addNoteToLeaseService(leaseId, description, files = [], userId = null) {
  if (!leaseId) throw Object.assign(new Error('leaseId is required'), { status: 400 });
  if (!description || typeof description !== 'string') throw Object.assign(new Error('description is required'), { status: 400 });

  // Allowed file extensions and max size
  const allowedExts = ['.jpg', '.jpeg', '.png', '.pdf', '.doc', '.docx', '.txt', '.xlsx', '.xls'];
  const maxSize = 20 * 1024 * 1024; // 20MB
  const path = require('path');
  const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
  const s3Client = require('../../../../../integrations/s3');
  const config = require('../../../../../config/default');
  const UPLOAD_LEASE_SUBDIR = require('../../../../../common/constants/uploads').UPLOAD_LEASE_SUBDIR || 'lease-documents';
  const uploadedFiles = [];

  for (const f of files) {
    const ext = path.extname(f.originalname || f.filename || '').toLowerCase();
    if (!allowedExts.includes(ext)) throw Object.assign(new Error(`File extension ${ext} not allowed`), { status: 400 });
    if (f.size > maxSize) throw Object.assign(new Error(`File ${f.originalname || f.filename} exceeds max size 20MB`), { status: 400 });

    const key = s3Client.getKeyForLease
      ? s3Client.getKeyForLease(leaseId, f.originalname || f.filename, userId)
      : `${UPLOAD_LEASE_SUBDIR}/${leaseId}/${Date.now()}_${f.originalname || f.filename}`;
    const result = await s3Client.upload({ localFilePath: f.path, key });
    uploadedFiles.push({ file: f, key: result.Key || key, result });
  }

  try {
    return await runInTransaction(async (session) => {
      const uploadedMetaIds = [];
      const bucketName = config.s3 && config.s3.bucket ? config.s3.bucket : (process.env.S3_BUCKET || 'mock-bucket');
      const region = config.s3 && config.s3.region ? config.s3.region : (process.env.AWS_REGION || 'mock-region');

      for (const { file: f, key, result } of uploadedFiles) {
        const metadataDoc = await createOne(
          DocumentMetadata,
          {
            key,
            bucketName,
            region,
            size: f.size || 0,
            contentType: f.mimetype || 'application/octet-stream',
            originalName: f.originalname || f.filename,
            s3Location: result.Location || (s3Client.baseUrl ? `${s3Client.baseUrl}/${key}` : `/${key}`),
          },
          session
        );
        uploadedMetaIds.push(metadataDoc._id);
      }

      const lease = await Lease.findOne({ _id: leaseId, isDeleted: { $ne: true } }).session(session);
      if (!lease) throw Object.assign(new Error('Lease not found'), { status: 404 });
      lease.notes = lease.notes || [];
      lease.notes.push({ description, attachments: uploadedMetaIds });
      await lease.save({ session });
      return lease;
    });
  } catch (dbErr) {
    for (const { key } of uploadedFiles) {
      try {
        await s3Client.delete({ key });
      } catch (delErr) {
        logger.warn('[Lease] Failed to delete S3 object after note DB failure:', delErr?.message);
      }
    }
    throw dbErr;
  }
}

/**
 * List leases for an owner based on status category with pagination.
 * Input: { createdBy, status, propertyId, from, to, pageNumber, pageSize }
 * status values supported:
 *  - Active
 *  - Submitted
 *  - FutureLease (Active and start_date > today)
 *  - Expiring90 (Active and end_date within next 90 days)
 *  - Expired
 *  - Terminated
 * propertyId: filter by specific property
 * from: start date filter
 * to: end date filter
 * Date filter logic:
 *  - If only 'to' is provided: filter from start of 'to' year to 'to' date
 *  - If only 'from' is provided: filter from 'from' date to current date
 *  - If both provided: filter between 'from' and 'to'
 * @returns {Promise<{data: Array, total: number, page: number, pageSize: number}>}
 */
function isValidLeaseListDateInput(val) {
  if (!val && val !== '') return false;
  try {
    const s = String(val).trim();
    if (!s) return false;
    const candidate = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000Z` : s;
    return DateUtil.toUTC(candidate) != null;
  } catch (e) {
    return false;
  }
}

/**
 * parse Lease List Utc Day Start
 *
 * Performs logic operations for parseLeaseListUtcDayStart.
 *
 * @param dateStr - Request/input argument
 * @returns Operations result
 */
function parseLeaseListUtcDayStart(dateStr) {
  const s = String(dateStr || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return DateUtil.toUTC(`${s}T00:00:00.000Z`);
  }
  return DateUtil.toUTC(s);
}

/**
 * parse Lease List Utc Day End
 *
 * Performs logic operations for parseLeaseListUtcDayEnd.
 *
 * @param dateStr - Request/input argument
 * @returns Operations result
 */
function parseLeaseListUtcDayEnd(dateStr) {
  const s = String(dateStr || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return DateUtil.toUTC(`${s}T23:59:59.999Z`);
  }
  const parsed = DateUtil.toUTC(s);
  if (!parsed) return null;
  parsed.setUTCHours(23, 59, 59, 999);
  return parsed;
}

/** Leases whose tenure overlaps the inclusive UTC day range [from, to]. */
function buildLeaseListTenureDateFilter(from, to) {
  if ((from && !isValidLeaseListDateInput(from)) || (to && !isValidLeaseListDateInput(to))) {
    throw Object.assign(new Error('Invalid date format for "from" or "to" query parameter'), { status: 400 });
  }

  let rangeStart = null;
  let rangeEnd = null;

  if (to && !from) {
    const end = parseLeaseListUtcDayEnd(to);
    if (end) {
      rangeStart = DateUtil.fromEpoch(Date.UTC(end.getUTCFullYear(), 0, 1, 0, 0, 0, 0));
      rangeEnd = end;
    }
  } else if (from && !to) {
    rangeStart = parseLeaseListUtcDayStart(from);
    rangeEnd = parseLeaseListUtcDayEnd(DateUtil.toISO(ClockService.now()).slice(0, 10));
  } else if (from && to) {
    rangeStart = parseLeaseListUtcDayStart(from);
    rangeEnd = parseLeaseListUtcDayEnd(to);
  }

  if (!rangeStart || !rangeEnd) {
    return {};
  }

  return {
    start_date: { $lte: rangeEnd },
    $or: [
      { end_date: { $gte: rangeStart } },
      { end_date: null },
      { lease_type: LEASE_TYPES.MONTH_TO_MONTH },
    ],
  };
}

async function listLeasesByLandlordService({ createdBy, status, propertyId, from, to, search, pageNumber, pageSize }) {
  logger.debug('Listing leases by landlord', { createdBy, status, propertyId, search });
  if (!createdBy) {
    const err = new Error('createdBy is required');
    err.status = 400;
    throw err;
  }

  // 1) fetch properties for landlord (excluding deleted properties)
  let propertyIds = await findPropertyIdsByCreatedBy(Property, createdBy);
  if (propertyId) {
    const propertyIdStr = String(propertyId);
    propertyIds = propertyIds.filter((id) => String(id) === propertyIdStr);
  }
  if (!propertyIds || propertyIds.length === 0) {
    return {
      data: [],
      total: 0,
      page: 1,
      pageSize: 10
    };
  }

  // 2) build lease filter based on requested status
  const filter = { property_id: { $in: propertyIds }, isDeleted: { $ne: true } };

  // Apply search filter across tenant names, property name, unit name
  // (tenant name matching is done post-query via the transformed data; property/unit matched here)
  if (search && String(search).trim()) {
    const searchRegex = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [
      { unitName: searchRegex },
      { leaseTerm: searchRegex },
    ];
  }

  // Apply date filters - show leases whose tenure overlaps the selected range
  const tenureDateFilter = buildLeaseListTenureDateFilter(from, to);
  if (Object.keys(tenureDateFilter).length > 0) {
    filter.$and = [...(filter.$and || []), tenureDateFilter];
  }

  const now = ClockService.now();
  const in90 = DateUtil.fromEpoch(ClockService.nowEpoch() + 90 * MS_PER_DAY);

  switch ((status || '').toLowerCase()) {
    case 'draft':
    case 'submitted':
      filter.status = LEASE_STATUSES.SUBMITTED;
      break;
    case 'active':
      filter.status = LEASE_STATUSES.ACTIVE;
      break;
    case 'inprocess':
    case 'in-process':
    case 'in_process':
      filter.status = LEASE_STATUSES.SUBMITTED;
      break;
    case 'futurelease':
    case 'future-lease':
    case 'future_lease':
      filter.$or = [
        { status: LEASE_STATUSES.ACTIVE, start_date: { $gt: now } },
        { status: LEASE_STATUSES.APPROVED, start_date: { $gt: now } },
      ];
      break;
    case 'expiring90':
    case 'expiring-90':
    case 'expiring_90':
      filter.status = LEASE_STATUSES.ACTIVE;
      filter.end_date = { $gte: now, $lte: in90 };
      break;
    case 'expired':
      filter.status = LEASE_STATUSES.EXPIRED;
      break;
    case 'terminated':
      filter.status = LEASE_STATUSES.TERMINATED;
      break;
    case 'approved':
      filter.status = LEASE_STATUSES.APPROVED;
      break;
    case 'rejected':
      filter.status = LEASE_STATUSES.REJECTED;
      break;
    default:
      // if no status provided, return all leases for owner properties
      break;
  }

  // Get standardized pagination parameters
  const { getPagination } = require('../../../../../common/helpers/paginationHelper');
  const { offset, limit: effectiveLimit, page, pageSize: effectivePageSize } = getPagination({
    page: pageNumber,
    pageSize
  });

  // Execute paginated query and get counts for different lease categories
  const in90Days = DateUtil.fromEpoch(ClockService.nowEpoch() + 90 * MS_PER_DAY);

  const listingFilter = filter;

  const [
    leases, 
    total, 
    activeLeaseCount,
    inProcessLeaseCount,
    futureLeaseCount,
    expiringInNext90Days,
    expiredLease,
    terminatedLeaseCount,
    approvedLeaseCount,
    rejectedLeaseCount,
  ] = await Promise.all([
    findPaginatedLeasesForLandlordList(listingFilter, {
      offset,
      limit: effectiveLimit,
      propertyCollectionName: Property.collection.name,
    }),
    Lease.countDocuments(listingFilter),
    // Active leases count
    Lease.countDocuments({ 
      property_id: { $in: propertyIds },
      status: LEASE_STATUSES.ACTIVE,
      isDeleted: { $ne: true }
    }),
    // In-process leases count (Submitted)
    Lease.countDocuments({
      property_id: { $in: propertyIds },
      status: LEASE_STATUSES.SUBMITTED,
      isDeleted: { $ne: true }
    }),
    // Future leases count (start date in future)
    Lease.countDocuments({ 
      property_id: { $in: propertyIds },
      start_date: { $gt: now },
      isDeleted: { $ne: true }
    }),
    // Leases expiring in next 90 days
    Lease.countDocuments({ 
      property_id: { $in: propertyIds },
      status: LEASE_STATUSES.ACTIVE,
      end_date: { $gte: now, $lte: in90Days },
      isDeleted: { $ne: true }
    }),
    // Expired leases count
    Lease.countDocuments({ 
      property_id: { $in: propertyIds },
      status: LEASE_STATUSES.EXPIRED,
      isDeleted: { $ne: true }
    }),
    // Terminated leases count
    Lease.countDocuments({
      property_id: { $in: propertyIds },
      status: LEASE_STATUSES.TERMINATED,
      isDeleted: { $ne: true }
    }),
    // Approved leases count
    Lease.countDocuments({
      property_id: { $in: propertyIds },
      status: LEASE_STATUSES.APPROVED,
      isDeleted: { $ne: true }
    }),
    // Rejected leases count
    Lease.countDocuments({
      property_id: { $in: propertyIds },
      status: LEASE_STATUSES.REJECTED,
      isDeleted: { $ne: true }
    }),
  ]);

  const propertyIdsForUnits = [...new Set(leases.map((l) => String(l.property_id?._id || l.property_id)))].filter(Boolean);
  const propertiesWithUnits = await Property.find({ _id: { $in: propertyIdsForUnits }, isDeleted: { $ne: true } })
    .select('unitDetails')
    .lean();
  const propertyUnitMap = new Map(propertiesWithUnits.map((p) => [String(p._id), p]));

  const User = require('../../../../../shared/modules/users/models/user.model');
  const allTenantIds = [
    ...new Set(
      leases.flatMap((lease) =>
        (lease.rentAndDepositDestribution?.split || [])
          .map((split) => split.tenantId)
          .filter((id) => id && mongoose.Types.ObjectId.isValid(id))
          .map((id) => String(id))
      )
    ),
  ];
  const tenantUsersById = new Map();
  if (allTenantIds.length > 0) {
    const tenantUsers = await User.find({
      _id: { $in: allTenantIds },
      isDeleted: { $ne: true },
    })
      .select('firstName lastName email phone')
      .lean();
    tenantUsers.forEach((user) => tenantUsersById.set(String(user._id), user));
  }

  // Transform data to return only required fields
  const transformedData = leases.map((lease) => {
    let tenants = [];
    const propForUnit = propertyUnitMap.get(String(lease.property_id?._id || lease.property_id));
    const displayUnitName = propForUnit
      ? resolvedUnitNameForLease(lease, propForUnit) || lease.unitName
      : lease.unitName;

    if (lease.rentAndDepositDestribution?.split?.length > 0) {
      tenants = lease.rentAndDepositDestribution.split.map((split) => {
        const tenantUser = tenantUsersById.get(String(split.tenantId));
        if (tenantUser) {
          const tenantName = `${tenantUser.firstName || ''} ${tenantUser.lastName || ''}`.trim();
          return {
            _id: tenantUser._id,
            name: tenantName || 'Unknown Tenant',
            email: tenantUser.email,
            phone: tenantUser.phone,
            rentAmount: split.rentAmount,
            rentPercentage: split.rentPercentage,
          };
        }
        return null;
      }).filter((tenant) => tenant !== null);
    }

    return {
      _id: lease._id,
      tenants: tenants.map(t => t.name).join(', '),
      tenantDetails: tenants, // Include full tenant details array
      propertyName: lease.property_id?.name || 'N/A',
      unitId: lease.unitId,
      unitName: displayUnitName || 'N/A',
      propertyAddress: lease.property_id?.address || 'N/A',
      status: lease.status,
      leaseTerm: lease.leaseTerm || '',
      start_date: lease.start_date || null,
      end_date: lease.end_date || null,
      rent: lease.rentDetails?.amount || 0,
      dates: `${lease.start_date ? formatDateInAppTimezone(lease.start_date) : 'N/A'} - ${lease.end_date ? formatDateInAppTimezone(lease.end_date) : 'N/A'}`,
      documents: 'Unsigned'
    };
  });

  return {
    data: transformedData,
    activeLeaseCount,
    inProcessLeaseCount,
    futureLeaseCount,
    expiringInNext90Days,
    expiredLease,
    terminatedLeaseCount,
    approvedLeaseCount,
    rejectedLeaseCount,
    total,
    page,
    pageSize: effectivePageSize
  };
}

// Add a document to a lease and set status to Submitted
// documentMeta is expected to contain { metadataId, originalName, uploadedAt }
async function addDocumentToLeaseService(leaseId, documentMeta, options = {}) {
  if (!options.session) {
    return runInTransaction((session) => addDocumentToLeaseService(leaseId, documentMeta, { session }));
  }

  if (!leaseId) {
    const err = new Error('leaseId is required');
    err.status = 400;
    throw err;
  }
  const safeDocLeaseId = toObjectId(leaseId);
  if (!safeDocLeaseId) throw Object.assign(new Error('Invalid leaseId'), { status: 400 });
  if (!documentMeta || !documentMeta.metadataId) {
    const err = new Error('document metadataId is required');
    err.status = 400;
    throw err;
  }

  const opts = {};
  if (options.session) opts.session = options.session;

  const lease = await Lease.findOne({ _id: safeDocLeaseId, isDeleted: { $ne: true } }, null, opts);
  if (!lease) {
    const err = new Error('Lease not found');
    err.status = 404;
    throw err;
  }


  // store only a reference to DocumentMetadata
  const doc = {
    metadataId: documentMeta.metadataId,
    originalName: documentMeta.originalName,
    uploadedAt: documentMeta.uploadedAt || ClockService.now(),
  };

  if (options.uploadedBy) doc.uploadedBy = options.uploadedBy;

  // push document and set status to Submitted
  lease.documents = lease.documents || [];
  lease.documents.push(doc);
  lease.status = LEASE_STATUSES.SUBMITTED;

  const saved = await lease.save(opts);
  return saved.toObject();
}

// Upload file to storage, persist metadata into Lease and set status to Submitted.
// This method contains the full business logic for uploading and persisting a lease document.
async function uploadLeaseDocumentService(leaseId, fileObj, options = {}) {
  if (!leaseId) {
    const err = new Error('leaseId is required');
    err.status = 400;
    throw err;
  }
  if (!fileObj || !fileObj.path) {
    const err = new Error('file object with local path is required');
    err.status = 400;
    throw err;
  }

  const s3Client = require('../../../../../integrations/s3');
  const { UPLOAD_LEASE_SUBDIR } = require('../../../../../common/constants/uploads');
  const userId = options.uploadedBy || options.userId || null;

  const filename = fileObj.filename || fileObj.originalname;
  const key = s3Client.getKeyForLease ? s3Client.getKeyForLease(leaseId, filename, userId) : `${UPLOAD_LEASE_SUBDIR || 'lease-documents'}/${filename}`;

  // upload to storage first
  let uploadResult;
  try {
    uploadResult = await s3Client.upload({ localFilePath: fileObj.path, key });
  } catch (e) {
    const err = new Error(e && e.message ? e.message : 'Failed to upload file to storage');
    err.status = 500;
    throw err;
  }

  const uploaded = {
    // persist document metadata and pass metadataId to DB
    originalName: fileObj.originalname,
    uploadedAt: ClockService.now(),
  };

  const storageKey = uploadResult.Key || key;

  try {
    return await runInTransaction(async (session) => {
      const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
      const cfg = require('../../../../../config/default');
      const bucketName = cfg.s3 && cfg.s3.bucketName ? cfg.s3.bucketName : (process.env.S3_BUCKET || 'mock-bucket');
      const region = cfg.s3 && cfg.s3.region ? cfg.s3.region : (process.env.AWS_REGION || 'mock-region');
      const metadataDoc = await createOne(
        DocumentMetadata,
        {
          key: storageKey,
          bucketName,
          region,
          size: fileObj.size || 0,
          contentType: fileObj.mimetype || 'application/octet-stream',
          originalName: fileObj.originalname || filename,
        },
        session
      );
      uploaded.metadataId = metadataDoc._id;
      return addDocumentToLeaseService(leaseId, uploaded, { session, uploadedBy: options.uploadedBy });
    });
  } catch (dbErr) {
    try {
      await s3Client.delete({ key: storageKey });
    } catch (delErr) {
      logger.warn('Failed to delete uploaded object after DB failure:', delErr?.message);
    }
    const err = new Error(dbErr?.message || 'Failed to persist uploaded document');
    err.status = dbErr?.status || 500;
    throw err;
  }
}

async function getLeaseByTenantService({ tenantId, propertyId, unit, unitId }) {
  if (!tenantId || !propertyId || (!unit && !unitId)) {
    const err = new Error('tenantId, propertyId and (unit or unitId) are required');
    err.status = 400;
    throw err;
  }

  const base = {
    property_id: propertyId,
    'rentAndDepositDestribution.split.tenantId': tenantId,
  };

  let lease = null;
  if (unitId && mongoose.Types.ObjectId.isValid(String(unitId))) {
    const property = await Property.findOne({ _id: propertyId, isDeleted: { $ne: true } }).select('unitDetails').lean();
    const details = property?.unitDetails || [];
    const candidates = await Lease.find({ ...base, isDeleted: { $ne: true } }).lean();
    const targetSub = details.find((u) => u._id && String(u._id) === String(unitId));
    if (!targetSub) {
      const err = new Error('unitId does not match property');
      err.status = 400;
      throw err;
    }
    lease = candidates.find((L) => leaseReferencesSameUnit(L, details, targetSub)) || null;
  } else {
    lease = await Lease.findOne({
      ...base,
      unitName: unit,
      isDeleted: { $ne: true },
    }).lean();
  }

  if (!lease) {
    const err = new Error('Lease not found');
    err.status = 404;
    throw err;
  }

  return lease;
}

async function checkTenureAvailabilityService({
  property_id,
  unitName,
  unit_id,
  lease_type,
  start_date,
  end_date,
  exclude_lease_id,
}) {
  const requestedStart = toStoredLeaseDate(start_date);
  const requestedEnd = lease_type === LEASE_TYPES.FIXED_TERM
    ? toStoredLeaseDate(end_date)
    : addYearsToStoredDate(requestedStart, 1);

  const query = {
    property_id,
    isDeleted: { $ne: true },
    status: {
      $in: [LEASE_STATUSES.SUBMITTED, LEASE_STATUSES.APPROVED, LEASE_STATUSES.ACTIVE, LEASE_STATUSES.EXPIRED],
    },
    start_date: { $lte: requestedEnd },
    $or: [
      { end_date: { $gte: requestedStart } },
      { end_date: null },
      { end_date: { $exists: false } },
    ],
  };

  if (exclude_lease_id) query._id = { $ne: exclude_lease_id };
  if (unitName && !unit_id) query.unitName = unitName;

  let conflictingLeases = await Lease.find({ ...query, isDeleted: { $ne: true } })
    .select('_id start_date end_date status lease_type unitId unitName')
    .sort({ start_date: 1 })
    .lean();

  if (unit_id && mongoose.Types.ObjectId.isValid(String(unit_id))) {
    const property = await Property.findOne({ _id: property_id, isDeleted: { $ne: true } }).select('unitDetails').lean();
    const details = property?.unitDetails || [];
    const targetSub = details.find((u) => u._id && String(u._id) === String(unit_id));
    if (!targetSub) {
      const err = new Error('unit_id does not match property');
      err.status = 400;
      throw err;
    }
    conflictingLeases = conflictingLeases.filter((L) =>
      leaseReferencesSameUnit(L, details, targetSub)
    );
  }

  return {
    available: conflictingLeases.length === 0,
    checkedRange: {
      start: requestedStart.toISOString(),
      end: requestedEnd.toISOString(),
    },
    conflictingLeases: conflictingLeases.map((l) => ({
      _id: String(l._id),
      start_date: l.start_date,
      end_date: l.end_date || null,
      status: l.status,
      lease_type: l.lease_type,
    })),
  };
}

module.exports = {
  createLeaseService,
  getLeaseByIdService,
  listLeasesService,
  updateLeaseService,
  regenerateFuturePendingInvoicesForLease,
  deleteLeaseService,
  terminateLeaseService,
  terminateLeaseWithCommentService,
  renewLeaseService,
  addCommentToLeaseService,
  addNoteToLeaseService,
  listLeasesByLandlordService,
  addDocumentToLeaseService,
  uploadLeaseDocumentService,
  getLeaseByTenantService,
  checkTenureAvailabilityService,
};
