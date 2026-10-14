const { describe, test, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const maintenanceRequestModelPath = require.resolve('../model/maintenanceRequest.model');
const maintenanceServicePath = require.resolve('../service/maintenance.service');
const controllerPath = require.resolve('./maintenance.controller');

const ticketId = '507f1f77bcf86cd799439021';
const vendorAId = '507f1f77bcf86cd799439011';
const vendorBId = '507f1f77bcf86cd799439012';
const boardUserId = '507f1f77bcf86cd799439031';

describe('maintenance.controller assignVendor', () => {
  let originalMaintenanceRequest;
  let originalMaintenanceService;
  let updateMaintenanceRequestMock;
  let findOneMock;

  beforeEach(() => {
    originalMaintenanceRequest = require(maintenanceRequestModelPath);
    originalMaintenanceService = require(maintenanceServicePath);

    updateMaintenanceRequestMock = mock.fn(async () => ({ _id: ticketId, assignedTo: vendorBId }));
    findOneMock = mock.fn(() => ({
      select: () => ({
        lean: async () => ({ assignedTo: vendorAId }),
      }),
    }));

    require.cache[maintenanceRequestModelPath] = {
      id: maintenanceRequestModelPath,
      filename: maintenanceRequestModelPath,
      loaded: true,
      exports: {
        findOne: findOneMock,
      },
    };

    require.cache[maintenanceServicePath] = {
      id: maintenanceServicePath,
      filename: maintenanceServicePath,
      loaded: true,
      exports: {
        ...originalMaintenanceService,
        updateMaintenanceRequest: updateMaintenanceRequestMock,
      },
    };

    delete require.cache[controllerPath];
  });

  afterEach(() => {
    require.cache[maintenanceRequestModelPath] = {
      id: maintenanceRequestModelPath,
      filename: maintenanceRequestModelPath,
      loaded: true,
      exports: originalMaintenanceRequest,
    };
    require.cache[maintenanceServicePath] = {
      id: maintenanceServicePath,
      filename: maintenanceServicePath,
      loaded: true,
      exports: originalMaintenanceService,
    };
    delete require.cache[controllerPath];
  });

  function buildResponse() {
    let statusCode = 200;
    let body = null;
    return {
      res: {
        status(code) {
          statusCode = code;
          return this;
        },
        json(payload) {
          body = payload;
          return this;
        },
      },
      getResult() {
        return { statusCode, body };
      },
    };
  }

  test('rejects assigning the vendor that is already on the ticket', async () => {
    const controller = require(controllerPath);
    const { res, getResult } = buildResponse();

    await controller.assignVendor(
      {
        params: { id: ticketId },
        body: { vendorId: vendorAId },
        headers: {},
        user: { _id: boardUserId, role: { name: 'HOA Board Member' } },
        userId: boardUserId,
        userRoleName: 'HOA Board Member',
        hoaContext: null,
      },
      res
    );

    const { statusCode, body } = getResult();
    assert.equal(statusCode, 400);
    assert.match(body.message, /already assigned/i);
    assert.equal(updateMaintenanceRequestMock.mock.calls.length, 0);
  });

  test('assigns a different vendor to the ticket', async () => {
    const controller = require(controllerPath);
    const { res, getResult } = buildResponse();

    await controller.assignVendor(
      {
        params: { id: ticketId },
        body: { vendorId: vendorBId },
        headers: {},
        user: { _id: boardUserId, role: { name: 'HOA Board Member' } },
        userId: boardUserId,
        userRoleName: 'HOA Board Member',
        hoaContext: null,
      },
      res
    );

    const { statusCode, body } = getResult();
    assert.equal(statusCode, 200);
    assert.match(body.message, /vendor assigned/i);
    assert.equal(updateMaintenanceRequestMock.mock.calls.length, 1);
    assert.equal(findOneMock.mock.calls.length, 1);
  });

  test('assigns a vendor that is not linked to the active HOA', async () => {
    const userModelPath = require.resolve('../../users/models/user.model');
    const companyRoleHelperPath = require.resolve('../../../../common/helpers/companyRoleHelper');
    const originalUser = require.cache[userModelPath];
    const originalHelper = require.cache[companyRoleHelperPath];
    const helperExports = require(companyRoleHelperPath);

    require.cache[userModelPath] = {
      id: userModelPath,
      filename: userModelPath,
      loaded: true,
      exports: {
        findOne: () => ({
          select: () => ({
            lean: async () => ({
              _id: vendorBId,
              companyId: 'company',
              companyRoleId: 'vendor-role',
            }),
          }),
        }),
      },
    };
    require.cache[companyRoleHelperPath] = {
      id: companyRoleHelperPath,
      filename: companyRoleHelperPath,
      loaded: true,
      exports: {
        ...helperExports,
        resolveUserRoleName: async () => 'Vendor',
      },
    };
    delete require.cache[controllerPath];

    try {
      const controller = require(controllerPath);
      const { res, getResult } = buildResponse();

      await controller.assignVendor(
        {
          params: { id: ticketId },
          body: { vendorId: vendorBId },
          headers: {},
          user: { _id: boardUserId, role: { name: 'HOA Board Member' } },
          userId: boardUserId,
          userRoleName: 'HOA Board Member',
          hoaContext: {
            hoaId: '507f1f77bcf86cd799439099',
            userId: boardUserId,
            roleName: 'HOA Board Member',
          },
        },
        res
      );

      const { statusCode, body } = getResult();
      assert.equal(statusCode, 200);
      assert.match(body.message, /vendor assigned/i);
      assert.equal(updateMaintenanceRequestMock.mock.calls.length, 1);
    } finally {
      if (originalUser) require.cache[userModelPath] = originalUser;
      else delete require.cache[userModelPath];
      if (originalHelper) require.cache[companyRoleHelperPath] = originalHelper;
      else delete require.cache[companyRoleHelperPath];
      delete require.cache[controllerPath];
    }
  });
});
