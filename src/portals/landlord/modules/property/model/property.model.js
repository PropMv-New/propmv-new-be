/**
 * ------------------------------------------------------------------
 * File: property.model.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * diagnostic, ensureLandlordIndexes, maintenanceEmailHelper, propertyUnitReference
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const { INTERNATIONAL_PHONE_REGEX } = require('../../../../../shared/utils/phoneValidation.util');

/**
 * Property Schema - Shared Model for Multi-Portal Architecture
 * 
 * This model is used by both:
 * - propmv/src/portals/landlord/modules/property/ (Landlord Portal)
 * - propmv/src/portals/hoa-board/modules/property/ (HOA Board Portal)
 * 
 * The createdBy field serves as the owner reference for both:
 * - Landlords: References the landlord user who owns the property
 * - HOA Board Members: References the HOA board member who manages the property
 * 
 * Data Isolation:
 * - Landlords can only access properties where createdBy matches their user ID
 * - HOA Board Members can only access properties where createdBy matches their user ID
 * - Middleware enforces role-based filtering automatically
 * 
 * Note: Keep validations at the schema-level minimal and let the service
 * layer perform more complex business validations where appropriate.
 */

const PropertySchema = new Schema({
  // Owner/Manager ID - Used by both Landlords and HOA Board Members
  // For Landlords: References the landlord user who owns the property
  // For HOA Board Members: References the HOA board member who manages the property
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  type: { type: String },
  propertyType: { type: String, required: [true, 'propertyType is required'] },
  description: { type: String },
  ownershipType: { type: String, required: [true, 'ownershipType is required'] },
  imageMode: { type: String, enum: ['shared', 'per-unit'], default: 'shared' },
  propertyManager: { type: String },
  hasHOA: { type: Boolean, default: false },
  /** Portal that created this property: hoa | landlord | property-manager */
  sourcePortal: {
    type: String,
    enum: ['hoa', 'landlord', 'property-manager'],
    default: undefined,
    index: true,
  },
  hoaId: { type: Schema.Types.ObjectId, ref: 'HOA' },
  address: {
    street: String,
    addressLine2: String,
    city: String,
    state: String,
    zip: String,
    country: String,
  },
  /** IANA timezone for billing calendar (late fees, due dates). Falls back to America/New_York. */
  billingTimezone: { type: String, default: null },
  billingTimezoneSource: {
    type: String,
    enum: ['zip_lookup', 'manual', 'default', null],
    default: null,
  },
  // Owner details (replaces legacy contact* fields)
  ownerName: { type: String, required: [true, 'ownerName is required'] },
  ownerEmail: {
    type: String, required: [true, 'ownerEmail is required'], validate: {
      validator: function (v) {
        if (!v) return false;
        return /^\S+@\S+\.\S+$/.test(v);
      },
      message: 'ownerEmail must be a valid email address'
    }
  },
  ownerPhone: {
    type: String, required: [true, 'ownerPhone is required'], validate: {
      validator: function (v) {
        if (!v) return false;
        return INTERNATIONAL_PHONE_REGEX.test(v);
      },
      message: 'ownerPhone must be a valid phone number (7-15 digits, country code allowed)'
    }
  },
  ownerType: { type: String, required: [true, 'ownerType is required'] },
  // Joint Ownership - array of owners with ownership and payout percentages
  jointOwners: [{
    name: { type: String, required: [true, 'jointOwners.name is required'] },
    email: {
      type: String, required: [true, 'jointOwners.email is required'], validate: {
        validator: function (v) {
          if (!v) return false;
          return /^\S+@\S+\.\S+$/.test(v);
        },
        message: 'jointOwners.email must be a valid email address'
      }
    },
    phone: {
      type: String, required: [true, 'jointOwners.phone is required'], validate: {
        validator: function (v) {
          if (!v) return false;
          return INTERNATIONAL_PHONE_REGEX.test(v);
        },
        message: 'jointOwners.phone must be a valid phone number (7-15 digits, country code allowed)'
      }
    },
    ownershipPercent: { type: Number, required: [true, 'jointOwners.ownershipPercent is required'], min: [0, 'ownershipPercent must be >= 0'], max: [100, 'ownershipPercent must be <= 100'] },
    role: { type: String, required: [true, 'jointOwners.role is required'], enum: ['primary', 'secondary'] },
    payoutPercent: { type: Number, required: [true, 'jointOwners.payoutPercent is required'], min: [0, 'payoutPercent must be >= 0'], max: [100, 'payoutPercent must be <= 100'] },
  }],
  tags: [{ type: String }],
  unitDetails: [{
    unitName: { type: String },
    unitType: { type: String },
    rentIncludes: [{ type: String }],
    bedRooms: {
      type: Number, min: [0, 'bedRooms must be >= 0'], validate: {
        validator: function (v) {
          // if unitType indicates residential, bedRooms is required (minimum 1)
          const ut = (this.unitType || '').toString().toLowerCase();
          if (ut && ut.includes('resid')) return typeof v === 'number' && v >= 1;
          return true;
        },
        message: 'bedRooms is required for residential unit types and must be at least 1'
      }
    },
    bathRoom: {
      type: Number, min: [0, 'bathRoom must be >= 0'], validate: {
        validator: function (v) {
          const ut = (this.unitType || '').toString().toLowerCase();
          if (ut && ut.includes('resid')) return typeof v === 'number' && v >= 0;
          return true;
        },
        message: 'bathRoom is required for residential unit types'
      }
    },
    squareFeet: { type: Number, required: [true, 'squareFeet is required'], min: [1, 'squareFeet must be > 0'] },
    amenities: [{ type: String }],
    images: [{
      metadataId: { type: Schema.Types.ObjectId, ref: 'DocumentMetadata' },
      unitName: { type: String },
      isCommon: { type: Boolean, default: false },
    }]
  }],
  propertySettings: new Schema({
    bankAccountMode: { type: String, enum: ['shared', 'per-unit'], default: 'shared' },
    unitBankAccounts: [{
      unitName: { type: String },
      bankAccount: {
        entityType: { type: String, enum: ['individual', 'llc', 'corporation', 'partnership', 'trust'], default: 'individual' },
        // Individual/Trust fields
        firstName: { type: String },
        lastName: { type: String },
        email: {
          type: String, validate: {
            validator: function (v) {
              if (!v) return true; // Allow empty for business entities
              return /^\S+@\S+\.\S+$/.test(v);
            },
            message: 'bankAccount.email must be a valid email address'
          }
        },
        phone: {
          type: String, validate: {
            validator: function (v) {
              if (!v) return true; // Allow empty for business entities
              return INTERNATIONAL_PHONE_REGEX.test(v);
            },
            message: 'bankAccount.phone must be a valid phone number (7-15 digits, country code allowed)'
          }
        },
        dob: {
          type: Date, validate: {
            validator: function (v) {
              if (!v) return true; // Allow empty for business entities
              const now = new Date();
              const age = now.getFullYear() - v.getFullYear() - (now < new Date(now.getFullYear(), v.getMonth(), v.getDate()) ? 1 : 0);
              return age >= 18;
            },
            message: 'bankAccount.dob must be a date representing age 18 or older'
          }
        },
        ssn: { type: String },
        // Business Entity fields (LLC/Corporation/Partnership)
        businessName: { type: String },
        ein: { type: String },
        itin: { type: String },
        stateOfFormation: { type: String },
        // Bank details
        bankName: { type: String },
        accountType: { type: String },
        routingNumber: { type: String },
        accountNumber: { type: String },
        paymentBankAccountId: { type: Schema.Types.ObjectId, ref: 'PaymentBankAccount' },
        address: {
          street: { type: String },
          line2: { type: String },
          addressLine2: { type: String },
          city: { type: String },
          state: { type: String },
          zip: { type: String }
        }
      }
    }],
    bankAccount: {
      // Common fields
      entityType: { type: String, enum: ['individual', 'llc', 'corporation', 'partnership', 'trust'], default: 'individual' },
      // Individual/Trust fields
      firstName: { type: String },
      lastName: { type: String },
      email: {
        type: String, validate: {
          validator: function (v) {
            if (!v) return true;
            return /^\S+@\S+\.\S+$/.test(v);
          },
          message: 'bankAccount.email must be a valid email address'
        }
      },
      phone: {
        type: String, validate: {
          validator: function (v) {
            if (!v) return true;
            return INTERNATIONAL_PHONE_REGEX.test(v);
          },
          message: 'bankAccount.phone must be a valid phone number (7-15 digits, country code allowed)'
        }
      },
      dob: {
        type: Date, validate: {
          validator: function (v) {
            if (!v) return true;
            const now = new Date();
            const age = now.getFullYear() - v.getFullYear() - (now < new Date(now.getFullYear(), v.getMonth(), v.getDate()) ? 1 : 0);
            return age >= 18;
          },
          message: 'bankAccount.dob must be a date representing age 18 or older'
        }
      },
      ssn: { type: String },
      businessName: { type: String },
      ein: { type: String },
      itin: { type: String },
      stateOfFormation: { type: String },
      bankName: { type: String },
      accountType: { type: String },
      routingNumber: { type: String },
      accountNumber: { type: String },
      paymentBankAccountId: { type: Schema.Types.ObjectId, ref: 'PaymentBankAccount' },
      address: {
        street: { type: String },
        line2: { type: String },
        addressLine2: { type: String },
        city: { type: String },
        state: { type: String },
        zip: { type: String }
      }
    },
    lateFees: [{
      lateFeeType: { type: String, required: [true, 'lateFees.lateFeeType is required'] },
      feeAmount: { type: Number, required: [true, 'lateFees.feeAmount is required'], min: [0, 'feeAmount must be >= 0'] },
      gracePeriod: { type: Number, required: [true, 'lateFees.gracePeriod is required'], min: [0, 'gracePeriod must be >= 0'] },
      isRepeat: { type: Boolean, required: [true, 'lateFees.isRepeat is required'] },
      applyTo: { type: String },
      repeatEvery: {
        type: Number, validate: {
          validator: function (v) {
            // if isRepeat true, repeatEvery must be provided and > 0
            if (this.isRepeat) return typeof v === 'number' && v > 0;
            return true;
          },
          message: 'lateFees.repeatEvery is required and must be > 0 when isRepeat is true'
        }
      },
      repeatEndAfter: {
        type: Number,
        default: null,
        validate: {
          validator: function (v) {
            // Allow null when "never" is selected
            if (v === null || v === undefined) return true;
            // When isRepeat is true and a value is provided, it must be > 0
            if (this.isRepeat && v !== null) return typeof v === 'number' && v > 0;
            return true;
          },
          message: 'lateFees.repeatEndAfter must be null or a number > 0'
        }
      },
      applicableScope: { type: String, enum: ['none', 'all', 'specific'], default: 'all' },
      applicableUnits: {
        type: [String], default: [], validate: {
          validator: function (arr) {
            if (this.applicableScope === 'none' || this.applicableScope === 'all') return true;
            return Array.isArray(arr) && arr.length > 0;
          },
          message: 'lateFees.applicableUnits must be a non-empty array when scope is specific'
        }
      },
      chargeEachUnpaidTenat: { type: Boolean, required: [true, 'lateFees.chargeEachUnpaidTenat is required'] },
      isCommon: { type: Boolean, default: true },
    }]
  }, { strict: false }),
  images: [{
    metadataId: { type: Schema.Types.ObjectId, ref: 'DocumentMetadata', required: true },
    unitName: { type: String },
    isCommon: { type: Boolean, default: true },
  }],
  profileImageId: { type: Schema.Types.ObjectId, ref: 'DocumentMetadata' },
  notes: [
    {
      description: { type: String, required: true },
      attachments: [{ type: Schema.Types.ObjectId, ref: 'DocumentMetadata' }]
    }
  ],
  startingBalance: { type: Number, default: 0 },
  balanceAsOf: { type: Date },
  monthlyRecurringFee: { type: Number, default: 0 },
  paymentTerm: { type: Number, enum: [12, 24, 36, 60], default: 12 },
  associatedOwnerIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  emergencyContact: {
    name: { type: String },
    firstName: { type: String },
    lastName: { type: String },
    phone: { type: String },
    email: { type: String }
  },
  isArchieved: { type: Boolean, default: false },
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date },
}, { timestamps: true });

// Unique per landlord for property name + primary unit (allows HOA multi-unit rows sharing one community name).
// Partial index: soft-deleted and archived rows do not block name reuse.
PropertySchema.index(
  { createdBy: 1, name: 1, 'unitDetails.0.unitName': 1 },
  {
    unique: true,
    partialFilterExpression: {
      isDeleted: { $ne: true },
      isArchieved: { $ne: true },
    },
  }
);

module.exports = mongoose.models.Property || mongoose.model('Property', PropertySchema);
