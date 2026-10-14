const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  createQuoteEstimateSchema,
  createInstantQuoteEstimateSchema,
  paginationQuerySchema,
  objectIdParamSchema,
} = require('../../../portals/landlord/modules/insurance/validators/quoteEstimate.validator');
const { OBJECT_ID } = require('../helpers/fixtures');

const instantProperty = {
  property_id: OBJECT_ID,
  address: {
    street_address: '100 Oak St',
    city: 'Austin',
    state: 'TX',
    zip_code: '78701',
    county: 'Travis',
    lat: 30.27,
    lng: -97.74,
  },
  property_details: {
    property_type: 'SINGLE_FAMILY',
    size_sqft: 1800,
    year_built: 1995,
  },
};

describe('insurance quoteEstimate validators', () => {
  describe('createQuoteEstimateSchema', () => {
    test('accepts property with required address', () => {
      const { error } = createQuoteEstimateSchema.validate({
        properties: [{
          property_id: OBJECT_ID,
          address: { street_address: '1 Main', city: 'Austin', state: 'TX' },
        }],
      });
      assert.equal(error, undefined);
    });

    test('requires at least one property', () => {
      const { error } = createQuoteEstimateSchema.validate({ properties: [] });
      assert.ok(error);
    });
  });

  describe('createInstantQuoteEstimateSchema', () => {
    test('accepts single instant estimate property', () => {
      const { error } = createInstantQuoteEstimateSchema.validate({
        properties: [instantProperty],
      });
      assert.equal(error, undefined);
    });

    test('rejects more than one property', () => {
      const { error } = createInstantQuoteEstimateSchema.validate({
        properties: [instantProperty, instantProperty],
      });
      assert.ok(error);
    });

    test('rejects missing required address fields', () => {
      const { error } = createInstantQuoteEstimateSchema.validate({
        properties: [{
          address: { street_address: '100 Oak St' },
          property_details: instantProperty.property_details,
        }],
      });
      assert.ok(error);
    });

    test('rejects invalid property_type', () => {
      const { error } = createInstantQuoteEstimateSchema.validate({
        properties: [{
          ...instantProperty,
          property_details: {
            ...instantProperty.property_details,
            property_type: 'CASTLE',
          },
        }],
      });
      assert.ok(error);
    });
  });

  describe('paginationQuerySchema', () => {
    test('accepts page params', () => {
      const { error, value } = paginationQuerySchema.validate({
        page: 2,
        pageSize: 10,
      });
      assert.equal(error, undefined);
      assert.equal(value.page, 2);
    });
  });

  describe('objectIdParamSchema', () => {
    test('validates quote estimate id', () => {
      const { error } = objectIdParamSchema.validate({ id: OBJECT_ID });
      assert.equal(error, undefined);
    });
  });
});
