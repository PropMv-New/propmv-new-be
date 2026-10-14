const mongoose = require('mongoose');

const stripePaymentSchema = new mongoose.Schema({
  // Payer / context
  userId:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  invoiceId:        { type: mongoose.Schema.Types.ObjectId, ref: 'HoaBoardInvoice', index: true },
  propertyId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Property', index: true },
  hoaId:            { type: mongoose.Schema.Types.ObjectId, ref: 'HOA', index: true },

  // Stripe identifiers
  stripeCustomerId: { type: String, required: true, index: true },
  paymentIntentId:  { type: String, required: true, unique: true },
  chargeId:         { type: String, index: true },
  paymentMethodId:  { type: String, required: true },

  // Financials
  amount:           { type: Number, required: true },   // in dollars (e.g. 125.50)
  amountCents:      { type: Number, required: true },   // in cents  (e.g. 12550)
  currency:         { type: String, default: 'usd' },
  stripeFee:        { type: Number, default: null },    // populated later via reconciliation
  netAmount:        { type: Number, default: null },

  // Status & receipt
  status:           { type: String, required: true },   // succeeded | requires_action | failed
  receiptUrl:       { type: String, default: null },
  description:      { type: String, default: '' },

  // Reconciliation / settlement
  payoutId:         { type: String, default: null },
  settlementStatus: {
    type: String,
    enum: ['PENDING', 'RECONCILED', 'ACH_SENT', 'COMPLETED'],
    default: 'PENDING',
  },

  // Error tracking
  failureCode:      { type: String, default: null },
  failureMessage:   { type: String, default: null },

  // Idempotency
  idempotencyKey:   { type: String, index: true },
}, { timestamps: true });

stripePaymentSchema.index({ invoiceId: 1, status: 1 });

module.exports = mongoose.models.StripePayment ||
  mongoose.model('StripePayment', stripePaymentSchema);
