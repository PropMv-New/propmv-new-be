const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeDashboardMaintenanceStatusRows } = require('./dashboard.service');

describe('summarizeDashboardMaintenanceStatusRows', () => {
  it('counts Open + InProgress as open for vendor-assigned active work', () => {
    const summary = summarizeDashboardMaintenanceStatusRows([
      { _id: 'Open', count: 2 },
      { _id: 'InProgress', count: 3 },
      { _id: 'Resolved', count: 4 },
    ]);

    assert.equal(summary.open, 5);
    assert.equal(summary.resolved, 4);
    assert.equal(summary.pending, 0);
    assert.equal(summary.total, 9);
  });

  it('counts Resolved + Completed as resolved/closed', () => {
    const summary = summarizeDashboardMaintenanceStatusRows([
      { _id: 'Completed', count: 2 },
      { _id: 'Resolved', count: 1 },
      { _id: 'Open', count: 1 },
    ]);

    assert.equal(summary.open, 1);
    assert.equal(summary.resolved, 3);
    assert.equal(summary.total, 4);
  });

  it('keeps legacy Rejected in pending without hiding it from total', () => {
    const summary = summarizeDashboardMaintenanceStatusRows([
      { _id: 'Rejected', count: 1 },
      { _id: 'InProgress', count: 2 },
    ]);

    assert.equal(summary.open, 2);
    assert.equal(summary.pending, 1);
    assert.equal(summary.resolved, 0);
    assert.equal(summary.total, 3);
  });
});
