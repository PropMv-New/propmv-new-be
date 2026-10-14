const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  moneyAmount,
  moneyAmountOptional,
  signedMoneyAmount,
  quantityAmount,
  containsScientificNotation,
  roundMoney,
} = require('../common/validators/money.schema');

describe('money.schema', () => {
  describe('containsScientificNotation', () => {
    test('detects scientific notation in strings', () => {
      assert.equal(containsScientificNotation('55435e'), true);
      assert.equal(containsScientificNotation('1e5'), true);
      assert.equal(containsScientificNotation('0000e'), true);
      assert.equal(containsScientificNotation('100'), false);
    });
  });

  describe('roundMoney', () => {
    test('rounds to two decimal places', () => {
      assert.equal(roundMoney(100.505), 100.51);
      assert.equal(roundMoney(100.5), 100.5);
    });
  });

  describe('moneyAmount', () => {
    const schema = moneyAmount({ min: 0 });

    test('accepts valid monetary values', () => {
      for (const value of [100, 100.5, '100', '100.50', '0', '0.50']) {
        const { error, value: parsed } = schema.validate(value);
        assert.equal(error, undefined, `expected ${value} to be valid`);
        assert.ok(typeof parsed === 'number');
      }
    });

    test('rejects scientific notation strings', () => {
      for (const value of ['55435e', '2321321e', '0000e', '12e', '1e5']) {
        const { error } = schema.validate(value);
        assert.ok(error, `expected ${value} to be rejected`);
        assert.match(error.message, /scientific notation/i);
      }
    });

    test('rejects leading-zero amounts', () => {
      for (const value of ['0100', '000100', '0000']) {
        const { error } = schema.validate(value);
        assert.ok(error, `expected ${value} to be rejected`);
      }
    });

    test('rejects more than two decimal places as strings', () => {
      const { error } = schema.validate('100.999');
      assert.ok(error);
    });

    test('rejects more than two decimal places as numbers', () => {
      const { error } = schema.validate(100.999);
      assert.ok(error);
    });
  });

  describe('moneyAmount positive', () => {
    const schema = moneyAmount({ min: 0.01, positive: true });

    test('accepts positive payment amounts', () => {
      const { error, value } = schema.validate('50.25');
      assert.equal(error, undefined);
      assert.equal(value, 50.25);
    });

    test('rejects zero', () => {
      const { error } = schema.validate(0);
      assert.ok(error);
    });
  });

  describe('signedMoneyAmount', () => {
    const schema = signedMoneyAmount({ min: -5000, max: 1000000 });

    test('accepts negative credits', () => {
      const { error, value } = schema.validate('-5000');
      assert.equal(error, undefined);
      assert.equal(value, -5000);
    });

    test('rejects scientific notation', () => {
      const { error } = schema.validate('-5000e');
      assert.ok(error);
    });
  });

  describe('moneyAmountOptional', () => {
    const schema = moneyAmountOptional({ min: 0 });

    test('allows empty optional values', () => {
      const { error, value } = schema.validate('');
      assert.equal(error, undefined);
      assert.equal(value, undefined);
    });
  });

  describe('quantityAmount', () => {
    const schema = quantityAmount({ min: 0 });

    test('accepts whole numbers', () => {
      const { error, value } = schema.validate('10');
      assert.equal(error, undefined);
      assert.equal(value, 10);
    });

    test('rejects decimals and scientific notation', () => {
      assert.ok(schema.validate('10.5').error);
      assert.ok(schema.validate('10e2').error);
    });
  });
});
