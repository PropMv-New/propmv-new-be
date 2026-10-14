'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isPayloadRemoteProcessingAccountId,
  resolvePayloadPrimaryProcessingIdForOwnerWallet,
} = require('./payloadHoaOwnerProcessingAccount.util');

describe('payloadHoaOwnerProcessingAccount.util', () => {
  const hoaId = '507f1f77bcf86cd799439011';

  it('rejects PropMv HOA wallet scope keys as Payload processing account ids', () => {
    assert.equal(isPayloadRemoteProcessingAccountId(`hoa:${hoaId}`), false);
    assert.equal(isPayloadRemoteProcessingAccountId(hoaId), false);
  });

  it('accepts Payload processing account ids', () => {
    assert.equal(isPayloadRemoteProcessingAccountId('acct_abc123'), true);
    assert.equal(isPayloadRemoteProcessingAccountId('processing_xyz'), true);
  });

  it('never uses hoa scope as primary even when primaryProcessingId is wrong', () => {
    const id = resolvePayloadPrimaryProcessingIdForOwnerWallet({
      primaryProcessingId: `hoa:${hoaId}`,
      merchantIds: ['acct_merch_one', 'acct_merch_two'],
    });
    assert.equal(id, 'acct_merch_one');
  });

  it('prefers valid primaryProcessingId then falls back to additional board merchants', () => {
    assert.equal(
      resolvePayloadPrimaryProcessingIdForOwnerWallet({
        primaryProcessingId: 'acct_primary',
        merchantIds: ['acct_secondary'],
      }),
      'acct_primary',
    );

    assert.equal(
      resolvePayloadPrimaryProcessingIdForOwnerWallet({
        primaryProcessingId: '',
        merchantIds: ['acct_only'],
      }),
      'acct_only',
    );
  });

  it('supports future processing accounts via expanded merchantIds list', () => {
    const id = resolvePayloadPrimaryProcessingIdForOwnerWallet({
      primaryProcessingId: 'acct_legacy',
      merchantIds: ['acct_legacy', 'acct_added_tomorrow'],
    });
    assert.equal(id, 'acct_legacy');
  });

  it('returns empty when no valid Payload processing ids exist', () => {
    assert.equal(
      resolvePayloadPrimaryProcessingIdForOwnerWallet({
        primaryProcessingId: `hoa:${hoaId}`,
        merchantIds: [],
      }),
      '',
    );
  });
});
