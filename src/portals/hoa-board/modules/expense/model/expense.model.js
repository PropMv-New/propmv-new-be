/**
 * ------------------------------------------------------------------
 * File: expense.model.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * migrate-expense-status, propertyRelatedQueries, hoaDataIsolation, expense.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const { addHOADataIsolationHooks } = require('../../../../../middleware/hoaDataIsolation');
const { EXPENSE_STATUS_VALUES, EXPENSE_STATUS } = require('../../../../../common/constants/expense');

/**
 * Expense Model with HOA Data Isolation
 * 
 * This model represents expense records with comprehensive HOA Board Member
 * data isolation. Key features:
 * 
 * 1. Multi-item expense support with individual categorization
 * 2. File attachment support for receipts and documentation
 * 3. HOA data isolation fields for ownership tracking
 * 4. Automatic total calculation from expense items
 * 5. Property and unit association for expense categorization
 * 
 * HOA Data Isolation:
 * - createdBy: Tracks which user created the expense
 * - hoaBoardMemberId: Links expense to specific HOA Board Member
 * - Automatic filtering ensures HOA Board Members only see their expenses
 */

const PayeeSchema = new Schema({
  name: { type: String, required: true },
  contact: { type: String },
  phone: { type: String },
  email: { type: String },
  website: { type: String }
}, { _id: false });

// Must match landlord notes shape (shared `expenses` collection; same DB path as landlord portal)
const NoteSchema = new Schema({
  text: { type: String, required: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now }
}, { _id: true });

const CommentSchema = new Schema({
  text: { type: String, required: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now }
}, { _id: true });

const ExpenseItemSchema = new Schema({
  date: { type: Date, required: true },
  category: { type: String, required: true },
  description: { type: String },
  amount: { type: Number, required: true, min: 0 },
  fileDocument: {
    metadataId: { type: Schema.Types.ObjectId, ref: 'DocumentMetadata' },
    originalName: { type: String },
    uploadedAt: { type: Date }
  }
}, { _id: true });

const ExpenseSchema = new Schema({
  // Human-readable unique expense identifier (e.g. EXP123456)
  expenseId: { type: String, sparse: true },

  // Expense Details
  taxableEntity: { type: String, required: true },
  bankAccount: { type: String, required: true },
  property: { type: Schema.Types.ObjectId, ref: 'Property' },
  unitId: { type: Schema.Types.ObjectId },
  unit: { type: String },
  payees: [PayeeSchema],

  // Expense Items Array
  expenseItems: [ExpenseItemSchema],

  // Notes (shared with landlord expenses in the same collection)
  notes: [NoteSchema],
  comments: [CommentSchema],

  // Total
  total: { type: Number, min: 0 },

  // Additional fields for compatibility and tracking
  vendorPaidTo: { type: String }, // Vendor/Paid To
  expenseDate: { type: Date, required: true },
  dueDate: { type: Date, required: true },
  paymentDate: { type: Date },
  // Include landlord values so shared documents validate from either model
  status: { type: String, enum: EXPENSE_STATUS_VALUES, default: EXPENSE_STATUS.PENDING },
  
  // System fields for tracking and HOA data isolation
  hoaId: { type: Schema.Types.ObjectId, ref: 'HOA', index: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' }, // User who created this expense
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' }, // User who last updated this expense
  hoaBoardMemberId: { type: Schema.Types.ObjectId, ref: 'User' }, // HOA Board Member who owns this expense
  isDeleted: { type: Boolean, default: false }, // Soft delete flag

  // Vendor invoice payment → expense linkage (idempotent create key)
  vendorInvoiceId: { type: Schema.Types.ObjectId, ref: 'VendorInvoice' },
  vendorUserId: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

/**
 * expense Item File Document Is Complete
 *
 * Performs logic operations for expenseItemFileDocumentIsComplete.
 *
 * @param fileDocument - Request/input argument
 * @returns Operations result
 */
function expenseItemFileDocumentIsComplete(fileDocument) {
  if (!fileDocument) {
    return false;
  }
  const m = fileDocument.metadataId;
  if (m == null) {
    return false;
  }
  if (typeof m === 'object' && m._id) {
    return true;
  }
  return mongoose.Types.ObjectId.isValid(String(m));
}

// Pre-save middleware to calculate total from expense items
// This ensures the total field is always accurate and up-to-date
ExpenseSchema.pre('save', function (next) {
  if (this.expenseItems && this.expenseItems.length > 0) {
    this.expenseItems.forEach((item) => {
      if (!item.fileDocument) {
        return;
      }
      if (!expenseItemFileDocumentIsComplete(item.fileDocument)) {
        item.set('fileDocument', undefined);
      }
    });
  }
  if (this.expenseItems && this.expenseItems.length > 0) {
    this.total = this.expenseItems.reduce((sum, item) => sum + (item.amount || 0), 0);
  }
  
  // Auto-set status based on dueDate if not paid or partially paid
  if (this.status !== EXPENSE_STATUS.PAID && this.status !== EXPENSE_STATUS.PARTIALLY_PAID && this.dueDate) {
    const now = new Date();
    const dueDate = new Date(this.dueDate);

    if (dueDate < now) {
      this.status = EXPENSE_STATUS.OVERDUE;
    } else {
      this.status = EXPENSE_STATUS.PENDING;
    }
  }

  next();
});

// Add HOA data isolation hooks for automatic filtering and ownership setting
// These hooks ensure HOA Board Members can only access their own expense records
addHOADataIsolationHooks(ExpenseSchema);

ExpenseSchema.index({ property: 1, isDeleted: 1, expenseDate: -1 });
ExpenseSchema.index({ hoaId: 1, isDeleted: 1, expenseDate: -1 });
ExpenseSchema.index({ hoaBoardMemberId: 1, isDeleted: 1, expenseDate: -1 });
ExpenseSchema.index({ isDeleted: 1, status: 1, dueDate: 1 });
ExpenseSchema.index({ isDeleted: 1, createdAt: -1 });
ExpenseSchema.index(
  { vendorInvoiceId: 1 },
  { unique: true, sparse: true, partialFilterExpression: { vendorInvoiceId: { $type: 'objectId' } } }
);

const { toObjectId } = require('../../../../../common/db/mongooseHelpers');

ExpenseSchema.statics.countForProperty = function countForProperty(propertyId) {
  return this.countDocuments({ property: toObjectId(propertyId) }).exec();
};

// Distinct model name from LandlordExpense - both target the same `expenses` collection.
const EXPENSE_COLLECTION = 'expenses';
module.exports =
  mongoose.models.HoaExpense ||
  mongoose.model('HoaExpense', ExpenseSchema, EXPENSE_COLLECTION);
