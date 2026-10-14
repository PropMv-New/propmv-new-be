'use strict';

const mongoose = require('mongoose');
const { isHoaOwnerPayloadScopeKey } = require('./payloadHoaOwnerCustomerContext.util');

/**
 * True when value is a Payload processing account id (not PropMv scope keys or Mongo ids).
 */
function isPayloadRemoteProcessingAccountId(value) {
  const id = String(value || '').trim();
  if (!id) return false;
  if (isHoaOwnerPayloadScopeKey(id)) return false;
  if (mongoose.Types.ObjectId.isValid(id) && id.length === 24) return false;
  return true;
}

/**
 * Pick the processing account used for Customer primary_processing_id and payment_method_form.
 * Prefers heuristic primary, then any active merchant on the owner's board-member scope.
 */
function resolvePayloadPrimaryProcessingIdForOwnerWallet(context = {}) {
  const merchantIds = (context.merchantIds || []).map((id) => String(id).trim()).filter(Boolean);
  const ordered = [
    context.primaryProcessingId,
    ...merchantIds,
  ].map((id) => String(id || '').trim()).filter(Boolean);

  const seen = new Set();
  for (const id of ordered) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (isPayloadRemoteProcessingAccountId(id)) {
      return id;
    }
  }
  return '';
}

module.exports = {
  isPayloadRemoteProcessingAccountId,
  resolvePayloadPrimaryProcessingIdForOwnerWallet,
};
