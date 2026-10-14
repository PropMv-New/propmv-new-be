'use strict';

const {
  MERCHANT_ONBOARDING_STATUS,
  MERCHANT_STATUS,
  ENTITY_TYPE,
} = require('../constants/rainforest.constants');

function normalizeHoaId(value) {
  return String(value || '').trim();
}

function buildHoaBillableMerchantQuery(hoaId) {
  const normalized = normalizeHoaId(hoaId);
  if (!normalized) return null;

  return {
    isDeleted: { $ne: true },
    merchantId: { $ne: null },
    entityType: ENTITY_TYPE.HOA,
    'metadata.hoaId': normalized,
  };
}

function buildEntityBillableMerchantQuery({ entityType, businessId, toObjectId }) {
  if (!entityType || !businessId) return null;
  const businessOid = toObjectId(businessId);
  if (!businessOid) return null;

  return {
    isDeleted: { $ne: true },
    merchantId: { $ne: null },
    entityType,
    businessId: businessOid,
  };
}

function isBillableRainforestMerchantAccount(account) {
  if (!account?.merchantId) return false;

  const onboardingStatus = String(account.onboardingStatus || '').toUpperCase();
  if (onboardingStatus === MERCHANT_ONBOARDING_STATUS.ACTIVE) return true;

  const merchantStatus = String(account.merchantStatus || '').toUpperCase();
  return merchantStatus === MERCHANT_STATUS.ACTIVE;
}

function billableMerchantUnavailableMessage({ entityType, entityId } = {}) {
  if (entityType === ENTITY_TYPE.HOA && entityId) {
    return 'No active Business Merchant Account is available for this HOA yet. Ask your HOA board to complete Business Merchant Account onboarding and approve at least one business merchant - then owners can save cards and bank accounts.';
  }
    return 'No active Rainforest business merchant is available for this account yet. Complete Business Merchant Account onboarding and approval before saving payment methods.';
}

module.exports = {
  buildHoaBillableMerchantQuery,
  buildEntityBillableMerchantQuery,
  isBillableRainforestMerchantAccount,
  billableMerchantUnavailableMessage,
  normalizeHoaId,
};
