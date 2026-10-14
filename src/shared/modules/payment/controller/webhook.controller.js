/**
 * ------------------------------------------------------------------
 * File: webhook.controller.js
 * Module: Payment Module
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * webhook.routes
 * ------------------------------------------------------------------
 */

const { WebhookService } = require('../service/webhook.service');
const logger = require('../../../../common/logger');

const webhookService = new WebhookService();

const handlePaymentStatusWebhook = async (req, res, next) => {
  try {
    const payload = req.body;

    logger.info('[Webhook] Payment status received', {
      eventId: payload.event_id,
      eventType: payload.event_type,
      payoutId: payload.data?.id
    });

    if (payload.event_type !== 'payout.event.v1') {
      logger.warn('[Webhook] Unsupported event type', { eventType: payload.event_type });
      return res.status(200).json({ received: true, message: 'Event type not handled' });
    }

    const result = await webhookService.processPaymentStatusEvent(payload);

    if (result.duplicate) {
      return res.status(200).json({ received: true, message: 'Duplicate event' });
    }

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('[Webhook] Processing failed', {
      eventId: req.body?.event_id,
      error: err.message,
      stack: err.stack
    });
    next(err);
  }
};

const handleAccountCreateWebhook = async (req, res, next) => {
  try {
    const payload = req.body;

    logger.info('[Webhook] Account create received', {
      eventId: payload.event_id,
      eventType: payload.event_type,
      accountId: payload.account_id
    });

    if (payload.event_type !== 'account.created.v1') {
      logger.warn('[Webhook] Unsupported event type for account-create', { eventType: payload.event_type });
      return res.status(200).json({ received: true, message: 'Event type not handled' });
    }

    // process and persist raw payload
    await webhookService.processAccountCreateEvent(payload);

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('[Webhook] Account create processing failed', {
      eventId: req.body?.event_id,
      error: err.message,
      stack: err.stack
    });
    next(err);
  }
};

const handleAccountEventWebhook = async (req, res, next) => {
  try {
    const payload = req.body;

    logger.info('[Webhook] Account event received', {
      eventId: payload.event_id,
      eventType: payload.event_type,
      accountId: payload.account_id
    });

    if (payload.event_type !== 'account.event.v1') {
      logger.warn('[Webhook] Unsupported event type for account-event', { eventType: payload.event_type });
      return res.status(200).json({ received: true, message: 'Event type not handled' });
    }

    await webhookService.processAccountEvent(payload);

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('[Webhook] Account event processing failed', {
      eventId: req.body?.event_id,
      error: err.message,
      stack: err.stack
    });
    next(err);
  }
};

const handleCapabilityRequestWebhook = async (req, res, next) => {
  try {
    const payload = req.body;

    logger.info('[Webhook] Capability request received', {
      eventId: payload.event_id,
      eventType: payload.event_type,
      accountId: payload.account_id
    });

    if (payload.event_type !== 'capability_request.created.v1') {
      logger.warn('[Webhook] Unsupported event type for capability-request', { eventType: payload.event_type });
      return res.status(200).json({ received: true, message: 'Event type not handled' });
    }

    await webhookService.processCapabilityRequest(payload);

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('[Webhook] Capability request processing failed', {
      eventId: req.body?.event_id,
      error: err.message,
      stack: err.stack
    });
    next(err);
  }
};

const handleCapabilityEventWebhook = async (req, res, next) => {
  try {
    const payload = req.body;

    logger.info('[Webhook] Capability event received', {
      eventId: payload.event_id,
      eventType: payload.event_type,
      accountId: payload.account_id
    });

    if (payload.event_type !== 'capability_request.event.v1') {
      logger.warn('[Webhook] Unsupported event type for capability-event', { eventType: payload.event_type });
      return res.status(200).json({ received: true, message: 'Event type not handled' });
    }

    await webhookService.processCapabilityEvent(payload);

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('[Webhook] Capability event processing failed', {
      eventId: req.body?.event_id,
      error: err.message,
      stack: err.stack
    });
    next(err);
  }
};

const handleChargeCreateWebhook = async (req, res, next) => {
  try {
    const payload = req.body;

    logger.info('[Webhook] Charge create received', {
      eventId: payload.event_id,
      eventType: payload.event_type,
      accountId: payload.account_id,
      chargeId: payload.data?.id
    });

    if (payload.event_type !== 'charge.created.v1') {
      logger.warn('[Webhook] Unsupported event type for charge-create', { eventType: payload.event_type });
      return res.status(200).json({ received: true, message: 'Event type not handled' });
    }

    await webhookService.processChargeCreate(payload);

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('[Webhook] Charge create processing failed', {
      eventId: req.body?.event_id,
      error: err.message,
      stack: err.stack
    });
    next(err);
  }
};

const handleChargeEventWebhook = async (req, res, next) => {
  try {
    const payload = req.body;

    logger.info('[Webhook] Charge event received', {
      eventId: payload.event_id,
      eventType: payload.event_type,
      accountId: payload.account_id,
      chargeId: payload.data?.id
    });

    if (payload.event_type !== 'charge.event.v1') {
      logger.warn('[Webhook] Unsupported event type for charge-event', { eventType: payload.event_type });
      return res.status(200).json({ received: true, message: 'Event type not handled' });
    }

    await webhookService.processChargeEvent(payload);

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('[Webhook] Charge event processing failed', {
      eventId: req.body?.event_id,
      error: err.message,
      stack: err.stack
    });
    next(err);
  }
};

