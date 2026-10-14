const mongoose = require('mongoose');

/**
 * ------------------------------------------------------------------
 * File: leaseActivation.service.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * lease.controller, leaseAutoApproval.service, leaseManagement.service
 * ------------------------------------------------------------------
 */
const Lease = require('../model/lease.model');
const Invoice = require('../../invoice/model/invoice.model');
const User = require('../../../../../shared/modules/users/models/user.model');
const { LEASE_STATUSES, LEASE_TYPES, FREQUENCY_TYPES } = require('../../../../../common/constants/lease');
const { INVOICE_TYPES, INVOICE_STATUS } = require('../../../../../common/constants/invoice');
const { generateLandlordInvoiceNumber } = require('../../invoice/helpers/invoiceId.helper');
const { runInTransaction } = require('./leaseDb.util');
const logger = require('../../../../../common/logger');
const { ClockService, DateUtil } = require('../../../../../common/date');
const {
  getDateKeyInTimeZone,
  parseDateOnlyToNoonUtc,
  parseAppYmd,
  lastDayOfAppMonth,
  isDueDateOnOrBeforeToday,
  compareCalendarDateToToday,
  formatMonthYearInAppTimezone,
} = require('../../../../../common/helpers/hoaBillingDates');

function isMongoObjectIdString(value) {
  const str = String(value ?? '').trim();
  return mongoose.Types.ObjectId.isValid(str) && str.length === 24;
}

/**
 * Resolve invoice.tenants for a generatedInvoices row.
 * Wizards may persist client-temp tenant keys (Date.now()) instead of user ObjectIds;
 * fall back to name match / lease tenants so invite-ack activation does not 500.
 */
function resolveInvoiceTenantsForTemplate(template, leaseTenantIds, tenantNameById = {}) {
  const leaseTenants = (leaseTenantIds || [])
    .map((t) => {
      const normalized = normalizeTenantRefId(t);
      return normalized != null ? String(normalized) : '';
    })
    .filter(Boolean);

  if (!template?.tenantId) return leaseTenants;

  const raw = String(normalizeTenantRefId(template.tenantId) || '').trim();
  if (isMongoObjectIdString(raw) && leaseTenants.includes(raw)) {
    return [raw];
  }

  const wantName = String(template.tenantName || '').trim().toLowerCase();
  if (wantName) {
    const match = leaseTenants.find(
      (tid) => String(tenantNameById[tid] || '').trim().toLowerCase() === wantName
    );
    if (match) return [match];
  }

  if (leaseTenants.length === 1) return leaseTenants;

  logger.warn('[leaseActivation] unresolved generatedInvoices.tenantId; attaching all lease tenants', {
    templateTenantId: raw || null,
    templateTenantName: template.tenantName || null,
    leaseTenantCount: leaseTenants.length,
  });
  return leaseTenants;
}

function addYearsToStoredDate(value, years) {
  const key = getDateKeyInTimeZone(value);
  const p = parseAppYmd(key);
  if (!p) return DateUtil.toUTC(value);
  return parseDateOnlyToNoonUtc(
    `${p.y + years}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
  ) || DateUtil.toUTC(value);
}

function toStoredDueDate(value) {
  if (!value) return null;
  const key = getDateKeyInTimeZone(value);
  return key ? parseDateOnlyToNoonUtc(key) : DateUtil.toUTC(value);
}

const monthIndex = (y, m) => y * 12 + (m - 1);

/** Monthly due dates on `dueDay` within [rangeStart, rangeEnd] (business timezone calendar). */
function calculateMonthlyDueDatesInRange(rangeStart, rangeEnd, dueDay) {
  const startKey = getDateKeyInTimeZone(rangeStart);
  const endKey = getDateKeyInTimeZone(rangeEnd);
  if (!startKey || !endKey) return [];

  const startP = parseAppYmd(startKey);
  const endP = parseAppYmd(endKey);
  if (!startP || !endP) return [];

  const startMs = parseDateOnlyToNoonUtc(startKey)?.getTime() ?? 0;
  const endMs = parseDateOnlyToNoonUtc(endKey)?.getTime() ?? 0;
  const dates = [];
  const normalizedDueDay = Math.max(1, parseInt(dueDay, 10) || 1);

  for (let idx = monthIndex(startP.y, startP.m); idx <= monthIndex(endP.y, endP.m); idx += 1) {
    const y = Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    const last = lastDayOfAppMonth(y, m);
    const day = Math.min(normalizedDueDay, last);
    const dueDate = parseDateOnlyToNoonUtc(
      `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    );
    if (!dueDate) continue;
    const ms = dueDate.getTime();
    if (ms >= startMs && ms <= endMs) {
      dates.push(dueDate);
    }
  }

  return dates;
}
/**
 * Collect all tenant user ids from a lease split, regardless of shared-responsibility flag.
 * Invoices must always reference every lease tenant so UI and emails show correct names.
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
 * resolve Lease Tenant Ids
 *
 * Performs logic operations for resolveLeaseTenantIds.
 *
 * @param lease - Request/input argument
 * @returns Operations result
 */
