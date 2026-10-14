/**
 * ------------------------------------------------------------------
 * File: unitLateFee.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * invoice.service, hoaLateFeeScheduler.service, ledger.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Invoice = require('../../invoice/model/invoice.model');
const Property = require('../../property/model/property.model');
const HOASettings = require('../../hoa-settings/model/hoaSettings.model');
const logger = require('../../../../../common/logger');
const { INVOICE_STATUS, INVOICE_TYPES, HOA_UNIT_SCHEDULE_INVOICE_TYPES } = require('../../../../../common/constants/invoice');
const { ClockService, DateUtil } = require('../../../../../common/date');
const {
  getCalendarDaysLateInTimezone,
  resolvePropertyBillingTimezone,
} = require('../../../../../common/helpers/billingCalendar');
const {
  compareCalendarDateToToday,
} = require('../../../../../common/helpers/hoaBillingDates');
const { notifyLateFeeAppliedInBackground } = require('../../../../../common/helpers/invoiceNotificationEmailHelper');
const { upsertLateFeeLineItem, isLateFeeLineItem } = require('../../invoice/helpers/lateFeeLineItems.helper');
const { isOpeningBalanceInvoice } = require('../../invoice/helpers/openingBalanceInvoice.helper');

const HOA_LATE_FEE_RULE_KEY = 'hoa-late-fee';

const roundCurrency = (value) => Number((Number(value) || 0).toFixed(2));

const toObjectId = (value) => {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
};

const normalizeString = (value) => String(value || '').trim().toLowerCase();

const getDaysLate = (dueDate, today = ClockService.now(), timeZone) =>
  getCalendarDaysLateInTimezone(dueDate, today, timeZone);

const matchesApplicableUnits = (lateFee, invoice, property) => {
  const scope = normalizeString(lateFee?.applicableScope);
  if (scope === 'none') return false;
  if (scope === 'all') return true;

  const applicableUnits = Array.isArray(lateFee?.applicableUnits) ? lateFee.applicableUnits : [];
  if (applicableUnits.length === 0) return false;

  const normalizedApplicable = new Set(applicableUnits.map(normalizeString).filter(Boolean));
  if (
    normalizedApplicable.has('all') ||
    normalizedApplicable.has('all units') ||
    normalizedApplicable.has('all properties') ||
    normalizedApplicable.has('*')
  ) {
    return true;
  }

  const propertyName = normalizeString(property?.name);
  const unitName = normalizeString(invoice?.unit || property?.unitDetails?.[0]?.unitName);
  const compositeLabel =
    propertyName && unitName ? `${propertyName} - ${unitName}` : '';

  const candidates = [
    invoice?.unit,
    property?.unitDetails?.[0]?.unitName,
    property?.name,
    compositeLabel,
    property?._id && unitName ? `${property._id}::${unitName}` : '',
    property?.id && unitName ? `${property.id}::${unitName}` : '',
  ]
    .map(normalizeString)
    .filter(Boolean);

  if (candidates.some((candidate) => normalizedApplicable.has(candidate))) {
    return true;
  }

  for (const entry of normalizedApplicable) {
    if (entry.includes(' - ') && unitName && entry.endsWith(` - ${unitName}`)) {
      return true;
    }
    if (entry.includes('::')) {
      const [, storedUnit] = entry.split('::');
      if (normalizeString(storedUnit) === unitName) return true;
    }
  }

  return false;
};

const matchesApplyTo = (lateFee, invoice) => {
  const applyTo = normalizeString(lateFee?.applyTo || 'all-invoices');
  if (!applyTo || applyTo === 'all-invoices') return true;

  if (applyTo === 'rent-only' || applyTo === 'rental-invoices') {
    return HOA_UNIT_SCHEDULE_INVOICE_TYPES.includes(String(invoice?.type || ''));
  }

  return true;
};

/**
 * Legacy / HOA multi-rule late fees.
 * First eligible calendar day is dueDate + gracePeriod + 1 (matches UI + getFirstLateFeeEligibleYmd).
 * Future invoices and due-today with grace=0 both have daysLate=0 → not eligible.
 */
