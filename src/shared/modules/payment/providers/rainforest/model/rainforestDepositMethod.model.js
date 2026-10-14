'use strict';

const mongoose = require('mongoose');
const { PAYMENT_PROVIDER } = require('../constants/rainforest.constants');

const DEPOSIT_ROUTE_TYPE = {
  PAYMENTS: 'PAYMENTS',
  BILLING: 'BILLING',
  AVAILABLE: 'AVAILABLE',
};

const DEPOSIT_METHOD_STATUS = {
  CREATED: 'CREATED',
  ACTIVE: 'ACTIVE',
  REPLACED: 'REPLACED',
};

const DEPOSIT_METHOD_TYPE = {
  ACH: 'ACH',
  PLAID_ACH: 'PLAID_ACH',
};

/**
 * Local mirror of Rainforest merchant deposit methods (payout bank accounts).
 * Parent is RainforestAccount. Never stores full account numbers - last4 only.
 */
const rainforestDepositMethodSchema = new mongoose.Schema(
  {
    provider: { type: String, default: PAYMENT_PROVIDER.RAINFOREST, index: true },
    rainforestAccountRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RainforestAccount',
      required: true,
      index: true,
    },
    businessId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    entityType: { type: String, required: true, index: true },
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    merchantId: { type: String, required: true, index: true },
    depositMethodId: { type: String, required: true, index: true },
    depositMethodConfigId: { type: String, default: '' },

    routeType: {
      type: String,
      enum: Object.values(DEPOSIT_ROUTE_TYPE),
      default: DEPOSIT_ROUTE_TYPE.AVAILABLE,
      index: true,
    },
    /** True when this deposit method is deposit_routes.PAYMENTS for the merchant */
    isPrimaryPayout: { type: Boolean, default: false, index: true },

    status: {
      type: String,
      enum: Object.values(DEPOSIT_METHOD_STATUS),
      default: DEPOSIT_METHOD_STATUS.CREATED,
      index: true,
    },
    methodType: {
      type: String,
      enum: Object.values(DEPOSIT_METHOD_TYPE),
      default: DEPOSIT_METHOD_TYPE.ACH,
    },

    holderName: { type: String, default: '' },
    routingNumber: { type: String, default: '' },
    last4: { type: String, default: '' },
    bankName: { type: String, default: '' },
    accountType: { type: String, default: 'unknown' },
    fingerprint: { type: String, default: '', index: true },

    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    latestResponse: { type: mongoose.Schema.Types.Mixed, default: null },
    lastSyncedAt: { type: Date, default: null },
    lastWebhookAt: { type: Date, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'rainforestdepositmethods' }
);

rainforestDepositMethodSchema.index(
  { provider: 1, depositMethodId: 1 },
  { unique: true, sparse: true }
);
rainforestDepositMethodSchema.index({ rainforestAccountRef: 1, isDeleted: 1, createdAt: -1 });
rainforestDepositMethodSchema.index({ rainforestAccountRef: 1, isPrimaryPayout: 1, isDeleted: 1 });

module.exports = {
  RainforestDepositMethod: mongoose.models.RainforestDepositMethod
    || mongoose.model('RainforestDepositMethod', rainforestDepositMethodSchema),
  DEPOSIT_ROUTE_TYPE,
  DEPOSIT_METHOD_STATUS,
  DEPOSIT_METHOD_TYPE,
};