function resolveLeaseTenantIds(lease) {
  const split = lease?.rentAndDepositDestribution?.split;
  if (!Array.isArray(split)) return [];
  return split.map((entry) => normalizeTenantRefId(entry?.tenantId)).filter(Boolean);
}

/** Compare calendar dates only: true when lease start is today or in the past (business TZ). */
function leaseStartOnOrBeforeToday(startDate) {
  if (!startDate) return false;
  return isDueDateOnOrBeforeToday(startDate, ClockService.now());
}

/**
 * assert Lease Eligible For Invoice Creation
 *
 * Performs logic operations for assertLeaseEligibleForInvoiceCreation.
 *
 * @param lease - Request/input argument
 * @returns Operations result
 */
function assertLeaseEligibleForInvoiceCreation(lease) {
  if (!lease.property_id) {
    const err = new Error('Property not found for lease');
    err.status = 400;
    throw err;
  }
  if (!lease.rentAndDepositDestribution?.split?.length) {
    const err = new Error('No tenants found in lease');
    err.status = 400;
    throw err;
  }
  if (!lease.unitName) {
    const err = new Error('Unit name is required for lease activation');
    err.status = 400;
    throw err;
  }
}

/**
 * After all onboarding gates pass: set lease to Active (start on/before today) or Approved
 * (future start), then create invoices when none exist yet.
 */
const autoFinalizeLeaseAfterOnboarding = async (leaseId, options = {}) => {
  if (!leaseId) {
    const err = new Error('leaseId is required');
    err.status = 400;
    throw err;
  }

  if (!options.session) {
    return runInTransaction((session) => autoFinalizeLeaseAfterOnboarding(leaseId, { session }));
  }

  const session = options.session;
  const lease = await Lease.findOne({ _id: leaseId, isDeleted: { $ne: true } })
    .populate('property_id')
    .session(session);
  if (!lease) {
    const err = new Error('Lease not found');
    err.status = 404;
    throw err;
  }

  if (lease.status === LEASE_STATUSES.ACTIVE) {
    const err = new Error('Lease is already active');
    err.status = 400;
    throw err;
  }

  if (lease.status === LEASE_STATUSES.APPROVED) {
    return { lease, invoices: [] };
  }

  if (lease.status !== LEASE_STATUSES.SUBMITTED) {
    const err = new Error(`Lease must be ${LEASE_STATUSES.SUBMITTED} to complete onboarding`);
    err.status = 400;
    throw err;
  }

  assertLeaseEligibleForInvoiceCreation(lease);

  const nextStatus = leaseStartOnOrBeforeToday(lease.start_date)
    ? LEASE_STATUSES.ACTIVE
    : LEASE_STATUSES.APPROVED;
  lease.status = nextStatus;
  await lease.save({ session });

  const invoiceCount = await Invoice.countDocuments({ lease_id: lease._id }).session(session);
  let invoices = [];
  if (invoiceCount === 0) {
    if (Array.isArray(lease.generatedInvoices) && lease.generatedInvoices.length > 0) {
      invoices = await createInvoicesFromGeneratedTemplates(lease, { session });
    } else {
      invoices = await generateInvoicesFromLeaseConfig(lease, { session });
    }
  }

  return { lease, invoices };
};

