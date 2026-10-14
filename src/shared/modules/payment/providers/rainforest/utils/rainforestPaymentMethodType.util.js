'use strict';

const { PAYMENT_METHOD_TYPE } = require('../constants/rainforest.constants');

/** Methods shown in PropMv cards settings (cards + digital wallets). */
const RAINFOREST_CARDS_SECTION_ALLOWED_METHODS =
  'APPLE_PAY,CARD,PAYPAL_WALLET,VENMO,PAYPAL_PAYLATER';

const WALLET_METHOD_TYPES = new Set([
  PAYMENT_METHOD_TYPE.APPLE_PAY,
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

function isAchLikeMethodType(methodType) {
  const normalized = normalizeMethodType(methodType);
  return normalized === PAYMENT_METHOD_TYPE.ACH
    || normalized === PAYMENT_METHOD_TYPE.PLAID_ACH;
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
  RAINFOREST_CARDS_SECTION_ALLOWED_METHODS,
  WALLET_METHOD_TYPES,
  isWalletMethodType,
  isMerchantLockedWalletMethodType,
  isCardsSectionMethodType,
  isInstantSettleMethodType,
  isAchLikeMethodType,
  allowedMethodsNeedWalletButtons,
  allowedMethodsNeedOriginatingMerchant,
  normalizeMethodType,
};
