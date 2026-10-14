'use strict';

const mongoose = require('mongoose');
const { redactForAudit } = require('./auditRedact.util');

function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Shape an AuditLog document for investigation API responses (no secrets).
 */
function formatAuditLogForInvestigation(doc) {
  if (!doc) return null;
  const row = typeof doc.toObject === 'function' ? doc.toObject() : doc;

  return redactForAudit({
    id: String(row._id),
    auditEventId: row.auditEventId || '',
    module: row.module || '',
    event: row.event || '',
    action: row.action || '',
    entity: row.entity || '',
    entityId: row.entityId || '',
    portal: row.portal || '',
    source: row.source || '',
    success: row.success !== false,
    failureReason: row.failureReason || '',
    createdBy: row.createdBy ? String(row.createdBy) : '',
    userName: row.userName || '',
    userRole: row.userRole || '',
    hoaId: row.hoaId ? String(row.hoaId) : '',
    before: row.before ?? null,
    after: row.after ?? null,
    ipAddress: row.ipAddress || '',
    deviceInfo: row.deviceInfo || '',
    browserInfo: row.browserInfo || '',
    sessionId: row.sessionId || '',
    requestId: row.requestId || '',
    correlationId: row.correlationId || '',
    createdAt: toIso(row.createdAt),
  });
}

function formatOutboxForInvestigation(doc) {
  if (!doc) return null;
  const row = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: String(row._id),
    eventId: row.eventId,
    idempotencyKey: row.idempotencyKey || '',
    status: row.status,
    retryCount: row.retryCount || 0,
    maxRetries: row.maxRetries || 0,
    nextRetryAt: toIso(row.nextRetryAt),
    lastError: row.lastError || '',
    auditLogId: row.auditLogId ? String(row.auditLogId) : '',
    processedAt: toIso(row.processedAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    module: row.payload?.module || '',
    event: row.payload?.event || '',
    requestId: row.payload?.requestId || '',
    correlationId: row.payload?.correlationId || '',
    replayHistory: Array.isArray(row.replayHistory)
      ? row.replayHistory.map((h) => ({
        at: toIso(h.at),
        initiatedBy: h.initiatedBy ? String(h.initiatedBy) : '',
        outcome: h.outcome || '',
        note: h.note || '',
      }))
      : [],
  };
}

function isValidObjectId(value) {
  return mongoose.Types.ObjectId.isValid(String(value || ''));
}

module.exports = {
  formatAuditLogForInvestigation,
  formatOutboxForInvestigation,
  isValidObjectId,
};
