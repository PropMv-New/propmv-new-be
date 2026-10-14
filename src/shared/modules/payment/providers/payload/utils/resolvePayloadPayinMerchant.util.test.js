'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ENTITY_TYPE } = require('../constants/payload.constants');
const { isPayloadOwnerMethodInHoaScope } = require('./payloadHoaOwnerCustomerContext.util');
const { inferHoaIdForOwnerPaymentMethod } = require('./resolvePayloadPayinMerchant.util');

describe('inferHoaIdForOwnerPaymentMethod', () => {
  const hoaId = '507f1f77bcf86cd799439011';

  it('prefers explicit hoaId argument', () => {
    const method = { entityType: ENTITY_TYPE.HOA, entityId: 'other' };
    assert.equal(inferHoaIdForOwnerPaymentMethod(method, hoaId), hoaId);
  });

  it('reads hoaId from HOA-scoped payment method entity', () => {
    const method = {
      entityType: ENTITY_TYPE.HOA,
      entityId: hoaId,
      billableMerchantId: `hoa:${hoaId}`,
    };
    assert.equal(inferHoaIdForOwnerPaymentMethod(method, null), hoaId);
  });

  it('parses hoaId from unified wallet scope key on billableMerchantId', () => {
    const method = { billableMerchantId: `hoa:${hoaId}` };
    assert.equal(inferHoaIdForOwnerPaymentMethod(method, ''), hoaId);
  });
});

describe('resolvePayloadPayinMerchant HOA unified pay-in scope', () => {
  it('allows community-scoped methods when deposit merchant differs from legacy billableMerchantId', () => {
    const hoaId = '507f1f77bcf86cd799439011';
    const depositMerchant = 'acct_merch_b';
    const method = {
      billableMerchantId: 'acct_merch_a',
      entityType: ENTITY_TYPE.HOA,
      entityId: hoaId,
    };

    assert.equal(
      isPayloadOwnerMethodInHoaScope(method, hoaId, {
        scopeKey: `hoa:${hoaId}`,
        merchantIds: ['acct_merch_a', depositMerchant],
      }),
      true,
    );
    assert.notEqual(String(method.billableMerchantId), depositMerchant);
  });
});
