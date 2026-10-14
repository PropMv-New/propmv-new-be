'use strict';

const { REFUND_STATUS } = require('../constants/rainforest.constants');
const {
  roundMoney,
  dollarsToMinorUnits,
} = require('./rainforestPayinSettlement.util');

function normalizeRefundStatus(status) {
  return String(status || '').trim().toUpperCase();
}

function resolveRainforestRefundLifecycleAction({
  status,
  eventType = '',
} = {}) {
  const normalizedStatus = normalizeRefundStatus(status);
  const normalizedEvent = String(eventType || '').trim().toLowerCase();

  if (
    normalizedStatus === REFUND_STATUS.SUCCEEDED
    || normalizedEvent === 'refund.succeeded'
  ) {
    return 'complete';
  }

  if (
    normalizedStatus === REFUND_STATUS.FAILED
    || normalizedStatus === REFUND_STATUS.CANCELED
    || normalizedEvent === 'refund.failed'
    || normalizedEvent === 'refund.canceled'
  ) {
    return 'fail';
  }

  return 'none';
}

function buildRefundIdempotencyKey({
  userId,
  invoiceId,
  paymentTransactionId,
  refundAttemptId,
}) {
  const crypto = require('crypto');
  const seed = [
    String(userId || ''),
    String(invoiceId || ''),
    String(paymentTransactionId || ''),
    String(refundAttemptId || ''),
  ].join(':');
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 40);
}

function mapInvoiceRefundToPayinMinorUnits(invoiceRefundAmount, payin) {
  const invoiceNet = roundMoney(payin?.invoicePaymentAmount || 0);
  const chargeCents = Number(payin?.chargeAmountCents || 0);
  const requestedCents = dollarsToMinorUnits(invoiceRefundAmount);

  if (invoiceNet <= 0 || chargeCents <= 0) {
    return requestedCents;
  }

  const invoiceNetCents = dollarsToMinorUnits(invoiceNet);
  if (invoiceNetCents <= 0) return requestedCents;

  const scaled = Math.round((requestedCents / invoiceNetCents) * chargeCents);
  return Math.max(0, Math.min(chargeCents, scaled));
}

function remainingInvoiceRefundableAmount(paymentTx) {
  const gross = roundMoney(paymentTx?.amount || 0);
  const priorRefunded = roundMoney(paymentTx?.refundedAmount || 0);
  return roundMoney(Math.max(0, gross - priorRefunded));
}

module.exports = {
  normalizeRefundStatus,
  resolveRainforestRefundLifecycleAction,
  buildRefundIdempotencyKey,
  mapInvoiceRefundToPayinMinorUnits,
  remainingInvoiceRefundableAmount,
};
