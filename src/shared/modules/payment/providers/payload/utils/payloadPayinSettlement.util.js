'use strict';

const { PAYMENT_METHOD_TYPE } = require('../constants/payload.constants');
const {
  isInstantSettleMethodType,
  isAchLikeMethodType: isAchLikeMethodTypeFromUtil,
  isCheck21MethodType,
} = require('./payloadPaymentMethodType.util');

const PAYIN_STATUS = {
  CREATED: 'CREATED',
  PROCESSING: 'PROCESSING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  RETURNED: 'RETURNED',
  CANCELED: 'CANCELED',
  IN_REVIEW: 'IN_REVIEW',
};

const PAYIN_FAIL_STATUSES = new Set([
  PAYIN_STATUS.FAILED,
  PAYIN_STATUS.RETURNED,
  PAYIN_STATUS.CANCELED,
]);

/** Funding states that mean Check21 must not settle PropMV books yet (stricter than ACH). */
const CHECK21_DEFERRED_FUNDING = new Set(['pending', 'processing']);

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function dollarsToMinorUnits(dollars) {
  return Math.round(roundMoney(dollars) * 100);
}

function minorUnitsToDollars(minorUnits) {
  return roundMoney(Number(minorUnits || 0) / 100);
}

function normalizePayinStatus(status) {
  const raw = String(status || '').trim().toUpperCase();
  const payloadMap = {
    AUTHORIZED: PAYIN_STATUS.PROCESSING,
    PROCESSING: PAYIN_STATUS.PROCESSING,
    PROCESSED: PAYIN_STATUS.SUCCEEDED,
    DECLINED: PAYIN_STATUS.FAILED,
    REJECTED: PAYIN_STATUS.FAILED,
    VOIDED: PAYIN_STATUS.CANCELED,
  };
  return payloadMap[raw] || raw;
}

function normalizeFundingStatus(fundingStatus) {
  return String(fundingStatus || '').trim().toLowerCase();
}

function mapPayloadTransactionToPayinFields(remote = {}) {
  const statusRaw = remote.status || remote.value || '';
  const risk = String(remote.risk_flag || '').toLowerCase();
  let status = normalizePayinStatus(statusRaw);
  if (risk === 'in_review') {
    status = PAYIN_STATUS.IN_REVIEW;
  }
  const funding = normalizeFundingStatus(remote.funding_status || remote.fundingStatus);
  const fundingRejected = funding === 'reversed';
  return {
    status,
    payinId: remote.id || remote.transaction_id || null,
    refusalCode: remote.status_code || '',
    refusalDesc: remote.status_message || remote.statusMessage || '',
    hasAchReturn: fundingRejected,
    fundingStatus: funding || null,
  };
}

function isCardLikeMethodType(methodType) {
  return isInstantSettleMethodType(methodType);
}

function isAchLikeMethodType(methodType) {
  return isAchLikeMethodTypeFromUtil(methodType);
}

function invoiceMethodLabel(methodType) {
  if (isCardLikeMethodType(methodType)) return 'card';
  // Distinct from offline manual Record Payment method "Check"
  if (isCheck21MethodType(methodType)) return 'check21';
  if (isAchLikeMethodType(methodType)) return 'echeck';
  return 'echeck';
}

/**
 * Settlement policy (production):
 * - Card / Apple Pay: settle on PROCESSING or SUCCEEDED/processed (first confirmation;
 *   alreadySettled guards duplicate settle when a later processed webhook arrives).
 * - ACH / Plaid ACH: settle on SUCCEEDED only (funds committed for merchant deposit).
 * - Check21: ACH-like fail paths; settle on SUCCEEDED/processed only when funding is not
 *   deferred (pending/processing). Stricter than ACH — see roadmap-check21.md §6.1.
 * - Fail on FAILED / RETURNED / CANCELED, including ACH returns flagged on succeeded payloads.
 * - Post-settle reject is handled separately (reverse) when payin already settled.
 */
function resolvePayloadPayinSettlementAction({
  methodType,
  status,
  eventType,
  hasAchReturn = false,
  fundingStatus = null,
  alreadySettled = false,
} = {}) {
  const normalizedStatus = normalizePayinStatus(status);
  const normalizedEvent = String(eventType || '').trim().toLowerCase();
  const evt = normalizedEvent.replace('payin.', '');
  const funding = normalizeFundingStatus(fundingStatus);

  if (alreadySettled) {
    if (
      normalizedStatus === PAYIN_STATUS.FAILED
      || normalizedStatus === PAYIN_STATUS.RETURNED
      || funding === 'reversed'
      || evt === 'reject'
      || evt === 'refund'
    ) {
      return 'reverse';
    }
    return 'none';
  }

  if (PAYIN_FAIL_STATUSES.has(normalizedStatus)) {
    return 'fail';
  }

  if (hasAchReturn && (isAchLikeMethodType(methodType) || isCheck21MethodType(methodType))) {
    return 'fail';
  }

  if (isCardLikeMethodType(methodType)) {
    // Settle on first confirmation. Sandbox (and some live charges) return
    // `processed` / SUCCEEDED immediately without an intermediate PROCESSING
    // status — previously that path returned `none` and left Vendor/HOA invoices
    // stuck in Processing with settledAt=null when webhooks were absent.
    // alreadySettled (above) prevents double-settle on later processed webhooks.
    if (
      normalizedStatus === PAYIN_STATUS.PROCESSING
      || normalizedStatus === PAYIN_STATUS.SUCCEEDED
      || evt === 'processing'
      || evt === 'authorized'
      || evt === 'processed'
    ) {
      return 'settle';
    }
  } else if (isCheck21MethodType(methodType)) {
    if (normalizedStatus === PAYIN_STATUS.SUCCEEDED || evt === 'processed') {
      if (CHECK21_DEFERRED_FUNDING.has(funding)) {
        return 'none';
      }
      return 'settle';
    }
  } else if (isAchLikeMethodType(methodType)) {
    if (normalizedStatus === PAYIN_STATUS.SUCCEEDED || evt === 'processed') {
      return 'settle';
    }
  } else if (normalizedStatus === PAYIN_STATUS.SUCCEEDED || evt === 'processed') {
    return 'settle';
  }

  return 'none';
}

module.exports = {
  PAYIN_STATUS,
  PAYIN_FAIL_STATUSES,
  CHECK21_DEFERRED_FUNDING,
  roundMoney,
  dollarsToMinorUnits,
  minorUnitsToDollars,
  normalizePayinStatus,
  normalizeFundingStatus,
  isCardLikeMethodType,
  isAchLikeMethodType,
  invoiceMethodLabel,
  resolvePayloadPayinSettlementAction,
  mapPayloadTransactionToPayinFields,
  PAYMENT_METHOD_TYPE,
};
