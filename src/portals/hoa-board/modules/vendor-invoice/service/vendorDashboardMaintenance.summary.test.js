const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  summarizeVendorMaintenanceStatusRows,
  buildVendorMaintenanceTicketMatch,
} = require('./vendorInvoice.service');

describe('summarizeVendorMaintenanceStatusRows', () => {
  it('counts Open + InProgress as open and Resolved as completed', () => {
    const summary = summarizeVendorMaintenanceStatusRows([
      { _id: 'Open', count: 2 },
      { _id: 'InProgress', count: 1 },
      { _id: 'Resolved', count: 4 },
    ]);

    assert.equal(summary.open, 3);
    assert.equal(summary.inProgress, 1);
    assert.equal(summary.completed, 4);
    assert.equal(summary.total, 7);
    assert.equal(summary.remaining, 3);
  });

  it('treats a lone InProgress ticket as Open (not resolved)', () => {
    const summary = summarizeVendorMaintenanceStatusRows([
      { _id: 'InProgress', count: 1 },
    ]);
    assert.equal(summary.open, 1);
    assert.equal(summary.completed, 0);
    assert.equal(summary.total, 1);
    assert.equal(summary.remaining, 1);
  });

  it('normalizes status casing/spacing so In Progress still counts as open', () => {
    const summary = summarizeVendorMaintenanceStatusRows([
      { _id: 'in progress', count: 1 },
      { _id: 'IN_PROGRESS', count: 1 },
      { _id: 'resolved', count: 2 },
    ]);
    assert.equal(summary.open, 2);
    assert.equal(summary.completed, 2);
  });

  it('treats Completed as closed/completed', () => {
    const summary = summarizeVendorMaintenanceStatusRows([
      { _id: 'Completed', count: 2 },
      { _id: 'Resolved', count: 1 },
    ]);

    assert.equal(summary.completed, 3);
    assert.equal(summary.open, 0);
    assert.equal(summary.total, 3);
  });
});

describe('buildVendorMaintenanceTicketMatch', () => {
  it('filters period stats by request_date to match maintenance listing', () => {
    const vendorId = '507f1f77bcf86cd799439011';
    const match = buildVendorMaintenanceTicketMatch(
      vendorId,
      null,
      { startDate: '2026-09-01', endDate: '2026-09-30' },
    );

    assert.equal(String(match.assignedTo), vendorId);
    assert.ok(match.request_date?.$gte);
    assert.ok(match.request_date?.$lte);
    assert.equal(match.createdAt, undefined);
  });

  it('does not scope vendor maintenance stats by active HOA (cross-community assigned work)', () => {
    const vendorId = '507f1f77bcf86cd799439011';
    const hoaId = '507f1f77bcf86cd799439088';
    const match = buildVendorMaintenanceTicketMatch(
      vendorId,
      { hoaId },
      null,
    );
    assert.equal(String(match.assignedTo), vendorId);
    assert.equal(match.hoaId, undefined);
  });
});
