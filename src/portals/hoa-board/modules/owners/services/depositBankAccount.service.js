/**
 * ------------------------------------------------------------------
 * File: depositBankAccount.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * depositBankAccount.controller
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Property = require('../../property/model/property.model');
const Invoice = require('../../invoice/model/invoice.model');
const { INVOICE_STATUS } = require('../../../../../common/constants/invoice');
const { buildHoaBoardPropertyMatch } = require('../../../../../middleware/hoaDataIsolation');
const { logActivity } = require('../../dashboard/service/activity.service');
const { ClockService, DateUtil } = require('../../../../../common/date');
const {
  getEffectiveInvoiceStatus,
  normalizeDepositBankLabel,
  appendDepositBankChangeHistory,
} = require('../../invoice/service/invoice.service');

/**
 * ValidationError
 *
 * Represents the Validation Error controller/model class.
 */
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

const toObjectId = (value) => {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
};

const requireObjectId = (value, fieldName) => {
  const oid = toObjectId(value);
  if (!oid) throw new ValidationError(`Valid ${fieldName} is required`);
  return oid;
};

const buildUnitScopeFilter = (userContext) => {
  const filter = { isDeleted: { $ne: true } };
  const propertyMatch = buildHoaBoardPropertyMatch(userContext);
  if (propertyMatch) {
    filter.$and = filter.$and || [];
    filter.$and.push(propertyMatch);
  }
  return filter;
};

/**
 * Returns how many units and invoices are linked to a deposit bank account.
 */
async function getDepositBankAccountUsage(bankAccountId, userContext) {
  const bankOid = requireObjectId(bankAccountId, 'bankAccountId');
  const unitFilter = {
    ...buildUnitScopeFilter(userContext),
    depositBankAccountId: bankOid,
  };

  const units = await Property.find(unitFilter).select('_id').lean();
  const unitIds = units.map((u) => u._id).filter(Boolean);

  if (unitIds.length === 0) {
    return { unitCount: 0, invoiceCount: 0 };
  }

  const invoiceCount = await Invoice.countDocuments({
    isDeleted: { $ne: true },
    propertyId: { $in: unitIds },
  });

  return { unitCount: unitIds.length, invoiceCount };
}

/**
 * Reassign units and future/unpaid invoices from one deposit bank account to another.
 * Paid invoices retain their historical bank snapshot; partial invoices keep the paid
 * portion on the old bank and route the remaining balance to the new bank.
 */
async function reassignDepositBankAccount(fromBankAccountId, toBankAccountId, toBankAccountName, userContext, userId) {
  const fromOid = requireObjectId(fromBankAccountId, 'fromBankAccountId');
  const toOid = requireObjectId(toBankAccountId, 'toBankAccountId');
  const toName = normalizeDepositBankLabel(toBankAccountName);

  if (String(fromOid) === String(toOid)) {
    throw new ValidationError('Replacement bank account must be different from the account being removed');
  }
  if (!toName) {
    throw new ValidationError('Replacement bank account name is required');
  }

  const unitFilter = {
    ...buildUnitScopeFilter(userContext),
    depositBankAccountId: fromOid,
  };

  const units = await Property.find(unitFilter)
    .select('_id depositBankAccountId depositBankAccountName')
    .lean();
  const unitIds = units.map((u) => u._id).filter(Boolean);

  if (unitIds.length === 0) {
    return { unitCount: 0, updatedInvoiceCount: 0 };
  }

  const unitById = new Map(units.map((u) => [String(u._id), u]));
  const safeUnitIds = unitIds.map((id) => toObjectId(id)).filter(Boolean);
  const invoices = await Invoice.find({
    isDeleted: { $ne: true },
    propertyId: { $in: safeUnitIds },
  });

  let updatedInvoiceCount = 0;

  for (const inv of invoices) {
    const unit = unitById.get(String(inv.propertyId));
    const oldBankName = normalizeDepositBankLabel(unit?.depositBankAccountName);
    const status = getEffectiveInvoiceStatus(inv);
    let changed = false;

    if (status === INVOICE_STATUS.PAID) {
      if (!inv.depositBankLocked) {
        inv.depositBankAccountId = unit?.depositBankAccountId || fromOid;
        inv.depositBankAccountName = oldBankName;
        inv.depositBankLocked = true;
        changed = true;
      }
    } else if (status === INVOICE_STATUS.PARTIALLY_PAID) {
      if (!inv.depositBankLocked) {
        inv.depositBankAccountId = unit?.depositBankAccountId || fromOid;
        inv.depositBankAccountName = oldBankName;
        inv.depositBankLocked = true;
        changed = true;
      }
      const prevBalanceName =
        normalizeDepositBankLabel(inv.balanceDepositBankAccountName) || oldBankName;
      appendDepositBankChangeHistory(inv, {
        previousBankAccountId: inv.balanceDepositBankAccountId || unit?.depositBankAccountId || fromOid,
        previousBankAccountName: prevBalanceName,
        newBankAccountId: toOid,
        newBankAccountName: toName,
      }, userId);
      inv.balanceDepositBankAccountId = toOid;
      inv.balanceDepositBankAccountName = toName;
      changed = true;
    } else {
      inv.depositBankAccountId = toOid;
      inv.depositBankAccountName = toName;
      inv.depositBankLocked = false;
      inv.balanceDepositBankAccountId = undefined;
      inv.balanceDepositBankAccountName = '';
      appendDepositBankChangeHistory(inv, {
        previousBankAccountId: unit?.depositBankAccountId || fromOid,
        previousBankAccountName: oldBankName,
        newBankAccountId: toOid,
        newBankAccountName: toName,
      }, userId);
      changed = true;
    }

    if (changed) {
      await inv.save();
      updatedInvoiceCount += 1;
    }
  }

  await Property.updateMany(
    { _id: { $in: safeUnitIds } },
    { $set: { depositBankAccountId: toOid, depositBankAccountName: toName } }
  );

  if (userId) {
    await logActivity({
      userId,
      action: 'UPDATE',
      module: 'Settings',
      entityId: toOid,
      entityName: toName,
      description: `Reassigned deposit bank account to "${toName}" (${unitIds.length} unit${unitIds.length === 1 ? '' : 's'}, ${updatedInvoiceCount} invoice${updatedInvoiceCount === 1 ? '' : 's'})`,
      meta: {
        fromBankAccountId: String(fromOid),
        toBankAccountId: String(toOid),
        unitCount: unitIds.length,
        updatedInvoiceCount,
      },
    });
  }

  return {
    unitCount: unitIds.length,
    updatedInvoiceCount,
  };
}

module.exports = {
  getDepositBankAccountUsage,
  reassignDepositBankAccount,
};
