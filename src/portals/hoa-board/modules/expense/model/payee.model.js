/**
 * ------------------------------------------------------------------
 * File: payee.model.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * hoaDataIsolation, payee.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const { addHOADataIsolationHooks } = require('../../../../../middleware/hoaDataIsolation');

const PayeeSchema = new Schema({
  organization: { type: String, trim: true },
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, required: true, trim: true },
  email: { type: String, trim: true },
  phone: { type: String, trim: true },
  category: { type: String, required: true, enum: ['Contractor', 'Insurance', 'Lender', 'Maintenance', 'Management Company', 'Owner', 'Professional', 'PropMv', 'Supplier', 'Tax', 'Uncategorized', 'Utility'] },
  website: { type: String, trim: true },
  addressLine1: { type: String, trim: true },
  addressLine2: { type: String, trim: true },
  city: { type: String, trim: true },
  state: { type: String, trim: true },
  zipCode: { type: String, trim: true },
  secondaryPhone: { type: String, trim: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  hoaBoardMemberId: { type: Schema.Types.ObjectId, ref: 'User' },
  hoaId: { type: Schema.Types.ObjectId, ref: 'HOA', index: true },
  isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

addHOADataIsolationHooks(PayeeSchema);

PayeeSchema.index({ hoaBoardMemberId: 1, isDeleted: 1 });
PayeeSchema.index({ hoaId: 1, isDeleted: 1 });
PayeeSchema.index({ isDeleted: 1, category: 1 });
PayeeSchema.index({ hoaBoardMemberId: 1, email: 1 });

module.exports = mongoose.model('Payee', PayeeSchema);
