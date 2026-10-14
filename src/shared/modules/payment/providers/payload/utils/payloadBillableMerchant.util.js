'use strict';

const {
  MERCHANT_ONBOARDING_STATUS,
  MERCHANT_STATUS,
  ENTITY_TYPE,
} = require('../constants/payload.constants');

function normalizeHoaId(value) {
  return String(value || '').trim();
}

function buildHoaBillableMerchantQuery(hoaId, { boardMemberIds } = {}) {
  const normalized = normalizeHoaId(hoaId);
  if (!normalized) return null;

  const query = {
    isDeleted: { $ne: true },
    merchantId: { $ne: null },
    entityType: ENTITY_TYPE.HOA,
    'metadata.hoaId': normalized,
  };

  if (Array.isArray(boardMemberIds)) {
    const { boardMemberObjectIds } = require('./payloadHoaOwnerBoardMemberScope.util');
    const createdByIds = boardMemberObjectIds(boardMemberIds);
    query.createdBy = createdByIds.length ? { $in: createdByIds } : { $in: [] };
  }

  return query;
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

function isBillablePayloadMerchantAccount(account) {
  if (!account?.merchantId) return false;

  const onboardingStatus = String(account.onboardingStatus || '').toUpperCase();
  if (onboardingStatus === MERCHANT_ONBOARDING_STATUS.ACTIVE) return true;

  if (account.metadata?.payloadSandboxSimulatedActive) return true;

  const merchantStatus = String(account.merchantStatus || '').toUpperCase();
  if (merchantStatus === MERCHANT_STATUS.ACTIVE) return true;

  return String(account.merchantStatus || '').toLowerCase() === 'active';
}

async function findActiveBillableMerchantId(scopedQuery, { PayloadAccountModel, syncPayloadAccountFromRemote, logger } = {}) {
  if (!scopedQuery) return '';

  const Account = PayloadAccountModel || require('../model/payloadAccount.model');
  const syncRemote = syncPayloadAccountFromRemote
    || require('../service/payloadMerchant.service').syncPayloadAccountFromRemote;
  const log = logger || require('../../../../../../common/logger');

  const activeLocal = await Account.findOne({
    ...scopedQuery,
    onboardingStatus: MERCHANT_ONBOARDING_STATUS.ACTIVE,
  }).sort({ updatedAt: -1 });
  if (activeLocal?.merchantId) return activeLocal.merchantId;

  const candidates = await Account.find(scopedQuery).sort({ updatedAt: -1 });
  for (const candidate of candidates) {
    try {
      await syncRemote(candidate);
      const refreshed = await Account.findById(candidate._id);
      if (isBillablePayloadMerchantAccount(refreshed)) {
        return refreshed.merchantId;
      }
    } catch (err) {
      log.warn('[PayloadBillableMerchant] Billable merchant sync failed', {
        merchantId: candidate.merchantId,
        message: err.message,
      });
    }
  }

  return '';
}

function billableMerchantUnavailableMessage({ entityType, entityId, reason } = {}) {
  if (entityType === ENTITY_TYPE.HOA && entityId) {
    if (reason === 'no_board_member_scope') {
      return 'Your owner account is not linked to a unit under an HOA board member who has completed payment setup. Ask your board to confirm your unit assignment, then try again.';
    }
    if (reason === 'board_no_hoa_merchant') {
      return 'Complete HOA Business Merchant Account onboarding and activate at least one processing account before adding payer payment methods.';
    }
    if (reason === 'no_board_member_merchants') {
      return 'Your HOA board member has not finished Business Merchant Account setup yet. Ask them to complete onboarding and activate at least one processing account before you save a card or bank account.';
    }
    return 'No active Business Merchant Account is available for this HOA yet. Ask your HOA board to complete Business Merchant Account onboarding and approve at least one business merchant - then owners can save cards and bank accounts.';
  }
  return 'No active Payload business merchant is available for this account yet. Complete Business Merchant Account onboarding and approval before saving payment methods.';
}

module.exports = {
  buildHoaBillableMerchantQuery,
  buildEntityBillableMerchantQuery,
  isBillablePayloadMerchantAccount,
  findActiveBillableMerchantId,
  billableMerchantUnavailableMessage,
  normalizeHoaId,
};
