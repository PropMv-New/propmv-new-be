'use strict';

const mongoose = require('mongoose');
const {
  PAYMENT_PROVIDER,
  ENTITY_TYPE,
  MERCHANT_ONBOARDING_STATUS,
  MERCHANT_STATUS,
} = require('../constants/payload.constants');

const payloadAccountSchema = new mongoose.Schema(
  {
    provider: { type: String, default: PAYMENT_PROVIDER.PAYLOAD, index: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    entityType: { type: String, enum: Object.values(ENTITY_TYPE), required: true, index: true },
    /** Per-merchant PropMv entity id (new ObjectId per business account, like Straddle). */
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    externalId: { type: String, required: true, unique: true, index: true },

    accountName: { type: String, default: '', trim: true },
    merchantId: { type: String, default: null, index: true },
    merchantApplicationId: { type: String, default: null, index: true },
    /** Payload-unique merchant name sent to Payload API. */
    merchantName: { type: String, default: '' },
    merchantStatus: { type: String, default: MERCHANT_STATUS.PENDING, index: true },
    applicationStatus: { type: String, default: 'CREATED' },
    onboardingStatus: {
      type: String,
      enum: Object.values(MERCHANT_ONBOARDING_STATUS),
      default: MERCHANT_ONBOARDING_STATUS.NOT_STARTED,
      index: true,
    },

    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    environment: { type: String, default: process.env.PAYLOAD_ENVIRONMENT || 'sandbox' },
    lastSyncedAt: { type: Date, default: null },
    lastWebhookAt: { type: Date, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'payloadaccounts' }
);

payloadAccountSchema.index({ createdBy: 1, entityType: 1, isDeleted: 1 });
payloadAccountSchema.index({ businessId: 1, entityType: 1, isDeleted: 1 });
payloadAccountSchema.index({ 'metadata.hoaId': 1, createdBy: 1, isDeleted: 1 });
/**
 * Unique real processing account ids. Partial filter avoids null/empty collisions
 * during plugin onboarding (merchantId not minted yet).
 */
payloadAccountSchema.index(
  { provider: 1, merchantId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      merchantId: { $type: 'string', $gt: '' },
    },
  }
);
payloadAccountSchema.index(
  { provider: 1, merchantApplicationId: 1 },
  {
    partialFilterExpression: {
      merchantApplicationId: { $type: 'string', $gt: '' },
    },
  }
);
/** Phase 1: at most one active Vendor Payload Processing Account per Vendor user */
payloadAccountSchema.index(
  { entityType: 1, createdBy: 1 },
  {
    unique: true,
    partialFilterExpression: {
      entityType: 'vendor',
      isDeleted: false,
    },
  }
);

module.exports = mongoose.models.PayloadAccount
  || mongoose.model('PayloadAccount', payloadAccountSchema);
