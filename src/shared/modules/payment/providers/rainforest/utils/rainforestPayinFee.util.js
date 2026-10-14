'use strict';

const {
  calcProcessingFeeAmount,
  normalizeBillingSettings,
} = require('../../../../billing-settings/service/billingSettings.service');
const {
  roundMoney,
  dollarsToMinorUnits,
} = require('./rainforestPayinSettlement.util');

const {
  isInstantSettleMethodType,
  isAchLikeMethodType,
} = require('./rainforestPaymentMethodType.util');

function resolveRainforestFeeMethodKey(methodType) {
  if (isInstantSettleMethodType(methodType)) return 'card';
  if (isAchLikeMethodType(methodType)) return 'bankTransfer';
  return 'card';
}

function resolveProcessingFeePaidBy(methodType, billingSettings = normalizeBillingSettings()) {
  const fees = billingSettings.transactionFees || {};
  const methodKey = resolveRainforestFeeMethodKey(methodType);
  if (methodKey === 'card') {
    return fees.card?.paidBy === 'operator' ? 'operator' : 'payer';
  }
  return fees.bankTransfer?.paidBy === 'operator' ? 'operator' : 'payer';
}

/**
 * Compute PropMv processing fee + Rainforest PLATFORM split for a payin.
 * When paidBy=operator, charge equals invoice amount and no split is applied.
 */
function calculateRainforestProcessingFee({
  invoicePaymentAmount,
  methodType,
  billingSettings = normalizeBillingSettings(),
  applyFee = true,
} = {}) {
  const netAmount = roundMoney(invoicePaymentAmount);
  const methodKey = resolveRainforestFeeMethodKey(methodType);
  const paidBy = resolveProcessingFeePaidBy(methodType, billingSettings);
  const rawFee = applyFee
    ? calcProcessingFeeAmount(netAmount, methodKey, billingSettings)
    : 0;
  const processingFeeAmount = paidBy === 'payer' ? roundMoney(rawFee) : 0;
  const chargeAmount = roundMoney(netAmount + processingFeeAmount);
  const platformFeeCents = processingFeeAmount > 0
    ? dollarsToMinorUnits(processingFeeAmount)
    : 0;

  return {
    invoicePaymentAmount: netAmount,
    processingFeeAmount,
    processingFeePaidBy: paidBy,
    chargeAmount,
    platformFeeCents,
    amountSplits: buildRainforestPlatformAmountSplits(platformFeeCents),
  };
}

function buildRainforestPlatformAmountSplits(platformFeeCents) {
  const cents = Math.round(Number(platformFeeCents || 0));
  if (cents <= 0) return null;

  return [{
    type: 'PLATFORM',
    amount: cents,
    currency_code: 'USD',
    amount_split_reversal_config: {
      on_full_refund: true,
      on_ach_return: true,
    },
  }];
}

function validateRainforestPayinAmounts({
  invoicePaymentAmount,
  chargeAmount,
  methodType,
  billingSettings = normalizeBillingSettings(),
} = {}) {
  const netAmount = roundMoney(invoicePaymentAmount);
  const suppliedCharge = roundMoney(chargeAmount != null ? chargeAmount : netAmount);
  const withFeeQuote = calculateRainforestProcessingFee({
    invoicePaymentAmount: netAmount,
    methodType,
    billingSettings,
    applyFee: true,
  });
  const withoutFeeQuote = calculateRainforestProcessingFee({
    invoicePaymentAmount: netAmount,
    methodType,
    billingSettings,
    applyFee: false,
  });
  const includesFee = suppliedCharge > netAmount + 0.009;

  if (
    !includesFee
    && withFeeQuote.processingFeePaidBy === 'payer'
    && withFeeQuote.processingFeeAmount > 0
  ) {
    return {
      valid: false,
      reason: 'missing_payer_fee',
      expectedChargeAmount: withFeeQuote.chargeAmount,
      processingFeeAmount: withFeeQuote.processingFeeAmount,
      processingFeePaidBy: withFeeQuote.processingFeePaidBy,
    };
  }

  const expected = includesFee ? withFeeQuote : withoutFeeQuote;

  if (Math.abs(suppliedCharge - expected.chargeAmount) > 0.009) {
    return {
      valid: false,
      expectedChargeAmount: expected.chargeAmount,
      processingFeeAmount: expected.processingFeeAmount,
      processingFeePaidBy: expected.processingFeePaidBy,
    };
  }

  if (includesFee && expected.processingFeePaidBy === 'operator') {
    return {
      valid: false,
      reason: 'operator_pays_fees',
      expectedChargeAmount: netAmount,
      processingFeeAmount: 0,
      processingFeePaidBy: expected.processingFeePaidBy,
    };
  }

  return {
    valid: true,
    ...expected,
  };
}

/**
 * Resolve charge totals for execute. When the client omits the payer fee, apply the
 * server-side billing quote instead of failing (Phase 3E authoritative fees).
 */
function resolveAuthoritativeRainforestPayinAmounts({
  invoicePaymentAmount,
  chargeAmount,
  methodType,
  billingSettings = normalizeBillingSettings(),
} = {}) {
  const netAmount = roundMoney(invoicePaymentAmount);
  let totalCharge = roundMoney(chargeAmount != null ? chargeAmount : netAmount);
  let validation = validateRainforestPayinAmounts({
    invoicePaymentAmount: netAmount,
    chargeAmount: totalCharge,
    methodType,
    billingSettings,
  });

  if (
    !validation.valid
    && validation.reason === 'missing_payer_fee'
    && validation.expectedChargeAmount
  ) {
    totalCharge = roundMoney(validation.expectedChargeAmount);
    validation = validateRainforestPayinAmounts({
      invoicePaymentAmount: netAmount,
      chargeAmount: totalCharge,
      methodType,
      billingSettings,
    });
  }

  return {
    netAmount,
    totalCharge,
    validation,
  };
}

function buildRainforestRefundAmountSplits(payin = {}, refundChargeCents) {
  const platformFeeCents = Math.round(Number(payin.platformFeeCents || 0));
  const chargeCents = Math.round(Number(payin.chargeAmountCents || 0));
  const requested = Math.round(Number(refundChargeCents || 0));

  if (platformFeeCents <= 0 || chargeCents <= 0 || requested <= 0) {
    return null;
  }

  const platformReversalCents = Math.min(
    platformFeeCents,
    Math.round((requested / chargeCents) * platformFeeCents)
  );

  if (platformReversalCents <= 0) return null;

  return [{
    type: 'PLATFORM',
    amount: platformReversalCents,
    currency_code: 'USD',
  }];
}

module.exports = {
  resolveRainforestFeeMethodKey,
  resolveProcessingFeePaidBy,
  calculateRainforestProcessingFee,
  buildRainforestPlatformAmountSplits,
  validateRainforestPayinAmounts,
  resolveAuthoritativeRainforestPayinAmounts,
  buildRainforestRefundAmountSplits,
};
