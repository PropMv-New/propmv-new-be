/**
 * ------------------------------------------------------------------
 * File: lateFeeInvoice.service.js
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
 * Late Fee Invoice Generation Service
 */

const Invoice = require('../model/invoice.model');
const Lease = require('../../leasing/model/lease.model');
const Property = require('../../property/model/property.model');
const User = require('../../../../../shared/modules/users/models/user.model');
const { INVOICE_TYPES } = require('../../../../../common/constants/invoice');
const { startOfDay, getDaysPastDue } = require('../../../../../common/helpers/landlordInvoiceStatus.helper');
const logger = require('../../../../../common/logger');
const { runInTransaction } = require('../../../../../common/helpers/transactionHelper');
const emailHelper = require('../../../../../common/helpers/emailHelper');
const { getDefaultFromName } = require('../../../../../common/helpers/communityEmailContext.service');
const { ClockService } = require('../../../../../common/date');
const { resolvePropertyBillingTimezone } = require('../../../../../common/helpers/billingCalendar');
const { formatEmailDate } = require('../../../../../common/helpers/hoaBillingDates');
const {
  LATE_FEE_INVOICE_TYPE,
  roundCurrency,
  resolveLateFeeRuleId,
  isUnitApplicable,
  isEligibleForLateFee,
  calculateExpectedLateFeeCount,
  generateLateFeeTitle,
  calculateLateFeeAmount,
  buildLateFeeDescription,
  buildLateFeeLineItems,
  resolveLateFeeTenants,
  computeLateFeeDueDate,
} = require('./lateFeeInvoice.helpers');

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

async function getExistingLateFeeInvoices(rentInvoiceId, lateFeeRuleId, session) {
  return Invoice.find({
    type: LATE_FEE_INVOICE_TYPE,
    'metadata.parentInvoiceId': rentInvoiceId,
    'metadata.lateFeeRuleId': lateFeeRuleId,
    isDeleted: { $ne: true },
  }).session(session || null);
}

async function sendLateFeeNotificationEmail(lateFeeInvoice, rentInvoice, property) {
  try {
    const tenantIds = lateFeeInvoice.tenants || [];
    if (!tenantIds.length) return;

    const tenants = await User.find({
      _id: { $in: tenantIds },
      isDeleted: { $ne: true },
      email: { $exists: true, $nin: [null, ''] },
    }).select('email firstName lastName').lean();

    if (!tenants.length) return;

    const now = ClockService.now();
    const daysOverdue = getDaysPastDue(rentInvoice.dueDate, now);
    const invoiceBase = process.env.INVOICE_BASE_URL || process.env.FRONTEND_BASE_URL || 'https://app.propmv.com';
    const viewInvoiceUrl = `${invoiceBase.replace(/\/$/, '')}/invoices/${lateFeeInvoice.invoiceId || lateFeeInvoice._id}`;

    for (const tenant of tenants) {
      const tenantName = `${tenant.firstName || ''} ${tenant.lastName || ''}`.trim() || 'Tenant';
      await emailHelper.sendEmail(
        'late-fee-notification',
        tenant.email,
        {
          tenantName,
          rentInvoiceNumber: rentInvoice.invoiceId || rentInvoice._id,
          rentDueDate: formatEmailDate(rentInvoice.dueDate),
          daysOverdue,
          rentBalance: `$${(rentInvoice.balanceDue || 0).toFixed(2)}`,
          lateFeeInvoiceNumber: lateFeeInvoice.invoiceId || lateFeeInvoice._id,
          propertyName: property.name || 'Your Property',
          unitNumber: lateFeeInvoice.unit || 'N/A',
          lateFeeAmount: `$${(lateFeeInvoice.subAmount || 0).toFixed(2)}`,
          gracePeriod: lateFeeInvoice.metadata?.gracePeriod || 0,
          lateFeeDueDate: formatEmailDate(lateFeeInvoice.dueDate),
          totalAmountDue: `$${((rentInvoice.balanceDue || 0) + (lateFeeInvoice.subAmount || 0)).toFixed(2)}`,
          viewInvoiceUrl,
        },
        {
          template: 'late-fee-invoice-notification',
          subject: `Late fee assessment - ${property.name || getDefaultFromName()}`,
          preheaderText: `Late fee of $${(lateFeeInvoice.subAmount || 0).toFixed(2)} assessed for overdue rent invoice.`,
        }
      ).catch((emailError) => {
        logger.error('[lateFeeInvoice.service] Failed to send late fee notification email', {
          error: emailError.message,
        });
      });
    }
  } catch (error) {
    logger.error('[lateFeeInvoice.service] Error in sendLateFeeNotificationEmail', { error: error.message });
  }
}

