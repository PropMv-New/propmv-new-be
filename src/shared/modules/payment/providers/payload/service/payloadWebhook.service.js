'use strict';

const crypto = require('crypto');
const { ClockService } = require('../../../../../../common/date');
const PayloadWebhookEvent = require('../model/payloadWebhookEvent.model');
const {
  WEBHOOK_PROCESSING_STATUS,
  MERCHANT_WEBHOOK_PREFIX,
  MERCHANT_APPLICATION_WEBHOOK_PREFIX,
  PAYMENT_METHOD_WEBHOOK_PREFIX,
  DEPOSIT_METHOD_WEBHOOK_PREFIX,
  PAYIN_WEBHOOK_PREFIX,
  REFUND_WEBHOOK_PREFIX,
  AUDIT_EVENTS,
} = require('../constants/payload.constants');
const {
  applyMerchantWebhookUpdate,
  applyMerchantApplicationWebhookUpdate,
} = require('./payloadMerchant.service');
const { applyPaymentMethodWebhookUpdate } = require('./payloadPaymentMethod.service');
const {
  applyDepositMethodWebhookUpdate,
  syncDepositMethodsFromMerchantWebhook,
} = require('./payloadDepositMethod.service');
const { auditPayload } = require('./payloadAudit.helper');
const logger = require('../../../../../../common/logger');

function deriveEventId(payload, rawBody) {
  const trigger = payload?.trigger || payload?.event_type || 'unknown';
  const triggeredOn = payload?.triggered_on || {};
  const resourceId = triggeredOn?.id
    || payload?.data?.merchant_id
    || payload?.data?.payin_id
    || '';
  const value = triggeredOn?.value || '';

  const explicit = payload?.event_id || payload?.id;
  if (explicit) return String(explicit);

  const hash = crypto.createHash('sha256').update(String(rawBody || JSON.stringify(payload || {}))).digest('hex');
  return `${trigger}:${resourceId}:${value}:${hash.slice(0, 20)}`;
}

function isPayinRelatedWebhookTrigger(trigger) {
  const normalized = String(trigger || '').trim();
  if (!normalized) return false;
  if (
    ['payment', 'automatic_payment', 'processed', 'authorized', 'decline', 'void', 'reject', 'refund'].includes(normalized)
  ) {
    return true;
  }
  return normalized.startsWith(PAYIN_WEBHOOK_PREFIX) || normalized.startsWith(REFUND_WEBHOOK_PREFIX);
}

function deriveResourceId(payload) {
  const triggeredOn = payload?.triggered_on || {};
  if (triggeredOn?.id) return String(triggeredOn.id);
  const data = payload?.data || {};
  return (
    data.merchant_id
    || data.merchant_application_id
    || data.payment_method_id
    || data.deposit_method_id
    || data.payin_id
    || data.refund_id
    || data.transaction_id
    || ''
  );
}

async function persistWebhookEvent({ payload, signatureVerified, rawBody }) {
  const eventType = String(payload?.trigger || payload?.event_type || '').trim();
  const eventId = deriveEventId(payload, rawBody);
  const resourceId = deriveResourceId(payload);

  try {
    const doc = await PayloadWebhookEvent.create({
      eventId,
      eventType,
      resourceId: resourceId ? String(resourceId) : '',
      payload,
      signatureVerified: !!signatureVerified,
      processingStatus: WEBHOOK_PROCESSING_STATUS.RECEIVED,
      receivedAt: ClockService.now(),
    });

    auditPayload({
      event: AUDIT_EVENTS.WEBHOOK_RECEIVED,
      entity: 'PayloadWebhookEvent',
      entityId: doc._id,
      after: { eventId, eventType, resourceId },
    });

    return { doc, duplicate: false };
  } catch (err) {
    if (err?.code === 11000) {
      const existing = await PayloadWebhookEvent.findOne({ eventId });
      return { doc: existing, duplicate: true };
    }
    throw err;
  }
}

