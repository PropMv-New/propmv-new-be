/**
 * HOA community scope: active x-hoa-id must not leak via shared landlord_id.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  buildHoaBoardPropertyMatch,
  buildActiveHoaIdMatch,
} = require('../middleware/hoaDataIsolation');

describe('buildHoaBoardPropertyMatch', () => {
  const hoaA = new mongoose.Types.ObjectId().toString();
  const memberId = new mongoose.Types.ObjectId().toString();

  test('with active hoaId scopes strictly to that community', () => {
    const match = buildHoaBoardPropertyMatch({
      isHOABoardMember: true,
      hoaId: hoaA,
      hoaMemberUserIds: [memberId],
      userId: memberId,
    });
    assert.deepEqual(match, { hoaId: new mongoose.Types.ObjectId(hoaA) });
    assert.equal(match.$or, undefined);
  });

  test('buildActiveHoaIdMatch returns null without hoaId', () => {
    assert.equal(buildActiveHoaIdMatch({ hoaId: null }), null);
  });
});
