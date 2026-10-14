/**
 * ------------------------------------------------------------------
 * File: unit.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * unit.controller, owner.service, unitImportExport.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Property = require('../../property/model/property.model');
const User = require('../../../../../shared/modules/users/models/user.model');
const logger = require('../../../../../common/logger');

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function toObjectIds(arr) {
  return (Array.isArray(arr) ? arr : []).map(toObjectId).filter(Boolean);
}
const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
const s3Client = require('../../../../../integrations/s3');
const config = require('../../../../../config/default');
const { logActivity } = require('../../dashboard/service/activity.service');
const { generateUnitInvoices } = require('./unitInvoice.service');
const { sendUnitAssignmentEmail } = require('../../../../../common/helpers/unitAssignmentEmailHelper');
const Expense = require('../../expense/model/expense.model');
const fs = require('fs');
const path = require('path');
const Invoice = require('../../invoice/model/invoice.model');
const { INVOICE_STATUS, INVOICE_TYPES, HOA_UNIT_SCHEDULE_INVOICE_TYPES } = require('../../../../../common/constants/invoice');
const ledgerService = require('./ledger.service');
const LedgerEntry = require('../models/ledgerEntry.model');
const { recalculateFutureScheduleInvoicesForUnit } = require('./unitScheduleRecalc.service');
const invoiceService = require('../../invoice/service/invoice.service');
const HOASettings = require('../../hoa-settings/model/hoaSettings.model');
const { updateOwnersMailingAddress } = require('../../../../../common/helpers/addressHelper');
const {
  getDateKeyInTimeZone,
  parseDateOnlyToNoonUtc,
  dateOnlyKeyFromStoredInstant,
  billingCalendarDateKey,
  formatDateInAppTimezone,
} = require('../../../../../common/helpers/hoaBillingDates');
const { sendOwnerRemovalNoticeEmail } = require('../../../../../common/helpers/ownerRemovalNoticeEmailHelper');
const { buildHOAOwnerUserFilter } = require('../../../../../common/helpers/hoaOwnerRole');
const {
  assertOwnerEligibleForPropertyAssignment,
  assertOwnersEligibleForPropertyAssignment,
  isOwnerEligibleForInvoiceGeneration,
  shouldGenerateInvoicesForOwnerAssignment,
} = require('../helpers/ownerEligibility.helper');
const { ClockService, DateUtil, TIMEZONE } = require('../../../../../common/date');
const { resolvePropertyBillingTimezoneFields } = require('../../../../../common/helpers/resolvePropertyBillingTimezone');
const { resolvePaymentDueDayFromSources } = require('../helpers/paymentDueDay.helper');
const {
  notifyPropertyCreatedInAppInBackground,
  notifyPropertyUpdatedInAppInBackground,
  notifyPropertyDeletedInAppInBackground,
  notifyOwnerUpdatedInAppInBackground,
  notifyOwnerDeletedInAppInBackground,
} = require('../../../../../common/helpers/hoaEntityNotify.helper');

const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function asPlainPropertyDoc(doc) {
  return doc?.toObject ? doc.toObject() : doc;
}

function queueUnitPropertyCreatedNotification(unit, actorUserId) {
  notifyPropertyCreatedInAppInBackground(asPlainPropertyDoc(unit), actorUserId || null);
}

function queueUnitPropertyUpdatedNotification(unit, actorUserId) {
  notifyPropertyUpdatedInAppInBackground(asPlainPropertyDoc(unit), actorUserId || null);
}

function applyUnitBillingTimezoneFields(target, unitData, existingUnit = null) {
  const addressInput = unitData.address
    ? {
      street: unitData.address.line1,
      zip: unitData.address.zipCode || unitData.address.zip,
      state: unitData.address.state,
    }
    : existingUnit?.address;

  const fields = resolvePropertyBillingTimezoneFields(
    {
      billingTimezone: unitData.billingTimezone,
      billingTimezoneSource: unitData.billingTimezoneSource,
      address: addressInput,
    },
    existingUnit
  );

  target.billingTimezone = fields.billingTimezone;
  target.billingTimezoneSource = fields.billingTimezoneSource;
}

const normalizeUnitTitle = (s) => String(s || '').trim();
const normalizePropertyDisplayName = (s) => String(s || '').trim();

const assertValidUnitTitle = (title, city, { required = true } = {}) => {
  const normalizedTitle = normalizeUnitTitle(title);
  const addressCity = normalizeUnitTitle(city);
  if (required && !normalizedTitle) {
    const err = new Error('Unit Number is required');
    err.status = 400;
    throw err;
  }
  if (
    normalizedTitle &&
    addressCity &&
    normalizedTitle.toLowerCase() === addressCity.toLowerCase()
  ) {
    const err = new Error(
      'Unit Number cannot be the same as City. Please enter a valid unit number.'
    );
    err.status = 400;
    throw err;
  }
  return normalizedTitle;
};

const currentUnitTitleFromProperty = (unit) =>
  normalizeUnitTitle(
    (unit && unit.unitDetails && unit.unitDetails[0] && unit.unitDetails[0].unitName) || ''
  );

/**
 * HOA invoices store a denormalized unit/property label. Keep those snapshots in sync
 * when the live unit number or property display name changes so listing, detail, PDF,
 * and emails do not keep showing stale values. Association stays on propertyId.
 */
const syncAssociatedInvoiceLabels = async (
  unitId,
  { unitLabel, propertyName, previousUnitLabel, previousPropertyName, session } = {}
) => {
  const setFields = {};
  const nextUnitLabel = normalizeUnitTitle(unitLabel);
  const nextPropertyName = normalizePropertyDisplayName(propertyName);
  if (nextUnitLabel && nextUnitLabel !== normalizeUnitTitle(previousUnitLabel)) {
    setFields.unit = nextUnitLabel;
  }
  if (nextPropertyName && nextPropertyName !== normalizePropertyDisplayName(previousPropertyName)) {
    setFields.propertyName = nextPropertyName;
  }
  if (Object.keys(setFields).length === 0) return { modifiedCount: 0 };

  return Invoice.updateMany(
    { propertyId: toObjectId(unitId) || unitId },
    { $set: setFields },
    session ? { session } : {}
  );
};

/**
 * HOA stores one Property document per unit; `name` is the property display name (may repeat).
 * A duplicate is another document with the same property name and the same unit name (any unitDetails entry).
 */
const findDuplicateUnitDocument = async (propertyName, unitTitle, { excludeId, session, hoaId } = {}) => {
  const name = String(propertyName || '').trim();
  const title = String(unitTitle || '').trim();
  if (!name || !title) return null;
  const filter = {
    name: { $regex: new RegExp(`^${escapeRegex(name)}$`, 'i') },
    unitDetails: {
      $elemMatch: {
        unitName: { $regex: new RegExp(`^${escapeRegex(title)}$`, 'i') },
      },
    },
    isDeleted: { $ne: true },
    // Match active listings: archived properties are hidden but were still blocking recreate.
    isArchieved: { $ne: true },
  };
  if (excludeId) {
    filter._id = { $ne: excludeId };
  }
  if (hoaId) {
    filter.hoaId = hoaId;
  }
  let q = Property.findOne(filter);
  if (session) q = q.session(session);
  return q.lean();
};

const roundMoney = (n) => Math.round((Number(n) || 0) * 100) / 100;

const normalizeDepositBankLabel = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, 200);
};

const asIdString = (value) => {
  if (!value) return null;
  return value.toString ? value.toString() : String(value);
};

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(asIdString(value));

async function assertOwnerIdsEligibleForPropertyAssignment(ownerIds, session = null) {
  if (!Array.isArray(ownerIds) || ownerIds.length === 0) return;
  const safeIds = toObjectIds(ownerIds);
  if (safeIds.length === 0) return;

  const ownerRoleFilter = await buildHOAOwnerUserFilter();
  let ownerQuery = User.find({
    $and: [ownerRoleFilter, { _id: { $in: safeIds } }],
  }).select('portalOnboardingStatus status isArchived isDeleted');
  if (session) ownerQuery = ownerQuery.session(session);
  const owners = await ownerQuery.lean();

  if (owners.length !== safeIds.length) {
    const err = new Error('One or more owners were not found');
    err.status = 400;
    throw err;
  }

  assertOwnersEligibleForPropertyAssignment(owners);
}

async function loadOwnersForInvoiceEligibility(ownerIds, session = null) {
  if (!Array.isArray(ownerIds) || ownerIds.length === 0) return [];
  const safeIds = toObjectIds(ownerIds);
  if (safeIds.length === 0) return [];

  const ownerRoleFilter = await buildHOAOwnerUserFilter();
  let ownerQuery = User.find({
    $and: [ownerRoleFilter, { _id: { $in: safeIds } }],
  }).select('portalOnboardingStatus status isArchived isDeleted propertyIds');
  if (session) ownerQuery = ownerQuery.session(session);
  return ownerQuery.lean();
}

async function hasInvoiceEligibleAssociatedOwner(ownerIds, session = null) {
  const owners = await loadOwnersForInvoiceEligibility(ownerIds, session);
  return owners.some((owner) => isOwnerEligibleForInvoiceGeneration(owner));
}

const resolveUserPhoneForUnitContact = (user) => {
  if (!user) return '';
  for (const candidate of [user.phone, user.secondaryPhone]) {
    if (candidate == null || candidate === '') continue;
    const s = String(candidate).trim();
    if (s) return s;
  }
  return '';
};

async function resolveOwnerInfoForUnit(unitData, session) {
  const associatedOwnerIds = Array.isArray(unitData.associatedOwnerIds) ? unitData.associatedOwnerIds : [];
  const primaryOwnerId = associatedOwnerIds.find((id) => isValidObjectId(id));
  const boardMemberId = toObjectId(unitData.landlordId || unitData.boardMemberId);

  // HOA flow priority: assigned owner details first, board member fallback.
  const candidateIds = toObjectIds([primaryOwnerId, boardMemberId]).filter(Boolean);

  const defaultInfo = { name: 'Default Owner', email: 'owner@example.com', phone: '' };
  if (candidateIds.length === 0) {
    return { ownerInfo: defaultInfo, source: 'none' };
  }

  for (const candidateId of candidateIds) {
    let query = User.findById(candidateId);
    if (session) query = query.session(session);
    const user = await query;
    if (!user) continue;

    // Ownerless units fall back to board member contact; phone is optional (stored as-is).
    const info = {
      name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Owner',
      email: user.email || 'owner@example.com',
      phone: resolveUserPhoneForUnitContact(user),
    };
    const source = primaryOwnerId && String(toObjectId(primaryOwnerId)) === String(candidateId) ? 'hoa-owner' : 'hoa-board-member';
    return { ownerInfo: info, source };
  }

  return { ownerInfo: defaultInfo, source: 'none' };
}

/**
 * When an ownerless unit is assigned with Start Fresh, unapplied Property.remainingCredit
 * is cleared via an HOA expense (Include Current Balance keeps credit on the unit).
 */
async function createUnappliedCreditReleaseExpense({
  unit,
  unitId,
  amount,
  performedBy,
  session,
  newOwnerUserId,
}) {
  const credit = roundMoney(amount);
  if (credit <= 0) return null;
  const unitLabel =
    unit.unitDetails && unit.unitDetails[0] && unit.unitDetails[0].unitName
      ? String(unit.unitDetails[0].unitName)
      : 'Unit';
  const expensePayload = await ledgerService.buildUnappliedCreditReleaseExpensePayload({
    unitDoc: unit,
    unitId,
    creditReleasedExpense: credit,
    performedBy,
    session,
    vendorOwnerUserIds: newOwnerUserId ? [String(newOwnerUserId)] : [],
    expenseItemDescription: `Unapplied owner credit cleared when assigning a new owner with Start Fresh (${unit.name || 'property'} / ${unitLabel}).`,
  });
  return ledgerService.createCreditReleaseExpenseInSession(expensePayload, session);
}

const hasBillingConfiguration = (unitData = {}) =>
  unitData.startingBalance !== undefined &&
  unitData.balanceAsOf &&
  Number(unitData.monthlyRecurringFee) > 0 &&
  Number(unitData.paymentTerm) > 0;

const shouldGenerateBillingInvoices = async (propertyId, unitData = {}) => {
  if (!hasBillingConfiguration(unitData)) return false;
  if (!Array.isArray(unitData.associatedOwnerIds) || unitData.associatedOwnerIds.length === 0) return false;
  if (!(await hasInvoiceEligibleAssociatedOwner(unitData.associatedOwnerIds))) return false;

  const safePropId = toObjectId(propertyId);
  if (!safePropId) return false;
  const existingInvoiceCount = await Invoice.countDocuments({
    propertyId: safePropId,
    isDeleted: { $ne: true }
  });

  return existingInvoiceCount === 0;
};

const countExistingInvoices = async (propertyId, session) => {
  let query = Invoice.countDocuments({
    propertyId,
    isDeleted: { $ne: true }
  });

  if (session) {
    query = query.session(session);
  }

  return await query;
};

const generateBillingInvoicesIfNeeded = async ({
  propertyId,
  propertyName,
  unitData,
  session,
  existingInvoiceCount,
  includeOpeningBalanceInvoice
}) => {
  if (!hasBillingConfiguration(unitData)) return false;
  if (!Array.isArray(unitData.associatedOwnerIds) || unitData.associatedOwnerIds.length === 0) return false;
  if (!(await hasInvoiceEligibleAssociatedOwner(unitData.associatedOwnerIds, session))) return false;

  const invoiceCount = existingInvoiceCount ?? await countExistingInvoices(propertyId, session);
  if (invoiceCount > 0) return false;

  const { invoices, remainingCredit } = await generateUnitInvoices(unitData, propertyId, propertyName, session, {
    includeOpeningBalanceInvoice,
    notifyCreatedEmails: false,
  });

  const creditToPersist = await ledgerService.resolvePropertyRemainingCreditAfterInvoiceGeneration(
    propertyId,
    remainingCredit,
    session
  );

  await Property.findByIdAndUpdate(
    propertyId,
    { $set: { remainingCredit: creditToPersist } },
    { session }
  );

  if (!session && Array.isArray(invoices) && invoices.length > 0) {
    const { notifyScheduleInvoiceCreatedEmails } = require('./invoiceScheduleNotify.service');
    notifyScheduleInvoiceCreatedEmails(invoices);
  }

  return { generated: true, invoices: invoices || [] };
};

const queueBillingInvoiceGeneration = ({ propertyId, propertyName, unitData, context = 'unit', mode = 'initial' }) => {
  if (!propertyId || !hasBillingConfiguration(unitData)) return;

  const markStatus = async (status, extra = {}) => {
    await Property.findByIdAndUpdate(propertyId, {
      $set: {
        'requestPayload.billingProcessingStatus': status,
        'requestPayload.billingProcessingUpdatedAt': ClockService.now(),
        ...extra,
      },
    });
  };

  const runGeneration = async () => {
    await markStatus('processing');

    const freshUnit = await Property.findById(propertyId).lean();
    if (!freshUnit) {
      await markStatus('complete');
      return;
    }

    const rp =
      freshUnit.requestPayload && typeof freshUnit.requestPayload === 'object' && !Array.isArray(freshUnit.requestPayload)
        ? freshUnit.requestPayload
        : {};
    const preferHoaSettings =
      context === 'add-owner' ||
      (mode === 'regenerate' && unitData.paymentDueDay == null);
    const paymentDueDay = await resolveUnitPaymentDueDay({
      hoaId: freshUnit.hoaId || unitData.hoaId,
      requestPayload: rp,
      explicitDay: unitData.paymentDueDay,
      preferHoaSettings,
    });
    await Property.findByIdAndUpdate(propertyId, {
      $set: { 'requestPayload.paymentDueDay': paymentDueDay },
    });
    const freshUnitData = {
      ...unitData,
      startingBalance: freshUnit.startingBalance,
      balanceAsOf: freshUnit.balanceAsOf,
      monthlyRecurringFee: freshUnit.monthlyRecurringFee,
      paymentTerm: freshUnit.paymentTerm,
      associatedOwnerIds: freshUnit.associatedOwnerIds,
      paymentDueDay,
      createdBy: freshUnit.createdBy || unitData.createdBy,
      hoaBoardMemberId: freshUnit.hoaBoardMemberId || unitData.hoaBoardMemberId,
      hoaId: freshUnit.hoaId || unitData.hoaId,
      title:
        freshUnit.unitDetails && freshUnit.unitDetails[0] && freshUnit.unitDetails[0].unitName
          ? freshUnit.unitDetails[0].unitName
          : unitData.title,
    };

    if (!Array.isArray(freshUnitData.associatedOwnerIds) || freshUnitData.associatedOwnerIds.length === 0) {
      await markStatus('complete');
      return;
    }

    if (!(await hasInvoiceEligibleAssociatedOwner(freshUnitData.associatedOwnerIds))) {
      await markStatus('complete');
      return;
    }

    if (mode === 'initial') {
      const shouldGenerate = await shouldGenerateBillingInvoices(propertyId, freshUnitData);
      if (!shouldGenerate) {
        await markStatus('complete');
        return;
      }
    }

    const { invoices, remainingCredit } = await generateUnitInvoices(
      freshUnitData,
      propertyId,
      propertyName || freshUnit.name,
      null,
      {
        includeOpeningBalanceInvoice: true,
        notifyCreatedEmails: false,
      }
    );

    if (Array.isArray(invoices) && invoices.length > 0) {
      try {
        const { notifyScheduleInvoiceCreatedEmails } = require('./invoiceScheduleNotify.service');
        await notifyScheduleInvoiceCreatedEmails(invoices, { background: false });
      } catch (notifyErr) {
        logger.warn('[unit] Initial invoice notification failed:', notifyErr?.message || notifyErr);
      }
    }

    const creditToPersist = await ledgerService.resolvePropertyRemainingCreditAfterInvoiceGeneration(
      propertyId,
      remainingCredit
    );

    await Property.findByIdAndUpdate(propertyId, {
      $set: {
        remainingCredit: creditToPersist,
        hasGeneratedInvoices: true,
        'requestPayload.billingProcessingStatus': 'complete',
        'requestPayload.billingProcessingUpdatedAt': ClockService.now(),
      },
    });
  };

  setImmediate(async () => {
    try {
      await runGeneration();
      logger.info(`[${context}] async invoice generation completed for unit:`, propertyId);
    } catch (error) {
      logger.error(`[${context}] async invoice generation failed for unit ${propertyId}:`, error.message);
      try {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await runGeneration();
        logger.info(`[${context}] async invoice generation retry succeeded for unit:`, propertyId);
      } catch (retryErr) {
        logger.error(`[${context}] async invoice generation retry failed for unit ${propertyId}:`, retryErr.message);
        await markStatus('failed', {
          'requestPayload.billingProcessingError': String(retryErr.message || retryErr).slice(0, 500),
        });
      }
    }
  });
};

const getBillingProcessingStatus = (unit) => {
  const rp = unit?.requestPayload;
  if (rp && typeof rp === 'object' && !Array.isArray(rp) && rp.billingProcessingStatus) {
    return rp.billingProcessingStatus;
  }
  return null;
};

const getBillingProcessingError = (unit) => {
  const rp = unit?.requestPayload;
  if (rp && typeof rp === 'object' && !Array.isArray(rp) && rp.billingProcessingError) {
    return rp.billingProcessingError;
  }
  return null;
};

const markBillingPendingInSession = async (propertyId, session) => {
  await Property.findByIdAndUpdate(
    propertyId,
    { $set: { 'requestPayload.billingProcessingStatus': 'pending' } },
    { session }
  );
};

const buildUnitBackgroundMeta = (unitData = {}, options = {}) => {
  const invoicesQueued = Boolean(options.invoicesQueued);
  const ownerMailingSync = Boolean(options.ownerMailingSync);

  return {
    backgroundProcessing: {
      invoices: invoicesQueued,
      ownerMailingSync,
    },
    billingProcessingStatus: invoicesQueued ? 'pending' : (options.billingProcessingStatus ?? null),
  };
};

const buildCreateUnitBackgroundMeta = (unitData = {}) =>
  buildUnitBackgroundMeta(unitData, {
    invoicesQueued:
      hasBillingConfiguration(unitData) &&
      Array.isArray(unitData.associatedOwnerIds) &&
      unitData.associatedOwnerIds.length > 0,
    ownerMailingSync:
      Array.isArray(unitData.associatedOwnerIds) &&
      unitData.associatedOwnerIds.length > 0 &&
      !!unitData.address,
  });

const schedulePostUpdateBackgroundTasks = ({
  updated,
  unitData,
  invoiceData,
  invoicesQueued,
  invoiceQueueMode = 'initial',
  ownerMailingSync = false,
}) => {
  const propertyId = updated._id;
  const propertyName = updated.name;

  if (invoicesQueued && invoiceData) {
    queueBillingInvoiceGeneration({
      propertyId,
      propertyName,
      unitData: invoiceData,
      context: 'unit-update',
      mode: invoiceQueueMode,
    });
  }

  if (ownerMailingSync && updated.associatedOwnerIds?.length > 0 && updated.address) {
    setImmediate(async () => {
      try {
        await updateOwnersMailingAddress(updated.associatedOwnerIds, updated.address);
      } catch (e) {
        logger.warn('[updateUnit] async owner mailing sync failed:', e.message);
      }
    });
  }
};
const schedulePostCreateBackgroundTasks = (created, unitData) => {
  const propertyId = created._id;
  const propertyName = created.name;
  const willQueueInvoices =
    hasBillingConfiguration(unitData) &&
    Array.isArray(unitData.associatedOwnerIds) &&
    unitData.associatedOwnerIds.length > 0;

  if (willQueueInvoices) {
    queueBillingInvoiceGeneration({
      propertyId,
      propertyName,
      unitData,
      context: 'unit-create',
    });
  }

  if (unitData.associatedOwnerIds?.length > 0 && unitData.address) {
    setImmediate(async () => {
      try {
        await updateOwnersMailingAddress(unitData.associatedOwnerIds, {
          street: unitData.address.line1,
          line2: unitData.address.line2,
          city: unitData.address.city,
          state: unitData.address.state,
          zip: unitData.address.zipCode,
        });
      } catch (e) {
        logger.warn('[createUnit] async owner mailing sync failed:', e.message);
      }
    });
  }
};

