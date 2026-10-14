'use strict';

const { roundMoney } = require('./payloadPayinSettlement.util');
const { isHoaOwnerPayloadScopeKey } = require('./payloadHoaOwnerCustomerContext.util');

function isInvalidPayloadChargeCustomerId(customerId, processingAccountId = '') {
  const id = String(customerId || '').trim();
  if (!id) return true;
  if (isHoaOwnerPayloadScopeKey(id)) return true;
  const processingId = String(processingAccountId || '').trim();
  if (processingId && id === processingId) return true;
  return false;
}

function classifyPayloadPaymentMethodScope(remote = {}) {
  const customer = String(remote.customer_id || remote.customerId || '').trim();
  if (customer && !isInvalidPayloadChargeCustomerId(customer)) {
    return 'customer';
  }
  const accountId = String(
    remote.account_id
    || remote.processing_id
    || remote.processingId
    || '',
  ).trim();
  if (accountId) return 'processing_account';
  return 'customer';
}

function resolvePayloadSettlementBankIdForMerchant(depositMethod, merchantId) {
  const settlementId = String(depositMethod?.depositMethodId || '').trim();
  if (!settlementId) return '';
  const depositMerchantId = String(depositMethod?.merchantId || '').trim();
  const chargeMerchantId = String(merchantId || '').trim();
  if (depositMerchantId && chargeMerchantId && depositMerchantId !== chargeMerchantId) {
    return '';
  }
  return settlementId;
}

/**
 * Payload Transaction.create fields (see docs.payload.com object reference):
 * - conv_fee is readonly (calculated by Payload); do not send on create.
 * - Payer processing fees are included in `amount` when billing settings assign fees to payer.
 */
function buildPayloadTransactionChargeBody({
  netAmount,
  totalCharge,
  amountValidation,
  customerId,
  paymentMethodId,
  merchantId,
  settlementBankId,
  description,
  metadata,
  clientIp,
}) {
  const payerPaysFee =
    amountValidation?.processingFeePaidBy === 'payer'
    && Number(amountValidation?.processingFeeAmount || 0) > 0;
  const transactionAmount = roundMoney(payerPaysFee ? totalCharge : netAmount);

  const body = {
    type: 'payment',
    amount: transactionAmount,
    description: description || '',
    payment_method_id: String(paymentMethodId),
    processing_id: String(merchantId),
    attrs: { ...(metadata || {}) },
  };

  const chargeCustomerId = String(customerId || '').trim();
  if (chargeCustomerId) {
    body.customer_id = chargeCustomerId;
  }

  if (settlementBankId) {
    body.processing_method_id = String(settlementBankId);
    body.attrs.propmv_deposit_payment_method_id = String(settlementBankId);
  }

  const ip = String(clientIp || '').trim();
  if (ip) {
    body.initiator = { ip };
  }

  return body;
}

/**
 * Payload PaymentMethod `account_id` is often the processing (merchant) account for send-only
 * payer instruments - it must not be compared to Customer id.
 * @see https://docs.payload.com/apis/object-reference/payment-methods/
 */
function resolvePayloadChargeCustomerId({
  localCustomerId,
  remotePaymentMethod = {},
  processingAccountId = '',
} = {}) {
  const local = String(localCustomerId || '').trim();
  const remoteCustomer = String(
    remotePaymentMethod.customer_id
    || remotePaymentMethod.customerId
    || ''
  ).trim();
  const processingId = String(processingAccountId || '').trim();

  if (remoteCustomer && !isInvalidPayloadChargeCustomerId(remoteCustomer, processingId)) {
    return remoteCustomer;
  }
  if (local && !isInvalidPayloadChargeCustomerId(local, processingId)) {
    return local;
  }
  return '';
}

function shouldRetryPayloadChargeWithoutCustomerId(err, transactionPayload = {}) {
  const status = Number(err?.statusCode || 0);
  if (status !== 400 && status !== 422) return false;
  if (!transactionPayload?.customer_id) return false;
  const message = String(err?.message || '').toLowerCase();
  return message.includes('payment_method_id');
}

function validateRemotePaymentMethodForCharge(remote = {}) {
  const status = String(remote.status || '').toLowerCase();
  if (status && !['active', 'created'].includes(status)) {
    const err = new Error('This payment method is not active. Choose another method or re-add it in Settings.');
    err.statusCode = 400;
    throw err;
  }
}

module.exports = {
  buildPayloadTransactionChargeBody,
  resolvePayloadChargeCustomerId,
  validateRemotePaymentMethodForCharge,
  classifyPayloadPaymentMethodScope,
  resolvePayloadSettlementBankIdForMerchant,
  shouldRetryPayloadChargeWithoutCustomerId,
  isInvalidPayloadChargeCustomerId,
};
