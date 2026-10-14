'use strict';

const { ClockService } = require('../../../../../../common/date');
const {
  isHoaOwnerPayloadScopeKey,
  buildHoaOwnerPayloadScopeKey,
} = require('./payloadHoaOwnerCustomerContext.util');
const { ENTITY_TYPE, PAYMENT_METHOD_TYPE } = require('../constants/payload.constants');

function normalizeDedupePart(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePaymentMethodTypeGroup(type) {
  const raw = String(type || '').toUpperCase();
  if (raw.includes('ACH') || raw.includes('BANK') || raw.includes('PLAID')) return 'bank';
  if (
    raw.includes('CARD')
    || raw.includes('APPLE')
    || raw.includes('GOOGLE')
    || raw.includes('PAYPAL')
    || raw.includes('VENMO')
  ) {
    return 'card';
  }
  return normalizeDedupePart(type) || 'other';
}

/**
 * Logical instrument key — same bank/card even if Payload returned multiple pm ids.
 */
function buildOwnerPaymentMethodIdentityKey(method) {
  if (!method) return '';

  const typeGroup = normalizePaymentMethodTypeGroup(method.type);
  const display = method.display || {};
  const last4 = normalizeDedupePart(display.last4);
  const routing = normalizeDedupePart(display.routingNumber);
  const bankName = normalizeDedupePart(display.bankName);
  const holder = normalizeDedupePart(display.holderName);

  if (typeGroup === 'bank') {
    // HOA owner UI: one row per account ending (legacy duplicates often differ only by type/routing/fingerprint).
    if (last4 && last4.length >= 4) return `bank:last4:${last4}`;
    if (last4 && routing) return `bank:${last4}:${routing}`;
    if (last4 && bankName) return `bank:${last4}:${bankName}`;
    if (last4) return `bank:${last4}`;
  }

  const fingerprint = normalizeDedupePart(display.fingerprint);
  if (fingerprint) {
    return `fp:${typeGroup}:${fingerprint}`;
  }

  const brand = normalizeDedupePart(display.brand);
  if (typeGroup === 'card' && last4) return `card:${brand}:${last4}`;

  const providerId = String(method.providerPaymentMethodId || '').trim();
  if (providerId) return `pm:${providerId}`;

  return `id:${String(method.id || method._id || '')}`;
}

/** Exact Payload payment method id (used for provider-level equality). */
function buildOwnerPaymentMethodDedupeKey(method) {
  const providerId = String(method?.providerPaymentMethodId || '').trim();
  if (providerId) return `pm:${providerId}`;
  return buildOwnerPaymentMethodIdentityKey(method);
}

function scoreHoaOwnerPaymentMethodCanonical(method, hoaIdStr) {
  let score = 0;
  const scopeKey = buildHoaOwnerPayloadScopeKey(hoaIdStr);

  if (method.entityType === ENTITY_TYPE.HOA && String(method.entityId || '') === hoaIdStr) {
    score += 100;
  }
  if (String(method.billableMerchantId || '') === scopeKey) {
    score += 80;
  }
  if (isHoaOwnerPayloadScopeKey(method.billableMerchantId)) {
    score += 40;
  }
  if (method.isDefault) {
    score += 10;
  }

  const updatedAt = method.updatedAt ? new Date(method.updatedAt).getTime() : 0;
  return score * 1_000_000 + updatedAt;
}

function pickCanonicalHoaOwnerPaymentMethod(candidates, hoaIdStr) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const sorted = [...candidates].sort(
    (a, b) => scoreHoaOwnerPaymentMethodCanonical(b, hoaIdStr)
      - scoreHoaOwnerPaymentMethodCanonical(a, hoaIdStr),
  );
  return sorted[0];
}

function attachHoaProcessingMerchantMetadata(method, merchantIds = []) {
  if (!method || typeof method !== 'object') return method;
  const ids = [...new Set((merchantIds || []).map((id) => String(id)).filter(Boolean))];
  return {
    ...method,
    hoaProcessingMerchantIds: ids,
  };
}

/**
 * Drop legacy rows tied to removed HOA merchants; dedupe by logical instrument.
 */
