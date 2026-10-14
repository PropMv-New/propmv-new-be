'use strict';

const mongoose = require('mongoose');
const PayloadAccount = require('../model/payloadAccount.model');
const { PayloadDepositMethod } = require('../model/payloadDepositMethod.model');
const {
  MERCHANT_ONBOARDING_STATUS,
  PAYMENT_METHOD_STATUS,
} = require('../constants/payload.constants');
const {
  isBillablePayloadMerchantAccount,
  findActiveBillableMerchantId,
} = require('./payloadBillableMerchant.util');
const payloadConfig = require('../../../../../../config/payload.config');
const { ENTITY_TYPE } = require('../constants/payload.constants');
const {
  isPayloadOwnerMethodInHoaScope,
  resolveHoaOwnerPayloadCustomerContext,
  isHoaOwnerPayloadScopeKey,
  parseHoaIdFromOwnerPayloadScopeKey,
} = require('./payloadHoaOwnerCustomerContext.util');
const { normalizeHoaId } = require('./payloadBillableMerchant.util');

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

async function findPayloadAccountByMerchantId(merchantId) {
  if (!merchantId) return null;
  return PayloadAccount.findOne({
    merchantId: String(merchantId),
    isDeleted: { $ne: true },
  }).lean();
}

async function resolvePayloadAccountForDepositBank(depositBankAccountId) {
  const ref = String(depositBankAccountId || '').trim();
  if (!ref) return null;

  const bankOid = toObjectId(ref);
  let depositMethod = null;
  if (bankOid) {
    depositMethod = await PayloadDepositMethod.findOne({
      _id: bankOid,
      isDeleted: { $ne: true },
    }).lean();
  }
  if (!depositMethod) {
    depositMethod = await PayloadDepositMethod.findOne({
      depositMethodId: ref,
      isDeleted: { $ne: true },
    }).lean();
  }

  if (depositMethod?.merchantId) {
    const account = await findPayloadAccountByMerchantId(depositMethod.merchantId);
    if (account && isBillablePayloadMerchantAccount(account)) {
      return { account, depositMethod, source: 'payload_deposit_method' };
    }
  }

  return null;
}

async function resolveHoaPayinMerchantId(hoaId, depositContext = null, { boardMemberIds } = {}) {
  const hoaIdStr = normalizeHoaId(hoaId);
  if (depositContext?.account?.merchantId) {
    const merchantId = String(depositContext.account.merchantId);
    if (!Array.isArray(boardMemberIds)) {
      return merchantId;
    }
    const { buildHoaBillableMerchantQuery, isBillablePayloadMerchantAccount } = require('./payloadBillableMerchant.util');
    const scopedQuery = buildHoaBillableMerchantQuery(hoaIdStr, { boardMemberIds });
    if (!scopedQuery) return '';
    const PayloadAccount = require('../model/payloadAccount.model');
    const account = await PayloadAccount.findOne({
      ...scopedQuery,
      merchantId,
    }).lean();
    if (account && isBillablePayloadMerchantAccount(account)) {
      return merchantId;
    }
  }
  if (!hoaIdStr) return '';
  const { resolvePayloadHoaOwnerBillableMerchantId } = require('./payloadHoaOwnerBillableMerchant.util');
  return resolvePayloadHoaOwnerBillableMerchantId(hoaIdStr, { findActiveBillableMerchantId, boardMemberIds });
}

function inferHoaIdForOwnerPaymentMethod(method, hoaId) {
  const explicit = normalizeHoaId(hoaId);
  if (explicit) return explicit;
  if (method?.entityType === ENTITY_TYPE.HOA && method.entityId) {
    return normalizeHoaId(method.entityId);
  }
  if (isHoaOwnerPayloadScopeKey(method?.billableMerchantId)) {
    return parseHoaIdFromOwnerPayloadScopeKey(method.billableMerchantId);
  }
  return '';
}

async function assertActiveBillableMerchantAccount(merchantId) {
  const account = await findPayloadAccountByMerchantId(merchantId);
  if (!account || !isBillablePayloadMerchantAccount(account)) {
    const err = new Error('Payload business merchant is not active. Ask your HOA board to complete payment setup.');
    err.statusCode = 400;
    throw err;
  }

  if (String(account.onboardingStatus || '').toUpperCase() !== MERCHANT_ONBOARDING_STATUS.ACTIVE) {
    const err = new Error('Payload business merchant is not active yet.');
    err.statusCode = 400;
    throw err;
  }

  return account;
}

