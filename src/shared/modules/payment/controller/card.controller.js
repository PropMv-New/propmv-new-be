const { StripeService }   = require('../service/stripe.service');
const StripeCustomer      = require('../model/stripeCustomer.model');
const StripePayment       = require('../model/stripePayment.model');
const Invoice             = require('../../../../portals/hoa-board/modules/invoice/model/invoice.model');
const { INVOICE_STATUS }  = require('../../../../common/constants/invoice');
const { initiateInvoiceProcessingPayment } = require('../../../../portals/hoa-board/modules/invoice/helpers/invoiceProcessingPayment.helper');
const ledgerService = require('../../../../portals/hoa-board/modules/owners/services/ledger.service');
const LedgerEntry = require('../../../../portals/hoa-board/modules/owners/models/ledgerEntry.model');
const logger              = require('../../../../common/logger');
const { ClockService, DateUtil } = require('../../../../common/date');

const stripe = new StripeService();

// ── helpers ───────────────────────────────────────────────────────────────────

// Stripe decline code → user-friendly message
const DECLINE_MESSAGES = {
  card_declined:          'Your card was declined. Please try a different card.',
  insufficient_funds:     'Insufficient funds. Please use a different card.',
  expired_card:           'Your card has expired. Please update your card details.',
  incorrect_cvc:          'Incorrect CVC. Please check your card details.',
  authentication_required:'This card requires authentication. Please use a different card or contact your bank.',
  processing_error:       'A processing error occurred. Please try again.',
};

function parseStripeError(err) {
  const status  = err?.statusCode ?? err?.status ?? 500;
  const code    = err?.raw?.decline_code ?? err?.code ?? null;
  const message = DECLINE_MESSAGES[code] ?? err?.message ?? 'Stripe error';
  const map = {
    400: message,
    401: 'Stripe authentication failed.',
    402: message,
    403: message,
    404: 'Payment method not found.',
    409: message,
    429: 'Too many requests. Please try again shortly.',
  };
  return { status, message: map[status] ?? message, code };
}

