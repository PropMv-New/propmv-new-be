const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { buildActivityTimelineAndReminderCount } = require('./invoice.service');

describe('buildActivityTimelineAndReminderCount cross-invoice redirect', () => {
  it('emits payment_redirected for self_allocation spill when redirect metadata is present', () => {
    const groupId = 'pay-group-150';
    const olderId = new mongoose.Types.ObjectId();
    const plain = {
      createdAt: new Date('2026-08-01T12:00:00Z'),
      paymentTransactions: [
        {
          _id: new mongoose.Types.ObjectId(),
          amount: 50,
          method: 'Check',
          paidAt: new Date('2026-08-13T12:00:00Z'),
          recordedAt: new Date('2026-08-13T12:00:00Z'),
          paymentGroupId: groupId,
          recordedPaymentTotal: 150,
          fifoAllocationRole: 'self_allocation',
          fifoRedirectedAmount: 100,
          fifoRedirectedToInvoiceId: olderId,
          fifoRedirectedToInvoiceNumber: 'INV-A',
          fifoRedirectedAllocations: [
            { invoiceId: olderId, invoiceNumber: 'INV-A', amount: 100 },
          ],
        },
      ],
    };

    const { activityTimeline } = buildActivityTimelineAndReminderCount(plain, new Map());
    const redirected = activityTimeline.find((entry) => entry.kind === 'payment_redirected');
    assert.ok(redirected, 'expected payment_redirected timeline entry');
    assert.equal(redirected.recordedAmount, 150);
    assert.equal(redirected.appliedToThisInvoice, 50);
    assert.equal(redirected.redirectedAmount, 100);
    assert.equal(redirected.redirectedToInvoiceNumber, 'INV-A');
    assert.equal(redirected.redirectedAllocations.length, 1);
    assert.ok(!activityTimeline.some((entry) => entry.kind === 'payment_overpayment'));
  });

  it('reconstructs payment_redirected from prior_allocation map when redirect fields are missing', () => {
    const groupId = 'pay-group-missing-meta';
    const olderId = new mongoose.Types.ObjectId();
    const plain = {
      createdAt: new Date('2026-08-01T12:00:00Z'),
      paymentTransactions: [
        {
          _id: new mongoose.Types.ObjectId(),
          amount: 50,
          method: 'Check',
          paidAt: new Date('2026-08-13T12:00:00Z'),
          recordedAt: new Date('2026-08-13T12:00:00Z'),
          paymentGroupId: groupId,
          recordedPaymentTotal: 150,
          fifoAllocationRole: 'self_allocation',
          // Intentionally omit fifoRedirected* to simulate persistence gap
        },
      ],
    };
    const priorAllocationMap = new Map([
      [groupId, [{ invoiceId: String(olderId), invoiceNumber: 'INV-A', amount: 100 }]],
    ]);

    const { activityTimeline } = buildActivityTimelineAndReminderCount(plain, priorAllocationMap);
    const redirected = activityTimeline.find((entry) => entry.kind === 'payment_redirected');
    assert.ok(redirected, 'expected reconstructed payment_redirected entry');
    assert.equal(redirected.recordedAmount, 150);
    assert.equal(redirected.appliedToThisInvoice, 50);
    assert.equal(redirected.redirectedAmount, 100);
    assert.equal(redirected.redirectedToInvoiceNumber, 'INV-A');
    assert.ok(!activityTimeline.some((entry) => entry.kind === 'payment_overpayment'));
    assert.ok(!activityTimeline.some((entry) => entry.kind === 'payment'));
  });

  it('keeps payment_overpayment when excess is credit-only with no prior allocations', () => {
    const groupId = 'pay-group-credit-only';
    const plain = {
      createdAt: new Date('2026-08-01T12:00:00Z'),
      paymentTransactions: [
        {
          _id: new mongoose.Types.ObjectId(),
          amount: 100,
          method: 'Check',
          paidAt: new Date('2026-08-13T12:00:00Z'),
          recordedAt: new Date('2026-08-13T12:00:00Z'),
          paymentGroupId: groupId,
          recordedPaymentTotal: 150,
          fifoAllocationRole: 'self_allocation',
        },
        {
          _id: new mongoose.Types.ObjectId(),
          amount: 50,
          method: 'Credit Balance',
          note: 'Overpayment of $50.00 stored as credit balance',
          paidAt: new Date('2026-08-13T12:00:00Z'),
          recordedAt: new Date('2026-08-13T12:00:00Z'),
          paymentGroupId: groupId,
          recordedPaymentTotal: 150,
        },
      ],
    };

    const { activityTimeline } = buildActivityTimelineAndReminderCount(plain, new Map());
    const overpayment = activityTimeline.find((entry) => entry.kind === 'payment_overpayment');
    assert.ok(overpayment, 'expected payment_overpayment for credit-only excess');
    assert.equal(overpayment.recordedAmount, 150);
    assert.equal(overpayment.appliedToThisInvoice, 100);
    assert.equal(overpayment.creditStored, 50);
    assert.ok(!activityTimeline.some((entry) => entry.kind === 'payment_redirected'));
  });

  it('emits payment_redirected for over-balance spill even when redirect metadata is missing', () => {
    // Bug: payment >= current invoice balance with older unpaid invoice(s).
    // Cash spills to Invoice A first; remainder hits B as self_allocation.
    // When fifoRedirected* failed to persist, timeline used to emit payment_overpayment
    // / plain payment and omit the amount applied to Invoice A.
    const groupId = 'pay-group-over-balance-spill';
    const olderId = new mongoose.Types.ObjectId();
    const plain = {
      createdAt: new Date('2026-08-01T12:00:00Z'),
      paymentTransactions: [
        {
          _id: new mongoose.Types.ObjectId(),
          amount: 50,
          method: 'Check',
          paidAt: new Date('2026-08-13T12:00:00Z'),
          recordedAt: new Date('2026-08-13T12:00:00Z'),
          paymentGroupId: groupId,
          recordedPaymentTotal: 150,
          fifoAllocationRole: 'self_allocation',
          // Intentionally omit fifoRedirected* (persistence gap)
        },
      ],
    };
    const priorAllocationMap = new Map([
      [groupId, [{ invoiceId: String(olderId), invoiceNumber: 'INV-A', amount: 100 }]],
    ]);

    const { activityTimeline } = buildActivityTimelineAndReminderCount(plain, priorAllocationMap);
    const redirected = activityTimeline.find((entry) => entry.kind === 'payment_redirected');
    assert.ok(redirected, 'expected payment_redirected for over-balance FIFO spill');
    assert.equal(redirected.recordedAmount, 150);
    assert.equal(redirected.appliedToThisInvoice, 50);
    assert.equal(redirected.redirectedAmount, 100);
    assert.equal(redirected.redirectedToInvoiceNumber, 'INV-A');
    assert.ok(!activityTimeline.some((entry) => entry.kind === 'payment_overpayment'));
    assert.ok(!activityTimeline.some((entry) => entry.kind === 'payment'));
  });

  it('emits payment_redirected when payment equals current invoice balance and all cash goes to older invoice', () => {
    // A=$100, B=$100, pay $100 on B → all to A, B gets recorded_only.
    const groupId = 'pay-group-equals-balance';
    const olderId = new mongoose.Types.ObjectId();
    const plain = {
      createdAt: new Date('2026-08-01T12:00:00Z'),
      paymentTransactions: [
        {
          _id: new mongoose.Types.ObjectId(),
          amount: 0,
          method: 'Check',
          paidAt: new Date('2026-08-13T12:00:00Z'),
          recordedAt: new Date('2026-08-13T12:00:00Z'),
          paymentGroupId: groupId,
          recordedPaymentTotal: 100,
          fifoAllocationRole: 'recorded_only',
          fifoRedirectedAmount: 100,
          fifoRedirectedToInvoiceId: olderId,
          fifoRedirectedToInvoiceNumber: 'INV-A',
          fifoRedirectedAllocations: [
            { invoiceId: olderId, invoiceNumber: 'INV-A', amount: 100 },
          ],
        },
      ],
    };

    const { activityTimeline } = buildActivityTimelineAndReminderCount(plain, new Map());
    const redirected = activityTimeline.find((entry) => entry.kind === 'payment_redirected');
    assert.ok(redirected, 'expected payment_redirected for equals-balance FIFO redirect');
    assert.equal(redirected.recordedAmount, 100);
    assert.equal(redirected.appliedToThisInvoice, 0);
    assert.equal(redirected.redirectedAmount, 100);
    assert.equal(redirected.redirectedToInvoiceNumber, 'INV-A');
    assert.ok(!activityTimeline.some((entry) => entry.kind === 'payment'));
  });

  it('prefers prior_allocation invoice labels when stored redirect rows lack numbers', () => {
    const groupId = 'pay-group-missing-labels';
    const olderId = new mongoose.Types.ObjectId();
    const plain = {
      createdAt: new Date('2026-08-01T12:00:00Z'),
      paymentTransactions: [
        {
          _id: new mongoose.Types.ObjectId(),
          amount: 50,
          method: 'Check',
          paidAt: new Date('2026-08-13T12:00:00Z'),
          recordedAt: new Date('2026-08-13T12:00:00Z'),
          paymentGroupId: groupId,
          recordedPaymentTotal: 150,
          fifoAllocationRole: 'self_allocation',
          fifoRedirectedAmount: 100,
          fifoRedirectedAllocations: [
            { invoiceId: olderId, invoiceNumber: '', amount: 100 },
          ],
        },
      ],
    };
    const priorAllocationMap = new Map([
      [groupId, [{ invoiceId: String(olderId), invoiceNumber: 'INV-A', amount: 100 }]],
    ]);

    const { activityTimeline } = buildActivityTimelineAndReminderCount(plain, priorAllocationMap);
    const redirected = activityTimeline.find((entry) => entry.kind === 'payment_redirected');
    assert.ok(redirected);
    assert.equal(redirected.redirectedToInvoiceNumber, 'INV-A');
    assert.equal(redirected.redirectedAllocations[0].invoiceNumber, 'INV-A');
  });

  it('does not treat FIFO spill as credit overpayment when Credit Balance sibling is absent', () => {
    const groupId = 'pay-group-spill-no-credit';
    const plain = {
      createdAt: new Date('2026-08-01T12:00:00Z'),
      paymentTransactions: [
        {
          _id: new mongoose.Types.ObjectId(),
          amount: 50,
          method: 'Check',
          paidAt: new Date('2026-08-13T12:00:00Z'),
          recordedAt: new Date('2026-08-13T12:00:00Z'),
          paymentGroupId: groupId,
          recordedPaymentTotal: 150,
          fifoAllocationRole: 'self_allocation',
        },
      ],
    };

    const { activityTimeline } = buildActivityTimelineAndReminderCount(plain, new Map());
    const redirected = activityTimeline.find((entry) => entry.kind === 'payment_redirected');
    assert.ok(redirected, 'expected implied payment_redirected for spill without credit');
    assert.equal(redirected.recordedAmount, 150);
    assert.equal(redirected.appliedToThisInvoice, 50);
    assert.equal(redirected.redirectedAmount, 100);
    assert.ok(!activityTimeline.some((entry) => entry.kind === 'payment_overpayment'));
  });

  it('marks automated reminders as system triggered without a board member sender', () => {
    const plain = {
      createdAt: new Date('2026-09-01T12:00:00Z'),
      reminderHistory: [
        {
          recipients: ['jai@propmv.com'],
          subject: 'Invoice due today - #INV181472 - Social Coders',
          sentAt: new Date('2026-09-14T04:00:00.000Z'),
          sentBy: null,
          source: 'system',
          reminderType: 'due_today',
        },
      ],
    };

    const { activityTimeline } = buildActivityTimelineAndReminderCount(plain, new Map());
    const reminder = activityTimeline.find((entry) => entry.kind === 'reminder');
    assert.ok(reminder);
    assert.equal(reminder.isSystemTriggered, true);
    assert.equal(reminder.source, 'system');
    assert.equal(reminder.sentBy, null);
    assert.equal(reminder.subject, 'Invoice due today - #INV181472 - Social Coders');
  });

  it('keeps manual reminders attributed to the board member', () => {
    const plain = {
      createdAt: new Date('2026-09-01T12:00:00Z'),
      reminderHistory: [
        {
          recipients: ['owner@example.com'],
          subject: 'Payment reminder',
          sentAt: new Date('2026-09-14T16:00:00.000Z'),
          sentBy: { firstName: 'Board', lastName: 'Member' },
          source: 'manual',
        },
      ],
    };

    const { activityTimeline } = buildActivityTimelineAndReminderCount(plain, new Map());
    const reminder = activityTimeline.find((entry) => entry.kind === 'reminder');
    assert.equal(reminder.isSystemTriggered, false);
    assert.equal(reminder.sentBy, 'Board Member');
  });
});
