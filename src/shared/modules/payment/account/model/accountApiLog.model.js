'use strict';

const mongoose = require('mongoose');

const accountApiLogSchema = new mongoose.Schema(
  {
    operation:      { type: String, required: true, index: true },  // createAccount, getAccount, etc.
    entityType:     { type: String, default: null },
    entityId:       { type: mongoose.Schema.Types.ObjectId, default: null },
    straddleAccountId: { type: String, default: null, index: true },
    requestBody:    { type: mongoose.Schema.Types.Mixed, default: null },
    responseBody:   { type: mongoose.Schema.Types.Mixed, default: null },
    httpStatus:     { type: Number, default: null },
    apiRequestId:   { type: String, default: null },
    correlationId:  { type: String, default: null },
    requestId:      { type: String, default: null },
    executionMs:    { type: Number, default: null },
    retryCount:     { type: Number, default: 0 },
    success:        { type: Boolean, default: false },
    errorDetails:   { type: mongoose.Schema.Types.Mixed, default: null },
    createdBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

accountApiLogSchema.index({ operation: 1, createdAt: -1 });
accountApiLogSchema.index({ straddleAccountId: 1, createdAt: -1 });

module.exports = mongoose.models.AccountApiLog ||
  mongoose.model('AccountApiLog', accountApiLogSchema);
