const { describe, test, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { PORTAL_ONBOARDING_STATUS } = require('../../../../../common/constants/portalOnboarding');
const { USER_STATUSES } = require('../../../../../common/constants/user');
const { INVOICE_STATUS } = require('../../../../../common/constants/invoice');

const helperPath = require.resolve('../helpers/ownerListFilters.helper');
const propertyModelPath = require.resolve('../../property/model/property.model');
const invoiceModelPath = require.resolve('../../invoice/model/invoice.model');
const invoiceServicePath = require.resolve('../../invoice/service/invoice.service');

const PROPERTY_ID = '507f1f77bcf86cd799439011';
const UNIT_ID = '507f1f77bcf86cd799439012';
const OWNER_ID = '507f1f77bcf86cd799439013';

describe('ownerListFilters.helper', () => {
  let helper;
  let Property;
  let Invoice;
  let originalPropertyModule;
  let originalInvoiceModule;
  let originalInvoiceServiceModule;

  beforeEach(() => {
    delete require.cache[helperPath];

    originalPropertyModule = require(propertyModelPath);
    Property = {
      findById: mock.fn(async () => null),
      find: mock.fn(async () => []),
    };
    require.cache[propertyModelPath] = { exports: Property };

    originalInvoiceModule = require(invoiceModelPath);
    Invoice = {
      find: mock.fn(() => ({
        select: () => ({
          lean: async () => [],
        }),
      })),
    };
    require.cache[invoiceModelPath] = { exports: Invoice };

    originalInvoiceServiceModule = require(invoiceServicePath);
    require.cache[invoiceServicePath] = {
      exports: {
        getEffectiveInvoiceStatus: (invoice) => invoice.status,
      },
    };

    helper = require('../helpers/ownerListFilters.helper');
  });

  afterEach(() => {
    require.cache[propertyModelPath] = originalPropertyModule;
    require.cache[invoiceModelPath] = originalInvoiceModule;
    require.cache[invoiceServicePath] = originalInvoiceServiceModule;
    delete require.cache[helperPath];
  });

  test('mapOwnerAccountStatusFilters maps Verified to portal active status', () => {
    const mapped = helper.mapOwnerAccountStatusFilters(['Verified']);
    assert.deepEqual(mapped.portalStatuses, [PORTAL_ONBOARDING_STATUS.ACTIVE]);
    assert.deepEqual(mapped.userStatuses, []);
  });

  test('mapOwnerAccountStatusFilters maps invitation sent and invited portal statuses', () => {
    const mapped = helper.mapOwnerAccountStatusFilters(['Invitation Sent']);
    assert.deepEqual(mapped.portalStatuses, [
      PORTAL_ONBOARDING_STATUS.INVITATION_SENT,
      'invited',
    ]);
  });

  test('buildOwnerAccountStatusFilter builds portal and user status query', () => {
    const filter = helper.buildOwnerAccountStatusFilter('Verified,Active');
    assert.ok(filter.$or);
    assert.equal(filter.$or.length, 2);
    assert.deepEqual(filter.$or[0], {
      portalOnboardingStatus: { $in: [PORTAL_ONBOARDING_STATUS.ACTIVE] },
    });
    assert.deepEqual(filter.$or[1], {
      status: { $in: [USER_STATUSES.ACTIVE] },
    });
  });

  test('buildOwnerStatusFilter supports Active and Inactive selections', () => {
    const filter = helper.buildOwnerStatusFilter('Active,Inactive');
    assert.ok(filter.$or);
    assert.equal(filter.$or.length, 2);
    assert.deepEqual(filter.$or[0], {
      status: USER_STATUSES.ACTIVE,
      isArchived: { $ne: true },
    });
  });

  test('mapInvoiceToOwnerPaymentStatus maps paid, overdue, and due buckets', () => {
    const getStatus = (invoice) => invoice.status;
    assert.equal(
      helper.mapInvoiceToOwnerPaymentStatus({ status: INVOICE_STATUS.PAID }, getStatus),
      'Paid',
    );
    assert.equal(
      helper.mapInvoiceToOwnerPaymentStatus({ status: INVOICE_STATUS.OVERDUE }, getStatus),
      'Overdue',
    );
    assert.equal(
      helper.mapInvoiceToOwnerPaymentStatus({ status: INVOICE_STATUS.PENDING }, getStatus),
      'Due',
    );
  });

  test('findOwnerIdsByPaymentStatuses returns owner ids for selected payment statuses', async () => {
    Invoice.find = mock.fn(() => ({
      select: () => ({
        lean: async () => [
          { tenants: [OWNER_ID], status: INVOICE_STATUS.OVERDUE },
          { tenants: ['507f1f77bcf86cd799439099'], status: INVOICE_STATUS.PAID },
        ],
      }),
    }));

    const ownerIds = await helper.findOwnerIdsByPaymentStatuses(['Overdue'], null);
    assert.deepEqual(ownerIds, [OWNER_ID]);
  });

  test('resolveOwnerPropertyScopeIds returns unit id when only unitId is provided', async () => {
    const scoped = await helper.resolveOwnerPropertyScopeIds({
      unitId: UNIT_ID,
    });
    assert.deepEqual(scoped, [UNIT_ID]);
  });

  test('resolveOwnerPropertyScopeIds resolves property and unit name to scoped property ids', async () => {
    Property.findById = mock.fn(() => ({
      select: () => ({
        lean: async () => ({
          _id: PROPERTY_ID,
          landlord_id: 'landlord-1',
          unitDetails: [{ _id: UNIT_ID, unitName: 'Unit 101' }],
          name: 'Test Property',
        }),
      }),
    }));
    Property.find = mock.fn(() => ({
      select: () => ({
        lean: async () => [{ _id: UNIT_ID }],
      }),
    }));

    const scoped = await helper.resolveOwnerPropertyScopeIds({
      propertyId: PROPERTY_ID,
      unitName: 'Unit 101',
    });

    assert.deepEqual(scoped, [UNIT_ID]);
    assert.equal(Property.find.mock.calls.length, 1);
  });

  test('resolveOwnerPropertyScopeIds returns null when no scope inputs are provided', async () => {
    const scoped = await helper.resolveOwnerPropertyScopeIds({});
    assert.equal(scoped, null);
  });

  test('collectAssignedOwnerIdsFromUnits unions timeline owners and associatedOwnerIds', () => {
    const owner1 = '507f1f77bcf86cd799439021';
    const owner2 = '507f1f77bcf86cd799439022';
    const owner3 = '507f1f77bcf86cd799439023';
    const ids = helper.collectAssignedOwnerIdsFromUnits(
      [{
        associatedOwnerIds: [owner1, owner2, { _id: owner3 }],
        ownershipRecords: [{ ownerId: owner1 }, { ownerId: owner2 }],
      }],
      (unit) => (unit.ownershipRecords || []).map((row) => row.ownerId),
    );

    assert.deepEqual(ids.sort(), [owner1, owner2, owner3].sort());
  });

  test('collectAssignedOwnerIdsFromUnits keeps all associated owners when timeline is sparse', () => {
    const owner1 = '507f1f77bcf86cd799439031';
    const owner2 = '507f1f77bcf86cd799439032';
    const owner3 = '507f1f77bcf86cd799439033';
    const ids = helper.collectAssignedOwnerIdsFromUnits(
      [{ associatedOwnerIds: [owner1, owner2, owner3] }],
      () => [owner1, owner2],
    );

    assert.equal(ids.length, 3);
    assert.ok(ids.includes(owner3));
  });

  test('resolveOwnerPickerPropertyIds uses the property document id, not embedded unitDetails id', async () => {
    Property.findById = mock.fn((id) => ({
      select: () => ({
        lean: async () => (String(id) === PROPERTY_ID ? { _id: PROPERTY_ID } : null),
      }),
    }));
    Property.findOne = mock.fn(() => ({
      select: () => ({
        lean: async () => null,
      }),
    }));

    const scoped = await helper.resolveOwnerPickerPropertyIds({
      propertyId: PROPERTY_ID,
      unitId: UNIT_ID,
      unitName: 'Unit 101',
    });

    assert.deepEqual(scoped, [PROPERTY_ID]);
    assert.equal(Property.find.mock.calls.length, 0);
  });

  test('resolveOwnerPickerPropertyIds finds the property by embedded unitDetails id', async () => {
    Property.findById = mock.fn(() => ({
      select: () => ({
        lean: async () => null,
      }),
    }));
    Property.findOne = mock.fn(() => ({
      select: () => ({
        lean: async () => ({ _id: PROPERTY_ID }),
      }),
    }));

    const scoped = await helper.resolveOwnerPickerPropertyIds({
      unitId: UNIT_ID,
    });

    assert.deepEqual(scoped, [PROPERTY_ID]);
    assert.equal(Property.findOne.mock.calls.length, 1);
  });
});