async function resolveStripeCustomer(user) {
  let record = await StripeCustomer.findOne({ userId: user._id });
  if (!record) {
    const customer = await stripe.createCustomer({
      name:   [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
      email:  user.email,
      userId: user._id,
    });
    record = await StripeCustomer.create({ userId: user._id, stripeCustomerId: customer.id });
    logger.info('[Card] Created Stripe customer', { userId: user._id, stripeCustomerId: customer.id });
  }
  return record.stripeCustomerId;
}

function shapeCard(pm, defaultPmId) {
  return {
    paymentMethodId: pm.id,
    brand:           pm.card.brand,
    last4:           pm.card.last4,
    expiryMonth:     pm.card.exp_month,
    expiryYear:      pm.card.exp_year,
    funding:         pm.card.funding,
    fingerprint:     pm.card.fingerprint,
    isDefault:       pm.id === defaultPmId,
  };
}

// ── controllers ───────────────────────────────────────────────────────────────

const createSetupIntent = async (req, res, next) => {
  try {
    const stripeCustomerId = await resolveStripeCustomer(req.user);
    const setupIntent      = await stripe.createSetupIntent(stripeCustomerId);
    logger.info('[Card] SetupIntent created', { userId: req.user._id, setupIntentId: setupIntent.id });
    res.json({ success: true, data: { clientSecret: setupIntent.client_secret } });
  } catch (err) {
    const { status, message } = parseStripeError(err);
    logger.error('[Card] createSetupIntent failed', { userId: req.user._id, message });
    res.status(status).json({ success: false, message });
  }
};

const listCards = async (req, res, next) => {
  try {
    const record = await StripeCustomer.findOne({ userId: req.user._id });
    if (!record) return res.json({ success: true, data: [] });

    const { paymentMethods, defaultPmId } = await stripe.listPaymentMethods(record.stripeCustomerId);
    const data = paymentMethods.map(pm => shapeCard(pm, defaultPmId));
    res.json({ success: true, data });
  } catch (err) {
    const { status, message } = parseStripeError(err);
    logger.error('[Card] listCards failed', { userId: req.user._id, message });
    res.status(status).json({ success: false, message });
  }
};

const deleteCard = async (req, res, next) => {
  try {
    const { paymentMethodId } = req.params;
    await stripe.detachPaymentMethod(paymentMethodId);
    logger.info('[Card] PaymentMethod detached', { userId: req.user._id, paymentMethodId });
    res.json({ success: true, message: 'Card removed successfully.' });
  } catch (err) {
    const { status, message } = parseStripeError(err);
    logger.error('[Card] deleteCard failed', { userId: req.user._id, message });
    res.status(status).json({ success: false, message });
  }
};

const setDefaultCard = async (req, res, next) => {
  try {
    const { paymentMethodId } = req.params;
    const record = await StripeCustomer.findOne({ userId: req.user._id });
    if (!record) return res.status(404).json({ success: false, message: 'No Stripe customer found.' });

    await stripe.setDefaultPaymentMethod(record.stripeCustomerId, paymentMethodId);
    logger.info('[Card] Default card updated', { userId: req.user._id, paymentMethodId });
    res.json({ success: true, message: 'Default card updated.' });
  } catch (err) {
    const { status, message } = parseStripeError(err);
    logger.error('[Card] setDefaultCard failed', { userId: req.user._id, message });
    res.status(status).json({ success: false, message });
  }
};

const chargeCard = async (req, res, next) => {
  try {
    const { invoiceId, amount, currency = 'usd', paymentMethodId, description } = req.body;

    // 1. Load Stripe customer
    const record = await StripeCustomer.findOne({ userId: req.user._id });
    if (!record) return res.status(404).json({ success: false, message: 'No Stripe customer found. Please add a card first.' });
    const { stripeCustomerId } = record;

    // 2. Verify PaymentMethod belongs to this customer
    await stripe.verifyPaymentMethodOwnership(stripeCustomerId, paymentMethodId);

    // 3. Load invoice
    const invoice = await Invoice.findOne({ _id: invoiceId, isDeleted: { $ne: true } });
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found.' });
    if (invoice.status === INVOICE_STATUS.PAID) {
      return res.status(409).json({ success: false, message: 'Invoice is already paid.' });
    }

    try {
      await ledgerService.assertOwnerOnlinePaymentAllowed(invoice, amount);
    } catch (validationErr) {
      const status = validationErr.status || validationErr.statusCode || 400;
      return res.status(status).json({ success: false, message: validationErr.message });
    }

    const amountCents = Math.round(amount * 100);
    // Each charge attempt gets a unique idempotency key so partial payments
    // on the same invoice create separate PaymentIntents on Stripe.
    // Format: card_charge_{invoiceId}_{pmId}_{cents}_{epochSeconds}
    const idempotencyKey = `card_charge_${invoiceId}_${paymentMethodId}_${amountCents}_${Math.floor(ClockService.nowEpoch() / 1000)}`;

    // 4. Create & confirm PaymentIntent
    const paymentIntent = await stripe.chargeCard({
      stripeCustomerId,
      paymentMethodId,
      amountCents,
      currency,
      description: description || `Invoice #${invoice.invoiceId} payment`,
      metadata: { invoiceId: String(invoiceId), userId: String(req.user._id) },
      idempotencyKey,
    });

    const chargeId    = paymentIntent.latest_charge ?? null;
    const receiptUrl  = paymentIntent.charges?.data?.[0]?.receipt_url ?? null;
    const piStatus    = paymentIntent.status;

    // 5. Persist StripePayment - use upsert on paymentIntentId so retries
    //    (e.g. network timeout after Stripe succeeded) never throw duplicate key.
    const stripePayment = await StripePayment.findOneAndUpdate(
      { paymentIntentId: paymentIntent.id },
      {
        $setOnInsert: {
          userId:           req.user._id,
          invoiceId:        invoice._id,
          propertyId:       invoice.propertyId,
          hoaId:            invoice.hoaId,
          stripeCustomerId,
          paymentIntentId:  paymentIntent.id,
          chargeId,
          paymentMethodId,
          amount,
          amountCents,
          currency,
          status:           piStatus,
          receiptUrl,
          description:      description || '',
          idempotencyKey,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // 6. Update invoice - mirrors exactly what Straddle does, but since card
    //    charges are synchronous we can go straight to Paid when succeeded.
    if (piStatus === 'succeeded') {
      const newAlreadyPaid = (invoice.alreadyPaid || 0) + amount;
      const newBalanceDue  = Math.max(0, (invoice.balanceDue || 0) - amount);
      const isFullyPaid    = newBalanceDue <= 0.009;
      const newStatus      = isFullyPaid ? INVOICE_STATUS.PAID
        : newAlreadyPaid > 0 ? INVOICE_STATUS.PARTIALLY_PAID
        : invoice.status;

      await Invoice.findOneAndUpdate(
        { _id: invoice._id },
        {
          $set: {
            status:      newStatus,
            alreadyPaid: newAlreadyPaid,
            processingAmount: 0,
            balanceDue:  newBalanceDue,
            paidOn:      isFullyPaid ? ClockService.now() : invoice.paidOn,
            updatedBy:   req.user._id,
          },
          $push: {
            paymentTransactions: {
              amount,
              method:       'card',
              isManual:     false,
              status:       'completed',
              paidBy:       req.user._id,
              note:         `Stripe card payment - ${paymentIntent.id}`,
              balanceAfter: newBalanceDue,
              recordedBy:   req.user._id,
              paidAt:       ClockService.now(),
              recordedAt:   ClockService.now(),
              completedAt:  ClockService.now(),
              gatewayTransactionId: stripePayment._id,
              gatewayExternalId: paymentIntent.id,
            },
          },
        }
      );

      if (invoice.propertyId && amount > 0) {
        const existingLedger = await LedgerEntry.findOne({
          unitId: invoice.propertyId,
          type: 'payment',
          referenceId: invoice._id,
          'metadata.gatewayExternalId': paymentIntent.id,
        }).lean();

        if (!existingLedger) {
          await ledgerService.recordPayment(invoice.propertyId, amount, invoice._id, {
            source: 'stripe_card',
            invoiceId: invoice._id,
            invoiceNumber: invoice.invoiceId,
            paymentMethod: 'card',
            paymentNotes: `Stripe card payment - ${paymentIntent.id}`,
            paidBy: req.user._id,
            balanceAfter: newBalanceDue,
            gatewayExternalId: paymentIntent.id,
          });
          await ledgerService.applyAllUnappliedCreditToDueInvoices(invoice.propertyId);
        }
      }

      logger.info('[Card] Invoice updated after card charge', { invoiceId, newStatus, newBalanceDue });
    } else {
      try {
        await initiateInvoiceProcessingPayment({
          invoiceId: invoice._id,
          amount,
          method: 'card',
          paidBy: req.user._id,
          recordedBy: req.user._id,
          gatewayTransactionId: stripePayment._id,
          gatewayExternalId: paymentIntent.id,
          note: `Stripe card payment pending - ${paymentIntent.id}`,
        });
      } catch (invoiceErr) {
        if (invoiceErr.statusCode === 409) {
          return res.status(409).json({ success: false, message: invoiceErr.message });
        }
        logger.error('[Card] Failed to record processing payment on invoice', {
          invoiceId: invoice._id,
          error: invoiceErr.message,
        });
      }
    }

    logger.info('[Card] chargeCard completed', { userId: req.user._id, paymentIntentId: paymentIntent.id, piStatus });
    res.status(201).json({
      success: true,
      data: {
        paymentIntentId: paymentIntent.id,
        chargeId,
        status:          piStatus,
        amount,
        currency,
        receiptUrl,
        stripePaymentId: stripePayment._id,
      },
    });
  } catch (err) {
    const { status, message, code } = parseStripeError(err);
    logger.error('[Card] chargeCard failed', { userId: req.user?._id, message, code });
    res.status(status).json({ success: false, message, code });
  }
};

module.exports = { createSetupIntent, listCards, deleteCard, setDefaultCard, chargeCard };