const getMaxSequenceForRule = (lateFee, invoice, today = ClockService.now(), timeZone) => {
  const daysLate = getDaysLate(invoice?.dueDate, today, timeZone);
  const gracePeriod = Math.max(0, Number(lateFee?.gracePeriod) || 0);
  // Critical: never apply before the due date has passed (and grace has ended).
  if (daysLate <= gracePeriod) return 0;

  if (!lateFee?.isRepeat) return 1;

  const repeatEvery = Math.max(1, Number(lateFee?.repeatEvery) || 1);
  // daysLate === gracePeriod + 1 → first eligible day → sequence 1
  const daysSinceFirstEligible = daysLate - gracePeriod - 1;
  const generatedCount = 1 + Math.floor(Math.max(0, daysSinceFirstEligible) / repeatEvery);

  const rawEnd = lateFee?.repeatEndAfter;
  if (rawEnd == null || rawEnd === '' || String(rawEnd).toLowerCase() === 'never') {
    return generatedCount;
  }
  const repeatEndAfter = Number(rawEnd);
  if (!Number.isFinite(repeatEndAfter) || repeatEndAfter <= 0) {
    return generatedCount;
  }
  return Math.min(generatedCount, Math.floor(repeatEndAfter));
};

/** HOA Settings late fees: grace ends at end of due date + gracePeriodDays. */
const getHoaMaxLateFeeSequence = (gracePeriodDays, lateFeeConfig, invoice, today = ClockService.now(), timeZone) => {
  const daysLate = getDaysLate(invoice?.dueDate, today, timeZone);
  const grace = Math.max(0, Number(gracePeriodDays) || 0);
  if (daysLate <= grace) return 0;

  const eligibleDays = daysLate - grace;
  if (eligibleDays <= 0) return 0;

  if (!lateFeeConfig?.dailyEnabled) {
    return 1;
  }

  return eligibleDays;
};

const getTotalLateFeesFromHistory = (invoice, ruleKey = null) => {
  const rows = Array.isArray(invoice?.lateFeeHistory) ? invoice.lateFeeHistory : [];
  return roundCurrency(
    rows
      .filter((row) => !ruleKey || row.lateFeeRuleKey === ruleKey)
      .reduce((sum, row) => sum + (Number(row.amount) || 0), 0)
  );
};

const resolvePrincipalSubAmount = (invoice) => {
  if (invoice?.principalSubAmount != null) {
    return roundCurrency(Number(invoice.principalSubAmount));
  }
  const historyTotal = getTotalLateFeesFromHistory(invoice);
  return roundCurrency(Math.max(0, (Number(invoice?.subAmount) || 0) - historyTotal));
};

const getPrincipalOutstanding = (invoice) => {
  const principal = resolvePrincipalSubAmount(invoice);
  const paid = Number(invoice?.alreadyPaid) || 0;
  return roundCurrency(Math.max(0, principal - paid));
};

const hasLateFeeApplied = (invoice, ruleKey, sequence) =>
  (invoice?.lateFeeHistory || []).some(
    (row) => row.lateFeeRuleKey === ruleKey && Number(row.lateFeeSequence) === Number(sequence)
  );

const calculateLateFeeAmount = (lateFee, invoice) => {
  const feeType = normalizeString(lateFee?.lateFeeType);
  const baseAmount = Number(lateFee?.feeAmount) || 0;
  const invoiceTotal = resolvePrincipalSubAmount(invoice);
  const outstanding = getPrincipalOutstanding(invoice);

  if (baseAmount <= 0) return 0;

  let amount = 0;
  if (feeType === 'flat-fee') {
    amount = baseAmount;
  } else if (feeType === 'percentage-outstanding') {
    amount = (outstanding * baseAmount) / 100;
  } else {
    amount = (invoiceTotal * baseAmount) / 100;
  }

  const tenantCount = Array.isArray(invoice?.tenants) && invoice.tenants.length > 0 ? invoice.tenants.length : 1;
  const multiplier = lateFee?.chargeEachUnpaidTenat ? tenantCount : 1;
  return roundCurrency(amount * multiplier);
};