async function createLateFeeInvoiceDoc(
  rentInvoice,
  lateFee,
  lateFeeRuleId,
  count,
  lease,
  property,
  tenantNameById,
  session,
  propertyTimezone,
) {
  const title = generateLateFeeTitle(rentInvoice, count);
  const amount = calculateLateFeeAmount(rentInvoice, lateFee, lease);
  if (amount <= 0) throw new Error('Calculated late fee amount must be greater than zero');

  const description = buildLateFeeDescription(lateFee, amount);
  const lineItems = buildLateFeeLineItems(title, description, amount, lease, tenantNameById);
  const subAmount = roundCurrency(lineItems.reduce((sum, item) => sum + Number(item.amount || 0), 0));
  const now = ClockService.now();
  const gracePeriod = Number(lateFee.gracePeriod || 0);

  const invoiceData = {
    type: LATE_FEE_INVOICE_TYPE,
    lease_id: lease._id,
    propertyId: property._id,
    propertyName: property.name,
    unitId: rentInvoice.unitId,
    unit: rentInvoice.unit || lease.unitName,
    term: rentInvoice.term || lease.leaseTerm || 'N/A',
    tenants: resolveLateFeeTenants(rentInvoice, lease),
    invoiceItemDetails: lineItems,
    subAmount,
    alreadyPaid: 0,
    balanceDue: subAmount,
    isPartialPaymentAllowed: Boolean(lease.rentAndDepositDestribution?.isPartialPaymentAllowed),
    dueDate: computeLateFeeDueDate(rentInvoice, lateFee, count, propertyTimezone),
    comments: [{
      text: `Late fee generated for overdue rent invoice ${rentInvoice.invoiceId}. Grace period: ${gracePeriod} days.`,
      createdBy: rentInvoice.createdBy,
      createdAt: now,
    }],
    metadata: {
      parentInvoiceId: rentInvoice._id,
      parentInvoiceNumber: rentInvoice.invoiceId,
      lateFeeRuleId,
      lateFeeOccurrence: count,
      lateFeeType: lateFee.lateFeeType,
      gracePeriod,
      isRecurring: Boolean(lateFee.isRepeat),
      generatedAt: now,
    },
    createdBy: rentInvoice.createdBy,
  };

  const lateFeeInvoice = new Invoice(invoiceData);
  await lateFeeInvoice.validate();
  const saved = await lateFeeInvoice.save({ session });

  setImmediate(() => {
    sendLateFeeNotificationEmail(saved, rentInvoice, property).catch(() => undefined);
  });

  return saved;
}

