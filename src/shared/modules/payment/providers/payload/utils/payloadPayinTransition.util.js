'use strict';

const { PAYIN_STATUS } = require('./payloadPayinSettlement.util');

/**
 * Allowed PayloadPayin status transitions (service-enforced).
 * Regressive / illegal transitions return false so out-of-order webhooks are ignored.
 */
const ALLOWED_TRANSITIONS = {
  [PAYIN_STATUS.CREATED]: new Set([
    PAYIN_STATUS.PROCESSING,
    PAYIN_STATUS.SUCCEEDED,
    PAYIN_STATUS.FAILED,
    PAYIN_STATUS.CANCELED,
    PAYIN_STATUS.IN_REVIEW,
  ]),
  [PAYIN_STATUS.PROCESSING]: new Set([
    PAYIN_STATUS.PROCESSING,
    PAYIN_STATUS.SUCCEEDED,
    PAYIN_STATUS.FAILED,
    PAYIN_STATUS.CANCELED,
    PAYIN_STATUS.IN_REVIEW,
  ]),
  [PAYIN_STATUS.IN_REVIEW]: new Set([
    PAYIN_STATUS.PROCESSING,
    PAYIN_STATUS.SUCCEEDED,
    PAYIN_STATUS.FAILED,
    PAYIN_STATUS.CANCELED,
    PAYIN_STATUS.IN_REVIEW,
  ]),
  [PAYIN_STATUS.SUCCEEDED]: new Set([
    PAYIN_STATUS.SUCCEEDED,
    PAYIN_STATUS.RETURNED,
  ]),
  [PAYIN_STATUS.FAILED]: new Set([
    PAYIN_STATUS.FAILED,
  ]),
  [PAYIN_STATUS.CANCELED]: new Set([
    PAYIN_STATUS.CANCELED,
  ]),
  [PAYIN_STATUS.RETURNED]: new Set([
    PAYIN_STATUS.RETURNED,
  ]),
};

function canTransitionPayinStatus(fromStatus, toStatus) {
  const from = String(fromStatus || PAYIN_STATUS.CREATED).trim().toUpperCase();
  const to = String(toStatus || '').trim().toUpperCase();
  if (!to) return false;
  if (from === to) return true;
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.has(to);
}

/**
 * Apply transition if allowed; returns { applied, status, reason }.
 */
function applyPayinStatusTransition(currentStatus, nextStatus) {
  const from = String(currentStatus || PAYIN_STATUS.CREATED).trim().toUpperCase();
  const to = String(nextStatus || '').trim().toUpperCase();
  if (!to) {
    return { applied: false, status: from, reason: 'missing_next_status' };
  }
  if (from === to) {
    return { applied: true, status: from, reason: 'noop' };
  }
  if (!canTransitionPayinStatus(from, to)) {
    return { applied: false, status: from, reason: 'forbidden_transition' };
  }
  return { applied: true, status: to, reason: 'ok' };
}

module.exports = {
  ALLOWED_TRANSITIONS,
  canTransitionPayinStatus,
  applyPayinStatusTransition,
};