const calculateHoaLateFeeAmount = (lateFeeConfig, invoice, sequence) => {
  const outstanding = getPrincipalOutstanding(invoice);
  if (outstanding <= 0) return 0;

  if (sequence === 1) {
    if (normalizeString(lateFeeConfig?.initialType) === 'percentage') {
      const pct = Number(lateFeeConfig?.initialPercentage) || 0;
      if (pct <= 0) return 0;
      return roundCurrency((outstanding * pct) / 100);
    }
    const flat = Number(lateFeeConfig?.initialAmount) || 0;
    return flat > 0 ? roundCurrency(flat) : 0;
  }

  if (!lateFeeConfig?.dailyEnabled) return 0;

  if (normalizeString(lateFeeConfig?.dailyType) === 'percentage') {
    const pct = Number(lateFeeConfig?.dailyPercentage) || 0;
    if (pct <= 0) return 0;
    return roundCurrency((outstanding * pct) / 100);
  }

  const dailyFlat = Number(lateFeeConfig?.dailyAmount) || 0;
  return dailyFlat > 0 ? roundCurrency(dailyFlat) : 0;
};

const buildLateFeeRuleKey = (lateFee, index) => {
  if (lateFee?._id) return `rule-${lateFee._id}`;
  return `rule-${index + 1}`;
};

const buildLateFeeInvoiceId = (sourceInvoiceId, ruleKey, sequence) =>
  `LATE-${String(sourceInvoiceId)}-${ruleKey}-${sequence}`;

const buildLateFeeTerm = (sourceInvoice, sequence, isHoaDaily = false) => {
  if (sequence === 1) {
    return `Initial Late Fee - ${sourceInvoice?.term || 'Invoice'}`;
  }
  if (isHoaDaily) {
    return `Daily Late Fee - ${sourceInvoice?.term || 'Invoice'}`;
  }
  const suffix = sequence > 1 ? ` #${sequence}` : '';
  return `Late Fee${suffix} - ${sourceInvoice?.term || 'Invoice'}`;
};

const buildLegacyLateFeeDescription = (lateFee, sourceInvoice, sequence, amount) => {
  const gracePeriod = Math.max(0, Number(lateFee?.gracePeriod) || 0);
  const sourceTerm = sourceInvoice?.term || 'invoice';
  const appliedAfter = gracePeriod === 0 ? 'immediately after due date' : `${gracePeriod} day${gracePeriod === 1 ? '' : 's'} overdue`;
  return `Late fee for ${sourceTerm}, applied ${appliedAfter}. Charge amount: $${amount.toFixed(2)}.`;
};

const buildHoaLateFeeDescription = (lateFeeConfig, sourceInvoice, sequence, amount) => {
  const sourceTerm = sourceInvoice?.term || 'invoice';
  if (sequence === 1) {
    if (normalizeString(lateFeeConfig?.initialType) === 'percentage') {
      const pct = Number(lateFeeConfig?.initialPercentage) || 0;
      return `Initial late fee (${pct}%) for ${sourceTerm}. Charge amount: $${amount.toFixed(2)}.`;
    }
    return `Initial late fee for ${sourceTerm}. Charge amount: $${amount.toFixed(2)}.`;
  }
  return `Daily late fee for ${sourceTerm}. Charge amount: $${amount.toFixed(2)}.`;
};

const buildHoaLateFeeLineItemLabel = (lateFeeConfig, sequence) => {
  if (sequence === 1) {
    if (normalizeString(lateFeeConfig?.initialType) === 'percentage') {
      const pct = Number(lateFeeConfig?.initialPercentage) || 0;
      return `Initial Late Fee (${pct}%)`;
    }
    return 'Initial Late Fee';
  }
  return 'Daily Late Fee';
};

const buildHoaLateFeeActivityText = (lateFeeConfig, sequence, amount) => {
  const formatted = `$${amount.toFixed(2)}`;
  if (sequence === 1) {
    if (normalizeString(lateFeeConfig?.initialType) === 'percentage') {
      const pct = Number(lateFeeConfig?.initialPercentage) || 0;
      return `Late Fee Applied (+${formatted}) - Initial Late Fee (${pct}%)`;
    }
    return `Late Fee Applied (+${formatted}) - Initial Late Fee`;
  }
  return `Daily Late Fee Applied (+${formatted})`;
};

const getTotalAppliedLateFees = async (sourceInvoiceId, ruleKey) => {
  const invoice = await Invoice.findById(sourceInvoiceId).select('lateFeeHistory principalSubAmount subAmount').lean();
  if (!invoice) return 0;
  return getTotalLateFeesFromHistory(invoice, ruleKey);
};

const resolveLateFeeActorId = (invoice) => {
  if (invoice?.createdBy && mongoose.Types.ObjectId.isValid(String(invoice.createdBy))) {
    return invoice.createdBy;
  }
  if (
    Array.isArray(invoice?.tenants)
    && invoice.tenants[0]
    && mongoose.Types.ObjectId.isValid(String(invoice.tenants[0]))
  ) {
    return invoice.tenants[0];
  }
  return null;
};

