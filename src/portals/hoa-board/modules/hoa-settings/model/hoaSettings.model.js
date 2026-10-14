/**
 * ------------------------------------------------------------------
 * File: hoaSettings.model.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * hoaSettings.service, invoice.service, unit.service, unitLateFee.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');

const HOASettingsSchema = new mongoose.Schema(
  {
    hoaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'HOA',
      required: true,
      unique: true,
    },

    // ── Monthly Recurring Fee ─────────────────────────────────────────────
    recurringFee: {
      enabled: { type: Boolean, default: false },
      amount: { type: Number, min: 0, max: 1000000, default: 0 },
      frequency: {
        type: String,
        enum: ['monthly', 'quarterly', 'annually'],
        default: 'monthly',
      },
      tenure: { type: Number, min: 1, max: 5, default: 1 }, // years
    },

    // ── Payment Term ──────────────────────────────────────────────────────
    paymentTerm: {
      dueDay: { type: Number, min: 1, max: 28, default: 1 },
      gracePeriodDays: { type: Number, min: 0, max: 365, default: 5 },
      acceptPartialPayments: { type: Boolean, default: false },
    },

    // ── Late Fees (multi-rule, same shape as property propertySettings.lateFees) ──
    lateFees: [{
      lateFeeType: { type: String },
      feeAmount: { type: Number, min: 0 },
      gracePeriod: { type: Number, min: 0 },
      isRepeat: { type: Boolean },
      repeatEvery: { type: Number, min: 1 },
      repeatEndAfter: { type: Number, min: 1, default: null },
      applicableScope: { type: String, enum: ['none', 'all', 'specific'], default: 'all' },
      applicableUnits: { type: [String] },
      chargeEachUnpaidTenat: { type: Boolean },
    }],

    // ── Automated Payment Reminders ─────────────────────────────────────
    paymentReminders: {
      enabled: { type: Boolean, default: true },
      timezone: { type: String, default: null },
      channels: {
        email: { type: Boolean, default: true },
        inApp: { type: Boolean, default: true },
        push: { type: Boolean, default: false },
      },
      beforeDueDate: {
        enabled: { type: Boolean, default: true },
        intervals: [{
          daysBefore: { type: Number, min: 1, max: 90 },
          enabled: { type: Boolean, default: true },
        }],
      },
      onDueDate: { type: Boolean, default: true },
      afterDueDate: {
        enabled: { type: Boolean, default: true },
        intervals: [{
          daysAfter: { type: Number, min: 1, max: 365 },
          enabled: { type: Boolean, default: true },
        }],
        continueOverdueReminders: { type: Boolean, default: true },
        overdueFrequencyDays: { type: Number, min: 1, max: 30, default: 7 },
        maxOverdueReminders: { type: Number, min: 1, max: 52, default: 10 },
      },
      respectGracePeriod: { type: Boolean, default: true },
      templates: {
        beforeDue: { subject: { type: String, default: '' }, body: { type: String, default: '' } },
        onDueDate: { subject: { type: String, default: '' }, body: { type: String, default: '' } },
        overdue: { subject: { type: String, default: '' }, body: { type: String, default: '' } },
      },
    },

    // ── Late Fee (legacy single-fee config) ─────────────────────────────
    lateFee: {
      enabled: { type: Boolean, default: false },
      applyAfterDays: { type: Number, min: 0, default: 5 },

      // One-time initial fee
      initialType: { type: String, enum: ['flat', 'percentage'], default: 'flat' },
      initialAmount: { type: Number, min: 0, default: 0 },
      initialPercentage: { type: Number, min: 0, max: 100, default: 0 },

      // Daily recurring fee
      dailyEnabled: { type: Boolean, default: false },
      dailyType: { type: String, enum: ['flat', 'percentage'], default: 'flat' },
      dailyAmount: { type: Number, min: 0, default: 0 },
      dailyPercentage: { type: Number, min: 0, max: 100, default: 0 },

      // Cap
      maxAmount: { type: Number, min: 0, default: null },
    },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.HOASettings ||
  mongoose.model('HOASettings', HOASettingsSchema);