/** HOA Property schema allows 12 | 24 | 36 | 60 months */
const snapPaymentTermMonthsToSchema = (months) => {
  const m = Number(months);
  if (!Number.isFinite(m) || m <= 0) return 12;
  const allowed = [12, 24, 36, 60];
  if (allowed.includes(m)) return m;
  const higher = allowed.find((a) => a >= m);
  return higher || 60;
};

const utcDateOnlyString = (d = ClockService.now()) => {
  const key = getDateKeyInTimeZone(d);
  if (key) return key;
  const parsed = DateUtil.toUTC(d);
  if (!parsed) return getDateKeyInTimeZone(ClockService.now()) || '';
  return getDateKeyInTimeZone(parsed) || '';
};

async function resolveUnitPaymentDueDay({
  hoaId,
  requestPayload,
  explicitDay,
  hoaSettings = null,
  preferHoaSettings = false,
}) {
  let settings = hoaSettings;
  if (!settings && hoaId) {
    const safeHoaId = toObjectId(hoaId);
    if (safeHoaId) {
      settings = await HOASettings.findOne({ hoaId: safeHoaId }).select('paymentTerm').lean();
    }
  }
  return resolvePaymentDueDayFromSources({
    explicitDay,
    requestPayload,
    hoaSettings: settings,
    preferHoaSettings,
  });
}

async function resolveHoaBillingDefaults(hoaId) {
  if (!hoaId) return null;
  const safeHoaId = toObjectId(hoaId);
  if (!safeHoaId) return null;
  const hoaSettings = await HOASettings.findOne({ hoaId: safeHoaId }).lean();
  const settingsEnabled = hoaSettings && hoaSettings.recurringFee?.enabled !== false;
  const settingsFeeAmount = settingsEnabled ? Number(hoaSettings.recurringFee?.amount ?? 0) : 0;
  const tenureYears = settingsEnabled ? Number(hoaSettings.recurringFee?.tenure ?? 0) : 0;
  const rawTermMonths = tenureYears > 0 ? tenureYears * 12 : 0;
  if (settingsFeeAmount <= 0 || rawTermMonths <= 0) return null;

  const dueDayRaw = hoaSettings?.paymentTerm?.dueDay;
  const paymentDueDay = resolvePaymentDueDayFromSources({
    explicitDay: dueDayRaw,
    hoaSettings,
  });

  return {
    monthlyRecurringFee: settingsFeeAmount,
    paymentTerm: snapPaymentTermMonthsToSchema(rawTermMonths),
    paymentDueDay,
  };
}

/** Apply HOA Settings billing defaults when a unit has owners but no explicit billing payload. */
async function hydrateUnitBillingFromHoaSettings(unitData = {}, hoaId) {
  if (hasBillingConfiguration(unitData)) return unitData;
  if (!Array.isArray(unitData.associatedOwnerIds) || unitData.associatedOwnerIds.length === 0) {
    return unitData;
  }

  const defaults = await resolveHoaBillingDefaults(hoaId);
  if (!defaults) return unitData;

  const balanceAsOf = unitData.balanceAsOf || getDateKeyInTimeZone(ClockService.now());
  const startingBalance = unitData.startingBalance !== undefined ? unitData.startingBalance : 0;

  return {
    ...unitData,
    startingBalance,
    balanceAsOf,
    monthlyRecurringFee: defaults.monthlyRecurringFee,
    paymentTerm: defaults.paymentTerm,
    paymentDueDay: unitData.paymentDueDay ?? defaults.paymentDueDay,
  };
}

const scheduleOwnerInvoiceGenerationForUnit = (unitId, ownerIds, options = {}) => {
  const ids = Array.isArray(ownerIds) ? ownerIds.filter(Boolean) : [];
  if (!unitId || ids.length === 0) return;

  setImmediate(async () => {
    for (const ownerId of ids) {
      try {
        await ensureInvoicesWhenOwnerLinkedToUnits([unitId], ownerId, options);
      } catch (err) {
        logger.warn(
          '[unit] Failed to generate invoices after owner assignment:',
          unitId,
          ownerId,
          err?.message || err
        );
      }
    }
  });
};

/**
 * Add-owner flow: after linking owner to units, generate HOA invoices from HOA settings -
 * balanceAsOf = today (UTC date), startingBalance = 0, fee/term from HOASettings, same as agreed flow.
 */
async function ensureInvoicesWhenOwnerLinkedToUnits(propertyIds, newOwnerId, options = {}) {
  if (!Array.isArray(propertyIds) || propertyIds.length === 0 || !newOwnerId) return;
  const session = options.session || null;
  const newOwnerStr = asIdString(newOwnerId);
  const actorUserId = options.userId || options.createdBy || options.hoaBoardMemberId;

  const linkedOwners = await loadOwnersForInvoiceEligibility([newOwnerStr], session);
  let linkedOwner = linkedOwners[0] || null;
  if (!linkedOwner) {
    let fallbackQuery = User.findById(newOwnerStr).select('portalOnboardingStatus status isArchived isDeleted');
    if (session) fallbackQuery = fallbackQuery.session(session);
    linkedOwner = await fallbackQuery.lean();
  }
  if (!shouldGenerateInvoicesForOwnerAssignment(linkedOwner, 0)) {
    logger.info('[ensureInvoicesWhenOwnerLinkedToUnits] skipped - owner is not verified', newOwnerStr);
    return;
  }

  const settingsByHoaId = new Map();
  const loadHoaSettings = async (hoaId) => {
    if (!hoaId) return null;
    const key = String(hoaId);
    if (settingsByHoaId.has(key)) return settingsByHoaId.get(key);
    let qs = HOASettings.findOne({ hoaId });
    if (session) qs = qs.session(session);
    const row = await qs.lean();
    settingsByHoaId.set(key, row);
    return row;
  };

  for (const pid of propertyIds) {
    const unitIdStr = asIdString(pid);
    if (!unitIdStr || !isValidObjectId(unitIdStr)) continue;

    let q = Property.findById(pid);
    if (session) q = q.session(session);
    const unit = await q;
    if (!unit) continue;

    const associatedOwnerIds = normalizeObjectIdStrings(unit.associatedOwnerIds || []);
    if (!associatedOwnerIds.includes(newOwnerStr)) continue;

    const invoiceCount = await countExistingInvoices(unit._id, session);
    if (invoiceCount > 0) continue;

    const hoaId = unit.hoaId || options.hoaId;
    const hoaSettings = await loadHoaSettings(hoaId);
    const settingsEnabled = hoaSettings && hoaSettings.recurringFee?.enabled !== false;
    const settingsFeeAmount = settingsEnabled ? Number(hoaSettings.recurringFee?.amount ?? 0) : 0;
    const tenureYears = settingsEnabled ? Number(hoaSettings.recurringFee?.tenure ?? 0) : 0;
    const settingsTermMonthsRaw = tenureYears > 0 ? tenureYears * 12 : 0;

    const feeAmount =
      settingsFeeAmount > 0
        ? settingsFeeAmount
        : Number(unit.monthlyRecurringFee || 0);
    const rawTermMonths =
      settingsTermMonthsRaw > 0
        ? settingsTermMonthsRaw
        : Number(unit.paymentTerm || 0);
    const paymentTermMonths = snapPaymentTermMonthsToSchema(rawTermMonths);
    const requestPayload =
      unit.requestPayload && typeof unit.requestPayload === 'object' && !Array.isArray(unit.requestPayload)
        ? unit.requestPayload
        : {};
    const paymentDueDay = resolvePaymentDueDayFromSources({
      requestPayload,
      hoaSettings,
      preferHoaSettings: true,
    });

    if (feeAmount <= 0 || rawTermMonths <= 0) continue;

    const balanceAsOf = unit.balanceAsOf
      ? utcDateOnlyString(unit.balanceAsOf)
      : getDateKeyInTimeZone(ClockService.now());
    const startingBalance = Number(unit.startingBalance || 0);
    const balanceAsOfDate = parseDateOnlyToNoonUtc(balanceAsOf);

    const prevRp = { ...requestPayload };
    if (paymentDueDay != null) prevRp.paymentDueDay = paymentDueDay;

    await Property.findByIdAndUpdate(
      unit._id,
      {
        $set: {
          startingBalance,
          balanceAsOf: balanceAsOfDate,
          monthlyRecurringFee: feeAmount,
          paymentTerm: paymentTermMonths,
          requestPayload: prevRp,
        },
      },
      { session }
    );

    const unitData = {
      startingBalance,
      balanceAsOf,
      monthlyRecurringFee: feeAmount,
      paymentTerm: paymentTermMonths,
      paymentDueDay,
      associatedOwnerIds,
      title:
        unit.unitDetails && unit.unitDetails[0] && unit.unitDetails[0].unitName
          ? unit.unitDetails[0].unitName
          : 'Unit',
      createdBy: actorUserId,
      hoaBoardMemberId: options.hoaBoardMemberId || actorUserId,
      hoaId,
    };

    if (!hasBillingConfiguration(unitData)) continue;

    const safeUnitIdForOb = toObjectId(unit._id);
    let obQ = LedgerEntry.countDocuments({ unitId: safeUnitIdForOb, type: 'opening_balance' });
    if (session) obQ = obQ.session(session);
    const obCount = await obQ;
    if (obCount === 0) {
      await ledgerService.createOpeningBalance(unit._id, startingBalance, balanceAsOfDate, session);
    }

    await generateBillingInvoicesIfNeeded({
      propertyId: unit._id,
      propertyName: unit.name,
      unitData,
      session,
      existingInvoiceCount: 0,
      includeOpeningBalanceInvoice: true,
    });
  }
}

/**
 * Owner verification is the invoice trigger. Generate HOA-fee invoices for
 * already-associated units, or attach the owner as a payer when invoices exist.
 */
async function ensureInvoicesWhenOwnerVerified(ownerId, options = {}) {
  if (!ownerId) return;
  const ownerIdStr = asIdString(ownerId);
  const session = options.session || null;
  const owners = await loadOwnersForInvoiceEligibility([ownerIdStr], session);
  let owner = owners[0];
  if (!owner) {
    let fallbackQuery = User.findById(ownerIdStr).select('portalOnboardingStatus status isArchived isDeleted propertyIds');
    if (session) fallbackQuery = fallbackQuery.session(session);
    owner = await fallbackQuery.lean();
  }
  if (!owner || !isOwnerEligibleForInvoiceGeneration(owner)) return;

  const fromUser = normalizeObjectIdStrings(owner.propertyIds || []);
  const ownerOid = toObjectId(ownerIdStr);
  const orFilters = [];
  if (fromUser.length > 0) {
    orFilters.push({ _id: { $in: toObjectIds(fromUser) } });
  }
  if (ownerOid) {
    orFilters.push({ associatedOwnerIds: ownerOid });
  }
  if (orFilters.length === 0) return;

  let unitQuery = Property.find({
    isDeleted: { $ne: true },
    $or: orFilters,
  }).select('_id associatedOwnerIds ownershipRecords');
  if (session) unitQuery = unitQuery.session(session);
  const units = await unitQuery.lean();
  if (!Array.isArray(units) || units.length === 0) return;

  const unitIds = units.map((unit) => unit._id);
  await ensureInvoicesWhenOwnerLinkedToUnits(unitIds, ownerIdStr, {
    ...options,
    session,
    source: options.source || 'owner-verified',
  });

  for (const unit of units) {
    const associated = normalizeObjectIdStrings(unit.associatedOwnerIds || []);
    if (!associated.includes(ownerIdStr)) continue;

    const records = Array.isArray(unit.ownershipRecords) ? unit.ownershipRecords : [];
    const activeRecord = records.find((record) => (
      record?.ownerId?.toString() === ownerIdStr && !record.endDate
    ));
    await syncInvoiceTenantsForAddOwner({
      unitId: asIdString(unit._id),
      ownerId: ownerIdStr,
      effectiveDate: toDateAtStartOfDay(activeRecord?.startDate || ClockService.now()),
      financialHandling: activeRecord?.financialHandling || 'FRESH',
      session,
    });
  }
}

const normalizeBillingDate = (value) => {
  if (!value) return null;
  // Keep YYYY-MM-DD / UTC-midnight calendar day (do not shift via America/New_York).
  const key = billingCalendarDateKey(value);
  if (key) return key;
  const iso = DateUtil.toISO(value);
  return iso ? iso.split('T')[0] : null;
};

const normalizeBillingNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : fallback;
};

const MIN_STARTING_BALANCE = -5000;

const clampStartingBalanceCredit = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed >= MIN_STARTING_BALANCE) return parsed;
  return MIN_STARTING_BALANCE;
};

const normalizeStartingBalance = (value, fallback = 0) =>
  clampStartingBalanceCredit(normalizeBillingNumber(value, fallback));

const applyStartingBalanceLimits = (unitData = {}) => {
  if (unitData.startingBalance === undefined || unitData.startingBalance === null) return;
  unitData.startingBalance = normalizeStartingBalance(unitData.startingBalance);
};

const resolveBillingConfiguration = (unitData = {}, existingUnit = {}, fallbackOwnerIds = []) => ({
  startingBalance: unitData.startingBalance !== undefined ? unitData.startingBalance : existingUnit.startingBalance,
  balanceAsOf: unitData.balanceAsOf || existingUnit.balanceAsOf,
  monthlyRecurringFee: unitData.monthlyRecurringFee !== undefined ? unitData.monthlyRecurringFee : existingUnit.monthlyRecurringFee,
  paymentTerm: unitData.paymentTerm || existingUnit.paymentTerm,
  paymentDueDay: unitData.paymentDueDay,
  associatedOwnerIds: unitData.ownerIds || unitData.associatedOwnerIds || fallbackOwnerIds || existingUnit.associatedOwnerIds || []
});

const billingConfigurationChanged = (existingUnit = {}, nextBillingConfig = {}) => {
  return (
    normalizeBillingNumber(existingUnit.startingBalance) !== normalizeBillingNumber(nextBillingConfig.startingBalance) ||
    normalizeBillingDate(existingUnit.balanceAsOf) !== normalizeBillingDate(nextBillingConfig.balanceAsOf) ||
    normalizeBillingNumber(existingUnit.monthlyRecurringFee) !== normalizeBillingNumber(nextBillingConfig.monthlyRecurringFee) ||
    Number(existingUnit.paymentTerm || 0) !== Number(nextBillingConfig.paymentTerm || 0)
  );
};

const isFeeOrTermOnlyBillingChange = (existingUnit = {}, nextBillingConfig = {}) => {
  const balanceChanged =
    normalizeBillingNumber(existingUnit.startingBalance) !== normalizeBillingNumber(nextBillingConfig.startingBalance) ||
    normalizeBillingDate(existingUnit.balanceAsOf) !== normalizeBillingDate(nextBillingConfig.balanceAsOf);
  const feeOrTermChanged =
    normalizeBillingNumber(existingUnit.monthlyRecurringFee) !== normalizeBillingNumber(nextBillingConfig.monthlyRecurringFee) ||
    Number(existingUnit.paymentTerm || 0) !== Number(nextBillingConfig.paymentTerm || 0);
  return feeOrTermChanged && !balanceChanged;
};

const applyBillingConfigurationChange = async ({
  unitId,
  existingUnit,
  invoiceData,
  updated,
  session,
  existingInvoiceCount,
  deletedByUserId,
  deferGeneration = false,
}) => {
  const feeOnly = isFeeOrTermOnlyBillingChange(existingUnit, invoiceData);
  if (feeOnly) {
    const unitDoc = updated.toObject ? updated.toObject() : updated;
    await recalculateFutureScheduleInvoicesForUnit(unitDoc, { session });
    return { invoicesQueued: false };
  }

  const deletedOpenInvoices = await softDeleteOpenAutoGeneratedInvoices(
    unitId,
    deletedByUserId,
    session
  );

  logger.info('Updating unit billing - regenerating open invoices:', {
    unitId,
    deletedOpenInvoices: deletedOpenInvoices.modifiedCount || 0
  });

  await ensureOpeningBalanceLedgerIfMissing(unitId, invoiceData, existingUnit, existingInvoiceCount, session);

  const hasOwners = Array.isArray(updated.associatedOwnerIds) && updated.associatedOwnerIds.length > 0;
  if (deferGeneration && hasBillingConfiguration(invoiceData) && hasOwners) {
    return { invoicesQueued: true, mode: 'regenerate' };
  }

  const openingAmtPositive =
    normalizeBillingNumber(
      invoiceData.startingBalance !== undefined ? invoiceData.startingBalance : 0
    ) > 0;

  const { invoices, remainingCredit } = await generateUnitInvoices(invoiceData, unitId, updated.name, session, {
    includeOpeningBalanceInvoice: existingInvoiceCount === 0 || openingAmtPositive,
    notifyCreatedEmails: false,
  });
  const creditToPersist = await ledgerService.resolvePropertyRemainingCreditAfterInvoiceGeneration(
    unitId,
    remainingCredit,
    session
  );
  await Property.findByIdAndUpdate(unitId, { $set: { remainingCredit: creditToPersist } }, { session });
  if (!session && Array.isArray(invoices) && invoices.length > 0) {
    const { notifyScheduleInvoiceCreatedEmails } = require('./invoiceScheduleNotify.service');
    notifyScheduleInvoiceCreatedEmails(invoices);
  }
  return { invoicesQueued: false, invoices: invoices || [] };
};

/**
 * Create opening_balance ledger row before first automated invoice run if missing (matches createUnit).
 */
const ensureOpeningBalanceLedgerIfMissing = async (unitId, invoiceData, existingUnit, existingInvoiceCount, session) => {
  if (existingInvoiceCount > 0) return;
  const safeUnitIdForLedger = toObjectId(unitId);
  let q = LedgerEntry.countDocuments({ unitId: safeUnitIdForLedger, type: 'opening_balance' });
  if (session) q = q.session(session);
  const obCount = await q;
  if (obCount > 0) return;
  const amount = normalizeBillingNumber(
    invoiceData.startingBalance !== undefined ? invoiceData.startingBalance : existingUnit.startingBalance
  );
  const asOf = invoiceData.balanceAsOf || existingUnit.balanceAsOf || ClockService.now();
  await ledgerService.createOpeningBalance(unitId, amount, asOf, session);
};

const softDeleteOpenAutoGeneratedInvoices = async (propertyId, deletedBy, session) => {
  const openStatuses = [
    INVOICE_STATUS.PENDING,
    INVOICE_STATUS.PARTIALLY_PAID,
    INVOICE_STATUS.OVERDUE
  ];

  const delSet = {
    isDeleted: true,
    deletedAt: ClockService.now(),
    deletedBy: deletedBy || undefined
  };

  const safePropertyId = toObjectId(propertyId);
  const monthlyResult = await Invoice.updateMany(
    {
      propertyId: safePropertyId,
      type: { $in: HOA_UNIT_SCHEDULE_INVOICE_TYPES },
      term: /^Month \d+$/,
      status: { $in: openStatuses },
      isDeleted: { $ne: true }
    },
    { $set: delSet },
    { session }
  );

  /** Past-due / carried opening rows from `generateUnitInvoices` - replace on billing change to avoid duplicates. */
  const pastDueResult = await Invoice.updateMany(
    {
      propertyId: safePropertyId,
      type: { $in: HOA_UNIT_SCHEDULE_INVOICE_TYPES },
      term: 'Past Due Balance',
      status: { $in: openStatuses },
      isDeleted: { $ne: true }
    },
    { $set: delSet },
    { session }
  );

  const m0 = Number(monthlyResult.modifiedCount || 0) || 0;
  const m1 = Number(pastDueResult.modifiedCount || 0) || 0;
  return { modifiedCount: m0 + m1, matchedCount: Number(monthlyResult.matchedCount || 0) + Number(pastDueResult.matchedCount || 0) };
};

async function resolveAssignerName(userId) {
  if (!userId) return process.env.APP_NAME || 'PropMv Team';
  const actor = await User.findById(userId).select('firstName lastName email').lean();
  if (!actor) return process.env.APP_NAME || 'PropMv Team';
  return `${actor.firstName || ''} ${actor.lastName || ''}`.trim() || actor.email || process.env.APP_NAME || 'PropMv Team';
}

async function notifyOwnersForUnitAssignment(ownerIds = [], propertyDoc, assignedByUserId) {
  if (!Array.isArray(ownerIds) || ownerIds.length === 0 || !propertyDoc) return;

  const owners = await User.find({
    _id: { $in: toObjectIds(ownerIds) },
    isDeleted: { $ne: true },
    email: { $exists: true, $ne: null },
  })
    .select('firstName lastName email hoaInfo')
    .lean();

  if (!owners.length) return;

  const property =
    propertyDoc && typeof propertyDoc.toObject === 'function'
      ? propertyDoc.toObject()
      : propertyDoc;
  const assignedByName = await resolveAssignerName(assignedByUserId);
  await Promise.all(
    owners.map((owner) =>
      sendUnitAssignmentEmail({
        recipient: owner,
        property,
        assignedByName,
        hoaId: property?.hoaId || null,
      }),
    ),
  );
}

const toDateAtStartOfDay = (value = ClockService.now()) => {
  // YYYY-MM-DD (and Joi UTC-midnight Date forms) must keep their calendar day.
  // getDateKeyInTimeZone alone shifts UTC midnight back a day in America/New_York.
  let key = null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      key = trimmed;
    } else if (trimmed.includes('T')) {
      key = dateOnlyKeyFromStoredInstant(trimmed) || getDateKeyInTimeZone(trimmed);
    }
  } else {
    key = dateOnlyKeyFromStoredInstant(value) || getDateKeyInTimeZone(value);
  }
  if (!key) {
    const err = new Error('Invalid effective date');
    err.status = 400;
    throw err;
  }
  const anchored = parseDateOnlyToNoonUtc(key);
  if (!anchored) {
    const err = new Error('Invalid effective date');
    err.status = 400;
    throw err;
  }
  return anchored;
};

/**
 * True when an ownership period still covers `effectiveDate` (calendar noon anchor).
 * Ended / inverted periods (endDate <= startDate or end calendar day <= effective day) do not block re-add.
 * Same-day remove + re-add: today removals store wall-clock endDate (often after noon) but the period
 * is closed for the entire effective calendar day once removed.
 */