/**
 * Activate a lease and create invoices from pre-generated templates or generate them on-demand
 * Supports both new leases with generatedInvoices and legacy leases without them
 * @param {String} leaseId - Lease ID to activate
 * @returns {Object} - { lease, invoices }
 */
const activateLeaseService = async (leaseId, options = {}) => {
  if (!leaseId) {
    const err = new Error('leaseId is required');
    err.status = 400;
    throw err;
  }

  if (!options.session) {
    return runInTransaction((session) => activateLeaseService(leaseId, { session }));
  }

  const session = options.session;
  const lease = await Lease.findOne({ _id: leaseId, isDeleted: { $ne: true } })
    .populate('property_id')
    .session(session);
  if (!lease) {
    const err = new Error('Lease not found');
    err.status = 404;
    throw err;
  }

  if (lease.status === LEASE_STATUSES.ACTIVE) {
    const err = new Error('Lease is already active');
    err.status = 400;
    throw err;
  }

  const blocked = new Set([
    LEASE_STATUSES.EXPIRED,
    LEASE_STATUSES.TERMINATED,
    LEASE_STATUSES.REJECTED,
  ]);
  if (blocked.has(lease.status)) {
    const err = new Error('Lease cannot be activated in its current status');
    err.status = 400;
    throw err;
  }

  if (lease.status !== LEASE_STATUSES.SUBMITTED && lease.status !== LEASE_STATUSES.APPROVED) {
    const err = new Error(
      `Lease must be ${LEASE_STATUSES.SUBMITTED} or ${LEASE_STATUSES.APPROVED} to activate`
    );
    err.status = 400;
    throw err;
  }

  assertLeaseEligibleForInvoiceCreation(lease);

  lease.status = LEASE_STATUSES.ACTIVE;
  await lease.save({ session });

  const invoiceCount = await Invoice.countDocuments({ lease_id: lease._id }).session(session);
  let invoices = [];
  if (invoiceCount === 0) {
    if (Array.isArray(lease.generatedInvoices) && lease.generatedInvoices.length > 0) {
      invoices = await createInvoicesFromGeneratedTemplates(lease, { session });
    } else {
      invoices = await generateInvoicesFromLeaseConfig(lease, { session });
    }
  }

  return { lease, invoices };
};

/**
 * Generate unique invoiceId (INV + UUID). Sync - no DB round-trip.
 * Prefer this over legacy INV+6digit findOne loops during batch activation.
 */
const generateUniqueInvoiceId = async () => generateLandlordInvoiceNumber();

/**
 * Create invoices from pre-generated templates stored in lease.generatedInvoices
 * Maps each template to a proper Invoice document with all required fields
 * @param {Object} lease - The lease object with property populated and generatedInvoices array
 * @returns {Array} - Array of created Invoice documents
 */
