/**
 * ------------------------------------------------------------------
 * File: invoice.model.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * app, propertyRelatedQueries, hoaPropertyScope, invoiceLifecycleEmail.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const { ClockService, DateUtil } = require('../../../../../common/date');
const Schema = mongoose.Schema;
const { INVOICE_TYPES, INVOICE_STATUS, INVOICE_TYPE_ENUM_VALUES } = require('../../../../../common/constants/invoice');
const {
  getDateKeyInTimeZone,
  dueDateStringExprMongo,
} = require('../../../../../common/helpers/hoaBillingDates');
const { EntityNoteSchema } = require('../../../../../common/schemas/entityNote.schema');

const InvoiceItemSchema = new Schema({
  invoiceItem: { type: String, required: true },
  // description is optional; default to empty string for compatibility
  description: { type: String, required: false, default: '' },
  quantity: { type: Number, required: true, min: 0 },
  rate: { type: Number, required: true },
  amount: { type: Number, required: true }
}, { _id: false });

const PAYMENT_TX_STATUS = {
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

const PaymentTransactionSchema = new Schema({
  amount: { type: Number, required: true, min: 0 },
  method: { type: String, default: '' },
  /** Manual records may be reversed by board users; gateway payments are immutable here. */
  isManual: { type: Boolean, default: true },
  /** Gateway rows: processing until settled, then completed. Legacy rows omit status (treated as completed). */
  status: { type: String, enum: Object.values(PAYMENT_TX_STATUS) },
  /** Linked StraddleTransaction or StripePayment document */
  gatewayTransactionId: { type: Schema.Types.ObjectId },
  gatewayExternalId: { type: String, default: '' },
  paidBy: { type: Schema.Types.ObjectId, ref: 'User' },
  note: { type: String, default: '' },
  checkNumber: { type: String, default: '' },
  moneyOrderNumber: { type: String, default: '' },
  balanceAfter: { type: Number, required: true },
  recordedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  paidAt: { type: Date, default: Date.now },
  /** When the payment was recorded in the system (distinct from user-selected paidAt). */
  recordedAt: { type: Date, default: Date.now },
  completedAt: { type: Date },
  /** Rainforest refund metadata for gateway payments (does not apply to manual rows). */
  refundedAmount: { type: Number, min: 0, default: 0 },
  refundedAt: { type: Date },
  refundExternalId: { type: String, default: '' },
  /** Soft-deleted rows are hidden from payment history/balance math but retained for audit timeline. */
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date },
  deletedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  /** Links all payment rows created by one board Record Payment session. */
  paymentGroupId: { type: String, default: '' },
  /** Total amount the board member entered when recording payment (may exceed this row's amount). */
  recordedPaymentTotal: { type: Number, min: 0 },
  /** Invoice the user recorded payment against (primary / selected invoice). */
  recordedAgainstInvoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
  recordedAgainstInvoiceNumber: { type: String, default: '' },
  /**
   * FIFO allocation role for cross-invoice payments:
   * - prior_allocation: funds applied here from a payment recorded on a later invoice
   * - self_allocation: portion applied to the invoice it was recorded against
   * - recorded_only: audit anchor when the full payment went to older invoices
   */
  fifoAllocationRole: {
    type: String,
    enum: ['', 'prior_allocation', 'self_allocation', 'recorded_only'],
    default: '',
  },
  fifoRedirectedAmount: { type: Number, min: 0 },
  fifoRedirectedToInvoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
  fifoRedirectedToInvoiceNumber: { type: String, default: '' },
  fifoRedirectedToDueDate: { type: Date },
  /** Full FIFO redirect breakdown when payment was applied to older invoices first. */
  fifoRedirectedAllocations: [{
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
    invoiceNumber: { type: String, default: '' },
    amount: { type: Number, min: 0 },
  }],
  /**
   * When this row is auto-applied unit credit, links back to the overpayment
   * payment group that created the credit (so allocations can be reversed independently).
   */
  sourcePaymentGroupId: { type: String, default: '' },
  sourceInvoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
  sourceInvoiceNumber: { type: String, default: '' },
}, { _id: true });

