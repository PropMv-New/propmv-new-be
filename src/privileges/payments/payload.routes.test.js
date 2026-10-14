'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { lookupRequiredPrivilegesForRoute } = require('../../middleware/apiPrivilegeCheck');
const { PRIVILEGE_EDIT_INCOME } = require('../../common/constants/privileges');

const payloadRoutePrivileges = require('./payload.routes');

describe('payload route privilege map', () => {
  it('maps owner payment method mutate routes for authorize middleware', () => {
    const maps = [payloadRoutePrivileges];
    const deleteRoute = lookupRequiredPrivilegesForRoute(
      'DELETE',
      '/api/v1/payments/payload/payment-methods/:methodId',
      maps,
    );
    const putRoute = lookupRequiredPrivilegesForRoute(
      'PUT',
      '/api/v1/payments/payload/payment-methods/:methodId',
      maps,
    );
    const editInitRoute = lookupRequiredPrivilegesForRoute(
      'POST',
      '/api/v1/payments/payload/payment-methods/initialize-edit',
      maps,
    );

    assert.equal(deleteRoute.found, true);
    assert.equal(putRoute.found, true);
    assert.equal(editInitRoute.found, true);
    assert.deepEqual(deleteRoute.privileges, []);
  });

  it('maps Check21 submit-for-invoice to EDIT_INCOME', () => {
    const maps = [payloadRoutePrivileges];
    const submit = lookupRequiredPrivilegesForRoute(
      'POST',
      '/api/v1/payments/payload/check21/submit-for-invoice',
      maps,
    );

    assert.equal(submit.found, true);
    assert.deepEqual(submit.privileges, [PRIVILEGE_EDIT_INCOME]);
  });
});
