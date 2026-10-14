/**
 * ------------------------------------------------------------------
 * File: invoice.model.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * hoaDataIsolation, landlordDataIsolation, roleBasedDataIsolation, dashboard.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const { ClockService, DateUtil } = require('../../../../../common/date');
const Schema = mongoose.Schema;
const { INVOICE_TYPES, INVOICE_STATUS, INVOICE_TYPE_ENUM_VALUES } = require('../../../../../common/constants/invoice');
const { deriveLandlordInvoiceStatus } = require('../../../../../common/helpers/landlordInvoiceStatus.helper');
const { allocateUniqueLandlordInvoiceNumber, isLandlordInvoiceNumber } = require('../helpers/invoiceId.helper');
const LANDLORD_INVOICE_MODEL_NAME = 'LandlordInvoice';

const InvoiceItemSchema = new Schema({
  invoiceItem: { type: String, required: true },
  // description is optional; default to empty string for compatibility
  description: { type: String, required: false, default: '' },
  quantity: { type: Number, required: true, min: 0 },
  rate: { type: Number, required: true, min: 0 },
  amount: { type: Number, required: true, min: 0 },
  notes: { type: String, default: '' }
}, { _id: false });

const PaymentHistorySchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  paymentDate: { type: Date, required: true, default: Date.now },
  paymentType: { type: String, required: true, enum: ['Cash', 'Check', 'Money Order', 'Credit Card', 'Debit Card', 'Bank Transfer', 'Online Payment', 'Other'] },
  paymentAmount: { type: Number, required: true, min: 0 },
  checkNumber: { type: String },
  moneyOrderNumber: { type: String },
  notes: { type: String },
  recordedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  recordedAt: { type: Date, default: Date.now },
  isManual: { type: Boolean, default: true }
}, { _id: true, timestamps: true });

const InvoiceSchema = new Schema({
  invoiceId: { type: String, required: true, unique: true },
  type: { type: String, enum: INVOICE_TYPE_ENUM_VALUES, required: true },
  status: { type: String, enum: Object.values(INVOICE_STATUS), default: INVOICE_STATUS.PENDING },
  lease_id: { type: Schema.Types.ObjectId, ref: 'Lease' },
  propertyId: { type: Schema.Types.ObjectId, ref: 'Property', required: true },
  /** Denormalized property label for compatibility and faster reads. */
  propertyName: { type: String, default: '' },
  /** property.unitDetails[n]._id - stable unit reference */
  unitId: { type: Schema.Types.ObjectId },
  /** Denormalized unit label for compatibility with legacy invoice consumers. */
  unit: { type: String, default: '' },
  term: { type: String, required: true },
  tenants: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  invoiceItemDetails: {
    type: [InvoiceItemSchema],
    validate: [arr => Array.isArray(arr) && arr.length > 0, 'invoiceItemDetails must contain at least one item']
  },
  subAmount: { type: Number, required: true, min: 0 },
  alreadyPaid: { type: Number, required: true, min: 0, default: 0 },
  balanceDue: { type: Number, required: true, min: 0 },
  isPartialPaymentAllowed: { type: Boolean, required: true },
  dueDate: { type: Date, required: true },
  paidOn: { type: Date },
  documents: [{
    metadataId: { type: Schema.Types.ObjectId, ref: 'DocumentMetadata', required: true },
    originalName: { type: String },
    uploadedAt: { type: Date, default: Date.now },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' }
  }],
  comments: [{
    text: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt: { type: Date, default: Date.now }
  }],
  paymentHistory: { type: [PaymentHistorySchema], default: [] },
  /** Late fee linkage and generation metadata */
  metadata: {
    type: {
      parentInvoiceId: { type: Schema.Types.ObjectId, ref: 'LandlordInvoice' },
      parentInvoiceNumber: { type: String },
      lateFeeRuleId: { type: String },
      lateFeeOccurrence: { type: Number, min: 1 },
      lateFeeType: { type: String },
      gracePeriod: { type: Number, min: 0 },
      isRecurring: { type: Boolean },
      generatedAt: { type: Date },
      /** Set on landlord deposit refund invoices generated at lease end */
      isDepositRefund: { type: Boolean },
    },
    default: undefined,
  },
  /** Count of manual payment reminder emails sent via POST /invoice/:id/remind */
  remindersSent: { type: Number, default: 0, min: 0 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

// Pre-validate hook to generate invoiceId before validation
InvoiceSchema.pre('validate', async function (next) {
  try {
    const InvoiceModel = this.constructor;
    // Allocate on create only when missing / not already a canonical INV+UUID number.
    // Callers that pre-assign generateLandlordInvoiceNumber() skip an extra round-trip.
    if (this.isNew && !isLandlordInvoiceNumber(this.invoiceId)) {
      this.invoiceId = await allocateUniqueLandlordInvoiceNumber(InvoiceModel, {
        session: this.$session(),
      });
    }
    next();
  } catch (error) {
    next(error);
  }
});

// Pre-save hook to handle status calculation
InvoiceSchema.pre('save', async function (next) {
  try {
    const InvoiceModel = this.constructor;
    // Store original status for comparison
    if (!this.isNew) {
      const original = await InvoiceModel.findOne({ _id: this._id, isDeleted: { $ne: true } }).select('status').lean();
      this._original = original;
    }

    // Auto-calculate status based on balanceDue, payment progress, and due date
    const previousStatus = this.isNew ? null : this._original?.status;

    this.status = deriveLandlordInvoiceStatus(this);

    if (this.status === INVOICE_STATUS.PAID) {
      if (previousStatus !== INVOICE_STATUS.PAID && !this.paidOn) {
        this.paidOn = ClockService.now();
      }
    } else if (this.status !== INVOICE_STATUS.PAID && previousStatus === INVOICE_STATUS.PAID) {
      this.paidOn = undefined;
    }

    next();
  } catch (error) {
    next(error);
  }
});

const LandlordInvoice = mongoose.models[LANDLORD_INVOICE_MODEL_NAME]
  || mongoose.model(LANDLORD_INVOICE_MODEL_NAME, InvoiceSchema, 'invoices');

// Backward-compatible alias for legacy refs/populates that still target model name `Invoice`.
if (!mongoose.models.Invoice) {
  mongoose.model('Invoice', LandlordInvoice.schema, 'invoices');
}

module.exports = LandlordInvoice;