const ReminderHistorySchema = new Schema({
  recipients: [{ type: String, required: true }],
  subject: { type: String, default: '' },
  sentAt: { type: Date, default: Date.now },
  sentBy: { type: Schema.Types.ObjectId, ref: 'User' },
  source: { type: String, enum: ['manual', 'system'], default: 'manual' },
  reminderType: { type: String, enum: ['', 'before_due', 'due_today', 'overdue', 'manual'], default: 'manual' },
  daysOffset: { type: Number },
  channels: [{ type: String }],
}, { _id: true });

const DepositBankChangeHistorySchema = new Schema({
  previousBankAccountId: { type: Schema.Types.ObjectId },
  previousBankAccountName: { type: String, default: '', maxlength: 200 },
  newBankAccountId: { type: Schema.Types.ObjectId },
  newBankAccountName: { type: String, default: '', maxlength: 200 },
  changedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  changedAt: { type: Date, default: Date.now }
}, { _id: true });

const InvoiceEditHistorySchema = new Schema({
  changes: [{ type: String, required: true }],
  editedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  editedAt: { type: Date, default: Date.now }
}, { _id: true });

const InvoiceWaiveHistorySchema = new Schema({
  amount: { type: Number, required: true, min: 0 },
  reason: { type: String, default: '', maxlength: 2000 },
  lineItemIndex: { type: Number, min: 0 },
  invoiceItem: { type: String, default: '' },
  lineItemDescription: { type: String, default: '' },
  waivedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  waivedAt: { type: Date, default: Date.now },
  reversed: { type: Boolean, default: false },
  reversedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  reversedAt: { type: Date },
}, { _id: true });

const InvoiceWaiveReversalHistorySchema = new Schema({
  amount: { type: Number, required: true, min: 0 },
  reversedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  reversedAt: { type: Date, default: Date.now },
  previousStatus: { type: String, default: '' },
  newStatus: { type: String, default: '' },
}, { _id: true });

/** Persisted ownership audit events for invoice Activity Timeline (independent of tenants[]). */
const InvoiceOwnershipHistorySchema = new Schema({
  action: {
    type: String,
    enum: ['OWNER_ADDED', 'OWNER_REMOVED', 'OWNER_CHANGED', 'OWNER_EVENT_REVERTED'],
    required: true,
  },
  previousOwnerIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  newOwnerIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  previousOwnerNames: [{ type: String }],
  newOwnerNames: [{ type: String }],
  propertyId: { type: Schema.Types.ObjectId, ref: 'Property' },
  unitId: { type: Schema.Types.ObjectId, ref: 'Property' },
  unitLabel: { type: String, default: '' },
  description: { type: String, required: true, maxlength: 2000 },
  performedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  performedAt: { type: Date, default: Date.now },
}, { _id: true });

const LateFeeHistorySchema = new Schema({
  lateFeeRuleKey: { type: String, required: true },
  lateFeeSequence: { type: Number, required: true, min: 1 },
  amount: { type: Number, required: true, min: 0 },
  lineItemLabel: { type: String, default: '' },
  description: { type: String, default: '' },
  calculationMethod: { type: String, default: '' },
  appliedAt: { type: Date, default: Date.now },
  appliedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  source: { type: String, default: 'system' },
}, { _id: true });