const createInvoicesFromGeneratedTemplates = async (lease, options = {}) => {
  const session = options.session || null;
  const invoiceDocs = [];

  // Always attach every lease tenant to generated invoices (not only when rent is shared).
  const tenants = resolveLeaseTenantIds(lease);
  logger.info('[leaseActivation] createInvoicesFromGeneratedTemplates:resolved-tenants', {
    leaseId: String(lease._id),
    tenantCount: tenants.length,
  });

  const tenantUsers = tenants.length
    ? (session
      ? await User.find({ _id: { $in: tenants }, isDeleted: { $ne: true } }).select('firstName lastName').session(session).lean()
      : await User.find({ _id: { $in: tenants }, isDeleted: { $ne: true } }).select('firstName lastName').lean())
    : [];
  const tenantNameById = tenantUsers.reduce((acc, t) => {
    acc[String(t._id)] = `${t.firstName || ''} ${t.lastName || ''}`.trim() || `Tenant ${String(t._id)}`;
    return acc;
  }, {});

  const buildRentLineItemsFromSplit = (totalAmount) => {
    const split = Array.isArray(lease?.rentAndDepositDestribution?.split)
      ? lease.rentAndDepositDestribution.split
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

    const calcAmount = (entry) => {
      const pct = Number(entry?.rentPercentage || 0);
      if (pct > 0) return Number(((totalAmount * pct) / 100).toFixed(2));
      return Number((totalAmount / split.length).toFixed(2));
    };

    const lineItems = split.map((entry, idx) => {
      const tid = String(entry?.tenantId || '');
      const tenantName = tenantNameById[tid] || `Tenant ${idx + 1}`;
      const lineLabel = `${INVOICE_TYPES.RENT} - ${tenantName}`;
      const shareAmount = calcAmount(entry);
      return {
        invoiceItem: lineLabel,
        description: lineLabel,
        quantity: 1,
        rate: shareAmount,
        amount: shareAmount,
      };
    });

    const sum = lineItems.reduce((s, li) => s + Number(li.amount || 0), 0);
    const drift = Number((Number(totalAmount) - sum).toFixed(2));
    if (Math.abs(drift) >= 0.01 && lineItems.length > 0) {
      const last = lineItems[lineItems.length - 1];
      const patched = Number((Number(last.amount || 0) + drift).toFixed(2));
      lineItems[lineItems.length - 1] = {
        ...last,
        amount: patched,
        rate: patched,
      };
    }

    return lineItems;
  };

  const buildFeeLineItemsFromSplit = (totalAmount, feeName) => {
    const split = Array.isArray(lease?.rentAndDepositDestribution?.split)
      ? lease.rentAndDepositDestribution.split
      : [];
    const labelPrefix = feeName || INVOICE_TYPES.OTHER;
    if (!split.length) {
      return [{
        invoiceItem: labelPrefix,
        description: labelPrefix,
        quantity: 1,
        rate: totalAmount,
        amount: totalAmount,
      }];
    }

    const calcAmount = (entry) => {
      const pct = Number(entry?.rentPercentage || 0);
      if (pct > 0) return Number(((totalAmount * pct) / 100).toFixed(2));
      return Number((totalAmount / split.length).toFixed(2));
    };

    const lineItems = split.map((entry, idx) => {
      const tid = String(entry?.tenantId || '');
      const tenantName = tenantNameById[tid] || `Tenant ${idx + 1}`;
      const lineLabel = `${labelPrefix} - ${tenantName}`;
      const shareAmount = calcAmount(entry);
      return {
        invoiceItem: lineLabel,
        description: lineLabel,
        quantity: 1,
        rate: shareAmount,
        amount: shareAmount,
      };
    });

    const sum = lineItems.reduce((s, li) => s + Number(li.amount || 0), 0);
    const drift = Number((Number(totalAmount) - sum).toFixed(2));
    if (Math.abs(drift) >= 0.01 && lineItems.length > 0) {
      const last = lineItems[lineItems.length - 1];
      const patched = Number((Number(last.amount || 0) + drift).toFixed(2));
      lineItems[lineItems.length - 1] = {
        ...last,
        amount: patched,
        rate: patched,
      };
    }

    return lineItems;
  };

  const isEqualResponsibility = lease?.rentAndDepositDestribution?.isAllTenantsEquallyResponsible !== false;

  // Iterate through each pre-generated invoice template
  for (const generatedInvoiceTemplate of lease.generatedInvoices) {
    try {
      // Determine invoice type mapping
      let invoiceType = INVOICE_TYPES.OTHER;
      if (generatedInvoiceTemplate.type === 'rent') {
        invoiceType = INVOICE_TYPES.RENT;
      } else if (generatedInvoiceTemplate.type === 'deposit') {
        invoiceType = INVOICE_TYPES.DEPOSIT;
      } else if (generatedInvoiceTemplate.type === 'additional-fee') {
        invoiceType = INVOICE_TYPES.OTHER;
      }

      // Honor status from generatedInvoices template when provided.
      // Invoice model computes status from balanceDue, so we align financial fields
      // with the template status to preserve intended state.
      const templateStatus = String(generatedInvoiceTemplate.status || '').toLowerCase();
      let status = INVOICE_STATUS.PENDING;
      let alreadyPaid = 0;
      let balanceDue = generatedInvoiceTemplate.amount;
      let paidOn;

      if (templateStatus === 'paid') {
        status = INVOICE_STATUS.PAID;
        alreadyPaid = generatedInvoiceTemplate.amount;
        balanceDue = 0;
        paidOn = ClockService.now();
      } else if (templateStatus === 'partially_paid' || templateStatus === 'partially paid') {
        status = INVOICE_STATUS.PARTIALLY_PAID;
        // Optional template support: paidAmount. If absent, keep invoice pending-like.
        const paidAmount = Number(generatedInvoiceTemplate.paidAmount || 0);
        if (paidAmount > 0 && paidAmount < Number(generatedInvoiceTemplate.amount || 0)) {
          alreadyPaid = paidAmount;
          balanceDue = Number(generatedInvoiceTemplate.amount) - paidAmount;
        }
      } else if (templateStatus === 'overdue') {
        // Overdue isn't auto-derived in the current invoice model pre-save hook.
        // Keep financials pending-like; downstream overdue jobs can classify by dueDate.
        status = INVOICE_STATUS.OVERDUE;
      }

      const dueDate = toStoredDueDate(generatedInvoiceTemplate.dueDate);

      // For individual responsibility, each template invoice belongs to a specific tenant.
      // Use the template's tenantId when it is a real lease tenant ObjectId; otherwise
      // resolve via tenantName / single-tenant fallback (client temp keys are common).
      const invoiceTenants = resolveInvoiceTenantsForTemplate(
        generatedInvoiceTemplate,
        tenants,
        tenantNameById
      );
      if (!invoiceTenants.length) {
        const err = new Error('No valid tenants found for generated invoice template');
        err.status = 400;
        throw err;
      }

      // When a tenantId is present the template already encodes the exact per-tenant
      // amount and description shown on the UI - use it directly.
      // Only rebuild line items from the split when there is no tenantId (equal
      // responsibility mode where one invoice covers all tenants).
      const hasPerTenantTemplate = !!generatedInvoiceTemplate.tenantId;

      invoiceDocs.push({
        invoiceId: generateLandlordInvoiceNumber(),
        type: invoiceType,
        status,
        lease_id: lease._id,
        propertyId: lease.property_id._id,
        propertyName: lease.property_id.name,
        unit: lease.unitName,
        unitId: lease.unitId,
        term: lease.leaseTerm || 'N/A',
        tenants: invoiceTenants,
        invoiceItemDetails:
          hasPerTenantTemplate
            ? [{
                invoiceItem: generatedInvoiceTemplate.description,
                description: generatedInvoiceTemplate.description,
                quantity: 1,
                rate: generatedInvoiceTemplate.amount,
                amount: generatedInvoiceTemplate.amount,
              }]
            : invoiceType === INVOICE_TYPES.RENT && isEqualResponsibility
              ? buildRentLineItemsFromSplit(generatedInvoiceTemplate.amount)
              : invoiceType === INVOICE_TYPES.OTHER && isEqualResponsibility
                ? buildFeeLineItemsFromSplit(
                  generatedInvoiceTemplate.amount,
                  generatedInvoiceTemplate.feeName || generatedInvoiceTemplate.description
                )
                : [{
                  invoiceItem: generatedInvoiceTemplate.description,
                  description: generatedInvoiceTemplate.description,
                  quantity: 1,
                  rate: generatedInvoiceTemplate.amount,
                  amount: generatedInvoiceTemplate.amount
                }],
        subAmount: generatedInvoiceTemplate.amount,
        alreadyPaid,
        balanceDue,
        isPartialPaymentAllowed: lease.rentAndDepositDestribution.isPartialPaymentAllowed,
        dueDate,
        ...(paidOn ? { paidOn } : {}),
      });
    } catch (error) {
      logger.error(`Failed to create invoice from template: ${error.message}`, error);
      throw error;
    }
  }

  if (!invoiceDocs.length) return [];

  // Batch insert: one round-trip instead of N×(id-check + save) against remote Mongo.
  const insertOpts = { ordered: true };
  if (session) insertOpts.session = session;
  return Invoice.insertMany(invoiceDocs, insertOpts);
};

