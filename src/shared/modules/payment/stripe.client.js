/**
 * ------------------------------------------------------------------
 * File: stripe.client.js
 * Module: Payment Module
 *
 * Purpose:
 * Backend utility/module providing helper functions for stripe.client.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const Stripe = require('stripe');

/**
 * StripeService
 *
 * Represents the Stripe Service controller/model class.
 */
class StripeService {
  constructor() {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }

  async createCustomer(data) {
    return this.stripe.customers.create({
      name:  data.name,
      email: data.email,
      phone: data.phone
    });
  }

  // Attach a bank account (ACH) to a Stripe customer via bank account token
  async attachBankAccount(customerId, bankAccountToken) {
    return this.stripe.customers.createSource(customerId, {
      source: bankAccountToken
    });
  }

  // Update bank account holder name / account type on an existing source
  async updateBankAccount(customerId, bankAccountId, updates) {
    return this.stripe.customers.updateSource(customerId, bankAccountId, updates);
  }

  // Verify micro-deposits for a bank account
  async verifyBankAccount(customerId, bankAccountId, amounts) {
    return this.stripe.customers.verifySource(customerId, bankAccountId, {
      amounts
    });
  }

  async charge(data) {
    return this.stripe.paymentIntents.create({
      amount:         data.amount,
      currency:       'usd',
      customer:       data.customerId,
      payment_method: data.paymentMethodId,
      confirm:        true
    });
  }

  async payout(data) {
    return this.stripe.transfers.create({
      amount:      data.amount,
      currency:    'usd',
      destination: data.connectedAccountId
    });
  }
}

module.exports = { StripeService };