const ownershipRecordOverlapsEffectiveDate = (record, effectiveDate) => {
  if (!record?.startDate || !effectiveDate) return false;
  const startMs = record.startDate.getTime();
  const effectiveMs = effectiveDate.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(effectiveMs)) return false;

  if (record.endDate) {
    const endMs = record.endDate.getTime();
    if (!Number.isFinite(endMs)) return false;
    // Zero-length or inverted rows from same-day remove-before-noon are fully closed.
    if (endMs <= startMs) return false;

    const endKey = billingCalendarDateKey(record.endDate);
    const effectiveKey = billingCalendarDateKey(effectiveDate);
    if (endKey && effectiveKey && endKey <= effectiveKey) return false;

    // Exclusive end on a later calendar day: inactive at/after endDate timestamp.
    if (endMs <= effectiveMs) return false;
  }

  if (startMs === effectiveMs && !record.endDate) return true;
  return startMs <= effectiveMs && (!record.endDate || record.endDate.getTime() > effectiveMs);
};

/**
 * Removal (and other today-or-future flows): effective date must be today or a future calendar day.
 * Rejects past dates even if the client bypasses the date picker.
 */
const assertOwnershipEffectiveDateNotInPast = (effectiveDateInput, label = 'Effective date') => {
  if (!effectiveDateInput) {
    const err = new Error(`${label} is required`);
    err.status = 400;
    throw err;
  }
  const refDate = DateUtil.toUTC(effectiveDateInput);
  if (Number.isNaN(refDate.getTime())) {
    const err = new Error(`Invalid ${label.toLowerCase()}`);
    err.status = 400;
    throw err;
  }
  const effectiveKey = dateOnlyKeyFromStoredInstant(refDate) || getDateKeyInTimeZone(refDate);
  const todayKey = getDateKeyInTimeZone(ClockService.now());
  if (effectiveKey && todayKey && effectiveKey < todayKey) {
    const err = new Error(
      `${label} cannot be in the past. Choose today or a future date.`
    );
    err.status = 400;
    throw err;
  }
};

/**
 * Add Owner / Change Ownership: Balance as of ≤ effective date ≤ today.
 * Rejects dates before the unit's Balance as of date and future dates.
 */
const resolveBalanceAsOfDateKey = (balanceAsOfInput, fallback = null) => {
  const raw = balanceAsOfInput || fallback;
  if (!raw) return getDateKeyInTimeZone(ClockService.now());
  return (
    normalizeBillingDate(raw)
    || dateOnlyKeyFromStoredInstant(raw)
    || getDateKeyInTimeZone(DateUtil.toUTC(raw))
    || getDateKeyInTimeZone(ClockService.now())
  );
};

const assertOwnershipEffectiveDateWithinBalanceWindow = (
  effectiveDateInput,
  balanceAsOfInput,
  label = 'Effective date',
  options = {}
) => {
  if (!effectiveDateInput) {
    const err = new Error(`${label} is required`);
    err.status = 400;
    throw err;
  }
  const refDate = DateUtil.toUTC(effectiveDateInput);
  if (Number.isNaN(refDate.getTime())) {
    const err = new Error(`Invalid ${label.toLowerCase()}`);
    err.status = 400;
    throw err;
  }
  const effectiveKey = dateOnlyKeyFromStoredInstant(refDate) || getDateKeyInTimeZone(refDate);
  const todayKey = getDateKeyInTimeZone(ClockService.now());
  const balanceKey = resolveBalanceAsOfDateKey(balanceAsOfInput, options.fallbackBalanceAsOf);

  if (effectiveKey && balanceKey && effectiveKey < balanceKey) {
    const err = new Error(
      `${label} cannot be earlier than the property Balance as of date (${balanceKey}).`
    );
    err.status = 400;
    throw err;
  }
  if (effectiveKey && todayKey && effectiveKey > todayKey) {
    const err = new Error(
      `${label} cannot be in the future. Choose a date between the Balance as of date and today.`
    );
    err.status = 400;
    throw err;
  }
};

/** @deprecated Use assertOwnershipEffectiveDateNotInPast */
const assertRemovalEffectiveDateNotInPast = (effectiveDateInput) =>
  assertOwnershipEffectiveDateNotInPast(effectiveDateInput, 'Effective removal date');

/**
 * Persisted ownership start date for an owner currently associated with a unit.
 * Prefers the active timeline row; falls back to the latest open-ended record.
 */
const resolveOwnershipEffectiveDateForOwner = (unit, ownerId, at = ClockService.now()) => {
  if (!unit || !ownerId) return null;
  const ownerIdStr = String(ownerId);
  const timeline = ensureOwnershipTimeline(unit, unit?.createdAt || at);

  const pickLatestStart = (records) => {
    if (!records.length) return null;
    return records
      .slice()
      .sort((a, b) => (b.startDate?.getTime?.() || 0) - (a.startDate?.getTime?.() || 0))[0]
      ?.startDate || null;
  };

  const activeAt = timeline.filter(
    (record) =>
      record.ownerId?.toString() === ownerIdStr && isOwnershipRecordActiveAt(record, at)
  );
  const activeStart = pickLatestStart(activeAt);
  if (activeStart) return activeStart;

  // Same-day noon anchors: record may not be "active" yet before wall-clock noon.
  const todayKey = billingCalendarDateKey(at);
  const pendingSameDay = timeline.filter((record) => {
    if (record.ownerId?.toString() !== ownerIdStr || !record.startDate) return false;
    if (billingCalendarDateKey(record.startDate) !== todayKey) return false;
    if (record.endDate && record.endDate.getTime() <= record.startDate.getTime()) return false;
    return !record.endDate || record.endDate.getTime() > at.getTime();
  });
  const pendingStart = pickLatestStart(pendingSameDay);
  if (pendingStart) return pendingStart;

  const openEnded = timeline.filter(
    (record) =>
      record.ownerId?.toString() === ownerIdStr &&
      record.startDate &&
      !record.endDate
  );
  return pickLatestStart(openEnded);
};

const pickLatestOwnershipRecordForOwner = (timeline = [], ownerIdStr) => {
  const records = timeline.filter(
    (record) => record.ownerId?.toString() === ownerIdStr && record.startDate,
  );
  if (!records.length) return null;
  return records
    .slice()
    .sort((a, b) => (b.startDate?.getTime?.() || 0) - (a.startDate?.getTime?.() || 0))[0];
};

/**
 * Ownership period + status for property detail / owner listings.
 * scheduled_removal = still active today but endDate is a future calendar day.
 * Uses the same current-owner evaluation as listings so same-day noon transfers
 * do not leave previous owners marked current before wall-clock noon.
 */
const resolveOwnershipPeriodForOwner = (unit, ownerId, at = ClockService.now()) => {
  if (!unit || !ownerId) {
    return { startDate: null, endDate: null, status: null };
  }
  const ownerIdStr = String(ownerId);
  const timeline = ensureOwnershipTimeline(unit, unit?.createdAt || at);
  const record = pickLatestOwnershipRecordForOwner(timeline, ownerIdStr);
  if (!record) {
    return { startDate: null, endDate: null, status: null };
  }

  const { startDate, endDate } = record;
  const currentOwnerIds = new Set(getCurrentOwnerIdsFromUnit(unit, at));
  const isCurrent = currentOwnerIds.has(ownerIdStr);

  let status;
  if (isCurrent) {
    status = endDate && isFutureCalendarEffectiveDate(endDate, at) ? 'scheduled_removal' : 'current';
  } else if (endDate && !isFutureCalendarEffectiveDate(endDate, at)) {
    // Ended on or before today's calendar day (exclusive noon transfer end).
    status = 'removed';
  } else {
    status = 'previous';
  }

  return {
    startDate: startDate || null,
    endDate: endDate || null,
    status,
  };
};

const isFutureCalendarEffectiveDate = (effectiveDate, now = ClockService.now()) => {
  const effectiveKey =
    dateOnlyKeyFromStoredInstant(effectiveDate) || getDateKeyInTimeZone(effectiveDate);
  const todayKey = getDateKeyInTimeZone(now);
  return Boolean(effectiveKey && todayKey && effectiveKey > todayKey);
};

const normalizeObjectIdStrings = (values = []) => (
  [...new Set((Array.isArray(values) ? values : [values])
    .filter(Boolean)
    .map((value) => value.toString()))]
);

/** When PUT/PATCH sends only associatedOwnerIds, still sync owners' User.propertyIds (parity with POST create). */
const resolveOwnersPayloadForUnitUpdate = (unitData = {}) => {
  if (unitData.ownerIds !== undefined) {
    return Array.isArray(unitData.ownerIds) ? unitData.ownerIds : [];
  }
  if (unitData.associatedOwnerIds !== undefined) {
    return Array.isArray(unitData.associatedOwnerIds) ? unitData.associatedOwnerIds : [];
  }
  return undefined;
};

const cloneOwnershipRecords = (records = []) => (
  (Array.isArray(records) ? records : []).map((record) => ({
    ownerId: record.ownerId?.toString ? record.ownerId.toString() : record.ownerId,
    startDate: record.startDate ? (DateUtil.toUTC(record.startDate)) : null,
    endDate: record.endDate ? (DateUtil.toUTC(record.endDate)) : null,
    financialHandling: record.financialHandling || 'FRESH',
    createdAt: record.createdAt ? (DateUtil.toUTC(record.createdAt) || ClockService.now()) : ClockService.now(),
  }))
);

const getActiveOwnerIdsFromRecords = (records = [], at = ClockService.now()) => (
  normalizeObjectIdStrings(
    records
      .filter((record) => record.startDate && record.startDate <= at && (!record.endDate || record.endDate > at))
      .map((record) => record.ownerId)
  )
);

/**
 * Point-in-time used after ending/starting ownership on `effectiveDate`.
 * Timeline rows are anchored at calendar noon; evaluating "now" before noon UTC
 * incorrectly keeps ended owners active and excludes newly started ones.
 */
const ownershipActivityAtAfterEffectiveDate = (effectiveDate, now = ClockService.now()) => {
  const effectiveMs = effectiveDate instanceof Date ? effectiveDate.getTime() : NaN;
  const nowMs = now instanceof Date ? now.getTime() : ClockService.nowEpoch();
  if (!Number.isFinite(effectiveMs)) return now;
  return new Date(Math.max(nowMs, effectiveMs) + 1);
};

/**
 * When persisting associatedOwnerIds after add/change ownership, evaluate "who is current now".
 * Future effective dates must not activate new owners early; same-day transfers still use the
 * noon-safe activity anchor so today changes take effect immediately after save.
 */
const ownershipActivityAtForCurrentAssociation = (effectiveDate, now = ClockService.now()) => {
  if (isFutureCalendarEffectiveDate(effectiveDate, now)) {
    return now;
  }
  return ownershipActivityAtAfterEffectiveDate(effectiveDate, now);
};

/**
 * Calendar-day evaluation instant for "who is current now".
 *
 * Timeline rows are anchored at calendar noon. Before noon on an effective day:
 * - previous owners with endDate = today's noon still look active
 * - new owners with startDate = today's noon still look inactive
 *
 * Write paths already use ownershipActivityAtForCurrentAssociation(); reads must
 * match so email/UI/listings share one source of truth once the calendar day is reached.
 */
const resolveCurrentOwnershipEvaluationAt = (timeline = [], at = ClockService.now()) => {
  const todayKey = billingCalendarDateKey(at);
  let latestPendingSameDayStart = null;
  for (const record of timeline) {
    if (!record?.startDate) continue;
    if (billingCalendarDateKey(record.startDate) !== todayKey) continue;
    if (record.endDate && record.endDate.getTime() <= record.startDate.getTime()) continue;
    if (record.endDate && record.endDate.getTime() <= at.getTime()) continue;
    if (record.startDate.getTime() > at.getTime()) {
      if (
        !latestPendingSameDayStart
        || record.startDate.getTime() > latestPendingSameDayStart.getTime()
      ) {
        latestPendingSameDayStart = record.startDate;
      }
    }
  }
  if (latestPendingSameDayStart) {
    return ownershipActivityAtAfterEffectiveDate(latestPendingSameDayStart, at);
  }
  return at;
};

const getCurrentOwnerIdsFromUnit = (unit, at = ClockService.now()) => {
  const timeline = ensureOwnershipTimeline(unit, unit?.createdAt || at);
  // Prefer noon-safe evaluation whenever a same-day start is pending - do not return
  // early with previous owners who only remain "active" because endDate is today's noon.
  const evaluationAt = resolveCurrentOwnershipEvaluationAt(timeline, at);
  const active = getActiveOwnerIdsFromRecords(timeline, evaluationAt);
  if (active.length > 0) return active;

  // Live association fallback: never hide owners still linked on the unit when the
  // timeline has no active row at `at` (legacy data / temporary empty evaluation).
  return normalizeObjectIdStrings(unit.associatedOwnerIds || []);
};

const isOwnershipRecordActiveAt = (record, at) => (
  Boolean(record?.startDate) &&
  record.startDate <= at &&
  (!record.endDate || record.endDate > at)
);

/** Future removals end at 00:00 in the business timezone on the effective calendar day. */
const removalEndInstantForEffectiveDate = (effectiveDate, isRemovalToday, now = ClockService.now()) => {
  if (isRemovalToday) return now;
  const effectiveKey = billingCalendarDateKey(effectiveDate);
  if (!effectiveKey) return toDateAtStartOfDay(effectiveDate);
  return DateUtil.calendarDateTimeInTimezoneToUtc(effectiveKey, 0, 0, 0, TIMEZONE.BUSINESS);
};

/**
 * After closing one owner's timeline row, resolve who remains associated on the unit.
 * Uses associatedOwnerIds as the source of truth for co-owners so a same-day remove
 * before calendar-noon start anchors does not incorrectly look like last-owner removal.
 */
const resolveRemainingOwnerIdsAfterRemoval = ({
  previousOwnerIds = [],
  removedOwnerId,
  ownershipRecords = [],
  removalEndDate,
  isRemovalToday,
  now = ClockService.now(),
}) => {
  const removedId = removedOwnerId?.toString?.() || String(removedOwnerId || '');
  const previous = normalizeObjectIdStrings(previousOwnerIds);
  const remainingAssociated = previous.filter((id) => id !== removedId);

  if (isRemovalToday) {
    // Keep every other previously associated owner who still has an open (or not-yet-ended)
    // ownership period - including records that start later today at calendar noon.
    const kept = remainingAssociated.filter((ownerId) =>
      ownershipRecords.some((record) => {
        if (record.ownerId?.toString() !== ownerId) return false;
        if (!record.startDate) return false;
        return !record.endDate || record.endDate > removalEndDate;
      })
    );
    if (kept.length > 0) return normalizeObjectIdStrings(kept);
    // Fall back to timeline evaluation (covers stale associatedOwnerIds).
  }

  const at = isRemovalToday
    ? ownershipActivityAtAfterEffectiveDate(removalEndDate, now)
    : now;
  return getActiveOwnerIdsFromRecords(ownershipRecords, at).filter((id) => id !== removedId);
};
const findOwnershipRecordForRemoval = ({
  ownershipRecords = [],
  ownerId,
  associatedOwnerIds = [],
  removalEndDate,
  effectiveKey,
  now = ClockService.now(),
}) => {
  const ownerIdStr = ownerId?.toString?.() || String(ownerId || '');
  if (!ownerIdStr) return null;

  const activeAtRemoval = ownershipRecords.find((record) => (
    record.ownerId?.toString() === ownerIdStr &&
    isOwnershipRecordActiveAt(record, removalEndDate)
  ));
  if (activeAtRemoval) return activeAtRemoval;

  // Today removals: prefer currently-active-at-now when removalEndDate is "now".
  const activeNow = ownershipRecords.find((record) => (
    record.ownerId?.toString() === ownerIdStr &&
    isOwnershipRecordActiveAt(record, now)
  ));
  if (activeNow) return activeNow;

  const stillAssociated = normalizeObjectIdStrings(associatedOwnerIds).includes(ownerIdStr);
  if (!stillAssociated) return null;

  // Associated owner with an open-ended row (including calendar-noon start later today).
  const openEnded = ownershipRecords.find((record) => (
    record.ownerId?.toString() === ownerIdStr && !record.endDate && record.startDate
  ));
  if (openEnded) return openEnded;

  const endedOnEffectiveDay = ownershipRecords.find((record) => (
    record.ownerId?.toString() === ownerIdStr &&
    record.endDate &&
    effectiveKey &&
    billingCalendarDateKey(record.endDate) === effectiveKey
  ));
  return endedOnEffectiveDay || null;
};

const buildInitialOwnershipRecords = (ownerIds = [], startDate = ClockService.now()) => (
  normalizeObjectIdStrings(ownerIds).map((ownerId) => ({
    ownerId,
    startDate: toDateAtStartOfDay(startDate),
    endDate: null,
    financialHandling: 'FRESH',
    createdAt: ClockService.now(),
  }))
);

const ensureOwnershipTimeline = (unit, fallbackStartDate = ClockService.now()) => {
  const existingRecords = cloneOwnershipRecords(unit.ownershipRecords || []);
  if (existingRecords.length > 0) {
    return existingRecords;
  }
  return buildInitialOwnershipRecords(unit.associatedOwnerIds || [], fallbackStartDate);
};

const syncOwnerPropertyMembership = async (unitId, previousOwnerIds, nextOwnerIds, session) => {
  const oldOwnerIds = normalizeObjectIdStrings(previousOwnerIds);
  const newOwnerIds = normalizeObjectIdStrings(nextOwnerIds);
  const removedOwners = oldOwnerIds.filter((id) => !newOwnerIds.includes(id));
  const addedOwners = newOwnerIds.filter((id) => !oldOwnerIds.includes(id));

  if (removedOwners.length > 0) {
    await User.updateMany(
      { _id: { $in: toObjectIds(removedOwners) } },
      { $pull: { propertyIds: unitId } },
      { session }
    );
  }

  if (addedOwners.length > 0) {
    await User.updateMany(
      { _id: { $in: toObjectIds(addedOwners) } },
      { $addToSet: { propertyIds: unitId } },
      { session }
    );
  }

  return { removedOwners, addedOwners };
};

const createOwnershipLogEntry = ({ action, ownerIds, effectiveDate, performedBy, details = {} }) => ({
  action,
  ownerIds: normalizeObjectIdStrings(ownerIds),
  effectiveDate: effectiveDate ? toDateAtStartOfDay(effectiveDate) : undefined,
  timestamp: ClockService.now(),
  performedBy: performedBy || undefined,
  details,
});

const OWNERSHIP_ACTIVITY_ACTION = {
  ADD: 'OWNER_ADDED',
  REMOVE: 'OWNER_REMOVED',
  CHANGE: 'OWNER_CHANGED',
};

const OWNERSHIP_ACTIVITY_TITLE = {
  OWNER_ADDED: 'Owner Added',
  OWNER_REMOVED: 'Owner Removed',
  OWNER_CHANGED: 'Owner Changed',
};

const formatPersonDisplayName = (user) => {
  if (!user) return '';
  if (typeof user === 'string') return user.trim();
  const full = `${user.firstName || ''} ${user.lastName || ''}`.trim();
  return full || String(user.email || '').trim() || '';
};

const formatOwnerNamesList = (names = []) => {
  const cleaned = (Array.isArray(names) ? names : []).map((n) => String(n || '').trim()).filter(Boolean);
  if (cleaned.length === 0) return 'an owner';
  if (cleaned.length === 1) return cleaned[0];
  if (cleaned.length === 2) return `${cleaned[0]} and ${cleaned[1]}`;
  return `${cleaned.slice(0, -1).join(', ')}, and ${cleaned[cleaned.length - 1]}`;
};

const resolveUnitDisplayLabel = (unit) => {
  if (!unit) return 'Unit';
  const fromDetails =
    unit.unitDetails && unit.unitDetails[0] && unit.unitDetails[0].unitName
      ? String(unit.unitDetails[0].unitName).trim()
      : '';
  return fromDetails || String(unit.name || unit.title || 'Unit').trim() || 'Unit';
};

