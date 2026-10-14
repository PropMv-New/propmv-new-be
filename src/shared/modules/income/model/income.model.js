/**
 * ------------------------------------------------------------------
 * File: income.model.js
 * Module: Income Module
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * income.service, landlordPortalEventEmail.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const IncomeSchema = new Schema({
  incomeId: { type: String, unique: true, required: true },
  type: { 
    type: String, 
    enum: ['Rent', 'Deposit', 'Late Fee', 'Pet Fee', 'Parking Fee', 'Other'], 
    required: true 
  },
  propertyId: { type: Schema.Types.ObjectId, ref: 'Property', required: true },
  unit: { type: String, required: true },
  tenants: [{ type: Schema.Types.ObjectId, ref: 'User', required: true }],
  amount: { type: Number, required: true, min: 0 },
  description: { type: String, required: true },
  dueDate: { type: Date, required: true },
  receivedDate: { type: Date },
  status: { 
    type: String, 
    enum: ['Pending', 'Received', 'Overdue'], 
    default: 'Pending' 
  },
  invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
  paymentMethod: { type: String },
  notes: { type: String },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

// Auto-generate incomeId if not provided
IncomeSchema.pre('save', async function(next) {
  if (this.isNew && !this.incomeId) {
    let unique = false;
    while (!unique) {
      const randomNum = Math.floor(100000 + Math.random() * 900000);
      this.incomeId = `INC${randomNum}`;
      const exists = await mongoose.models.Income.findOne({ incomeId: this.incomeId, isDeleted: { $ne: true } });
      if (!exists) unique = true;
    }
  }
  next();
});

module.exports = mongoose.models.Income || mongoose.model('Income', IncomeSchema);