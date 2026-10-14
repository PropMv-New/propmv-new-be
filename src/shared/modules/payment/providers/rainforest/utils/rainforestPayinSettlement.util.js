'use strict';

const { PAYMENT_METHOD_TYPE } = require('../constants/rainforest.constants');
const {
  isInstantSettleMethodType,
  isAchLikeMethodType: isAchLikeMethodTypeFromUtil,
} = require('./rainforestPaymentMethodType.util');

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
  return String(status || '').trim().toUpperCase();
}

function isCardLikeMethodType(methodType) {
  return isInstantSettleMethodType(methodType);
}

function isAchLikeMethodType(methodType) {
  return isAchLikeMethodTypeFromUtil(methodType);
}

function invoiceMethodLabel(methodType) {
  return isCardLikeMethodType(methodType) ? 'card' : 'echeck';
}

/**
 * Settlement policy (production):
 * - Card / Apple Pay: settle on PROCESSING (approved, low reversal risk before deposit).
 * - ACH / Plaid ACH: settle on SUCCEEDED only (funds committed for merchant deposit).
 * - Fail on FAILED / RETURNED / CANCELED, including ACH returns flagged on succeeded payloads.
 */
function resolveRainforestPayinSettlementAction({
  methodType,
  status,
  eventType,
  hasAchReturn = false,
} = {}) {
  const normalizedStatus = normalizePayinStatus(status);
  const normalizedEvent = String(eventType || '').trim().toLowerCase();

  if (PAYIN_FAIL_STATUSES.has(normalizedStatus)) {
    return 'fail';
  }

  if (hasAchReturn && isAchLikeMethodType(methodType)) {
    return 'fail';
  }

  if (isCardLikeMethodType(methodType)) {
    // Settle on PROCESSING (preferred) or SUCCEEDED (idempotent if already settled).
    // Returning 'none' for SUCCEEDED left immediate card approvals with no invoice
    // settlement and no owner email/in-app notifications.
    if (
      normalizedStatus === PAYIN_STATUS.PROCESSING
      || normalizedEvent === 'payin.processing'
      || normalizedStatus === PAYIN_STATUS.SUCCEEDED
      || normalizedEvent === 'payin.succeeded'
    ) {
      return 'settle';
    }
  } else if (isAchLikeMethodType(methodType)) {
    if (
      normalizedStatus === PAYIN_STATUS.SUCCEEDED
      || normalizedEvent === 'payin.succeeded'
    ) {
      return 'settle';
    }
  } else {
    // Unknown method types default to conservative ACH-like behavior.
    if (
      normalizedStatus === PAYIN_STATUS.SUCCEEDED
      || normalizedEvent === 'payin.succeeded'
    ) {
      return 'settle';
    }
  }

  return 'none';
}

module.exports = {
  PAYIN_STATUS,
  PAYIN_FAIL_STATUSES,
  roundMoney,
  dollarsToMinorUnits,
  minorUnitsToDollars,
  normalizePayinStatus,
  isCardLikeMethodType,
  isAchLikeMethodType,
  invoiceMethodLabel,
  resolveRainforestPayinSettlementAction,
};
