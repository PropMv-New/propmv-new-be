'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { planMaintenanceUnitUpdate } = require('./normalizeMaintenanceUnitUpdate');

describe('planMaintenanceUnitUpdate', () => {
  it('noops when unit fields are absent', () => {
    assert.deepEqual(planMaintenanceUnitUpdate({ title: 'Leak' }), { action: 'noop' });
  });

  it('clears when unitId/units are empty (property deselected payload)', () => {
    assert.deepEqual(
      planMaintenanceUnitUpdate({ property_id: null, unitId: null, units: '' }),
      { action: 'clear' }
    );
    assert.deepEqual(
      planMaintenanceUnitUpdate({ unitId: '', units: '' }, '507f1f77bcf86cd799439011'),
      { action: 'clear' }
    );
  });

  it('clears when property is cleared even if a unit name is still present', () => {
    assert.deepEqual(
      planMaintenanceUnitUpdate({ property_id: null, units: '12A' }),
      { action: 'clear' }
    );
  });

  it('plans resolve by unitId when a property is available', () => {
    const unitId = '507f1f77bcf86cd799439022';
    assert.deepEqual(
      planMaintenanceUnitUpdate(
        { property_id: '507f1f77bcf86cd799439011', unitId },
        null
      ),
      { action: 'resolve', unitId, unitName: undefined }
    );
  });

  it('plans resolve by unit name against the existing property', () => {
    assert.deepEqual(
      planMaintenanceUnitUpdate({ units: '12A' }, '507f1f77bcf86cd799439011'),
      { action: 'resolve', unitId: undefined, unitName: '12A' }
    );
  });

  it('errors when resolving a unit without any property', () => {
    const plan = planMaintenanceUnitUpdate({ units: '12A' }, null);
    assert.equal(plan.action, 'resolve');
    assert.equal(plan.error, 'property_id is required when updating unit');
  });
});
