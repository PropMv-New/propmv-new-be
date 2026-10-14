const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  createListingSchema,
  updateListingSchema,
  idParamSchema,
  listListingsQuerySchema,
} = require('../../../portals/landlord/modules/listing/validators/listing.validator');
const { LISTING_STATUS, PAYMENT_FREQUENCY, LEASE_TYPE } = require('../../../common/constants/listing');
const { CREATED_BY, OBJECT_ID, PROPERTY_ID } = require('../helpers/fixtures');

const validCreateListing = {
  propertyId: PROPERTY_ID,
  unitName: 'Unit A',
  listingHeadline: 'Bright 2BR',
  description: 'Spacious apartment',
  rentalAmount: 1500,
  securityDeposit: 1500,
  paymentFrequency: PAYMENT_FREQUENCY.MONTHLY,
  availableDate: '2026-04-01',
  leaseType: LEASE_TYPE.FIXED_TERM,
};

describe('listing validators', () => {
  describe('createListingSchema', () => {
    test('accepts minimal valid payload with unitName', () => {
      const { error, value } = createListingSchema.validate(validCreateListing);
      assert.equal(error, undefined);
      assert.equal(value.status, LISTING_STATUS.DRAFT);
      assert.equal(value.isAcceptingApplications, true);
    });

    test('accepts unitId instead of unitName', () => {
      const { error } = createListingSchema.validate({
        ...validCreateListing,
        unitName: undefined,
        unitId: OBJECT_ID,
      });
      assert.equal(error, undefined);
    });

    test('rejects missing propertyId', () => {
      const { error } = createListingSchema.validate({
        ...validCreateListing,
        propertyId: undefined,
      });
      assert.ok(error);
    });

    test('rejects when neither unitId nor unitName provided', () => {
      const { error } = createListingSchema.validate({
        ...validCreateListing,
        unitName: '',
      });
      assert.ok(error);
    });

    test('rejects invalid payment frequency', () => {
      const { error } = createListingSchema.validate({
        ...validCreateListing,
        paymentFrequency: 'yearly',
      });
      assert.ok(error);
    });
  });

  describe('updateListingSchema', () => {
    test('accepts partial update', () => {
      const { error, value } = updateListingSchema.validate({
        listingHeadline: 'Updated headline',
        rentalAmount: 1600,
      });
      assert.equal(error, undefined);
      assert.equal(value.listingHeadline, 'Updated headline');
    });

    test('accepts status transitions', () => {
      const { error } = updateListingSchema.validate({ status: LISTING_STATUS.ACTIVE });
      assert.equal(error, undefined);
    });
  });

  describe('idParamSchema', () => {
    test('accepts valid object id', () => {
      const { error } = idParamSchema.validate({ id: OBJECT_ID });
      assert.equal(error, undefined);
    });

    test('rejects invalid id', () => {
      const { error } = idParamSchema.validate({ id: 'short' });
      assert.ok(error);
    });
  });

  describe('listListingsQuerySchema', () => {
    test('accepts filter and pagination params', () => {
      const { error, value } = listListingsQuerySchema.validate({
        pageNumber: 1,
        pageSize: 20,
        createdBy: CREATED_BY,
        status: LISTING_STATUS.PUBLISHED,
        minRent: 1000,
        maxRent: 3000,
        sortBy: 'rentalAmount',
        order: 'desc',
      });
      assert.equal(error, undefined);
      assert.equal(value.order, 'desc');
    });
  });
});
