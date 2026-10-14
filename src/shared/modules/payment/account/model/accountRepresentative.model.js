'use strict';

const mongoose = require('mongoose');

const relationshipSchema = new mongoose.Schema(
  {
    primary:           { type: Boolean, default: false },
    control:           { type: Boolean, default: true },
    owner:             { type: Boolean, default: false },
    percentOwnership:  { type: Number, default: null },
    title:             { type: String, default: null },
  },
  { _id: false }
);

const accountRepresentativeSchema = new mongoose.Schema(
  {
    straddleAccountRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'StraddleAccount',
      required: true,
      index: true,
    },
    businessId:   { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    entityType:   { type: String, required: true },
    entityId:     { type: mongoose.Schema.Types.ObjectId, required: true },

    straddleAccountId:       { type: String, required: true, index: true },
    straddleRepresentativeId:{ type: String, default: null, index: true },
    externalId:              { type: String, required: true, index: true },

    firstName:     { type: String, required: true },
    lastName:      { type: String, required: true },
    dob:           { type: String, required: true }, // YYYY-MM-DD
    ssnLast4:      { type: String, default: null },
    email:         { type: String, required: true },
    mobileNumber:  { type: String, required: true },
    relationship:  { type: relationshipSchema, default: () => ({ control: true, primary: true }) },

    status:        { type: String, default: 'created' },
    metadata:      { type: mongoose.Schema.Types.Mixed, default: {} },
    latestRequest: { type: mongoose.Schema.Types.Mixed, default: null },
    latestResponse:{ type: mongoose.Schema.Types.Mixed, default: null },
    latestError:   { type: mongoose.Schema.Types.Mixed, default: null },
    lastSyncedAt:  { type: Date, default: null },
    lastWebhookAt: { type: Date, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

accountRepresentativeSchema.index(
  { straddleAccountRef: 1, isDeleted: 1 },
  { unique: false }
);
accountRepresentativeSchema.index({ externalId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.models.AccountRepresentative ||
  mongoose.model('AccountRepresentative', accountRepresentativeSchema);