const InvoiceSchema = new Schema({
  invoiceId: { type: String, unique: true, required: true },
  type: { type: String, enum: INVOICE_TYPE_ENUM_VALUES, required: true },
  status: { type: String, enum: Object.values(INVOICE_STATUS), default: INVOICE_STATUS.PENDING },
  lease_id: { type: Schema.Types.ObjectId, ref: 'Lease' },
  propertyId: { type: Schema.Types.ObjectId, ref: 'Property', required: true },
  propertyName: { type: String, required: true },
  hoaId: { type: Schema.Types.ObjectId, ref: 'HOA', index: true },
  unit: { type: String, required: true },
  term: { type: String, required: true },
  tenants: [{ type: Schema.Types.ObjectId, ref: 'User', required: true }],
  invoiceItemDetails: {
    type: [InvoiceItemSchema],
    validate: [arr => Array.isArray(arr) && arr.length > 0, 'invoiceItemDetails must contain at least one item']
  },
  subAmount: { type: Number, required: true },
  /** Principal assessment amount before late fees; used for percentage/fee calculations */
  principalSubAmount: { type: Number, min: 0 },
  alreadyPaid: { type: Number, required: true, min: 0, default: 0 },
  /** In-flight gateway payments not yet confirmed on the invoice */
  processingAmount: { type: Number, required: true, min: 0, default: 0 },
  balanceDue: { type: Number, required: true },
  lateFeeHistory: { type: [LateFeeHistorySchema], default: [] },
  isPartialPaymentAllowed: { type: Boolean, required: true },
  notes: { type: String, default: '' },
  dueDate: { type: Date, required: true },
  /** Mirrors landlord API naming: all payers selected for this invoice */
  isAllTenantSelected: { type: Boolean, default: false },
  isRecurringInvoice: { type: Boolean, default: false },
  /** When true, line items roll into the main fee/assessment run; when false, separate recurring invoices */
  isLineItemOnRentalInvoice: { type: Boolean },
  frequency: { type: String },
  dueOnDate: { type: Number, min: 1, max: 31 },
  startDate: { type: Date },
  endDate: { type: Date },
  paidOn: { type: Date },
  /** Snapshot of deposit bank at creation or when first payment is recorded (audit/history). */
  depositBankAccountId: { type: Schema.Types.ObjectId },
  depositBankAccountName: { type: String, default: '', maxlength: 200 },
  /** Remaining balance deposit bank (e.g. after partial payment + bank reassignment). */
  balanceDepositBankAccountId: { type: Schema.Types.ObjectId },
  balanceDepositBankAccountName: { type: String, default: '', maxlength: 200 },
  /** When true, depositBankAccountId/Name reflect received payments and must not change. */
  depositBankLocked: { type: Boolean, default: false },
  generatedFrom: {
    type: String,
    enum: ['manual', 'unit_schedule', 'opening_balance', 'late_fee', 'policy_term'],
    default: 'manual',
    index: true
  },
  sourceInvoiceId: {
    type: Schema.Types.ObjectId,
    ref: 'Invoice',
    index: true
  },
  lateFeeRuleKey: { type: String, index: true },
  lateFeeSequence: { type: Number, min: 1 },
  /** Manual/backdated invoices: cron will not auto-apply late fees when true */
  skipAutoLateFees: { type: Boolean, default: false },
  /**
   * When true, automatic credit application skips this invoice until credit is
   * applied manually (set after a board member removes an applied credit).
   */
  skipAutoCreditApply: { type: Boolean, default: false },
  /**
   * Legacy date-based pause (start of next HOA calendar day). Still honored by
   * isInvoiceAutoCreditPaused for older documents.
   */
  skipAutoCreditUntil: { type: Date },
  /** Payload mirror invoice for owner autopay (PropMV remains invoice source of truth). */
  payloadAutopayMirror: {
    payloadInvoiceId: { type: String, default: '', index: true },
    lastSyncedAt: { type: Date, default: null },
    syncStatus: { type: String, default: '' },
    lastSyncError: { type: String, default: '' },
  },
  documents: [{
    metadataId: { type: Schema.Types.ObjectId, ref: 'DocumentMetadata', required: true },
    originalName: { type: String },
    uploadedAt: { type: Date, default: Date.now },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' }
  }],
  comments: [EntityNoteSchema],
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date },
  deletedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  paymentTransactions: { type: [PaymentTransactionSchema], default: [] },
  reminderHistory: { type: [ReminderHistorySchema], default: [] },
  depositBankChangeHistory: { type: [DepositBankChangeHistorySchema], default: [] },
  editHistory: { type: [InvoiceEditHistorySchema], default: [] },
  waiveHistory: { type: [InvoiceWaiveHistorySchema], default: [] },
  waiveReversalHistory: { type: [InvoiceWaiveReversalHistorySchema], default: [] },
  ownershipHistory: { type: [InvoiceOwnershipHistorySchema], default: [] },
  /** Latest waive snapshot (also stored per event in waiveHistory) */
  waivedAmount: { type: Number, min: 0, default: 0 },
  waivedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  waivedAt: { type: Date },
  waiveReason: { type: String, default: '', maxlength: 2000 }
}, { timestamps: true });

InvoiceSchema.pre('validate', function (next) {
  if (!Array.isArray(this.tenants) || this.tenants.length === 0) {
    this.invalidate('tenants', 'At least one owner (payer) is required');
  }
  next();
});

InvoiceSchema.index(
  { sourceInvoiceId: 1, lateFeeRuleKey: 1, lateFeeSequence: 1 },
  {
    unique: true,
    partialFilterExpression: { generatedFrom: 'late_fee', isDeleted: false }
  }
);