/**
 * LEGACY FLOW: Generate invoices from lease configuration for backward compatibility
 * Used when lease doesn't have pre-generated invoices
 * @param {Object} lease - The lease object with property populated
 * @returns {Array} - Array of created Invoice documents
 */
const generateInvoicesFromLeaseConfig = async (lease, options = {}) => {
  const session = options.session || null;
  const invoices = [];
  const now = ClockService.now();

  // Always attach every lease tenant to generated invoices (not only when rent is shared).
  const tenants = resolveLeaseTenantIds(lease);
  logger.info('[leaseActivation] generateInvoicesFromLeaseConfig:resolved-tenants', {
    leaseId: String(lease._id),
    tenantCount: tenants.length,
  });

  // Validate required lease fields for invoice generation
  if (!lease.rentDetails?.amount) {
    const err = new Error('Rent amount is required for invoice generation');
    err.status = 400;
    throw err;
  }

  if (!lease.rentDetails?.firstRentalInvoiceDue) {
    const err = new Error('First rental invoice due date is required for invoice generation');
    err.status = 400;
    throw err;
  }

  if (!lease.depositDetails) {
    const err = new Error('Deposit details are required for invoice generation');
    err.status = 400;
    throw err;
  }

  // 1. Generate deposit invoice
  const depositInvoice = await generateDepositInvoice(lease, now, tenants, session);
  if (depositInvoice) invoices.push(depositInvoice);

  // 2. Generate first rent invoice
  if (lease.rentDetails.firstRentalInvoiceDue) {
    const firstRentInvoice = await createRentInvoice(
      lease,
      toStoredDueDate(lease.rentDetails.firstRentalInvoiceDue),
      now,
      tenants,
      session
    );
    invoices.push(firstRentInvoice);
  }

  // 3. Generate recurring rent invoices
  const recurringRentInvoices = await generateRentInvoices(lease, now, tenants, session);
  invoices.push(...recurringRentInvoices);

  // 4. Generate additional fee invoices
  const additionalFeeInvoices = await generateAdditionalFeeInvoices(lease, now, tenants, session);
  invoices.push(...additionalFeeInvoices);

  return invoices;
};

