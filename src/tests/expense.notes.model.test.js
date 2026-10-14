/**
 * Unit tests: LandlordExpense vs HoaExpense model names and shared `notes` path.
 * Ensures Mongoose does not register a single 'Expense' schema that omits `notes`.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const LandlordExpense = require('../shared/modules/expense/model/expense.model');
const HoaExpense = require('../portals/hoa-board/modules/expense/model/expense.model');

describe('Expense models (split registration)', () => {
  test('LandlordExpense and HoaExpense are different model names', () => {
    assert.equal(LandlordExpense.modelName, 'LandlordExpense');
    assert.equal(HoaExpense.modelName, 'HoaExpense');
    assert.notEqual(LandlordExpense.modelName, HoaExpense.modelName);
  });

  test('both schemas define notes array for $push / reads on shared collection', () => {
    assert.ok(LandlordExpense.schema.path('notes'), 'LandlordExpense must have notes');
    assert.ok(HoaExpense.schema.path('notes'), 'HoaExpense must have notes');
  });

  test('both use the same collection name (expenses)', () => {
    assert.equal(LandlordExpense.collection.collectionName, 'expenses');
    assert.equal(HoaExpense.collection.collectionName, 'expenses');
  });
});
