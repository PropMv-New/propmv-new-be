'use strict';

const { PAYMENT_METHOD_TYPE } = require('../constants/payload.constants');

/** Methods shown in PropMv cards settings (cards + digital wallets). */
const PAYLOAD_CARDS_SECTION_ALLOWED_METHODS =
  'APPLE_PAY,GOOGLE_PAY,CARD,PAYPAL_WALLET,VENMO,PAYPAL_PAYLATER';

const WALLET_METHOD_TYPES = new Set([
  PAYMENT_METHOD_TYPE.APPLE_PAY,
  PAYMENT_METHOD_TYPE.GOOGLE_PAY,
  PAYMENT_METHOD_TYPE.PAYPAL_WALLET,
  PAYMENT_METHOD_TYPE.VENMO,
  PAYMENT_METHOD_TYPE.PAYPAL_PAYLATER,
]);

const MERCHANT_LOCKED_WALLET_TYPES = new Set([
  PAYMENT_METHOD_TYPE.PAYPAL_WALLET,
  PAYMENT_METHOD_TYPE.VENMO,
  PAYMENT_METHOD_TYPE.PAYPAL_PAYLATER,
]);

const CARDS_SECTION_METHOD_TYPES = new Set([
  PAYMENT_METHOD_TYPE.CARD,
  ...WALLET_METHOD_TYPES,
]);

function normalizeMethodType(methodType) {
  return String(methodType || '').trim().toUpperCase();
}

/** Infer PropMV method type from Payload API payment-method or transaction payloads. */
function resolveRemotePaymentMethodType(remote = {}) {
  const nested = remote?.payment_method || remote?.paymentMethod || {};
  const explicit = normalizeMethodType(
    remote?.method_type
    || remote?.methodType
    || nested?.method_type
    || nested?.methodType
  );
  if (explicit) return explicit;

  const objectType = String(remote?.type || nested?.type || '').trim().toLowerCase();
  if (objectType === 'bank_account') return PAYMENT_METHOD_TYPE.ACH;
  if (objectType === 'google_pay') return PAYMENT_METHOD_TYPE.GOOGLE_PAY;
  if (objectType === 'apple_pay') return PAYMENT_METHOD_TYPE.APPLE_PAY;
  if (objectType === 'card') return PAYMENT_METHOD_TYPE.CARD;

  if (remote?.google_pay && typeof remote.google_pay === 'object') {
    return PAYMENT_METHOD_TYPE.GOOGLE_PAY;
  }
  if (remote?.apple_pay && typeof remote.apple_pay === 'object') {
    return PAYMENT_METHOD_TYPE.APPLE_PAY;
  }
  return '';
}

function isWalletMethodType(methodType) {
  return WALLET_METHOD_TYPES.has(normalizeMethodType(methodType));
}

function isMerchantLockedWalletMethodType(methodType) {
  return MERCHANT_LOCKED_WALLET_TYPES.has(normalizeMethodType(methodType));
}

function isCardsSectionMethodType(methodType) {
  return CARDS_SECTION_METHOD_TYPES.has(normalizeMethodType(methodType));
}

/** Card + wallet methods settle quickly (processing), unlike ACH. */
function isInstantSettleMethodType(methodType) {
  return isCardsSectionMethodType(methodType);
}

/** Check21 remote deposit (board Upload Check) — ACH-like rails, stricter settle predicate. */
function isCheck21MethodType(methodType) {
  const normalized = normalizeMethodType(methodType);
  if (
    normalized === PAYMENT_METHOD_TYPE.CHECK
    || normalized === PAYMENT_METHOD_TYPE.CHECK21
  ) {
    return true;
  }
  return normalized.includes('CHECK21') || normalized === 'CHECK';
}

function isAchLikeMethodType(methodType) {
  const normalized = normalizeMethodType(methodType);
  // Check21 is handled separately (stricter funding settle rules).
  if (isCheck21MethodType(normalized)) {
    return false;
  }
  if (normalized === PAYMENT_METHOD_TYPE.ACH || normalized === PAYMENT_METHOD_TYPE.PLAID_ACH) {
    return true;
  }
  // Align with Payload payment-method storage (saved banks may use BANK_* labels).
  if (normalized.includes('ACH') || normalized.includes('PLAID')) {
    return true;
  }
  if (normalized.includes('BANK') && !normalized.includes('CARD')) {
    return true;
  }
  return false;
}

function allowedMethodsNeedWalletButtons(allowedMethods = '') {
  const upper = String(allowedMethods || '').toUpperCase();
  return [...WALLET_METHOD_TYPES].some((type) => upper.includes(type));
}

function allowedMethodsNeedOriginatingMerchant(allowedMethods = '') {
  const upper = String(allowedMethods || '').toUpperCase();
  return [...MERCHANT_LOCKED_WALLET_TYPES].some((type) => upper.includes(type));
}

module.exports = {
  PAYLOAD_CARDS_SECTION_ALLOWED_METHODS,
  WALLET_METHOD_TYPES,
  isWalletMethodType,
  isMerchantLockedWalletMethodType,
  isCardsSectionMethodType,
  isInstantSettleMethodType,
  isAchLikeMethodType,
  isCheck21MethodType,
  allowedMethodsNeedWalletButtons,
  allowedMethodsNeedOriginatingMerchant,
  normalizeMethodType,
  resolveRemotePaymentMethodType,
};
