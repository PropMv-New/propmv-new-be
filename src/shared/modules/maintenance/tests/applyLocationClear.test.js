/**
 * Found in end-to-end QA: a maintenance ticket created without a property
 * (property is optional) could not be edited - the edit form sends
 * property_id null / unitId null / units '' and the update failed with
 * "units or unitId is required when updating unit".
 *
 * Run: node --test src/shared/modules/maintenance/tests/applyLocationClear.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyLocationClear } = require('../service/maintenance.service');

test('clearing the property clears the unit too', () => {
  const updates = { property_id: null, unitId: null, units: '', title: 'Gate' };
  assert.equal(applyLocationClear(updates), true);
  assert.deepEqual(
    { property_id: updates.property_id, unitId: updates.unitId, units: updates.units },
    { property_id: null, unitId: null, units: '' }
  );
});

test('an empty-string property also counts as cleared', () => {
  assert.equal(applyLocationClear({ property_id: '' }), true);
});

test('an update with a property is left alone', () => {
  const updates = { property_id: '6abe209a214c035b43f65a18', units: 'Unit 3' };
  assert.equal(applyLocationClear(updates), false);
  assert.equal(updates.units, 'Unit 3');
});

test('an update that does not mention the property is left alone', () => {
  const updates = { title: 'Gate' };
  assert.equal(applyLocationClear(updates), false);
  assert.equal('unitId' in updates, false);
});
