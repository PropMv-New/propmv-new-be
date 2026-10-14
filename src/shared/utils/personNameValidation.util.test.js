const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidPersonName } = require('./personNameValidation.util');

test('isValidPersonName accepts ampersand only after a letter', () => {
  assert.equal(isValidPersonName('Alan & Susan'), true);
  assert.equal(isValidPersonName('Smith & Jones'), true);
  assert.equal(isValidPersonName("O'Brien"), true);
  assert.equal(isValidPersonName('Mary-Jane'), true);
});

test('isValidPersonName rejects names starting with a number or symbol', () => {
  assert.equal(isValidPersonName('123 Main'), false);
  assert.equal(isValidPersonName('-Alan'), false);
  assert.equal(isValidPersonName('.Alan'), false);
  assert.equal(isValidPersonName('&Susan'), false);
  assert.equal(isValidPersonName('12 Test'), false);
});

test('isValidPersonName rejects invalid ampersand placement', () => {
  assert.equal(isValidPersonName(' & Susan'), false);
  assert.equal(isValidPersonName('Alan&'), false);
  assert.equal(isValidPersonName('123 & Co'), false);
  assert.equal(isValidPersonName('Alan@Susan'), false);
});