/**
 * Generate deposit invoice (legacy flow)
 */
const generateDepositInvoice = async (lease, now, tenants, session = null) => {
  const { depositDetails } = lease;
  
  if (!depositDetails?.amount || depositDetails.amount <= 0) {
    return null;
  }

  if (depositDetails.isDepositAlreadyCollected) {
    return null;
  }

  const dueDate = toStoredDueDate(depositDetails.due);
  let status = INVOICE_STATUS.PENDING;
  if (compareCalendarDateToToday(dueDate, now) < 0) {
    status = INVOICE_STATUS.OVERDUE;
  }

  const invoiceId = await generateUniqueInvoiceId(session);

  const invoice = new Invoice({
    invoiceId,
    type: INVOICE_TYPES.DEPOSIT,
    status,
    lease_id: lease._id,
    propertyId: lease.property_id._id,
    propertyName: lease.property_id.name,
    unit: lease.unitName,
    unitId: lease.unitId,
    term: lease.leaseTerm || 'N/A',
    tenants,
    invoiceItemDetails: [{
      invoiceItem: INVOICE_TYPES.DEPOSIT,
      description: 'Security Deposit',
      quantity: 1,
      rate: depositDetails.amount,
      amount: depositDetails.amount
    }],
    subAmount: depositDetails.amount,
    alreadyPaid: 0,
    balanceDue: depositDetails.amount,
    isPartialPaymentAllowed: lease.rentAndDepositDestribution.isPartialPaymentAllowed,
    dueDate
  });

  return session ? await invoice.save({ session }) : await invoice.save();
};

/**
 * Generate first rent invoice (legacy flow)
 */