const buildOwnershipActivityDescription = ({
  action,
  previousOwnerNames = [],
  newOwnerNames = [],
  unitLabel,
  performedByName,
  performedAt,
}) => {
  const unit = unitLabel || 'Unit';
  const dateLabel = formatDateInAppTimezone(performedAt || ClockService.now(), {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const byClause = performedByName ? ` by ${performedByName}` : '';
  const onClause = dateLabel ? ` on ${dateLabel}` : '';
  const prevLabel = formatOwnerNamesList(previousOwnerNames);
  const nextLabel = formatOwnerNamesList(newOwnerNames);
  const prevVerb = (Array.isArray(previousOwnerNames) && previousOwnerNames.filter(Boolean).length > 1) ? 'were' : 'was';
  const nextVerb = (Array.isArray(newOwnerNames) && newOwnerNames.filter(Boolean).length > 1) ? 'were' : 'was';

  if (action === OWNERSHIP_ACTIVITY_ACTION.REMOVE) {
    return `${prevLabel} ${prevVerb} removed from ${unit}${byClause}${onClause}.`;
  }
  if (action === OWNERSHIP_ACTIVITY_ACTION.CHANGE) {
    return `${prevLabel} ${prevVerb} replaced by ${nextLabel} for ${unit}${byClause}${onClause}.`;
  }
  // OWNER_ADDED
  return `${nextLabel} ${nextVerb} added as ${
    Array.isArray(newOwnerNames) && newOwnerNames.filter(Boolean).length > 1 ? 'owners' : 'an owner'
  } of ${unit}${byClause}${onClause}.`;
};

/**
 * Persist ownership audit for Dashboard Recent Activity + Invoice Activity Timeline.
 * Does not mutate invoice.tenants (historical payer info stays intact).
 */
async function recordOwnershipChangeActivities({
  unit,
  unitId,
  action,
  previousOwnerIds = [],
  newOwnerIds = [],
  performedBy,
  performedAt = ClockService.now(),
  session = null,
  source = 'ownership-flow',
}) {
  const activityAction = OWNERSHIP_ACTIVITY_ACTION[action] || action;
  if (!activityAction || !OWNERSHIP_ACTIVITY_TITLE[activityAction]) {
    logger.warn('[recordOwnershipChangeActivities] Unknown ownership action:', action);
    return null;
  }

  const unitOid = toObjectId(unitId) || toObjectId(unit?._id);
  if (!unitOid) return null;

  const prevIds = normalizeObjectIdStrings(previousOwnerIds);
  const nextIds = normalizeObjectIdStrings(newOwnerIds);
  const nameIds = [...new Set([...prevIds, ...nextIds, asIdString(performedBy)].filter(Boolean))];
  const users = nameIds.length
    ? await User.find({ _id: { $in: toObjectIds(nameIds) } })
      .select('firstName lastName email')
      .lean()
    : [];
  const nameById = new Map(
    users.map((u) => [String(u._id), formatPersonDisplayName(u)])
  );

  const previousOwnerNames = prevIds.map((id) => nameById.get(id) || 'Unknown owner');
  const newOwnerNames = nextIds.map((id) => nameById.get(id) || 'Unknown owner');
  const performedByName = performedBy
    ? (nameById.get(asIdString(performedBy)) || 'Unknown user')
    : '';
  const unitLabel = resolveUnitDisplayLabel(unit);
  const description = buildOwnershipActivityDescription({
    action: activityAction,
    previousOwnerNames,
    newOwnerNames,
    unitLabel,
    performedByName,
    performedAt,
  });

  const ownershipHistoryEntry = {
    action: activityAction,
    previousOwnerIds: toObjectIds(prevIds),
    newOwnerIds: toObjectIds(nextIds),
    previousOwnerNames,
    newOwnerNames,
    propertyId: unitOid,
    unitId: unitOid,
    unitLabel,
    description,
    performedBy: toObjectId(performedBy) || undefined,
    performedAt: performedAt instanceof Date ? performedAt : ClockService.now(),
  };

  const updateOpts = session ? { session } : {};
  await Invoice.updateMany(
    { propertyId: unitOid, isDeleted: { $ne: true } },
    { $push: { ownershipHistory: ownershipHistoryEntry } },
    updateOpts
  );

  if (performedBy) {
    await logActivity({
      userId: performedBy,
      action: activityAction,
      module: 'Unit',
      entityId: unitOid,
      entityName: unitLabel,
      description,
      meta: {
        action: activityAction,
        previousOwnerIds: prevIds,
        newOwnerIds: nextIds,
        previousOwnerNames,
        newOwnerNames,
        propertyId: String(unitOid),
        unitId: String(unitOid),
        unitLabel,
        performedBy: asIdString(performedBy),
        performedAt: ownershipHistoryEntry.performedAt,
        source,
      },
    });
  }

  return ownershipHistoryEntry;
}

const syncInvoiceTenantsForAddOwner = async ({ unitId, ownerId, effectiveDate, financialHandling, session }) => {
  const query = {
    propertyId: unitId,
    isDeleted: { $ne: true },
    tenants: { $ne: ownerId },
  };

  // Effective date always gates invoice association. Future-dated owners must not
  // appear on invoices that predate their start. INCLUDE_BALANCE on today still
  // shares all open balances (including overdue); future INCLUDE_BALANCE only
  // touches open invoices due on/after the effective date.
  if (financialHandling === 'INCLUDE_BALANCE' && !isFutureCalendarEffectiveDate(effectiveDate)) {
    query.balanceDue = { $gt: 0 };
  } else {
    query.dueDate = { $gte: effectiveDate };
    if (financialHandling === 'INCLUDE_BALANCE') {
      query.balanceDue = { $gt: 0 };
    }
  }

  await Invoice.updateMany(
    query,
    { $addToSet: { tenants: ownerId } },
    { session }
  );
};

/**
 * Owner create/update flows link owners to units via propertyIds without going through addOwner.
 * Mirror addOwner side effects: ownership timeline + future invoice payers.
 */
async function linkOwnerToUnitsFromOwnerFlow(propertyIds, ownerId, options = {}) {
  if (!Array.isArray(propertyIds) || propertyIds.length === 0 || !ownerId) return;

  const ownerIdStr = asIdString(ownerId);
  const session = options.session || null;
  const ownerRoleFilter = await buildHOAOwnerUserFilter();
  let ownerQuery = User.findOne({ $and: [ownerRoleFilter, { _id: ownerIdStr }] })
    .select('portalOnboardingStatus status isArchived isDeleted');
  if (session) ownerQuery = ownerQuery.session(session);
  const ownerDoc = await ownerQuery.lean();
  if (!ownerDoc) {
    const err = new Error('Owner not found');
    err.status = 404;
    throw err;
  }
  assertOwnerEligibleForPropertyAssignment(ownerDoc);
  const ownerInvoiceEligible = isOwnerEligibleForInvoiceGeneration(ownerDoc);

  const effectiveDate = toDateAtStartOfDay(options.effectiveDate || ClockService.now());
  const financialHandling = options.financialHandling || 'FRESH';
  const performedBy = options.userId || options.createdBy || options.hoaBoardMemberId;
  const linkedUnits = [];

  for (const pid of propertyIds) {
    const unitIdStr = asIdString(pid);
    if (!unitIdStr || !isValidObjectId(unitIdStr)) continue;

    let q = Property.findById(pid);
    if (session) q = q.session(session);
    const unit = await q;
    if (!unit) continue;

    const previousOwnerIds = normalizeObjectIdStrings(unit.associatedOwnerIds || []);
    if (previousOwnerIds.includes(ownerIdStr)) continue;

    const ownershipRecords = ensureOwnershipTimeline(unit, unit.createdAt);
    const hasConflictingRecord = ownershipRecords.some((record) => (
      record.ownerId?.toString() === ownerIdStr &&
      ownershipRecordOverlapsEffectiveDate(record, effectiveDate)
    ));
    if (hasConflictingRecord) continue;

    ownershipRecords.push({
      ownerId: ownerIdStr,
      startDate: effectiveDate,
      endDate: null,
      financialHandling,
      createdAt: ClockService.now(),
    });

    const nextActiveOwnerIds = getActiveOwnerIdsFromRecords(
      ownershipRecords,
      ownershipActivityAtForCurrentAssociation(effectiveDate, ClockService.now())
    );
    const updateOpts = session ? { session } : {};

    await Property.findByIdAndUpdate(
      unitIdStr,
      {
        $set: {
          associatedOwnerIds: nextActiveOwnerIds,
          ownershipRecords,
        },
        $push: {
          ownershipLogs: createOwnershipLogEntry({
            action: 'ADD',
            ownerIds: [ownerIdStr],
            effectiveDate,
            performedBy,
            details: {
              financialHandling,
              source: options.source || 'owner-flow',
            },
          }),
        },
      },
      updateOpts,
    );

    if (ownerInvoiceEligible) {
      await syncInvoiceTenantsForAddOwner({
        unitId: unitIdStr,
        ownerId: ownerIdStr,
        effectiveDate,
        financialHandling,
        session,
      });
    }

    try {
      await recordOwnershipChangeActivities({
        unit,
        unitId: unitIdStr,
        action: 'ADD',
        previousOwnerIds,
        newOwnerIds: [ownerIdStr],
        performedBy,
        performedAt: ClockService.now(),
        session,
        source: options.source || 'owner-flow',
      });
    } catch (activityErr) {
      logger.warn('[linkOwnerToUnitsFromOwnerFlow] Failed to record ownership activity:', activityErr.message);
    }

    linkedUnits.push(unit);
  }

  if (linkedUnits.length > 0 && !options.skipAssignmentEmail) {
    setImmediate(async () => {
      try {
        const [recipient, assignedByName] = await Promise.all([
          User.findById(ownerIdStr).select('firstName lastName email hoaInfo').lean(),
          resolveAssignerName(performedBy),
        ]);
        if (!recipient?.email) return;

        for (const unit of linkedUnits) {
          const unitLean = unit.toObject ? unit.toObject() : unit;
          await sendUnitAssignmentEmail({
            recipient,
            property: unitLean,
            assignedByName,
            hoaId: unitLean.hoaId || options.hoaId || null,
            skipRecipientValidation: options.skipAssignmentEmailValidation === true,
          });
        }
      } catch (emailErr) {
        logger.warn('[linkOwnerToUnitsFromOwnerFlow] unit assignment email failed:', emailErr.message);
      }
    });
  }
}

/**
 * Statuses reassigned to remaining owners when removing a co-owner.
 * Processing is intentionally excluded so in-flight payments keep historical payers.
 * Paid / waived invoices keep their historical snapshot.
 */
const CO_OWNER_REMOVE_INVOICE_REASSIGN_STATUSES = [
  INVOICE_STATUS.PENDING,
  INVOICE_STATUS.PARTIALLY_PAID,
  INVOICE_STATUS.OVERDUE,
];

/**
 * Co-owner remove invoice payer sync:
 * - Paid + Processing: keep historical `tenants` (owner names at invoice time).
 *   Processing is excluded so an in-flight owner payment does not rewrite the payer to remaining owners.
 * - Open unpaid (Pending / Partially Paid / Overdue): reassign payers to remaining owners
 *   for same-day removals so removed co-owners no longer appear on outstanding invoices.
 * - Future-dated removals: only invoices due on/after the effective date.
 *
 * Last-owner path: after settlement + future soft-delete, only pull the removed
 * owner from remaining future unpaid rows (avoids empty-tenant save failures).
 */
const syncInvoiceTenantsForRemoveOwner = async ({
  unitId,
  ownerId,
  effectiveDate,
  session,
  remainingOwnerIds = [],
}) => {
  const remaining = normalizeObjectIdStrings(remainingOwnerIds);
  const futureDated = Boolean(effectiveDate && isFutureCalendarEffectiveDate(effectiveDate));

  // Co-owner remove: remaining owners become current payers on open unpaid invoices.
  if (remaining.length > 0) {
    const tenantObjs = remaining.map((id) => new mongoose.Types.ObjectId(id));
    const query = {
      propertyId: unitId,
      isDeleted: { $ne: true },
      status: { $in: CO_OWNER_REMOVE_INVOICE_REASSIGN_STATUSES },
      tenants: ownerId,
    };
    if (futureDated) {
      query.dueDate = { $gte: effectiveDate };
    }
    await Invoice.updateMany(
      query,
      { $set: { tenants: tenantObjs } },
      { session }
    );
    return;
  }

  // Last-owner path: only pull from future/open unpaid rows after settlement has run.
  const lastOwnerQuery = {
    propertyId: unitId,
    isDeleted: { $ne: true },
    dueDate: { $gte: effectiveDate },
    status: { $in: [INVOICE_STATUS.PENDING, INVOICE_STATUS.OVERDUE, INVOICE_STATUS.PARTIALLY_PAID] },
    tenants: ownerId,
  };
  await Invoice.updateMany(
    lastOwnerQuery,
    { $pull: { tenants: ownerId } },
    { session }
  );
};

/**
 * Point open invoices at the new owners so carried balances and prior payments stay
 * on the document while the payable remainder is owed by the assignee.
 *
 * Today transfers: include overdue/open rows even when dueDate is before today
 * (MIGRATE / balance carry-forward).
 * Future transfers: only invoices due on/after the effective date - never rewrite history.
 */
const syncInvoiceTenantsForChangeOwnership = async ({
  unitId,
  ownerIds,
  session,
  effectiveDate,
}) => {
  const normalizedOwnerIds = normalizeObjectIdStrings(ownerIds || []);
  if (normalizedOwnerIds.length === 0) return;

  const tenantObjs = normalizedOwnerIds.map((id) => new mongoose.Types.ObjectId(id));
  const query = {
    propertyId: unitId,
    isDeleted: { $ne: true },
    status: { $in: [INVOICE_STATUS.PENDING, INVOICE_STATUS.PARTIALLY_PAID, INVOICE_STATUS.OVERDUE] },
  };

  if (effectiveDate && isFutureCalendarEffectiveDate(effectiveDate)) {
    query.dueDate = { $gte: effectiveDate };
  }

  await Invoice.updateMany(
    query,
    { $set: { tenants: tenantObjs } },
    { session }
  );
};

const removalPaymentFromChangePayload = (payload) => {
  if (!payload?.paymentMethod || !String(payload.paymentMethod).trim()) return null;
  return {
    paymentMethod: String(payload.paymentMethod).trim(),
    checkNumber: payload.checkNumber,
    moneyOrderNumber: payload.moneyOrderNumber,
  };
};

const isRetryableWriteConflict = (error) => {
  if (!error) return false;
  const message = String(error.message || '').toLowerCase();
  return (
    error.code === 112 ||
    message.includes('write conflict') ||
    message.includes('transienttransactionerror')
  );
};

const mapPropertyValidationError = (error) => {
  if (!error) return error;
  if (error.name === 'ValidationError') {
    error.status = 400;
  }
  return error;
};

const runWithTransactionRetry = async (operation, maxRetries = 3) => {
  let attempt = 0;
  let lastError;

  while (attempt < maxRetries) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (!isRetryableWriteConflict(error) || attempt >= maxRetries) {
        throw error;
      }
    }
  }

  throw lastError;
};

const mapUnitResponse = (unit, fallback = {}) => ({
  _id: unit._id,
  title: unit.unitDetails && unit.unitDetails[0] ? unit.unitDetails[0].unitName : unit.name,
  propertyName: unit.name,
  description: unit.description || '',
  address: {
    line1: unit.address?.street || '',
    line2: unit.address?.line2 || '',
    city: unit.address?.city || '',
    state: unit.address?.state || '',
    zipCode: unit.address?.zip || ''
  },
  startingBalance: fallback.startingBalance !== undefined ? fallback.startingBalance : (unit.startingBalance || 0),
  balanceAsOf: fallback.balanceAsOf !== undefined ? fallback.balanceAsOf : (unit.balanceAsOf || unit.createdAt),
  monthlyRecurringFee: fallback.monthlyRecurringFee !== undefined ? fallback.monthlyRecurringFee : (unit.monthlyRecurringFee || 0),
  paymentTerm: fallback.paymentTerm !== undefined ? fallback.paymentTerm : (unit.paymentTerm || 0),
  depositBankAccountId: fallback.depositBankAccountId || (unit.depositBankAccountId ? unit.depositBankAccountId.toString() : ''),
  depositBankAccountName:
    fallback.depositBankAccountName !== undefined
      ? normalizeDepositBankLabel(fallback.depositBankAccountName)
      : normalizeDepositBankLabel(unit.depositBankAccountName),
  tags: unit.tags || [],
  billingTimezone: unit.billingTimezone || null,
  billingTimezoneSource: unit.billingTimezoneSource || null,
  ownerIds: normalizeObjectIdStrings(unit.associatedOwnerIds || []),
  associatedOwnerIds: normalizeObjectIdStrings(unit.associatedOwnerIds || []),
  ownershipRecords: (unit.ownershipRecords || []).map((record) => ({
    ownerId: record.ownerId?.toString ? record.ownerId.toString() : record.ownerId,
    startDate: record.startDate,
    endDate: record.endDate,
    financialHandling: record.financialHandling || 'FRESH',
    createdAt: record.createdAt,
  })),
  ownershipLogs: (unit.ownershipLogs || []).map((log) => ({
    _id: log._id?.toString ? log._id.toString() : log._id,
    action: log.action,
    ownerIds: normalizeObjectIdStrings(log.ownerIds || []),
    effectiveDate: log.effectiveDate,
    timestamp: log.timestamp,
    performedBy: log.performedBy?.toString ? log.performedBy.toString() : log.performedBy,
    details: log.details || {},
  })),
  createdAt: unit.createdAt,
  updatedAt: unit.updatedAt,
  billingProcessingStatus: getBillingProcessingStatus(unit),
  billingProcessingError: getBillingProcessingError(unit),
});

const rewriteOwnershipTimeline = ({
  records,
  nextOwnerIds,
  effectiveDate,
  action,
  performedBy,
  details = {},
  financialHandling = 'FRESH',
}) => {
  const timeline = cloneOwnershipRecords(records);
  const nextIds = normalizeObjectIdStrings(nextOwnerIds);

  timeline.forEach((record) => {
    if (!record.endDate || record.endDate > effectiveDate) {
      record.endDate = effectiveDate;
    }
  });

  nextIds.forEach((ownerId) => {
    timeline.push({
      ownerId,
      startDate: effectiveDate,
      endDate: null,
      financialHandling,
      createdAt: ClockService.now(),
    });
  });

  return {
    ownershipRecords: timeline,
    ownershipLog: createOwnershipLogEntry({
      action,
      ownerIds: nextIds,
      effectiveDate,
      performedBy,
      details,
    }),
  };
};

async function createUnit(unitData, options = {}) {
  let ownSession = false;
  let session = options && options.session;
  if (!session) {
    session = await mongoose.startSession();
    session.startTransaction();
    ownSession = true;
    options = Object.assign({}, options, { session });
  }

  try {
    applyStartingBalanceLimits(unitData);
    if (!unitData.hoaId && options.hoaContext?.hoaId) {
      unitData.hoaId = options.hoaContext.hoaId;
    }

    // Normalize associatedOwnerIds to always be an array
    if (typeof unitData.associatedOwnerIds === 'string') {
      unitData.associatedOwnerIds = [unitData.associatedOwnerIds];
    } else if (!Array.isArray(unitData.associatedOwnerIds)) {
      unitData.associatedOwnerIds = [];
    }

    logger.info('[createUnit Service] Received associatedOwnerIds:', unitData.associatedOwnerIds);

    await assertOwnerIdsEligibleForPropertyAssignment(unitData.associatedOwnerIds, session);

    unitData = await hydrateUnitBillingFromHoaSettings(
      unitData,
      unitData.hoaId || options.hoaContext?.hoaId
    );

    if (!unitData.address || !unitData.address.line1 || !unitData.address.city || !unitData.address.state || !unitData.address.zipCode) {
      const err = new Error('Address fields (line1, city, state, zipCode) are required');
      err.status = 400;
      throw err;
    }


    if (!unitData.depositBankAccountId || !mongoose.Types.ObjectId.isValid(unitData.depositBankAccountId)) {
      const err = new Error('Valid depositBankAccountId is required');
      err.status = 400;
      throw err;
    }

    // Validate billing setup when a starting balance is provided, including zero and negative values
    if (unitData.startingBalance !== undefined && !unitData.balanceAsOf) {
      const err = new Error('balanceAsOf date is required when startingBalance is provided');
      err.status = 400;
      throw err;
    }

    // Check for duplicate unit name within the same property
    const createTitle = assertValidUnitTitle(
      unitData.title,
      unitData.address && unitData.address.city,
      { required: true }
    );
    const duplicateUnit = await findDuplicateUnitDocument(
      normalizePropertyDisplayName(unitData.propertyName),
      createTitle,
      { session, hoaId: unitData.hoaId }
    );
    if (duplicateUnit) {
      const err = new Error(`Unit "${createTitle}" already exists under property "${normalizePropertyDisplayName(unitData.propertyName)}".`);
      err.status = 409;
      throw err;
    }

    const { ownerInfo } = await resolveOwnerInfoForUnit(unitData, session);

    // Create property record for the unit
    const propertyData = {
      landlord_id:
        unitData.landlordId || unitData.boardMemberId || unitData.createdBy || unitData.hoaBoardMemberId,
      name: normalizePropertyDisplayName(unitData.propertyName || unitData.title || 'Untitled Unit'),
      description: unitData.description || '',
      propertyType: 'Residential',
      ownershipType: 'Individual',
      ownerName: ownerInfo.name,
      ownerEmail: ownerInfo.email,
      ownerPhone: ownerInfo.phone,
      ownerType: 'Individual',
      address: {
        street: unitData.address.line1,
        city: unitData.address.city,
        state: unitData.address.state,
        zip: unitData.address.zipCode,
      },
      unitDetails: [{
        unitName: createTitle,
        unitType: 'Residential',
        squareFeet: 1000,
        bedRooms: 1,
        bathRoom: 1,
      }],
      // emergencyContact: unitData.emergencyContact || {},
      tags: unitData.tags || [],
      depositBankAccountId: unitData.depositBankAccountId,
      depositBankAccountName: normalizeDepositBankLabel(unitData.depositBankAccountName),
      startingBalance: unitData.startingBalance || 0,
      balanceAsOf: unitData.balanceAsOf,
      monthlyRecurringFee: unitData.monthlyRecurringFee || 0,
      paymentTerm: unitData.paymentTerm || 12,
      associatedOwnerIds: unitData.associatedOwnerIds || [],
      ownershipRecords: buildInitialOwnershipRecords(
        unitData.associatedOwnerIds || [],
        unitData.balanceAsOf || ClockService.now()
      ),
      ownershipLogs: [],
      propertySettings: {
        bankAccount: {
          firstName: ownerInfo.name.split(' ')[0] || 'Owner',
          lastName: ownerInfo.name.split(' ')[1] || 'Name',
          email: ownerInfo.email,
          phone: ownerInfo.phone,
          dob: DateUtil.parseDateOnlyToNoonUtc('1990-01-01'),
          ssn: '000-00-0000',
          address: {
            street: unitData.address.line1,
            city: unitData.address.city,
            state: unitData.address.state,
            zip: unitData.address.zipCode,
          }
        },
        lateFees: []
      }
    };
    if (unitData.hoaId) {
      propertyData.hoaId = unitData.hoaId;
    }
    propertyData.sourcePortal = 'hoa';

    applyUnitBillingTimezoneFields(propertyData, unitData);

    logger.info('[createUnit Service] Creating property with associatedOwnerIds:', propertyData.associatedOwnerIds);



    let created;
    if (options.session) {
      const docs = await Property.create([propertyData], { session: options.session });
      created = docs[0];
    } else {
      created = await Property.create(propertyData);
    }

    logger.info('[createUnit Service] Property created with ID:', created._id);
    logger.info('[createUnit Service] Created property associatedOwnerIds:', created.associatedOwnerIds);

    // Sync bidirectional relationship: add property to owners' propertyIds
    // Use unitData.associatedOwnerIds instead of created.associatedOwnerIds to ensure we have the original data
    if (unitData.associatedOwnerIds && unitData.associatedOwnerIds.length > 0) {
      const updateResult = await User.updateMany(
        { _id: { $in: unitData.associatedOwnerIds } },
        { $addToSet: { propertyIds: created._id } },
        { session: options.session }
      );
      logger.info('[createUnit] Synced property to owners:', { propertyId: created._id, ownerIds: unitData.associatedOwnerIds, updateResult });
    } else {
      logger.info('[createUnit] No associatedOwnerIds to sync');
    }

    // Create opening_balance ledger entry when billing is configured (including HOA-settings defaults).
    if (hasBillingConfiguration(unitData)) {
      await ledgerService.createOpeningBalance(
        created._id,
        unitData.startingBalance,
        unitData.balanceAsOf,
        options.session
      );
    }

    const backgroundMeta = buildCreateUnitBackgroundMeta(unitData);
    if (backgroundMeta.backgroundProcessing.invoices) {
      await Property.findByIdAndUpdate(
        created._id,
        { $set: { 'requestPayload.billingProcessingStatus': 'pending' } },
        { session: options.session }
      );
    }

    if (ownSession) {
      await session.commitTransaction();
      session.endSession();
    }

    if (ownSession) {
      schedulePostCreateBackgroundTasks(created, unitData);
    }

    // Log activity after transaction commits
    try {
      await logActivity({
        userId: unitData.landlordId || unitData.boardMemberId,
        action: 'CREATE',
        module: 'Unit',
        entityId: created._id,
        hoaId: created.hoaId || unitData.hoaId || undefined,
        entityName: created.name,
        description: `Created unit "${created.name}"`,
        meta: { address: created.address, hoaId: created.hoaId || unitData.hoaId }
      });
      logger.info('Activity logged for unit:', created.name);
    } catch (activityError) {
      logger.error('Failed to log activity:', activityError);
    }

    if (ownSession && unitData.associatedOwnerIds && unitData.associatedOwnerIds.length > 0) {
      setImmediate(async () => {
        try {
          await notifyOwnersForUnitAssignment(
            unitData.associatedOwnerIds,
            created.toObject ? created.toObject() : created,
            unitData.landlordId || unitData.boardMemberId,
          );
        } catch (e) {
          logger.warn('Failed to send unit-assignment emails on unit create:', e.message);
        }
      });
    }

    if (ownSession) {
      queueUnitPropertyCreatedNotification(
        created,
        unitData.landlordId || unitData.hoaBoardMemberId || unitData.createdBy || null
      );
    }

    return {
      ...mapUnitResponse(created, {
        startingBalance: unitData.startingBalance || 0,
        balanceAsOf: unitData.balanceAsOf,
      }),
      images: [],
      ...backgroundMeta,
    };
  } catch (e) {
    mapPropertyValidationError(e);
    if (ownSession && session) {
      try { await session.abortTransaction(); } catch (ignore) { }
      try { session.endSession(); } catch (ignore) { }
    }
    throw e;
  }
}