const buildLateFeeCalculationMethod = (lateFeeConfig, sequence, isHoa) => {
  if (!isHoa || !lateFeeConfig) return 'legacy-rule';
  if (sequence === 1) {
    return normalizeString(lateFeeConfig.initialType) === 'percentage'
      ? `initial-percentage-${Number(lateFeeConfig.initialPercentage) || 0}`
      : 'initial-flat';
  }
  if (!lateFeeConfig.dailyEnabled) return 'daily-disabled';
  return normalizeString(lateFeeConfig.dailyType) === 'percentage'
    ? `daily-percentage-${Number(lateFeeConfig.dailyPercentage) || 0}`
    : 'daily-flat';
};

const applyLateFeeToInvoiceDocument = ({
  invoice,
  lateFeeRuleKey,
  sequence,
  feeAmount,
  description,
  lineItemLabel,
  lateFeeConfig,
  isHoa = false,
  calculationMethod,
  propertyTimezone,
}) => {
  if (!invoice || invoice.isDeleted) return null;
  if (hasLateFeeApplied(invoice, lateFeeRuleKey, sequence)) return null;

  const amount = roundCurrency(feeAmount);
  if (amount <= 0) return null;

  if (invoice.principalSubAmount == null) {
    invoice.principalSubAmount = resolvePrincipalSubAmount(invoice);
  }

  const now = ClockService.now();
  const actorId = resolveLateFeeActorId(invoice);
  const activityText = isHoa && lateFeeConfig
    ? buildHoaLateFeeActivityText(lateFeeConfig, sequence, amount)
    : `Late Fee Applied (+$${amount.toFixed(2)})`;

  invoice.lateFeeHistory = invoice.lateFeeHistory || [];
  invoice.lateFeeHistory.push({
    lateFeeRuleKey,
    lateFeeSequence: sequence,
    amount,
    lineItemLabel,
    description,
    calculationMethod: calculationMethod || buildLateFeeCalculationMethod(lateFeeConfig, sequence, isHoa),
    appliedAt: now,
    appliedBy: actorId || undefined,
    source: 'system',
  });

  invoice.invoiceItemDetails = upsertLateFeeLineItem(invoice.invoiceItemDetails, {
    lineItemLabel,
    description,
    amount,
  });

  invoice.subAmount = roundCurrency((Number(invoice.subAmount) || 0) + amount);
  invoice.balanceDue = roundCurrency((Number(invoice.balanceDue) || 0) + amount);

  if (getPrincipalOutstanding(invoice) > 0 && invoice.status === INVOICE_STATUS.PAID) {
    invoice.status = INVOICE_STATUS.PARTIALLY_PAID;
  } else if (
    getPrincipalOutstanding(invoice) > 0
    && [INVOICE_STATUS.PENDING, INVOICE_STATUS.OVERDUE, INVOICE_STATUS.PARTIALLY_PAID].includes(String(invoice.status))
    && Number(invoice.balanceDue) > 0
  ) {
    if (invoice.dueDate && compareCalendarDateToToday(invoice.dueDate, ClockService.now(), propertyTimezone) < 0) {
      invoice.status = INVOICE_STATUS.OVERDUE;
    }
  }

  if (actorId) {
    invoice.comments = invoice.comments || [];
    invoice.comments.push({
      text: activityText,
      isSystem: true,
      createdBy: actorId,
      updatedBy: actorId,
      createdAt: now,
      updatedAt: now,
    });
  }

  return {
    invoiceId: invoice._id,
    amount,
    lateFeeRuleKey,
    lateFeeSequence: sequence,
    appliedAt: now,
  };
};

const applyLateFeeToSourceInvoice = async ({
  sourceInvoiceId,
  lateFeeRuleKey,
  sequence,
  feeAmount,
  description,
  lineItemLabel,
  lateFeeConfig,
  isHoa = false,
  calculationMethod,
  propertyTimezone,
}) => {
  const invoice = await Invoice.findById(sourceInvoiceId);
  if (!invoice || invoice.isDeleted) return null;

  const applied = applyLateFeeToInvoiceDocument({
    invoice,
    lateFeeRuleKey,
    sequence,
    feeAmount,
    description,
    lineItemLabel,
    lateFeeConfig,
    isHoa,
    calculationMethod,
    propertyTimezone,
  });
  if (!applied) return null;

  try {
    const saved = await invoice.save();
    notifyLateFeeAppliedInBackground({
      invoiceId: saved._id,
      amount: applied.amount,
      lateFeeSequence: sequence,
    });
    return applied;
  } catch (error) {
    if (error?.code === 11000) return null;
    throw error;
  }
};