async function processLateFeeForInvoice(rentInvoice, session) {
  try {
    const lease = await Lease.findOne({ _id: rentInvoice.lease_id, isDeleted: { $ne: true } }).session(session || null);
    if (!lease) return { success: false, error: 'Lease not found' };

    const property = await Property.findOne({ _id: lease.property_id, isDeleted: { $ne: true } }).session(session || null);
    if (!property) return { success: false, error: 'Property not found' };

    const propertyTimezone = resolvePropertyBillingTimezone(property);
    const lateFees = property.propertySettings?.lateFees || [];
    if (!lateFees.length) return { success: true, message: 'No late fees configured', generated: 0 };

    const unitName = rentInvoice.unit || lease.unitName;
    const tenantNameById = await loadTenantNameMap(lease, session);
    const results = [];

    for (let ruleIndex = 0; ruleIndex < lateFees.length; ruleIndex += 1) {
      const lateFee = lateFees[ruleIndex];
      const lateFeeRuleId = resolveLateFeeRuleId(lateFee, ruleIndex);

      if (!isEligibleForLateFee(rentInvoice, lateFee.gracePeriod || 0, ClockService.now(), propertyTimezone)) continue;
      if (!isUnitApplicable(lateFee, unitName)) continue;

      const expectedCount = calculateExpectedLateFeeCount(rentInvoice, lateFee, ClockService.now(), propertyTimezone);
      if (expectedCount <= 0) continue;

      const existingLateFees = await getExistingLateFeeInvoices(rentInvoice._id, lateFeeRuleId, session);
      const toGenerate = expectedCount - existingLateFees.length;
      if (toGenerate <= 0) continue;

      for (let i = 1; i <= toGenerate; i += 1) {
        const count = existingLateFees.length + i;
        try {
          const lateFeeInvoice = await createLateFeeInvoiceDoc(
            rentInvoice,
            lateFee,
            lateFeeRuleId,
            count,
            lease,
            property,
            tenantNameById,
            session,
            propertyTimezone,
          );
          results.push({ success: true, lateFeeInvoiceId: lateFeeInvoice._id, count, lateFeeRuleId });
        } catch (error) {
          results.push({ success: false, error: error.message, count, lateFeeRuleId });
        }
      }
    }

    return { success: true, generated: results.filter((entry) => entry.success).length, results };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function findOverdueRentInvoices() {
  const startOfToday = startOfDay(ClockService.now());
  return Invoice.find({
    type: INVOICE_TYPES.RENT,
    balanceDue: { $gt: 0 },
    isDeleted: { $ne: true },
    dueDate: { $lt: startOfToday },
  });
}

async function generateAllLateFeeInvoices(options = {}) {
  logger.info('[lateFeeInvoice.service] Starting late fee invoice generation');
  try {
    const overdueRentInvoices = await findOverdueRentInvoices();
    if (!overdueRentInvoices.length) {
      return { success: true, message: 'No overdue rent invoices found', processed: 0, generated: 0 };
    }

    const propertyCache = new Map();
    const results = { processed: 0, generated: 0, errors: [], invoices: [] };
    for (const invoice of overdueRentInvoices) {
      try {
        const propertyId = String(invoice.propertyId || '');
        let property = propertyCache.get(propertyId);
        if (!property && propertyId) {
          property = await Property.findOne({ _id: invoice.propertyId, isDeleted: { $ne: true } })
            .select('billingTimezone billingTimezoneSource')
            .lean();
          propertyCache.set(propertyId, property || null);
        }

        const propertyTimezone = resolvePropertyBillingTimezone(property || {});
        if (options.billingTimezone && propertyTimezone !== options.billingTimezone) {
          continue;
        }

        const result = await runInTransaction(async (session) => processLateFeeForInvoice(invoice, session));
        results.processed += 1;
        if (result.success && result.generated) {
          results.generated += result.generated;
          results.invoices.push({
            rentInvoiceId: String(invoice._id),
            rentInvoiceNumber: invoice.invoiceId,
            generated: result.generated,
          });
        } else if (!result.success) {
          results.errors.push({ rentInvoiceId: String(invoice._id), error: result.error });
        }
      } catch (error) {
        results.errors.push({ rentInvoiceId: String(invoice._id), error: error.message });
      }
    }

    return { success: true, ...results };
  } catch (error) {
    return { success: false, error: error.message, processed: 0, generated: 0 };
  }
}

async function generateLateFeeForInvoice(rentInvoiceId) {
  try {
    const rentInvoice = await Invoice.findOne({ _id: rentInvoiceId, isDeleted: { $ne: true } });
    if (!rentInvoice) return { success: false, error: 'Invoice not found' };
    if (rentInvoice.type !== INVOICE_TYPES.RENT) return { success: false, error: 'Invoice is not a rent invoice' };
    if (Number(rentInvoice.balanceDue || 0) <= 0) return { success: false, error: 'Invoice has no outstanding balance' };
    if (!isEligibleForLateFee(rentInvoice, 0)) return { success: false, error: 'Invoice is not overdue' };

    return runInTransaction(async (session) => processLateFeeForInvoice(rentInvoice, session));
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  generateAllLateFeeInvoices,
  generateLateFeeForInvoice,
  processLateFeeForInvoice,
  findOverdueRentInvoices,
  getExistingLateFeeInvoices,
  LATE_FEE_INVOICE_TYPE,
};