async function createUnitWithImages(unitData, files = [], options = {}) {
  let ownSession = false;
  let session = options && options.session;
  if (!session) {
    session = await mongoose.startSession();
    session.startTransaction();
    ownSession = true;
    options = Object.assign({}, options, { session });
  }

  try {
    if (!unitData.hoaId && options.hoaContext?.hoaId) {
      unitData.hoaId = options.hoaContext.hoaId;
    }

    // Normalize associatedOwnerIds to always be an array
    if (typeof unitData.associatedOwnerIds === 'string') {
      unitData.associatedOwnerIds = [unitData.associatedOwnerIds];
    } else if (!Array.isArray(unitData.associatedOwnerIds)) {
      unitData.associatedOwnerIds = [];
    }

    logger.info('[createUnitWithImages Service] Received associatedOwnerIds:', unitData.associatedOwnerIds);

    unitData = await hydrateUnitBillingFromHoaSettings(
      unitData,
      unitData.hoaId || options.hoaContext?.hoaId
    );

    // Validate required fields
    if (!unitData.address || !unitData.address.line1 || !unitData.address.city || !unitData.address.state || !unitData.address.zipCode) {
      const err = new Error('Address fields (line1, city, state, zipCode) are required');
      err.status = 400;
      throw err;
    }


    if (!unitData.depositBankAccountId || !mongoose.Types.ObjectId.isValid(unitData.depositBankAccountId)) {
      const err = new Error('Valid depositBankAccountId is required');
      err.status = 400;
      throw err;
    }
    // Validate billing setup when a starting balance is provided, including zero and negative values
    if (unitData.startingBalance !== undefined && !unitData.balanceAsOf) {
      const err = new Error('balanceAsOf date is required when startingBalance is provided');
      err.status = 400;
      throw err;
    }

    // Check for duplicate unit name within the same property
    const createTitle = assertValidUnitTitle(
      unitData.title,
      unitData.address && unitData.address.city,
      { required: true }
    );
    const duplicateUnit = await findDuplicateUnitDocument(
      normalizePropertyDisplayName(unitData.propertyName),
      createTitle,
      { session, hoaId: unitData.hoaId }
    );
    if (duplicateUnit) {
      const err = new Error(`Unit "${createTitle}" already exists under property "${normalizePropertyDisplayName(unitData.propertyName)}".`);
      err.status = 409;
      throw err;
    }

    const { ownerInfo } = await resolveOwnerInfoForUnit(unitData, session);

    // Create property record for the unit
    const propertyData = {
      landlord_id:
        unitData.landlordId || unitData.boardMemberId || unitData.createdBy || unitData.hoaBoardMemberId,
      name: normalizePropertyDisplayName(unitData.propertyName || unitData.title || 'Untitled Unit'),
      description: unitData.description || '',
      propertyType: 'Residential',
      ownershipType: 'Individual',
      ownerName: ownerInfo.name,
      ownerEmail: ownerInfo.email,
      ownerPhone: ownerInfo.phone,
      ownerType: 'Individual',
      address: {
        street: unitData.address.line1,
        city: unitData.address.city,
        state: unitData.address.state,
        zip: unitData.address.zipCode,
      },
      unitDetails: [{
        unitName: createTitle,
        unitType: 'Residential',
        squareFeet: 1000,
        bedRooms: 1,
        bathRoom: 1,
      }],
      // emergencyContact: unitData.emergencyContact || {},
      tags: unitData.tags || [],
      depositBankAccountId: unitData.depositBankAccountId,
      depositBankAccountName: normalizeDepositBankLabel(unitData.depositBankAccountName),
      startingBalance: unitData.startingBalance || 0,
      balanceAsOf: unitData.balanceAsOf,
      monthlyRecurringFee: unitData.monthlyRecurringFee || 0,
      paymentTerm: unitData.paymentTerm || 12,
      associatedOwnerIds: unitData.associatedOwnerIds || [],
      ownershipRecords: buildInitialOwnershipRecords(
        unitData.associatedOwnerIds || [],
        unitData.balanceAsOf || ClockService.now()
      ),
      ownershipLogs: [],
      propertySettings: {
        bankAccount: {
          firstName: ownerInfo.name.split(' ')[0] || 'Owner',
          lastName: ownerInfo.name.split(' ')[1] || 'Name',
          email: ownerInfo.email,
          phone: ownerInfo.phone,
          dob: DateUtil.parseDateOnlyToNoonUtc('1990-01-01'),
          ssn: '000-00-0000',
          address: {
            street: unitData.address.line1,
            city: unitData.address.city,
            state: unitData.address.state,
            zip: unitData.address.zipCode,
          }
        },
        lateFees: []
      }
    };
    if (unitData.hoaId) {
      propertyData.hoaId = unitData.hoaId;
    }
    propertyData.sourcePortal = 'hoa';

    logger.info('[createUnitWithImages Service] Creating property with associatedOwnerIds:', propertyData.associatedOwnerIds);

    let created;
    if (options.session) {
      const docs = await Property.create([propertyData], { session: options.session });
      created = docs[0];
    } else {
      created = await Property.create(propertyData);
    }

    // Handle image uploads if provided
    let uploadedImages = [];
    if (files && files.length > 0) {
      for (const file of files) {

        // Ensure file.path exists, fallback to constructing it
        const filePath = file.path || path.join(file.destination || '', file.filename || file.originalname);

        if (!fs.existsSync(filePath)) {
          logger.error(`File does not exist at path: ${filePath}`);
          throw new Error(`Uploaded file not found at: ${filePath}`);
        }

        const filename = file.filename || file.originalname;
        const key = `property-images/${created._id}/${filename}`;

        const result = await s3Client.upload({ localFilePath: filePath, key });

        const bucketName = config.s3?.bucketName || process.env.S3_BUCKET || 'mock-bucket';
        const region = config.s3?.region || process.env.AWS_REGION || 'mock-region';

        const metadataDoc = await DocumentMetadata.create([{
          key: result.Key || key,
          bucketName,
          region,
          size: file.size || 0,
          contentType: file.mimetype || 'image/jpeg',
          originalName: filename
        }], { session });

        uploadedImages.push({ metadataId: metadataDoc[0]._id });
      }

      // Update property with images
      await Property.findByIdAndUpdate(
        created._id,
        { $set: { images: uploadedImages } },
        { session }
      );
    }

    // Sync bidirectional relationship: add property to owners' propertyIds
    if (unitData.associatedOwnerIds && unitData.associatedOwnerIds.length > 0) {
      const updateResult = await User.updateMany(
        { _id: { $in: unitData.associatedOwnerIds } },
        { $addToSet: { propertyIds: created._id } },
        { session }
      );
      logger.info('[createUnitWithImages] Synced propertyId', created._id, 'to owners:', unitData.associatedOwnerIds, 'updateResult:', updateResult);
    }

    // Create opening_balance ledger entry when billing is configured (including HOA-settings defaults).
    if (hasBillingConfiguration(unitData)) {
      await ledgerService.createOpeningBalance(
        created._id,
        unitData.startingBalance,
        unitData.balanceAsOf,
        session
      );
    }

    const backgroundMeta = buildCreateUnitBackgroundMeta(unitData);
    if (backgroundMeta.backgroundProcessing.invoices) {
      await Property.findByIdAndUpdate(
        created._id,
        { $set: { 'requestPayload.billingProcessingStatus': 'pending' } },
        { session }
      );
    }

    if (ownSession) {
      await session.commitTransaction();
      session.endSession();
    }

    if (ownSession) {
      schedulePostCreateBackgroundTasks(created, unitData);
    }

    if (ownSession && unitData.associatedOwnerIds && unitData.associatedOwnerIds.length > 0) {
      setImmediate(async () => {
        try {
          await notifyOwnersForUnitAssignment(
            unitData.associatedOwnerIds,
            created.toObject ? created.toObject() : created,
            unitData.landlordId || unitData.boardMemberId,
          );
        } catch (e) {
          logger.warn('Failed to send unit-assignment emails on unit create with images:', e.message);
        }
      });
    }

    if (ownSession) {
      queueUnitPropertyCreatedNotification(
        created,
        unitData.landlordId || unitData.hoaBoardMemberId || unitData.createdBy || null
      );
    }

    return {
      ...mapUnitResponse(created, {
        startingBalance: unitData.startingBalance || 0,
        balanceAsOf: unitData.balanceAsOf,
      }),
      images: uploadedImages,
      imagesUploaded: uploadedImages.length,
      ...backgroundMeta,
    };
  } catch (e) {
    mapPropertyValidationError(e);
    if (ownSession && session) {
      try { await session.abortTransaction(); } catch (ignore) { }
      try { session.endSession(); } catch (ignore) { }
    }
    throw e;
  }
}

async function updateUnit(unitId, unitData, options = {}) {
  let ownSession = false;
  let session = options && options.session;
  if (!session) {
    session = await mongoose.startSession();
    session.startTransaction();
    ownSession = true;
    options = Object.assign({}, options, { session });
  }

  try {
    applyStartingBalanceLimits(unitData);
    // Validate unit exists
    const existingUnit = await Property.findById(unitId).session(session);
    if (!existingUnit) {
      const err = new Error('Unit not found');
      err.status = 404;
      throw err;
    }

    // Validate required fields if provided
    if (unitData.address) {
      if (!unitData.address.line1 || !unitData.address.city || !unitData.address.state || !unitData.address.zipCode) {
        const err = new Error('Address fields (line1, city, state, zipCode) are required');
        err.status = 400;
        throw err;
      }
    }


    if (unitData.depositBankAccountId && !mongoose.Types.ObjectId.isValid(unitData.depositBankAccountId)) {
      const err = new Error('Valid depositBankAccountId is required');
      err.status = 400;
      throw err;
    }

    const nextPropertyName = normalizePropertyDisplayName(
      unitData.propertyName !== undefined && unitData.propertyName !== null
        ? unitData.propertyName
        : existingUnit.name || ''
    );
    if (Object.prototype.hasOwnProperty.call(unitData, 'title')) {
      assertValidUnitTitle(
        unitData.title,
        (unitData.address && unitData.address.city) || existingUnit.address?.city,
        { required: true }
      );
    }
    const nextTitle =
      unitData.title !== undefined && unitData.title !== null
        ? normalizeUnitTitle(unitData.title)
        : currentUnitTitleFromProperty(existingUnit);

    const duplicateOther = await findDuplicateUnitDocument(nextPropertyName, nextTitle, {
      excludeId: existingUnit._id,
      session,
      hoaId: existingUnit.hoaId || unitData.hoaId,
    });
    if (duplicateOther) {
      const err = new Error(`Unit "${nextTitle}" already exists under property "${nextPropertyName}".`);
      err.status = 409;
      throw err;
    }

    // Build update object
    const updateData = {};
    if (unitData.propertyName) updateData.name = normalizePropertyDisplayName(unitData.propertyName);
    if (unitData.title) {
      updateData['unitDetails.0.unitName'] = normalizeUnitTitle(unitData.title);
    }
    if (unitData.description !== undefined) updateData.description = unitData.description;
    // if (unitData.emergencyContact) updateData.emergencyContact = unitData.emergencyContact;
    if (unitData.address) {
      updateData.address = {
        street: unitData.address.line1,
        city: unitData.address.city,
        state: unitData.address.state,
        zip: unitData.address.zipCode,
      };
    }
    if (unitData.tags !== undefined) updateData.tags = unitData.tags;
    let addedOwners = [];
    const ownersPayload = resolveOwnersPayloadForUnitUpdate(unitData);
    if (ownersPayload !== undefined) {
      await assertOwnerIdsEligibleForPropertyAssignment(ownersPayload, session);
      const effectiveDate = toDateAtStartOfDay(ClockService.now());
      const timeline = ensureOwnershipTimeline(existingUnit, existingUnit.createdAt);
      const previousOwnerIds = getActiveOwnerIdsFromRecords(timeline, ClockService.now());
      const ownershipUpdate = rewriteOwnershipTimeline({
        records: timeline,
        nextOwnerIds: ownersPayload,
        effectiveDate,
        action: 'CHANGE',
        performedBy: unitData.landlordId || unitData.boardMemberId || existingUnit.landlord_id,
        details: { source: 'legacy_update' },
        financialHandling: 'FRESH',
      });
      updateData.ownershipRecords = ownershipUpdate.ownershipRecords;
      updateData.ownershipLogs = [...(existingUnit.ownershipLogs || []), ownershipUpdate.ownershipLog];
      updateData.associatedOwnerIds = getActiveOwnerIdsFromRecords(
        ownershipUpdate.ownershipRecords,
        ownershipActivityAtForCurrentAssociation(effectiveDate, ClockService.now())
      );

      const membershipUpdate = await syncOwnerPropertyMembership(
        unitId,
        previousOwnerIds,
        updateData.associatedOwnerIds,
        session
      );
      addedOwners = membershipUpdate.addedOwners;
    }
    // Lock starting balance updates once invoices exist, except for ownerless units (fresh onboarding for next owner).
    if (unitData.startingBalance !== undefined) {
      const safeUnitIdForCount = toObjectId(unitId);
      const invoiceCount = await Invoice.countDocuments({ propertyId: safeUnitIdForCount, isDeleted: { $ne: true } });
      const hasAssociatedOwners =
        Array.isArray(existingUnit.associatedOwnerIds) && existingUnit.associatedOwnerIds.length > 0;
      if (invoiceCount > 0 && hasAssociatedOwners) {
        const err = new Error('Starting balance is locked. Use an adjustment instead.');
        err.status = 400;
        throw err;
      }
      updateData.startingBalance = unitData.startingBalance;
    }
    if (unitData.balanceAsOf) updateData.balanceAsOf = unitData.balanceAsOf;
    if (unitData.monthlyRecurringFee !== undefined) updateData.monthlyRecurringFee = unitData.monthlyRecurringFee;
    if (unitData.paymentTerm) updateData.paymentTerm = unitData.paymentTerm;
    if (unitData.depositBankAccountId) {
      updateData.depositBankAccountId = unitData.depositBankAccountId;
    }
    if (unitData.depositBankAccountName !== undefined) {
      updateData.depositBankAccountName = normalizeDepositBankLabel(unitData.depositBankAccountName);
    }

    applyUnitBillingTimezoneFields(updateData, unitData, existingUnit);

    // Update the unit
    const updated = await Property.findByIdAndUpdate(
      unitId,
      { $set: updateData },
      { new: true, session }
    );

    await syncAssociatedInvoiceLabels(unitId, {
      unitLabel: nextTitle,
      propertyName: nextPropertyName,
      previousUnitLabel: currentUnitTitleFromProperty(existingUnit),
      previousPropertyName: normalizePropertyDisplayName(existingUnit.name || ''),
      session,
    });

    const invoiceData = {
      ...unitData,
      ...resolveBillingConfiguration(unitData, existingUnit, updated.associatedOwnerIds)
    };
    const hasBillingConfig = hasBillingConfiguration(invoiceData);
    const billingChanged = billingConfigurationChanged(existingUnit, invoiceData);
    const existingInvoiceCount = await countExistingInvoices(unitId, session);
    let invoicesQueued = false;
    let invoiceQueueMode = 'initial';

    if (hasBillingConfig && billingChanged) {
      const billingResult = await applyBillingConfigurationChange({
        unitId,
        existingUnit,
        invoiceData,
        updated,
        session,
        existingInvoiceCount,
        deletedByUserId: unitData.landlordId || unitData.boardMemberId || updated.landlord_id,
        deferGeneration: true,
      });
      if (billingResult?.invoicesQueued) {
        invoicesQueued = true;
        invoiceQueueMode = billingResult.mode || 'regenerate';
        await markBillingPendingInSession(unitId, session);
      }
    } else if (existingInvoiceCount === 0) {
      await ensureOpeningBalanceLedgerIfMissing(unitId, invoiceData, existingUnit, existingInvoiceCount, session);
      if (
        hasBillingConfiguration(invoiceData) &&
        Array.isArray(updated.associatedOwnerIds) &&
        updated.associatedOwnerIds.length > 0
      ) {
        invoicesQueued = true;
        invoiceQueueMode = 'initial';
        await markBillingPendingInSession(unitId, session);
      }
    }

    const depositBankChanged =
      unitData.depositBankAccountId &&
      String(existingUnit.depositBankAccountId || '') !== String(unitData.depositBankAccountId);
    if (depositBankChanged) {
      await invoiceService.logDepositBankChangeForUnitInvoices(
        unitId,
        {
          previousBankAccountId: existingUnit.depositBankAccountId,
          previousBankAccountName: existingUnit.depositBankAccountName,
          newBankAccountId: unitData.depositBankAccountId,
          newBankAccountName: normalizeDepositBankLabel(unitData.depositBankAccountName),
        },
        unitData.boardMemberId || unitData.landlordId || updated.landlord_id,
        session
      );
    }

    if (ownSession) {
      await session.commitTransaction();
      session.endSession();
    }

    const addressWasUpdated = Boolean(unitData.address);
    const ownerMailingSync =
      addressWasUpdated &&
      updated.associatedOwnerIds &&
      updated.associatedOwnerIds.length > 0;

    if (ownSession) {
      schedulePostUpdateBackgroundTasks({
        updated,
        unitData,
        invoiceData,
        invoicesQueued,
        invoiceQueueMode,
        ownerMailingSync,
      });
    }

    // Log activity after transaction commits
    await logActivity({
      userId: updated.landlord_id,
      action: 'UPDATE',
      module: 'Unit',
      entityId: updated._id,
      entityName: updated.name,
      description: `Updated unit "${updated.name}"`,
      meta: { address: updated.address }
    });

    if (ownSession && addedOwners.length > 0 && !invoicesQueued) {
      setImmediate(async () => {
        try {
          await notifyOwnersForUnitAssignment(
            addedOwners,
            updated.toObject ? updated.toObject() : updated,
            updated.landlord_id,
          );
        } catch (e) {
          logger.warn('Failed to send unit-assignment emails on unit update:', e.message);
        }
      });
      scheduleOwnerInvoiceGenerationForUnit(unitId, addedOwners, {
        userId: unitData.landlordId || unitData.boardMemberId || updated.landlord_id,
        hoaBoardMemberId: unitData.hoaBoardMemberId || unitData.boardMemberId || updated.landlord_id,
        createdBy: unitData.landlordId || unitData.boardMemberId || updated.landlord_id,
        hoaId: unitData.hoaId || updated.hoaId,
      });
    }

    const backgroundMeta = buildUnitBackgroundMeta(unitData, {
      invoicesQueued,
      ownerMailingSync,
    });

    if (ownSession) {
      queueUnitPropertyUpdatedNotification(
        updated,
        options.userId || unitData.landlordId || unitData.hoaBoardMemberId || unitData.boardMemberId || updated.landlord_id || null
      );
    }

    return {
      ...mapUnitResponse(updated, {
        startingBalance: unitData.startingBalance !== undefined ? unitData.startingBalance : (updated.startingBalance || 0),
        balanceAsOf: unitData.balanceAsOf || updated.balanceAsOf || updated.createdAt,
      }),
      ...backgroundMeta,
    };
  } catch (e) {
    if (ownSession && session) {
      try { await session.abortTransaction(); } catch (ignore) { }
      try { session.endSession(); } catch (ignore) { }
    }
    throw e;
  }
}

