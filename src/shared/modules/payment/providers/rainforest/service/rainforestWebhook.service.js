'use strict';

const crypto = require('crypto');
const { ClockService } = require('../../../../../../common/date');
const RainforestWebhookEvent = require('../model/rainforestWebhookEvent.model');
const {
  WEBHOOK_PROCESSING_STATUS,
  MERCHANT_WEBHOOK_PREFIX,
  MERCHANT_APPLICATION_WEBHOOK_PREFIX,
  PAYMENT_METHOD_WEBHOOK_PREFIX,
  DEPOSIT_METHOD_WEBHOOK_PREFIX,
  PAYIN_WEBHOOK_PREFIX,
  REFUND_WEBHOOK_PREFIX,
  AUDIT_EVENTS,
} = require('../constants/rainforest.constants');
const {
  applyMerchantWebhookUpdate,
  applyMerchantApplicationWebhookUpdate,
} = require('./rainforestMerchant.service');
const { applyPaymentMethodWebhookUpdate } = require('./rainforestPaymentMethod.service');
const {
  applyDepositMethodWebhookUpdate,
  syncDepositMethodsFromMerchantWebhook,
} = require('./rainforestDepositMethod.service');
const { auditRainforest } = require('./rainforestAudit.helper');
const logger = require('../../../../../../common/logger');

function deriveEventId(payload, rawBody) {
  const explicit =
    payload?.event_id
    || payload?.id
    || payload?.data?.event_id
    || payload?.data?.id;
  if (explicit) return String(explicit);

  const resourceId =
    payload?.data?.merchant_id
    || payload?.data?.merchant_application_id
    || payload?.data?.payment_method_id
    || payload?.data?.deposit_method_id
    || payload?.data?.payin_id
    || '';

  const hash = crypto.createHash('sha256').update(String(rawBody || JSON.stringify(payload || {}))).digest('hex');
  return `${payload?.event_type || 'unknown'}:${resourceId}:${hash.slice(0, 24)}`;
}

function deriveResourceId(payload) {
  const data = payload?.data || {};
  return (
    data.merchant_id
    || data.merchant_application_id
    || data.payment_method_id
    || data.deposit_method_id
    || data.payin_id
    || data.refund_id
    || ''
  );
}

async function persistWebhookEvent({ payload, signatureVerified, rawBody }) {
  const eventType = String(payload?.event_type || '').trim();
  const eventId = deriveEventId(payload, rawBody);
  const resourceId = deriveResourceId(payload);

  try {
    const doc = await RainforestWebhookEvent.create({
      eventId,
      eventType,
      resourceId: resourceId ? String(resourceId) : '',
      payload,
      signatureVerified: !!signatureVerified,
      processingStatus: WEBHOOK_PROCESSING_STATUS.RECEIVED,
      receivedAt: ClockService.now(),
    });

    auditRainforest({
      event: AUDIT_EVENTS.WEBHOOK_RECEIVED,
      entity: 'RainforestWebhookEvent',
      entityId: doc._id,
      after: { eventId, eventType, resourceId },
    });

    return { doc, duplicate: false };
  } catch (err) {
    if (err?.code === 11000) {
      const existing = await RainforestWebhookEvent.findOne({ eventId });
      return { doc: existing, duplicate: true };
    }
    throw err;
  }
}