const softDeleteLegacyLateFeeInvoice = async (invoiceId) => {
  const safeId = toObjectId(invoiceId);
  if (!safeId) return;
  await Invoice.updateOne(
    { _id: safeId },
    { $set: { isDeleted: true, deletedAt: ClockService.now() } }
  );
};

const migrateLegacyLateFeeInvoicesForUnit = async (unitId) => {
  const safeUnitId = toObjectId(unitId);
  if (!safeUnitId) return [];
  const childInvoices = await Invoice.find({
    propertyId: safeUnitId,
    generatedFrom: 'late_fee',
    isDeleted: { $ne: true },
    sourceInvoiceId: { $exists: true, $ne: null },
  })
    .sort({ lateFeeSequence: 1, createdAt: 1 })
    .lean();

  const migrated = [];
  for (const child of childInvoices) {
    const source = await Invoice.findById(child.sourceInvoiceId);
    if (!source || source.isDeleted) {
      await softDeleteLegacyLateFeeInvoice(child._id);
      continue;
    }

    const ruleKey = child.lateFeeRuleKey || HOA_LATE_FEE_RULE_KEY;
    const sequence = Number(child.lateFeeSequence) || 1;
    if (hasLateFeeApplied(source, ruleKey, sequence)) {
      await softDeleteLegacyLateFeeInvoice(child._id);
      continue;
    }

    const item = Array.isArray(child.invoiceItemDetails) ? child.invoiceItemDetails[0] : null;
    const applied = await applyLateFeeToSourceInvoice({
      sourceInvoiceId: source._id,
      lateFeeRuleKey: ruleKey,
      sequence,
      feeAmount: Number(child.subAmount) || 0,
      description: item?.description || `Migrated late fee #${sequence}`,
      lineItemLabel: item?.invoiceItem || (sequence === 1 ? 'Initial Late Fee' : 'Daily Late Fee'),
      isHoa: ruleKey === HOA_LATE_FEE_RULE_KEY,
      calculationMethod: 'migrated-child-invoice',
    });

    await softDeleteLegacyLateFeeInvoice(child._id);
    if (applied) migrated.push(applied);
  }

  return migrated;
};

const ensureHoaLateFeesForInvoice = async ({
  unitId,
  property,
  invoice,
  lateFeeConfig,
  gracePeriodDays,
  today,
  propertyTimezone,
}) => {
  const lateFeeRuleKey = HOA_LATE_FEE_RULE_KEY;
  const maxCap = lateFeeConfig?.maxAmount != null ? Number(lateFeeConfig.maxAmount) : null;
  const appliedFees = [];
  const pendingNotifications = [];

  const current = await Invoice.findById(invoice._id);
  if (!current) return appliedFees;

  for (let sequence = 1; sequence <= 365; sequence += 1) {
    const maxSequence = getHoaMaxLateFeeSequence(gracePeriodDays, lateFeeConfig, current, today, propertyTimezone);
    if (sequence > maxSequence) break;
    if (hasLateFeeApplied(current, lateFeeRuleKey, sequence)) continue;

    let feeAmount = calculateHoaLateFeeAmount(lateFeeConfig, current, sequence);
    if (feeAmount <= 0) continue;

    const totalApplied = getTotalLateFeesFromHistory(current, lateFeeRuleKey);
    if (maxCap != null && maxCap > 0) {
      const remainingCap = roundCurrency(maxCap - totalApplied);
      if (remainingCap <= 0) break;
      feeAmount = Math.min(feeAmount, remainingCap);
    }

    const applied = applyLateFeeToInvoiceDocument({
      invoice: current,
      lateFeeRuleKey,
      sequence,
      feeAmount,
      description: buildHoaLateFeeDescription(lateFeeConfig, current, sequence, feeAmount),
      lineItemLabel: buildHoaLateFeeLineItemLabel(lateFeeConfig, sequence),
      lateFeeConfig,
      isHoa: true,
      propertyTimezone,
    });

    if (applied) {
      appliedFees.push(applied);
      pendingNotifications.push({
        invoiceId: current._id,
        amount: applied.amount,
        lateFeeSequence: sequence,
      });
    }
  }

  if (appliedFees.length > 0) {
    try {
      await current.save();
      pendingNotifications.forEach((notification) => {
        notifyLateFeeAppliedInBackground(notification);
      });
    } catch (error) {
      if (error?.code === 11000) return [];
      throw error;
    }
  }

  return appliedFees;
};

