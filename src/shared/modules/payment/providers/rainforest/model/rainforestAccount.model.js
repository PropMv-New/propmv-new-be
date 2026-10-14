'use strict';

const mongoose = require('mongoose');
const {
  PAYMENT_PROVIDER,
  ENTITY_TYPE,
  MERCHANT_ONBOARDING_STATUS,
  MERCHANT_STATUS,
} = require('../constants/rainforest.constants');

const rainforestAccountSchema = new mongoose.Schema(
  {
    provider: { type: String, default: PAYMENT_PROVIDER.RAINFOREST, index: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    entityType: { type: String, enum: Object.values(ENTITY_TYPE), required: true, index: true },
    /** Per-merchant PropMv entity id (new ObjectId per business account, like Straddle). */
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    externalId: { type: String, required: true, unique: true, index: true },

    accountName: { type: String, default: '', trim: true },
    merchantId: { type: String, default: null, index: true },
    merchantApplicationId: { type: String, default: null, index: true },
    /** Rainforest-unique merchant name sent to Rainforest API. */
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
    environment: { type: String, default: process.env.RAINFOREST_ENVIRONMENT || 'sandbox' },
    lastSyncedAt: { type: Date, default: null },
    lastWebhookAt: { type: Date, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'rainforestaccounts' }
);

rainforestAccountSchema.index({ createdBy: 1, entityType: 1, isDeleted: 1 });
rainforestAccountSchema.index({ businessId: 1, entityType: 1, isDeleted: 1 });
rainforestAccountSchema.index({ 'metadata.hoaId': 1, createdBy: 1, isDeleted: 1 });
rainforestAccountSchema.index({ provider: 1, merchantId: 1 }, { unique: true, sparse: true });
rainforestAccountSchema.index({ provider: 1, merchantApplicationId: 1 }, { sparse: true });

module.exports = mongoose.models.RainforestAccount
  || mongoose.model('RainforestAccount', rainforestAccountSchema);
