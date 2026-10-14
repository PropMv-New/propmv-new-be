const { describe, test, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const maintenanceRequestModelPath = require.resolve('../model/maintenanceRequest.model');
const maintenanceServicePath = require.resolve('../service/maintenance.service');
const controllerPath = require.resolve('./maintenance.controller');

const ticketId = '507f1f77bcf86cd799439021';
const noteId = '507f1f77bcf86cd799439041';
const vendorAId = '507f1f77bcf86cd799439011';
const vendorBId = '507f1f77bcf86cd799439012';

describe('maintenance.controller maintenance notes', () => {
  let originalMaintenanceRequest;
  let originalMaintenanceService;
  let updateMaintenanceNoteMock;
  let deleteMaintenanceNoteMock;

  beforeEach(() => {
    originalMaintenanceRequest = require(maintenanceRequestModelPath);
    originalMaintenanceService = require(maintenanceServicePath);

    updateMaintenanceNoteMock = mock.fn(async () => ({
      _id: ticketId,
      notes: [{ _id: noteId, author: { _id: vendorAId }, content: 'updated' }],
    }));
    deleteMaintenanceNoteMock = mock.fn(async () => ({
      _id: ticketId,
      notes: [],
    }));

    require.cache[maintenanceServicePath] = {
      id: maintenanceServicePath,
      filename: maintenanceServicePath,
      loaded: true,
      exports: {
        ...originalMaintenanceService,
        updateMaintenanceNote: updateMaintenanceNoteMock,
        deleteMaintenanceNote: deleteMaintenanceNoteMock,
      },
    };

    delete require.cache[controllerPath];
  });

  afterEach(() => {
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

  test('updateNote forwards to service with authenticated user context', async () => {
    const controller = require(controllerPath);
    const { res, getResult } = buildResponse();

    await controller.updateNote(
      {
        params: { id: ticketId, noteId },
        body: { content: 'Updated note' },
        headers: {},
        user: { _id: vendorAId, role: { name: 'Vendor' } },
        userId: vendorAId,
        userRoleName: 'Vendor',
        hoaContext: { isVendor: true, hoaId: '507f1f77bcf86cd799439099', userId: vendorAId },
      },
      res
    );

    const { statusCode, body } = getResult();
    assert.equal(statusCode, 200);
    assert.match(body.message, /updated/i);
    assert.equal(updateMaintenanceNoteMock.mock.calls.length, 1);
    assert.equal(updateMaintenanceNoteMock.mock.calls[0].arguments[2].content, 'Updated note');
  });

  test('deleteNote forwards to service with authenticated user context', async () => {
    const controller = require(controllerPath);
    const { res, getResult } = buildResponse();

    await controller.deleteNote(
      {
        params: { id: ticketId, noteId },
        headers: {},
        user: { _id: vendorAId, role: { name: 'Vendor' } },
        userId: vendorAId,
        userRoleName: 'Vendor',
        hoaContext: { isVendor: true, hoaId: '507f1f77bcf86cd799439099', userId: vendorAId },
      },
      res
    );

    const { statusCode, body } = getResult();
    assert.equal(statusCode, 200);
    assert.match(body.message, /deleted/i);
    assert.equal(deleteMaintenanceNoteMock.mock.calls.length, 1);
  });
});