async function getUnitById(unitId, options = {}) {
  try {
    const unit = await Property.findById(unitId).populate('images.metadataId');
    if (!unit) {
      const err = new Error('Unit not found');
      err.status = 404;
      throw err;
    }

    if (options.hoaContext?.hoaId && unit.hoaId && String(unit.hoaId) !== String(options.hoaContext.hoaId)) {
      const err = new Error('Unit not found');
      err.status = 404;
      throw err;
    }

    const ownershipTimeline = ensureOwnershipTimeline(unit, unit.createdAt);
    const finalOwnerIds = toObjectIds(getCurrentOwnerIdsFromUnit(unit, ClockService.now()));

    // Transform images to URLs
    const imageUrls = Array.isArray(unit.images) ? unit.images.map(img => {
      if (img && img.metadataId && img.metadataId.key) {
        const baseUrl = config.s3?.baseUrl || process.env.S3_BASE_URL || '';
        return `${baseUrl}/${img.metadataId.key}`;
      }
      return null;
    }).filter(Boolean) : [];

    const hasBillingSetup = Boolean(
      unit.balanceAsOf ||
      (unit.startingBalance || 0) !== 0 ||
      (unit.monthlyRecurringFee || 0) > 0
    );

    let invoiceScheduleMeta = null;
    try {
      const { getInvoiceScheduleMetaForUnit } = require('./invoiceScheduleMeta.service');
      invoiceScheduleMeta = await getInvoiceScheduleMetaForUnit(unitId, { unit });
    } catch (metaErr) {
      logger.warn('[unit] invoiceScheduleMeta failed:', metaErr?.message || metaErr);
    }

    return {
      ...mapUnitResponse(
        {
          ...unit.toObject(),
          associatedOwnerIds: finalOwnerIds,
          ownershipRecords: ownershipTimeline,
        },
        {
          startingBalance: hasBillingSetup ? (unit.startingBalance || 0) : null,
          balanceAsOf: hasBillingSetup ? unit.balanceAsOf : null,
          monthlyRecurringFee: hasBillingSetup ? (unit.monthlyRecurringFee || 0) : null,
          paymentTerm: hasBillingSetup ? (unit.paymentTerm || 12) : 0,
        }
      ),
      images: imageUrls,
      invoiceScheduleMeta,
    };
  } catch (e) {
    throw e;
  }
}

async function updateUnitWithImages(unitId, unitData, files = [], options = {}) {
  let ownSession = false;
  let session = options && options.session;
  if (!session) {
    session = await mongoose.startSession();
    session.startTransaction();
    ownSession = true;
    options = Object.assign({}, options, { session });
  }

  try {
    const existingUnit = await Property.findById(unitId).session(session);
    if (!existingUnit) {
      const err = new Error('Unit not found');
      err.status = 404;
      throw err;
    }

    if (unitData.address) {
      if (!unitData.address.line1 || !unitData.address.city || !unitData.address.state || !unitData.address.zipCode) {
        const err = new Error('Address fields (line1, city, state, zipCode) are required');
        err.status = 400;
        throw err;
      }
    }


    if (unitData.depositBankAccountId && !mongoose.Types.ObjectId.isValid(unitData.depositBankAccountId)) {
      const err = new Error('Valid depositBankAccountId is required');
      err.status = 400;
      throw err;
    }

    const nextPropertyNameWithImages = normalizePropertyDisplayName(
      unitData.propertyName !== undefined && unitData.propertyName !== null
        ? unitData.propertyName
        : existingUnit.name || ''
    );
    if (Object.prototype.hasOwnProperty.call(unitData, 'title')) {
      assertValidUnitTitle(
        unitData.title,
        (unitData.address && unitData.address.city) || existingUnit.address?.city,
        { required: true }
      );
    }
    const nextTitleWithImages =
      unitData.title !== undefined && unitData.title !== null
        ? normalizeUnitTitle(unitData.title)
        : currentUnitTitleFromProperty(existingUnit);

    const duplicateOtherWithImages = await findDuplicateUnitDocument(
      nextPropertyNameWithImages,
      nextTitleWithImages,
      { excludeId: existingUnit._id, session, hoaId: existingUnit.hoaId || unitData.hoaId }
    );
    if (duplicateOtherWithImages) {
      const err = new Error(
        `Unit "${nextTitleWithImages}" already exists under property "${nextPropertyNameWithImages}".`
      );
      err.status = 409;
      throw err;
    }

    const updateData = {};
    if (unitData.propertyName) updateData.name = normalizePropertyDisplayName(unitData.propertyName);
    if (unitData.title) updateData['unitDetails.0.unitName'] = normalizeUnitTitle(unitData.title);
    if (unitData.description !== undefined) updateData.description = unitData.description;
    // if (unitData.emergencyContact) updateData.emergencyContact = unitData.emergencyContact;
    if (unitData.address) {
      updateData.address = {
        street: unitData.address.line1,
        city: unitData.address.city,
        state: unitData.address.state,
        zip: unitData.address.zipCode,
      };
    }
    if (unitData.tags !== undefined) updateData.tags = unitData.tags;
    let addedOwners = [];
    const ownersPayloadMultipart = resolveOwnersPayloadForUnitUpdate(unitData);
    if (ownersPayloadMultipart !== undefined) {
      const effectiveDate = toDateAtStartOfDay(ClockService.now());
      const timeline = ensureOwnershipTimeline(existingUnit, existingUnit.createdAt);
      const previousOwnerIds = getActiveOwnerIdsFromRecords(timeline, ClockService.now());
      const ownershipUpdate = rewriteOwnershipTimeline({
        records: timeline,
        nextOwnerIds: ownersPayloadMultipart,
        effectiveDate,
        action: 'CHANGE',
        performedBy: unitData.landlordId || unitData.boardMemberId || existingUnit.landlord_id,
        details: { source: 'legacy_update' },
        financialHandling: 'FRESH',
      });
      updateData.ownershipRecords = ownershipUpdate.ownershipRecords;
      updateData.ownershipLogs = [...(existingUnit.ownershipLogs || []), ownershipUpdate.ownershipLog];
      updateData.associatedOwnerIds = getActiveOwnerIdsFromRecords(
        ownershipUpdate.ownershipRecords,
        ownershipActivityAtForCurrentAssociation(effectiveDate, ClockService.now())
      );

      const membershipUpdate = await syncOwnerPropertyMembership(
        unitId,
        previousOwnerIds,
        updateData.associatedOwnerIds,
        session
      );
      addedOwners = membershipUpdate.addedOwners;
    }
    // Lock starting balance updates once invoices exist, except for ownerless units (fresh onboarding for next owner).
    if (unitData.startingBalance !== undefined) {
      const safeUnitIdForCount = toObjectId(unitId);
      const invoiceCount = await Invoice.countDocuments({ propertyId: safeUnitIdForCount, isDeleted: { $ne: true } });
      const hasAssociatedOwners =
        Array.isArray(existingUnit.associatedOwnerIds) && existingUnit.associatedOwnerIds.length > 0;
      if (invoiceCount > 0 && hasAssociatedOwners) {
        const err = new Error('Starting balance is locked. Use an adjustment instead.');
        err.status = 400;
        throw err;
      }
      updateData.startingBalance = unitData.startingBalance;
    }
    if (unitData.balanceAsOf) updateData.balanceAsOf = unitData.balanceAsOf;
    if (unitData.monthlyRecurringFee !== undefined) updateData.monthlyRecurringFee = unitData.monthlyRecurringFee;
    if (unitData.paymentTerm) updateData.paymentTerm = unitData.paymentTerm;
    if (unitData.depositBankAccountId) {
      updateData.depositBankAccountId = unitData.depositBankAccountId;
    }
    if (unitData.depositBankAccountName !== undefined) {
      updateData.depositBankAccountName = normalizeDepositBankLabel(unitData.depositBankAccountName);
    }

    // Handle image uploads
    let uploadedImages = [];
    if (files && files.length > 0) {
      for (const file of files) {
        const filename = file.filename || file.originalname;
        const key = `property-images/${unitId}/${filename}`;

        const result = await s3Client.upload({ localFilePath: file.path, key });

        const bucketName = config.s3?.bucketName || process.env.S3_BUCKET || 'mock-bucket';
        const region = config.s3?.region || process.env.AWS_REGION || 'mock-region';

        const metadataDoc = await DocumentMetadata.create([{
          key: result.Key || key,
          bucketName,
          region,
          size: file.size || 0,
          contentType: file.mimetype || 'image/jpeg',
          originalName: filename
        }], { session });

        uploadedImages.push({ metadataId: metadataDoc[0]._id });
      }

      updateData.images = [...(existingUnit.images || []), ...uploadedImages];
    }

    const updated = await Property.findByIdAndUpdate(
      unitId,
      { $set: updateData },
      { new: true, session }
    );

    await syncAssociatedInvoiceLabels(unitId, {
      unitLabel: nextTitleWithImages,
      propertyName: nextPropertyNameWithImages,
      previousUnitLabel: currentUnitTitleFromProperty(existingUnit),
      previousPropertyName: normalizePropertyDisplayName(existingUnit.name || ''),
      session,
    });

    const invoiceData = {
      ...unitData,
      ...resolveBillingConfiguration(unitData, existingUnit, updated.associatedOwnerIds)
    };
    const hasBillingConfig = hasBillingConfiguration(invoiceData);
    const billingChanged = billingConfigurationChanged(existingUnit, invoiceData);
    const existingInvoiceCount = await countExistingInvoices(unitId, session);
    let invoicesQueued = false;
    let invoiceQueueMode = 'initial';

    if (hasBillingConfig && billingChanged) {
      const billingResult = await applyBillingConfigurationChange({
        unitId,
        existingUnit,
        invoiceData,
        updated,
        session,
        existingInvoiceCount,
        deletedByUserId: unitData.landlordId || unitData.boardMemberId || updated.landlord_id,
        deferGeneration: true,
      });
      if (billingResult?.invoicesQueued) {
        invoicesQueued = true;
        invoiceQueueMode = billingResult.mode || 'regenerate';
        await markBillingPendingInSession(unitId, session);
      }
    } else if (existingInvoiceCount === 0) {
      await ensureOpeningBalanceLedgerIfMissing(unitId, invoiceData, existingUnit, existingInvoiceCount, session);
      if (
        hasBillingConfiguration(invoiceData) &&
        Array.isArray(updated.associatedOwnerIds) &&
        updated.associatedOwnerIds.length > 0
      ) {
        invoicesQueued = true;
        invoiceQueueMode = 'initial';
        await markBillingPendingInSession(unitId, session);
      }
    }

    const depositBankChanged =
      unitData.depositBankAccountId &&
      String(existingUnit.depositBankAccountId || '') !== String(unitData.depositBankAccountId);
    if (depositBankChanged) {
      await invoiceService.logDepositBankChangeForUnitInvoices(
        unitId,
        {
          previousBankAccountId: existingUnit.depositBankAccountId,
          previousBankAccountName: existingUnit.depositBankAccountName,
          newBankAccountId: unitData.depositBankAccountId,
          newBankAccountName: normalizeDepositBankLabel(unitData.depositBankAccountName),
        },
        unitData.boardMemberId || unitData.landlordId || updated.landlord_id,
        session
      );
    }

    if (ownSession) {
      await session.commitTransaction();
      session.endSession();
    }

    const addressWasUpdatedWithImages = Boolean(unitData.address);
    const ownerMailingSync =
      addressWasUpdatedWithImages &&
      updated.associatedOwnerIds &&
      updated.associatedOwnerIds.length > 0;

    if (ownSession) {
      schedulePostUpdateBackgroundTasks({
        updated,
        unitData,
        invoiceData,
        invoicesQueued,
        invoiceQueueMode,
        ownerMailingSync,
      });
    }

    await logActivity({
      userId: updated.landlord_id,
      action: 'UPDATE',
      module: 'Unit',
      entityId: updated._id,
      entityName: updated.name,
      description: `Updated unit "${updated.name}"`,
      meta: { address: updated.address }
    });

    if (ownSession && addedOwners.length > 0) {
      setImmediate(async () => {
        try {
          await notifyOwnersForUnitAssignment(
            addedOwners,
            updated.toObject ? updated.toObject() : updated,
            updated.landlord_id,
          );
        } catch (e) {
          logger.warn('Failed to send unit-assignment emails on unit update with images:', e.message);
        }
      });
      scheduleOwnerInvoiceGenerationForUnit(unitId, addedOwners, {
        userId: unitData.landlordId || unitData.boardMemberId || updated.landlord_id,
        hoaBoardMemberId: unitData.hoaBoardMemberId || unitData.boardMemberId || updated.landlord_id,
        createdBy: unitData.landlordId || unitData.boardMemberId || updated.landlord_id,
        hoaId: unitData.hoaId || updated.hoaId,
      });
    }

    const backgroundMeta = buildUnitBackgroundMeta(unitData, {
      invoicesQueued,
      ownerMailingSync,
    });

    if (ownSession) {
      queueUnitPropertyUpdatedNotification(
        updated,
        options.userId || unitData.landlordId || unitData.hoaBoardMemberId || unitData.boardMemberId || updated.landlord_id || null
      );
    }

    return {
      ...mapUnitResponse(updated, {
        startingBalance: unitData.startingBalance || 0,
        balanceAsOf: unitData.balanceAsOf || updated.createdAt,
      }),
      images: uploadedImages,
      imagesUploaded: uploadedImages.length,
      ...backgroundMeta,
    };
  } catch (e) {
    if (ownSession && session) {
      try { await session.abortTransaction(); } catch (ignore) { }
      try { session.endSession(); } catch (ignore) { }
    }
    throw e;
  }
}

async function addOwner(unitId, payload, performedBy, options = {}) {
  /** Apply pooled credit to due invoices before Start Fresh expense uses remainingCredit. */
  await ledgerService.applyAllUnappliedCreditToDueInvoices(unitId);

  return runWithTransactionRetry(async () => {
    let ownSession = false;
    let session = options.session;
    if (!session) {
      session = await mongoose.startSession();
      session.startTransaction();
      ownSession = true;
    }

    try {
      const unit = await Property.findById(unitId).session(session);
      if (!unit) {
        const err = new Error('Unit not found');
        err.status = 404;
        throw err;
      }

      const ownerRoleFilter = await buildHOAOwnerUserFilter();
      const safeOwnerId = toObjectId(payload.ownerId);
      const owner = await User.findOne({
        $and: [ownerRoleFilter, { _id: safeOwnerId }],
      }).session(session);
      if (!owner) {
        const err = new Error('Owner not found');
        err.status = 404;
        throw err;
      }
      assertOwnerEligibleForPropertyAssignment(owner);
      const ownerInvoiceEligible = isOwnerEligibleForInvoiceGeneration(owner);

      const effectiveDate = toDateAtStartOfDay(payload.startDate);
      assertOwnershipEffectiveDateWithinBalanceWindow(
        payload.startDate || effectiveDate,
        unit.balanceAsOf,
        'Effective date',
        { fallbackBalanceAsOf: unit.createdAt }
      );
      const ownershipRecords = ensureOwnershipTimeline(unit, unit.createdAt);
      const hasConflictingRecord = ownershipRecords.some((record) => (
        record.ownerId?.toString() === payload.ownerId.toString() &&
        ownershipRecordOverlapsEffectiveDate(record, effectiveDate)
      ));
      if (hasConflictingRecord) {
        const err = new Error('This owner already has an ownership record that overlaps the selected effective date');
        err.status = 400;
        throw err;
      }

      const previousOwnerIds = normalizeObjectIdStrings(unit.associatedOwnerIds || []);
      ownershipRecords.push({
        ownerId: payload.ownerId.toString(),
        startDate: effectiveDate,
        endDate: null,
        financialHandling: payload.financialHandling,
        createdAt: ClockService.now(),
      });

      const nextActiveOwnerIds = getActiveOwnerIdsFromRecords(
        ownershipRecords,
        ownershipActivityAtForCurrentAssociation(effectiveDate, ClockService.now())
      );
      await Property.findByIdAndUpdate(unitId, {
        $set: {
          associatedOwnerIds: nextActiveOwnerIds,
          ownershipRecords,
        },
        $push: {
          ownershipLogs: createOwnershipLogEntry({
            action: 'ADD',
            ownerIds: [payload.ownerId],
            effectiveDate,
            performedBy,
            details: { financialHandling: payload.financialHandling },
          })
        }
      }, { new: true, session });

      if (ownerInvoiceEligible) {
        await syncInvoiceTenantsForAddOwner({
          unitId,
          ownerId: payload.ownerId.toString(),
          effectiveDate,
          financialHandling: payload.financialHandling,
          session,
        });
      }

      let creditExpenseCreated = null;
      const wasOwnerless = previousOwnerIds.length === 0;
      let invoicesQueuedOnAdd = false;
      let invoiceSeedDataForQueue = null;
      let unitNameForQueue = unit.name;

      if (wasOwnerless && payload.financialHandling === 'FRESH') {
        const creditBasis = await ledgerService.computePortfolioWriteOffSettlementAmountUsd(unitId, session);
        const credit = roundMoney(
          Number(creditBasis.remainingCreditEffective || unit.remainingCredit || 0) || 0
        );
        if (credit > 0) {
          await createUnappliedCreditReleaseExpense({
            unit,
            unitId,
            amount: credit,
            performedBy,
            session,
            newOwnerUserId: payload.ownerId,
          });
          await ledgerService.drainLedgerCreditSourcesForRelease(
            unitId,
            credit,
            performedBy,
            session
          );
          creditExpenseCreated = { amount: credit };
        }
      }

      // Edit-unit flow often saves billing fields before linking owners; generateUnitInvoices skips when
      // associatedOwnerIds is empty. After a verified owner exists, create invoices if billing is configured.
      if (wasOwnerless && ownerInvoiceEligible) {
        const unitForBilling = await Property.findById(unitId).session(session).lean();
        if (unitForBilling) {
          const rp =
            unitForBilling.requestPayload && typeof unitForBilling.requestPayload === 'object' && !Array.isArray(unitForBilling.requestPayload)
              ? unitForBilling.requestPayload
              : {};
          const paymentDueDay = await resolveUnitPaymentDueDay({
            hoaId: unitForBilling.hoaId,
            requestPayload: rp,
            preferHoaSettings: true,
          });
          const balanceAsOf = unitForBilling.balanceAsOf != null
            ? normalizeBillingDate(unitForBilling.balanceAsOf)
            : getDateKeyInTimeZone(ClockService.now());
          const invoiceSeedData = {
            startingBalance:
              unitForBilling.startingBalance !== undefined && unitForBilling.startingBalance !== null
                ? normalizeBillingNumber(unitForBilling.startingBalance)
                : 0,
            balanceAsOf,
            monthlyRecurringFee: normalizeBillingNumber(unitForBilling.monthlyRecurringFee),
            paymentTerm: Number(unitForBilling.paymentTerm || 0),
            paymentDueDay,
            associatedOwnerIds: normalizeObjectIdStrings(nextActiveOwnerIds),
            title:
              unitForBilling.unitDetails && unitForBilling.unitDetails[0] && unitForBilling.unitDetails[0].unitName
                ? unitForBilling.unitDetails[0].unitName
                : 'Unit',
            createdBy: performedBy,
            hoaBoardMemberId: performedBy,
            hoaId: unitForBilling.hoaId,
          };

          if (hasBillingConfiguration(invoiceSeedData)) {
            await Property.findByIdAndUpdate(
              unitId,
              {
                $set: {
                  balanceAsOf: parseDateOnlyToNoonUtc(balanceAsOf),
                  'requestPayload.paymentDueDay': paymentDueDay,
                },
              },
              { session },
            );
            await softDeleteOpenAutoGeneratedInvoices(unitId, performedBy, session);
            await ensureOpeningBalanceLedgerIfMissing(
              unitId,
              invoiceSeedData,
              unitForBilling,
              0,
              session
            );
            invoicesQueuedOnAdd = true;
            invoiceSeedDataForQueue = invoiceSeedData;
            unitNameForQueue = unitForBilling.name;
            await markBillingPendingInSession(unitId, session);
          }
        }
      }

      await syncOwnerPropertyMembership(unitId, previousOwnerIds, nextActiveOwnerIds, session);

      if (ownSession) {
        await session.commitTransaction();
        session.endSession();
      }

      // Persist after ownership commit so audit survives later ownership changes.
      try {
        await recordOwnershipChangeActivities({
          unit,
          unitId,
          action: 'ADD',
          previousOwnerIds,
          newOwnerIds: [payload.ownerId],
          performedBy,
          performedAt: ClockService.now(),
          session: ownSession ? null : session,
          source: 'add-owner',
        });
      } catch (activityErr) {
        logger.warn('[addOwner] Failed to record ownership activity:', activityErr.message);
      }

      if (ownSession && invoicesQueuedOnAdd && invoiceSeedDataForQueue) {
        queueBillingInvoiceGeneration({
          propertyId: unitId,
          propertyName: unitNameForQueue,
          unitData: invoiceSeedDataForQueue,
          context: 'add-owner',
          mode: 'regenerate',
        });
      }

      if (ownSession) {
        setImmediate(async () => {
          try {
            const [recipient, freshUnit, assignedByName] = await Promise.all([
              User.findById(payload.ownerId).select('firstName lastName email hoaInfo').lean(),
              Property.findById(unitId).select('name address unitDetails hoaId associatedOwnerIds').lean(),
              resolveAssignerName(performedBy),
            ]);
            if (!recipient?.email || !freshUnit) return;
            await sendUnitAssignmentEmail({
              recipient,
              property: freshUnit,
              assignedByName,
              hoaId: freshUnit.hoaId,
            });
            queueUnitPropertyUpdatedNotification(freshUnit, performedBy);
            notifyOwnerUpdatedInAppInBackground(recipient, performedBy, freshUnit.hoaId);
          } catch (emailErr) {
            logger.warn('[addOwner] unit assignment email failed:', emailErr.message);
          }
        });
      }

      return {
        message: 'Owner added successfully',
        unitId,
        ownerId: payload.ownerId,
        startDate: effectiveDate,
        financialHandling: payload.financialHandling,
        ...(creditExpenseCreated ? { creditExpenseCreated } : {}),
        ...(invoicesQueuedOnAdd
          ? buildUnitBackgroundMeta(invoiceSeedDataForQueue, { invoicesQueued: true })
          : {}),
      };
    } catch (error) {
      if (ownSession && session) {
        try { await session.abortTransaction(); } catch (ignore) { }
        try { session.endSession(); } catch (ignore) { }
      }
      throw error;
    }
  });
}