async function processRainforestWebhookEvent(doc) {
  if (!doc || doc.processingStatus === WEBHOOK_PROCESSING_STATUS.PROCESSED) {
    return { skipped: true, reason: 'already_processed' };
  }

  const payload = doc.payload || {};
  const eventType = String(payload.event_type || doc.eventType || '');
  const data = payload.data || {};

  doc.processingStatus = WEBHOOK_PROCESSING_STATUS.PROCESSING;
  await doc.save();

  try {
    if (eventType.startsWith(MERCHANT_APPLICATION_WEBHOOK_PREFIX)) {
      await applyMerchantApplicationWebhookUpdate({
        merchantId: data.merchant_id,
        merchantApplicationId: data.merchant_application_id,
        applicationStatus: data.status,
        webhookAt: ClockService.now(),
      });
      if (data.merchant_id) {
        await syncDepositMethodsFromMerchantWebhook({
          merchantId: data.merchant_id,
          remoteMerchant: data,
          webhookAt: ClockService.now(),
        });
      }
    } else if (eventType.startsWith(MERCHANT_WEBHOOK_PREFIX)) {
      await applyMerchantWebhookUpdate({
        merchantId: data.merchant_id,
        merchantStatus: data.status,
        applicationStatus: data.latest_merchant_application?.status,
        webhookAt: ClockService.now(),
      });
      if (data.merchant_id) {
        await syncDepositMethodsFromMerchantWebhook({
          merchantId: data.merchant_id,
          remoteMerchant: data,
          webhookAt: ClockService.now(),
        });
      }
    } else if (eventType.startsWith(DEPOSIT_METHOD_WEBHOOK_PREFIX)) {
      await applyDepositMethodWebhookUpdate({
        depositMethodId: data.deposit_method_id,
        remotePayload: data,
        webhookAt: ClockService.now(),
      });
    } else if (eventType.startsWith(PAYMENT_METHOD_WEBHOOK_PREFIX)) {
      await applyPaymentMethodWebhookUpdate({
        paymentMethodId: data.payment_method_id,
        status: data.status,
        remotePayload: data,
      });
    } else if (eventType.startsWith(PAYIN_WEBHOOK_PREFIX)) {
      const { applyPayinWebhookUpdate } = require('./rainforestPayin.service');
      await applyPayinWebhookUpdate({
        payinId: data.payin_id,
        remotePayload: data,
        eventType,
      });
    } else if (eventType.startsWith(REFUND_WEBHOOK_PREFIX)) {
      const { applyRefundWebhookUpdate } = require('./rainforestRefund.service');
      await applyRefundWebhookUpdate({
        refundId: data.refund_id,
        remotePayload: data,
        eventType,
      });
    } else {
      doc.processingStatus = WEBHOOK_PROCESSING_STATUS.IGNORED;
      doc.processedAt = ClockService.now();
      doc.error = '';
      await doc.save();
      return { skipped: true, reason: 'unsupported_event' };
    }

    doc.processingStatus = WEBHOOK_PROCESSING_STATUS.PROCESSED;
    doc.processedAt = ClockService.now();
    doc.error = '';
    await doc.save();

    auditRainforest({
      event: AUDIT_EVENTS.WEBHOOK_PROCESSED,
      entity: 'RainforestWebhookEvent',
      entityId: doc._id,
      after: { eventType, resourceId: doc.resourceId },
    });

    return { processed: true };
  } catch (err) {
    doc.processingStatus = WEBHOOK_PROCESSING_STATUS.FAILED;
    doc.retryCount = (doc.retryCount || 0) + 1;
    doc.error = err.message || 'Webhook processing failed';
    await doc.save();

    auditRainforest({
      event: AUDIT_EVENTS.WEBHOOK_FAILED,
      entity: 'RainforestWebhookEvent',
      entityId: doc._id,
      success: false,
      failureReason: doc.error,
    });

    logger.error('[RainforestWebhook] Processing failed', { eventId: doc.eventId, error: doc.error });
    throw err;
  }
}

async function ingestRainforestWebhook({ payload, signatureVerified, rawBody }) {
  const { doc, duplicate } = await persistWebhookEvent({ payload, signatureVerified, rawBody });
  if (duplicate && doc?.processingStatus === WEBHOOK_PROCESSING_STATUS.PROCESSED) {
    return { duplicate: true, eventId: doc.eventId };
  }

  const result = await processRainforestWebhookEvent(doc);
  return { duplicate: !!duplicate, eventId: doc.eventId, ...result };
}

module.exports = {
  ingestRainforestWebhook,
  processRainforestWebhookEvent,
  persistWebhookEvent,
  deriveEventId,
};
