/**
 * ------------------------------------------------------------------
 * File: property.model.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * app, hoaPropertyScope, contacts.service, noteReminder.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const { addHOADataIsolationHooks } = require('../../../../../middleware/hoaDataIsolation');

// Property schema represents a landlord's property with units, address, contact info and
// optional settings. Keep validations at the schema-level minimal and let the service
// layer perform more complex business validations where appropriate.
//
// HOA Data Isolation:
// This model includes HOA data isolation hooks that automatically:
// 1. Filter queries for HOA Board Members to only show their properties (landlord_id match)
// 2. Set ownership fields when HOA Board Members create properties
// 3. Ensure data segregation between different HOA Board Members

const PropertySchema = new Schema({
  landlord_id: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  hoaId: { type: Schema.Types.ObjectId, ref: 'HOA', index: true },
  name: { type: String, required: true },
  type: { type: String },
  propertyType: { type: String, required: [true, 'propertyType is required'] },
  description: { type: String },
  ownershipType: { type: String, required: [true, 'ownershipType is required'] },
  propertyManager: { type: String },
  hasHOA: { type: Boolean, default: false },
  /** Portal that created this property: hoa | landlord | property-manager */
  sourcePortal: {
    type: String,
    enum: ['hoa', 'landlord', 'property-manager'],
    default: 'hoa',
    index: true,
  },
  address: {
    street: String,
    line2: String,
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
  ownerPhone: { type: String },
  ownerType: { type: String, required: [true, 'ownerType is required'] },
  unitDetails: [{
    unitName: { type: String },
    unitType: { type: String },
    rentIncludes: [{ type: String }],
    bedRooms: {
      type: Number, min: [0, 'bedRooms must be >= 0'], validate: {
        validator: function (v) {
          // if unitType indicates residential, bedRooms is required (allow 0+)
          const ut = (this.unitType || '').toString().toLowerCase();
          if (ut && ut.includes('resid')) return typeof v === 'number' && v >= 0;
          return true;
        },
        message: 'bedRooms is required for residential unit types'
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
    amenities: [{ type: String }]
  }],
  propertySettings: {
    bankAccount: {
      entityType: { type: String, enum: ['individual', 'llc', 'corporation', 'partnership', 'trust'], default: 'individual' },
      firstName: { type: String, required: [true, 'bankAccount.firstName is required'] },
      lastName: { type: String, required: [true, 'bankAccount.lastName is required'] },
      email: {
        type: String, required: [true, 'bankAccount.email is required'], validate: {
          validator: function (v) {
            if (!v) return false;
            // simple email regex
            return /^\S+@\S+\.\S+$/.test(v);
          },
          message: 'bankAccount.email must be a valid email address'
        }
      },
      phone: { type: String },
      dob: {
        type: Date, required: [true, 'bankAccount.dob is required'], validate: {
          validator: function (v) {
            if (!v) return false;
            const now = new Date();
            const age = now.getFullYear() - v.getFullYear() - (now < new Date(now.getFullYear(), v.getMonth(), v.getDate()) ? 1 : 0);
            return age >= 18;
          },
          message: 'bankAccount.dob must be a date representing age 18 or older'
        }
      },
      ssn: { type: String, required: [true, 'bankAccount.ssn is required'] },
      businessName: { type: String },
      ein: { type: String },
      itin: { type: String },
      stateOfFormation: { type: String },
      bankName: { type: String },
      accountType: { type: String },
      routingNumber: { type: String },
      accountNumber: { type: String },
      address: {
        street: { type: String, required: [true, 'bankAccount.address.street is required'] },
        line2: { type: String },
        addressLine2: { type: String },
        city: { type: String, required: [true, 'bankAccount.address.city is required'] },
        state: { type: String, required: [true, 'bankAccount.address.state is required'] },
        zip: { type: String, required: [true, 'bankAccount.address.zip is required'] },
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
        type: Number, validate: {
          validator: function (v) {
            if (this.isRepeat) return typeof v === 'number' && v > 0;
            return true;
          },
          message: 'lateFees.repeatEndAfter is required and must be > 0 when isRepeat is true'
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
      chargeEachUnpaidTenat: { type: Boolean, required: [true, 'lateFees.chargeEachUnpaidTenat is required'] }
    }]
  },
  images: [{
    metadataId: { type: Schema.Types.ObjectId, ref: 'DocumentMetadata', required: true }
  }],
  notes: [
    {
      title: { type: String },
      description: { type: String, required: true },
      /** Human-friendly sequential number within this property's notes (Note #1, #2, …) */
      noteNumber: { type: Number, min: 1 },
      isPinned: { type: Boolean, default: false },
      isImportant: { type: Boolean, default: false },
      reminder: { type: Date },
      reminderNotifiedAt: { type: Date },
      createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
      updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      createdAt: { type: Date, default: Date.now },
      updatedAt: { type: Date, default: Date.now },
      attachments: [{ type: Schema.Types.ObjectId, ref: 'DocumentMetadata' }]
    }
  ],
  depositBankAccountId: { type: Schema.Types.ObjectId, required: true },
  /** Display label for the selected payout account (set from board UI when saving the unit). */
  depositBankAccountName: { type: String, default: '', maxlength: 200 },
  startingBalance: { type: Number, default: 0 },
  balanceAsOf: { type: Date },
  /** Set when automated/manual unit invoices are first created; prevents ledger opening balance from resurfacing as overdue after invoice removal. */
  hasGeneratedInvoices: { type: Boolean, default: false },
  remainingCredit: { type: Number, default: 0 },
  monthlyRecurringFee: { type: Number, default: 0 },
  paymentTerm: { type: Number, enum: [12, 24, 36, 60], default: 12 },
  /** Owner links for HOA occupancy/billing; indexed for vacant/occupied list filters. */
  associatedOwnerIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  ownershipRecords: [{
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, default: null },
    financialHandling: { type: String, default: 'FRESH' },
    createdAt: { type: Date, default: Date.now }
  }],
  ownershipLogs: [{
    action: { type: String, enum: ['ADD', 'REMOVE', 'CHANGE'], required: true },
    ownerIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    effectiveDate: { type: Date },
    timestamp: { type: Date, default: Date.now },
    performedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    details: { type: Schema.Types.Mixed }
  }],
  requestPayload: { type: Schema.Types.Mixed },
  // emergencyContact: {
  //   name: { type: String },
  //   firstName: { type: String },
  //   lastName: { type: String },
  //   phone: { type: String },
  //   email: { type: String }
  // },
  tags: [{ type: String }],
  isArchieved: { type: Boolean, default: false },
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date },
  status: { type: String },
}, { timestamps: true });