const createRentInvoice = async (lease, dueDate, now, tenants, session = null) => {
  const monthYear = formatMonthYearInAppTimezone(dueDate);
  
  let status = INVOICE_STATUS.PENDING;
  if (compareCalendarDateToToday(dueDate, now) < 0) {
    status = INVOICE_STATUS.OVERDUE;
  }

  const invoiceId = await generateUniqueInvoiceId(session);
  
  const invoice = new Invoice({
    invoiceId,
    type: INVOICE_TYPES.RENT,
    status,
    lease_id: lease._id,
    propertyId: lease.property_id._id,
    propertyName: lease.property_id.name,
    unit: lease.unitName,
    unitId: lease.unitId,
    term: lease.leaseTerm || 'N/A',
    tenants,
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
    dueDate
  });
  
  return session ? await invoice.save({ session }) : await invoice.save();
};

/**
 * Generate recurring rent invoices (legacy flow)
 */
const generateRentInvoices = async (lease, now, tenants, session = null) => {
  const invoices = [];
  const { lease_type, rentDetails, start_date, end_date } = lease;

  if (!rentDetails?.frequency || !rentDetails?.amount) {
    return invoices;
  }

  const startDate = toStoredDueDate(start_date);
  let endDate;

  if (lease_type === LEASE_TYPES.FIXED_TERM) {
    endDate = toStoredDueDate(end_date);
  } else {
    endDate = addYearsToStoredDate(start_date, 1);
  }

  if (rentDetails.frequency === FREQUENCY_TYPES.MONTHLY) {
    const dueDay = parseInt(rentDetails.dueOne, 10);
    const dueDates = calculateMonthlyDueDatesInRange(startDate, endDate, dueDay);
    const firstDue = rentDetails.firstRentalInvoiceDue
      ? toStoredDueDate(rentDetails.firstRentalInvoiceDue)
      : null;
    const firstDueMs = firstDue?.getTime() ?? null;

    for (const dueDate of dueDates) {
      if (firstDueMs != null && dueDate.getTime() === firstDueMs) continue;
      const invoice = await createRentInvoice(lease, dueDate, now, tenants, session);
      invoices.push(invoice);
    }
  }
  
  return invoices;
};

/**
 * Generate additional fee invoices (legacy flow)
 */
const generateAdditionalFeeInvoices = async (lease, now, tenants, session = null) => {
  const invoices = [];
  const { additionalFees } = lease;

  // Handle both array and single object formats for backward compatibility
  let feesArray = [];
  if (Array.isArray(additionalFees)) {
    feesArray = additionalFees;
  } else if (additionalFees && typeof additionalFees === 'object') {
    feesArray = [additionalFees];
  }

  if (feesArray.length === 0) {
    return invoices;
  }

  for (const fee of feesArray) {
    // Skip fees that should be line items on rent invoices
    if (fee.isRecurringInvoice && fee.lineItemOnRentalInvoice) {
      continue;
    }

    if (!fee.isRecurringInvoice) {
      // One-time fee
      const feeInvoice = await createAdditionalFeeInvoice(lease, fee, toStoredDueDate(fee.dueDate), now, tenants, session);
      invoices.push(feeInvoice);
    } else if (fee.isRecurringInvoice && !fee.lineItemOnRentalInvoice) {
      // Recurring separate invoices
      const recurringFeeInvoices = await generateRecurringFeeInvoices(lease, fee, now, tenants, session);
      invoices.push(...recurringFeeInvoices);
    }
  }

  return invoices;
};

/**
 * Create a single additional fee invoice (legacy flow)
 */
const createAdditionalFeeInvoice = async (lease, fee, dueDate, now, tenants, session = null) => {
  let status = INVOICE_STATUS.PENDING;
  if (compareCalendarDateToToday(dueDate, now) < 0) {
    status = INVOICE_STATUS.OVERDUE;
  }

  const invoiceItems = fee.items.map(item => ({
    invoiceItem: item.name,
    description: item.description,
    quantity: item.quantity,
    rate: item.rate,
    amount: item.amount
  }));

  const invoiceId = await generateUniqueInvoiceId(session);

  const invoice = new Invoice({
    invoiceId,
    type: INVOICE_TYPES.OTHER,
    status,
    lease_id: lease._id,
    propertyId: lease.property_id._id,
    propertyName: lease.property_id.name,
    unit: lease.unitName,
    unitId: lease.unitId,
    term: lease.leaseTerm || 'N/A',
    tenants,
    invoiceItemDetails: invoiceItems,
    subAmount: fee.balanceAmount,
    alreadyPaid: fee.alreadyPaid,
    balanceDue: fee.balanceAmount,
    isPartialPaymentAllowed: lease.rentAndDepositDestribution.isPartialPaymentAllowed,
    dueDate
  });

  return session ? await invoice.save({ session }) : await invoice.save();
};

