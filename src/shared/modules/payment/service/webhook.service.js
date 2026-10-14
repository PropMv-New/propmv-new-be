/**
 * ------------------------------------------------------------------
 * File: webhook.service.js
 * Module: Payment Module
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * webhook.controller
 * ------------------------------------------------------------------
 */

const PaymentStatus = require('../model/paymentStatus.model');
const StraddleTransaction = require('../model/straddleTransaction.model');
const StraddleWebhookEventResponse = require('../model/straddleWebhookEventResponse.model');
const logger = require('../../../../common/logger');
const { ClockService, DateUtil } = require('../../../../common/date');

/**
 * WebhookService
 *
 * Represents the Webhook Service controller/model class.
 */
class WebhookService {
  async processPaymentStatusEvent(payload) {
    const { event_id, event_type, account_id, data } = payload;

    if (!event_id || !event_type || !data) {
      throw new Error('Invalid webhook payload structure');
    }

    // Record raw webhook into StraddleWebhookEventResponse collection for auditing
    try {
      const eventKey = event_id || `${event_type}-${data?.id || ClockService.nowEpoch()}`;
      await StraddleWebhookEventResponse.create({
        event: eventKey,
        account_id: account_id,
        event_type: payload.event_type,
        response: payload
      });
    } catch (err) {
      // Log but do not block processing on audit store failures
      logger.warn('[Webhook] Failed to persist raw webhook event response', { error: err.message });
    }

    const existingEvent = await PaymentStatus.findOne({ event_id });
    if (existingEvent) {
      logger.info('[Webhook] Duplicate event ignored', { eventId: event_id });
      return { duplicate: true, event: existingEvent };
    }

    let paymentStatus;
    try {
      paymentStatus = await PaymentStatus.create({
        event_id,
        eventId: event_id,
        event_type,
        account_id,
        data: {
          id: data.id,
          amount: data.amount,
          currency: data.currency,
          description: data.description,
          status: data.status,
          paykey: data.paykey,
          paykey_details: data.paykey_details,
          customer_details: data.customer_details,
          status_details: data.status_details,
          status_history: data.status_history,
          payment_rail: data.payment_rail,
          consent_type: data.consent_type,
          effective_at: data.effective_at,
          payment_date: data.payment_date,
          processed_at: data.processed_at,
          external_id: data.external_id,
          funding_ids: data.funding_ids,
          related_payments: data.related_payments,
          is_refund: data.is_refund,
          is_resubmit: data.is_resubmit,
          has_resubmit: data.has_resubmit,
          device: data.device,
          config: data.config,
          created_at: data.created_at,
          updated_at: data.updated_at,
          metadata: data.metadata || {}
        },
        rawPayload: payload
      });
    } catch (err) {
      if (err && err.name === 'ValidationError') {
        // Save without validation to avoid rejecting unknown enum values from webhook payloads
        logger.warn('[Webhook] PaymentStatus validation failed, saving without validation', { error: err.message });
        const doc = new PaymentStatus({
          event_id,
          eventId: event_id,
          event_type,
          account_id,
          data: payload.data || {},
          rawPayload: payload
        });
        // disable validation on save
        paymentStatus = await doc.save({ validateBeforeSave: false });
      } else {
        throw err;
      }
    }

    await this.updateTransactionStatus(data.id, data.status);
    
    // Create or update Straddle transaction with invoice/lease linking
    await this.createOrUpdateStraddleTransaction(payload, data.id, 'payout');

    logger.info('[Webhook] Payment status processed', {
      eventId: event_id,
      accountId: account_id,
      payoutId: data.id,
      status: data.status,
      amount: data.amount,
      paykey: data.paykey
    });

    return { duplicate: false, event: paymentStatus };
  }

  async updateTransactionStatus(straddleId, status) {
    const transaction = await StraddleTransaction.findOne({ straddleId });
    if (transaction) {
      transaction.status = status;
      await transaction.save();
      logger.info('[Webhook] Transaction updated', { straddleId, status });
    }
  }

