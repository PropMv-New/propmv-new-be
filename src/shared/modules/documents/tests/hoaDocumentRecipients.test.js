const test = require('node:test');
const assert = require('node:assert/strict');

const { parseIdList } = require('../service/hoa.service');

test('parseIdList dedupes ObjectIds from JSON array strings', () => {
  const id = '507f1f77bcf86cd799439011';
  const result = parseIdList(JSON.stringify([id, id, 'not-an-id']));
  assert.equal(result.length, 1);
  assert.equal(String(result[0]), id);
});

test('parseIdList accepts comma-separated values', () => {
  const a = '507f1f77bcf86cd799439011';
  const b = '507f1f77bcf86cd799439012';
  const result = parseIdList(`${a},${b}`);
  assert.equal(result.length, 2);
});

test('parseIdList returns empty for blank input', () => {
  assert.deepEqual(parseIdList(''), []);
  assert.deepEqual(parseIdList(null), []);
  assert.deepEqual(parseIdList(undefined), []);
});

test('bumpDocumentVersion increments minor version', () => {
  const { bumpDocumentVersion } = require('../service/hoa.service');
  assert.equal(bumpDocumentVersion('v1.0'), 'v1.1');
  assert.equal(bumpDocumentVersion('v2.4'), 'v2.5');
  assert.equal(bumpDocumentVersion('invalid'), 'v1.1');
});
