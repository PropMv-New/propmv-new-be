const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveMaintenanceListStatusFilter,
} = require('./maintenance.service');

describe('resolveMaintenanceListStatusFilter', () => {
  it('expands Open to Open + InProgress for HOA board/owner (not only vendors)', () => {
    const filter = resolveMaintenanceListStatusFilter('Open', { vendorScoped: false });
    assert.deepEqual(filter, { $in: ['Open', 'InProgress'] });
  });

  it('expands Resolved to Resolved + Completed', () => {
    const filter = resolveMaintenanceListStatusFilter('Resolved', { vendorScoped: false });
    assert.ok(filter.$in.includes('Resolved'));
    assert.ok(filter.$in.includes('Completed'));
  });

  it('leaves InProgress as an exact status match', () => {
    assert.equal(
      resolveMaintenanceListStatusFilter('InProgress', { vendorScoped: false }),
      'InProgress'
    );
  });
});
