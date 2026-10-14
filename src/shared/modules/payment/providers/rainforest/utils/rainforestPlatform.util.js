'use strict';

const { RainforestClient } = require('../client/rainforest.client');
const rainforestConfig = require('../../../../../../config/rainforest.config');
const logger = require('../../../../../../common/logger');

const client = new RainforestClient();

function pickPlatformId(source = {}) {
  if (!source || typeof source !== 'object') return '';
  return String(
    source.platform_id
    || source.platformId
    || source.metadata?.rainforest_platform_id
    || ''
  ).trim();
}

async function resolveRainforestPlatformId(account) {
  const configured = String(rainforestConfig.rainforest.platformId || '').trim();
  if (configured) return configured;

  const cached = pickPlatformId(account?.metadata || {});
  if (cached) return cached;

  if (!account?.merchantId) return '';

  try {
    const remote = await client.getMerchant(account.merchantId);
    const platformId = pickPlatformId(remote);
    if (platformId && account.metadata && typeof account.metadata === 'object') {
      account.metadata.rainforestPlatformId = platformId;
      account.markModified('metadata');
      await account.save();
    }
    return platformId;
  } catch (err) {
    logger.warn('[Rainforest] Unable to resolve platform id from merchant', {
      merchantId: account.merchantId,
      message: err.message,
    });
    return '';
  }
}

async function resolvePlatformIdForBillableMerchant(merchantId) {
  const configured = String(rainforestConfig.rainforest.platformId || '').trim();
  if (configured) return configured;

  if (!merchantId) return '';

  const RainforestAccount = require('../model/rainforestAccount.model');
  const account = await RainforestAccount.findOne({
    merchantId: String(merchantId),
    isDeleted: { $ne: true },
  });
  if (account) {
    return resolveRainforestPlatformId(account);
  }

  try {
    const remote = await client.getMerchant(merchantId);
    return pickPlatformId(remote);
  } catch (err) {
    logger.warn('[Rainforest] Unable to resolve platform id for billable merchant', {
      merchantId,
      message: err.message,
    });
    return '';
  }
}

module.exports = {
  resolveRainforestPlatformId,
  resolvePlatformIdForBillableMerchant,
  pickPlatformId,
};
