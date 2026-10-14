const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');
const { CREATED_BY } = require('../helpers/fixtures');

describe('dashboard.controller getSummary', () => {
  test('returns dashboard summary json', async () => {
    const summaryPayload = { data: { occupancy: { totalUnits: 5 } } };
    const servicePath = require.resolve('../../../portals/landlord/modules/dashboard/service/dashboard.service');
    const controllerPath = require.resolve('../../../portals/landlord/modules/dashboard/controller/dashboard.controller');

    const originalService = require(servicePath);
    require.cache[servicePath] = {
      id: servicePath,
      filename: servicePath,
      loaded: true,
      exports: {
        getDashboardSummary: mock.fn(async () => summaryPayload),
      },
    };
    delete require.cache[controllerPath];
    const controller = require(controllerPath);

    const req = {
      query: { startDate: '2026-01-01', endDate: '2026-01-31', createdBy: CREATED_BY },
      user: { _id: CREATED_BY },
    };
    let responseBody = null;
    const res = {
      json(data) {
        responseBody = data;
        return this;
      },
    };

    await controller.getSummary(req, res, () => {});

    assert.deepEqual(responseBody, summaryPayload);

    require.cache[servicePath] = {
      id: servicePath,
      filename: servicePath,
      loaded: true,
      exports: originalService,
    };
    delete require.cache[controllerPath];
  });

  test('forwards service errors to next', async () => {
    const servicePath = require.resolve('../../../portals/landlord/modules/dashboard/service/dashboard.service');
    const controllerPath = require.resolve('../../../portals/landlord/modules/dashboard/controller/dashboard.controller');
    const originalService = require(servicePath);
    const boom = new Error('DB unavailable');

    require.cache[servicePath] = {
      id: servicePath,
      filename: servicePath,
      loaded: true,
      exports: {
        getDashboardSummary: mock.fn(async () => { throw boom; }),
      },
    };
    delete require.cache[controllerPath];
    const controller = require(controllerPath);

    let forwarded = null;
    await controller.getSummary({ query: {}, user: {} }, { json() {} }, (err) => {
      forwarded = err;
    });

    assert.equal(forwarded, boom);

    require.cache[servicePath] = {
      id: servicePath,
      filename: servicePath,
      loaded: true,
      exports: originalService,
    };
    delete require.cache[controllerPath];
  });
});
