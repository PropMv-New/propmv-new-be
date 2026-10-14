'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildHoaOwnerPayloadScopeKey,
  isHoaOwnerPayloadScopeKey,
  parseHoaIdFromOwnerPayloadScopeKey,
  buildHoaOwnerPayloadExternalUid,
  isPayloadOwnerMethodInHoaScope,
  isHoaOwnerBillableMerchantInputValid,
  buildHoaOwnerPaymentMethodListOrFilters,
} = require('./payloadHoaOwnerCustomerContext.util');
const { ENTITY_TYPE } = require('../constants/payload.constants');

describe('payloadHoaOwnerCustomerContext.util', () => {
  const hoaId = '507f1f77bcf86cd799439011';

  it('builds stable HOA owner scope keys', () => {
    assert.equal(buildHoaOwnerPayloadScopeKey(hoaId), `hoa:${hoaId}`);
    assert.equal(isHoaOwnerPayloadScopeKey(`hoa:${hoaId}`), true);
    assert.equal(parseHoaIdFromOwnerPayloadScopeKey(`hoa:${hoaId}`), hoaId);
  });

  it('builds external_uid scoped to user and HOA', () => {
    assert.equal(
      buildHoaOwnerPayloadExternalUid('64a1b2c3d4e5f6789012345', hoaId),
      `propmv:64a1b2c3d4e5f6789012345:${hoaId}`,
    );
  });

  it('accepts HOA-scoped, entity-linked, and legacy merchant methods', () => {
    const ctx = {
      scopeKey: `hoa:${hoaId}`,
      merchantIds: ['acct_merch_a', 'acct_merch_b'],
    };

    assert.equal(
      isPayloadOwnerMethodInHoaScope(
        { entityType: ENTITY_TYPE.HOA, entityId: hoaId, billableMerchantId: `hoa:${hoaId}` },
        hoaId,
        ctx,
      ),
      true,
    );

    assert.equal(
      isPayloadOwnerMethodInHoaScope(
        { billableMerchantId: 'acct_merch_b' },
        hoaId,
        ctx,
      ),
      true,
    );

    assert.equal(
      isPayloadOwnerMethodInHoaScope(
        { billableMerchantId: 'acct_other' },
        hoaId,
        ctx,
      ),
      false,
    );
  });

  it('builds list OR filters for unified HOA wallet queries', () => {
    const ctx = {
      scopeKey: `hoa:${hoaId}`,
      merchantIds: ['acct_merch_a', 'acct_merch_b'],
    };
    const filters = buildHoaOwnerPaymentMethodListOrFilters(hoaId, ctx);
    assert.equal(filters.length, 4);
    assert.equal(filters[0].entityType, ENTITY_TYPE.HOA);
    assert.equal(String(filters[0].entityId), hoaId);
    assert.equal(filters[1].billableMerchantId, `hoa:${hoaId}`);
  });

  it('validates billableMerchantId inputs during HOA setup', () => {
    const ctx = {
      scopeKey: `hoa:${hoaId}`,
      primaryProcessingId: 'acct_primary',
      merchantIds: ['acct_primary', 'acct_secondary'],
    };

    assert.equal(isHoaOwnerBillableMerchantInputValid(`hoa:${hoaId}`, ctx), true);
    assert.equal(isHoaOwnerBillableMerchantInputValid('acct_secondary', ctx), true);
    assert.equal(isHoaOwnerBillableMerchantInputValid('acct_unknown', ctx), false);
  });

  it('rejects payment methods tied to another board member merchant outside owner ctx', () => {
    const ctx = {
      scopeKey: `hoa:${hoaId}`,
      merchantIds: ['acct_board_a_one', 'acct_board_a_two'],
    };

    assert.equal(
      isPayloadOwnerMethodInHoaScope({ billableMerchantId: 'acct_board_b_one' }, hoaId, ctx),
      false,
    );
    assert.equal(
      isPayloadOwnerMethodInHoaScope({ billableMerchantId: 'acct_board_a_two' }, hoaId, ctx),
      true,
    );
  });
});