// Unique per landlord for property/community name + primary unit (HOA: one Property doc per unit).
// Same community name may repeat across units; landlord create flow still enforces one name per listing in code.
PropertySchema.index(
  { landlord_id: 1, name: 1, 'unitDetails.0.unitName': 1 },
  {
    unique: true,
    partialFilterExpression: {
      isDeleted: { $ne: true },
      isArchieved: { $ne: true },
    },
  }
);

PropertySchema.index({ hoaId: 1, isDeleted: 1, isArchieved: 1 });
PropertySchema.index({ hoaId: 1, landlord_id: 1, isDeleted: 1, isArchieved: 1 });
PropertySchema.index({ associatedOwnerIds: 1, isDeleted: 1 });
PropertySchema.index({ landlord_id: 1, isDeleted: 1, isArchieved: 1 });
PropertySchema.index({ landlord_id: 1, isDeleted: 1, isArchieved: 1, createdAt: -1 });
PropertySchema.index({ name: 1, isDeleted: 1 });

// Add HOA data isolation hooks to automatically filter and set ownership
// These hooks ensure HOA Board Members can only access their own properties
addHOADataIsolationHooks(PropertySchema);

// HOA must not share mongoose model name "Property" with the landlord portal - whichever
// schema loads first wins globally (e.g. landlord required ownerPhone vs HOA optional).
module.exports = mongoose.models.HOAProperty || mongoose.model('HOAProperty', PropertySchema, 'properties');
