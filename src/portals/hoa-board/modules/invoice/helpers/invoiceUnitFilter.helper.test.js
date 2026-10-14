const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveInvoiceUnitLabelFromProperty,
  resolveInvoiceUnitNumber,
  collectUnitFilterAliases,
  buildUnitMongoFilter,
} = require('./invoiceUnitFilter.helper');

describe('invoiceUnitFilter.helper', () => {
  const property = {
    unitDetails: [
      { _id: '6a7ad92bed72fa344f259966', unitName: '3343' },
    ],
  };

  it('resolves unitDetails id to unit name', () => {
    assert.equal(
      resolveInvoiceUnitLabelFromProperty(property, '6a7ad92bed72fa344f259966'),
      '3343',
    );
  });

  it('keeps unit name refs as unit name', () => {
    assert.equal(resolveInvoiceUnitLabelFromProperty(property, '3343'), '3343');
  });

  it('uses the live unit name when the stored snapshot is stale', () => {
    assert.equal(
      resolveInvoiceUnitLabelFromProperty(property, '101'),
      '3343',
    );
  });

  it('resolves invoice unitNumber from a populated property after rename', () => {
    assert.equal(
      resolveInvoiceUnitNumber({
        unit: '101',
        propertyId: property,
      }),
      '3343',
    );
  });

  it('falls back to the stored unit when no property is populated', () => {
    assert.equal(resolveInvoiceUnitNumber({ unit: '101' }), '101');
  });

  it('collects name + id aliases for list filters', () => {
    const aliases = collectUnitFilterAliases('3343', [property]);
    assert.deepEqual(aliases.sort(), ['3343', '6a7ad92bed72fa344f259966'].sort());
  });

  it('collects aliases when filter is the unitDetails id', () => {
    const aliases = collectUnitFilterAliases('6a7ad92bed72fa344f259966', [property]);
    assert.deepEqual(aliases.sort(), ['3343', '6a7ad92bed72fa344f259966'].sort());
  });

  it('builds case-insensitive regex for a single alias', () => {
    const filter = buildUnitMongoFilter(['3343']);
    assert.equal(filter.$options, 'i');
    assert.equal(filter.$regex, '^3343$');
  });

  it('builds $in for multiple aliases', () => {
    assert.deepEqual(
      buildUnitMongoFilter(['3343', '6a7ad92bed72fa344f259966']),
      { $in: ['3343', '6a7ad92bed72fa344f259966'] },
    );
  });
});