  /**
   * Create or update Straddle transaction with invoice/lease linking
   * @param {Object} payload - Webhook payload with account_id and data
   * @param {String} straddleId - Straddle transaction ID
   * @param {String} type - Transaction type (charge/payout)
   * @returns {Promise<Object>} Created/updated transaction
   */
  async createOrUpdateStraddleTransaction(payload, straddleId, type) {
    const { account_id, data } = payload;
    
    // Extract invoice/lease reference from metadata if available
    const metadata = data?.metadata || {};
    const invoiceId = metadata.invoiceId || metadata.invoice_id;
    const leaseId = metadata.leaseId || metadata.lease_id;

    const transactionData = {
      straddleId,
      type,
      amount: data?.amount || 0,
      currency: data?.currency || 'usd',
      paykeyId: data?.paykey,
      accountId: account_id,
      invoiceId: invoiceId || undefined,
      leaseId: leaseId || undefined,
      description: data?.description,
      status: data?.status,
      metadata: data?.metadata || {},
      raw: payload
    };

    try {
      const transaction = await StraddleTransaction.findOneAndUpdate(
        { straddleId },
        { $set: transactionData },
        { upsert: true, new: true, runValidators: false }
      );
      
      logger.info('[Webhook] Straddle transaction created/updated', {
        straddleId,
        type,
        accountId: account_id,
        invoiceId,
        leaseId,
        status: data?.status
      });
      
      return transaction;
    } catch (err) {
      logger.error('[Webhook] Failed to create/update Straddle transaction', {
        straddleId,
        error: err.message
      });
      throw err;
    }
  }

  async processAccountCreateEvent(payload) {
    const { event_id } = payload;

    if (!event_id) {
      throw new Error('Invalid account.create webhook payload: missing event_id');
    }

    try {
      await StraddleWebhookEventResponse.create({ event: event_id, account_id: payload.account_id, event_type: payload.event_type, response: payload });
      logger.info('[Webhook] Account create event persisted', { eventId: event_id });
    } catch (err) {
      logger.warn('[Webhook] Failed to persist account create event', { eventId: event_id, error: err.message });
    }
  }

  async processAccountEvent(payload) {
    const { event_id } = payload;

    if (!event_id) {
      throw new Error('Invalid account event webhook payload: missing event_id');
    }

    try {
      await StraddleWebhookEventResponse.create({ event: event_id, account_id: payload.account_id, event_type: payload.event_type, response: payload });
      logger.info('[Webhook] Account event persisted', { eventId: event_id });
    } catch (err) {
      logger.warn('[Webhook] Failed to persist account event', { eventId: event_id, error: err.message });
    }
  }

  async processCapabilityRequest(payload) {
    const { event_id } = payload;

    if (!event_id) {
      throw new Error('Invalid capability request webhook payload: missing event_id');
    }

    try {
      await StraddleWebhookEventResponse.create({ event: event_id, account_id: payload.account_id, event_type: payload.event_type, response: payload });
      logger.info('[Webhook] Capability request persisted', { eventId: event_id });
    } catch (err) {
      logger.warn('[Webhook] Failed to persist capability request', { eventId: event_id, error: err.message });
    }
  }

  async processCapabilityEvent(payload) {
    const { event_id } = payload;

    if (!event_id) {
      throw new Error('Invalid capability event webhook payload: missing event_id');
    }

    try {
      await StraddleWebhookEventResponse.create({ event: event_id, account_id: payload.account_id, event_type: payload.event_type, response: payload });
      logger.info('[Webhook] Capability event persisted', { eventId: event_id });
    } catch (err) {
      logger.warn('[Webhook] Failed to persist capability event', { eventId: event_id, error: err.message });
    }
  }

