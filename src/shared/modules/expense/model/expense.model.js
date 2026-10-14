/**
 * ------------------------------------------------------------------
 * File: expense.model.js
 * Module: Expense Module
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * migrate-expense-status, landlordDataIsolation, roleBasedDataIsolation, expense.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const { EXPENSE_STATUS_VALUES, EXPENSE_STATUS } = require('../../../../common/constants/expense');

const PayeeSchema = new Schema({
  name: { type: String, required: true },
  contact: { type: String },
  phone: { type: String },
  email: { type: String },
  website: { type: String }
}, { _id: false });

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
    // No default: only set when a real receipt is saved (avoids empty { fileDocument: { uploadedAt } } rows)
    uploadedAt: { type: Date }
  }
}, { _id: true });

const ExpenseSchema = new Schema({
  // Expense Details
  taxableEntity: { type: String, required: true },
  bankAccount: { type: String, required: true },
  property: { type: Schema.Types.ObjectId, ref: 'Property', required: true },
  unitId: { type: Schema.Types.ObjectId },
  payees: [PayeeSchema],
  
  // Expense Items Array
  expenseItems: [ExpenseItemSchema],
  
  // Notes
  notes: [NoteSchema],
  comments: [CommentSchema],
  
  // Total
  total: { type: Number, min: 0 },
  
  // Additional fields for compatibility and tracking
  vendorPaidTo: { type: String }, // Vendor/Paid To
  expenseDate: { type: Date, required: true },
  dueDate: { type: Date, required: true },
  paymentDate: { type: Date },
  status: { type: String, enum: EXPENSE_STATUS_VALUES, default: EXPENSE_STATUS.PENDING },
  
  // System fields
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  isDeleted: { type: Boolean, default: false }
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

// Pre-save: drop incomplete fileDocument (no metadataId) so we never persist placeholder subdocs
ExpenseSchema.pre('save', function(next) {
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
  next();
});

// Distinct model name so HOA's Expense schema cannot overwrite this schema (both use `expenses` collection).
const EXPENSE_COLLECTION = 'expenses';
module.exports =
  mongoose.models.LandlordExpense ||
  mongoose.model('LandlordExpense', ExpenseSchema, EXPENSE_COLLECTION);
