const mongoose = require('mongoose');

const trustedDeviceSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    fingerprintHash: {
      type: String,
      required: true,
    },
    deviceName: {
      type: String,
      trim: true,
      maxlength: 120,
      default: null,
    },
    browser: {
      type: String,
      trim: true,
      maxlength: 80,
      default: null,
    },
    os: {
      type: String,
      trim: true,
      maxlength: 80,
      default: null,
    },
    lastIp: {
      type: String,
      trim: true,
      default: null,
    },
    lastUserAgent: {
      type: String,
      trim: true,
      maxlength: 512,
      default: null,
    },
    firstTrustedAt: {
      type: Date,
      default: Date.now,
    },
    lastLoginAt: {
      type: Date,
      default: Date.now,
    },
    trustedUntil: {
      type: Date,
      required: true,
      index: true,
    },
    isRevoked: {
      type: Boolean,
      default: false,
      index: true,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

trustedDeviceSchema.index(
  { userId: 1, fingerprintHash: 1 },
  { unique: true, partialFilterExpression: { isRevoked: false } }
);
trustedDeviceSchema.index({ userId: 1, trustedUntil: 1 });

module.exports = mongoose.model('TrustedDevice', trustedDeviceSchema);
