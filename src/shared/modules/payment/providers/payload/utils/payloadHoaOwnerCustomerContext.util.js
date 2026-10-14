'use strict';

const mongoose = require('mongoose');
const PayloadAccount = require('../model/payloadAccount.model');
const {
  buildHoaBillableMerchantQuery,
  isBillablePayloadMerchantAccount,
  normalizeHoaId,
} = require('./payloadBillableMerchant.util');
const { ENTITY_TYPE } = require('../constants/payload.constants');

const HOA_OWNER_SCOPE_PREFIX = 'hoa:';

function buildHoaOwnerPayloadScopeKey(hoaId) {
  const normalized = normalizeHoaId(hoaId);
  if (!normalized) return '';
  return `${HOA_OWNER_SCOPE_PREFIX}${normalized}`;
}

function isHoaOwnerPayloadScopeKey(value) {
  return String(value || '').startsWith(HOA_OWNER_SCOPE_PREFIX);
}

function parseHoaIdFromOwnerPayloadScopeKey(scopeKey) {
  if (!isHoaOwnerPayloadScopeKey(scopeKey)) return '';
  return normalizeHoaId(String(scopeKey).slice(HOA_OWNER_SCOPE_PREFIX.length));
}

function buildHoaOwnerPayloadExternalUid(userId, hoaId) {
  const hoaStr = normalizeHoaId(hoaId);
  const userStr = String(userId || '').trim();
  if (!hoaStr || !userStr) return '';
  return `propmv:${userStr}:${hoaStr}`;
}

async function listActiveHoaPayloadMerchantIds(hoaId, { boardMemberIds } = {}) {
  const hoaIdStr = normalizeHoaId(hoaId);
  const scopedQuery = buildHoaBillableMerchantQuery(hoaIdStr, { boardMemberIds });
  if (!scopedQuery) return [];

  const accounts = await PayloadAccount.find(scopedQuery).sort({ createdAt: 1 }).lean();
  const merchantIds = [];
  const seen = new Set();
  for (const row of accounts) {
    if (!row?.merchantId || !isBillablePayloadMerchantAccount(row)) continue;
    const id = String(row.merchantId);
    if (seen.has(id)) continue;
    seen.add(id);
    merchantIds.push(id);
  }
  return merchantIds;
}

async function resolveHoaOwnerPayloadCustomerContext(hoaId, { findActiveBillableMerchantId, ownerUserId } = {}) {
  const hoaIdStr = normalizeHoaId(hoaId);
  if (!hoaIdStr) {
    return {
      hoaId: '',
      scopeKey: '',
      primaryProcessingId: '',
      merchantIds: [],
      boardMemberIds: [],
    };
  }

  const { resolveHoaBoardMemberIdsForOwner } = require('./payloadHoaOwnerBoardMemberScope.util');
  const boardMemberIds = ownerUserId
    ? await resolveHoaBoardMemberIdsForOwner(ownerUserId, hoaIdStr)
    : undefined;

  const merchantIds = await listActiveHoaPayloadMerchantIds(hoaIdStr, { boardMemberIds });
  const { resolvePayloadHoaOwnerBillableMerchantId } = require('./payloadHoaOwnerBillableMerchant.util');
  const primaryProcessingId = await resolvePayloadHoaOwnerBillableMerchantId(hoaIdStr, {
    findActiveBillableMerchantId,
    boardMemberIds,
  });

  return {
    hoaId: hoaIdStr,
    scopeKey: buildHoaOwnerPayloadScopeKey(hoaIdStr),
    primaryProcessingId: primaryProcessingId || merchantIds[0] || '',
    merchantIds,
    boardMemberIds,
  };
}

function isPayloadOwnerMethodInHoaScope(method, hoaId, context = {}) {
  const hoaIdStr = normalizeHoaId(hoaId);
  if (!method || !hoaIdStr) return false;

  const merchantIds = new Set((context.merchantIds || []).map(String));
  const scopeKey = context.scopeKey || buildHoaOwnerPayloadScopeKey(hoaIdStr);

  if (method.entityType === ENTITY_TYPE.HOA && method.entityId && String(method.entityId) === hoaIdStr) {
    return true;
  }

  if (
    isHoaOwnerPayloadScopeKey(method.billableMerchantId)
    && method.entityId
    && String(method.entityId) === hoaIdStr
  ) {
    return true;
  }

  if (String(method.billableMerchantId) === scopeKey) {
    return true;
  }

  if (method.billableMerchantId && merchantIds.has(String(method.billableMerchantId))) {
    return true;
  }

  return false;
}

function buildHoaOwnerPaymentMethodListOrFilters(hoaId, context = {}) {
  const hoaIdStr = normalizeHoaId(hoaId);
  const hoaOid = mongoose.Types.ObjectId.isValid(hoaIdStr)
    ? new mongoose.Types.ObjectId(hoaIdStr)
    : null;
  if (!hoaOid || !context.scopeKey) return [];

  const merchantFilters = (context.merchantIds || []).map((merchantId) => ({
    billableMerchantId: String(merchantId),
  }));

  return [
    { entityType: ENTITY_TYPE.HOA, entityId: hoaOid },
    { billableMerchantId: context.scopeKey },
    ...merchantFilters,
  ];
}

function isHoaOwnerBillableMerchantInputValid(input, context) {
  const value = String(input || '').trim();
  if (!value || !context?.scopeKey) return false;
  if (value === context.scopeKey) return true;
  if (value === String(context.primaryProcessingId || '')) return true;
  return (context.merchantIds || []).some((id) => String(id) === value);
}

module.exports = {
  HOA_OWNER_SCOPE_PREFIX,
  buildHoaOwnerPayloadScopeKey,
  isHoaOwnerPayloadScopeKey,
  parseHoaIdFromOwnerPayloadScopeKey,
  buildHoaOwnerPayloadExternalUid,
  listActiveHoaPayloadMerchantIds,
  resolveHoaOwnerPayloadCustomerContext,
  isPayloadOwnerMethodInHoaScope,
  isHoaOwnerBillableMerchantInputValid,
  buildHoaOwnerPaymentMethodListOrFilters,
};
