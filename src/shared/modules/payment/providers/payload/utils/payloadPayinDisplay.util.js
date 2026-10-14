'use strict';

const { PAYIN_STATUS } = require('../constants/payload.constants');
const { normalizePayinStatus } = require('./payloadPayinSettlement.util');
const {
  appendPayloadPayinLifecycleFromRemote,
  buildPayloadLifecycleStages,
  resolveActiveLifecyclePhase,
} = require('./payloadPayinLifecycle.util');

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function mapPayloadPayinStatusForTracker(status) {
  const normalized = normalizePayinStatus(status);
  switch (normalized) {
    case PAYIN_STATUS.CREATED:
      return 'created';
    case PAYIN_STATUS.PROCESSING:
      return 'pending';
    case PAYIN_STATUS.IN_REVIEW:
      return 'on_hold';
    case PAYIN_STATUS.SUCCEEDED:
      return 'paid';
    case PAYIN_STATUS.FAILED:
      return 'failed';
    case PAYIN_STATUS.RETURNED:
      return 'reversed';
    case PAYIN_STATUS.CANCELED:
      return 'cancelled';
    default:
      return String(status || 'pending').toLowerCase();
  }
}

function buildPayloadPayinStatusHistory(payin = {}) {
  const raw = payin.raw && typeof payin.raw === 'object' ? payin.raw : {};
  const rawHistory = raw.status_history || raw.statusHistory;
  if (Array.isArray(rawHistory) && rawHistory.length > 0) {
    return rawHistory.map((entry) => ({
      status: mapPayloadPayinStatusForTracker(entry.status || entry.event || entry.type),
      timestamp: entry.timestamp || entry.created_at || entry.createdAt || null,
      status_details: entry.status_details || entry.details || entry.reason || null,
    }));
  }

  const history = [];
  const push = (status, timestamp, details) => {
    if (!timestamp && history.length > 0) return;
    history.push({
      status: mapPayloadPayinStatusForTracker(status),
      timestamp: toIso(timestamp),
      status_details: details || null,
    });
  };

  push(PAYIN_STATUS.CREATED, payin.createdAt, 'Payment initiated');

  const normalized = normalizePayinStatus(payin.status);
  if (normalized === PAYIN_STATUS.PROCESSING || normalized === PAYIN_STATUS.IN_REVIEW) {
    push(
      normalized,
      payin.updatedAt || payin.createdAt,
      normalized === PAYIN_STATUS.IN_REVIEW ? 'Payment under review' : 'Processing payment',
    );
  }

  if (payin.settledAt || normalized === PAYIN_STATUS.SUCCEEDED) {
    push(PAYIN_STATUS.SUCCEEDED, payin.settledAt || payin.updatedAt, 'Payment successful');
  }

  if (payin.failedAt || normalized === PAYIN_STATUS.FAILED) {
    push(
      PAYIN_STATUS.FAILED,
      payin.failedAt || payin.updatedAt,
      payin.refusalDesc || 'Payment failed',
    );
  }

  if (normalized === PAYIN_STATUS.RETURNED) {
    push(PAYIN_STATUS.RETURNED, payin.failedAt || payin.updatedAt, payin.refusalDesc || 'Payment returned');
  }

  if (normalized === PAYIN_STATUS.CANCELED) {
    push(PAYIN_STATUS.CANCELED, payin.failedAt || payin.updatedAt, 'Payment cancelled');
  }

  return history.filter((entry) => entry.timestamp || history.length === 1);
}

function buildPayloadPayinTrackerPayload(payin = {}) {
  const metadata = payin.metadata && typeof payin.metadata === 'object' ? payin.metadata : {};
  let lifecycleHistory = Array.isArray(metadata.payloadLifecycleHistory)
    ? metadata.payloadLifecycleHistory
    : [];

  // Backfill read-only tracker for payins created before lifecycle persistence.
  if (lifecycleHistory.length === 0 && (payin.raw || payin.status)) {
    lifecycleHistory = appendPayloadPayinLifecycleFromRemote([], {
      remote: payin.raw || {},
      eventType: '',
      methodType: payin.methodType || payin.method_type || '',
      payinStatus: payin.status || '',
      at: payin.lastWebhookAt || payin.updatedAt || payin.createdAt,
    });
  }

  const lifecycleStages = buildPayloadLifecycleStages(lifecycleHistory, payin.status);
  const activePhase = resolveActiveLifecyclePhase(lifecycleHistory, payin.status);

  const statusHistory = buildPayloadPayinStatusHistory(payin);
  const currentStatus = activePhase
    || (statusHistory.length ? statusHistory[statusHistory.length - 1].status : mapPayloadPayinStatusForTracker(payin.status));

  return {
    status: currentStatus,
    status_history: statusHistory,
    lifecycle_history: lifecycleHistory,
    lifecycle_stages: lifecycleStages,
    method_type: payin.methodType || payin.method_type || null,
    payin_id: payin.payinId || payin.payin_id || null,
    merchant_id: payin.merchantId || payin.merchant_id || null,
    refusal_code: payin.refusalCode || '',
    refusal_desc: payin.refusalDesc || '',
  };
}

module.exports = {
  buildPayloadPayinStatusHistory,
  buildPayloadPayinTrackerPayload,
  mapPayloadPayinStatusForTracker,
  appendPayloadPayinLifecycleFromRemote,
};
