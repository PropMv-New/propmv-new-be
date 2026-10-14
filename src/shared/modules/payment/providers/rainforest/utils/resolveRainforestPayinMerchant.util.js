'use strict';

const mongoose = require('mongoose');
const RainforestAccount = require('../model/rainforestAccount.model');
const { RainforestDepositMethod } = require('../model/rainforestDepositMethod.model');
const {
  MERCHANT_ONBOARDING_STATUS,
  PAYMENT_METHOD_STATUS,
} = require('../constants/rainforest.constants');
const { isBillableRainforestMerchantAccount } = require('./rainforestBillableMerchant.util');

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

async function findRainforestAccountByMerchantId(merchantId) {
  if (!merchantId) return null;
  return RainforestAccount.findOne({
    merchantId: String(merchantId),
    isDeleted: { $ne: true },
  }).lean();
}

async function resolveRainforestAccountForDepositBank(depositBankAccountId) {
  const bankOid = toObjectId(depositBankAccountId);
  if (!bankOid) return null;

  const depositMethod = await RainforestDepositMethod.findOne({
    _id: bankOid,
    isDeleted: { $ne: true },
  }).lean();
  if (depositMethod?.merchantId) {
    const account = await findRainforestAccountByMerchantId(depositMethod.merchantId);
    if (account && isBillableRainforestMerchantAccount(account)) {
      return { account, depositMethod, source: 'rainforest_deposit_method' };
    }
  }

  return null;
}

async function assertPaymentMethodForPayin({ userId, paymentMethodRef, expectedMerchantId = null }) {
  const RainforestPaymentMethod = require('../model/rainforestPaymentMethod.model');
  const userOid = toObjectId(userId);
  if (!userOid) {
    const err = new Error('Invalid user context.');
    err.statusCode = 400;
    throw err;
  }

  let method = null;
  const ref = String(paymentMethodRef || '').trim();
  if (mongoose.Types.ObjectId.isValid(ref) && ref.length === 24) {
    method = await RainforestPaymentMethod.findOne({
      _id: ref,
      userId: userOid,
      isDeleted: { $ne: true },
    });
  }
  if (!method) {
    method = await RainforestPaymentMethod.findOne({
      providerPaymentMethodId: ref,
      userId: userOid,
      isDeleted: { $ne: true },
    });
  }

  if (!method) {
    const err = new Error('Rainforest payment method not found.');
    err.statusCode = 404;
    throw err;
  }

  const status = String(method.status || '').toUpperCase();
  const allowed = new Set([
    PAYMENT_METHOD_STATUS.ACTIVE,
    PAYMENT_METHOD_STATUS.CREATED,
  ]);
  if (!allowed.has(status)) {
    const err = new Error('This Rainforest payment method is not active.');
    err.statusCode = 400;
    throw err;
  }

  if (!method.billableMerchantId) {
    const err = new Error('Rainforest payment method is missing merchant scope.');
    err.statusCode = 400;
    throw err;
  }

  if (expectedMerchantId && String(method.billableMerchantId) !== String(expectedMerchantId)) {
    const err = new Error(
      'This payment method cannot be used for the selected invoice deposit bank. Add a payment method for the correct HOA business account.'
    );
    err.statusCode = 400;
    throw err;
  }

  const account = await findRainforestAccountByMerchantId(method.billableMerchantId);
  if (!account || !isBillableRainforestMerchantAccount(account)) {
    const err = new Error('Rainforest business merchant is not active. Ask your HOA board to complete payment setup.');
    err.statusCode = 400;
    throw err;
  }

  if (String(account.onboardingStatus || '').toUpperCase() !== MERCHANT_ONBOARDING_STATUS.ACTIVE) {
    const err = new Error('Rainforest business merchant is not active yet.');
    err.statusCode = 400;
    throw err;
  }

  return { method, account };
}

/**
 * Resolve the Rainforest merchant that will receive the payin.
 * Prefers the unit deposit bank's merchant when mapped; otherwise uses the payment method merchant.
 */
async function resolvePayinMerchantContext({ invoice, paymentMethodRef, userId }) {
  const Property = require('../../../../../../portals/hoa-board/modules/property/model/property.model');
  let depositContext = null;

  if (invoice?.propertyId) {
    const property = await Property.findById(invoice.propertyId)
      .select('depositBankAccountId depositBankAccountName hoaId')
      .lean();
    if (property?.depositBankAccountId) {
      depositContext = await resolveRainforestAccountForDepositBank(property.depositBankAccountId);
    }
  }

  const expectedMerchantId = depositContext?.account?.merchantId || null;
  const { method, account: methodAccount } = await assertPaymentMethodForPayin({
    userId,
    paymentMethodRef,
    expectedMerchantId,
  });

  const account = depositContext?.account || methodAccount;
  return {
    method,
    account,
    depositMethod: depositContext?.depositMethod || null,
    merchantId: String(account.merchantId),
  };
}

module.exports = {
  resolvePayinMerchantContext,
  assertPaymentMethodForPayin,
  resolveRainforestAccountForDepositBank,
  findRainforestAccountByMerchantId,
};
