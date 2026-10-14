/**
 * Unit tests: shared expense service transaction helpers.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  withExpenseTransaction,
  runInTransaction,
} = require('../shared/modules/expense/service/expenseDb.util');

const {
  mergeExpenseScopeFromActor,
  parseExpenseItemIndices,
  normalizeListQuery,
} = require('../shared/modules/expense/service/expense.service');

describe('withExpenseTransaction', () => {
  test('reuses caller session without starting a nested transaction', async () => {
    const fakeSession = { id: 'expense-session' };
    let receivedSession = null;
    const result = await withExpenseTransaction(async (session) => {
      receivedSession = session;
      return 'ok';
    }, { session: fakeSession });
    assert.equal(result, 'ok');
    assert.equal(receivedSession, fakeSession);
  });

  test('runInTransaction is exported', () => {
    assert.equal(typeof runInTransaction, 'function');
  });
});

describe('parseExpenseItemIndices', () => {
  test('parses JSON string indices', () => {
    assert.deepEqual(parseExpenseItemIndices('[0,1]'), [0, 1]);
  });

  test('parses array indices', () => {
    assert.deepEqual(parseExpenseItemIndices([0, 2]), [0, 2]);
  });
});

describe('mergeExpenseScopeFromActor', () => {
  test('merges createdBy from actor', () => {
    const actorId = '507f1f77bcf86cd799439011';
    const merged = mergeExpenseScopeFromActor({}, actorId);
    assert.equal(String(merged.createdBy), actorId);
  });
});

describe('normalizeListQuery', () => {
  test('parses pagination fields', () => {
    const q = normalizeListQuery({ pageNumber: '2', pageSize: '25' }, '507f1f77bcf86cd799439011');
    assert.equal(q.pageNumber, 2);
    assert.equal(q.pageSize, 25);
  });
});
