const { ClockService } = require('../../../../../common/date');
const { INVOICE_STATUS } = require('../../../../../common/constants/invoice');
const { recalculateInvoiceStatus } = require('./invoicePaymentReversal.helper');

const roundMoney = (value) => Number((Number(value) || 0).toFixed(2));

/**
 * Apply create-form "Already Paid" so one-time HOA invoices match update /
 * policy-term prepaid behavior: correct balanceDue, status, paidOn, and a
 * paymentTransactions row (Payments Received + totals from txs).
 *
 * Notifications/email already prefer balanceDue from the client payload; without
 * this step the invoice stayed Pending/Overdue with an empty payment history.
 *
 * Mutates `data` in place and returns it.
 */
function applyCreateTimeAlreadyPaid(data) {
  if (!data || typeof data !== 'object') return data;

  const subAmount = roundMoney(data.subAmount);
  let alreadyPaid = roundMoney(data.alreadyPaid);
  if (alreadyPaid < 0) alreadyPaid = 0;
  if (alreadyPaid > subAmount) alreadyPaid = subAmount;

  const processingAmount = roundMoney(data.processingAmount);
  const waivedAmount = roundMoney(data.waivedAmount);
  const balanceDue = roundMoney(
    Math.max(0, subAmount - alreadyPaid - processingAmount - waivedAmount)
  );

  data.alreadyPaid = alreadyPaid;
  data.balanceDue = balanceDue;

  const statusProbe = {
    alreadyPaid,
    balanceDue,
    processingAmount,
    waivedAmount,
    dueDate: data.dueDate,
    status: data.status,
  };
  recalculateInvoiceStatus(statusProbe);
  data.status = statusProbe.status;

  if (statusProbe.status === INVOICE_STATUS.PAID) {
    data.paidOn = data.paidOn || ClockService.now();
  } else if (statusProbe.paidOn === undefined) {
    delete data.paidOn;
  }

  if (alreadyPaid <= 0) {
    return data;
  }

  const existingTxs = Array.isArray(data.paymentTransactions)
    ? data.paymentTransactions.filter(Boolean)
    : [];
  const alreadyRecorded = existingTxs.some((tx) => {
    if (tx?.isDeleted === true) return false;
    return Math.abs(roundMoney(tx.amount) - alreadyPaid) < 0.009;
  });
  if (alreadyRecorded) {
    return data;
  }

  const when = ClockService.now();
  data.paymentTransactions = [
    ...existingTxs,
    {
      amount: alreadyPaid,
      method: 'Payment',
      isManual: true,
      note: `Already paid at invoice creation: $${alreadyPaid.toFixed(2)}`,
      balanceAfter: balanceDue,
      paidAt: when,
      recordedAt: when,
    },
  ];

  return data;
}

module.exports = {
  applyCreateTimeAlreadyPaid,
};
