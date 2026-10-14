'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  collectHoaBoardMemberIdsForOwnerFromProperties,
  boardMemberObjectIds,
} = require('./payloadHoaOwnerBoardMemberScope.util');
const { buildHoaBillableMerchantQuery } = require('./payloadBillableMerchant.util');
const { ENTITY_TYPE } = require('../constants/payload.constants');

describe('payloadHoaOwnerBoardMemberScope.util', () => {
  const ownerA = '507f1f77bcf86cd799439011';
  const boardOne = '507f1f77bcf86cd799439012';
  const boardTwo = '507f1f77bcf86cd799439013';
  const hoaId = '507f1f77bcf86cd799439099';

  const getCurrentOwnerIdsFromUnit = (unit) => unit.currentOwnerIds || [];

  it('collects landlord_id only for units where owner is current', () => {
    const properties = [
      {
        landlord_id: boardOne,
        currentOwnerIds: [ownerA],
      },
      {
        landlord_id: boardTwo,
        currentOwnerIds: ['other-owner'],
      },
      {
        landlord_id: boardTwo,
        currentOwnerIds: [ownerA],
      },
    ];

    const ids = collectHoaBoardMemberIdsForOwnerFromProperties(
      ownerA,
      properties,
      getCurrentOwnerIdsFromUnit,
    );

    assert.deepEqual(new Set(ids), new Set([boardOne, boardTwo]));
  });

  it('returns empty board member ids when owner is not on any unit', () => {
    const ids = collectHoaBoardMemberIdsForOwnerFromProperties(
      ownerA,
      [{ landlord_id: boardOne, currentOwnerIds: ['x'] }],
      getCurrentOwnerIdsFromUnit,
    );
    assert.deepEqual(ids, []);
  });

  it('buildHoaBillableMerchantQuery scopes PayloadAccount rows to board member createdBy', () => {
    const query = buildHoaBillableMerchantQuery(hoaId, { boardMemberIds: [boardOne, boardTwo] });
    assert.equal(query.entityType, ENTITY_TYPE.HOA);
    assert.equal(query['metadata.hoaId'], hoaId);
    assert.equal(query.createdBy.$in.length, 2);
    assert.equal(String(query.createdBy.$in[0]), boardOne);
    assert.equal(String(query.createdBy.$in[1]), boardTwo);
  });

  it('buildHoaBillableMerchantQuery with empty boardMemberIds matches no merchants', () => {
    const query = buildHoaBillableMerchantQuery(hoaId, { boardMemberIds: [] });
    assert.deepEqual(query.createdBy, { $in: [] });
  });

  it('buildHoaBillableMerchantQuery without boardMemberIds keeps HOA-wide merchant query', () => {
    const query = buildHoaBillableMerchantQuery(hoaId);
    assert.equal(query.createdBy, undefined);
  });

  it('boardMemberObjectIds dedupes and drops invalid ids', () => {
    const ids = boardMemberObjectIds([boardOne, boardOne, 'not-an-id', boardTwo]);
    assert.equal(ids.length, 2);
  });
});
