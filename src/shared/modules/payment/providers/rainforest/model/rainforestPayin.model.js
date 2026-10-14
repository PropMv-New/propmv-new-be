'use strict';

const mongoose = require('mongoose');
const { PAYMENT_PROVIDER } = require('../constants/rainforest.constants');

const rainforestPayinSchema = new mongoose.Schema(
  {
    provider: { type: String, default: PAYMENT_PROVIDER.RAINFOREST, index: true },
    payinId: { type: String, default: null, index: true },
    payinConfigId: { type: String, required: true, index: true },
    merchantId: { type: String, required: true, index: true },
    rainforestAccountRef: { type: mongoose.Schema.Types.ObjectId, ref: 'RainforestAccount', default: null, index: true },

    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', required: true, index: true },
    propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', default: null, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    paymentMethodLocalId: { type: mongoose.Schema.Types.ObjectId, ref: 'RainforestPaymentMethod', default: null },
    providerPaymentMethodId: { type: String, required: true, index: true },

    methodType: { type: String, default: 'CARD', index: true },
    status: { type: String, default: 'CREATED', index: true },

    /** Net invoice amount applied (USD dollars, excludes processing fee). */
    invoicePaymentAmount: { type: Number, required: true },
    /** Total Rainforest payin amount in minor units (cents). */
    chargeAmountCents: { type: Number, required: true },
    /** PropMv processing fee charged to payer (USD dollars). */
    processingFeeAmount: { type: Number, min: 0, default: 0 },
    processingFeePaidBy: { type: String, enum: ['payer', 'operator', ''], default: '' },
    /** PLATFORM amount split sent to Rainforest (minor units). */
    platformFeeCents: { type: Number, min: 0, default: 0 },
    currency: { type: String, default: 'USD' },

    paymentAttemptId: { type: String, default: '', index: true },
    idempotencyKey: { type: String, required: true, index: true },

    settledAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    lastWebhookAt: { type: Date, default: null },

    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
    refusalCode: { type: String, default: '' },
    refusalDesc: { type: String, default: '' },

    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'rainforestpayins' }
);

rainforestPayinSchema.index({ provider: 1, payinId: 1 }, { unique: true, sparse: true });
rainforestPayinSchema.index({ provider: 1, idempotencyKey: 1 }, { unique: true });
rainforestPayinSchema.index({ invoiceId: 1, paymentAttemptId: 1, isDeleted: 1 });

module.exports = mongoose.models.RainforestPayin
  || mongoose.model('RainforestPayin', rainforestPayinSchema);
