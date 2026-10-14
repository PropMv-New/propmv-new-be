const { test, describe, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const HOAMembership = require('../portals/hoa-board/modules/hoa/model/hoaMembership.model');
const User = require('../shared/modules/users/models/user.model');
const Property = require('../portals/hoa-board/modules/property/model/property.model');
const { buildHoaOwnerUserFilter, userCanAccessHoaCommunity } = require('./hoaDataIsolation');

const HOA_ID = '6a7ca55e69c2d54fc9796cc4';
const BOARD_USER_ID = '507f1f77bcf86cd799439011';
const OWNER_USER_ID = '507f1f77bcf86cd799439012';

function leanFindOne(doc) {
  return { select: () => ({ lean: async () => doc }) };
}

function leanFindById(doc) {
  return { select: () => ({ lean: async () => doc }) };
}

describe('buildHoaOwnerUserFilter', () => {
  test('scopes owners to HOA context', () => {
    const filter = buildHoaOwnerUserFilter({
      hoaId: 'hoa123',
      userId: 'user1',
      hoaMemberUserIds: ['user1', 'user2'],
      propertyIds: ['prop1', 'prop2'],
    });

    assert.ok(filter.$or);
    assert.deepEqual(filter.$or[0], { 'hoaInfo.hoaId': { $in: ['hoa123'] } });
    assert.equal(filter.$or[1].propertyIds.$in.length, 2);
    assert.equal(filter.$or.some((c) => c.hoaBoardMemberId), false);
  });

  test('does not match owners by board member id alone', () => {
    const filter = buildHoaOwnerUserFilter({
      hoaId: 'hoa123',
      userId: 'user1',
      hoaMemberUserIds: ['user1', 'user2'],
      propertyIds: [],
    });

    assert.deepEqual(filter, { $or: [{ 'hoaInfo.hoaId': { $in: ['hoa123'] } }] });
  });

  test('returns null without hoaId', () => {
    assert.equal(buildHoaOwnerUserFilter({ userId: 'user1' }), null);
  });
});

describe('userCanAccessHoaCommunity', () => {
  afterEach(() => mock.restoreAll());

  test('allows an active board member with HOA membership', async () => {
    mock.method(HOAMembership, 'findOne', () => leanFindOne({ _id: 'membership-1' }));
    assert.equal(await userCanAccessHoaCommunity(BOARD_USER_ID, HOA_ID), true);
  });

  test('allows an owner linked to the same community via hoaInfo without membership', async () => {
    mock.method(HOAMembership, 'findOne', () => leanFindOne(null));
    mock.method(User, 'findById', () => leanFindById({
      _id: OWNER_USER_ID,
      hoaInfo: { hoaId: HOA_ID },
      propertyIds: [],
      associatedHoaIds: [],
    }));
    assert.equal(await userCanAccessHoaCommunity(OWNER_USER_ID, HOA_ID), true);
  });

  test('allows an owner linked via unit associatedOwnerIds', async () => {
    mock.method(HOAMembership, 'findOne', () => leanFindOne(null));
    mock.method(User, 'findById', () => leanFindById({
      _id: OWNER_USER_ID,
      hoaInfo: {},
      propertyIds: [],
      associatedHoaIds: [],
    }));
    mock.method(Property, 'exists', async (query) => {
      if (query.associatedOwnerIds) return { _id: 'unit-1' };
      return null;
    });
    assert.equal(await userCanAccessHoaCommunity(OWNER_USER_ID, HOA_ID), true);
  });

  test('denies a user with no membership and no owner or vendor link', async () => {
    mock.method(HOAMembership, 'findOne', () => leanFindOne(null));
    mock.method(User, 'findById', () => leanFindById({
      _id: OWNER_USER_ID,
      hoaInfo: {},
      propertyIds: [],
      associatedHoaIds: [],
    }));
    mock.method(Property, 'exists', async () => null);
    assert.equal(await userCanAccessHoaCommunity(OWNER_USER_ID, HOA_ID), false);
  });
});

describe('verifyHOAResourceAccess community isolation (#301)', () => {
  const { verifyHOAResourceAccess } = require('./hoaDataIsolation');
  const Invoice = require('../portals/hoa-board/modules/invoice/model/invoice.model');
  const Expense = require('../portals/hoa-board/modules/expense/model/expense.model');
  const MaintenanceRequest = require('../shared/modules/maintenance/model/maintenanceRequest.model');
  const HOADocument = require('../shared/modules/documents/model/hoaDocument.model');

  const COMMUNITY_A = '6a9a78d29eae8e5db4c7057b';
  const COMMUNITY_B = '6a971d3514857c9f8df9a8ff';

  const PROP_A_ID = '507f1f77bcf86cd799439021';
  const PROP_B_ID = '507f1f77bcf86cd799439022';
  const OWNER_A_ID = '507f1f77bcf86cd799439023';
  const OWNER_MULTI_ID = '507f1f77bcf86cd799439024';
  const INV_A_ID = '507f1f77bcf86cd799439025';
  const EXP_A_ID = '507f1f77bcf86cd799439026';
  const MAINT_A_ID = '507f1f77bcf86cd799439027';
  const DOC_A_ID = '507f1f77bcf86cd799439028';

  const hoaContextB = {
    userId: BOARD_USER_ID,
    hoaId: COMMUNITY_B,
    hoaMemberUserIds: [BOARD_USER_ID],
    propertyIds: [PROP_B_ID],
    isHOABoardMember: true,
  };

  afterEach(() => mock.restoreAll());

  test('Property: rejects Community A property when Community B is active', async () => {
    mock.method(Property, 'findById', () => ({
      lean: async () => ({
        _id: PROP_A_ID,
        hoaId: COMMUNITY_A,
        createdBy: BOARD_USER_ID,
        landlord_id: BOARD_USER_ID,
      }),
    }));

    const allowed = await verifyHOAResourceAccess(BOARD_USER_ID, PROP_A_ID, `/api/v1/properties/${PROP_A_ID}`, hoaContextB);
    assert.equal(allowed, false, 'Community A property must be rejected under Community B context');
  });

  test('Property: allows Community B property when Community B is active', async () => {
    mock.method(Property, 'findById', () => ({
      lean: async () => ({
        _id: PROP_B_ID,
        hoaId: COMMUNITY_B,
        createdBy: BOARD_USER_ID,
      }),
    }));

    const allowed = await verifyHOAResourceAccess(BOARD_USER_ID, PROP_B_ID, `/api/v1/properties/${PROP_B_ID}`, hoaContextB);
    assert.equal(allowed, true, 'Community B property must be allowed under Community B context');
  });

  test('Unit: rejects Community A unit accessed via /units/ route when Community B is active', async () => {
    mock.method(Property, 'findById', () => ({
      lean: async () => ({
        _id: PROP_A_ID,
        hoaId: COMMUNITY_A,
        createdBy: BOARD_USER_ID,
      }),
    }));

    const allowed = await verifyHOAResourceAccess(BOARD_USER_ID, PROP_A_ID, `/api/v1/owners/units/${PROP_A_ID}`, hoaContextB);
    assert.equal(allowed, false, 'Community A unit must be rejected under Community B context');
  });

  test('Owner: rejects Community A owner without Community B units', async () => {
    mock.method(User, 'findById', () => ({
      lean: async () => ({
        _id: OWNER_A_ID,
        hoaInfo: { hoaId: COMMUNITY_A },
        propertyIds: [PROP_A_ID],
      }),
    }));

    const allowed = await verifyHOAResourceAccess(BOARD_USER_ID, OWNER_A_ID, `/api/v1/owners/${OWNER_A_ID}`, hoaContextB);
    assert.equal(allowed, false, 'Community A owner must be rejected under Community B context');
  });

  test('Owner: allows multi-community owner who has units in Community B', async () => {
    mock.method(User, 'findById', () => ({
      lean: async () => ({
        _id: OWNER_MULTI_ID,
        hoaInfo: { hoaId: COMMUNITY_A },
        propertyIds: [PROP_A_ID, PROP_B_ID],
      }),
    }));

    const allowed = await verifyHOAResourceAccess(BOARD_USER_ID, OWNER_MULTI_ID, `/api/v1/owners/${OWNER_MULTI_ID}`, hoaContextB);
    assert.equal(allowed, true, 'Multi-community owner with Community B units must be allowed');
  });

  test('Invoice: rejects Community A invoice even when created by same board member', async () => {
    mock.method(Invoice, 'findById', () => ({
      lean: async () => ({
        _id: INV_A_ID,
        hoaId: COMMUNITY_A,
        createdBy: BOARD_USER_ID,
      }),
    }));

    const allowed = await verifyHOAResourceAccess(BOARD_USER_ID, INV_A_ID, `/api/v1/invoices/${INV_A_ID}`, hoaContextB);
    assert.equal(allowed, false, 'Community A invoice must be rejected under Community B context');
  });

  test('Expense: rejects Community A expense even when created by same board member', async () => {
    mock.method(Expense, 'findById', () => ({
      lean: async () => ({
        _id: EXP_A_ID,
        hoaId: COMMUNITY_A,
        createdBy: BOARD_USER_ID,
        hoaBoardMemberId: BOARD_USER_ID,
      }),
    }));

    const allowed = await verifyHOAResourceAccess(BOARD_USER_ID, EXP_A_ID, `/api/v1/expenses/${EXP_A_ID}`, hoaContextB);
    assert.equal(allowed, false, 'Community A expense must be rejected under Community B context');
  });

  test('Maintenance: rejects Community A maintenance request under Community B context', async () => {
    mock.method(MaintenanceRequest, 'findById', () => ({
      lean: async () => ({
        _id: MAINT_A_ID,
        hoaId: COMMUNITY_A,
        property_id: PROP_A_ID,
      }),
    }));

    const allowed = await verifyHOAResourceAccess(BOARD_USER_ID, MAINT_A_ID, `/api/v1/maintenance/${MAINT_A_ID}`, hoaContextB);
    assert.equal(allowed, false, 'Community A maintenance must be rejected under Community B context');
  });

  test('Document: rejects Community A document under Community B context', async () => {
    mock.method(HOADocument, 'findById', () => ({
      lean: async () => ({
        _id: DOC_A_ID,
        hoaId: COMMUNITY_A,
        name: 'Community A Bylaws.pdf',
      }),
    }));

    const allowed = await verifyHOAResourceAccess(BOARD_USER_ID, DOC_A_ID, `/api/v1/documents/${DOC_A_ID}`, hoaContextB);
    assert.equal(allowed, false, 'Community A document must be rejected under Community B context');
  });
});
