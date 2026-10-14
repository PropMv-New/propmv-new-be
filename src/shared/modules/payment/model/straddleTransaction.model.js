/**
 * ------------------------------------------------------------------
 * File: straddleTransaction.model.js
 * Module: Payment Module
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * seedLeaseInvoicePayments, seedPaymentTransactions, verifyPaymentData, payment.controller
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');

const straddleTransactionSchema = new mongoose.Schema({
  straddleId:  { type: String, required: true, unique: true },
  type:        { type: String, enum: ['charge', 'payout'], required: true },
  amount:      { type: Number, required: true },
  currency:    { type: String, default: 'usd' },
  paykeyId:    { type: String },
  accountId:   { type: String, index: true }, // Straddle account_id from webhook
  invoiceId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', index: true }, // Reference to invoice
  leaseId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Lease', index: true }, // Reference to lease
  description: { type: String },
  status:      { type: String },
  metadata:    { type: mongoose.Schema.Types.Mixed, default: {} },
  raw:         { type: mongoose.Schema.Types.Mixed },
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

module.exports = mongoose.models.StraddleTransaction ||
  mongoose.model('StraddleTransaction', straddleTransactionSchema);
