'use strict';

const { ClockService, DateUtil } = require('../../../../../common/date');

const crypto = require('crypto');
const StraddleAccountWebhookEvent = require('../model/straddleAccountWebhookEvent.model');
const { AccountService } = require('./account.service');
const { LinkedBankService } = require('./linkedBank.service');
const { auditAccount, AUDIT_EVENTS } = require('./accountAudit.helper');
const { AUDIT_SOURCES } = require('../../../../modules/audit/service/auditLog.service');
const { LINKED_BANK_WEBHOOK_EVENTS } = require('../constants/linkedBank.constants');
const logger = require('../../../../../common/logger');

const accountService = new AccountService();
const linkedBankService = new LinkedBankService();

// ── Signature verification ────────────────────────────────────────────────────

function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.STRADDLE_WEBHOOK_SECRET;
  if (!secret) return; // skip if not configured (dev/test)
  if (!signatureHeader) throw Object.assign(new Error('Missing webhook signature'), { statusCode: 401 });

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const provided = signatureHeader.replace(/^sha256=/, '');
  const match = crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(provided.padEnd(expected.length, '0').slice(0, expected.length), 'hex')
  );
  if (!match) throw Object.assign(new Error('Invalid webhook signature'), { statusCode: 401 });
}

// ── Replay protection (5-minute window) ──────────────────────────────────────

function checkReplay(timestampHeader) {
  if (!timestampHeader) return;
  const ts = Number(timestampHeader);
  if (isNaN(ts)) return;
  const ageMs = ClockService.nowEpoch() - ts * 1000;
  if (ageMs > 5 * 60 * 1000) {
    throw Object.assign(new Error('Webhook replay detected'), { statusCode: 400 });
  }
}

// ── Core processor ────────────────────────────────────────────────────────────

class AccountWebhookService {

