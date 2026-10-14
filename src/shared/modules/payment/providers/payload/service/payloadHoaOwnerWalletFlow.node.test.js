'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolvePayloadPrimaryProcessingIdForOwnerWallet } = require('../utils/payloadHoaOwnerProcessingAccount.util');
const { buildHoaOwnerPaymentMethodMetadataPatch } = require('../utils/payloadHoaOwnerPaymentMethodList.util');

/**
 * HOA owner wallet: one saved card/bank (customer-scoped) must work across all board-member
 * processing accounts via hoaProcessingMerchantIds metadata on register.
 */
describe('HOA owner wallet processing account flow', () => {
  const hoaId = '507f1f77bcf86cd799439011';

  it('initialize primary uses real Payload id while wallet scope stays hoa:{hoaId}', () => {
    const scopeKey = `hoa:${hoaId}`;
    const merchantIds = ['acct_board_a_1', 'acct_board_a_2'];
    const primary = resolvePayloadPrimaryProcessingIdForOwnerWallet({
      primaryProcessingId: merchantIds[0],
      merchantIds,
    });

    assert.equal(primary, 'acct_board_a_1');
    assert.equal(scopeKey.startsWith('hoa:'), true);
    assert.notEqual(primary, scopeKey);
  });

  it('register metadata lists every active processing account for the owner board member', () => {
    const merchantIds = ['acct_board_a_1', 'acct_board_a_2', 'acct_board_a_3'];
    const patch = buildHoaOwnerPaymentMethodMetadataPatch(merchantIds);
    assert.deepEqual(patch.hoaProcessingMerchantIds, merchantIds);
  });

  it('when board adds a new processing account, merchantIds include legacy and new ids', () => {
    const before = resolvePayloadPrimaryProcessingIdForOwnerWallet({
      primaryProcessingId: 'acct_old',
      merchantIds: ['acct_old'],
    });
    const after = resolvePayloadPrimaryProcessingIdForOwnerWallet({
      primaryProcessingId: 'acct_old',
      merchantIds: ['acct_old', 'acct_new'],
    });
    assert.equal(before, 'acct_old');
    assert.equal(after, 'acct_old');
    const patch = buildHoaOwnerPaymentMethodMetadataPatch(['acct_old', 'acct_new']);
    assert.equal(patch.hoaProcessingMerchantIds.length, 2);
  });
});
