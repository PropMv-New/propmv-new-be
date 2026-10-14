'use strict';

const mongoose = require('mongoose');
const { LINKED_BANK_STATUS, LINKED_BANK_PURPOSE } = require('../constants/linkedBank.constants');

/**
 * Local mirror of Straddle Embed Linked Bank Accounts.
 * Parent is StraddleAccount (NOT PaymentCustomer).
 * Never stores full account_number - last4 only.
 */
const linkedBankAccountSchema = new mongoose.Schema(
  {
    // Local ownership
    straddleAccountRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'StraddleAccount',
      required: true,
      index: true,
    },
    businessId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    entityType: { type: String, required: true, index: true },
    entityId:   { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    // Straddle identifiers
    straddleAccountId:     { type: String, required: true, index: true }, // acct UUID from Straddle
    linkedBankAccountId:   { type: String, default: null, index: true },  // linked_bank_account UUID

    // Masked bank details (never store full account number)
    holderName:    { type: String, required: true },
    routingNumber: { type: String, required: true }, // 9 digits - needed for display; consider masking later
    last4:         { type: String, required: true },
    accountType:   { type: String, enum: ['checking', 'savings', 'unknown'], default: 'unknown' },
    description:   { type: String, default: null },
    purposes:      {
      type: [String],
      enum: Object.values(LINKED_BANK_PURPOSE),
      default: [LINKED_BANK_PURPOSE.CHARGES, LINKED_BANK_PURPOSE.PAYOUTS],
    },
    /** Exactly one primary receiving bank per Straddle account (local + UI) */
    isPrimary: { type: Boolean, default: false, index: true },

    // Status from Straddle
    status: {
      type: String,
      enum: Object.values(LINKED_BANK_STATUS),
      default: LINKED_BANK_STATUS.CREATED,
      index: true,
    },
    statusDetail: { type: mongoose.Schema.Types.Mixed, default: null },
    verificationStatus: {
      type: String,
      enum: ['pending', 'verified', 'failed', 'canceled'],
      default: 'pending',
      index: true,
    },
    straddleReady: { type: Boolean, default: false },

    metadata:       { type: mongoose.Schema.Types.Mixed, default: {} },
    latestRequest:  { type: mongoose.Schema.Types.Mixed, default: null },
    latestResponse: { type: mongoose.Schema.Types.Mixed, default: null },
    latestError:    { type: mongoose.Schema.Types.Mixed, default: null },
    lastSyncedAt:   { type: Date, default: null },
    lastWebhookAt:  { type: Date, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

linkedBankAccountSchema.index({ straddleAccountRef: 1, isDeleted: 1, createdAt: -1 });
linkedBankAccountSchema.index({ businessId: 1, entityType: 1 });

module.exports = mongoose.models.LinkedBankAccount ||
  mongoose.model('LinkedBankAccount', linkedBankAccountSchema);