const ensureLegacyLateFeesForInvoice = async ({
  unitId,
  property,
  invoice,
  lateFees,
  today,
  propertyTimezone,
}) => {
  const appliedFees = [];
  const pendingNotifications = [];

  const current = await Invoice.findById(invoice._id);
  if (!current) return appliedFees;

  for (let index = 0; index < lateFees.length; index += 1) {
    const lateFee = lateFees[index];
    if (normalizeString(lateFee?.applicableScope) === 'none') continue;

    const lateFeeRuleKey = buildLateFeeRuleKey(lateFee, index);

    for (let sequence = 1; sequence <= 365; sequence += 1) {
      if (!matchesApplicableUnits(lateFee, current, property)) break;
      if (!matchesApplyTo(lateFee, current)) break;

      const maxSequence = getMaxSequenceForRule(lateFee, current, today, propertyTimezone);
      if (sequence > maxSequence) break;
      if (hasLateFeeApplied(current, lateFeeRuleKey, sequence)) continue;

      const feeAmount = calculateLateFeeAmount(lateFee, current);
      if (feeAmount <= 0) continue;

      const applied = applyLateFeeToInvoiceDocument({
        invoice: current,
        lateFeeRuleKey,
        sequence,
        feeAmount,
        description: buildLegacyLateFeeDescription(lateFee, current, sequence, feeAmount),
        lineItemLabel: 'Late Fee',
        isHoa: false,
        calculationMethod: normalizeString(lateFee?.lateFeeType) || 'legacy-rule',
        propertyTimezone,
      });
      if (applied) {
        appliedFees.push(applied);
        pendingNotifications.push({
          invoiceId: current._id,
          amount: applied.amount,
          lateFeeSequence: sequence,
        });
      }
    }
  }

  if (appliedFees.length > 0) {
    try {
      await current.save();
      pendingNotifications.forEach((notification) => {
        notifyLateFeeAppliedInBackground(notification);
      });
    } catch (error) {
      if (error?.code === 11000) return [];
      throw error;
    }
  }

  return appliedFees;
};

const resolveHoaLateFeeSettings = async (hoaId) => {
  if (!hoaId) return null;
  const safeHoaId = toObjectId(hoaId);
  if (!safeHoaId) return null;
  const settings = await HOASettings.findOne({ hoaId: safeHoaId }).lean();
  if (!settings) return null;

  const gracePeriodDays = Math.max(0, Number(settings.paymentTerm?.gracePeriodDays) || 0);
  const acceptPartialPayments = settings.paymentTerm?.acceptPartialPayments !== false;

  if (Array.isArray(settings.lateFees) && settings.lateFees.length > 0) {
    return {
      lateFees: settings.lateFees,
      gracePeriodDays,
      acceptPartialPayments,
      useMultiRuleFormat: true,
    };
  }

  if (!settings?.lateFee?.enabled) return null;

  return {
    lateFee: settings.lateFee,
    gracePeriodDays,
    acceptPartialPayments,
  };
};

/**
 * Remove system-applied late fees from invoices that are not yet past due.
 * Guards against prior buggy runs that charged future invoices when gracePeriod was 0.
 */
