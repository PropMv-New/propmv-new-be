'use strict';

/**
 * Phase 4 — Owner → Vendor electronic payment attempt / transaction ledger.
 * Separate from HOA PayloadPayin (invoiceId → Invoice).
 */

const mongoose = require('mongoose');
const { PAYMENT_PROVIDER } = require('../constants/payload.constants');

const payloadVendorPayinSchema = new mongoose.Schema(
  {
    provider: { type: String, default: PAYMENT_PROVIDER.PAYLOAD, index: true },
    /** Payload transaction id */
    transactionId: { type: String, default: null, index: true },

    vendorInvoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'VendorInvoice',
      required: true,
      index: true,
    },
    hoaId: { type: mongoose.Schema.Types.ObjectId, ref: 'HOA', default: null, index: true },
    vendorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    payerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Phase 5: 'owner' | 'board' — who authorized the electronic pay. */
    payerRole: {
      type: String,
      enum: ['owner', 'board'],
      default: 'owner',
      index: true,
    },

    payloadAccountRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PayloadAccount',
      default: null,
      index: true,
    },
    merchantId: { type: String, required: true, index: true },
    destinationDepositMethodId: { type: String, required: true, index: true },

    paymentMethodLocalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PayloadPaymentMethod',
      default: null,
    },
    providerPaymentMethodId: { type: String, required: true, index: true },
    customerId: { type: String, default: '', index: true },

    methodType: { type: String, default: 'CARD', index: true },
    status: { type: String, default: 'CREATED', index: true },

    /** Net amount applied to VendorInvoice (USD dollars). Phase 4 v1: equals charge; no payer fee. */
    invoicePaymentAmount: { type: Number, required: true },
    /** Payload charge amount in minor units. Phase 4 v1: round(invoicePaymentAmount * 100). */
    chargeAmountCents: { type: Number, required: true },
    processingFeeAmount: { type: Number, min: 0, default: 0 },
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
  { timestamps: true, collection: 'payloadvendorpayins' },
);

payloadVendorPayinSchema.index(
  { provider: 1, transactionId: 1 },
  { unique: true, sparse: true, partialFilterExpression: { transactionId: { $type: 'string', $gt: '' } } },
);
payloadVendorPayinSchema.index({ provider: 1, idempotencyKey: 1 }, { unique: true });
payloadVendorPayinSchema.index({ vendorInvoiceId: 1, paymentAttemptId: 1, isDeleted: 1 });
payloadVendorPayinSchema.index({ vendorInvoiceId: 1, status: 1, isDeleted: 1 });

module.exports = mongoose.models.PayloadVendorPayin
  || mongoose.model('PayloadVendorPayin', payloadVendorPayinSchema);
