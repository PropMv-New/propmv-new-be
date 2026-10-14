const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  computePortfolioCreditBalance,
  computeAvailableCreditBalance,
  buildLedgerCreditDrainUpdates,
  applyBookedCreditReleaseOffset,
  resolveCreditReleaseExpenseBookedAmount,
  portfolioDisplayBalanceFromSummary,
  createCreditReleaseExpenseInSession,
} = require('../services/ledger.service');

describe('ledger credit balance deduplication', () => {
  const today = new Date('2026-06-01T12:00:00Z');

  it('does not double-count invoice overpayment mirrored on Property.remainingCredit', () => {
    const propertyDoc = { remainingCredit: 100, startingBalance: 0 };
    const entries = [
      {
        type: 'adjustment',
        amount: -100,
        metadata: { source: 'invoice_overpayment', remainingCredit: 100 },
      },
    ];

    assert.equal(
      computeAvailableCreditBalance(propertyDoc, entries, 0, [], today),
      100,
    );
    assert.equal(
      computePortfolioCreditBalance(100, 100, 100),
      100,
    );
  });

  it('adds manual ledger-only credit to Property.remainingCredit', () => {
    assert.equal(computePortfolioCreditBalance(100, 150, 100), 150);
    assert.equal(
      computeAvailableCreditBalance(
        { remainingCredit: 100 },
        [
          { type: 'adjustment', amount: -100, metadata: { source: 'invoice_overpayment', remainingCredit: 100 } },
          { type: 'adjustment', amount: -50, metadata: { remainingCredit: 50 } },
        ],
        0,
        [],
        today,
      ),
      150,
    );
  });

  it('counts ledger-only manual credit when property pool is zero', () => {
    assert.equal(computePortfolioCreditBalance(0, 50, 0), 50);
  });

  it('infers unapplied opening credit when Property.remainingCredit was never persisted', () => {
    assert.equal(
      computeAvailableCreditBalance(
        { remainingCredit: 0, startingBalance: -400 },
        [],
        -400,
        [
          {
            term: 'Manual',
            subAmount: 50,
            alreadyPaid: 50,
            balanceDue: 0,
            paymentTransactions: [
              {
                amount: 50,
                method: 'Credit Adjustment',
                note: 'Applied $50.00 from available credit balance',
              },
            ],
          },
        ],
        today,
      ),
      350,
    );
  });

  it('keeps overpayment credit after opening-balance credit was fully applied', () => {
    // Opening -$100 credit applied to invoice 1; later $150 payment on invoice 2
    // stores $50 on Property.remainingCredit. Must not be clamped to inferred 0.
    assert.equal(
      computeAvailableCreditBalance(
        { remainingCredit: 50, startingBalance: -100 },
        [
          {
            type: 'adjustment',
            amount: -50,
            metadata: { source: 'invoice_overpayment', remainingCredit: 0 },
          },
        ],
        -100,
        [
          {
            term: 'Manual',
            subAmount: 100,
            alreadyPaid: 100,
            balanceDue: 0,
            paymentTransactions: [
              {
                amount: 100,
                method: 'Credit Adjustment',
                note: 'Applied $100.00 from available credit balance',
              },
            ],
          },
          {
            term: 'Manual',
            subAmount: 100,
            alreadyPaid: 100,
            balanceDue: 0,
            paymentTransactions: [
              { amount: 100, method: 'Check' },
              {
                amount: 50,
                method: 'Credit Balance',
                note: 'Overpayment of $50.00 stored as credit balance',
              },
            ],
          },
        ],
        today,
      ),
      50,
    );
  });

  it('trusts persisted Property.remainingCredit over opening-balance inference', () => {
    assert.equal(
      computeAvailableCreditBalance(
        { remainingCredit: 400, startingBalance: -400 },
        [],
        -400,
        [
          {
            term: 'Manual',
            subAmount: 50,
            alreadyPaid: 50,
            balanceDue: 0,
            paymentTransactions: [
              {
                amount: 50,
                method: 'Credit Adjustment',
                note: 'Applied $50.00 from available credit balance',
              },
            ],
          },
        ],
        today,
      ),
      400,
    );
  });

  it('drains only the ledger credit rows that contribute to available credit', () => {
    const updates = buildLedgerCreditDrainUpdates(
      [
        {
          _id: 'overpayment-audit-row',
          type: 'adjustment',
          amount: -400,
          metadata: { source: 'invoice_overpayment', remainingCredit: 400 },
        },
        {
          _id: 'manual-credit-row',
          type: 'adjustment',
          amount: -400,
          metadata: { remainingCredit: 400 },
        },
      ],
      50,
    );

    assert.deepEqual(updates, [
      { entryId: 'manual-credit-row', remainingCredit: 350 },
    ]);
  });

  it('applyBookedCreditReleaseOffset zeros pool when credit was booked as HOA expense', () => {
    assert.equal(applyBookedCreditReleaseOffset(100, 100), 0);
    assert.equal(applyBookedCreditReleaseOffset(100, 40), 60);
    assert.equal(applyBookedCreditReleaseOffset(0, 100), 0);
  });

  it('resolveCreditReleaseExpenseBookedAmount uses line items when total is missing', () => {
    assert.equal(
      resolveCreditReleaseExpenseBookedAmount({
        total: 0,
        expenseItems: [{ category: 'Credit release', amount: 100 }],
      }),
      100,
    );
    assert.equal(
      resolveCreditReleaseExpenseBookedAmount({
        total: 75,
        expenseItems: [{ category: 'Credit release', amount: 100 }],
      }),
      75,
    );
  });

  it('portfolioDisplayBalanceFromSummary stays settled after credit-release expense is paid', () => {
    const summary = {
      overdueAmount: 0,
      dueTodayAmount: 0,
      remainingCredit: 0,
      netBalance: 0,
    };
    assert.equal(portfolioDisplayBalanceFromSummary(summary).creditBalance, 0);
  });

  it('does not count drained negative adjustments with missing remainingCredit metadata', () => {
    const propertyDoc = { remainingCredit: 0, startingBalance: 0 };
    const entries = [
      {
        type: 'adjustment',
        amount: -100,
        metadata: { source: 'invoice_overpayment', remainingCredit: 0 },
      },
      {
        type: 'adjustment',
        amount: -100,
        metadata: { remainingCredit: 0 },
      },
    ];

    assert.equal(
      computeAvailableCreditBalance(propertyDoc, entries, 0, [], today),
      0,
    );
  });
});

