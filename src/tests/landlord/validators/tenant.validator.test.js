const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  createTenantSchema,
  listTenantsQuerySchema,
  resendInviteSchema,
  idParamSchema,
  tenantDetailsQuerySchema,
} = require('../../../portals/landlord/modules/tenants/validators/tenant.validator');
const { CREATED_BY, OBJECT_ID, TENANT_ID, PROPERTY_ID } = require('../helpers/fixtures');

const MOCK_PASSWORD = 'MockPass123!';

describe('tenant validators', () => {
  describe('createTenantSchema', () => {
    test('accepts valid tenant payload', () => {
      const { error } = createTenantSchema.validate({
        email: 'tenant@example.com',
        password: MOCK_PASSWORD,
        phone: '+15551234567',
        firstName: 'Alex',
        lastName: 'Rivera',
        address: '10 Oak St',
        state: 'TX',
        zipCode: '78701',
        createdBy: CREATED_BY,
      });
      assert.equal(error, undefined);
    });

    test('rejects invalid zip code', () => {
      const { error } = createTenantSchema.validate({
        email: 'tenant@example.com',
        password: MOCK_PASSWORD,
        phone: '+15551234567',
        firstName: 'Alex',
        lastName: 'Rivera',
        address: '10 Oak St',
        state: 'TX',
        zipCode: '7870',
      });
      assert.ok(error);
    });

    test('rejects invalid email', () => {
      const { error } = createTenantSchema.validate({
        email: 'not-an-email',
        password: MOCK_PASSWORD,
        phone: '+15551234567',
        firstName: 'Alex',
        lastName: 'Rivera',
        address: '10 Oak St',
        state: 'TX',
        zipCode: '78701',
      });
      assert.ok(error);
    });
  });

  describe('listTenantsQuerySchema', () => {
    test('accepts pagination and archive flag', () => {
      const { error, value } = listTenantsQuerySchema.validate({
        createdBy: CREATED_BY,
        pageNumber: 1,
        pageSize: 25,
        text: 'alex',
        includeArchived: true,
        format: 'csv',
      });
      assert.equal(error, undefined);
      assert.equal(value.includeArchived, true);
    });
  });

  describe('resendInviteSchema', () => {
    test('requires tenantId and propertyId', () => {
      const { error } = resendInviteSchema.validate({
        tenantId: TENANT_ID,
        propertyId: PROPERTY_ID,
      });
      assert.equal(error, undefined);
    });
  });

  describe('idParamSchema', () => {
    test('validates tenant id param', () => {
      const { error } = idParamSchema.validate({ id: OBJECT_ID });
      assert.equal(error, undefined);
    });
  });

  describe('tenantDetailsQuerySchema', () => {
    test('accepts tenant lookup query', () => {
      const { error } = tenantDetailsQuerySchema.validate({
        tenantId: TENANT_ID,
        leaseId: OBJECT_ID,
        createdBy: CREATED_BY,
      });
      assert.equal(error, undefined);
    });
  });
});