InvoiceSchema.index({ propertyId: 1, isDeleted: 1, dueDate: 1 });
InvoiceSchema.index({ propertyId: 1, isDeleted: 1, status: 1, dueDate: 1 });
InvoiceSchema.index({ propertyId: 1, isDeleted: 1, status: 1, balanceDue: 1, dueDate: 1 });
InvoiceSchema.index({ tenants: 1, isDeleted: 1, dueDate: -1 });
InvoiceSchema.index({ propertyId: 1, isDeleted: 1, balanceDue: 1, dueDate: 1 });
InvoiceSchema.index({ hoaId: 1, isDeleted: 1, dueDate: 1 });
InvoiceSchema.index({ hoaId: 1, isDeleted: 1, status: 1, dueDate: 1 });
InvoiceSchema.index({ createdBy: 1, isDeleted: 1, dueDate: -1 });
// Optimizes the common list/stats filter: { propertyId: $in, isDeleted, generatedFrom }
InvoiceSchema.index({ propertyId: 1, isDeleted: 1, generatedFrom: 1, dueDate: 1 });
// Optimizes getInvoiceById prior-outstanding query
InvoiceSchema.index({ propertyId: 1, isDeleted: 1, status: 1, balanceDue: 1 });

const { commonQueryHelpersPlugin } = require('../../../../../common/db/schemaPlugins');
const { toObjectId, exactUnitNameRegex } = require('../../../../../common/db/mongooseHelpers');

commonQueryHelpersPlugin(InvoiceSchema);

const OVERDUE_INVOICE_PROJECTION = {
  _id: 1,
  propertyId: 1,
  lease_id: 1,
  unit: 1,
  balanceDue: 1,
  status: 1,
  dueDate: 1,
};

InvoiceSchema.statics.findOverdueByProperty = function findOverdueByProperty(propertyId, today, options = {}) {
  const { unitName, select = { balanceDue: 1 }, lean = true } = options;
  const filter = {
    propertyId: toObjectId(propertyId),
    isDeleted: { $ne: true },
    balanceDue: { $gt: 0 },
    dueDate: { $lt: today },
    status: { $nin: ['Paid'] },
  };
  if (unitName) filter.unit = exactUnitNameRegex(unitName);

  let query = this.find(filter).select(select);
  return lean ? query.lean().exec() : query.exec();
};

InvoiceSchema.statics.findOverdueByPropertyIds = function findOverdueByPropertyIds(propertyIds, today, options = {}) {
  const { select = OVERDUE_INVOICE_PROJECTION, lean = true } = options;
  const ids = propertyIds.map(toObjectId);
  let query = this.find({
    propertyId: { $in: ids },
    isDeleted: { $ne: true },
    balanceDue: { $gt: 0 },
    dueDate: { $lt: today },
    status: { $nin: ['Paid'] },
  }).select(select);

  return lean ? query.lean().exec() : query.exec();
};

/**
 * Aggregate unpaid invoice totals for property list enrichment (avoids loading every invoice doc).
 */