  async processChargeCreate(payload) {
    const { event_id } = payload;

    if (!event_id) {
      throw new Error('Invalid charge.create webhook payload: missing event_id');
    }

    try {
      await StraddleWebhookEventResponse.create({ event: event_id, account_id: payload.account_id, event_type: payload.event_type, response: payload });
      logger.info('[Webhook] Charge create persisted', { eventId: event_id });
    } catch (err) {
      logger.warn('[Webhook] Failed to persist charge create', { eventId: event_id, error: err.message });
    }
  }

  async processChargeEvent(payload) {
    const { event_id, data } = payload;

    if (!event_id) {
      throw new Error('Invalid charge event webhook payload: missing event_id');
    }

    try {
      await StraddleWebhookEventResponse.create({ event: event_id, account_id: payload.account_id, event_type: payload.event_type, response: payload });
      logger.info('[Webhook] Charge event persisted', { eventId: event_id });
    } catch (err) {
      logger.warn('[Webhook] Failed to persist charge event', { eventId: event_id, error: err.message });
    }

    const straddleId = data?.id;
    if (!straddleId) return;

    await this.updateTransactionStatus(straddleId, data.status);

    let straddleTx = null;
    try {
      straddleTx = await this.createOrUpdateStraddleTransaction(payload, straddleId, 'charge');
    } catch (err) {
      logger.error('[Webhook] Failed to upsert charge transaction', { straddleId, error: err.message });
    }

    try {
      const {
        settleInvoiceGatewayPayment,
        failInvoiceGatewayPayment,
        isGatewayPaymentSettledStatus,
        isGatewayPaymentFailedStatus,
      } = require('../../../../portals/hoa-board/modules/invoice/helpers/invoiceProcessingPayment.helper');

      const metadata = data?.metadata || {};
      const invoiceId = metadata.invoiceId || metadata.invoice_id || straddleTx?.invoiceId;
      const settlementPayload = {
        straddleId,
        status: data.status,
        invoiceId,
        gatewayTransactionId: straddleTx?._id,
        completedAt: data.processed_at || data.updated_at,
      };

      if (isGatewayPaymentSettledStatus(data.status)) {
        const result = await settleInvoiceGatewayPayment(settlementPayload);
        logger.info('[Webhook] Invoice gateway settlement', { straddleId, ...result });
      } else if (isGatewayPaymentFailedStatus(data.status)) {
        const result = await failInvoiceGatewayPayment({
          straddleId,
          invoiceId,
          gatewayTransactionId: straddleTx?._id,
          failedAt: data.updated_at,
        });
        logger.info('[Webhook] Invoice gateway payment failed', { straddleId, ...result });
      }
    } catch (err) {
      logger.error('[Webhook] Invoice settlement handler failed', { straddleId, error: err.message });
    }
  }

  async processCustomerCreate(payload) {
    const { event_id, data } = payload;

    if (!event_id) {
      throw new Error('Invalid customer.create webhook payload: missing event_id');
    }

    try {
      await StraddleWebhookEventResponse.create({ event: event_id, account_id: payload.account_id, event_type: payload.event_type, response: payload });
      const { applyCustomerStatusFromWebhook } = require('../controller/payment.controller');
      await applyCustomerStatusFromWebhook(data?.id || payload.customer_id, data || {});
      logger.info('[Webhook] Customer create persisted + applied', { eventId: event_id, customerId: data?.id });
    } catch (err) {
      logger.warn('[Webhook] Failed to persist customer create', { eventId: event_id, error: err.message });
    }
  }

  async processCustomerEvent(payload) {
    const { event_id, data } = payload;

    if (!event_id) {
      throw new Error('Invalid customer event webhook payload: missing event_id');
    }

    try {
      await StraddleWebhookEventResponse.create({ event: event_id, account_id: payload.account_id, event_type: payload.event_type, response: payload });
      const { applyCustomerStatusFromWebhook } = require('../controller/payment.controller');
      await applyCustomerStatusFromWebhook(data?.id || payload.customer_id, data || {});
      logger.info('[Webhook] Customer event persisted + applied', { eventId: event_id, customerId: data?.id, status: data?.status });
    } catch (err) {
      logger.warn('[Webhook] Failed to persist customer event', { eventId: event_id, error: err.message });
    }
  }

