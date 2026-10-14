/**
 * ------------------------------------------------------------------
 * File: tenantScreeningSettings.model.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * tenantScreeningSettings.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');

const screeningOptionSchema = new mongoose.Schema(
  {
    optionId: {
      type: String,
      enum: ['application_only', 'application_credit', 'application_credit_criminal_eviction'],
      required: true,
    },
    label: {
      type: String,
      required: true,
      // Examples: "Application Only", "Application + Credit", "Application + Credit + Criminal + Eviction"
    },
    innagoFee: {
      type: Number,
      required: true,
      min: 0,
    },
    additionalFee: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    totalFee: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false }
);

const tenantScreeningSettingsSchema = new mongoose.Schema(
  {
    // User who created these settings
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    landlord_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
      index: true,
    },

    // All available screening options with their complete fee information
    screeningOptions: [screeningOptionSchema],

    // Which option is currently selected
    selectedOption: {
      type: String,
      enum: ['application_only', 'application_credit', 'application_credit_criminal_eviction'],
      default: 'application_only',
      required: true,
    },

    // Advanced settings
    includeIncomeVerification: {
      type: Boolean,
      default: true,
    },
    useMultipleTemplates: {
      type: Boolean,
      default: false,
    },
    includeCriminalHistory: {
      type: Boolean,
      default: true,
    },

    // Reference to the property (if applicable)
    property_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Property',
      required: false,
      index: true,
    },

    // Timestamps
    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
      required: false,
      index: true,
      // Optional: TTL index for automatic cleanup after 30 days
      // Set this when creating settings for shared URLs
    },

    // Metadata
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
    collection: 'tenant_screening_settings',
  }
);

// Compound indexes for creator lookup
tenantScreeningSettingsSchema.index({ createdBy: 1, isDeleted: 1 });
tenantScreeningSettingsSchema.index({ createdBy: 1, createdAt: -1 });
tenantScreeningSettingsSchema.index({ landlord_id: 1, isDeleted: 1 });
tenantScreeningSettingsSchema.index({ landlord_id: 1, createdAt: -1 });

// TTL index for expired settings (auto-delete after 30 days if expiresAt is set)
tenantScreeningSettingsSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, sparse: true });

module.exports = mongoose.model('TenantScreeningSettings', tenantScreeningSettingsSchema);
