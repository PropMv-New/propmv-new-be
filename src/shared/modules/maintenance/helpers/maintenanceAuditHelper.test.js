const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  enrichMaintenanceAuditDisplay,
  buildMaintenanceCreatedActivitySummary,
  buildMaintenanceActivityTimeline,
  parseMaintenanceActionComment,
  isMaintenanceReopenUpdate,
  updatesIncludeMaintenanceEditFields,
  isSelfCreatedMaintenance,
} = require('./maintenanceAuditHelper');

describe('enrichMaintenanceAuditDisplay', () => {
  it('returns snapshot fields for new tickets', () => {
    const doc = enrichMaintenanceAuditDisplay({
      createdByName: 'John Smith',
      createdByRole: 'HOA Board Member',
      requestedForLabel: 'Annu Bharti (HOA Owner)',
      requestedForType: 'user',
      requestedBy: [{ _id: '507f1f77bcf86cd799439011', firstName: 'Annu', lastName: 'Bharti' }],
      createdBy: { _id: '507f1f77bcf86cd799439012', firstName: 'John', lastName: 'Smith' },
      createdAt: '2026-01-01T10:00:00.000Z',
    });

    assert.equal(doc.createdByDisplay, 'John Smith (HOA Board Member)');
    assert.equal(doc.requestedForDisplay, 'Annu Bharti (HOA Owner)');
    assert.equal(doc.isSelfCreated, false);
    assert.match(
      doc.creationActivitySummary,
      /created by John Smith \(HOA Board Member\) on behalf of Annu Bharti \(HOA Owner\)/
    );
    assert.ok(Array.isArray(doc.activityTimeline));
    assert.equal(doc.activityTimeline[0].type, 'created');
  });

  it('derives legacy display fields from populated users', () => {
    const ownerId = '507f1f77bcf86cd799439011';
    const doc = enrichMaintenanceAuditDisplay({
      createdBy: { _id: ownerId, firstName: 'Annu', lastName: 'Bharti' },
      requestedBy: [{ _id: ownerId, firstName: 'Annu', lastName: 'Bharti' }],
      unitName: 'Unit 101',
    });

    assert.equal(doc.createdByName, 'Annu Bharti');
    assert.equal(doc.requestedForDisplay, 'Annu Bharti');
    assert.equal(doc.isSelfCreated, true);
    assert.equal(
      doc.creationActivitySummary,
      'Maintenance request created by Annu Bharti.'
    );
  });

  it('falls back to unit label when no requester names exist', () => {
    const doc = enrichMaintenanceAuditDisplay({
      createdByName: 'Jai Kishan',
      createdByRole: 'Landlord',
      units: 'Unit 101',
      requestedBy: [],
    });

    assert.equal(doc.requestedForDisplay, 'Unit 101');
    assert.equal(doc.requestedForType, 'unit');
  });
});

describe('buildMaintenanceCreatedActivitySummary', () => {
  it('builds on-behalf summary', () => {
    const summary = buildMaintenanceCreatedActivitySummary({
      createdByDisplay: 'John Smith (HOA Board Member)',
      requestedForDisplay: 'Annu Bharti (HOA Owner)',
      isSelfCreated: false,
    });
    assert.equal(
      summary,
      'Maintenance request created by John Smith (HOA Board Member) on behalf of Annu Bharti (HOA Owner).'
    );
  });
});

describe('isSelfCreatedMaintenance', () => {
  it('detects self-created tickets', () => {
    const id = '507f1f77bcf86cd799439011';
    assert.equal(
      isSelfCreatedMaintenance({
        createdBy: id,
        requestedBy: [id],
      }),
      true
    );
    assert.equal(
      isSelfCreatedMaintenance({
        createdBy: id,
        requestedBy: ['507f1f77bcf86cd799439012'],
      }),
      false
    );
  });
});

describe('buildMaintenanceActivityTimeline', () => {
  it('includes creation, notes, edits, resolve, and reopen', () => {
    const timeline = buildMaintenanceActivityTimeline(
      {
        createdAt: '2026-01-01T10:00:00.000Z',
        notes: [
          {
            _id: '507f1f77bcf86cd799439021',
            content: 'Called plumber',
            createdAt: '2026-01-01T11:00:00.000Z',
            author: { firstName: 'Board', lastName: 'Member' },
          },
        ],
        activityLog: [
          {
            _id: '507f1f77bcf86cd799439031',
            type: 'edited',
            description: 'Maintenance ticket updated by Board Member.',
            createdAt: '2026-01-01T12:00:00.000Z',
            meta: { action: 'edited' },
          },
          {
            _id: '507f1f77bcf86cd799439032',
            type: 'status',
            description: 'Marked as resolved by Board Member.',
            createdAt: '2026-01-01T13:00:00.000Z',
            meta: { action: 'resolved' },
          },
          {
            _id: '507f1f77bcf86cd799439033',
            type: 'status',
            description: 'Ticket reopened by Board Member.',
            createdAt: '2026-01-01T14:00:00.000Z',
            meta: { action: 'reopened' },
          },
        ],
        comments: [
          {
            _id: '507f1f77bcf86cd799439041',
            text: 'Action: Marked as resolved. Comment: Fixed',
            createdAt: '2026-01-01T13:00:00.000Z',
            author: { firstName: 'Board', lastName: 'Member' },
          },
        ],
      },
      { creationActivitySummary: 'Maintenance request created by Board Member.' }
    );

    assert.equal(timeline[0].type, 'created');
    assert.ok(timeline.some((e) => e.type === 'note' && /Called plumber/.test(e.description)));
    assert.ok(timeline.some((e) => e.type === 'edited'));
    assert.ok(timeline.some((e) => e.meta?.action === 'resolved'));
    assert.ok(timeline.some((e) => e.meta?.action === 'reopened'));
    // Action comment should not duplicate when activityLog already has resolved
    assert.equal(timeline.filter((e) => e.meta?.action === 'resolved').length, 1);
  });

  it('synthesizes legacy Action comments when activityLog is empty', () => {
    const timeline = buildMaintenanceActivityTimeline({
      createdAt: '2026-01-01T10:00:00.000Z',
      comments: [
        {
          _id: '507f1f77bcf86cd799439041',
          text: 'Action: Reopened request. Comment: Still leaking',
          createdAt: '2026-01-02T10:00:00.000Z',
          author: { firstName: 'Jane', lastName: 'Doe' },
        },
      ],
    });

    const reopened = timeline.find((e) => e.meta?.action === 'reopened');
    assert.ok(reopened);
    assert.match(reopened.description, /Still leaking/);
  });
});

describe('parseMaintenanceActionComment', () => {
  it('parses resolve and reopen action comments', () => {
    assert.equal(
      parseMaintenanceActionComment('Action: Marked as resolved. Comment: Done').action,
      'resolved'
    );
    assert.equal(
      parseMaintenanceActionComment('Action: Reopened request. Comment: Not fixed').action,
      'reopened'
    );
    assert.equal(parseMaintenanceActionComment('Regular comment'), null);
  });
});

describe('update activity helpers', () => {
  it('detects reopen and edit fields', () => {
    assert.equal(isMaintenanceReopenUpdate('Resolved', 'Open'), true);
    assert.equal(isMaintenanceReopenUpdate('Open', 'Resolved'), false);
    assert.equal(updatesIncludeMaintenanceEditFields({ title: 'x' }), true);
    assert.equal(updatesIncludeMaintenanceEditFields({ status: 'Open' }), false);
  });
});