  async processFundingEventCreate(payload) {
    const { event_id } = payload;

    if (!event_id) {
      throw new Error('Invalid funding event create webhook payload: missing event_id');
    }

    try {
      await StraddleWebhookEventResponse.create({ event: event_id, account_id: payload.account_id, event_type: payload.event_type, response: payload });
      logger.info('[Webhook] Funding event create persisted', { eventId: event_id });
    } catch (err) {
      logger.warn('[Webhook] Failed to persist funding event create', { eventId: event_id, error: err.message });
    }
  }

  async processFundingEventEvent(payload) {
    const { event_id } = payload;

    if (!event_id) {
      throw new Error('Invalid funding event event webhook payload: missing event_id');
    }

    try {
      await StraddleWebhookEventResponse.create({ event: event_id, account_id: payload.account_id, event_type: payload.event_type, response: payload });
      logger.info('[Webhook] Funding event event persisted', { eventId: event_id });
    } catch (err) {
      logger.warn('[Webhook] Failed to persist funding event event', { eventId: event_id, error: err.message });
    }
  }

  async processLinkedBankAccountCreate(payload) {
    const { event_id } = payload;

    if (!event_id) {
      throw new Error('Invalid linked bank account create webhook payload: missing event_id');
    }

    try {
      await StraddleWebhookEventResponse.create({ event: event_id, account_id: payload.account_id, event_type: payload.event_type, response: payload });
      logger.info('[Webhook] Linked bank account create persisted', { eventId: event_id });
    } catch (err) {
      logger.warn('[Webhook] Failed to persist linked bank account create', { eventId: event_id, error: err.message });
    }
  }

  async processLinkedBankAccountEvent(payload) {
    const { event_id } = payload;

    if (!event_id) {
      throw new Error('Invalid linked bank account event webhook payload: missing event_id');
    }

    try {
      await StraddleWebhookEventResponse.create({ event: event_id, account_id: payload.account_id, event_type: payload.event_type, response: payload });
      logger.info('[Webhook] Linked bank account event persisted', { eventId: event_id });
    } catch (err) {
      logger.warn('[Webhook] Failed to persist linked bank account event', { eventId: event_id, error: err.message });
    }
  }

  async processPaykeyCreate(payload) {
    const { event_id } = payload;

    if (!event_id) {
      throw new Error('Invalid paykey.create webhook payload: missing event_id');
    }

    try {
      await StraddleWebhookEventResponse.create({ event: event_id, account_id: payload.account_id, event_type: payload.event_type, response: payload });
      logger.info('[Webhook] Paykey create persisted', { eventId: event_id });
    } catch (err) {
      logger.warn('[Webhook] Failed to persist paykey create', { eventId: event_id, error: err.message });
    }

    await this.applyPaykeyStatusToBankAccount(payload);
  }

  async processPaykeyEvent(payload) {
    const { event_id } = payload;

    if (!event_id) {
      throw new Error('Invalid paykey event webhook payload: missing event_id');
    }

    try {
      await StraddleWebhookEventResponse.create({ event: event_id, account_id: payload.account_id, event_type: payload.event_type, response: payload });
      logger.info('[Webhook] Paykey event persisted', { eventId: event_id });
    } catch (err) {
      logger.warn('[Webhook] Failed to persist paykey event', { eventId: event_id, error: err.message });
    }

    await this.applyPaykeyStatusToBankAccount(payload);
  }

