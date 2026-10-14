const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeMaintenanceNoteAuthorId,
  isPrivateMaintenanceNotesScope,
  filterMaintenanceNotesForViewer,
  assertMaintenanceNoteOwner,
  applyPrivateMaintenanceNotesForViewer,
  filterMaintenanceActivityLogForViewer,
} = require('./maintenanceNoteAccess.helper');

const vendorA = '507f1f77bcf86cd799439011';
const vendorB = '507f1f77bcf86cd799439012';
const boardUser = '507f1f77bcf86cd799439031';

describe('maintenance note access helper', () => {
  it('extracts author id from populated note references', () => {
    assert.equal(
      normalizeMaintenanceNoteAuthorId({ author: { _id: vendorA, firstName: 'Vendor' } }),
      vendorA
    );
  });

  it('detects HOA/vendor private note scope', () => {
    assert.equal(isPrivateMaintenanceNotesScope({ isVendor: true, hoaId: 'abc' }), true);
    assert.equal(isPrivateMaintenanceNotesScope({ isHOABoardMember: true, hoaId: 'abc' }), true);
    assert.equal(isPrivateMaintenanceNotesScope(null), false);
  });

  it('returns only the viewer notes in HOA/vendor scope', () => {
    const notes = [
      { _id: '1', author: { _id: vendorA }, content: 'mine' },
      { _id: '2', author: { _id: vendorB }, content: 'theirs' },
    ];
    const filtered = filterMaintenanceNotesForViewer(notes, vendorA);
    assert.equal(filtered.length, 1);
    assert.equal(String(filtered[0]._id), '1');
  });

  it('rejects non-owner note mutations with 403', () => {
    assert.throws(
      () => assertMaintenanceNoteOwner({ author: { _id: vendorA } }, vendorB),
      (err) => err.status === 403
    );
  });

  it('allows note owner mutations', () => {
    assert.doesNotThrow(() => assertMaintenanceNoteOwner({ author: { _id: vendorA } }, vendorA));
  });

  it('filters notes and note activity log entries for the viewer', () => {
    const doc = {
      notes: [
        { _id: 'n1', author: { _id: vendorA }, content: 'private A' },
        { _id: 'n2', author: { _id: vendorB }, content: 'private B' },
      ],
      activityLog: [
        { type: 'note', performedBy: vendorA, meta: { noteId: 'n1' }, description: 'A note' },
        { type: 'note', performedBy: vendorB, meta: { noteId: 'n2' }, description: 'B note' },
        { type: 'status', performedBy: boardUser, description: 'Status changed' },
      ],
    };

    const scoped = applyPrivateMaintenanceNotesForViewer(doc, vendorA, { isVendor: true, hoaId: 'hoa1' });
    assert.equal(scoped.notes.length, 1);
    assert.equal(String(scoped.notes[0]._id), 'n1');
    assert.equal(scoped.activityLog.length, 2);
    assert.ok(scoped.activityLog.every((entry) => entry.type !== 'note' || String(entry.performedBy) === vendorA));
  });

  it('does not filter notes for landlord scope', () => {
    const doc = {
      notes: [
        { _id: 'n1', author: { _id: vendorA }, content: 'A' },
        { _id: 'n2', author: { _id: vendorB }, content: 'B' },
      ],
      activityLog: [],
    };
    const scoped = applyPrivateMaintenanceNotesForViewer(doc, vendorA, null);
    assert.equal(scoped.notes.length, 2);
  });

  it('filters note activity log entries by performer', () => {
    const filtered = filterMaintenanceActivityLogForViewer(
      [
        { type: 'note', performedBy: vendorA },
        { type: 'note', performedBy: vendorB },
        { type: 'edited', performedBy: boardUser },
      ],
      vendorA,
      { privateNotes: true }
    );
    assert.equal(filtered.length, 2);
  });
});
