const Expense = require('../model/expense.model');

const SHORT_EXPENSE_ID_PATTERN = /^EXP\d{6}$/;

function makeExpenseId() {
  return `EXP${Math.floor(100000 + Math.random() * 900000)}`;
}

function isShortExpenseId(expenseId) {
  return typeof expenseId === 'string' && SHORT_EXPENSE_ID_PATTERN.test(expenseId.trim());
}

async function allocateUniqueExpenseId(options = {}) {
  const { session } = options;
  while (true) {
    const candidate = makeExpenseId();
    let query = Expense.findOne({ expenseId: candidate }).select('expenseId').lean();
    if (session) query = query.session(session);
    const exists = await query;
    if (!exists) return candidate;
  }
}

module.exports = { makeExpenseId, isShortExpenseId, allocateUniqueExpenseId };