async function assertPaymentMethodForPayin({
  userId,
  paymentMethodRef,
  expectedMerchantId = null,
  hoaId = null,
}) {
  const PayloadPaymentMethod = require('../model/payloadPaymentMethod.model');
  const userOid = toObjectId(userId);
  if (!userOid) {
    const err = new Error('Invalid user context.');
    err.statusCode = 400;
    throw err;
  }

  let method = null;
  const ref = String(paymentMethodRef || '').trim();
  if (mongoose.Types.ObjectId.isValid(ref) && ref.length === 24) {
    method = await PayloadPaymentMethod.findOne({
      _id: ref,
      userId: userOid,
      isDeleted: { $ne: true },
    });
  }
  if (!method) {
    method = await PayloadPaymentMethod.findOne({
      providerPaymentMethodId: ref,
      userId: userOid,
      isDeleted: { $ne: true },
    });
  }

  if (!method) {
    const err = new Error('Payload payment method not found.');
    err.statusCode = 404;
    throw err;
  }

  const status = String(method.status || '').toUpperCase();
  const allowed = new Set([
    PAYMENT_METHOD_STATUS.ACTIVE,
    PAYMENT_METHOD_STATUS.CREATED,
  ]);
  if (!allowed.has(status)) {
    const err = new Error('This Payload payment method is not active.');
    err.statusCode = 400;
    throw err;
  }

  const hasScope = Boolean(method.billableMerchantId)
    || (method.entityType === ENTITY_TYPE.HOA && method.entityId);
  if (!hasScope) {
    const err = new Error('Payload payment method is missing merchant scope.');
    err.statusCode = 400;
    throw err;
  }

  const inferredHoaId = inferHoaIdForOwnerPaymentMethod(method, hoaId);
  const unifiedHoaPayin = Boolean(
    inferredHoaId
    && payloadConfig.payload.hoaUnifiedOwnerWallet
  );

  if (unifiedHoaPayin) {
    const ctx = await resolveHoaOwnerPayloadCustomerContext(inferredHoaId, {
      findActiveBillableMerchantId,
      ownerUserId: userId,
    });
    if (!isPayloadOwnerMethodInHoaScope(method, inferredHoaId, ctx)) {
      const err = new Error(
        'This payment method is not saved for your HOA community. Add a bank or card from Payment Settings.'
      );
      err.statusCode = 400;
      throw err;
    }
    const payinMerchantId = expectedMerchantId
      || await resolveHoaPayinMerchantId(inferredHoaId, null, { boardMemberIds: ctx.boardMemberIds })
      || ctx.primaryProcessingId
      || ctx.merchantIds[0]
      || '';
    if (!payinMerchantId) {
      const err = new Error('Payload business merchant is not active. Ask your HOA board to complete payment setup.');
      err.statusCode = 400;
      throw err;
    }
    const account = await assertActiveBillableMerchantAccount(payinMerchantId);
    return { method, account };
  }

  if (expectedMerchantId && String(method.billableMerchantId) !== String(expectedMerchantId)) {
    const err = new Error(
      'This payment method cannot be used for the selected invoice deposit bank. Add a payment method for the correct HOA business account.'
    );
    err.statusCode = 400;
    throw err;
  }

  const account = await assertActiveBillableMerchantAccount(method.billableMerchantId);
  return { method, account };
}

/**
 * Resolve the Payload merchant that will receive the payin.
 * Prefers the unit deposit bank's merchant when mapped; otherwise uses the payment method merchant.
 */
async function resolvePayinMerchantContext({ invoice, paymentMethodRef, userId }) {
  const Property = require('../../../../../../portals/hoa-board/modules/property/model/property.model');
  let depositContext = null;

  let propertyHoaId = null;
  if (invoice?.propertyId) {
    const property = await Property.findById(invoice.propertyId)
      .select('depositBankAccountId depositBankAccountName hoaId')
      .lean();
    propertyHoaId = property?.hoaId ? String(property.hoaId) : null;
    if (property?.depositBankAccountId) {
      depositContext = await resolvePayloadAccountForDepositBank(property.depositBankAccountId);
    }
  }

  let expectedMerchantId = depositContext?.account?.merchantId || null;
  if (propertyHoaId && payloadConfig.payload.hoaUnifiedOwnerWallet && userId) {
    const ctx = await resolveHoaOwnerPayloadCustomerContext(propertyHoaId, {
      findActiveBillableMerchantId,
      ownerUserId: userId,
    });
    expectedMerchantId = await resolveHoaPayinMerchantId(propertyHoaId, depositContext, {
      boardMemberIds: ctx.boardMemberIds,
    }) || null;
  }

  const { method, account: methodAccount } = await assertPaymentMethodForPayin({
    userId,
    paymentMethodRef,
    expectedMerchantId,
    hoaId: propertyHoaId,
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
  resolvePayloadAccountForDepositBank,
  findPayloadAccountByMerchantId,
  inferHoaIdForOwnerPaymentMethod,
  resolveHoaPayinMerchantId,
};