async function processPayloadWebhookEvent(doc) {
  if (!doc || doc.processingStatus === WEBHOOK_PROCESSING_STATUS.PROCESSED) {
    return { skipped: true, reason: 'already_processed' };
  }

  const payload = doc.payload || {};
  const trigger = String(payload.trigger || payload.event_type || doc.eventType || '').trim();
  const triggeredOn = payload.triggered_on || {};
  const data = payload.data || {};
  const { PayloadClient } = require('../client/payload.client');
  const webhookClient = new PayloadClient();

  doc.processingStatus = WEBHOOK_PROCESSING_STATUS.PROCESSING;
  await doc.save();

  try {
    if (trigger === 'processing_status') {
      const processingId = triggeredOn.id || data.merchant_id || data.processing_id;
      const statusValue = triggeredOn.value || data.status || '';
      await applyMerchantWebhookUpdate({
        merchantId: processingId,
        merchantStatus: statusValue,
        applicationStatus: statusValue,
        webhookAt: ClockService.now(),
      });
      if (processingId) {
        await syncDepositMethodsFromMerchantWebhook({
          merchantId: processingId,
          remoteMerchant: data,
          webhookAt: ClockService.now(),
        });
      }
    } else if (isPayinRelatedWebhookTrigger(trigger)) {
      const transactionId = triggeredOn.id || data.payin_id || data.transaction_id;
      let remotePayload = data;
      if (transactionId && webhookClient.isConfigured()) {
        try {
          remotePayload = await webhookClient.getTransaction(transactionId);
        } catch (fetchErr) {
          logger.warn('[PayloadWebhook] Failed to fetch transaction for webhook', {
            transactionId,
            message: fetchErr.message,
          });
        }
      }

      if (trigger === 'refund' || String(remotePayload?.type || '').toLowerCase() === 'refund') {
        const { applyRefundWebhookUpdate } = require('./payloadRefund.service');
        await applyRefundWebhookUpdate({
          refundId: transactionId,
          remotePayload,
          eventType: trigger,
        });
      } else {
        // Phase 4: Vendor Owner→Vendor payins first; fall through to HOA payins.
        const { applyVendorPayinWebhookUpdate } = require('./payloadVendorPayin.service');
        const vendorHandled = await applyVendorPayinWebhookUpdate({
          transactionId,
          remotePayload,
          eventType: trigger,
        });
        if (!vendorHandled) {
          const { applyPayinWebhookUpdate } = require('./payloadPayin.service');
          await applyPayinWebhookUpdate({
            payinId: transactionId,
            remotePayload,
            eventType: trigger,
          });
        }
      }
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

    auditPayload({
      event: AUDIT_EVENTS.WEBHOOK_PROCESSED,
      entity: 'PayloadWebhookEvent',
      entityId: doc._id,
      after: { eventType: trigger, resourceId: doc.resourceId },
    });

    return { processed: true };
  } catch (err) {
    doc.processingStatus = WEBHOOK_PROCESSING_STATUS.FAILED;
    doc.retryCount = (doc.retryCount || 0) + 1;
    doc.error = err.message || 'Webhook processing failed';
    await doc.save();

    auditPayload({
      event: AUDIT_EVENTS.WEBHOOK_FAILED,
      entity: 'PayloadWebhookEvent',
      entityId: doc._id,
      success: false,
      failureReason: doc.error,
    });

    logger.error('[PayloadWebhook] Processing failed', { eventId: doc.eventId, error: doc.error });
    throw err;
  }
}

async function ingestPayloadWebhook({ payload, signatureVerified, rawBody }) {
  const { doc, duplicate } = await persistWebhookEvent({ payload, signatureVerified, rawBody });
  if (duplicate && doc?.processingStatus === WEBHOOK_PROCESSING_STATUS.PROCESSED) {
    return { duplicate: true, eventId: doc.eventId };
  }

  const result = await processPayloadWebhookEvent(doc);
  return { duplicate: !!duplicate, eventId: doc.eventId, ...result };
}

module.exports = {
  ingestPayloadWebhook,
  processPayloadWebhookEvent,
  persistWebhookEvent,
  deriveEventId,
  isPayinRelatedWebhookTrigger,
};