async function removeOwner(unitId, payload, performedBy, options = {}) {
  /** Apply pooled credits (ledger + Property.remainingCredit) to invoices that became due */
  await ledgerService.applyAllUnappliedCreditToDueInvoices(unitId);

  return runWithTransactionRetry(async () => {
    let ownSession = false;
    let session = options.session;
    if (!session) {
      session = await mongoose.startSession();
      session.startTransaction();
      ownSession = true;
    }

    try {
      const unit = await Property.findById(unitId).session(session);
      if (!unit) {
        const err = new Error('Unit not found');
        err.status = 404;
        throw err;
      }

      const now = ClockService.now();
      assertRemovalEffectiveDateNotInPast(payload.effectiveDate);
      // Calendar-day anchor for ownership logs. Joi converts ISO strings to Date, so do not
      // rely on string "T" detection for "today vs future" removal semantics.
      const effectiveDate = toDateAtStartOfDay(payload.effectiveDate);
      const todayKey = getDateKeyInTimeZone(now);
      const effectiveKey = billingCalendarDateKey(effectiveDate);
      const isRemovalToday = Boolean(effectiveKey && todayKey && effectiveKey === todayKey);
      const isFutureRemoval = !isRemovalToday;
      // Today: end at wall-clock now. Future: end at 00:00 business TZ on the effective calendar day.
      const removalEndDate = removalEndInstantForEffectiveDate(effectiveDate, isRemovalToday, now);
      const ownershipRecords = ensureOwnershipTimeline(unit, unit.createdAt);
      const targetRecord = findOwnershipRecordForRemoval({
        ownershipRecords,
        ownerId: payload.ownerId,
        associatedOwnerIds: unit.associatedOwnerIds || [],
        removalEndDate,
        effectiveKey,
        now,
      });

      if (!targetRecord) {
        const err = new Error('No active ownership record was found for this owner on the selected date');
        err.status = 400;
        throw err;
      }

      const previousOwnerIds = normalizeObjectIdStrings(unit.associatedOwnerIds || []);
      // Keep an already-correct endDate on the same calendar day; otherwise close at removalEndDate.
      // Never write endDate < startDate (same-day remove before noon start anchors) - clamp to start.
      if (
        !targetRecord.endDate ||
        !effectiveKey ||
        billingCalendarDateKey(targetRecord.endDate) !== effectiveKey ||
        targetRecord.endDate > removalEndDate
      ) {
        const startMs = targetRecord.startDate instanceof Date ? targetRecord.startDate.getTime() : 0;
        const endMs = Math.max(removalEndDate.getTime(), Number.isFinite(startMs) ? startMs : 0);
        targetRecord.endDate = new Date(endMs);
      }
      const nextActiveOwnerIds = isFutureRemoval
        ? getActiveOwnerIdsFromRecords(ownershipRecords, now)
        : resolveRemainingOwnerIdsAfterRemoval({
          previousOwnerIds,
          removedOwnerId: payload.ownerId,
          ownershipRecords,
          removalEndDate,
          isRemovalToday,
          now,
        });
      const isLastOwnerRemoval = !isFutureRemoval && nextActiveOwnerIds.length === 0;

      await Property.findByIdAndUpdate(unitId, {
        $set: {
          associatedOwnerIds: nextActiveOwnerIds,
          ownershipRecords,
        },
        $push: {
          ownershipLogs: createOwnershipLogEntry({
            action: 'REMOVE',
            ownerIds: [payload.ownerId],
            effectiveDate,
            performedBy,
            details: isFutureRemoval
              ? {
                isFutureScheduled: true,
                effectiveRemovalProcessed: false,
                effectiveDateKey: effectiveKey,
                removedOwnerId: String(payload.ownerId),
                balanceSettlement: payload.balanceSettlement || 'MARK_PAID',
                paymentMethod: payload.paymentMethod,
                checkNumber: payload.checkNumber,
                moneyOrderNumber: payload.moneyOrderNumber,
                previousOwnerIds,
              }
              : {},
          })
        }
      }, { new: true, session });

      if (isFutureRemoval) {
        await User.updateMany(
          { _id: toObjectId(payload.ownerId) },
          { $addToSet: { propertyIds: unitId } },
          { session }
        );
      }

      let ownerlessSettlement = null;
      if (!isFutureRemoval && isLastOwnerRemoval) {
        const balanceSettlement = payload.balanceSettlement || 'MARK_PAID';
        const removalPayment =
          balanceSettlement === 'MARK_PAID' &&
          payload.paymentMethod != null &&
          String(payload.paymentMethod).trim()
            ? {
              paymentMethod: String(payload.paymentMethod).trim(),
              checkNumber: payload.checkNumber,
              moneyOrderNumber: payload.moneyOrderNumber,
            }
            : null;
        await ledgerService.softDeleteFutureUnpaidInvoices(unitId, performedBy, session);
        ownerlessSettlement = await ledgerService.settleUnitFinancialsWhenLastOwnerRemoved(
          unitId,
          performedBy,
          session,
          removalPayment,
          {
            removedOwnerId: payload.ownerId.toString(),
            balanceSettlement,
          }
        );
        await Property.findByIdAndUpdate(
          unitId,
          {
            $set: {
              startingBalance: 0,
              remainingCredit: 0,
              'requestPayload.billingProcessingStatus': 'complete',
              'requestPayload.billingProcessingUpdatedAt': ClockService.now(),
            },
            $unset: { balanceAsOf: 1, 'requestPayload.paymentDueDay': 1 },
          },
          { session }
        );
      }

      if (!isFutureRemoval) {
        await syncInvoiceTenantsForRemoveOwner({
          unitId,
          ownerId: payload.ownerId.toString(),
          effectiveDate,
          session,
          remainingOwnerIds: nextActiveOwnerIds,
        });

        await syncOwnerPropertyMembership(unitId, previousOwnerIds, nextActiveOwnerIds, session);
      }

      const willBeOwnerless = !isFutureRemoval && isLastOwnerRemoval;

      if (ownSession) {
        await session.commitTransaction();
        session.endSession();
      }

      try {
        await recordOwnershipChangeActivities({
          unit,
          unitId,
          action: 'REMOVE',
          previousOwnerIds: [payload.ownerId],
          newOwnerIds: nextActiveOwnerIds,
          performedBy,
          performedAt: ClockService.now(),
          session: ownSession ? null : session,
          source: 'remove-owner',
        });
      } catch (activityErr) {
        logger.warn('[removeOwner] Failed to record ownership activity:', activityErr.message);
      }

      setImmediate(async () => {
        try {
          const removedOwner = await User.findById(payload.ownerId).lean();
          const unitSnapshot = await Property.findById(unitId).lean();
          if (removedOwner && unitSnapshot) {
            try {
              await sendOwnerRemovalNoticeEmail({
                owner: removedOwner,
                property: unitSnapshot,
                action: 'remove',
                effectiveDate,
                balanceSettlement: payload.balanceSettlement || null,
                performedBy,
              });
            } catch (emailErr) {
              logger.warn('[removeOwner] Failed to send owner removal notice:', emailErr.message);
            }

            if (!isFutureRemoval) {
              const ownerName = `${removedOwner.firstName || ''} ${removedOwner.lastName || ''}`.trim() || 'Owner';
              const unitName = unitSnapshot?.unitDetails?.[0]?.unitName
                ? `${unitSnapshot.name || 'Property'} · ${unitSnapshot.unitDetails[0].unitName}`
                : (unitSnapshot?.name || 'Unit');
              notifyOwnerDeletedInAppInBackground({
                ownerUserId: payload.ownerId.toString(),
                ownerName,
                hoaId: unitSnapshot.hoaId,
                propertyId: unitId,
                unitName,
              }, performedBy);
            }
          }
        } catch (notifyErr) {
          logger.warn('[removeOwner] Failed to send owner removal notification:', notifyErr.message);
        }
      });

      return {
        message: isFutureRemoval
          ? 'Owner removal scheduled successfully'
          : 'Owner removed successfully',
        unitId,
        ownerId: payload.ownerId,
        effectiveDate,
        scheduled: isFutureRemoval,
        ...(willBeOwnerless ? { ownerlessSettlement } : {}),
      };
    } catch (error) {
      if (ownSession && session) {
        try { await session.abortTransaction(); } catch (ignore) { }
        try { session.endSession(); } catch (ignore) { }
      }
      throw error;
    }
  });
}

async function changeOwnership(unitId, payload, performedBy, options = {}) {
  await ledgerService.applyAllUnappliedCreditToDueInvoices(unitId);

  return runWithTransactionRetry(async () => {
    let ownSession = false;
    let session = options.session;
    if (!session) {
      session = await mongoose.startSession();
      session.startTransaction();
      ownSession = true;
    }

    try {
      const unit = await Property.findById(unitId).session(session);
      if (!unit) {
        const err = new Error('Unit not found');
        err.status = 404;
        throw err;
      }

      const ownerRoleFilter = await buildHOAOwnerUserFilter();
      const safeNewOwnerIds = toObjectIds(payload.newOwnerIds);
      const ownerCount = await User.countDocuments({
        $and: [ownerRoleFilter, { _id: { $in: safeNewOwnerIds } }],
      }).session(session);
      if (ownerCount !== safeNewOwnerIds.length) {
        const err = new Error('One or more new owners were not found');
        err.status = 400;
        throw err;
      }

      const newOwners = await User.find({
        $and: [ownerRoleFilter, { _id: { $in: safeNewOwnerIds } }],
      })
        .select('portalOnboardingStatus status isArchived isDeleted')
        .session(session)
        .lean();
      assertOwnersEligibleForPropertyAssignment(newOwners);

      const previousOwnerIds = normalizeObjectIdStrings(unit.associatedOwnerIds || []);
      const creditBasis = await ledgerService.computePortfolioWriteOffSettlementAmountUsd(unitId, session);
      const creditSnapshotForLog = roundMoney(
        Number(creditBasis.remainingCreditEffective || unit.remainingCredit || 0) || 0
      );

      const effectiveDate = toDateAtStartOfDay(payload.effectiveDate);
      assertOwnershipEffectiveDateWithinBalanceWindow(
        payload.effectiveDate || effectiveDate,
        unit.balanceAsOf,
        'Effective transfer date',
        { fallbackBalanceAsOf: unit.createdAt }
      );
      const isFutureTransfer = isFutureCalendarEffectiveDate(effectiveDate);
      const normalizedNewOwnerIds = normalizeObjectIdStrings(payload.newOwnerIds);
      const effectiveKey = billingCalendarDateKey(effectiveDate);

      let balanceResetSettlement = null;
      let resetOpenInvoicesReassigned = null;
      if (payload.balanceHandling === 'RESET') {
        balanceResetSettlement = await ledgerService.settleUnitFinancialsForOwnershipBalanceReset(
          unitId,
          performedBy,
          session,
          removalPaymentFromChangePayload(payload),
          { priorOwnerIds: previousOwnerIds }
        );
        // Keep Billing Effective Date populated for the new ownership period.
        // Unsetting balanceAsOf left Account Summary showing "-" after change ownership.
        await Property.findByIdAndUpdate(
          unitId,
          {
            $set: {
              startingBalance: 0,
              remainingCredit: 0,
              balanceAsOf: effectiveDate,
              'requestPayload.billingProcessingStatus': 'complete',
              'requestPayload.billingProcessingUpdatedAt': ClockService.now(),
            },
            $unset: { 'requestPayload.paymentDueDay': 1 },
          },
          { session }
        );

        const safeUnitIdForOpen = toObjectId(unitId);
        let qOpen = Invoice.find({
          propertyId: safeUnitIdForOpen,
          isDeleted: { $ne: true },
          status: {
            $in: [
              INVOICE_STATUS.PENDING,
              INVOICE_STATUS.PARTIALLY_PAID,
              INVOICE_STATUS.OVERDUE,
            ],
          },
        })
          .select('invoiceId dueDate balanceDue term status')
          .sort({ dueDate: 1 });
        qOpen = qOpen.session(session);
        const openRows = await qOpen.lean();
        resetOpenInvoicesReassigned = openRows.map((i) => ({
          id: String(i._id),
          invoiceId: i.invoiceId,
          dueDate: i.dueDate,
          balanceDue: roundMoney(Number(i.balanceDue || 0)),
          term: i.term || null,
          status: i.status,
        }));
      }

      const timeline = ensureOwnershipTimeline(unit, unit.createdAt);
      const rewritten = rewriteOwnershipTimeline({
        records: timeline,
        nextOwnerIds: payload.newOwnerIds,
        effectiveDate,
        action: 'CHANGE',
        performedBy,
        details: {
          balanceHandling: payload.balanceHandling,
          chargeHandling: payload.chargeHandling,
          futureCharges: payload.futureCharges,
          templateHandling: payload.templateHandling,
          previousOwnerIds,
          newOwnerIds: normalizedNewOwnerIds,
          effectiveDateKey: effectiveKey,
          isFutureScheduled: isFutureTransfer,
          effectiveTransferProcessed: !isFutureTransfer,
          ...(isFutureTransfer ? {} : { effectiveTransferProcessedAt: ClockService.now() }),
          ...(payload.balanceHandling === 'MIGRATE'
            ? {
              remainingCreditCarriedForwardUsd: creditSnapshotForLog,
              previousOwnerIds,
              migrateNote:
                'Unit balance, open invoices (with prior payment history on partials), and credits carry forward to new owners.',
            }
            : {}),
          ...(payload.balanceHandling === 'RESET'
            ? {
              previousOwnerIds,
              resetNote:
                'Due/overdue balances for the prior period were settled; open invoices (including future-dated assessments) were reassigned to the new owners.',
              openInvoicesReassignedToNewOwners: resetOpenInvoicesReassigned || [],
            }
            : {}),
          ...(balanceResetSettlement ? { balanceResetSettlement } : {}),
        },
        financialHandling: payload.balanceHandling === 'MIGRATE' ? 'INCLUDE_BALANCE' : 'FRESH',
      });

      const nextActiveOwnerIds = getActiveOwnerIdsFromRecords(
        rewritten.ownershipRecords,
        ownershipActivityAtForCurrentAssociation(effectiveDate, ClockService.now())
      );

      await Property.findByIdAndUpdate(unitId, {
        $set: {
          associatedOwnerIds: nextActiveOwnerIds,
          ownershipRecords: rewritten.ownershipRecords,
        },
        $push: {
          ownershipLogs: rewritten.ownershipLog,
        }
      }, { new: true, session });

      await syncInvoiceTenantsForChangeOwnership({
        unitId,
        ownerIds: payload.newOwnerIds,
        session,
        effectiveDate,
      });

      await syncOwnerPropertyMembership(unitId, previousOwnerIds, nextActiveOwnerIds, session);

      if (ownSession) {
        await session.commitTransaction();
        session.endSession();
      }

      try {
        await recordOwnershipChangeActivities({
          unit,
          unitId,
          action: 'CHANGE',
          previousOwnerIds,
          newOwnerIds: payload.newOwnerIds,
          performedBy,
          performedAt: ClockService.now(),
          session: ownSession ? null : session,
          source: 'change-ownership',
        });
      } catch (activityErr) {
        logger.warn('[changeOwnership] Failed to record ownership activity:', activityErr.message);
      }

      if (ownSession) {
        setImmediate(async () => {
          try {
            const freshUnit = await Property.findById(unitId).lean();
            if (!freshUnit) return;

            const {
              queueOwnershipChangeScheduledNotification,
              queueOwnershipChangeEffectiveNotification,
            } = require('./ownershipChangeNotification.service');

            const notifyPayload = {
              unitId,
              property: freshUnit,
              previousOwnerIds,
              newOwnerIds: normalizedNewOwnerIds,
              effectiveDate,
              performedBy,
              balanceResetSettlement: balanceResetSettlement || null,
            };

            if (isFutureTransfer) {
              queueOwnershipChangeScheduledNotification(notifyPayload);
              await Property.findByIdAndUpdate(
                unitId,
                {
                  $set: {
                    'ownershipLogs.$[log].details.scheduledNotificationSentAt': ClockService.now(),
                  },
                },
                {
                  arrayFilters: [{ 'log.action': 'CHANGE', 'log.details.effectiveDateKey': effectiveKey }],
                }
              );
            } else {
              queueOwnershipChangeEffectiveNotification(notifyPayload);
              await Property.findByIdAndUpdate(
                unitId,
                {
                  $set: {
                    'ownershipLogs.$[log].details.effectiveNotificationSentAt': ClockService.now(),
                  },
                },
                {
                  arrayFilters: [{ 'log.action': 'CHANGE', 'log.details.effectiveDateKey': effectiveKey }],
                }
              );
            }
          } catch (notifyErr) {
            logger.warn('[changeOwnership] ownership notification failed:', notifyErr.message);
          }
        });
      }

      return {
        message: 'Ownership changed successfully',
        unitId,
        ownerIds: normalizeObjectIdStrings(payload.newOwnerIds),
        effectiveDate,
        ...(balanceResetSettlement ? { balanceResetSettlement } : {}),
      };
    } catch (error) {
      if (ownSession && session) {
        try { await session.abortTransaction(); } catch (ignore) { }
        try { session.endSession(); } catch (ignore) { }
      }
      throw error;
    }
  });
}

/**
 * Activate a future-scheduled ownership transfer on/after its effective calendar day.
 * Idempotent: skips logs already marked effectiveTransferProcessed.
 */
async function activateScheduledOwnershipTransfer(unitId, logEntry) {
  const effectiveDate = logEntry?.effectiveDate;
  const effectiveKey = billingCalendarDateKey(effectiveDate);
  if (!effectiveKey || !effectiveDate) {
    return { processed: false, reason: 'missing_effective_date' };
  }

  const previousOwnerIds = normalizeObjectIdStrings(logEntry.details?.previousOwnerIds || []);
  const newOwnerIds = normalizeObjectIdStrings(
    logEntry.details?.newOwnerIds || logEntry.ownerIds || []
  );
  const performedBy = logEntry.performedBy;

  return runWithTransactionRetry(async () => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const unit = await Property.findById(unitId).session(session);
      if (!unit) {
        const err = new Error('Unit not found');
        err.status = 404;
        throw err;
      }

      const pendingLog = (unit.ownershipLogs || []).find((log) => (
        log.action === 'CHANGE'
        && billingCalendarDateKey(log.effectiveDate) === effectiveKey
        && log.details?.isFutureScheduled === true
        && log.details?.effectiveTransferProcessed !== true
      ));
      if (!pendingLog) {
        try { await session.abortTransaction(); } catch (ignore) { }
        try { session.endSession(); } catch (ignore) { }
        return { processed: false, reason: 'already_processed' };
      }

      const timeline = ensureOwnershipTimeline(unit, unit.createdAt);
      const nextActiveOwnerIds = getActiveOwnerIdsFromRecords(
        timeline,
        ownershipActivityAtForCurrentAssociation(effectiveDate, ClockService.now())
      );
      const priorAssociated = normalizeObjectIdStrings(unit.associatedOwnerIds || []);

      await Property.findByIdAndUpdate(
        unitId,
        {
          $set: {
            associatedOwnerIds: nextActiveOwnerIds,
            'ownershipLogs.$[log].details.effectiveTransferProcessed': true,
            'ownershipLogs.$[log].details.effectiveTransferProcessedAt': ClockService.now(),
          },
        },
        {
          session,
          arrayFilters: [{
            'log.action': 'CHANGE',
            'log.details.effectiveDateKey': effectiveKey,
            'log.details.isFutureScheduled': true,
          }],
        }
      );

      await syncOwnerPropertyMembership(unitId, priorAssociated, nextActiveOwnerIds, session);
      await session.commitTransaction();
      session.endSession();

      const freshUnit = await Property.findById(unitId).lean();
      const { notifyOwnershipChangeEffective } = require('./ownershipChangeNotification.service');
      await notifyOwnershipChangeEffective({
        unitId,
        property: freshUnit,
        previousOwnerIds: previousOwnerIds.length ? previousOwnerIds : priorAssociated,
        newOwnerIds,
        effectiveDate,
        performedBy,
        balanceResetSettlement: pendingLog.details?.balanceResetSettlement || null,
      });

      await Property.findByIdAndUpdate(
        unitId,
        {
          $set: {
            'ownershipLogs.$[log].details.effectiveNotificationSentAt': ClockService.now(),
          },
        },
        {
          arrayFilters: [{ 'log.action': 'CHANGE', 'log.details.effectiveDateKey': effectiveKey }],
        }
      );

      return { processed: true, unitId, effectiveDateKey: effectiveKey };
    } catch (error) {
      try { await session.abortTransaction(); } catch (ignore) { }
      try { session.endSession(); } catch (ignore) { }
      throw error;
    }
  });
}

/**
 * Finalize a future-scheduled owner removal on/after its effective calendar day.
 * Applies membership, invoice, settlement, and notification side effects deferred at schedule time.
 */
