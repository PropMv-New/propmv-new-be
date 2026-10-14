#!/usr/bin/env node
'use strict';

/**
 * Register an Apple Pay domain with Payload (POST /applepay_domains).
 *
 * Prerequisites:
 * 1) Host Payload's file at:
 *    https://{domain}/.well-known/apple-developer-merchantid-domain-association
 *    (owner portal: innago-inspired-refresh/public/.well-known/ — deploy frontend first)
 * 2) PAYLOAD_SECRET_KEY must belong to the same Payload org as profile_id (processing account).
 *
 * Usage:
 *   node scripts/payload-register-applepay-domain.js \
 *     --profile-id acct_XXXX \
 *     --domain owner.propmv.com
 *
 * Loads propmv/.env when present (dotenv).
 */

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else {
  require('dotenv').config();
}

function readArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || !process.argv[idx + 1]) return '';
  return String(process.argv[idx + 1]).trim();
}

async function main() {
  const profileId = readArg('--profile-id') || readArg('--profile_id');
  const domain = readArg('--domain') || 'owner.propmv.com';
  const verifyOnly = process.argv.includes('--verify-url-only');

  const wellKnownUrl = `https://${domain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')}/.well-known/apple-developer-merchantid-domain-association`;

  if (verifyOnly) {
    const res = await fetch(wellKnownUrl, { redirect: 'follow' });
    const text = await res.text();
    const looksLikeHtml = /^\s*</.test(text);
    console.log(JSON.stringify({
      ok: res.ok && !looksLikeHtml,
      status: res.status,
      url: wellKnownUrl,
      byteLength: Buffer.byteLength(text, 'utf8'),
      looksLikeHtml,
      hint: looksLikeHtml
        ? 'URL returned HTML (SPA fallback). Deploy public/.well-known file and nginx ^~ /.well-known/ rule, then retry.'
        : 'Association file reachable.',
    }, null, 2));
    process.exit(res.ok && !looksLikeHtml ? 0 : 1);
  }

  const payloadConfig = require('../src/config/payload.config');
  if (!payloadConfig.payload.enabled || !payloadConfig.payload.apiKey) {
    console.error('Set PAYLOAD_ENABLED=true and PAYLOAD_SECRET_KEY in propmv/.env');
    process.exit(2);
  }
  if (!profileId) {
    console.error('Missing --profile-id acct_... (Payload processing account / profile_id)');
    process.exit(2);
  }

  const { PayloadClient } = require('../src/shared/modules/payment/providers/payload/client/payload.client');
  const client = new PayloadClient();

  try {
    await client.getProcessingAccount(profileId);
  } catch (err) {
    console.error(JSON.stringify({
      ok: false,
      step: 'getProcessingAccount',
      profileId,
      error: err.message,
      hint: 'profile_id must exist under the PAYLOAD_SECRET_KEY org.',
    }, null, 2));
    process.exit(1);
  }

  const urlCheck = await fetch(wellKnownUrl).catch(() => null);
  if (urlCheck) {
    const body = await urlCheck.text();
    if (/^\s*</.test(body)) {
      console.warn(JSON.stringify({
        warning: 'Domain verification URL returns HTML, not the association file.',
        url: wellKnownUrl,
        hint: 'Deploy frontend + nginx snippet before POST /applepay_domains or Payload may fail verification.',
      }, null, 2));
    }
  }

  try {
    const result = await client.registerApplePayDomain({ profileId, domain });
    console.log(JSON.stringify({ ok: true, domain, profileId, result }, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(JSON.stringify({
      ok: false,
      domain,
      profileId,
      error: err.message,
      payloadError: err.payloadError || undefined,
      hint: 'If InternalServerError: confirm .well-known file is live, then retry. Enable Apple Pay in Payload dashboard > Features & Add-ons if prompted.',
    }, null, 2));
    process.exit(1);
  }
}

main();
