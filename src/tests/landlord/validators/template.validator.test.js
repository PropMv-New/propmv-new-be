const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  createdByParamSchema,
  templateIdParamSchema,
  updateParamsSchema,
  createTemplateSchema,
  updateTemplateSchema,
  getTemplatesQuerySchema,
} = require('../../../portals/landlord/modules/leasing/validators/template.validator');
const { CREATED_BY, OBJECT_ID } = require('../helpers/fixtures');

describe('lease template validators', () => {
  describe('createTemplateSchema', () => {
    test('accepts valid template payload', () => {
      const { error, value } = createTemplateSchema.validate({
        templateName: 'Standard Lease',
        description: 'Default template',
        templateType: 'residential',
      });
      assert.equal(error, undefined);
      assert.equal(value.templateName, 'Standard Lease');
    });

    test('requires templateName', () => {
      const { error } = createTemplateSchema.validate({ description: 'No name' });
      assert.ok(error);
    });
  });

  describe('updateTemplateSchema', () => {
    test('accepts partial fields', () => {
      const { error } = updateTemplateSchema.validate({ templateName: 'Updated' });
      assert.equal(error, undefined);
    });
  });

  describe('param schemas', () => {
    test('createdByParamSchema validates object id', () => {
      const { error } = createdByParamSchema.validate({ createdBy: CREATED_BY });
      assert.equal(error, undefined);
    });

    test('templateIdParamSchema validates object id', () => {
      const { error } = templateIdParamSchema.validate({ templateId: OBJECT_ID });
      assert.equal(error, undefined);
    });

    test('updateParamsSchema requires both ids', () => {
      const { error } = updateParamsSchema.validate({
        createdBy: CREATED_BY,
        templateId: OBJECT_ID,
      });
      assert.equal(error, undefined);
    });
  });

  describe('getTemplatesQuerySchema', () => {
    test('applies pagination defaults', () => {
      const { error, value } = getTemplatesQuerySchema.validate({});
      assert.equal(error, undefined);
      assert.equal(value.pageNumber, 1);
      assert.equal(value.pageSize, 10);
    });

    test('accepts template filters', () => {
      const { error, value } = getTemplatesQuerySchema.validate({
        templateName: 'Lease',
        templateType: 'commercial',
        pageSize: 25,
      });
      assert.equal(error, undefined);
      assert.equal(value.pageSize, 25);
    });
  });
});
