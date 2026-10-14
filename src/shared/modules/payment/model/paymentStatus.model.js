/**
 * ------------------------------------------------------------------
 * File: paymentStatus.model.js
 * Module: Payment Module
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * seedLeaseInvoicePayments, seedPaymentTransactions, verifyPaymentData, webhook.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');

const paymentStatusSchema = new mongoose.Schema({
  // Top-level webhook fields
  event_id: { type: String, required: true, unique: true, index: true },
  event_type: { type: String, required: true },
  account_id: { type: String, index: true },
  
  // data object fields - exact snake_case from Straddle
  data: {
    id: { type: String, required: true, index: true },
    amount: { type: Number },
    currency: { type: String, default: 'usd' },
    description: { type: String },
    status: { 
      type: String, 
      required: true,
      enum: ['created', 'scheduled', 'pending', 'paid', 'failed', 'cancelled', 'on_hold', 'reversed'],
      index: true
    },
    paykey: { type: String, index: true },
    paykey_details: { type: mongoose.Schema.Types.Mixed },
    customer_details: { type: mongoose.Schema.Types.Mixed },
    status_details: { type: mongoose.Schema.Types.Mixed },
    status_history: [{ type: mongoose.Schema.Types.Mixed }],
    payment_rail: { type: String },
    consent_type: { type: String },
    effective_at: { type: Date },
    payment_date: { type: String },
    processed_at: { type: Date },
    external_id: { type: String },
    funding_ids: [{ type: String }],
    related_payments: [{ type: mongoose.Schema.Types.Mixed }],
    is_refund: { type: Boolean },
    is_resubmit: { type: Boolean },
    has_resubmit: { type: Boolean },
    device: { type: mongoose.Schema.Types.Mixed },
    config: { type: mongoose.Schema.Types.Mixed },
    created_at: { type: Date },
    updated_at: { type: Date },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  
  // Store complete raw payload as backup
  rawPayload: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });

paymentStatusSchema.index({ 'data.id': 1, 'data.status': 1 });
paymentStatusSchema.index({ account_id: 1, 'data.status': 1 });
paymentStatusSchema.index({ 'data.paykey': 1 });
paymentStatusSchema.index({ createdAt: -1 });

module.exports = mongoose.models.PaymentStatus || mongoose.model('PaymentStatus', paymentStatusSchema);