describe('createCreditReleaseExpenseInSession dedicated expenseId allocation', () => {
  const mongoose = require('mongoose');
  const Expense = require('../../expense/model/expense.model');
  let originalFindOne;
  let originalSave;

  beforeEach(() => {
    originalFindOne = Expense.findOne;
    originalSave = Expense.prototype.save;
  });

  afterEach(() => {
    Expense.findOne = originalFindOne;
    Expense.prototype.save = originalSave;
  });

  it('allocates a dedicated Expense ID matching /^EXP\\d{6}$/ using existing generator', async () => {
    let sessionPassedToFindOne = null;
    Expense.findOne = () => ({
      select: () => ({
        lean: () => ({
          session: (sess) => {
            sessionPassedToFindOne = sess;
            return Promise.resolve(null);
          },
          then: (fn) => Promise.resolve(null).then(fn),
        }),
      }),
    });

    let sessionPassedToSave = null;
    Expense.prototype.save = async function save(opts) {
      sessionPassedToSave = opts?.session;
      return this;
    };

    const mockSession = { id: 'mock-session-123' };
    const payload = {
      taxableEntity: 'qwe',
      bankAccount: 'HOA Bank Account',
      property: new mongoose.Types.ObjectId(),
      expenseDate: new Date('2026-09-01T12:00:00Z'),
      dueDate: new Date('2026-09-15T12:00:00Z'),
      expenseItems: [
        {
          date: new Date('2026-09-01T12:00:00Z'),
          category: 'Credit release',
          description: 'Unapplied resident credit booked when the last owner was removed (qwe / 56).',
          amount: 300,
        },
      ],
      vendorPaidTo: 'Annu Bharti',
      total: 300,
    };

    const saved = await createCreditReleaseExpenseInSession(payload, mockSession);

    assert.ok(saved.expenseId, 'saved expense must have expenseId');
    assert.match(saved.expenseId, /^EXP\d{6}$/, 'expenseId must match EXP + 6 digits format');
    assert.equal(sessionPassedToFindOne, mockSession, 'must pass session to allocateUniqueExpenseId');
    assert.equal(sessionPassedToSave, mockSession, 'must pass session to expense.save');
    assert.equal(saved.total, 300, 'total must remain unchanged');
    assert.equal(
      saved.expenseItems[0].description,
      'Unapplied resident credit booked when the last owner was removed (qwe / 56).',
      'description must remain unchanged'
    );
  });

  it('preserves existing expenseId if already supplied on the payload', async () => {
    Expense.prototype.save = async function save() {
      return this;
    };

    const mockSession = { id: 'mock-session-456' };
    const payload = {
      expenseId: 'EXP999999',
      taxableEntity: 'Samarth Heights',
      bankAccount: 'Bank Ref',
      expenseDate: new Date('2026-09-01T12:00:00Z'),
      dueDate: new Date('2026-09-15T12:00:00Z'),
      expenseItems: [
        {
          date: new Date('2026-09-01T12:00:00Z'),
          category: 'Credit release',
          description: 'Unapplied resident credit booked during ownership balance reset (Samarth Heights / 202).',
          amount: 150,
        },
      ],
      total: 150,
    };

    const saved = await createCreditReleaseExpenseInSession(payload, mockSession);
    assert.equal(saved.expenseId, 'EXP999999');
  });

  it('throws when session is omitted', async () => {
    await assert.rejects(
      async () => {
        await createCreditReleaseExpenseInSession({ total: 100 }, null);
      },
      { message: 'session is required' }
    );
  });
});
