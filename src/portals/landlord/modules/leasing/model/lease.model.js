/**
 * ------------------------------------------------------------------
 * File: lease.model.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * diagnostic, maintenanceEmailHelper, contacts.service, landlordDataIsolation
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const { LEASE_STATUSES, LEASE_TYPES, FREQUENCY_TYPES } = require('../../../../../common/constants/lease');
const { INVOICE_STATUS } = require('../../../../../common/constants/invoice');

const LeaseSchema = new Schema({
  property_id: { type: Schema.Types.ObjectId, ref: 'Property', required: true },
  /** Stable reference to property.unitDetails[n]._id (survives unit renames). */
  unitId: { type: Schema.Types.ObjectId },
  unitName: { type: String },
  leaseTerm: { type: String, required: [true, 'leaseTerm is required'] },
  lease_type: { type: String, enum: Object.values(LEASE_TYPES), required: true },
  start_date: { type: Date, required: [true, 'start_date is required'] },
  end_date: {
    type: Date, required: function () { return (this.lease_type || '') === LEASE_TYPES.FIXED_TERM; }, validate: {
      validator: function (v) {
        if ((this.lease_type || '') === LEASE_TYPES.FIXED_TERM) return v instanceof Date;
        return true;
      },
      message: `end_date is required for ${LEASE_TYPES.FIXED_TERM} leases and must be a valid date`
    }
  },
  // if FixedTerm, indicate whether to switch to month-to-month after term
  switchMonthToMonth: { type: Boolean, required: function () { return (this.lease_type || '') === LEASE_TYPES.FIXED_TERM; }, default: false },
  auto_renew: { type: Boolean, default: false },

  // rent details
  rentDetails: {
    frequency: { type: String, enum: Object.values(FREQUENCY_TYPES), required: [true, 'rentDetails.frequency is required'] },
    amount: { type: Number, required: [true, 'rentDetails.amount is required'], min: [0, 'rent amount must be >= 0'] },
    dueOne: { type: String },
    dueTwo: { type: String }, // For bi-monthly second date
    dueWeekday: { type: Number, min: 0, max: 6 }, // For weekly/bi-weekly (0=Sunday, 6=Saturday)
    semiAnnualDates: [{
      month: { type: Number, min: 1, max: 12, required: true },
      day: { type: Number, min: 1, max: 31, required: true }
    }], // For semi-annually (2 dates per year)
    firstRentalInvoiceDue: { type: Date, required: [true, 'rentDetails.firstRentalInvoiceDue is required'] }
  },

  // deposit details
  depositDetails: {
    amount: { type: Number, min: [0, 'deposit amount must be >= 0'], default: 0 },
    due: {
      type: Date, required: function () { return typeof this.amount === 'number' && this.amount > 0; }, validate: {
        validator: function (v) {
          if (typeof this.amount === 'number' && this.amount > 0) return v instanceof Date;
          return true;
        },
        message: 'depositDetails.due is required when deposit amount is present and must be a valid date'
      }
    },
    isDepositAlreadyCollected: { type: Boolean, required: [true, 'depositDetails.isDepositAlreadyCollected is required'] }
  },

  additionalFees: {
    type: [{
      items: [{
        name: { type: String, required: [true, 'additionalFees.name is required'] },
        description: { type: String },
        quantity: { type: Number, required: [true, 'additionalFees.quantity is required'], min: [0, 'quantity must be >= 0'] },
        rate: { type: Number, required: [true, 'additionalFees.rate is required'], min: [0, 'rate must be >= 0'] },
        amount: { type: Number, required: [true, 'additionalFees.amount is required'], min: [0, 'amount must be >= 0'] }
      }],
      totalAmount: { type: Number, required: [true, 'additionalFees.totalAmount is required'], min: [0, 'totalAmount must be >= 0'] },
      alreadyPaid: { type: Number, required: [true, 'additionalFees.alreadyPaid is required'], min: [0, 'alreadyPaid must be >= 0'] },
      balanceAmount: { type: Number, required: [true, 'additionalFees.balanceAmount is required'], min: [0, 'balanceAmount must be >= 0'] },
      isRecurringInvoice: { type: Boolean, required: [true, 'additionalFees.isRecurringInvoice is required'] },
      lineItemOnRentalInvoice: { type: Boolean, required: [true, 'additionalFees.lineItemOnRentalInvoice is required'] },
      dueDate: {
        type: Date, required: function () { return this.isRecurringInvoice === false; }, validate: {
          validator: function (v) {
            if (this.isRecurringInvoice === false) return v instanceof Date;
            return true;
          },
          message: 'additionalFees.dueDate is required when isRecurringInvoice is false and must be a valid date'
        }
      },
      frequency: { type: String, required: function () { return this.isRecurringInvoice === true && this.lineItemOnRentalInvoice === false; } },
      dueOnDate: { type: Number },
      dueOnDate2: { type: Number },
      dueWeekday: { type: Number },
      startDate: { type: Date, required: function () { return this.isRecurringInvoice === true; } },
      endDate: { type: Date, required: function () { return this.isRecurringInvoice === true; } },
      semiAnnualDates: [{
        month: { type: Number, min: 1, max: 12 },
        day: { type: Number, min: 1, max: 31 }
      }],
      customDates: [{ type: Date }] // For custom frequency fees - array of specific invoice due dates
    }],
    default: undefined
  },

  rentAndDepositDestribution: {
    isAllTenantsEquallyResponsible: { type: Boolean, required: [true, 'rentAndDepositDestribution.isAllTenantsEquallyResponsible is required'] },
    isPartialPaymentAllowed: { type: Boolean, required: [true, 'rentAndDepositDestribution.isPartialPaymentAllowed is required'] },
    rentDistributionType: { type: String, required: [true, 'rentAndDepositDestribution.rentDistributionType is required'] },
    securityDepositDestributionType: { type: String, required: [true, 'rentAndDepositDestribution.securityDepositDestributionType is required'] },
    split: [{
      tenantId: { type: Schema.Types.Mixed, required: [true, 'rentAndDepositDestribution.split.tenantId is required'] },
      rentAmount: { type: Number, required: [true, 'rentAndDepositDestribution.split.rentAmount is required'], min: [0, 'rentAmount must be >= 0'] },
      rentPercentage: { type: Number, required: [true, 'rentAndDepositDestribution.split.rentPercentage is required'], min: [0, 'rentPercentage must be >= 0'], max: [100, 'rentPercentage must be <= 100'] },
      depositAmount: { type: Number, required: [true, 'rentAndDepositDestribution.split.depositAmount is required'], min: [0, 'depositAmount must be >= 0'] },
      depositPercentage: { type: Number, required: [true, 'rentAndDepositDestribution.split.depositPercentage is required'], min: [0, 'depositPercentage must be >= 0'], max: [100, 'depositPercentage must be <= 100'] },
      screening: { type: [String], default: [] },
      inviteAcknowledged: { type: Boolean, default: false },
      inviteAcknowledgedAt: { type: Date },
    }]
  },
  documents: [{
    metadataId: { type: Schema.Types.ObjectId, ref: 'DocumentMetadata', required: true }
  }],
  notes: [{
    description: { type: String, required: [true, 'Note description is required'] },
    attachments: [{ type: Schema.Types.ObjectId, ref: 'DocumentMetadata' }]
  }],
  comments: [{
    text: { type: String, required: true },
    action: { type: String, required: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now }
  }],
  invoiceSummary: {
    rent: {
      dueDate: { type: Date },
      amount: { type: Number },
      frequency: { type: String },
      description: { type: String }
    },
    deposit: {
      dueDate: { type: Date },
      amount: { type: Number },
      description: { type: String }
    },
    additionalCharges: [{
      name: { type: String },
      dueDate: { type: Date },
      frequency: { type: String },
      amount: { type: Number },
      description: { type: String },
      startDate: { type: Date },
      endDate: { type: Date },
      isRecurringInvoice: { type: Boolean },
      lineItemOnRentalInvoice: { type: Boolean },
      _id: false
    }],
    totalMonthlyAmount: { type: Number, default: 0 },
    totalOneTimeAmount: { type: Number, default: 0 }
  },
  generatedInvoices: [{
    type: { type: String, enum: ['rent', 'deposit', 'additional-fee'], required: true },
    description: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    dueDate: { type: Date, required: true },
    frequency: { type: String },
    status: { type: String, enum: Object.values(INVOICE_STATUS), required: true },
    feeId: { type: String },
    feeName: { type: String },
    /** Tenant this invoice belongs to (individual responsibility mode). */
    tenantId: { type: String },
    tenantName: { type: String },
    _id: false
  }],
  requireInsurance: { type: Boolean, default: false },
  includeDamageReport: { type: Boolean, default: false },
  insuranceTenantsIds: [{ type: String }],
  linkedTo: { type: Schema.Types.ObjectId, ref: 'Lease' }, // Link to previous/renewed lease (legacy)
  linkedLease: { type: Schema.Types.ObjectId, ref: 'Lease' }, // Link to the expired lease from which this lease was renewed
  status: { type: String, enum: Object.values(LEASE_STATUSES), default: LEASE_STATUSES.SUBMITTED },
  isDeleted: { type: Boolean, default: false },
}, { timestamps: true });

const { attachLeaseQueryStatics } = require('../../../../../common/db/leaseQueryHelpers');

const LeaseModel = mongoose.models.Lease || mongoose.model('Lease', LeaseSchema);
module.exports = attachLeaseQueryStatics(LeaseModel);
