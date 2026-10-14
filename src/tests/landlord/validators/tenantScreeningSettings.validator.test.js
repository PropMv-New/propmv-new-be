const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  createScreeningSettingsSchema,
  updateScreeningSettingsSchema,
  idParamSchema,
  listQuerySchema,
} = require('../../../portals/landlord/modules/tenantScreeningSettings/validators/tenantScreeningSettings.validator');
const { OBJECT_ID, PROPERTY_ID } = require('../helpers/fixtures');

const screeningOption = {
  optionId: 'application_only',
  label: 'Application Only',
  innagoFee: 25,
  additionalFee: 0,
  totalFee: 25,
};

describe('tenantScreeningSettings validators', () => {
  describe('createScreeningSettingsSchema', () => {
    test('accepts valid screening settings', () => {
      const { error, value } = createScreeningSettingsSchema.validate({
        screeningOptions: [screeningOption],
        includeIncomeVerification: true,
      });
      assert.equal(error, undefined);
      assert.equal(value.selectedOption, 'application_only');
    });

    test('requires at least one screening option', () => {
      const { error } = createScreeningSettingsSchema.validate({
        screeningOptions: [],
      });
      assert.ok(error);
    });

    test('rejects invalid selectedOption', () => {
      const { error } = createScreeningSettingsSchema.validate({
        selectedOption: 'invalid',
        screeningOptions: [screeningOption],
      });
      assert.ok(error);
    });

    test('accepts optional property_id', () => {
      const { error } = createScreeningSettingsSchema.validate({
        property_id: PROPERTY_ID,
        screeningOptions: [screeningOption],
      });
      assert.equal(error, undefined);
    });
  });

  describe('updateScreeningSettingsSchema', () => {
    test('accepts partial update', () => {
      const { error } = updateScreeningSettingsSchema.validate({
        includeCriminalHistory: true,
      });
      assert.equal(error, undefined);
    });
  });

  describe('idParamSchema', () => {
    test('validates id param', () => {
      const { error } = idParamSchema.validate({ id: OBJECT_ID });
      assert.equal(error, undefined);
    });
  });

  describe('listQuerySchema', () => {
    test('accepts pagination and property filter', () => {
      const { error, value } = listQuerySchema.validate({
        pageNumber: 1,
        pageSize: 50,
        propertyId: PROPERTY_ID,
      });
      assert.equal(error, undefined);
      assert.equal(value.pageSize, 50);
    });

    test('rejects pageSize above max', () => {
      const { error } = listQuerySchema.validate({ pageSize: 500 });
      assert.ok(error);
    });
  });
});
