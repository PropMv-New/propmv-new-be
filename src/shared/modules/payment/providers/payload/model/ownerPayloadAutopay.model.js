'use strict';

const mongoose = require('mongoose');
const { PAYMENT_PROVIDER } = require('../constants/payload.constants');

const ownerPayloadAutopaySchema = new mongoose.Schema(
  {
    provider: { type: String, default: PAYMENT_PROVIDER.PAYLOAD, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    hoaId: { type: mongoose.Schema.Types.ObjectId, ref: 'HOA', required: true, index: true },
    enabled: { type: Boolean, default: false, index: true },
    payloadPaymentMethodLocalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PayloadPaymentMethod',
      default: null,
    },
    providerPaymentMethodId: { type: String, default: '', index: true },
    payloadCustomerId: { type: String, default: '' },
    enrolledAt: { type: Date, default: null },
    disabledAt: { type: Date, default: null },
    lastSyncedAt: { type: Date, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, collection: 'ownerpayloadautopays' },
);

ownerPayloadAutopaySchema.index(
  { provider: 1, userId: 1, hoaId: 1 },
  { unique: true },
);

module.exports = mongoose.models.OwnerPayloadAutopay
  || mongoose.model('OwnerPayloadAutopay', ownerPayloadAutopaySchema);
