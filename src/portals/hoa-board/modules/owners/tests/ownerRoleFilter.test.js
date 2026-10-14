/**
 * Ensures HOA owner role helper distinguishes owners from board members.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { isHOAOwnerRole } = require('../../../../../common/helpers/hoaOwnerRole');

describe('isHOAOwnerRole', () => {
  test('matches HOA Owner role names', () => {
    assert.equal(isHOAOwnerRole('HOA Owner'), true);
    assert.equal(isHOAOwnerRole({ name: 'HOA Owner' }), true);
    assert.equal(isHOAOwnerRole('hoa_owner'), true);
  });

  test('rejects HOA Board Member role', () => {
    assert.equal(isHOAOwnerRole('HOA Board Member'), false);
    assert.equal(isHOAOwnerRole({ name: 'HOA Board Member' }), false);
  });
});