InvoiceSchema.statics.aggregateUnpaidSummaryByPropertyIds = function aggregateUnpaidSummaryByPropertyIds(propertyIds, today) {
  if (!propertyIds?.length) {
    return Promise.resolve({ byProperty: [], byPropertyUnit: [] });
  }

  const ids = propertyIds.map(toObjectId);
  const todayKey = getDateKeyInTimeZone(today || new Date());
  const dueDateKeyExpr = dueDateStringExprMongo();

  return this.aggregate([
    {
      $match: {
        propertyId: { $in: ids },
        isDeleted: { $ne: true },
        balanceDue: { $gt: 0 },
        status: { $nin: ['Paid'] },
      },
    },
    {
      $addFields: {
        dueDateKey: dueDateKeyExpr,
        normalizedUnit: {
          $toLower: {
            $trim: {
              input: { $ifNull: ['$unit', ''] },
            },
          },
        },
      },
    },
    ...(todayKey
      ? [{ $match: { $expr: { $lte: ['$dueDateKey', todayKey] } } }]
      : []),
    {
      $addFields: {
        effectiveStatus: {
          $switch: {
            branches: [
              {
                case: {
                  $and: [
                    { $eq: ['$status', 'Overdue'] },
                    { $gte: ['$dueDateKey', todayKey] },
                  ],
                },
                then: 'Pending',
              },
              {
                case: {
                  $and: [
                    { $eq: ['$status', 'Pending'] },
                    { $lt: ['$dueDateKey', todayKey] },
                  ],
                },
                then: 'Overdue',
              },
              {
                case: {
                  $and: [
                    { $eq: ['$status', 'Partially Paid'] },
                    { $lt: ['$dueDateKey', todayKey] },
                  ],
                },
                then: 'Overdue',
              },
            ],
            default: '$status',
          },
        },
      },
    },
    {
      $facet: {
        byProperty: [
          {
            $group: {
              _id: '$propertyId',
              totalDue: { $sum: '$balanceDue' },
              /** Calendar past-due only (due before today in app TZ) - matches unit Amount Overdue. */
              pastDueAmount: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $lt: ['$dueDateKey', todayKey] },
                      ],
                    },
                    '$balanceDue',
                    0,
                  ],
                },
              },
              overdueAmount: {
                $sum: {
                  $cond: [{ $eq: ['$effectiveStatus', 'Overdue'] }, '$balanceDue', 0],
                },
              },
              partiallyPaidAmount: {
                $sum: {
                  $cond: [{ $eq: ['$effectiveStatus', 'Partially Paid'] }, '$balanceDue', 0],
                },
              },
              dueTodayAmount: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$dueDateKey', todayKey] },
                        { $ne: ['$status', 'Paid'] },
                      ],
                    },
                    '$balanceDue',
                    0,
                  ],
                },
              },
            },
          },
        ],
        byPropertyUnit: [
          {
            $group: {
              _id: {
                propertyId: '$propertyId',
                unit: '$normalizedUnit',
              },
              totalDue: { $sum: '$balanceDue' },
              overdueAmount: {
                $sum: {
                  $cond: [{ $eq: ['$effectiveStatus', 'Overdue'] }, '$balanceDue', 0],
                },
              },
            },
          },
        ],
      },
    },
  ])
    .exec()
    .then(([result]) => ({
      byProperty: result?.byProperty || [],
      byPropertyUnit: result?.byPropertyUnit || [],
    }));
};

InvoiceSchema.statics.findFeeSummaryRows = function findFeeSummaryRows(propertyId, options = {}) {
  const { select = { subAmount: 1, alreadyPaid: 1, balanceDue: 1, dueDate: 1, status: 1 }, lean = true } = options;
  let query = this.find({
    propertyId: toObjectId(propertyId),
    isDeleted: { $ne: true },
  }).select(select);

  return lean ? query.lean().exec() : query.exec();
};

InvoiceSchema.statics.findForPropertyDetail = async function findForPropertyDetail(propertyId, options = {}) {
  const { limit = 100, lean = true } = options;
  const propObjId = toObjectId(propertyId);

  let query = this.find({
    propertyId: propObjId,
    isDeleted: { $ne: true },
  })
    .sort({ dueDate: 1 })
    .limit(limit);

  let invoices = lean ? await query.lean().exec() : await query.exec();

  if (!invoices?.length) {
    const Lease = require('../../leasing/model/lease.model');
    const leases = await Lease.findByPropertyId(propertyId);
    const leaseIds = leases.map((l) => l._id).filter(Boolean);
    if (leaseIds.length > 0) {
      query = this.find({
        lease_id: { $in: leaseIds },
        isDeleted: { $ne: true },
      })
        .sort({ dueDate: 1 })
        .limit(limit);
      invoices = lean ? await query.lean().exec() : await query.exec();
    }
  }

  return invoices || [];
};

InvoiceSchema.statics.findOverdueRentByLeaseIds = function findOverdueRentByLeaseIds(leaseIds, options = {}) {
  const { select = { _id: 1, lease_id: 1 }, lean = true } = options;
  if (!leaseIds?.length) return Promise.resolve([]);

  let query = this.find({
    lease_id: { $in: leaseIds.map(toObjectId) },
    status: INVOICE_STATUS.OVERDUE,
    type: INVOICE_TYPES.RENT,
  }).select(select);

  return lean ? query.lean().exec() : query.exec();
};

InvoiceSchema.statics.countForProperty = function countForProperty(propertyId) {
  return this.countDocuments({ propertyId: toObjectId(propertyId) }).exec();
};

module.exports = mongoose.models.HoaBoardInvoice || mongoose.model('HoaBoardInvoice', InvoiceSchema, 'invoices');
