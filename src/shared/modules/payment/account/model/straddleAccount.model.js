'use strict';

const mongoose = require('mongoose');
const {
  ENTITY_TYPE,
  ACCOUNT_STATUS,
  ONBOARDING_STATUS,
  VERIFICATION_STATUS,
  CAPABILITY_STATUS,
} = require('../constants/account.constants');

const straddleAccountSchema = new mongoose.Schema(
  {
    // ── Internal ──────────────────────────────────────────────────────────────
    businessId:   { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    entityType:   { type: String, enum: Object.values(ENTITY_TYPE), required: true, index: true },
    entityId:     { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    // ── Straddle ──────────────────────────────────────────────────────────────
    organizationId:      { type: String, default: null },
    straddleAccountId:   { type: String, default: null, index: true },
    externalId:          { type: String, required: true, unique: true, index: true },
    accountName:         { type: String, required: true },
    legalName:           { type: String, default: null },
    accountType:         { type: String, default: null },   // business (Embed)
    email:               { type: String, default: null },
    phone:               { type: String, default: null },
    website:             { type: String, default: null },
    taxId:               { type: String, default: null },   // EIN - stored for display; never expose raw in logs
    address:             { type: mongoose.Schema.Types.Mixed, default: null },
    description:         { type: String, default: null },
    useCase:             { type: String, default: null },

    status:              { type: String, enum: Object.values(ACCOUNT_STATUS), default: ACCOUNT_STATUS.CREATED, index: true },
    previousStatus:      { type: String, default: null },
    onboardingStatus:    { type: String, enum: Object.values(ONBOARDING_STATUS), default: ONBOARDING_STATUS.NOT_STARTED },
    verificationStatus:  { type: String, enum: Object.values(VERIFICATION_STATUS), default: VERIFICATION_STATUS.UNVERIFIED },
    capabilityStatus:    { type: String, enum: Object.values(CAPABILITY_STATUS), default: CAPABILITY_STATUS.INACTIVE },
    complianceStatus:    { type: String, default: null },

    capabilities:        { type: mongoose.Schema.Types.Mixed, default: {} },
    metadata:            { type: mongoose.Schema.Types.Mixed, default: {} },
    environment:         { type: String, default: process.env.NODE_ENV || 'development' },

    // ── Operational ───────────────────────────────────────────────────────────
    lastSyncedAt:           { type: Date, default: null },
    lastWebhookAt:          { type: Date, default: null },
    lastStatusChangeAt:     { type: Date, default: null },
    onboardingCompletedAt:  { type: Date, default: null },
    /** 1–5 wizard step for save-and-continue (business → rep → bank → terms → done) */
    onboardingWizardStep:   { type: Number, default: 1, min: 1, max: 5 },
    termsOfService: {
      acceptedAt:        { type: Date, default: null },
      acceptedIp:        { type: String, default: null },
      acceptedUserAgent: { type: String, default: null },
      agreementType:     { type: String, default: 'embedded' },
      agreementUrl:      { type: String, default: null },
    },
    activatedAt:            { type: Date, default: null },
    disabledAt:             { type: Date, default: null },

    // ── Audit ─────────────────────────────────────────────────────────────────
    createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    deletedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isDeleted:  { type: Boolean, default: false },
    deletedAt:  { type: Date, default: null },

    // ── Tracking ──────────────────────────────────────────────────────────────
    requestId:      { type: String, default: null },
    correlationId:  { type: String, default: null },
    apiRequestId:   { type: String, default: null },
    version:        { type: Number, default: 1 },
    syncAttempts:   { type: Number, default: 0 },
    retryCount:     { type: Number, default: 0 },

    // ── Raw API data ──────────────────────────────────────────────────────────
    latestRequest:  { type: mongoose.Schema.Types.Mixed, default: null },
    latestResponse: { type: mongoose.Schema.Types.Mixed, default: null },
    latestError:    { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

straddleAccountSchema.index({ businessId: 1, entityType: 1 });
straddleAccountSchema.index({ straddleAccountId: 1 }, { sparse: true });
straddleAccountSchema.index({ externalId: 1 }, { unique: true });
straddleAccountSchema.index({ status: 1, entityType: 1 });

module.exports = mongoose.models.StraddleAccount ||
  mongoose.model('StraddleAccount', straddleAccountSchema);