  /**
   * Entry point - called by the controller for every inbound account webhook.
   * Handles: signature verification, replay protection, deduplication,
   * persistence, state sync, and audit.
   */
  async process(payload, { rawBody, signatureHeader, timestampHeader, correlationId } = {}) {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw Object.assign(new Error('Invalid webhook payload: must be a JSON object'), { statusCode: 400 });
    }
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) delete payload[key];
    }
    const { event_id: eventId, event_type: eventType, account_id: straddleAccountId, data } = payload;

    if (!eventId || !eventType) {
      throw Object.assign(new Error('Invalid webhook payload: missing event_id or event_type'), { statusCode: 400 });
    }

    // Security checks
    if (rawBody) verifySignature(rawBody, signatureHeader);
    checkReplay(timestampHeader);

    // Idempotency / duplicate detection
    const existing = await StraddleAccountWebhookEvent.findOne({ eventId });
    if (existing) {
      logger.info('[AccountWebhook] Duplicate event ignored', { eventId, eventType });
      return { duplicate: true };
    }

    // Persist raw event immediately (dead-letter ready - processed=false until done)
    const eventRecord = await StraddleAccountWebhookEvent.create({
      eventId,
      eventType,
      accountId: straddleAccountId || data?.id || null,
      straddleAccountId: straddleAccountId || null,
      rawPayload: payload,
      processed: false,
      correlationId: correlationId || null,
    });

    auditAccount({
      event: AUDIT_EVENTS.WEBHOOK_RECEIVED,
      before: null,
      after: { eventId, eventType, straddleAccountId },
      source: AUDIT_SOURCES.WEBHOOK,
    });

    try {
      await this._dispatch(eventType, straddleAccountId, data, payload);

      eventRecord.processed = true;
      eventRecord.processedAt = ClockService.now();
      await eventRecord.save();

      auditAccount({
        event: AUDIT_EVENTS.WEBHOOK_PROCESSED,
        before: null,
        after: { eventId, eventType },
        source: AUDIT_SOURCES.WEBHOOK,
      });

      logger.info('[AccountWebhook] Processed', { eventId, eventType });
      return { duplicate: false, eventId };

    } catch (err) {
      eventRecord.processingError = err.message;
      eventRecord.retryCount = (eventRecord.retryCount || 0) + 1;
      await eventRecord.save();

      auditAccount({
        event: AUDIT_EVENTS.WEBHOOK_FAILED,
        before: null,
        after: { eventId, eventType, error: err.message },
        source: AUDIT_SOURCES.WEBHOOK,
        success: false,
        failureReason: err.message,
      });

      logger.error('[AccountWebhook] Processing failed', { eventId, eventType, error: err.message });
      throw err;
    }
  }

  // ── Event dispatcher ────────────────────────────────────────────────────────

  async _dispatch(eventType, straddleAccountId, data, payload) {
    if (LINKED_BANK_WEBHOOK_EVENTS.includes(eventType) || String(eventType).startsWith('linked_bank_account.')) {
      return this._onLinkedBankEvent(eventType, straddleAccountId, data, payload);
    }

    switch (eventType) {
      case 'account.created.v1':
        return this._onAccountCreated(straddleAccountId, data);

      case 'account.event.v1':
        return this._onAccountEvent(straddleAccountId, data);

      case 'capability_request.created.v1':
      case 'capability_request.event.v1':
        return this._onCapabilityEvent(straddleAccountId, data, eventType);

      case 'representative.created.v1':
      case 'representative.event.v1':
        return this._onRepresentativeEvent(straddleAccountId, data, eventType);

      default:
        logger.warn('[AccountWebhook] Unknown account event type - stored for review', { eventType });
        // Stored already; no further action needed (dead-letter ready)
    }
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  async _onAccountCreated(straddleAccountId, data) {
    if (!straddleAccountId && !data?.id) return;
    const id = straddleAccountId || data?.id;
    await accountService.applyStatusFromWebhook(id, data || {}, 'account.created.v1');
  }

  async _onAccountEvent(straddleAccountId, data) {
    if (!straddleAccountId && !data?.id) return;
    const id = straddleAccountId || data?.id;
    await accountService.applyStatusFromWebhook(id, data || {}, 'account.event.v1');
  }

  async _onCapabilityEvent(straddleAccountId, data, eventType) {
    if (!straddleAccountId) return;
    // Capability changes may carry updated capability_status / capabilities
    const patch = {};
    if (data?.status)              patch.capability_status = data.status;
    if (data?.capabilities)        patch.capabilities      = data.capabilities;
    if (Object.keys(patch).length) {
      await accountService.applyStatusFromWebhook(straddleAccountId, patch, eventType);
    }
    auditAccount({
      event: AUDIT_EVENTS.CAPABILITIES_CHANGED,
      before: null,
      after: { straddleAccountId, eventType, data },
      source: AUDIT_SOURCES.WEBHOOK,
    });
  }

  async _onRepresentativeEvent(straddleAccountId, data, eventType) {
    // Representative events affect verification / onboarding status
    if (!straddleAccountId) return;
    const patch = {};
    if (data?.verification_status) patch.verification_status = data.verification_status;
    if (data?.onboarding_status)   patch.onboarding_status   = data.onboarding_status;
    if (Object.keys(patch).length) {
      await accountService.applyStatusFromWebhook(straddleAccountId, patch, eventType);
    }
  }

  /**
   * linked_bank_account.created.v1 / linked_bank_account.event.v1
   * Payload typically includes data.id (linked bank UUID) and data.status.
   */
  async _onLinkedBankEvent(eventType, straddleAccountId, data, payload) {
    const linkedBankId =
      data?.id ||
      payload?.data?.id ||
      payload?.linked_bank_account_id ||
      null;

    if (!linkedBankId) {
      logger.warn('[AccountWebhook] linked_bank_account event missing id', { eventType });
      return;
    }

    await linkedBankService.applyStatusFromWebhook(linkedBankId, data || payload?.data || {});
    logger.info('[AccountWebhook] Linked bank status applied', {
      eventType,
      linkedBankId,
      status: data?.status,
      straddleAccountId,
    });
  }
}

module.exports = { AccountWebhookService, verifySignature };
