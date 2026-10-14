'use strict';

/**
 * Resolve the Straddle Account used for Vendor portal bank linking.
 * Vendors are platform entities - not HOA members - but Straddle SaaS
 * REQUIRES Straddle-Account-Id on every customer/bridge call (no org-level customers).
 *
 * Resolution order:
 * 1. STRADDLE_VENDOR_ACCOUNT_ID env (dedicated vendor platform account)
 * 2. Local StraddleAccount marked metadata.purpose = 'vendor_platform'
 * 3. First associated HOA with an active Straddle account (payment rails association)
 * 4. First associated landlord with an active Straddle account
 * Never returns a null account id - callers get a clear 400 instead of Straddle 403.
 */

const StraddleAccount = require('../account/model/straddleAccount.model');
const { ENTITY_TYPE } = require('../account/constants/account.constants');
const { resolveEmbeddedAccount } = require('./resolveEmbeddedAccount');
const logger = require('../../../../common/logger');

function missingAccountError(detail) {
  const err = new Error(
    detail
    || 'Vendor payment platform is not configured. Set STRADDLE_VENDOR_ACCOUNT_ID, '
    + 'or associate this vendor with an HOA/landlord that has a Straddle account.'
  );
  err.statusCode = 400;
  return err;
}

async function resolveVendorPlatformAccount(opts = {}) {
  const associatedHoaIds = Array.isArray(opts.associatedHoaIds)
    ? opts.associatedHoaIds.filter(Boolean).map(String)
    : [];
  const associatedLandlordIds = Array.isArray(opts.associatedLandlordIds)
    ? opts.associatedLandlordIds.filter(Boolean).map(String)
    : [];

  const envAccountId = String(process.env.STRADDLE_VENDOR_ACCOUNT_ID || '').trim();
  if (envAccountId) {
    const account = await StraddleAccount.findOne({
      straddleAccountId: envAccountId,
      isDeleted: { $ne: true },
    });
    if (account?.straddleAccountId) {
      return { account, straddleAccountId: account.straddleAccountId, source: 'env' };
    }
    // Env may point at a live Straddle account not mirrored locally yet
    return { account: null, straddleAccountId: envAccountId, source: 'env' };
  }

  const platformAccount = await StraddleAccount.findOne({
    'metadata.purpose': 'vendor_platform',
    isDeleted: { $ne: true },
    straddleAccountId: { $ne: null },
  }).sort({ createdAt: -1 });

  if (platformAccount?.straddleAccountId) {
    return {
      account: platformAccount,
      straddleAccountId: platformAccount.straddleAccountId,
      source: 'vendor_platform',
    };
  }

  for (const hoaId of associatedHoaIds) {
    try {
      const scope = await resolveEmbeddedAccount({
        hoaId,
        entityType: ENTITY_TYPE.HOA,
        entityId: hoaId,
      });
      if (scope?.straddleAccountId) {
        logger.info('[Payment] vendor bank link using associated HOA Straddle account', {
          hoaId,
          straddleAccountId: scope.straddleAccountId,
        });
        return { ...scope, source: 'associated_hoa' };
      }
    } catch (_) {
      /* try next association */
    }
  }

  for (const landlordId of associatedLandlordIds) {
    try {
      const scope = await resolveEmbeddedAccount({
        entityType: ENTITY_TYPE.LANDLORD,
        entityId: landlordId,
      });
      if (scope?.straddleAccountId) {
        logger.info('[Payment] vendor bank link using associated landlord Straddle account', {
          landlordId,
          straddleAccountId: scope.straddleAccountId,
        });
        return { ...scope, source: 'associated_landlord' };
      }
    } catch (_) {
      /* try next association */
    }
  }

  throw missingAccountError();
}

module.exports = { resolveVendorPlatformAccount };
