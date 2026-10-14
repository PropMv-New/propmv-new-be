'use strict';

const SANDBOX_BASE_URL = 'https://api.sandbox.rainforestpay.com';
const PRODUCTION_BASE_URL = 'https://api.rainforestpay.com';

function normalizeRainforestBaseUrl(rawUrl) {
  if (!rawUrl) return null;
  let url = String(rawUrl).trim().replace(/\/$/, '');

  // Common misconfiguration: rainforestapi.com vs rainforestpay.com
  if (/rainforestapi\.com/i.test(url)) {
    url = url.replace(/rainforestapi\.com/i, 'rainforestpay.com');
  }

  return url;
}

function resolveRainforestBaseUrl() {
  if (process.env.RAINFOREST_BASE_URL) {
    return normalizeRainforestBaseUrl(process.env.RAINFOREST_BASE_URL);
  }
  const env = String(process.env.RAINFOREST_ENVIRONMENT || 'sandbox').toLowerCase();
  return env === 'production' ? PRODUCTION_BASE_URL : SANDBOX_BASE_URL;
}

module.exports = {
  rainforest: {
    apiKey: process.env.RAINFOREST_API_KEY || '',
    webhookSecret: process.env.RAINFOREST_WEBHOOK_SECRET || process.env.RAINFOREST_WEBHOOK_SIGNING_KEY || '',
    environment: process.env.RAINFOREST_ENVIRONMENT || 'sandbox',
    baseURL: resolveRainforestBaseUrl(),
    platformId: process.env.RAINFOREST_PLATFORM_ID || '',
    termsAndConditionsUrl: process.env.RAINFOREST_TERMS_URL || '',
    enabled: String(process.env.RAINFOREST_ENABLED || 'false').toLowerCase() === 'true',
    sessionTtlSeconds: Number(process.env.RAINFOREST_SESSION_TTL_SECONDS) || 3600,
    timeoutMs: Number(process.env.RAINFOREST_TIMEOUT_MS) || 15000,
  },
  isRainforestSandbox() {
    const url = resolveRainforestBaseUrl().toLowerCase();
    return url.includes('sandbox') || String(process.env.RAINFOREST_ENVIRONMENT || '').toLowerCase() === 'sandbox';
  },
  resolveRainforestBaseUrl,
};
