'use strict';

const mongoose = require('mongoose');
const {
  PAYMENT_PROVIDER,
  PAYMENT_METHOD_STATUS,
  PAYMENT_METHOD_TYPE,
} = require('../constants/payload.constants');

const payloadPaymentMethodSchema = new mongoose.Schema(
  {
    provider: { type: String, default: PAYMENT_PROVIDER.PAYLOAD, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    providerPaymentMethodId: { type: String, required: true, index: true },
    paymentMethodConfigId: { type: String, default: null, index: true },
    billableMerchantId: { type: String, default: null, index: true },
    entityType: { type: String, default: null, index: true },
    entityId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    type: { type: String, enum: Object.values(PAYMENT_METHOD_TYPE), default: PAYMENT_METHOD_TYPE.CARD, index: true },
    status: { type: String, enum: Object.values(PAYMENT_METHOD_STATUS), default: PAYMENT_METHOD_STATUS.CREATED, index: true },
    isDefault: { type: Boolean, default: false },
    display: {
      brand: { type: String, default: '' },
      last4: { type: String, default: '' },
      expMonth: { type: Number, default: null },
      expYear: { type: Number, default: null },
      accountType: { type: String, default: '' },
      bankName: { type: String, default: '' },
      holderName: { type: String, default: '' },
      routingNumber: { type: String, default: '' },
      fingerprint: { type: String, default: '' },
      walletLabel: { type: String, default: '' },
    },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    lastWebhookAt: { type: Date, default: null },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'payloadpaymentmethods' }
);

payloadPaymentMethodSchema.index({ provider: 1, providerPaymentMethodId: 1 }, { unique: true });
payloadPaymentMethodSchema.index({ userId: 1, isDeleted: 1, status: 1 });

module.exports = mongoose.models.PayloadPaymentMethod
  || mongoose.model('PayloadPaymentMethod', payloadPaymentMethodSchema);
