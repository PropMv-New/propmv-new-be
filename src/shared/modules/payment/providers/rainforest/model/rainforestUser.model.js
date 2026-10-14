'use strict';

const mongoose = require('mongoose');
const { PAYMENT_PROVIDER } = require('../constants/rainforest.constants');

const rainforestUserSchema = new mongoose.Schema(
  {
    provider: { type: String, default: PAYMENT_PROVIDER.RAINFOREST, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Rainforest billable merchant context used for payor payment-method storage */
    billableMerchantId: { type: String, default: null, index: true },
    entityType: { type: String, default: null },
    entityId: { type: mongoose.Schema.Types.ObjectId, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    lastSyncedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'rainforestusers' }
);

rainforestUserSchema.index({ provider: 1, userId: 1, billableMerchantId: 1 }, { unique: true });

module.exports = mongoose.models.RainforestUser
  || mongoose.model('RainforestUser', rainforestUserSchema);
