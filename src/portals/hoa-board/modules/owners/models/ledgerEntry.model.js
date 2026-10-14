/**
 * ------------------------------------------------------------------
 * File: ledgerEntry.model.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * propertyRelatedQueries, invoiceCreditReconcile.helper, invoicePaymentReversal.helper, ledger.controller
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const LedgerEntrySchema = new Schema({
  unitId: { type: Schema.Types.ObjectId, ref: 'Property', required: true, index: true },
  type: {
    type: String,
    enum: ['opening_balance', 'adjustment', 'payment'],
    required: true
  },
  amount: { type: Number, required: true }, // +ve = due, -ve = credit
  referenceId: { type: Schema.Types.ObjectId }, // invoiceId or paymentId
  metadata: { type: Schema.Types.Mixed }, // { reason, createdBy, ... }
  createdAt: { type: Date, default: Date.now }
}, { timestamps: false, versionKey: false });

LedgerEntrySchema.index({ unitId: 1, type: 1 });
LedgerEntrySchema.index({ unitId: 1, createdAt: 1 });
LedgerEntrySchema.index({ referenceId: 1 }, { sparse: true });

const { toObjectId } = require('../../../../../common/db/mongooseHelpers');

LedgerEntrySchema.statics.findCreditAdjustmentsByUnitIds = function findCreditAdjustmentsByUnitIds(unitIds) {
  const ids = unitIds.map(toObjectId);
  return this.find({
    unitId: { $in: ids },
    type: 'adjustment',
    amount: { $lt: 0 },
  })
    .select('unitId amount metadata')
    .lean()
    .exec()
    .catch(() => []);
};

/** Balance math only needs opening rows, adjustments, and unlinked payments. */
LedgerEntrySchema.statics.findEntriesForBalanceByUnitIds = function findEntriesForBalanceByUnitIds(unitIds) {
  const ids = unitIds.map(toObjectId);
  if (!ids.length) return Promise.resolve([]);
  // Invoice-linked payment rows are audit mirrors of invoice.alreadyPaid - including them
  // would double-count against invoice balances. Unlinked payments (no referenceId) are
  // manual corrections, offline deposits, or legacy adjustments recorded directly on the ledger.
  return this.find({
    unitId: { $in: ids },
    $or: [
      { type: 'opening_balance' },
      { type: 'adjustment' },
      {
        type: 'payment',
        $or: [{ referenceId: { $exists: false } }, { referenceId: null }],
      },
    ],
  })
    .select('unitId type amount metadata referenceId createdAt')
    .lean()
    .exec()
    .catch(() => []);
};

module.exports = mongoose.models.LedgerEntry || mongoose.model('LedgerEntry', LedgerEntrySchema);
