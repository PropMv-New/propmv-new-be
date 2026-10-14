'use strict';

const DEFAULT_BASE_URL = 'https://api.payload.com';

function normalizePayloadBaseUrl(rawUrl) {
  if (!rawUrl) return DEFAULT_BASE_URL;
  return String(rawUrl).trim().replace(/\/$/, '');
}
//werfsdgsdfgdfgg
function resolveMerchantOnboardingMode() {
  const raw = String(process.env.PAYLOAD_MERCHANT_ONBOARDING_MODE || '').trim().toLowerCase();
  if (raw === 'api' || raw === 'plugin' || raw === 'auto') return raw;
  // Sandbox default: Payload.js processing account plugin + ephemeral client tokens (see Payload UI auth docs).
  const sandbox = String(process.env.PAYLOAD_ENVIRONMENT || 'sandbox').toLowerCase() !== 'production';
  return sandbox ? 'plugin' : 'auto';
}

module.exports = {
  payload: {
    apiKey: String(process.env.PAYLOAD_SECRET_KEY || process.env.PAYLOAD_API_KEY || '').trim(),
    /** @deprecated UI must use ephemeral client tokens from POST /access_tokens, not a static client key. */
    clientKey: process.env.PAYLOAD_CLIENT_KEY || '',
    environment: process.env.PAYLOAD_ENVIRONMENT || 'sandbox',
    baseURL: normalizePayloadBaseUrl(process.env.PAYLOAD_BASE_URL),
    orgProcessingId: process.env.PAYLOAD_ORG_PROCESSING_ID || '',
    termsAndConditionsUrl: process.env.PAYLOAD_TERMS_URL || '',
    enabled: String(process.env.PAYLOAD_ENABLED || 'false').toLowerCase() === 'true',
    merchantOnboardingMode: resolveMerchantOnboardingMode(),
    sessionTtlSeconds: Number(process.env.PAYLOAD_SESSION_TTL_SECONDS) || 3600,
    timeoutMs: Number(process.env.PAYLOAD_TIMEOUT_MS) || 45000,
    apiVersion: process.env.PAYLOAD_API_VERSION || 'v2',
    /** HOA owners: one Payload customer + wallet per community; charges use per-property processing_id. */
    hoaUnifiedOwnerWallet: String(process.env.PAYLOAD_HOA_UNIFIED_OWNER_WALLET || 'true').toLowerCase() !== 'false',
    ownerAutopayEnabled: String(process.env.PAYLOAD_OWNER_AUTOPAY_ENABLED || 'false').toLowerCase() === 'true',
    /** Production Check21 board Upload Check (Record Payment). Default off until QA gates pass. */
    check21Enabled: String(process.env.PAYLOAD_CHECK21_ENABLED || 'false').toLowerCase() === 'true',
    /** Optional: attempt docs JSON receiver/check_images wire format (default multipart only). */
    check21DocsJsonEnabled: String(process.env.PAYLOAD_CHECK21_DOCS_JSON || 'false').toLowerCase() === 'true',
    /**
     * Vendor Portal Payload Processing Account onboarding (Phase 1).
     * When false, Vendor Settings keeps the existing Straddle bank UI.
     * Requires PAYLOAD_ENABLED=true as well.
     */
    vendorMerchantEnabled: String(process.env.PAYLOAD_VENDOR_MERCHANT_ENABLED || 'false').toLowerCase() === 'true',
    /**
     * Phase 4/5 — Owner/Board → Vendor electronic pay execute.
     * Default false. Sandbox COMPLETE ≠ production-ready; keep false in production
     * until live webhooks, auth, re-fetch, card/ACH lifecycle, and ACTIVE PA are verified.
     */
    vendorPayEnabled: String(process.env.PAYLOAD_VENDOR_PAY_ENABLED || 'false').toLowerCase() === 'true',
  },
  isPayloadSandbox() {
    return String(process.env.PAYLOAD_ENVIRONMENT || 'sandbox').toLowerCase() !== 'production';
  },
  resolveMerchantOnboardingMode,
};
