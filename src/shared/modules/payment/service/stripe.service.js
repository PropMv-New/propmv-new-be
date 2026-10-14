const Stripe = require('stripe');
const logger = require('../../../../common/logger');
const { ClockService, DateUtil } = require('../../../../common/date');

class StripeService {
  constructor() {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
  }

  // ── Customer ──────────────────────────────────────────────────────────────

  async createCustomer({ name, email, userId }) {
    logger.info('[Stripe] createCustomer', { email });
    return this.stripe.customers.create({
      name,
      email,
      metadata: { userId: String(userId) },
    });
  }

  async getCustomer(stripeCustomerId) {
    return this.stripe.customers.retrieve(stripeCustomerId);
  }

  // ── SetupIntent ───────────────────────────────────────────────────────────

  async createSetupIntent(stripeCustomerId) {
    logger.info('[Stripe] createSetupIntent', { stripeCustomerId });
    return this.stripe.setupIntents.create({
      customer:             stripeCustomerId,
      usage:                'off_session',
      payment_method_types: ['card'],
    }, {
      idempotencyKey: `si_${stripeCustomerId}_${ClockService.nowEpoch()}`,
    });
  }

  // ── PaymentMethods ────────────────────────────────────────────────────────

  async listPaymentMethods(stripeCustomerId) {
    logger.info('[Stripe] listPaymentMethods', { stripeCustomerId });
    const [pmList, customer] = await Promise.all([
      this.stripe.paymentMethods.list({ customer: stripeCustomerId, type: 'card' }),
      this.stripe.customers.retrieve(stripeCustomerId),
    ]);
    const defaultPmId = customer.invoice_settings?.default_payment_method ?? null;
    return { paymentMethods: pmList.data, defaultPmId };
  }

  async detachPaymentMethod(paymentMethodId) {
    logger.info('[Stripe] detachPaymentMethod', { paymentMethodId });
    return this.stripe.paymentMethods.detach(paymentMethodId);
  }

  async setDefaultPaymentMethod(stripeCustomerId, paymentMethodId) {
    logger.info('[Stripe] setDefaultPaymentMethod', { stripeCustomerId, paymentMethodId });
    return this.stripe.customers.update(stripeCustomerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
  }

  // ── Charge saved card ─────────────────────────────────────────────────────

  async verifyPaymentMethodOwnership(stripeCustomerId, paymentMethodId) {
    const pm = await this.stripe.paymentMethods.retrieve(paymentMethodId);
    if (pm.customer !== stripeCustomerId) {
      const err = new Error('PaymentMethod does not belong to this customer.');
      err.statusCode = 403;
      throw err;
    }
    return pm;
  }

  async chargeCard({ stripeCustomerId, paymentMethodId, amountCents, currency = 'usd', description, metadata = {}, idempotencyKey }) {
    logger.info('[Stripe] chargeCard', { stripeCustomerId, amountCents, paymentMethodId });
    return this.stripe.paymentIntents.create({
      amount:          amountCents,
      currency,
      customer:        stripeCustomerId,
      payment_method:  paymentMethodId,
      confirm:         true,
      off_session:     true,
      automatic_payment_methods: { enabled: false },
      payment_method_types: ['card'],
      description,
      metadata,
    }, {
      idempotencyKey: idempotencyKey || `charge_${paymentMethodId}_${amountCents}_${ClockService.nowEpoch()}`,
    });
  }
}

module.exports = { StripeService };
