const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseCSV,
  validateRow,
  transformRowToUnit,
} = require('../services/unitImportExport.service');

describe('unit import/export helpers', () => {
  it('parses quoted CSV fields that contain commas', () => {
    const content = [
      'propertyName,title,address[line1],address[city],address[state],address[zipCode],depositBankAccountId',
      '"Sunset, Villa","Unit 101","123 Main, Apt 4",Los Angeles,CA,90001,507f1f77bcf86cd799439011',
    ].join('\n');

    const { rows } = parseCSV(content);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].propertyName, 'Sunset, Villa');
    assert.equal(rows[0]['address[line1]'], '123 Main, Apt 4');
  });

  it('allows missing depositBankAccountId when a default bank is provided', () => {
    const errors = validateRow({
      propertyName: 'A',
      title: 'B',
      'address[line1]': '1 St',
      'address[city]': 'City',
      'address[state]': 'CA',
      'address[zipCode]': '90001',
    }, 2, { defaultDepositBankAccountId: '507f1f77bcf86cd799439011' });
    assert.equal(errors.length, 0);
  });

  it('rejects bank IDs outside the allowed HOA list', () => {
    const errors = validateRow({
      propertyName: 'A',
      title: 'B',
      'address[line1]': '1 St',
      'address[city]': 'City',
      'address[state]': 'CA',
      'address[zipCode]': '90001',
      depositBankAccountId: '507f1f77bcf86cd799439099',
    }, 3, {
      allowedDepositBankAccountIds: ['507f1f77bcf86cd799439011'],
    });
    assert.ok(errors.some((msg) => msg.includes('not one of this HOA')));
  });

  it('applies default bank and sanitizes formula-like cells', () => {
    const unit = transformRowToUnit({
      propertyName: '=Sunset Villa',
      title: 'Unit 101',
      description: '',
      startingBalance: '0',
      balanceAsOf: '2026-01-01',
      monthlyRecurringFee: '100',
      paymentTerm: '12',
      depositBankAccountId: '',
      'address[line1]': '123 Main St',
      'address[city]': 'Los Angeles',
      'address[state]': 'CA',
      'address[zipCode]': '90001',
    }, '507f1f77bcf86cd799439012', { hoaId: '507f1f77bcf86cd799439013' }, {
      defaultDepositBankAccountId: '507f1f77bcf86cd799439011',
    });

    assert.equal(unit.propertyName, 'Sunset Villa');
    assert.equal(String(unit.hoaId), '507f1f77bcf86cd799439013');
    assert.equal(unit.depositBankAccountId, '507f1f77bcf86cd799439011');
  });
});
