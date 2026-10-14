'use strict';

const { billingCalendarDateKey, APP_TIMEZONE } = require('./hoaBillingDates');

const PAYMENT_DATE_BEFORE_INVOICE_GENERATION =
  'Payment date cannot be earlier than the invoice generation date';

/** Calendar compare in APP_TIMEZONE: -1 before, 0 same day, 1 after */
function compareCalendarDates(dateA, dateB, timeZone = APP_TIMEZONE) {
  const keyA = billingCalendarDateKey(dateA, timeZone);
  const keyB = billingCalendarDateKey(dateB, timeZone);
  if (!keyA || !keyB) return 0;
  if (keyA < keyB) return -1;
  if (keyA > keyB) return 1;
  return 0;
}

function isPaymentDateOnOrAfterInvoiceGeneration(paymentDate, invoiceCreatedAt, timeZone = APP_TIMEZONE) {
  if (!paymentDate || !invoiceCreatedAt) return true;
  return compareCalendarDates(paymentDate, invoiceCreatedAt, timeZone) >= 0;
}

function assertPaymentDateOnOrAfterInvoiceGeneration(paymentDate, invoiceCreatedAt, timeZone = APP_TIMEZONE) {
  if (!isPaymentDateOnOrAfterInvoiceGeneration(paymentDate, invoiceCreatedAt, timeZone)) {
    throw Object.assign(new Error(PAYMENT_DATE_BEFORE_INVOICE_GENERATION), {
      status: 400,
      code: 'PAYMENT_DATE_BEFORE_INVOICE_GENERATION',
    });
  }
}

module.exports = {
  PAYMENT_DATE_BEFORE_INVOICE_GENERATION,
  compareCalendarDates,
  isPaymentDateOnOrAfterInvoiceGeneration,
  assertPaymentDateOnOrAfterInvoiceGeneration,
};