const stripPrematureLateFeesFromFutureInvoice = async (invoiceRef, today, propertyTimezone) => {
  const invoiceId = invoiceRef?._id || invoiceRef;
  if (!invoiceId) return false;

  const invoice = await Invoice.findById(invoiceId);
  if (!invoice || invoice.isDeleted) return false;
  if (isOpeningBalanceInvoice(invoice)) return false;

  // Only strip when the due calendar day is still in the future (not due yet).
  if (compareCalendarDateToToday(invoice.dueDate, today, propertyTimezone) <= 0) {
    return false;
  }

  const history = Array.isArray(invoice.lateFeeHistory) ? invoice.lateFeeHistory : [];
  const items = Array.isArray(invoice.invoiceItemDetails) ? invoice.invoiceItemDetails : [];
  const hasLateFeeItems = items.some(isLateFeeLineItem);
  if (history.length === 0 && !hasLateFeeItems) return false;

  invoice.invoiceItemDetails = items.filter((item) => !isLateFeeLineItem(item));
  invoice.lateFeeHistory = [];

  const principal = roundCurrency(
    invoice.principalSubAmount != null
      ? Number(invoice.principalSubAmount)
      : resolvePrincipalSubAmount(invoice)
  );
  invoice.principalSubAmount = principal;
  invoice.subAmount = principal;
  invoice.balanceDue = roundCurrency(Math.max(0, principal - (Number(invoice.alreadyPaid) || 0)));

  if (Number(invoice.balanceDue) > 0 && invoice.status === INVOICE_STATUS.OVERDUE) {
    invoice.status = INVOICE_STATUS.PENDING;
  }

  const noteActorId =
    invoice.createdBy
    || (Array.isArray(invoice.tenants) && invoice.tenants.length > 0 ? invoice.tenants[0] : null);
  if (noteActorId) {
    const now = ClockService.now();
    invoice.comments = invoice.comments || [];
    invoice.comments.push({
      text: 'Automatic late fees removed: invoice due date has not been reached yet.',
      isSystem: true,
      createdBy: noteActorId,
      updatedBy: noteActorId,
      createdAt: now,
      updatedAt: now,
    });
  }

  await invoice.save();
  return true;
};

/**
 * Remove system-applied late fees from opening-balance invoices (legacy/migrated balances).
 * Opening balances must not accrue automatic late fees even if they were applied before this rule.
 */
const stripAutoLateFeesFromOpeningBalanceInvoice = async (invoiceRef) => {
  const invoiceId = invoiceRef?._id || invoiceRef;
  if (!invoiceId) return false;

  const invoice = await Invoice.findById(invoiceId);
  if (!invoice || invoice.isDeleted || !isOpeningBalanceInvoice(invoice)) return false;

  const history = Array.isArray(invoice.lateFeeHistory) ? invoice.lateFeeHistory : [];
  const items = Array.isArray(invoice.invoiceItemDetails) ? invoice.invoiceItemDetails : [];
  const hasLateFeeItems = items.some(isLateFeeLineItem);
  if (history.length === 0 && !hasLateFeeItems) return false;

  invoice.invoiceItemDetails = items.filter((item) => !isLateFeeLineItem(item));
  invoice.lateFeeHistory = [];

  const principal = roundCurrency(
    invoice.principalSubAmount != null
      ? Number(invoice.principalSubAmount)
      : resolvePrincipalSubAmount(invoice)
  );
  invoice.principalSubAmount = principal;
  invoice.subAmount = principal;
  invoice.balanceDue = roundCurrency(Math.max(0, principal - (Number(invoice.alreadyPaid) || 0)));

  if (!invoice.skipAutoLateFees) {
    invoice.skipAutoLateFees = true;
  }
  if (invoice.generatedFrom !== 'opening_balance') {
    invoice.generatedFrom = 'opening_balance';
  }

  const noteActorId =
    invoice.createdBy
    || (Array.isArray(invoice.tenants) && invoice.tenants.length > 0 ? invoice.tenants[0] : null);
  if (noteActorId) {
    const now = ClockService.now();
    invoice.comments = invoice.comments || [];
    invoice.comments.push({
      text: 'Automatic late fees removed: opening balance is a historical carried-forward amount, not a PropMv invoice.',
      isSystem: true,
      createdBy: noteActorId,
      updatedBy: noteActorId,
      createdAt: now,
      updatedAt: now,
    });
  }

  await invoice.save();
  return true;
};