/**
 * Generate recurring fee invoices (legacy flow)
 */
const generateRecurringFeeInvoices = async (lease, fee, now, tenants, session = null) => {
  const invoices = [];
  const { lease_type, start_date, end_date } = lease;
  const frequency = fee.frequency;
  const dueOnDate = fee.dueOnDate;
  
  // Use fee's start/end dates if provided, otherwise use lease dates
  let startDate, endDate;
  
  if (fee.startDate && fee.endDate) {
    startDate = toStoredDueDate(fee.startDate);
    endDate = toStoredDueDate(fee.endDate);
  } else {
    startDate = toStoredDueDate(start_date);

    if (lease_type === LEASE_TYPES.FIXED_TERM) {
      endDate = toStoredDueDate(end_date);
    } else {
      endDate = addYearsToStoredDate(start_date, 1);
    }
  }

  let dueDates = [];
  const normalizedFreq = frequency ? frequency.toLowerCase() : 'monthly';
  
  if (normalizedFreq === 'monthly') {
    dueDates = calculateFeeMonthlyDates(startDate, endDate, dueOnDate);
  }

  for (const dueDate of dueDates) {
    const invoice = await createAdditionalFeeInvoice(lease, fee, dueDate, now, tenants, session);
    invoices.push(invoice);
  }

  return invoices;
};

/**
 * Calculate monthly dates for additional fees
 */
const calculateFeeMonthlyDates = (startDate, endDate, dueDay) => {
  const startKey = getDateKeyInTimeZone(startDate);
  const startP = parseAppYmd(startKey);
  if (!startP) return [];
  const rangeStart = parseDateOnlyToNoonUtc(`${startP.y}-${String(startP.m).padStart(2, '0')}-01`);
  return calculateMonthlyDueDatesInRange(rangeStart, endDate, dueDay);
};

/**
 * Approve a lease: set status to Approved (used for future-start leases).
 * Creates invoices if none exist yet.
 */
const approveLeaseService = async (leaseId, options = {}) => {
  if (!leaseId) {
    const err = new Error('leaseId is required');
    err.status = 400;
    throw err;
  }

  if (!options.session) {
    return runInTransaction((session) => approveLeaseService(leaseId, { session }));
  }

  const session = options.session;
  const lease = await Lease.findOne({ _id: leaseId, isDeleted: { $ne: true } })
    .populate('property_id')
    .session(session);
  if (!lease) {
    const err = new Error('Lease not found');
    err.status = 404;
    throw err;
  }

  if (lease.status === LEASE_STATUSES.APPROVED) {
    const err = new Error('Lease is already approved');
    err.status = 400;
    throw err;
  }

  const blocked = new Set([LEASE_STATUSES.EXPIRED, LEASE_STATUSES.TERMINATED, LEASE_STATUSES.REJECTED]);
  if (blocked.has(lease.status)) {
    const err = new Error('Lease cannot be approved in its current status');
    err.status = 400;
    throw err;
  }

  assertLeaseEligibleForInvoiceCreation(lease);

  lease.status = LEASE_STATUSES.APPROVED;
  await lease.save({ session });

  const invoiceCount = await Invoice.countDocuments({ lease_id: lease._id }).session(session);
  let invoices = [];
  if (invoiceCount === 0) {
    if (Array.isArray(lease.generatedInvoices) && lease.generatedInvoices.length > 0) {
      invoices = await createInvoicesFromGeneratedTemplates(lease, { session });
    } else {
      invoices = await generateInvoicesFromLeaseConfig(lease, { session });
    }
  }

  return { lease, invoices };
};

module.exports = {
  activateLeaseService,
  approveLeaseService,
  autoFinalizeLeaseAfterOnboarding,
  leaseStartOnOrBeforeToday,
};