function dedupeHoaOwnerPaymentMethodsForList(methods, { hoaId, merchantIds = [] } = {}) {
  const hoaIdStr = String(hoaId || '').trim();
  if (!hoaIdStr || !Array.isArray(methods)) return [];

  const activeMerchantSet = new Set((merchantIds || []).map((id) => String(id)));
  const scopeKey = buildHoaOwnerPayloadScopeKey(hoaIdStr);
  const eligible = [];

  for (const method of methods) {
    const billable = String(method.billableMerchantId || '');
    const isCommunityScoped =
      method.entityType === ENTITY_TYPE.HOA
      || billable === scopeKey
      || isHoaOwnerPayloadScopeKey(billable);

    if (isCommunityScoped) {
      eligible.push(method);
      continue;
    }

    if (billable && activeMerchantSet.has(billable)) {
      eligible.push(method);
      continue;
    }

    // Legacy row for a merchant removed from the HOA — hide from owner UI.
  }

  const groups = new Map();
  for (const method of eligible) {
    const key = buildOwnerPaymentMethodIdentityKey(method);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(method);
  }

  const deduped = [];
  for (const group of groups.values()) {
    const canonical = pickCanonicalHoaOwnerPaymentMethod(group, hoaIdStr);
    if (canonical) {
      deduped.push(attachHoaProcessingMerchantMetadata(canonical, merchantIds));
    }
  }

  deduped.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    const aTs = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTs = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return bTs - aTs;
  });

  return deduped;
}

/**
 * Returns Mongo ids of duplicate HOA owner rows to soft-delete (canonical kept).
 */
function findHoaOwnerPaymentMethodDuplicateIds(methods, { hoaId, merchantIds = [] } = {}) {
  const hoaIdStr = String(hoaId || '').trim();
  if (!hoaIdStr || !Array.isArray(methods)) return [];

  const listed = dedupeHoaOwnerPaymentMethodsForList(methods, { hoaId: hoaIdStr, merchantIds });
  const keepIds = new Set(
    listed.map((row) => String(row.id || row._id || '')).filter(Boolean),
  );

  const activeMerchantSet = new Set((merchantIds || []).map((id) => String(id)));
  const scopeKey = buildHoaOwnerPayloadScopeKey(hoaIdStr);
  const toRemove = [];

  for (const method of methods) {
    const localId = String(method.id || method._id || '');
    if (!localId) continue;

    const billable = String(method.billableMerchantId || '');
    const isCommunityScoped =
      method.entityType === ENTITY_TYPE.HOA
      || billable === scopeKey
      || isHoaOwnerPayloadScopeKey(billable);

    if (!isCommunityScoped && billable && !activeMerchantSet.has(billable)) {
      toRemove.push(localId);
      continue;
    }

    if (keepIds.has(localId)) continue;

    const key = buildOwnerPaymentMethodIdentityKey(method);
    const canonical = listed.find((row) => buildOwnerPaymentMethodIdentityKey(row) === key);
    if (canonical && String(canonical.id || canonical._id) !== localId) {
      toRemove.push(localId);
    }
  }

  return [...new Set(toRemove)];
}

function buildHoaOwnerPaymentMethodMetadataPatch(merchantIds = []) {
  const ids = [...new Set((merchantIds || []).map((id) => String(id)).filter(Boolean))];
  return {
    hoaProcessingMerchantIds: ids,
    hoaProcessingMerchantsSyncedAt: ClockService.now(),
  };
}

function collectOwnerPaymentMethodIdentityGroups(methods) {
  const groups = new Map();
  for (const method of methods || []) {
    const key = buildOwnerPaymentMethodIdentityKey(method);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(method);
  }
  return groups;
}

module.exports = {
  normalizePaymentMethodTypeGroup,
  buildOwnerPaymentMethodIdentityKey,
  buildOwnerPaymentMethodDedupeKey,
  collectOwnerPaymentMethodIdentityGroups,
  dedupeHoaOwnerPaymentMethodsForList,
  findHoaOwnerPaymentMethodDuplicateIds,
  buildHoaOwnerPaymentMethodMetadataPatch,
  attachHoaProcessingMerchantMetadata,
};
