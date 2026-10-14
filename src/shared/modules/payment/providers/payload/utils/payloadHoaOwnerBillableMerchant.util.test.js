'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildHoaBillableMerchantQuery } = require('./payloadBillableMerchant.util');
const { ENTITY_TYPE } = require('../constants/payload.constants');

describe('payloadHoaOwnerBillableMerchant scoping', () => {
  it('buildHoaBillableMerchantQuery ties merchants to HOA metadata only', () => {
    const hoaId = '507f1f77bcf86cd799439011';
    const query = buildHoaBillableMerchantQuery(hoaId);
    assert.equal(query.entityType, ENTITY_TYPE.HOA);
    assert.equal(query['metadata.hoaId'], hoaId);
    assert.equal(query.isDeleted.$ne, true);
    assert.equal(query.createdBy, undefined);
  });

  it('does not mix board members when owner board scope is provided', () => {
    const hoaId = '507f1f77bcf86cd799439011';
    const boardMember = '507f1f77bcf86cd799439012';
    const query = buildHoaBillableMerchantQuery(hoaId, { boardMemberIds: [boardMember] });
    assert.equal(query.createdBy.$in.length, 1);
    assert.equal(String(query.createdBy.$in[0]), boardMember);
  });
});
