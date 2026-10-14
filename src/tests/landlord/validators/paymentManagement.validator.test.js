const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateGetPaymentManagement,
  validateGetPaymentSummary,
  validateAssignLandlord,
  validateUpsertPaymentSettings,
} = require('../../../portals/landlord/modules/payment-management/validators/paymentManagement.validator');
const { CREATED_BY, PROPERTY_ID } = require('../helpers/fixtures');

function runValidator(validator, source, data) {
  const req = { [source]: data };
  let nextCalled = false;
  let thrown = null;
  const next = () => { nextCalled = true; };
  try {
    validator(req, { status() { return this; }, json() {} }, next);
  } catch (err) {
    thrown = err;
  }
  return { req, nextCalled, thrown };
}

describe('paymentManagement validators', () => {
  describe('validateGetPaymentManagement', () => {
    test('passes valid query to next', () => {
      const { req, nextCalled } = runValidator(validateGetPaymentManagement, 'query', {
        pageNumber: 1,
        pagesize: 20,
        search: 'Oak',
        createdBy: CREATED_BY,
      });
      assert.equal(nextCalled, true);
      assert.equal(req.query.pageNumber, 1);
    });

    test('rejects invalid pagesize', () => {
      const { nextCalled, thrown } = runValidator(validateGetPaymentManagement, 'query', {
        pagesize: 500,
      });
      assert.equal(nextCalled, false);
      assert.ok(thrown);
    });
  });

  describe('validateGetPaymentSummary', () => {
    test('accepts createdBy filter', () => {
      const { nextCalled } = runValidator(validateGetPaymentSummary, 'query', {
        createdBy: CREATED_BY,
      });
      assert.equal(nextCalled, true);
    });
  });

  describe('validateAssignLandlord', () => {
    test('requires landlordName', () => {
      const valid = runValidator(validateAssignLandlord, 'body', {
        landlordName: 'John Smith',
        landlordEmail: 'john@example.com',
      });
      assert.equal(valid.nextCalled, true);

      const invalid = runValidator(validateAssignLandlord, 'body', {});
      assert.equal(invalid.nextCalled, false);
      assert.ok(invalid.thrown);
    });

    test('rejects invalid email', () => {
      const { nextCalled, thrown } = runValidator(validateAssignLandlord, 'body', {
        landlordName: 'John',
        landlordEmail: 'bad-email',
      });
      assert.equal(nextCalled, false);
      assert.ok(thrown);
    });
  });

  describe('validateUpsertPaymentSettings', () => {
    test('accepts valid settings payload', () => {
      const { nextCalled, req } = runValidator(validateUpsertPaymentSettings, 'body', {
        propertyId: PROPERTY_ID,
        percentageCut: 8.5,
      });
      assert.equal(nextCalled, true);
      assert.equal(req.body.percentageCut, 8.5);
    });

    test('rejects percentage above 100', () => {
      const { nextCalled, thrown } = runValidator(validateUpsertPaymentSettings, 'body', {
        propertyId: PROPERTY_ID,
        percentageCut: 150,
      });
      assert.equal(nextCalled, false);
      assert.ok(thrown);
    });
  });
});
