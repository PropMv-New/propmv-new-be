'use strict';

const { RainforestClient } = require('../client/rainforest.client');
const rainforestConfig = require('../../../../../../config/rainforest.config');

const client = new RainforestClient();

function buildMerchantOnboardingSession({ merchantId, ttlSeconds }) {
  const ttl = Math.min(Math.max(Number(ttlSeconds) || rainforestConfig.rainforest.sessionTtlSeconds, 300), 86400);
  return {
    ttl,
    statements: [
      {
        permissions: ['group#merchant_onboarding_component'],
        constraints: {
          merchant: {
            merchant_id: String(merchantId),
          },
        },
      },
    ],
  };
}

function buildPaymentMethodSession({ merchantId, ttlSeconds }) {
  const ttl = Math.min(Math.max(Number(ttlSeconds) || rainforestConfig.rainforest.sessionTtlSeconds, 300), 86400);
  return {
    ttl,
    statements: [
      {
        permissions: ['group#payment_component'],
        constraints: {
          merchant: {
            merchant_id: String(merchantId),
          },
        },
      },
    ],
  };
}

async function createMerchantOnboardingSession({ merchantId }) {
  const payload = buildMerchantOnboardingSession({ merchantId });
  const session = await client.createSession(payload);
  return {
    sessionId: session?.session_id || '',
    sessionKey: session?.session_key || '',
    expiresAt: session?.expires_at || null,
  };
}

async function createPaymentMethodSession({ merchantId }) {
  const payload = buildPaymentMethodSession({ merchantId });
  const session = await client.createSession(payload);
  return {
    sessionId: session?.session_id || '',
    sessionKey: session?.session_key || '',
    expiresAt: session?.expires_at || null,
  };
}

function buildDepositMethodSession({ merchantId, ttlSeconds }) {
  const ttl = Math.min(Math.max(Number(ttlSeconds) || rainforestConfig.rainforest.sessionTtlSeconds, 300), 86400);
  return {
    ttl,
    statements: [
      {
        permissions: ['group#merchant_onboarding_component', 'group#payment_component'],
        constraints: {
          merchant: {
            merchant_id: String(merchantId),
          },
        },
      },
    ],
  };
}

async function createDepositMethodSession({ merchantId }) {
  const payload = buildDepositMethodSession({ merchantId });
  const session = await client.createSession(payload);
  return {
    sessionId: session?.session_id || '',
    sessionKey: session?.session_key || '',
    expiresAt: session?.expires_at || null,
  };
}

function buildMerchantHubSession({ merchantId, ttlSeconds }) {
  const ttl = Math.min(Math.max(Number(ttlSeconds) || rainforestConfig.rainforest.sessionTtlSeconds, 300), 86400);
  return {
    ttl,
    statements: [
      {
        permissions: ['group#all'],
        constraints: {
          merchant: {
            merchant_id: String(merchantId),
          },
        },
      },
    ],
  };
}

async function createMerchantHubSession({ merchantId }) {
  const payload = buildMerchantHubSession({ merchantId });
  const session = await client.createSession(payload);
  return {
    sessionId: session?.session_id || '',
    sessionKey: session?.session_key || '',
    expiresAt: session?.expires_at || null,
  };
}

module.exports = {
  createMerchantOnboardingSession,
  createPaymentMethodSession,
  createDepositMethodSession,
  createMerchantHubSession,
  buildMerchantOnboardingSession,
  buildPaymentMethodSession,
  buildDepositMethodSession,
  buildMerchantHubSession,
};
