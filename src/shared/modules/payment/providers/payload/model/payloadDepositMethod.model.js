'use strict';

const mongoose = require('mongoose');
const { PAYMENT_PROVIDER } = require('../constants/payload.constants');

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
 * Local mirror of Payload merchant deposit methods (payout bank accounts).
 * Parent is PayloadAccount. Never stores full account numbers - last4 only.
 */
const payloadDepositMethodSchema = new mongoose.Schema(
  {
    provider: { type: String, default: PAYMENT_PROVIDER.PAYLOAD, index: true },
    payloadAccountRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PayloadAccount',
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

    /** Payload payment method verification_status (e.g. verified / pending). */
    verificationStatus: { type: String, default: '', index: true },
    /** Payload transfer_type (Vendor deposit banks: receive-only). */
    transferType: { type: String, default: '', index: true },
    /**
     * Local mirror of Payload default_deposit_method (source of truth is Payload).
     * isPrimaryPayout remains the HOA-compatible mirror of the same flag.
     */
    defaultDepositMethod: { type: Boolean, default: false, index: true },

    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    latestResponse: { type: mongoose.Schema.Types.Mixed, default: null },
    lastSyncedAt: { type: Date, default: null },
    lastWebhookAt: { type: Date, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'payloaddepositmethods' }
);

/**
 * Unique real Payload pm_… ids. Partial filter avoids collisions on missing/null
 * depositMethodId (sparse compound indexes still index docs that have provider set).
 */
payloadDepositMethodSchema.index(
  { provider: 1, depositMethodId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      depositMethodId: { $type: 'string', $gt: '' },
    },
  }
);
payloadDepositMethodSchema.index({ payloadAccountRef: 1, isDeleted: 1, createdAt: -1 });
payloadDepositMethodSchema.index({ payloadAccountRef: 1, isPrimaryPayout: 1, isDeleted: 1 });
payloadDepositMethodSchema.index({ payloadAccountRef: 1, depositMethodId: 1, isDeleted: 1 });
payloadDepositMethodSchema.index({ entityType: 1, entityId: 1, isDeleted: 1 });

module.exports = {
  PayloadDepositMethod: mongoose.models.PayloadDepositMethod
    || mongoose.model('PayloadDepositMethod', payloadDepositMethodSchema),
  DEPOSIT_ROUTE_TYPE,
  DEPOSIT_METHOD_STATUS,
  DEPOSIT_METHOD_TYPE,
};
