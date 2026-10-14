'use strict';

const mongoose = require('mongoose');
const PayloadAccount = require('../model/payloadAccount.model');
const { PayloadDepositMethod } = require('../model/payloadDepositMethod.model');
const Property = require('../../../../../../portals/hoa-board/modules/property/model/property.model');
const {
  buildHoaBillableMerchantQuery,
  isBillablePayloadMerchantAccount,
  normalizeHoaId,
} = require('./payloadBillableMerchant.util');
const { resolvePayloadAccountForDepositBank } = require('./resolvePayloadPayinMerchant.util');

function isDepositActiveForOwnerPay(deposit) {
  const status = String(deposit?.status || '').toUpperCase();
  return status === 'ACTIVE' || status === 'CREATED';
}

function isDepositSelectable(deposit) {
  return Boolean(deposit?.last4 || deposit?.depositMethodId || deposit?._id);
}

/**
 * Resolve the Payload processing account (merchantId) owners should use when saving
 * pay-in methods for an HOA community. Prefers merchants tied to community deposit
 * banks and unit deposit routing — not whichever HOA-scoped merchant was updated last.
 */
async function resolvePayloadHoaOwnerBillableMerchantId(hoaId, { findActiveBillableMerchantId, boardMemberIds } = {}) {
  const hoaIdStr = normalizeHoaId(hoaId);
  if (!hoaIdStr) return '';

  const scopedQuery = buildHoaBillableMerchantQuery(hoaIdStr, { boardMemberIds });
  if (!scopedQuery) return '';

  const accounts = (await PayloadAccount.find(scopedQuery).sort({ updatedAt: -1 }).lean())
    .filter((row) => isBillablePayloadMerchantAccount(row));
  if (!accounts.length) return '';

  const accountById = new Map(accounts.map((row) => [String(row._id), row]));
  const accountByMerchantId = new Map(
    accounts.filter((row) => row.merchantId).map((row) => [String(row.merchantId), row]),
  );

  const deposits = await PayloadDepositMethod.find({
    payloadAccountRef: { $in: accounts.map((row) => row._id) },
    isDeleted: { $ne: true },
  })
    .sort({ isPrimaryPayout: -1, updatedAt: -1 })
    .lean();

  const payoutDeposit = deposits.find(
    (row) => isDepositSelectable(row) && String(row.status || '').toUpperCase() === 'ACTIVE',
  ) || deposits.find((row) => isDepositSelectable(row) && isDepositActiveForOwnerPay(row));

  if (payoutDeposit) {
    const merchantId = payoutDeposit.merchantId
      || accountById.get(String(payoutDeposit.payloadAccountRef))?.merchantId;
    if (merchantId && accountByMerchantId.has(String(merchantId))) {
      return String(merchantId);
    }
  }

  const hoaOid = mongoose.Types.ObjectId.isValid(hoaIdStr)
    ? new mongoose.Types.ObjectId(hoaIdStr)
    : null;
  if (hoaOid) {
    const properties = await Property.find({
      hoaId: hoaOid,
      isDeleted: { $ne: true },
      depositBankAccountId: { $exists: true, $ne: null },
    })
      .select('depositBankAccountId')
      .limit(500)
      .lean();

    const merchantVotes = new Map();
    for (const property of properties) {
      const ctx = await resolvePayloadAccountForDepositBank(property.depositBankAccountId);
      const merchantId = ctx?.account?.merchantId;
      if (merchantId && accountByMerchantId.has(String(merchantId))) {
        merchantVotes.set(String(merchantId), (merchantVotes.get(String(merchantId)) || 0) + 1);
      }
    }

    if (merchantVotes.size > 0) {
      const [winner] = [...merchantVotes.entries()].sort((a, b) => b[1] - a[1]);
      return String(winner[0]);
    }
  }

  if (typeof findActiveBillableMerchantId === 'function') {
    return findActiveBillableMerchantId(scopedQuery);
  }

  return '';
}

module.exports = {
  resolvePayloadHoaOwnerBillableMerchantId,
};
