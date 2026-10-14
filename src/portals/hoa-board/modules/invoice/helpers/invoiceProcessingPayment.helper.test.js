const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  isGatewayPaymentSettledStatus,
  isGatewayPaymentFailedStatus,
  findProcessingTransactionForGateway,
  recalculateInvoiceStatusAfterGateway,
  hasActiveProcessingPayment,
  buildGatewayPaymentSettledNotification,
  notifyGatewayPaymentSettledInBackground,
  notifyGatewayPaymentProcessingInBackground,
  notifyGatewayPaymentFailedInBackground,
  notifyGatewayPaymentReversedInBackground,
} = require('./invoiceProcessingPayment.helper');
const { INVOICE_STATUS } = require('../../../../../common/constants/invoice');
const { recalculateInvoiceTotalsFromTransactions } = require('./invoicePaymentTransactions.helper');

describe('invoiceProcessingPayment.helper', () => {
  it('recognizes settled and failed gateway statuses', () => {
    assert.equal(isGatewayPaymentSettledStatus('paid'), true);
    assert.equal(isGatewayPaymentSettledStatus('completed'), true);
    assert.equal(isGatewayPaymentSettledStatus('pending'), false);
    assert.equal(isGatewayPaymentFailedStatus('failed'), true);
    assert.equal(isGatewayPaymentFailedStatus('cancelled'), true);
    assert.equal(isGatewayPaymentFailedStatus('paid'), false);
  });

  it('finds processing tx by gateway external id', () => {
    const invoice = {
      paymentTransactions: [
        {
          amount: 400,
          status: 'processing',
          gatewayExternalId: 'ch_123',
          isManual: false,
        },
      ],
    };
    const match = findProcessingTransactionForGateway(invoice, { gatewayExternalId: 'ch_123' });
    assert.equal(match?.amount, 400);
  });

  it('recalculates invoice status to Processing while processingAmount remains', () => {
    const invoice = {
      subAmount: 1000,
      alreadyPaid: 0,
      processingAmount: 400,
      balanceDue: 600,
      dueDate: new Date('2099-01-01'),
      status: INVOICE_STATUS.PENDING,
      paymentTransactions: [
        { amount: 400, status: 'processing', isManual: false },
      ],
    };
    recalculateInvoiceStatusAfterGateway(invoice);
    assert.equal(invoice.status, INVOICE_STATUS.PROCESSING);
  });

  it('moves from processing to paid when processing tx completes', () => {
    const invoice = {
      subAmount: 1000,
      waivedAmount: 0,
      dueDate: new Date('2099-01-01'),
      status: INVOICE_STATUS.PROCESSING,
      paymentTransactions: [
        {
          amount: 1000,
          status: 'completed',
          isManual: false,
          completedAt: new Date(),
        },
      ],
    };
    const totals = recalculateInvoiceTotalsFromTransactions(invoice);
    invoice.processingAmount = totals.processingAmount;
    invoice.alreadyPaid = totals.alreadyPaid;
    invoice.balanceDue = totals.balanceDue;
    recalculateInvoiceStatusAfterGateway(invoice);
    assert.equal(invoice.processingAmount, 0);
    assert.equal(invoice.alreadyPaid, 1000);
    assert.equal(invoice.balanceDue, 0);
    assert.equal(invoice.status, INVOICE_STATUS.PAID);
  });

  it('detects active processing payments', () => {
    assert.equal(hasActiveProcessingPayment({
      paymentTransactions: [{ amount: 50, status: 'processing' }],
    }), true);
    assert.equal(hasActiveProcessingPayment({
      paymentTransactions: [{ amount: 50, status: 'failed' }],
    }), false);
  });

  it('builds owner-gateway settlement payload from the source payment record', () => {
    const paidAt = new Date('2026-09-15T12:00:00.000Z');
    const completedAt = new Date('2026-09-15T12:05:00.000Z');
    const invoice = { _id: 'inv-b', invoiceId: 'INV-B', balanceDue: 0 };
    const processingTx = {
      _id: 'tx-owner-100',
      amount: 100,
      method: 'card',
      paidBy: 'owner-1',
      recordedBy: 'owner-1',
      paidAt,
      completedAt,
      gatewayExternalId: 'payin_abc',
    };

    const built = buildGatewayPaymentSettledNotification({
      invoice,
      processingTx,
      settledAmount: 100,
      completedAt,
    });

    assert.equal(built.emailPayload.paymentAmount, 100);
    assert.equal(built.emailPayload.paymentMethod, 'card');
    assert.equal(built.emailPayload.balanceAfter, 0);
    assert.equal(built.emailPayload.recordedByUserId, 'owner-1');
    assert.equal(built.emailPayload.paymentTransactionId, 'tx-owner-100');
    assert.equal(built.emailPayload.paidAt, paidAt);
    assert.equal(built.inApp.actorUserId, 'owner-1');
    assert.equal(built.inApp.amount, 100);
    assert.equal(built.inApp.eventSuffix, 'tx-owner-100');
  });

  it('does not notify when a gateway settlement has no applied amount', () => {
    assert.equal(buildGatewayPaymentSettledNotification({
      invoice: { _id: 'inv-b', balanceDue: 100 },
      processingTx: { amount: 0, method: 'ACH' },
      settledAmount: 0,
    }), null);
  });

  it('queues payment-recorded email and in-app notify for an owner gateway payment', () => {
    const emailPath = require.resolve('../../../../../common/helpers/invoiceLifecycleEmail.service');
    const inAppPath = require.resolve('../../../../../common/helpers/hoaInAppNotify.helper');
    const emailMod = require(emailPath);
    const inAppMod = require(inAppPath);
    const origEmail = emailMod.notifyPaymentRecordedInBackground;
    const origInApp = inAppMod.notifyPaymentReceivedInAppInBackground;
    const calls = { email: [], inApp: [] };
    emailMod.notifyPaymentRecordedInBackground = (payload) => { calls.email.push(payload); };
    inAppMod.notifyPaymentReceivedInAppInBackground = (...args) => { calls.inApp.push(args); };

    const invoice = { _id: 'inv-b', invoiceId: 'INV-B', balanceDue: 0, hoaId: 'hoa-1' };
    try {
      const queued = notifyGatewayPaymentSettledInBackground({
        invoice,
        processingTx: {
          _id: 'tx-owner-100',
          amount: 100,
          method: 'echeck',
          paidBy: 'owner-1',
          gatewayExternalId: 'payin_abc',
        },
        settledAmount: 100,
        completedAt: new Date('2026-09-15T12:05:00.000Z'),
      });
      assert.equal(queued, true);
      assert.equal(calls.email.length, 1);
      assert.equal(calls.email[0].paymentAmount, 100);
      assert.equal(calls.email[0].paymentMethod, 'echeck');
      assert.equal(calls.email[0].invoice, invoice);
      assert.equal(calls.inApp.length, 1);
      assert.deepEqual(calls.inApp[0], [invoice, 'owner-1', 100, 'tx-owner-100']);
    } finally {
      emailMod.notifyPaymentRecordedInBackground = origEmail;
      inAppMod.notifyPaymentReceivedInAppInBackground = origInApp;
    }
  });

  it('queues invoice-updated email and processing in-app notify when electronic payment starts', () => {
    const emailPath = require.resolve('../../../../../common/helpers/invoiceLifecycleEmail.service');
    const inAppPath = require.resolve('../../../../../common/helpers/hoaInAppNotify.helper');
    const emailMod = require(emailPath);
    const inAppMod = require(inAppPath);
    const origEmail = emailMod.notifyInvoiceUpdatedInBackground;
    const origInApp = inAppMod.notifyPaymentProcessingInAppInBackground;
    const calls = { email: [], inApp: [] };
    emailMod.notifyInvoiceUpdatedInBackground = (payload) => { calls.email.push(payload); };
    inAppMod.notifyPaymentProcessingInAppInBackground = (...args) => { calls.inApp.push(args); };

    const invoice = { _id: 'inv-p', invoiceId: 'INV-P', balanceDue: 50, hoaId: 'hoa-1' };
    try {
      const queued = notifyGatewayPaymentProcessingInBackground({
        invoice,
        processingTx: {
          _id: 'tx-proc-1',
          amount: 50,
          method: 'ACH',
          paidBy: 'owner-2',
        },
        amount: 50,
      });
      assert.equal(queued, true);
      assert.equal(calls.email.length, 1);
      assert.match(calls.email[0].activityIntro, /being processed/i);
      assert.equal(calls.inApp.length, 1);
      assert.deepEqual(calls.inApp[0], [invoice, 'owner-2', 50, 'tx-proc-1']);
    } finally {
      emailMod.notifyInvoiceUpdatedInBackground = origEmail;
      inAppMod.notifyPaymentProcessingInAppInBackground = origInApp;
    }
  });

  it('queues payment-failed email and in-app notify when gateway payment fails', () => {
    const emailPath = require.resolve('../../../../../common/helpers/invoiceNotificationEmailHelper');
    const inAppPath = require.resolve('../../../../../common/helpers/hoaInAppNotify.helper');
    const emailMod = require(emailPath);
    const inAppMod = require(inAppPath);
    const origEmail = emailMod.notifyPaymentFailedInBackground;
    const origInApp = inAppMod.notifyPaymentFailedInAppInBackground;
    const calls = { email: [], inApp: [] };
    emailMod.notifyPaymentFailedInBackground = (payload) => { calls.email.push(payload); };
    inAppMod.notifyPaymentFailedInAppInBackground = (...args) => { calls.inApp.push(args); };

    const invoice = { _id: 'inv-f', invoiceId: 'INV-F', balanceDue: 75, hoaId: 'hoa-1' };
    try {
      const queued = notifyGatewayPaymentFailedInBackground({
        invoice,
        processingTx: {
          _id: 'tx-fail-1',
          amount: 75,
          paidBy: 'owner-3',
          note: 'Insufficient funds',
        },
        failedAmount: 75,
        failedAt: new Date('2026-09-15T12:10:00.000Z'),
      });
      assert.equal(queued, true);
      assert.equal(calls.email.length, 1);
      assert.equal(calls.email[0].paymentAmount, 75);
      assert.equal(calls.email[0].failureReason, 'Insufficient funds');
      assert.equal(calls.inApp.length, 1);
      assert.deepEqual(calls.inApp[0], [invoice, 'owner-3', 75, 'tx-fail-1']);
    } finally {
      emailMod.notifyPaymentFailedInBackground = origEmail;
      inAppMod.notifyPaymentFailedInAppInBackground = origInApp;
    }
  });

  it('queues payment-deleted email and in-app notify when gateway payment is refunded', () => {
    const emailPath = require.resolve('../../../../../common/helpers/invoiceLifecycleEmail.service');
    const inAppPath = require.resolve('../../../../../common/helpers/hoaInAppNotify.helper');
    const emailMod = require(emailPath);
    const inAppMod = require(inAppPath);
    const origEmail = emailMod.notifyPaymentDeletedInBackground;
    const origInApp = inAppMod.notifyPaymentDeletedInAppInBackground;
    const calls = { email: [], inApp: [] };
    emailMod.notifyPaymentDeletedInBackground = (payload) => { calls.email.push(payload); };
    inAppMod.notifyPaymentDeletedInAppInBackground = (...args) => { calls.inApp.push(args); };

    const invoice = { _id: 'inv-r', invoiceId: 'INV-R', balanceDue: 40, hoaId: 'hoa-1' };
    try {
      const queued = notifyGatewayPaymentReversedInBackground({
        invoice,
        gatewayTx: {
          _id: 'tx-ref-1',
          amount: 40,
          method: 'card',
          paidBy: 'owner-4',
        },
        refundAmount: 40,
        refundedAt: new Date('2026-09-15T12:20:00.000Z'),
        recordedBy: 'board-1',
      });
      assert.equal(queued, true);
      assert.equal(calls.email.length, 1);
      assert.equal(calls.email[0].paymentAmount, 40);
      assert.equal(calls.email[0].recordedByUserId, 'board-1');
      assert.equal(calls.inApp.length, 1);
      assert.deepEqual(calls.inApp[0], [invoice, 'board-1', 40, 'refund:tx-ref-1:40']);
    } finally {
      emailMod.notifyPaymentDeletedInBackground = origEmail;
      inAppMod.notifyPaymentDeletedInAppInBackground = origInApp;
    }
  });
});