const handleCustomerCreateWebhook = async (req, res, next) => {
  try {
    const payload = req.body;

    logger.info('[Webhook] Customer create received', {
      eventId: payload.event_id,
      eventType: payload.event_type,
      accountId: payload.account_id,
      customerId: payload.data?.id
    });

    if (payload.event_type !== 'customer.created.v1') {
      logger.warn('[Webhook] Unsupported event type for customer-create', { eventType: payload.event_type });
      return res.status(200).json({ received: true, message: 'Event type not handled' });
    }

    await webhookService.processCustomerCreate(payload);

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('[Webhook] Customer create processing failed', {
      eventId: req.body?.event_id,
      error: err.message,
      stack: err.stack
    });
    next(err);
  }
};

const handleCustomerEventWebhook = async (req, res, next) => {
  try {
    const payload = req.body;

    logger.info('[Webhook] Customer event received', {
      eventId: payload.event_id,
      eventType: payload.event_type,
      accountId: payload.account_id,
      customerId: payload.data?.id
    });

    if (payload.event_type !== 'customer.event.v1') {
      logger.warn('[Webhook] Unsupported event type for customer-event', { eventType: payload.event_type });
      return res.status(200).json({ received: true, message: 'Event type not handled' });
    }

    await webhookService.processCustomerEvent(payload);

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('[Webhook] Customer event processing failed', {
      eventId: req.body?.event_id,
      error: err.message,
      stack: err.stack
    });
    next(err);
  }
};

const handleFundingEventCreateWebhook = async (req, res, next) => {
  try {
    const payload = req.body;

    logger.info('[Webhook] Funding event create received', {
      eventId: payload.event_id,
      eventType: payload.event_type,
      accountId: payload.account_id,
      fundingId: payload.data?.id
    });

    if (payload.event_type !== 'funding_event.created.v1') {
      logger.warn('[Webhook] Unsupported event type for funding-event-create', { eventType: payload.event_type });
      return res.status(200).json({ received: true, message: 'Event type not handled' });
    }

    await webhookService.processFundingEventCreate(payload);

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('[Webhook] Funding event create processing failed', {
      eventId: req.body?.event_id,
      error: err.message,
      stack: err.stack
    });
    next(err);
  }
};

const handleFundingEventEventWebhook = async (req, res, next) => {
  try {
    const payload = req.body;

    logger.info('[Webhook] Funding event event received', {
      eventId: payload.event_id,
      eventType: payload.event_type,
      accountId: payload.account_id,
      fundingId: payload.data?.id
    });

    if (payload.event_type !== 'funding_event.event.v1') {
      logger.warn('[Webhook] Unsupported event type for funding-event-event', { eventType: payload.event_type });
      return res.status(200).json({ received: true, message: 'Event type not handled' });
    }

    await webhookService.processFundingEventEvent(payload);

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('[Webhook] Funding event event processing failed', {
      eventId: req.body?.event_id,
      error: err.message,
      stack: err.stack
    });
    next(err);
  }
};

const handleLinkedBankAccountCreateWebhook = async (req, res, next) => {
  try {
    const payload = req.body;

    logger.info('[Webhook] Linked bank account create received', {
      eventId: payload.event_id,
      eventType: payload.event_type,
      accountId: payload.account_id,
      linkedAccountId: payload.data?.id
    });

    if (payload.event_type !== 'linked_bank_account.created.v1') {
      logger.warn('[Webhook] Unsupported event type for linked-bank-account-create', { eventType: payload.event_type });
      return res.status(200).json({ received: true, message: 'Event type not handled' });
    }

    await webhookService.processLinkedBankAccountCreate(payload);

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('[Webhook] Linked bank account create processing failed', {
      eventId: req.body?.event_id,
      error: err.message,
      stack: err.stack
    });
    next(err);
  }
};

const handleLinkedBankAccountEventWebhook = async (req, res, next) => {
  try {
    const payload = req.body;

    logger.info('[Webhook] Linked bank account event received', {
      eventId: payload.event_id,
      eventType: payload.event_type,
      accountId: payload.account_id,
      linkedAccountId: payload.data?.id
    });

    if (payload.event_type !== 'linked_bank_account.event.v1') {
      logger.warn('[Webhook] Unsupported event type for linked-bank-account-event', { eventType: payload.event_type });
      return res.status(200).json({ received: true, message: 'Event type not handled' });
    }

    await webhookService.processLinkedBankAccountEvent(payload);

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('[Webhook] Linked bank account event processing failed', {
      eventId: req.body?.event_id,
      error: err.message,
      stack: err.stack
    });
    next(err);
  }
};