const ensureLateFeeInvoicesForUnit = async (unitId, options = {}) => {
  if (!unitId || !mongoose.Types.ObjectId.isValid(String(unitId))) return [];
  const safeUnitId = new mongoose.Types.ObjectId(String(unitId));

  const today = options.today ? (DateUtil.toUTC(options.today) || ClockService.now()) : ClockService.now();
  const property = await Property.findOne({
    _id: safeUnitId,
    isDeleted: { $ne: true }
  })
    .select('name unitDetails propertySettings.lateFees hoaId billingTimezone billingTimezoneSource')
    .lean();

  if (!property) return [];

  const propertyTimezone = resolvePropertyBillingTimezone({
    billingTimezone: options.billingTimezone || property.billingTimezone,
  });

  const invoiceQuery = {
    propertyId: safeUnitId,
    isDeleted: { $ne: true },
    generatedFrom: { $ne: 'late_fee' },
    status: { $in: [INVOICE_STATUS.PENDING, INVOICE_STATUS.PARTIALLY_PAID, INVOICE_STATUS.OVERDUE] },
    balanceDue: { $gt: 0 },
  };
  if (options.onlyInvoiceId && mongoose.Types.ObjectId.isValid(String(options.onlyInvoiceId))) {
    invoiceQuery._id = new mongoose.Types.ObjectId(String(options.onlyInvoiceId));
  }

  const invoices = await Invoice.find(invoiceQuery)
    .select('_id invoiceId type status dueDate subAmount balanceDue term generatedFrom tenants unit createdBy skipAutoLateFees')
    .lean();

  if (invoices.length === 0) return [];

  for (const invoice of invoices) {
    if (!isOpeningBalanceInvoice(invoice)) continue;
    try {
      await stripAutoLateFeesFromOpeningBalanceInvoice(invoice._id);
    } catch (stripErr) {
      logger.warn('[late-fee] Opening balance late fee strip failed:', stripErr?.message || stripErr);
    }
  }

  const lateFeeEligibleInvoices = invoices.filter((invoice) => !isOpeningBalanceInvoice(invoice));
  if (lateFeeEligibleInvoices.length === 0) return [];

  const hoaLateFeeSettings = await resolveHoaLateFeeSettings(property.hoaId);
  const legacyLateFees = property?.propertySettings?.lateFees;
  const hasLegacyLateFees = Array.isArray(legacyLateFees) && legacyLateFees.length > 0;

  if (!hoaLateFeeSettings && !hasLegacyLateFees) return [];

  await migrateLegacyLateFeeInvoicesForUnit(unitId);

  const appliedFees = [];

  for (const invoice of lateFeeEligibleInvoices) {
    if (invoice.skipAutoLateFees && !options.forceApply) {
      continue;
    }

    // Hard rule: never evaluate late fees until the invoice due calendar day has passed.
    // Also remediate future invoices that were incorrectly charged by prior buggy runs.
    const daysLate = getDaysLate(invoice.dueDate, today, propertyTimezone);
    if (daysLate <= 0) {
      try {
        await stripPrematureLateFeesFromFutureInvoice(invoice._id, today, propertyTimezone);
      } catch (stripErr) {
        logger.warn('[late-fee] Premature late fee strip failed:', stripErr?.message || stripErr);
      }
      continue;
    }

    if (hoaLateFeeSettings?.useMultiRuleFormat) {
      const created = await ensureLegacyLateFeesForInvoice({
        unitId,
        property,
        invoice,
        lateFees: hoaLateFeeSettings.lateFees,
        today,
        propertyTimezone,
      });
      appliedFees.push(...created);
    } else if (hoaLateFeeSettings?.lateFee) {
      const created = await ensureHoaLateFeesForInvoice({
        unitId,
        property,
        invoice,
        lateFeeConfig: hoaLateFeeSettings.lateFee,
        gracePeriodDays: hoaLateFeeSettings.gracePeriodDays,
        today,
        propertyTimezone,
      });
      appliedFees.push(...created);
    }

    if (hasLegacyLateFees) {
      const created = await ensureLegacyLateFeesForInvoice({
        unitId,
        property,
        invoice,
        lateFees: legacyLateFees,
        today,
        propertyTimezone,
      });
      appliedFees.push(...created);
    }
  }

  return appliedFees;
};

module.exports = {
  ensureLateFeeInvoicesForUnit,
  migrateLegacyLateFeeInvoicesForUnit,
  stripAutoLateFeesFromOpeningBalanceInvoice,
  stripPrematureLateFeesFromFutureInvoice,
  calculateLateFeeAmount,
  calculateHoaLateFeeAmount,
  getMaxSequenceForRule,
  getHoaMaxLateFeeSequence,
  getDaysLate,
  getTotalAppliedLateFees,
  getPrincipalOutstanding,
  getTotalLateFeesFromHistory,
  HOA_LATE_FEE_RULE_KEY
};
