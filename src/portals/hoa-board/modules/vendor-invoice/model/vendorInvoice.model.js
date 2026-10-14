const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const { EntityNoteSchema } = require('../../../../../common/schemas/entityNote.schema');

const VENDOR_INVOICE_STATUS = {
  PENDING: 'Pending',
  PROCESSING: 'Processing',
  PAID: 'Paid',
  CANCELLED: 'Cancelled',
};

const VendorInvoiceItemSchema = new Schema({
  description: { type: String, required: true, trim: true, maxlength: 500 },
  quantity: { type: Number, required: true, min: 0, default: 1 },
  rate: { type: Number, required: true, min: 0 },
  amount: { type: Number, required: true, min: 0 },
}, { _id: false });

const VendorInvoiceActivityEntrySchema = new Schema({
  kind: { type: String, required: true, trim: true },
  at: { type: Date, required: true },
  // created
  isSystemGenerated: { type: Boolean },
  createdBy: { type: String },
  // payment / payment_overpayment
  amount: { type: Number },
  method: { type: String },
  note: { type: String },
  balanceAfter: { type: Number },
  recordedBy: { type: String },
  paidBy: { type: String },
  paidOn: { type: String },
  checkNumber: { type: String },
  moneyOrderNumber: { type: String },
  isDeleted: { type: Boolean },
  // status_change
  previousStatus: { type: String },
  newStatus: { type: String },
  changedBy: { type: String },
  // edit
  changes: [{ type: String }],
  editedBy: { type: String },
}, { _id: false });

const VendorInvoiceSchema = new Schema({
  invoiceNumber: { type: String, required: true, trim: true, index: true },
  vendorId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  assignedTo: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  hoaId: { type: Schema.Types.ObjectId, ref: 'HOA', index: true },
  maintenanceRequestId: { type: Schema.Types.ObjectId, ref: 'MaintenanceRequest' },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, trim: true, maxlength: 5000, default: '' },
  lineItems: {
    type: [VendorInvoiceItemSchema],
    validate: [arr => Array.isArray(arr) && arr.length > 0, 'At least one line item is required'],
  },
  subAmount: { type: Number, required: true, min: 0 },
  amountPaid: { type: Number, required: true, min: 0, default: 0 },
  balanceDue: { type: Number, required: true, min: 0 },
  status: {
    type: String,
    enum: Object.values(VENDOR_INVOICE_STATUS),
    default: VENDOR_INVOICE_STATUS.PENDING,
    index: true,
  },
  dueDate: { type: Date },
  paidAt: { type: Date },
  /** Legacy free-text field (create/update forms). Threaded notes live in `comments`. */
  notes: { type: String, trim: true, maxlength: 2000, default: '' },
  /** Structured notes/comments (board, assignee, vendor). */
  comments: { type: [EntityNoteSchema], default: [] },
  /** Linked HOA expense created when this invoice first becomes Paid (idempotent). */
  expenseId: { type: Schema.Types.ObjectId, ref: 'HoaExpense' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  isDeleted: { type: Boolean, default: false },
  activityTimeline: { type: [VendorInvoiceActivityEntrySchema], default: [] },
}, { timestamps: true });

VendorInvoiceSchema.index({ vendorId: 1, status: 1, isDeleted: 1 });
VendorInvoiceSchema.index({ assignedTo: 1, status: 1, isDeleted: 1 });
VendorInvoiceSchema.index({ hoaId: 1, isDeleted: 1, createdAt: -1 });
VendorInvoiceSchema.index({ invoiceNumber: 1, vendorId: 1 }, { unique: true });

module.exports = mongoose.model('VendorInvoice', VendorInvoiceSchema);
module.exports.VENDOR_INVOICE_STATUS = VENDOR_INVOICE_STATUS;
