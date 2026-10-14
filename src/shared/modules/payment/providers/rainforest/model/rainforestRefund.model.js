'use strict';

const mongoose = require('mongoose');
const { PAYMENT_PROVIDER } = require('../constants/rainforest.constants');

const rainforestRefundSchema = new mongoose.Schema(
  {
    provider: { type: String, default: PAYMENT_PROVIDER.RAINFOREST, index: true },
    refundId: { type: String, default: null, index: true },
    payinId: { type: String, required: true, index: true },
    payinLocalId: { type: mongoose.Schema.Types.ObjectId, ref: 'RainforestPayin', default: null, index: true },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', required: true, index: true },
    paymentTransactionId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    merchantId: { type: String, required: true, index: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    voidOrRefundType: { type: String, default: 'REFUND', index: true },
    status: { type: String, default: 'CREATED', index: true },
    reason: { type: String, default: 'REQUESTED_BY_CUSTOMER' },

    /** Invoice amount restored (USD dollars). */
    invoiceRefundAmount: { type: Number, required: true },
    /** Rainforest void/refund amount in minor units (cents). */
    amountCents: { type: Number, required: true },
    currency: { type: String, default: 'USD' },

    idempotencyKey: { type: String, required: true, index: true },
    refundAttemptId: { type: String, default: '', index: true },

    completedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    lastWebhookAt: { type: Date, default: null },

    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
    refusalCode: { type: String, default: '' },
    refusalDesc: { type: String, default: '' },

    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'rainforestrefunds' }
);

rainforestRefundSchema.index({ provider: 1, refundId: 1 }, { unique: true, sparse: true });
rainforestRefundSchema.index({ provider: 1, idempotencyKey: 1 }, { unique: true });
rainforestRefundSchema.index({ invoiceId: 1, paymentTransactionId: 1, isDeleted: 1 });

module.exports = mongoose.models.RainforestRefund
  || mongoose.model('RainforestRefund', rainforestRefundSchema);