const handlePaykeyCreateWebhook = async (req, res, next) => {
  try {
    const payload = req.body;

    logger.info('[Webhook] Paykey create received', {
      eventId: payload.event_id,
      eventType: payload.event_type,
      accountId: payload.account_id,
      paykeyId: payload.data?.id
    });

    if (payload.event_type !== 'paykey.created.v1' && !String(payload.event_type || '').startsWith('paykey.')) {
      logger.warn('[Webhook] Unsupported event type for paykey-create', { eventType: payload.event_type });
      return res.status(200).json({ received: true, message: 'Event type not handled' });
    }

    await webhookService.processPaykeyCreate(payload);

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('[Webhook] Paykey create processing failed', {
      eventId: req.body?.event_id,
      error: err.message,
      stack: err.stack
    });
    next(err);
  }
};

const handlePaykeyEventWebhook = async (req, res, next) => {
  try {
    const payload = req.body;

    logger.info('[Webhook] Paykey event received', {
      eventId: payload.event_id,
      eventType: payload.event_type,
      accountId: payload.account_id,
      paykeyId: payload.data?.id
    });

    if (payload.event_type !== 'paykey.event.v1' && !String(payload.event_type || '').startsWith('paykey.')) {
      logger.warn('[Webhook] Unsupported event type for paykey-event', { eventType: payload.event_type });
      return res.status(200).json({ received: true, message: 'Event type not handled' });
    }

    await webhookService.processPaykeyEvent(payload);

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('[Webhook] Paykey event processing failed', {
      eventId: req.body?.event_id,
      error: err.message,
      stack: err.stack
    });
    next(err);
  }
};

const handlePayoutCreateWebhook = async (req, res, next) => {
  try {
    const payload = req.body;

    logger.info('[Webhook] Payout create received', {
      eventId: payload.event_id,
      eventType: payload.event_type,
      accountId: payload.account_id,
      payoutId: payload.data?.id
    });

    if (payload.event_type !== 'payout.created.v1') {
      logger.warn('[Webhook] Unsupported event type for payout-create', { eventType: payload.event_type });
      return res.status(200).json({ received: true, message: 'Event type not handled' });
    }

    await webhookService.processPayoutCreate(payload);

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('[Webhook] Payout create processing failed', {
      eventId: req.body?.event_id,
      error: err.message,
      stack: err.stack
    });
    next(err);
  }
};

const handlePayoutEventWebhook = async (req, res, next) => {
  try {
    const payload = req.body;

    logger.info('[Webhook] Payout event received', {
      eventId: payload.event_id,
      eventType: payload.event_type,
      accountId: payload.account_id,
      payoutId: payload.data?.id
    });

    if (payload.event_type !== 'payout.event.v1') {
      logger.warn('[Webhook] Unsupported event type for payout-event', { eventType: payload.event_type });
      return res.status(200).json({ received: true, message: 'Event type not handled' });
    }

    await webhookService.processPayoutEvent(payload);

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('[Webhook] Payout event processing failed', {
      eventId: req.body?.event_id,
      error: err.message,
      stack: err.stack
    });
    next(err);
  }
};

const handleRepresentativeCreateWebhook = async (req, res, next) => {
  try {
    const payload = req.body;

    logger.info('[Webhook] Representative create received', {
      eventId: payload.event_id,
      eventType: payload.event_type,
      accountId: payload.account_id,
      representativeId: payload.data?.id
    });

    if (payload.event_type !== 'representative.created.v1') {
      logger.warn('[Webhook] Unsupported event type for representative-create', { eventType: payload.event_type });
      return res.status(200).json({ received: true, message: 'Event type not handled' });
    }

    await webhookService.processRepresentativeCreate(payload);

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('[Webhook] Representative create processing failed', {
      eventId: req.body?.event_id,
      error: err.message,
      stack: err.stack
    });
    next(err);
  }
};

const handleRepresentativeEventWebhook = async (req, res, next) => {
  try {
    const payload = req.body;

    logger.info('[Webhook] Representative event received', {
      eventId: payload.event_id,
      eventType: payload.event_type,
      accountId: payload.account_id,
      representativeId: payload.data?.id
    });

    if (payload.event_type !== 'representative.event.v1') {
      logger.warn('[Webhook] Unsupported event type for representative-event', { eventType: payload.event_type });
      return res.status(200).json({ received: true, message: 'Event type not handled' });
    }

    await webhookService.processRepresentativeEvent(payload);

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('[Webhook] Representative event processing failed', {
      eventId: req.body?.event_id,
      error: err.message,
      stack: err.stack
    });
    next(err);
  }
};

module.exports = { handlePaymentStatusWebhook, handleAccountCreateWebhook, handleAccountEventWebhook, handleCapabilityRequestWebhook, handleCapabilityEventWebhook, handleChargeCreateWebhook, handleChargeEventWebhook, handleCustomerCreateWebhook, handleCustomerEventWebhook, handleFundingEventCreateWebhook, handleFundingEventEventWebhook, handleLinkedBankAccountCreateWebhook, handleLinkedBankAccountEventWebhook, handlePaykeyCreateWebhook, handlePaykeyEventWebhook, handlePayoutCreateWebhook, handlePayoutEventWebhook, handleRepresentativeCreateWebhook, handleRepresentativeEventWebhook };