async function activateScheduledOwnershipRemoval(unitId, logEntry) {
  await ledgerService.applyAllUnappliedCreditToDueInvoices(unitId);

  const effectiveDate = logEntry?.effectiveDate;
  const effectiveKey = billingCalendarDateKey(effectiveDate);
  if (!effectiveKey || !effectiveDate) {
    return { processed: false, reason: 'missing_effective_date' };
  }

  const removedOwnerId = String(
    logEntry.details?.removedOwnerId || logEntry.ownerIds?.[0] || ''
  ).trim();
  if (!removedOwnerId) {
    return { processed: false, reason: 'missing_removed_owner' };
  }

  const performedBy = logEntry.performedBy;
  const balanceSettlement = logEntry.details?.balanceSettlement || 'MARK_PAID';
  const removalPayment =
    balanceSettlement === 'MARK_PAID' &&
    logEntry.details?.paymentMethod != null &&
    String(logEntry.details.paymentMethod).trim()
      ? {
        paymentMethod: String(logEntry.details.paymentMethod).trim(),
        checkNumber: logEntry.details.checkNumber,
        moneyOrderNumber: logEntry.details.moneyOrderNumber,
      }
      : null;

  return runWithTransactionRetry(async () => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const unit = await Property.findById(unitId).session(session);
      if (!unit) {
        const err = new Error('Unit not found');
        err.status = 404;
        throw err;
      }

      const pendingLog = (unit.ownershipLogs || []).find((log) => (
        log.action === 'REMOVE'
        && billingCalendarDateKey(log.effectiveDate) === effectiveKey
        && log.details?.isFutureScheduled === true
        && log.details?.effectiveRemovalProcessed !== true
      ));
      if (!pendingLog) {
        try { await session.abortTransaction(); } catch (ignore) { }
        try { session.endSession(); } catch (ignore) { }
        return { processed: false, reason: 'already_processed' };
      }

      const now = ClockService.now();
      const ownershipRecords = ensureOwnershipTimeline(unit, unit.createdAt);
      const previousOwnerIds = normalizeObjectIdStrings(
        logEntry.details?.previousOwnerIds || unit.associatedOwnerIds || []
      );
      const removalEndDate = removalEndInstantForEffectiveDate(effectiveDate, false, now);
      const nextActiveOwnerIds = resolveRemainingOwnerIdsAfterRemoval({
        previousOwnerIds,
        removedOwnerId,
        ownershipRecords,
        removalEndDate,
        isRemovalToday: true,
        now,
      });
      const isLastOwnerRemoval = nextActiveOwnerIds.length === 0;
      let ownerlessSettlement = null;

      if (isLastOwnerRemoval) {
        await ledgerService.softDeleteFutureUnpaidInvoices(unitId, performedBy, session);
        ownerlessSettlement = await ledgerService.settleUnitFinancialsWhenLastOwnerRemoved(
          unitId,
          performedBy,
          session,
          removalPayment,
          {
            removedOwnerId,
            balanceSettlement,
          }
        );
        await Property.findByIdAndUpdate(
          unitId,
          {
            $set: {
              startingBalance: 0,
              remainingCredit: 0,
              'requestPayload.billingProcessingStatus': 'complete',
              'requestPayload.billingProcessingUpdatedAt': ClockService.now(),
            },
            $unset: { balanceAsOf: 1, 'requestPayload.paymentDueDay': 1 },
          },
          { session }
        );
      }

      await syncInvoiceTenantsForRemoveOwner({
        unitId,
        ownerId: removedOwnerId,
        effectiveDate,
        session,
        remainingOwnerIds: nextActiveOwnerIds,
      });

      await syncOwnerPropertyMembership(unitId, previousOwnerIds, nextActiveOwnerIds, session);

      await Property.findByIdAndUpdate(
        unitId,
        {
          $set: {
            associatedOwnerIds: nextActiveOwnerIds,
            'ownershipLogs.$[log].details.effectiveRemovalProcessed': true,
            'ownershipLogs.$[log].details.effectiveRemovalProcessedAt': ClockService.now(),
          },
        },
        {
          session,
          arrayFilters: [{
            'log.action': 'REMOVE',
            'log.details.effectiveDateKey': effectiveKey,
            'log.details.isFutureScheduled': true,
          }],
        }
      );

      await session.commitTransaction();
      session.endSession();

      setImmediate(async () => {
        try {
          const removedOwner = await User.findById(removedOwnerId).lean();
          const unitSnapshot = await Property.findById(unitId).lean();
          if (!removedOwner || !unitSnapshot) return;
          try {
            await sendOwnerRemovalNoticeEmail({
              owner: removedOwner,
              property: unitSnapshot,
              action: 'remove',
              effectiveDate,
              balanceSettlement,
              performedBy,
            });
          } catch (emailErr) {
            logger.warn('[activateScheduledOwnershipRemoval] Failed to send owner removal notice:', emailErr.message);
          }

          const ownerName = `${removedOwner.firstName || ''} ${removedOwner.lastName || ''}`.trim() || 'Owner';
          const unitName = unitSnapshot?.unitDetails?.[0]?.unitName
            ? `${unitSnapshot.name || 'Property'} · ${unitSnapshot.unitDetails[0].unitName}`
            : (unitSnapshot?.name || 'Unit');
          notifyOwnerDeletedInAppInBackground({
            ownerUserId: removedOwnerId,
            ownerName,
            hoaId: unitSnapshot.hoaId,
            propertyId: unitId,
            unitName,
          }, performedBy);
        } catch (notifyErr) {
          logger.warn('[activateScheduledOwnershipRemoval] Failed to send owner removal notification:', notifyErr.message);
        }
      });

      return {
        processed: true,
        unitId,
        effectiveDateKey: effectiveKey,
        ownerlessSettlement,
      };
    } catch (error) {
      try { await session.abortTransaction(); } catch (ignore) { }
      try { session.endSession(); } catch (ignore) { }
      throw error;
    }
  });
}

async function processDueOwnershipTransfers(referenceDate = ClockService.now()) {
  const todayKey = billingCalendarDateKey(referenceDate);
  if (!todayKey) return { processed: 0, skipped: 0 };

  const units = await Property.find({
    isDeleted: { $ne: true },
    $or: [
      {
        ownershipLogs: {
          $elemMatch: {
            action: 'CHANGE',
            'details.isFutureScheduled': true,
            'details.effectiveTransferProcessed': { $ne: true },
          },
        },
      },
      {
        ownershipLogs: {
          $elemMatch: {
            action: 'REMOVE',
            'details.isFutureScheduled': true,
            'details.effectiveRemovalProcessed': { $ne: true },
          },
        },
      },
    ],
  })
    .select('_id ownershipLogs')
    .lean();

  let processed = 0;
  let skipped = 0;

  for (const unit of units) {
    const dueChangeLogs = (unit.ownershipLogs || [])
      .filter((log) => (
        log.action === 'CHANGE'
        && log.details?.isFutureScheduled === true
        && log.details?.effectiveTransferProcessed !== true
        && log.effectiveDate
        && billingCalendarDateKey(log.effectiveDate) <= todayKey
      ))
      .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());

    for (const log of dueChangeLogs) {
      try {
        const result = await activateScheduledOwnershipTransfer(unit._id, log);
        if (result?.processed) processed += 1;
        else skipped += 1;
      } catch (err) {
        skipped += 1;
        logger.warn('[processDueOwnershipTransfers] change activation failed', {
          unitId: unit._id,
          error: err?.message || err,
        });
      }
    }

    const dueRemoveLogs = (unit.ownershipLogs || [])
      .filter((log) => (
        log.action === 'REMOVE'
        && log.details?.isFutureScheduled === true
        && log.details?.effectiveRemovalProcessed !== true
        && log.effectiveDate
        && billingCalendarDateKey(log.effectiveDate) <= todayKey
      ))
      .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());

    for (const log of dueRemoveLogs) {
      try {
        const result = await activateScheduledOwnershipRemoval(unit._id, log);
        if (result?.processed) processed += 1;
        else skipped += 1;
      } catch (err) {
        skipped += 1;
        logger.warn('[processDueOwnershipTransfers] remove activation failed', {
          unitId: unit._id,
          error: err?.message || err,
        });
      }
    }
  }

  return { processed, skipped };
}

async function deleteUnit(unitId, options = {}) {
  let ownSession = false;
  let session = options && options.session;
  if (!session) {
    session = await mongoose.startSession();
    session.startTransaction();
    ownSession = true;
    options = Object.assign({}, options, { session });
  }

  try {
    const unit = await Property.findById(unitId).session(session);
    if (!unit) {
      const err = new Error('Unit not found');
      err.status = 404;
      throw err;
    }

    // Soft-delete the unit only (Property.isDeleted). Expenses remain on file for audit; never cascade-delete them.
    const deleted = await Property.findByIdAndUpdate(
      unitId,
      {
        $set: {
          isDeleted: true,
          deletedAt: ClockService.now()
        }
      },
      { new: true, session }
    );

    const deletedBy = options.userId || options.deletedBy || unit.landlord_id;
    await ledgerService.softDeleteFutureUnpaidInvoices(unitId, deletedBy, session);

    // Remove unit from associated owners' propertyIds
    if (unit.associatedOwnerIds && unit.associatedOwnerIds.length > 0) {
      await User.updateMany(
        { _id: { $in: unit.associatedOwnerIds } },
        { $pull: { propertyIds: unitId } },
        { session }
      );
    }

    if (ownSession) {
      await session.commitTransaction();
      session.endSession();
    }

    // Log activity after transaction commits
    await logActivity({
      userId: unit.landlord_id,
      action: 'DELETE',
      module: 'Unit',
      entityId: unit._id,
      entityName: unit.name,
      description: `Deleted unit "${unit.name}"`,
      meta: { address: unit.address }
    });

    notifyPropertyDeletedInAppInBackground({
      hoaId: unit.hoaId,
      propertyId: unitId,
      propertyName: unit.name || 'Property',
      ownerIds: unit.associatedOwnerIds || [],
    }, options.userId || options.deletedBy || null);

    return { message: 'Unit deleted successfully' };
  } catch (e) {
    if (ownSession && session) {
      try { await session.abortTransaction(); } catch (ignore) { }
      try { session.endSession(); } catch (ignore) { }
    }
    throw e;
  }
}

const ownershipRecordsShareEffectiveDay = (leftDate, rightDate) => {
  const leftKey = billingCalendarDateKey(leftDate);
  const rightKey = billingCalendarDateKey(rightDate);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
};

const ownershipRecordMatchesEffectiveStart = (record, ownerIdStr, effectiveDate) => (
  record?.ownerId?.toString() === ownerIdStr
  && record?.startDate
  && ownershipRecordsShareEffectiveDay(record.startDate, effectiveDate)
);

const ownershipRecordMatchesEffectiveEnd = (record, ownerIdStr, effectiveDate) => (
  record?.ownerId?.toString() === ownerIdStr
  && record?.endDate
  && ownershipRecordsShareEffectiveDay(record.endDate, effectiveDate)
);

const applyOwnershipLogRevertToRecords = (records = [], log = {}) => {
  const timeline = cloneOwnershipRecords(records);
  const action = String(log.action || '').toUpperCase();
  const effectiveDate = log.effectiveDate ? toDateAtStartOfDay(log.effectiveDate) : null;
  const ownerIds = normalizeObjectIdStrings(log.ownerIds || []);

  if (!effectiveDate) return timeline;

  if (action === 'REMOVE') {
    ownerIds.forEach((ownerId) => {
      const target = timeline.find((record) => ownershipRecordMatchesEffectiveEnd(record, ownerId, effectiveDate))
        || timeline.find((record) => record.ownerId?.toString() === ownerId && record.endDate);
      if (target) target.endDate = null;
    });
    return timeline;
  }

  if (action === 'ADD') {
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const record = timeline[index];
      const ownerIdStr = record.ownerId?.toString();
      if (ownerIds.includes(ownerIdStr) && ownershipRecordMatchesEffectiveStart(record, ownerIdStr, effectiveDate)) {
        timeline.splice(index, 1);
      }
    }
    return timeline;
  }

  if (action === 'CHANGE') {
    const previousOwnerIds = normalizeObjectIdStrings(log.details?.previousOwnerIds || []);
    const newOwnerIds = normalizeObjectIdStrings(log.details?.newOwnerIds || ownerIds);

    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const record = timeline[index];
      const ownerIdStr = record.ownerId?.toString();
      if (newOwnerIds.includes(ownerIdStr) && ownershipRecordMatchesEffectiveStart(record, ownerIdStr, effectiveDate)) {
        timeline.splice(index, 1);
      }
    }

    previousOwnerIds.forEach((ownerId) => {
      const target = timeline.find((record) => ownershipRecordMatchesEffectiveEnd(record, ownerId, effectiveDate));
      if (target) target.endDate = null;
    });
  }

  return timeline;
};

const getOwnershipRevertBlockReason = (unit, log) => {
  if (!unit || !log) return 'Ownership event not found';
  const action = String(log.action || '').toUpperCase();

  if (action === 'CHANGE') {
    if (String(log.details?.balanceHandling || '').toUpperCase() === 'RESET') {
      return 'Change-of-ownership events that reset balances cannot be reverted automatically.';
    }
    if (log.details?.balanceResetSettlement) {
      return 'This ownership change included a financial settlement and cannot be reverted automatically.';
    }
  }

  if (action === 'REMOVE') {
    const currentOwnerIds = getCurrentOwnerIdsFromUnit(unit, ClockService.now());
    if (currentOwnerIds.length === 0) {
      return 'Last-owner removal with financial settlement cannot be reverted automatically. Historical invoices and payments remain intact.';
    }
  }

  return null;
};

const buildOwnershipRevertDescription = ({
  revertedAction,
  ownerNames = [],
  unitLabel,
  effectiveDate,
  performedByName,
}) => {
  const owners = formatOwnerNamesList(ownerNames);
  const dateLabel = formatDateInAppTimezone(effectiveDate || ClockService.now(), {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const actionLabel = String(revertedAction || '').toUpperCase() === 'REMOVE'
    ? 'removal'
    : String(revertedAction || '').toUpperCase() === 'ADD'
      ? 'addition'
      : 'change';
  const byClause = performedByName ? ` by ${performedByName}` : '';
  return `The owner ${actionLabel} for ${owners} on ${unitLabel} effective ${dateLabel} was deleted/reverted${byClause}. Historical invoices and payments were not deleted.`;
};

async function recordOwnershipRevertActivity({
  unit,
  unitId,
  revertedLog,
  previousOwnerIds = [],
  newOwnerIds = [],
  performedBy,
  performedAt = ClockService.now(),
  session = null,
}) {
  const unitOid = toObjectId(unitId) || toObjectId(unit?._id);
  if (!unitOid || !revertedLog) return null;

  const prevIds = normalizeObjectIdStrings(previousOwnerIds);
  const nextIds = normalizeObjectIdStrings(newOwnerIds);
  const nameIds = [...new Set([...prevIds, ...nextIds, asIdString(performedBy)].filter(Boolean))];
  const users = nameIds.length
    ? await User.find({ _id: { $in: toObjectIds(nameIds) } }).select('firstName lastName email').lean()
    : [];
  const nameById = new Map(users.map((user) => [String(user._id), formatPersonDisplayName(user)]));

  const revertedOwnerNames = normalizeObjectIdStrings(revertedLog.ownerIds || [])
    .map((id) => nameById.get(id) || 'Unknown owner');
  const performedByName = performedBy
    ? (nameById.get(asIdString(performedBy)) || 'Unknown user')
    : '';
  const unitLabel = resolveUnitDisplayLabel(unit);
  const description = buildOwnershipRevertDescription({
    revertedAction: revertedLog.action,
    ownerNames: revertedOwnerNames,
    unitLabel,
    effectiveDate: revertedLog.effectiveDate,
    performedByName,
  });

  const ownershipHistoryEntry = {
    action: 'OWNER_EVENT_REVERTED',
    previousOwnerIds: toObjectIds(prevIds),
    newOwnerIds: toObjectIds(nextIds),
    previousOwnerNames: prevIds.map((id) => nameById.get(id) || 'Unknown owner'),
    newOwnerNames: nextIds.map((id) => nameById.get(id) || 'Unknown owner'),
    propertyId: unitOid,
    unitId: unitOid,
    unitLabel,
    description,
    performedBy: toObjectId(performedBy) || undefined,
    performedAt: performedAt instanceof Date ? performedAt : ClockService.now(),
  };

  const updateOpts = session ? { session } : {};
  await Invoice.updateMany(
    { propertyId: unitOid, isDeleted: { $ne: true } },
    { $push: { ownershipHistory: ownershipHistoryEntry } },
    updateOpts,
  );

  if (performedBy) {
    await logActivity({
      userId: performedBy,
      action: 'OWNER_EVENT_REVERTED',
      module: 'Unit',
      entityId: unitOid,
      entityName: unitLabel,
      description,
      meta: {
        revertedAction: revertedLog.action,
        revertedLogId: revertedLog._id ? String(revertedLog._id) : undefined,
        previousOwnerIds: prevIds,
        newOwnerIds: nextIds,
        performedBy: asIdString(performedBy),
        performedAt: ownershipHistoryEntry.performedAt,
      },
    });
  }

  return ownershipHistoryEntry;
}

const syncInvoiceTenantsForRevertAdd = async ({ unitId, ownerId, effectiveDate, session }) => {
  const query = {
    propertyId: unitId,
    isDeleted: { $ne: true },
    status: { $in: CO_OWNER_REMOVE_INVOICE_REASSIGN_STATUSES },
    tenants: ownerId,
  };
  if (effectiveDate && isFutureCalendarEffectiveDate(effectiveDate)) {
    query.dueDate = { $gte: effectiveDate };
  }
  await Invoice.updateMany(
    query,
    { $pull: { tenants: ownerId } },
    { session },
  );
};

async function getOwnershipEventRevertPreview(unitId, ownershipLogId) {
  const unit = await Property.findById(unitId).lean();
  if (!unit) {
    const err = new Error('Unit not found');
    err.status = 404;
    throw err;
  }

  const targetLog = (unit.ownershipLogs || []).find(
    (log) => String(log._id) === String(ownershipLogId),
  );
  if (!targetLog) {
    const err = new Error('Ownership event not found');
    err.status = 404;
    throw err;
  }

  const blockReason = getOwnershipRevertBlockReason(unit, targetLog);
  const timeline = ensureOwnershipTimeline(unit, unit.createdAt);
  const revertedRecords = applyOwnershipLogRevertToRecords(timeline, targetLog);
  const now = ClockService.now();
  const previousOwnerIds = getCurrentOwnerIdsFromUnit(unit, now);
  const resultingOwnerIds = getActiveOwnerIdsFromRecords(revertedRecords, now);

  return {
    ownershipLogId: String(targetLog._id),
    action: targetLog.action,
    effectiveDate: targetLog.effectiveDate,
    ownerIds: normalizeObjectIdStrings(targetLog.ownerIds || []),
    canRevert: !blockReason,
    blockReason,
    currentOwnerIds: previousOwnerIds,
    resultingOwnerIds,
    preservesFinancialHistory: true,
  };
}

async function revertOwnershipEvent(unitId, ownershipLogId, performedBy, options = {}) {
  await ledgerService.applyAllUnappliedCreditToDueInvoices(unitId);

  return runWithTransactionRetry(async () => {
    let ownSession = false;
    let session = options.session;
    if (!session) {
      session = await mongoose.startSession();
      session.startTransaction();
      ownSession = true;
    }

    try {
      const unit = await Property.findById(unitId).session(session);
      if (!unit) {
        const err = new Error('Unit not found');
        err.status = 404;
        throw err;
      }

      const logs = unit.ownershipLogs || [];
      const targetLog = logs.find((log) => String(log._id) === String(ownershipLogId));
      if (!targetLog) {
        const err = new Error('Ownership event not found');
        err.status = 404;
        throw err;
      }

      const blockReason = getOwnershipRevertBlockReason(unit, targetLog);
      if (blockReason) {
        const err = new Error(blockReason);
        err.status = 409;
        throw err;
      }

      const previousOwnerIds = normalizeObjectIdStrings(unit.associatedOwnerIds || []);
      const effectiveDate = toDateAtStartOfDay(targetLog.effectiveDate);
      const action = String(targetLog.action || '').toUpperCase();
      const ownerIds = normalizeObjectIdStrings(targetLog.ownerIds || []);
      const timeline = ensureOwnershipTimeline(unit, unit.createdAt);
      const ownershipRecords = applyOwnershipLogRevertToRecords(timeline, targetLog);
      const resultingOwnerIds = getActiveOwnerIdsFromRecords(ownershipRecords, ClockService.now());

      await Property.findByIdAndUpdate(unitId, {
        $set: {
          associatedOwnerIds: resultingOwnerIds,
          ownershipRecords,
        },
        $pull: {
          ownershipLogs: { _id: targetLog._id },
        },
      }, { session });

      if (action === 'REMOVE') {
        for (const ownerId of ownerIds) {
          await syncInvoiceTenantsForAddOwner({
            unitId,
            ownerId,
            effectiveDate,
            financialHandling: 'FRESH',
            session,
          });
        }
      } else if (action === 'ADD') {
        for (const ownerId of ownerIds) {
          await syncInvoiceTenantsForRevertAdd({
            unitId,
            ownerId,
            effectiveDate,
            session,
          });
        }
      } else if (action === 'CHANGE') {
        const restoredOwnerIds = normalizeObjectIdStrings(targetLog.details?.previousOwnerIds || []);
        if (restoredOwnerIds.length > 0) {
          await syncInvoiceTenantsForChangeOwnership({
            unitId,
            ownerIds: restoredOwnerIds,
            session,
            effectiveDate,
          });
        }
      }

      await syncOwnerPropertyMembership(unitId, previousOwnerIds, resultingOwnerIds, session);

      if (ownSession) {
        await session.commitTransaction();
        session.endSession();
      }

      try {
        await recordOwnershipRevertActivity({
          unit,
          unitId,
          revertedLog: targetLog,
          previousOwnerIds,
          newOwnerIds: resultingOwnerIds,
          performedBy,
          performedAt: ClockService.now(),
          session: ownSession ? null : session,
        });
      } catch (activityErr) {
        logger.warn('[revertOwnershipEvent] Failed to record revert activity:', activityErr.message);
      }

      return {
        unitId: String(unitId),
        ownershipLogId: String(ownershipLogId),
        action,
        previousOwnerIds,
        resultingOwnerIds,
        revertedAt: ClockService.now(),
      };
    } catch (error) {
      if (ownSession && session) {
        try { await session.abortTransaction(); } catch (ignore) { }
        try { session.endSession(); } catch (ignore) { }
      }
      throw error;
    }
  });
}

module.exports = {
  createUnit,
  createUnitWithImages,
  getUnitById,
  updateUnit,
  updateUnitWithImages,
  addOwner,
  removeOwner,
  changeOwnership,
  revertOwnershipEvent,
  getOwnershipEventRevertPreview,
  deleteUnit,
  ensureInvoicesWhenOwnerLinkedToUnits,
  ensureInvoicesWhenOwnerVerified,
  linkOwnerToUnitsFromOwnerFlow,
  // Exported for unit tests / ownership timeline helpers
  getActiveOwnerIdsFromRecords,
  ownershipActivityAtAfterEffectiveDate,
  ownershipActivityAtForCurrentAssociation,
  getCurrentOwnerIdsFromUnit,
  findOwnershipRecordForRemoval,
  resolveRemainingOwnerIdsAfterRemoval,
  ownershipRecordOverlapsEffectiveDate,
  toDateAtStartOfDay,
  syncAssociatedInvoiceLabels,
  syncInvoiceTenantsForRemoveOwner,
  CO_OWNER_REMOVE_INVOICE_REASSIGN_STATUSES,
  assertOwnershipEffectiveDateNotInPast,
  assertOwnershipEffectiveDateWithinBalanceWindow,
  resolveOwnershipEffectiveDateForOwner,
  resolveBalanceAsOfDateKey,
  resolveOwnershipPeriodForOwner,
  isFutureCalendarEffectiveDate,
  applyOwnershipLogRevertToRecords,
  getOwnershipRevertBlockReason,
  syncInvoiceTenantsForAddOwner,
  syncInvoiceTenantsForChangeOwnership,
  activateScheduledOwnershipTransfer,
  activateScheduledOwnershipRemoval,
  processDueOwnershipTransfers,
  removalEndInstantForEffectiveDate,
};