  /**
   * Apply paykey.created / paykey.event status onto local PaymentBankAccount (owner banks).
   */
  async applyPaykeyStatusToBankAccount(payload) {
    const data = payload?.data || {};
    const paykeyId = data.id || data.paykey_id || null;
    const paykeyToken = data.paykey || null;
    if (!paykeyId && !paykeyToken) {
      logger.warn('[Webhook] Paykey event missing id/paykey - skip bank update');
      return;
    }

    try {
      const PaymentBankAccount = require('../model/paymentBankAccount.model');
      const or = [];
      if (paykeyId) or.push({ 'straddle.gatewayId': paykeyId });
      if (paykeyToken) or.push({ 'straddle.paykeyToken': paykeyToken });

      const account = await PaymentBankAccount.findOne({ $or: or });
      if (!account) {
        logger.info('[Webhook] No local bank for paykey event', { paykeyId });
        return;
      }

      const status = data.status || account.straddle?.status;
      const isReady = ['active', 'verified'].includes(String(status || '').toLowerCase());
      const bankData = data.bank_data || data.bank_account || {};
      const maskedAccount = String(bankData.account_number || '');
      const last4 = maskedAccount.replace(/\D/g, '').slice(-4);

      account.straddle = {
        success: true,
        gatewayId: paykeyId || account.straddle?.gatewayId,
        paykeyToken: paykeyToken || account.straddle?.paykeyToken || null,
        status,
        raw: data,
      };
      account.straddleReady = isReady;
      if (isReady) account.verificationStatus = 'verified';
      if (last4) account.last4 = last4;
      if (bankData.routing_number) {
        account.routingNumber = String(bankData.routing_number).replace(/\D/g, '').slice(0, 9);
      }
      await account.save();
      logger.info('[Webhook] Bank account status updated from paykey event', {
        bankId: account._id,
        paykeyId,
        status,
      });
    } catch (err) {
      logger.warn('[Webhook] Failed to apply paykey status to bank', { error: err.message, paykeyId });
    }
  }

  async processPayoutCreate(payload) {
    const { event_id } = payload;

    if (!event_id) {
      throw new Error('Invalid payout.create webhook payload: missing event_id');
    }

    try {
      await StraddleWebhookEventResponse.create({ event: event_id, account_id: payload.account_id, event_type: payload.event_type, response: payload });
      logger.info('[Webhook] Payout create persisted', { eventId: event_id });
    } catch (err) {
      logger.warn('[Webhook] Failed to persist payout create', { eventId: event_id, error: err.message });
    }
  }

  async processPayoutEvent(payload) {
    const { event_id } = payload;

    if (!event_id) {
      throw new Error('Invalid payout.event webhook payload: missing event_id');
    }

    try {
      await StraddleWebhookEventResponse.create({ event: event_id, account_id: payload.account_id, event_type: payload.event_type, response: payload });
      logger.info('[Webhook] Payout event persisted', { eventId: event_id });
      
      // Create or update Straddle transaction with invoice/lease linking
      if (payload.data?.id) {
        await this.createOrUpdateStraddleTransaction(payload, payload.data.id, 'payout');
      }
    } catch (err) {
      logger.warn('[Webhook] Failed to persist payout event', { eventId: event_id, error: err.message });
    }
  }

  async processRepresentativeCreate(payload) {
    const { event_id } = payload;

    if (!event_id) {
      throw new Error('Invalid representative.create webhook payload: missing event_id');
    }

    try {
      await StraddleWebhookEventResponse.create({ event: event_id, account_id: payload.account_id, event_type: payload.event_type, response: payload });
      logger.info('[Webhook] Representative create persisted', { eventId: event_id });
    } catch (err) {
      logger.warn('[Webhook] Failed to persist representative create', { eventId: event_id, error: err.message });
    }
  }

  async processRepresentativeEvent(payload) {
    const { event_id } = payload;

    if (!event_id) {
      throw new Error('Invalid representative.event webhook payload: missing event_id');
    }

    try {
      await StraddleWebhookEventResponse.create({ event: event_id, account_id: payload.account_id, event_type: payload.event_type, response: payload });
      logger.info('[Webhook] Representative event persisted', { eventId: event_id });
    } catch (err) {
      logger.warn('[Webhook] Failed to persist representative event', { eventId: event_id, error: err.message });
    }
  }
}

module.exports = { WebhookService };
