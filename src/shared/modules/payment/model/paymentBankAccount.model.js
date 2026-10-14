/**
 * ------------------------------------------------------------------
 * File: paymentBankAccount.model.js
 * Module: Payment Module
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * property.service, expense.controller, payment.controller
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');

const bankGatewayResultSchema = new mongoose.Schema({
  success:     { type: Boolean, required: true },
  gatewayId:   { type: String },  // bridge / paykey UUID
  paykeyToken: { type: String },  // paykey token used for charges (data.paykey from Straddle)
  status:      { type: String },
  raw:         { type: mongoose.Schema.Types.Mixed },
  error:       { type: String }
}, { _id: false });

const paymentBankAccountSchema = new mongoose.Schema({
  paymentCustomerId: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentCustomer', default: null, index: true },
  straddleAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'StraddleAccount', default: null, index: true },

  holderName:    { type: String, required: true },
  accountType:   { type: String, enum: ['checking', 'savings'], default: 'checking' },
  routingNumber: { type: String, required: true },
  last4:         { type: String },
  verificationStatus: { type: String, enum: ['pending', 'verified'], default: 'pending' },

  straddle:      { type: bankGatewayResultSchema, default: null },
  straddleReady: { type: Boolean, default: false },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }
}, { timestamps: true });

// Prevent duplicate banks from Bridge double-callbacks / concurrent complete-bank-link
paymentBankAccountSchema.index(
  { 'straddle.gatewayId': 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: { 'straddle.gatewayId': { $type: 'string', $gt: '' } },
    name: 'uniq_straddle_gatewayId',
  }
);
paymentBankAccountSchema.index(
  { 'straddle.paykeyToken': 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: { 'straddle.paykeyToken': { $type: 'string', $gt: '' } },
    name: 'uniq_straddle_paykeyToken',
  }
);
paymentBankAccountSchema.index(
  { paymentCustomerId: 1, routingNumber: 1, last4: 1 },
  {
    unique: true,
    partialFilterExpression: {
      paymentCustomerId: { $type: 'objectId' },
      last4: { $type: 'string', $nin: ['', '****'] },
      routingNumber: { $type: 'string', $nin: ['', '000000000'] },
    },
    name: 'uniq_customer_routing_last4',
  }
);

module.exports = mongoose.models.PaymentBankAccount ||
  mongoose.model('PaymentBankAccount', paymentBankAccountSchema);
