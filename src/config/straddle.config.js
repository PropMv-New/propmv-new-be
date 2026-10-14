/**
 * ------------------------------------------------------------------
 * File: straddle.config.js
 * Module: Src Config
 *
 * Purpose:
 * Configuration settings, variables mapping, and constants definitions.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

module.exports = {
  straddle: {
    baseURL: process.env.STRADDLE_BASE_URL || 'https://api.straddle.com/v1',
    apiKey: process.env.STRADDLE_API_KEY || '',
    webhookSecret: process.env.STRADDLE_WEBHOOK_SECRET || '',
    // Platform organization - one Straddle org for the entire product
    organizationId: process.env.STRADDLE_ORGANIZATION_ID || '',
  },
  /** True when STRADDLE_BASE_URL points at Straddle sandbox (not production). */
  isStraddleSandbox() {
    const url = String(process.env.STRADDLE_BASE_URL || '').toLowerCase();
    return url.includes('sandbox');
  },
};
