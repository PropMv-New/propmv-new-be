'use strict';

const { PayloadClient } = require('../client/payload.client');
const payloadConfig = require('../../../../../../config/payload.config');
const logger = require('../../../../../../common/logger');

const client = new PayloadClient();

function pickPlatformId(source = {}) {
  if (!source || typeof source !== 'object') return '';
  return String(
    source.platform_id
    || source.platformId
    || source.metadata?.payload_platform_id
    || ''
  ).trim();
}

async function resolvePayloadPlatformId(account) {
  const configured = String(payloadConfig.payload.platformId || '').trim();
  if (configured) return configured;

  const cached = pickPlatformId(account?.metadata || {});
  if (cached) return cached;

  if (!account?.merchantId) return '';

  try {
    const remote = await client.getProcessingAccount(account.merchantId);
    const platformId = pickPlatformId(remote);
    if (platformId && account.metadata && typeof account.metadata === 'object') {
      account.metadata.payloadPlatformId = platformId;
      account.markModified('metadata');
      await account.save();
    }
    return platformId;
  } catch (err) {
    logger.warn('[Payload] Unable to resolve platform id from merchant', {
      merchantId: account.merchantId,
      message: err.message,
    });
    return '';
  }
}

async function resolvePlatformIdForBillableMerchant(merchantId) {
  const configured = String(payloadConfig.payload.platformId || '').trim();
  if (configured) return configured;

  if (!merchantId) return '';

  const PayloadAccount = require('../model/payloadAccount.model');
  const account = await PayloadAccount.findOne({
    merchantId: String(merchantId),
    isDeleted: { $ne: true },
  });
  if (account) {
    return resolvePayloadPlatformId(account);
  }

  try {
    const remote = await client.getProcessingAccount(merchantId);
    return pickPlatformId(remote);
  } catch (err) {
    logger.warn('[Payload] Unable to resolve platform id for billable merchant', {
      merchantId,
      message: err.message,
    });
    return '';
  }
}

module.exports = {
  resolvePayloadPlatformId,
  resolvePlatformIdForBillableMerchant,
  pickPlatformId,
};
