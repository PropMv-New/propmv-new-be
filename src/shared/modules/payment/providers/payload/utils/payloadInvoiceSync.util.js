'use strict';

const { roundMoney } = require('./payloadPayinSettlement.util');

function formatPayloadDueDate(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function isInvoiceEligibleForAutopaySync(invoice) {
  if (!invoice || invoice.isDeleted) return false;
  const balance = roundMoney(invoice.balanceDue);
  if (balance <= 0) return false;
  const status = String(invoice.status || '').toLowerCase();
  if (['paid', 'cancelled', 'canceled', 'void', 'waived'].includes(status)) return false;
  return Boolean(invoice.dueDate);
}

module.exports = {
  formatPayloadDueDate,
  isInvoiceEligibleForAutopaySync,
};
