const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Activity = require('../portals/hoa-board/modules/dashboard/model/activity.model');
const activityService = require('../portals/hoa-board/modules/dashboard/service/activity.service');
const Property = require('../portals/hoa-board/modules/property/model/property.model');
const Invoice = require('../portals/hoa-board/modules/invoice/model/invoice.model');
const User = require('../shared/modules/users/models/user.model');
const Expense = require('../portals/hoa-board/modules/expense/model/expense.model');
const MaintenanceRequest = require('../shared/modules/maintenance/model/maintenanceRequest.model');
const Payee = require('../portals/hoa-board/modules/expense/model/payee.model');
const HoaDocument = require('../shared/modules/documents/model/hoaDocument.model');

const restoreFns = [];

const patch = (target, key, value) => {
  const original = target[key];
  restoreFns.push(() => {
    target[key] = original;
  });
  target[key] = value;
};

const setupModelMocks = (suffix) => {
  const propId = new mongoose.Types.ObjectId(`6700000000000000000000${suffix}`);
  const invId = new mongoose.Types.ObjectId(`6700000000000000000001${suffix}`);
  const ownerId = new mongoose.Types.ObjectId(`6700000000000000000002${suffix}`);

  patch(Property, 'find', () => ({
    distinct: async () => [propId],
  }));
  patch(Property, 'distinct', async () => []);
  patch(Invoice, 'distinct', async () => [invId]);
  patch(User, 'distinct', async () => [ownerId]);
  patch(Expense, 'distinct', async () => []);
  patch(MaintenanceRequest, 'distinct', async () => []);
  patch(Payee, 'distinct', async () => []);
  patch(HoaDocument, 'distinct', async () => []);
};

afterEach(() => {
  while (restoreFns.length > 0) {
    const restore = restoreFns.pop();
    restore();
  }
});

