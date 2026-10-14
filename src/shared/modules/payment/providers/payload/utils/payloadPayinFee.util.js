'use strict';

const {
  calcProcessingFeeAmount,
  normalizeBillingSettings,
} = require('../../../../billing-settings/service/billingSettings.service');
const { roundMoney, dollarsToMinorUnits } = require('./payloadPayinSettlement.util');
const {
  isInstantSettleMethodType,
  isAchLikeMethodType,
} = require('./payloadPaymentMethodType.util');

function resolvePayloadFeeMethodKey(methodType) {
  if (isInstantSettleMethodType(methodType)) return 'card';
  if (isAchLikeMethodType(methodType)) return 'bankTransfer';
  return 'card';
}

function resolveProcessingFeePaidBy(methodType, billingSettings = normalizeBillingSettings()) {
  const fees = billingSettings.transactionFees || {};
  const methodKey = resolvePayloadFeeMethodKey(methodType);
  if (methodKey === 'card') {
    return fees.card?.paidBy === 'operator' ? 'operator' : 'payer';
  }
  return fees.bankTransfer?.paidBy === 'operator' ? 'operator' : 'payer';
}

/**
 * PropMv processing fees from HOA/landlord billing settings.
 * When paidBy is payer, the fee is included in the Payload transaction `amount`
 * (Payload `conv_fee` on transactions is readonly / platform-calculated).
 */
function calculatePayloadProcessingFee({
  invoicePaymentAmount,
  methodType,
  billingSettings = normalizeBillingSettings(),
  applyFee = true,
} = {}) {
  const netAmount = roundMoney(invoicePaymentAmount);
  const methodKey = resolvePayloadFeeMethodKey(methodType);
  const paidBy = resolveProcessingFeePaidBy(methodType, billingSettings);
  const rawFee = applyFee
    ? calcProcessingFeeAmount(netAmount, methodKey, billingSettings)
    : 0;
  const processingFeeAmount = paidBy === 'payer' ? roundMoney(rawFee) : 0;
  const chargeAmount = roundMoney(netAmount + processingFeeAmount);
  const convFeeCents = processingFeeAmount > 0
    ? dollarsToMinorUnits(processingFeeAmount)
    : 0;

  return {
    invoicePaymentAmount: netAmount,
    processingFeeAmount,
    processingFeePaidBy: paidBy,
    chargeAmount,
    platformFeeCents: convFeeCents,
    convFeeAmount: processingFeeAmount,
    convFeeCents,
  };
}

function validatePayloadPayinAmounts({
  invoicePaymentAmount,
  chargeAmount,
  methodType,
  billingSettings = normalizeBillingSettings(),
} = {}) {
  const netAmount = roundMoney(invoicePaymentAmount);
  const suppliedCharge = roundMoney(chargeAmount != null ? chargeAmount : netAmount);
  const withFeeQuote = calculatePayloadProcessingFee({
    invoicePaymentAmount: netAmount,
    methodType,
    billingSettings,
    applyFee: true,
  });
  const withoutFeeQuote = calculatePayloadProcessingFee({
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
      convFeeAmount: withFeeQuote.convFeeAmount,
      convFeeCents: withFeeQuote.convFeeCents,
    };
  }

  const expected = includesFee ? withFeeQuote : withoutFeeQuote;

  if (Math.abs(suppliedCharge - expected.chargeAmount) > 0.009) {
    return {
      valid: false,
      expectedChargeAmount: expected.chargeAmount,
      processingFeeAmount: expected.processingFeeAmount,
      processingFeePaidBy: expected.processingFeePaidBy,
      convFeeAmount: expected.convFeeAmount,
      convFeeCents: expected.convFeeCents,
    };
  }

  if (includesFee && expected.processingFeePaidBy === 'operator') {
    return {
      valid: false,
      reason: 'operator_pays_fees',
      expectedChargeAmount: netAmount,
      processingFeeAmount: 0,
      processingFeePaidBy: expected.processingFeePaidBy,
      convFeeAmount: 0,
      convFeeCents: 0,
    };
  }

  return {
    valid: true,
    ...expected,
  };
}

function resolveAuthoritativePayloadPayinAmounts({
  invoicePaymentAmount,
  chargeAmount,
  methodType,
  billingSettings = normalizeBillingSettings(),
  skipPayerFeeAutofill = false,
} = {}) {
  const netAmount = roundMoney(invoicePaymentAmount);
  let totalCharge = roundMoney(chargeAmount != null ? chargeAmount : netAmount);
  let validation = validatePayloadPayinAmounts({
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
    if (skipPayerFeeAutofill) {
      // Multi-invoice Pay Total: fee is charged on the first leg only. Later legs
      // intentionally send chargeAmount === invoicePaymentAmount.
      const withoutFeeQuote = calculatePayloadProcessingFee({
        invoicePaymentAmount: netAmount,
        methodType,
        billingSettings,
        applyFee: false,
      });
      validation = {
        valid: true,
        ...withoutFeeQuote,
      };
    } else {
      totalCharge = roundMoney(validation.expectedChargeAmount);
      validation = validatePayloadPayinAmounts({
        invoicePaymentAmount: netAmount,
        chargeAmount: totalCharge,
        methodType,
        billingSettings,
      });
    }
  }

  return {
    netAmount,
    totalCharge,
    validation,
  };
}

module.exports = {
  resolvePayloadFeeMethodKey,
  resolveProcessingFeePaidBy,
  calculatePayloadProcessingFee,
  validatePayloadPayinAmounts,
  resolveAuthoritativePayloadPayinAmounts,
};
