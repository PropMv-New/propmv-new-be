'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ENTITY_TYPE } = require('../constants/payload.constants');
const {
  buildOwnerPaymentMethodDedupeKey,
  dedupeHoaOwnerPaymentMethodsForList,
  findHoaOwnerPaymentMethodDuplicateIds,
} = require('./payloadHoaOwnerPaymentMethodList.util');

describe('payloadHoaOwnerPaymentMethodList.util', () => {
  const hoaId = '507f1f77bcf86cd799439011';
  const merchants = ['acct_merch_a', 'acct_merch_b'];

  it('dedupes bank rows when one row has Plaid fingerprint and another only shares last4', () => {
    const methods = [
      {
        id: '1',
        billableMerchantId: 'acct_merch_a',
        type: 'PLAID_ACH',
        display: { fingerprint: 'fp_plaid_only', last4: '4321' },
      },
      {
        id: '2',
        billableMerchantId: 'acct_merch_b',
        type: 'ACH',
        display: { last4: '4321', routingNumber: '021000021' },
      },
    ];
    const listed = dedupeHoaOwnerPaymentMethodsForList(methods, { hoaId, merchantIds: merchants });
    assert.equal(listed.length, 1);
  });

  it('dedupes bank rows with the same last4 even when routing metadata differs', () => {
    const methods = [
      {
        id: '1',
        billableMerchantId: 'acct_merch_a',
        type: 'ACH',
        display: { last4: '4321', routingNumber: '021000021' },
      },
      {
        id: '2',
        billableMerchantId: 'acct_merch_b',
        type: 'PLAID_ACH',
        display: { last4: '4321' },
      },
    ];
    const listed = dedupeHoaOwnerPaymentMethodsForList(methods, { hoaId, merchantIds: merchants });
    assert.equal(listed.length, 1);
  });

  it('dedupes PLAID_ACH and ACH with the same last4 and routing', () => {
    const methods = [
      {
        id: '1',
        billableMerchantId: 'acct_merch_a',
        type: 'PLAID_ACH',
        display: { last4: '4321', routingNumber: '021000021' },
      },
      {
        id: '2',
        billableMerchantId: 'acct_merch_b',
        type: 'ACH',
        display: { last4: '4321', routingNumber: '021000021' },
      },
    ];
    const listed = dedupeHoaOwnerPaymentMethodsForList(methods, { hoaId, merchantIds: merchants });
    assert.equal(listed.length, 1);
  });

  it('dedupes two legacy merchant rows for the same ACH fingerprint', () => {
    const methods = [
      {
        id: '1',
        billableMerchantId: 'acct_merch_a',
        type: 'ACH',
        display: { fingerprint: 'fp_same', last4: '1234', routingNumber: '110000000' },
      },
      {
        id: '2',
        billableMerchantId: 'acct_merch_b',
        type: 'ACH',
        display: { fingerprint: 'fp_same', last4: '1234', routingNumber: '110000000' },
      },
    ];

    const listed = dedupeHoaOwnerPaymentMethodsForList(methods, { hoaId, merchantIds: merchants });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].hoaProcessingMerchantIds.join(','), merchants.join(','));
    const { buildOwnerPaymentMethodIdentityKey } = require('./payloadHoaOwnerPaymentMethodList.util');
    assert.equal(
      buildOwnerPaymentMethodIdentityKey(methods[0]),
      buildOwnerPaymentMethodIdentityKey(methods[1]),
    );
  });

  it('prefers HOA community-scoped row over legacy merchant duplicate', () => {
    const methods = [
      {
        id: 'legacy',
        billableMerchantId: 'acct_merch_a',
        type: 'ACH',
        display: { last4: '9999', routingNumber: '021000021' },
      },
      {
        id: 'canonical',
        entityType: ENTITY_TYPE.HOA,
        entityId: hoaId,
        billableMerchantId: `hoa:${hoaId}`,
        type: 'ACH',
        display: { last4: '9999', routingNumber: '021000021' },
      },
    ];

    const listed = dedupeHoaOwnerPaymentMethodsForList(methods, { hoaId, merchantIds: merchants });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, 'canonical');
  });

  it('hides legacy rows for merchants removed from the HOA', () => {
    const methods = [
      {
        id: 'orphan',
        billableMerchantId: 'acct_deleted',
        type: 'ACH',
        display: { fingerprint: 'fp_orphan', last4: '1111' },
      },
      {
        id: 'ok',
        entityType: ENTITY_TYPE.HOA,
        entityId: hoaId,
        billableMerchantId: `hoa:${hoaId}`,
        type: 'CARD',
        display: { last4: '4242', brand: 'Visa' },
      },
    ];

    const listed = dedupeHoaOwnerPaymentMethodsForList(methods, { hoaId, merchantIds: merchants });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, 'ok');
  });

  it('finds duplicate ids to soft-delete', () => {
    const methods = [
      {
        _id: 'keep',
        entityType: ENTITY_TYPE.HOA,
        entityId: hoaId,
        billableMerchantId: `hoa:${hoaId}`,
        providerPaymentMethodId: 'pm_1',
        type: 'ACH',
        display: { fingerprint: 'fp_x' },
      },
      {
        _id: 'drop',
        billableMerchantId: 'acct_merch_a',
        providerPaymentMethodId: 'pm_2',
        type: 'ACH',
        display: { fingerprint: 'fp_x' },
      },
    ];

    const dropIds = findHoaOwnerPaymentMethodDuplicateIds(methods, { hoaId, merchantIds: merchants });
    assert.deepEqual(dropIds, ['drop']);
  });
});