describe('Community-Scoped Recent Activity (GitHub #300)', () => {
  const communityA_Id = '67000000000000000000000a'; // Test Sunset Valley
  const communityB_Id = '67000000000000000000000b'; // PropMv Test Community
  const boardMemberUserId = '670000000000000000000001';

  test('Activity schema contains indexed hoaId field', () => {
    const hoaIdPath = Activity.schema.path('hoaId');
    assert.ok(hoaIdPath, 'Activity schema must have hoaId path');
    assert.equal(hoaIdPath.instance.toLowerCase(), 'objectid');
  });

  test('logActivity persists explicit hoaId and metadata', async () => {
    let createdDoc = null;
    patch(Activity, 'create', async (doc) => {
      createdDoc = doc;
      return { _id: new mongoose.Types.ObjectId(), ...doc };
    });

    await activityService.logActivity({
      userId: boardMemberUserId,
      action: 'CREATE',
      module: 'Owner',
      entityId: new mongoose.Types.ObjectId(),
      hoaId: communityA_Id,
      entityName: 'John Doe',
      description: 'Created owner John Doe',
    });

    assert.ok(createdDoc, 'Activity document should be created');
    assert.equal(String(createdDoc.hoaId), communityA_Id);
    assert.equal(createdDoc.action, 'CREATE');
    assert.equal(createdDoc.module, 'Owner');
  });

  test('logActivity automatically infers hoaId from Invoice entity if omitted', async () => {
    const invoiceId = new mongoose.Types.ObjectId();
    let createdDoc = null;
    patch(Activity, 'create', async (doc) => {
      createdDoc = doc;
      return { _id: new mongoose.Types.ObjectId(), ...doc };
    });

    patch(Invoice, 'findById', () => ({
      select: () => ({
        lean: async () => ({ _id: invoiceId, hoaId: new mongoose.Types.ObjectId(communityA_Id) }),
      }),
    }));

    await activityService.logActivity({
      userId: boardMemberUserId,
      action: 'PAYMENT_SUCCESS',
      module: 'Invoice',
      entityId: invoiceId,
      entityName: 'HOA Invoice',
      description: 'Payment received',
    });

    assert.ok(createdDoc);
    assert.equal(String(createdDoc.hoaId), communityA_Id);
    assert.equal(createdDoc.action, 'PAYMENT_SUCCESS');
  });

  test('Two-community isolation: Community A query strictly scopes to Community A resources', async () => {
    let executedFilter = null;
    setupModelMocks('aa');

    patch(Activity, 'find', (filter) => {
      executedFilter = filter;
      return {
        populate: () => ({
          sort: () => ({
            skip: () => ({
              limit: () => ({
                lean: async () => [
                  {
                    _id: new mongoose.Types.ObjectId(),
                    module: 'Owner',
                    action: 'CREATE',
                    entityId: new mongoose.Types.ObjectId('6700000000000000000002aa'),
                    entityName: 'Sunset Valley Owner',
                    description: 'Created owner "Sunset Valley Owner"',
                    createdAt: new Date(),
                  },
                  {
                    _id: new mongoose.Types.ObjectId(),
                    module: 'Invoice',
                    action: 'PAYMENT_SUCCESS',
                    entityId: new mongoose.Types.ObjectId('6700000000000000000001aa'),
                    entityName: 'HOA Invoice',
                    description: 'Payment of $250.00 received',
                    createdAt: new Date(),
                  },
                ],
              }),
            }),
          }),
        }),
      };
    });

    patch(Activity, 'countDocuments', async () => 2);

    const result = await activityService.getRecentActivities({
      userContext: {
        isHOABoardMember: true,
        hoaId: communityA_Id,
        userId: boardMemberUserId,
      },
      communityId: communityA_Id,
      limit: 10,
    });

    assert.ok(executedFilter, 'Query filter must be generated');
    assert.ok(executedFilter.$or, 'Must contain community scoping $or clauses');

    // Verify community clauses match community A ID
    const hoaClause = executedFilter.$or.find((c) => c.hoaId && String(c.hoaId) === communityA_Id);
    assert.ok(hoaClause, 'Filter must match community A hoaId');

    // Verify activities returned belong to Community A
    assert.equal(result.data.length, 2);
    assert.equal(result.data[0].action, 'CREATE');
    assert.equal(result.data[0].module, 'Owner');
    assert.equal(result.data[1].action, 'PAYMENT_SUCCESS');
  });

  test('Two-community isolation: Community B query strictly excludes Community A activities', async () => {
    let executedFilter = null;
    setupModelMocks('bb');

    patch(Activity, 'find', (filter) => {
      executedFilter = filter;
      return {
        populate: () => ({
          sort: () => ({
            skip: () => ({
              limit: () => ({
                lean: async () => [
                  {
                    _id: new mongoose.Types.ObjectId(),
                    module: 'Invoice',
                    action: 'STATUS_CHANGE',
                    entityId: new mongoose.Types.ObjectId('6700000000000000000001bb'),
                    entityName: 'HOA Invoice',
                    description: 'Waived $50.00 late fee for PropMv Community',
                    createdAt: new Date(),
                  },
                ],
              }),
            }),
          }),
        }),
      };
    });

    patch(Activity, 'countDocuments', async () => 1);

    const result = await activityService.getRecentActivities({
      userContext: {
        isHOABoardMember: true,
        hoaId: communityB_Id,
        userId: boardMemberUserId,
      },
      communityId: communityB_Id,
      limit: 10,
    });

    assert.ok(executedFilter);
    // Ensure community A ID is NOT present in any clause
    const hasCommunityA = executedFilter.$or.some(
      (c) =>
        (c.hoaId && String(c.hoaId) === communityA_Id) ||
        (c['meta.hoaId'] && String(c['meta.hoaId']) === communityA_Id)
    );
    assert.equal(hasCommunityA, false, 'Community B query must NEVER include Community A criteria');

    // Ensure community B ID IS present
    const hasCommunityB = executedFilter.$or.some(
      (c) =>
        (c.hoaId && String(c.hoaId) === communityB_Id) ||
        (c['meta.hoaId'] && String(c['meta.hoaId']) === communityB_Id)
    );
    assert.equal(hasCommunityB, true, 'Community B query must include Community B criteria');

    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].description, 'Waived $50.00 late fee for PropMv Community');
  });

  test('Authorization: Mismatched or unauthorized community query rejects with 403', async () => {
    await assert.rejects(
      async () => {
        await activityService.getRecentActivities({
          userContext: {
            isHOABoardMember: true,
            hoaId: communityA_Id,
            userId: boardMemberUserId,
          },
          communityId: communityB_Id, // Unauthorized mismatch
          limit: 10,
        });
      },
      {
        status: 403,
        message: 'You do not have access to the requested HOA community',
      }
    );
  });
});
