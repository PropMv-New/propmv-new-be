const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  idParamSchema,
  listLeasesQuerySchema,
  listByLandlordQuerySchema,
  getLeaseByTenantQuerySchema,
  exportQuerySchema,
  tenureAvailabilityQuerySchema,
  createLeaseSchema,
} = require('../../../portals/landlord/modules/leasing/validators/lease.validator');
const { CREATED_BY, OBJECT_ID, PROPERTY_ID, TENANT_ID } = require('../helpers/fixtures');

describe('lease validators', () => {
  describe('idParamSchema', () => {
    test('accepts valid lease id', () => {
      const { error } = idParamSchema.validate({ id: OBJECT_ID });
      assert.equal(error, undefined);
    });
  });

  describe('listLeasesQuerySchema', () => {
    test('accepts property and pagination filters', () => {
      const { error, value } = listLeasesQuerySchema.validate({
        property_id: PROPERTY_ID,
        pageNumber: 1,
        pageSize: 10,
        status: 'active',
      });
      assert.equal(error, undefined);
      assert.equal(value.property_id, PROPERTY_ID);
    });
  });

  describe('listByLandlordQuerySchema', () => {
    test('accepts createdBy and date range', () => {
      const { error } = listByLandlordQuerySchema.validate({
        createdBy: CREATED_BY,
        from: '2026-01-01',
        to: '2026-12-31',
      });
      assert.equal(error, undefined);
    });
  });

  describe('getLeaseByTenantQuerySchema', () => {
    test('requires tenantId, propertyId, and unit or unitId', () => {
      const { error } = getLeaseByTenantQuerySchema.validate({
        tenantId: TENANT_ID,
        propertyId: PROPERTY_ID,
        unit: 'A',
      });
      assert.equal(error, undefined);
    });

    test('rejects when unit and unitId are both missing', () => {
      const { error } = getLeaseByTenantQuerySchema.validate({
        tenantId: TENANT_ID,
        propertyId: PROPERTY_ID,
      });
      assert.ok(error);
    });
  });

  describe('exportQuerySchema', () => {
    test('accepts export format', () => {
      const { error, value } = exportQuerySchema.validate({
        createdBy: CREATED_BY,
        format: 'csv',
      });
      assert.equal(error, undefined);
      assert.equal(value.format, 'csv');
    });

    test('rejects unsupported format', () => {
      const { error } = exportQuerySchema.validate({ format: 'pdf' });
      assert.ok(error);
    });
  });

  describe('tenureAvailabilityQuerySchema', () => {
    test('accepts fixed term with unitName', () => {
      const { error } = tenureAvailabilityQuerySchema.validate({
        property_id: PROPERTY_ID,
        unitName: 'Unit 1',
        lease_type: 'FixedTerm',
        start_date: '2026-06-01',
        end_date: '2027-05-31',
      });
      assert.equal(error, undefined);
    });

    test('accepts month-to-month without end_date', () => {
      const { error } = tenureAvailabilityQuerySchema.validate({
        property_id: PROPERTY_ID,
        unit_id: OBJECT_ID,
        lease_type: 'MonthToMonth',
        start_date: '2026-06-01',
      });
      assert.equal(error, undefined);
    });

    test('rejects fixed term without end_date', () => {
      const { error } = tenureAvailabilityQuerySchema.validate({
        property_id: PROPERTY_ID,
        unitName: 'Unit 1',
        lease_type: 'FixedTerm',
        start_date: '2026-06-01',
      });
      assert.ok(error);
    });
  });

  describe('createLeaseSchema custom rules', () => {
    test('rejects additionalFees recurring without frequency when not line item', () => {
      const { error } = createLeaseSchema.validate({
        propertyId: PROPERTY_ID,
        unit: 'A',
        leaseType: 'FixedTerm',
        startDate: '2026-06-01',
        endDate: '2027-05-31',
        rentDetails: {
          amount: 1200,
          frequency: 'monthly',
          firstRentalInvoiceDue: '2026-06-01',
          dueOnDate: 1,
        },
        depositDetails: { amount: 1200, dueDate: '2026-06-01' },
        rentAndDepositDestribution: {
          isAllTenantsEquallyResponsible: true,
          isPartialPaymentAllowed: false,
          rentDistributionType: 'equal',
          securityDepositDestributionType: 'equal',
          split: [{
            tenantId: TENANT_ID,
            rentAmount: 1200,
            rentPercentage: 100,
            depositAmount: 1200,
            depositPercentage: 100,
          }],
        },
        additionalFees: {
          items: [],
          totalAmount: 50,
          alreadyPaid: 0,
          balanceAmount: 50,
          isRecurringInvoice: true,
          lineItemOnRentalInvoice: false,
          startDate: '2026-06-01',
          endDate: '2027-05-31',
        },
      });
      assert.ok(error);
    });
  });
});
