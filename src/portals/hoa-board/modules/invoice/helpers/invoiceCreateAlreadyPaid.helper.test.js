const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const FIXED_NOW = new Date('2026-06-15T12:00:00.000Z');

describe('applyCreateTimeAlreadyPaid', () => {
  let applyCreateTimeAlreadyPaid;
  let clockRestore;

  beforeEach(() => {
    // Fresh require so ClockService mock can be applied if needed via real module
    delete require.cache[require.resolve('./invoiceCreateAlreadyPaid.helper')];
    ({ applyCreateTimeAlreadyPaid } = require('./invoiceCreateAlreadyPaid.helper'));
    const { ClockService } = require('../../../../../common/date');
    clockRestore = mock.method(ClockService, 'now', () => new Date(FIXED_NOW));
  });

  afterEach(() => {
    if (clockRestore) clockRestore.mock.restore();
  });

  it('leaves unpaid invoices unchanged aside from normalized balanceDue', () => {
    const data = {
      subAmount: 100,
      alreadyPaid: 0,
      balanceDue: 100,
      dueDate: '2026-07-01',
      status: 'Pending',
    };
    applyCreateTimeAlreadyPaid(data);
    assert.equal(data.alreadyPaid, 0);
    assert.equal(data.balanceDue, 100);
    assert.equal(data.status, 'Pending');
    assert.equal(data.paymentTransactions, undefined);
  });

  it('marks partial already-paid as Partially Paid with a payment transaction', () => {
    const data = {
      subAmount: 200,
      alreadyPaid: 75,
      balanceDue: 125,
      dueDate: '2026-05-01',
      status: 'Overdue',
    };
    applyCreateTimeAlreadyPaid(data);
    assert.equal(data.alreadyPaid, 75);
    assert.equal(data.balanceDue, 125);
    assert.equal(data.status, 'Partially Paid');
    assert.equal(data.paidOn, undefined);
    assert.equal(data.paymentTransactions.length, 1);
    assert.equal(data.paymentTransactions[0].amount, 75);
    assert.equal(data.paymentTransactions[0].method, 'Payment');
    assert.equal(data.paymentTransactions[0].isManual, true);
    assert.equal(data.paymentTransactions[0].balanceAfter, 125);
    assert.match(data.paymentTransactions[0].note, /Already paid at invoice creation/);
  });

  it('marks fully paid create-time alreadyPaid as Paid with paidOn', () => {
    const data = {
      subAmount: 150,
      alreadyPaid: 150,
      balanceDue: 0,
      dueDate: '2026-05-01',
      status: 'Overdue',
    };
    applyCreateTimeAlreadyPaid(data);
    assert.equal(data.alreadyPaid, 150);
    assert.equal(data.balanceDue, 0);
    assert.equal(data.status, 'Paid');
    assert.ok(data.paidOn instanceof Date);
    assert.equal(data.paymentTransactions.length, 1);
    assert.equal(data.paymentTransactions[0].amount, 150);
  });

  it('clamps alreadyPaid to subAmount and recomputes balanceDue', () => {
    const data = {
      subAmount: 100,
      alreadyPaid: 999,
      balanceDue: 0,
      dueDate: '2026-07-01',
    };
    applyCreateTimeAlreadyPaid(data);
    assert.equal(data.alreadyPaid, 100);
    assert.equal(data.balanceDue, 0);
    assert.equal(data.status, 'Paid');
  });

  it('does not duplicate an existing matching payment transaction', () => {
    const data = {
      subAmount: 100,
      alreadyPaid: 40,
      balanceDue: 60,
      dueDate: '2026-07-01',
      paymentTransactions: [
        {
          amount: 40,
          method: 'Payment',
          isManual: true,
          note: 'Already paid at invoice creation: $40.00',
          balanceAfter: 60,
        },
      ],
    };
    applyCreateTimeAlreadyPaid(data);
    assert.equal(data.paymentTransactions.length, 1);
  });
});
