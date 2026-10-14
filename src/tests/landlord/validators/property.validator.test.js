const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  idParamSchema,
  checkPropertyNameQuerySchema,
  importQuerySchema,
  updatePropertyQuerySchema,
} = require('../../../portals/landlord/modules/property/validators/property.validator');
const { CREATED_BY, OBJECT_ID } = require('../helpers/fixtures');

describe('property validators (extended)', () => {
  describe('idParamSchema', () => {
    test('accepts valid property id', () => {
      const { error } = idParamSchema.validate({ id: OBJECT_ID });
      assert.equal(error, undefined);
    });
  });

  describe('checkPropertyNameQuerySchema', () => {
    test('accepts valid property name', () => {
      const { error, value } = checkPropertyNameQuerySchema.validate({
        name: "O'Brien Apartments",
      });
      assert.equal(error, undefined);
      assert.equal(value.name, "O'Brien Apartments");
    });

    test('rejects empty name', () => {
      const { error } = checkPropertyNameQuerySchema.validate({ name: '' });
      assert.ok(error);
    });

    test('rejects special characters in name', () => {
      const { error } = checkPropertyNameQuerySchema.validate({ name: 'Bad@Name' });
      assert.ok(error);
    });

    test('accepts excludePropertyId', () => {
      const { error } = checkPropertyNameQuerySchema.validate({
        name: 'Oak Place',
        excludePropertyId: OBJECT_ID,
      });
      assert.equal(error, undefined);
    });
  });

  describe('importQuerySchema', () => {
    test('accepts empty import query', () => {
      const { error } = importQuerySchema.validate({});
      assert.equal(error, undefined);
    });
  });

  describe('updatePropertyQuerySchema', () => {
    test('requires propertyId on update query', () => {
      const { error } = updatePropertyQuerySchema.validate({ propertyId: OBJECT_ID });
      assert.equal(error, undefined);
    });
  });
});
