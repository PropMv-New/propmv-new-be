'use strict';

/**
 * Resolve the embedded Straddle Account for SaaS-scoped Customer / Paykey / Charge calls.
 * PropMv is a SaaS platform: customers belong to a landlord/HOA Straddle Account.
 *
 * Docs: https://docs.straddle.com/guides/embed/api-headers
 */

const StraddleAccount = require('../account/model/straddleAccount.model');
const { ENTITY_TYPE } = require('../account/constants/account.constants');

/**
 * @param {object} opts
 * @param {string} [opts.hoaId]
 * @param {string} [opts.entityId]
 * @param {string} [opts.entityType]  landlord | hoa | property_manager
 * @param {string} [opts.straddleAccountId]  Straddle UUID (validated against local record)
 * @param {string|import('mongoose').Types.ObjectId} [opts.companyId]  landlord company fallback
 * @returns {Promise<{ account: object, straddleAccountId: string }>}
 */
async function resolveEmbeddedAccount(opts = {}) {
  const {
    hoaId,
    entityId,
    entityType,
    straddleAccountId,
    companyId,
  } = opts;

  let account = null;

  if (straddleAccountId) {
    account = await StraddleAccount.findOne({
      straddleAccountId: String(straddleAccountId),
      isDeleted: { $ne: true },
    });
  }

  if (!account && (hoaId || (entityId && entityType === ENTITY_TYPE.HOA))) {
    const id = String(hoaId || entityId);

    // Legacy shared HOA account (entityId was the HOA community id)
    account = await StraddleAccount.findOne({
      entityType: ENTITY_TYPE.HOA,
      entityId: id,
      isDeleted: { $ne: true },
      straddleAccountId: { $ne: null },
    }).sort({ createdAt: -1 });

    // Per-board-member accounts store the community id on metadata.hoaId
    if (!account) {
      account = await StraddleAccount.findOne({
        entityType: ENTITY_TYPE.HOA,
        'metadata.hoaId': id,
        isDeleted: { $ne: true },
        straddleAccountId: { $ne: null },
      }).sort({ activatedAt: -1, createdAt: -1 });
    }
  }

  if (!account && entityId && entityType) {
    account = await StraddleAccount.findOne({
      entityType,
      entityId,
      isDeleted: { $ne: true },
      straddleAccountId: { $ne: null },
    }).sort({ createdAt: -1 });
  }

  // Landlord fallback: company-scoped business account
  if (!account && companyId) {
    account = await StraddleAccount.findOne({
      businessId: companyId,
      entityType: { $in: [ENTITY_TYPE.LANDLORD, ENTITY_TYPE.PROPERTY_MGR] },
      isDeleted: { $ne: true },
      straddleAccountId: { $ne: null },
    }).sort({ createdAt: -1 });
  }

  if (!account || !account.straddleAccountId) {
    const err = new Error(
      'No active payment account found for this community. Ask the HOA board / landlord to create a payment account first.'
    );
    err.statusCode = 400;
    throw err;
  }

  return { account, straddleAccountId: account.straddleAccountId };
}

module.exports = { resolveEmbeddedAccount };
