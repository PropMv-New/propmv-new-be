/**
 * ------------------------------------------------------------------
 * File: billingSettings.model.js
 * Module: Billing Settings Module
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * billingSettings.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');

const feePaidByEnum = ['payer', 'operator'];

const BillingSettingsSchema = new mongoose.Schema(
  {
    hoaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'HOA',
      sparse: true,
      unique: true,
    },
    operatorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      sparse: true,
      unique: true,
    },
    transactionFees: {
      bankTransfer: {
        feeAmount: { type: Number, min: 0, default: 2 },
        paidBy: { type: String, enum: feePaidByEnum, default: 'payer' },
      },
      card: {
        feePercent: { type: Number, min: 0, max: 100, default: 2.99 },
        paidBy: { type: String, enum: feePaidByEnum, default: 'payer' },
      },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

BillingSettingsSchema.pre('validate', function validateScope(next) {
  const hasHoa = Boolean(this.hoaId);
  const hasOperator = Boolean(this.operatorUserId);
  if (hasHoa === hasOperator) {
    this.invalidate('hoaId', 'Exactly one of hoaId or operatorUserId is required');
  }
  next();
});

module.exports =
  mongoose.models.BillingSettings
  || mongoose.model('BillingSettings', BillingSettingsSchema);
