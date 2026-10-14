const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { ClockService } = require('../date');
const {
  isPastDueOutstandingInvoice,
  isDueDateOnOrBeforeToday,
} = require('./hoaBillingDates');

describe('isPastDueOutstandingInvoice', () => {
  afterEach(() => ClockService.reset());

  it('includes Processing invoices with past due date and remaining balance', () => {
    ClockService.setFixedTime('2026-08-22T17:00:00.000Z');
    assert.equal(
      isPastDueOutstandingInvoice({
        status: 'Processing',
        dueDate: '2026-01-01',
        balanceDue: 50,
        alreadyPaid: 50,
        processingAmount: 50,
      }),
      true,
    );
  });

  it('excludes Processing invoices that are not yet past due', () => {
    ClockService.setFixedTime('2026-08-22T17:00:00.000Z');
    assert.equal(
      isPastDueOutstandingInvoice({
        status: 'Processing',
        dueDate: '2026-09-01',
        balanceDue: 100,
        processingAmount: 100,
      }),
      false,
    );
  });

  it('includes partially paid past-due invoices', () => {
    ClockService.setFixedTime('2026-08-22T17:00:00.000Z');
    assert.equal(
      isPastDueOutstandingInvoice({
        status: 'Partially Paid',
        dueDate: '2026-03-01',
        balanceDue: 50,
        alreadyPaid: 50,
      }),
      true,
    );
  });

  it('excludes fully paid invoices', () => {
    ClockService.setFixedTime('2026-08-22T17:00:00.000Z');
    assert.equal(
      isPastDueOutstandingInvoice({
        status: 'Paid',
        dueDate: '2026-01-01',
        balanceDue: 0,
        alreadyPaid: 100,
      }),
      false,
    );
  });

  it('does not treat Sep 14 as due in Eastern while UTC/IST is already Sep 14', () => {
    // 2026-09-14T00:01Z is Sep 13 8:01 PM EDT and Sep 14 5:31 AM IST.
    ClockService.setFixedTime('2026-09-14T00:01:00.000Z');
    assert.equal(
      isDueDateOnOrBeforeToday('2026-09-14', ClockService.now(), 'America/New_York'),
      false,
    );
    assert.equal(
      isDueDateOnOrBeforeToday('2026-09-14', ClockService.now(), 'Asia/Kolkata'),
      true,
    );
    assert.equal(
      isPastDueOutstandingInvoice({
        status: 'Pending',
        dueDate: '2026-09-13',
        balanceDue: 100,
      }, ClockService.now(), 'America/New_York'),
      false,
    );
  });

  it('treats Sep 14 as due at Eastern midnight, isolating auto-credit from IST', () => {
    ClockService.setFixedTime('2026-09-14T04:00:00.000Z');
    assert.equal(
      isDueDateOnOrBeforeToday('2026-09-14', ClockService.now(), 'America/New_York'),
      true,
    );
    assert.equal(
      isPastDueOutstandingInvoice({
        status: 'Pending',
        dueDate: '2026-09-13',
        balanceDue: 100,
      }, ClockService.now(), 'America/New_York'),
      true,
    );
  });

  it('excludes fully waived invoices', () => {
    ClockService.setFixedTime('2026-08-22T17:00:00.000Z');
    assert.equal(
      isPastDueOutstandingInvoice({
        status: 'Waived',
        dueDate: '2026-01-01',
        balanceDue: 0,
        waivedAmount: 100,
      }),
      false,
    );
  });
});
