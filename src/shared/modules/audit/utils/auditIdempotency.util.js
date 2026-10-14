'use strict';

const crypto = require('crypto');

/**
 * Build a stable idempotency key so HTTP/worker/webhook retries do not enqueue duplicates.
 *
 * eventId      - unique outbox record id (UUID), assigned at enqueue
 * requestId    - HTTP request trace id (may repeat on client retry)
 * correlationId - broader trace id across services
 */
function buildAuditIdempotencyKey(prepared = {}, explicitKey = '') {
  if (explicitKey) return String(explicitKey).slice(0, 512);

  if (prepared.idempotencyKey) return String(prepared.idempotencyKey).slice(0, 512);

  // Webhook events: Straddle event_id is the canonical dedup key
  const webhookEventId = prepared.after?.eventId || prepared.after?.event_id;
  if (webhookEventId && prepared.source === 'WEBHOOK') {
    return [
      'webhook',
      prepared.module || '',
      prepared.event || '',
      String(webhookEventId),
    ].join(':').slice(0, 512);
  }

  const parts = [
    prepared.requestId || '',
    prepared.correlationId || '',
    prepared.module || '',
    prepared.event || prepared.action || '',
    prepared.entity || '',
    prepared.entityId || '',
    prepared.createdBy ? String(prepared.createdBy) : '',
    prepared.success === false ? 'fail' : 'ok',
    prepared.source || '',
  ];

  const raw = parts.join('|');
  if (raw.replace(/\|/g, '').length === 0) {
    return null;
  }

  // Hash long keys for index efficiency while remaining deterministic
  if (raw.length > 400) {
    return crypto.createHash('sha256').update(raw).digest('hex');
  }
  return raw.slice(0, 512);
}

module.exports = {
  buildAuditIdempotencyKey,
};
