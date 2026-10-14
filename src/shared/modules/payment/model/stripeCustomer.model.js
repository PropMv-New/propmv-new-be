const mongoose = require('mongoose');

const stripeCustomerSchema = new mongoose.Schema({
  userId:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  stripeCustomerId: { type: String, required: true },
}, { timestamps: true });

stripeCustomerSchema.index({ userId: 1 }, { unique: true });

module.exports = mongoose.models.StripeCustomer ||
  mongoose.model('StripeCustomer', stripeCustomerSchema);
