'use strict';

const { PAYIN_STATUS } = require('../constants/rainforest.constants');
const { normalizePayinStatus } = require('./rainforestPayinSettlement.util');

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function mapRainforestPayinStatusForTracker(status) {
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

function buildRainforestPayinStatusHistory(payin = {}) {
  const raw = payin.raw && typeof payin.raw === 'object' ? payin.raw : {};
  const rawHistory = raw.status_history || raw.statusHistory;
  if (Array.isArray(rawHistory) && rawHistory.length > 0) {
    return rawHistory.map((entry) => ({
      status: mapRainforestPayinStatusForTracker(entry.status || entry.event || entry.type),
      timestamp: entry.timestamp || entry.created_at || entry.createdAt || null,
      status_details: entry.status_details || entry.details || entry.reason || null,
    }));
  }

  const history = [];
  const push = (status, timestamp, details) => {
    if (!timestamp && history.length > 0) return;
    history.push({
      status: mapRainforestPayinStatusForTracker(status),
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

function buildRainforestPayinTrackerPayload(payin = {}) {
  const statusHistory = buildRainforestPayinStatusHistory(payin);
  const currentStatus = statusHistory.length
    ? statusHistory[statusHistory.length - 1].status
    : mapRainforestPayinStatusForTracker(payin.status);

  return {
    status: currentStatus,
    status_history: statusHistory,
    method_type: payin.methodType || payin.method_type || null,
    payin_id: payin.payinId || payin.payin_id || null,
    merchant_id: payin.merchantId || payin.merchant_id || null,
    refusal_code: payin.refusalCode || '',
    refusal_desc: payin.refusalDesc || '',
  };
}

module.exports = {
  buildRainforestPayinStatusHistory,
  buildRainforestPayinTrackerPayload,
  mapRainforestPayinStatusForTracker,
};
