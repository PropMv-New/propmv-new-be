const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  createApplicationSchema,
  idParamSchema,
  listQuerySchema,
  exportQuerySchema,
  createBlankApplicationSchema,
  leaseInviteAckSchema,
  requestApplicationSchema,
  submitApplicationWithCreatedBySchema,
} = require('../../../portals/landlord/modules/application/validators/application.validator');
const { CREATED_BY, OBJECT_ID, PROPERTY_ID, TENANT_ID } = require('../helpers/fixtures');

const personalInformation = {
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@example.com',
  birthDate: '1990-01-15',
};

const addressInformation = {
  addressLine1: '123 Main St',
  city: 'Austin',
  state: 'TX',
  zip: '78701',
};

describe('application validators', () => {
  describe('createApplicationSchema', () => {
    test('accepts minimal valid application', () => {
      const { error } = createApplicationSchema.validate({
        propertyId: PROPERTY_ID,
        personalInformation,
        addressInformation,
      });
      assert.equal(error, undefined);
    });

    test('rejects missing propertyId', () => {
      const { error } = createApplicationSchema.validate({
        personalInformation,
        addressInformation,
      });
      assert.ok(error);
    });

    test('rejects invalid applicant email', () => {
      const { error } = createApplicationSchema.validate({
        propertyId: PROPERTY_ID,
        personalInformation: { ...personalInformation, email: 'not-email' },
        addressInformation,
      });
      assert.ok(error);
    });
  });

  describe('listQuerySchema', () => {
    test('accepts status and pagination filters', () => {
      const { error, value } = listQuerySchema.validate({
        createdBy: CREATED_BY,
        propertyId: PROPERTY_ID,
        status: 'pending',
        pageNumber: 1,
        pageSize: 20,
        applicantName: 'Jane',
      });
      assert.equal(error, undefined);
      assert.equal(value.status, 'pending');
    });

    test('rejects invalid status', () => {
      const { error } = listQuerySchema.validate({ status: 'unknown' });
      assert.ok(error);
    });
  });

  describe('exportQuerySchema', () => {
    test('accepts csv export', () => {
      const { error } = exportQuerySchema.validate({
        createdBy: CREATED_BY,
        format: 'csv',
      });
      assert.equal(error, undefined);
    });
  });

  describe('createBlankApplicationSchema', () => {
    test('requires tenantId', () => {
      const { error } = createBlankApplicationSchema.validate({ tenantId: TENANT_ID });
      assert.equal(error, undefined);
    });
  });

  describe('leaseInviteAckSchema', () => {
    test('requires leaseId and tenantId', () => {
      const { error } = leaseInviteAckSchema.validate({
        leaseId: OBJECT_ID,
        tenantId: TENANT_ID,
      });
      assert.equal(error, undefined);
    });
  });

  describe('requestApplicationSchema', () => {
    test('accepts screening request email', () => {
      const { error, value } = requestApplicationSchema.validate({
        email: 'prospect@example.com',
        screening: ['application', 'credit'],
        propertyName: 'Oak Apartments',
      });
      assert.equal(error, undefined);
      assert.deepEqual(value.screening, ['application', 'credit']);
    });
  });

  describe('submitApplicationWithCreatedBySchema', () => {
    test('requires createdBy and personal info', () => {
      const { error } = submitApplicationWithCreatedBySchema.validate({
        createdBy: CREATED_BY,
        personalInformation,
        addressInformation,
      });
      assert.equal(error, undefined);
    });
  });

  describe('idParamSchema', () => {
    test('validates application id', () => {
      const { error } = idParamSchema.validate({ id: OBJECT_ID });
      assert.equal(error, undefined);
    });
  });
});
