'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { join } = require('path');

/**
 * Regression: HOA owner card/bank initialize must pass userId into wallet context inside
 * resolveAuthoritativeBillableMerchantId (ReferenceError userOid → 503 on staging).
 */
describe('payloadPaymentMethod.service HOA initialize scope', () => {
  const servicePath = join(__dirname, 'payloadPaymentMethod.service.js');

  it('resolveAuthoritativeBillableMerchantId uses Board-aware wallet context for actor', () => {
    const src = readFileSync(servicePath, 'utf8');
    const start = src.indexOf('async function resolveAuthoritativeBillableMerchantId');
    assert.ok(start >= 0, 'resolveAuthoritativeBillableMerchantId must exist');
    const end = src.indexOf('\nasync function resolvePayloadUserRecordForPayin', start);
    assert.ok(end > start, 'function body must be bounded');
    const block = src.slice(start, end);

    assert.match(
      block,
      /resolveHoaPayloadWalletContextForActor\(\s*userId,\s*entityId\s*\)/,
    );
    // Must not regress to Owner-only unit scoping for every HOA initialize.
    assert.doesNotMatch(
      block,
      /resolveHoaOwnerPayloadCustomerContext\(\s*entityId,\s*hoaOwnerWalletContextOptions\(userId\)\s*\)/,
    );
  });

  it('Board wallet context omits ownerUserId unit-assignment filter', () => {
    const src = readFileSync(servicePath, 'utf8');
    const start = src.indexOf('async function resolveHoaPayloadWalletContextForActor');
    assert.ok(start >= 0);
    const end = src.indexOf('\nfunction resolveHoaOwnerWalletUnavailableReason', start);
    const block = src.slice(start, end);
    assert.match(block, /isActiveHoaBoardMember/);
    assert.match(block, /Omit ownerUserId/);
    assert.match(block, /actorIsBoardMember:\s*true/);
  });

  it('never sends PropMv hoa scope key to Payload as primary_processing_id fallback', () => {
    const src = readFileSync(servicePath, 'utf8');
    assert.doesNotMatch(src, /primary_processing_id:\s*String\(expectedPrimary \|\| billableMerchantId\)/);
    assert.doesNotMatch(src, /primaryProcessingId:\s*hoaCustomerContext\?\.primaryProcessingId \|\| billableMerchantId/);
    assert.match(src, /resolveHoaOwnerWalletProcessingId/);
    assert.match(src, /resolvePayloadPrimaryProcessingIdForOwnerWallet/);
  });
});

describe('payloadComponentSession owner payment_method_form', () => {
  const sessionPath = join(__dirname, 'payloadComponentSession.service.js');

  it('does not put processing_id on payment_method when customer_id is present', () => {
    const src = readFileSync(sessionPath, 'utf8');
    assert.doesNotMatch(
      src,
      /if \(customerId && processingId\) \{\s*paymentMethod\.processing_id/,
    );
    assert.match(src, /Do NOT send processing_id/);
  });
});
