'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const SERVICE_PATH = require.resolve('./vendorInvoice.service');
let restoreLoad = null;

function matchesPath(request, ...needles) {
  const normalized = String(request).replace(/\\/g, '/').toLowerCase();
  return needles.some((needle) => normalized.includes(String(needle).toLowerCase()));
}

function loadServiceWithStubs({
  hoaName = 'Sunrise HOA',
  property = {
    _id: '507f1f77bcf86cd799439077',
    name: 'Oak Street',
    address: { street: '1 Oak' },
    unitDetails: [{ _id: '507f1f77bcf86cd799439066', unitName: '12A' }],
  },
  ticket = {
    property_id: '507f1f77bcf86cd799439077',
    unitId: '507f1f77bcf86cd799439066',
    units: '',
  },
} = {}) {
  if (restoreLoad) restoreLoad();
  delete require.cache[SERVICE_PATH];
  for (const key of Object.keys(require.cache)) {
    const normalized = key.replace(/\\/g, '/').toLowerCase();
    if (
      normalized.includes('/hoa/model/hoa.model')
      || normalized.includes('/property/model/property.model')
      || normalized.includes('maintenancerequest.model')
      || normalized.includes('paymentbankaccount.model')
    ) {
      delete require.cache[key];
    }
  }
  const originalLoad = Module._load;

  Module._load = function patched(request, parent, isMain) {
    if (matchesPath(request, '/hoa/model/hoa.model', 'modules/hoa/model/hoa.model')) {
      return {
        findOne: () => ({
          select: () => ({
            lean: async () => (hoaName ? { name: hoaName } : null),
          }),
        }),
      };
    }
    if (matchesPath(request, '/property/model/property.model', 'modules/property/model/property.model')) {
      return {
        findOne: () => ({
          select: () => ({
            lean: async () => property,
          }),
        }),
      };
    }
    if (matchesPath(request, 'maintenance/model/maintenancerequest.model', 'maintenancerequest.model')) {
      return {
        findOne: () => ({
          select: () => ({
            lean: async () => ticket,
          }),
        }),
      };
    }
    if (matchesPath(request, 'paymentbankaccount.model')) {
      return {
        findOne: () => ({
          sort: () => ({
            select: () => ({
              lean: async () => null,
            }),
          }),
        }),
      };
    }
    if (matchesPath(request, 'common/logger')) {
      return { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    }
    return originalLoad(request, parent, isMain);
  };

  restoreLoad = () => {
    Module._load = originalLoad;
    restoreLoad = null;
  };

  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require('./vendorInvoice.service');
}

describe('vendor invoice assignee display', () => {
  afterEach(() => {
    if (restoreLoad) restoreLoad();
    delete require.cache[SERVICE_PATH];
  });

  it('resolvePersonDisplayName builds board/owner full name', () => {
    const { resolvePersonDisplayName } = loadServiceWithStubs();
    assert.equal(
      resolvePersonDisplayName({ firstName: 'Pat', lastName: 'Board', email: 'pat@example.com' }),
      'Pat Board'
    );
    assert.equal(resolvePersonDisplayName({ email: 'only@example.com' }), 'only@example.com');
    assert.equal(resolvePersonDisplayName('507f1f77bcf86cd799439011'), null);
  });

  it('resolveInvoicePropertyDetails uses assignee person name, not community/property label', async () => {
    const { resolveInvoicePropertyDetails } = loadServiceWithStubs();
    const enriched = await resolveInvoicePropertyDetails({
      _id: '507f1f77bcf86cd799439099',
      hoaId: '507f1f77bcf86cd799439088',
      maintenanceRequestId: '507f1f77bcf86cd799439055',
      vendorId: '507f1f77bcf86cd799439044',
      assignedTo: {
        _id: '507f1f77bcf86cd799439011',
        firstName: 'Alex',
        lastName: 'Owner',
        email: 'alex@example.com',
      },
      activityTimeline: [],
    });

    assert.equal(enriched.assigneeDisplayLabel, 'Alex Owner');
    assert.equal(enriched.communityName, 'Sunrise HOA');
    assert.equal(enriched.propertyName, 'Oak Street');
    assert.equal(enriched.unitName, '12A');
    assert.notEqual(enriched.assigneeDisplayLabel, 'Sunrise HOA');
    assert.notEqual(enriched.assigneeDisplayLabel, 'Oak Street - 12A');
  });

  it('resolveInvoicePropertyDetails still shows person name without a maintenance ticket', async () => {
    const { resolveInvoicePropertyDetails } = loadServiceWithStubs();
    const enriched = await resolveInvoicePropertyDetails({
      _id: '507f1f77bcf86cd799439099',
      hoaId: '507f1f77bcf86cd799439088',
      vendorId: '507f1f77bcf86cd799439044',
      assignedTo: {
        _id: '507f1f77bcf86cd799439012',
        firstName: 'Bo',
        lastName: 'Board',
        email: 'bo@example.com',
      },
      activityTimeline: [],
    });

    assert.equal(enriched.assigneeDisplayLabel, 'Bo Board');
    assert.equal(enriched.communityName, 'Sunrise HOA');
  });
});
