/**
 * Unit tests: shared maintenance service transaction helpers.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  withMaintenanceTransaction,
  runInTransaction,
} = require('../shared/modules/maintenance/service/maintenanceDb.util');

const {
  buildListFilterFromQuery,
  buildHoaCommunityMaintenanceScope,
  buildOwnerMaintenanceListScope,
  buildOwnerMaintenanceTicketMatch,
  applyMaintenanceListScopeToQuery,
  resolveMaintenanceListStatusFilter,
  normalizeListPagination,
  maintenanceRequestedByUserIds,
} = require('../shared/modules/maintenance/service/maintenance.service');
const mongoose = require('mongoose');
const { MAINTENANCE_REQUEST_STATUS } = require('../common/constants/property');

describe('withMaintenanceTransaction', () => {
  test('reuses caller session without starting a nested transaction', async () => {
    const fakeSession = { id: 'maintenance-session' };
    let receivedSession = null;
    const result = await withMaintenanceTransaction(async (session) => {
      receivedSession = session;
      return 'ok';
    }, { session: fakeSession });
    assert.equal(result, 'ok');
    assert.equal(receivedSession, fakeSession);
  });

  test('runInTransaction is exported', () => {
    assert.equal(typeof runInTransaction, 'function');
  });
});

describe('buildListFilterFromQuery', () => {
  test('merges createdBy from actor', () => {
    const actorId = '507f1f77bcf86cd799439011';
    const filter = buildListFilterFromQuery({ property_id: '507f1f77bcf86cd799439012' }, actorId);
    assert.equal(String(filter.createdBy), actorId);
    assert.equal(filter.property_id, '507f1f77bcf86cd799439012');
  });

  test('parses isUrgent boolean from string', () => {
    const filter = buildListFilterFromQuery({ isUrgent: 'true' }, null);
    assert.equal(filter.isUrgent, true);
  });

  test('does not default createdBy when HOA list scope is active', () => {
    const actorId = '507f1f77bcf86cd799439011';
    const filter = buildListFilterFromQuery({ hoaBoardMemberId: actorId }, actorId);
    assert.equal(filter.hoaBoardMemberId, actorId);
    assert.equal(filter.createdBy, undefined);
  });
});

describe('buildHoaCommunityMaintenanceScope', () => {
  const communityA = '6a245dd1e4d2dbdb2ca85bad';
  const propertyA = '6a247703406a3cac03873ee8';

  test('scopes by hoaId for community-only tickets', () => {
    const scope = buildHoaCommunityMaintenanceScope(communityA, []);
    assert.equal(scope.length, 1);
    assert.equal(String(scope[0].hoaId), communityA);
  });

  test('includes legacy property fallback without requester matching', () => {
    const scope = buildHoaCommunityMaintenanceScope(communityA, [propertyA]);
    assert.equal(scope.length, 2);
    assert.equal(String(scope[0].hoaId), communityA);
    assert.ok(scope[1].$and);
    assert.ok(scope[1].$and.some((clause) => clause.property_id));
    assert.equal(scope.some((clause) => clause.requestedBy), false);
  });

  test('includes legacy member fallback for tickets without hoaId', () => {
    const ownerId = '507f1f77bcf86cd799439011';
    const scope = buildHoaCommunityMaintenanceScope(communityA, [], [ownerId]);
    assert.equal(scope.length, 2);
    assert.ok(scope[1].$and);
    const memberScope = scope[1].$and.find(
      (clause) => clause.$or?.some((row) => row.createdBy || row.requestedBy)
    );
    assert.ok(memberScope);
    assert.ok(memberScope.$or.some((row) => row.createdBy));
    assert.ok(memberScope.$or.some((row) => row.requestedBy));
  });
});

describe('buildOwnerMaintenanceListScope', () => {
  const ownerId = '507f1f77bcf86cd799439011';
  const communityA = '6a245dd1e4d2dbdb2ca85bad';
  const propertyA = '6a247703406a3cac03873ee8';
  const ownerOid = new mongoose.Types.ObjectId(ownerId);
  const propOid = new mongoose.Types.ObjectId(propertyA);

  test('without HOA header matches owner requester, creator, and property scope', () => {
    const scope = buildOwnerMaintenanceListScope(null, ownerOid, [propOid]);
    assert.equal(scope.length, 1);
    assert.ok(scope[0].$or);
    const match = buildOwnerMaintenanceTicketMatch(ownerOid, [propOid]);
    assert.deepEqual(scope[0].$or, match);
    assert.ok(match.some((clause) => clause.createdBy));
    assert.ok(match.some((clause) => clause.requestedBy));
  });

  test('with HOA header narrows to active community and legacy property rows', () => {
    const scope = buildOwnerMaintenanceListScope({ hoaId: communityA }, ownerOid, [propOid]);
    assert.equal(scope.length, 2);
    assert.equal(String(scope[0].hoaId), communityA);
    assert.ok(scope[0].$or);
    assert.ok(scope[1].$and);
  });
});

describe('normalizeListPagination', () => {
  test('parses pageNumber and pageSize', () => {
    const p = normalizeListPagination({ pageNumber: '2', pageSize: '25' });
    assert.equal(p.pageNumber, 2);
    assert.equal(p.pageSize, 25);
  });

  test('falls back to page when pageNumber missing', () => {
    const p = normalizeListPagination({ page: '3', pageSize: '10' });
    assert.equal(p.pageNumber, 3);
    assert.equal(p.pageSize, 10);
  });
});

describe('applyMaintenanceListScopeToQuery', () => {
  const hoaId = new mongoose.Types.ObjectId();
  const propId = new mongoose.Types.ObjectId();
  const searchOr = [
    { title: { $regex: 'leak', $options: 'i' } },
    { ticketNumber: { $regex: 'leak', $options: 'i' } },
  ];

  test('preserves title search when multi-branch HOA scope would overwrite $or', () => {
    const scopeOr = buildHoaCommunityMaintenanceScope(hoaId, [propId], [new mongoose.Types.ObjectId()]);
    assert.ok(scopeOr.length > 1);

    const q = { isDeleted: { $ne: true }, $or: searchOr };
    applyMaintenanceListScopeToQuery(q, scopeOr, null);

    assert.equal(q.$or, undefined);
    assert.ok(Array.isArray(q.$and));
    assert.ok(q.$and.some((clause) => clause.$or === scopeOr || (clause.$or && clause.$or.length === scopeOr.length)));
    assert.ok(q.$and.some((clause) => clause.$or === searchOr));
  });

  test('keeps single-clause scope assign when there is no search', () => {
    const scopeOr = [{ hoaId }];
    const q = { isDeleted: { $ne: true } };
    applyMaintenanceListScopeToQuery(q, scopeOr, null);
    assert.equal(String(q.hoaId), String(hoaId));
    assert.equal(q.$or, undefined);
    assert.equal(q.$and, undefined);
  });

  test('ANDs search with single-clause scope that already embeds $or', () => {
    const ownerOid = new mongoose.Types.ObjectId();
    const scopeOr = buildOwnerMaintenanceListScope({ hoaId }, ownerOid, []);
    assert.equal(scopeOr.length, 1);
    assert.ok(scopeOr[0].$or);

    const q = { isDeleted: { $ne: true }, $or: searchOr };
    applyMaintenanceListScopeToQuery(q, scopeOr, null);

    assert.equal(q.$or, undefined);
    assert.ok(q.$and.some((clause) => clause === scopeOr[0]));
    assert.ok(q.$and.some((clause) => clause.$or === searchOr));
  });
});

describe('resolveMaintenanceListStatusFilter', () => {
  test('expands Open to Open+InProgress for vendor-scoped lists', () => {
    assert.deepEqual(
      resolveMaintenanceListStatusFilter('Open', { vendorScoped: true }),
      {
        $in: [
          MAINTENANCE_REQUEST_STATUS.OPEN,
          MAINTENANCE_REQUEST_STATUS.IN_PROGRESS,
        ],
      },
    );
  });

  test('expands Open to Open+InProgress for non-vendor lists (dashboard deep links)', () => {
    assert.deepEqual(
      resolveMaintenanceListStatusFilter('Open', { vendorScoped: false }),
      {
        $in: [
          MAINTENANCE_REQUEST_STATUS.OPEN,
          MAINTENANCE_REQUEST_STATUS.IN_PROGRESS,
        ],
      },
    );
  });
});

describe('maintenanceRequestedByUserIds', () => {
  test('extracts ids from array', () => {
    const ids = maintenanceRequestedByUserIds({
      requestedBy: [{ _id: '507f1f77bcf86cd799439011' }, '507f1f77bcf86cd799439012'],
    });
    assert.equal(ids.length, 2);
  });
});
