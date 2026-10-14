'use strict';

const Property = require('../../property/model/property.model');
const HOASettings = require('../model/hoaSettings.model');

async function loadAcceptPartialPaymentsForInvoice(invoice) {
  if (!invoice?.propertyId) return true;
  const property = await Property.findById(invoice.propertyId).select('hoaId').lean();
  if (!property?.hoaId) return true;
  const settings = await HOASettings.findOne({ hoaId: property.hoaId }).select('paymentTerm').lean();
  return Boolean(settings?.paymentTerm?.acceptPartialPayments);
}

async function loadAcceptPartialPaymentsForHoa(hoaId) {
  if (!hoaId) return false;
  const settings = await HOASettings.findOne({ hoaId }).select('paymentTerm').lean();
  return Boolean(settings?.paymentTerm?.acceptPartialPayments);
}

/**
 * Throws when HOA settings disallow paying less than the invoice collectable balance.
 */
async function assertHoaAcceptsPartialPaymentForInvoice(invoice, paymentAmount, collectableBalance) {
  const amount = Number(paymentAmount || 0);
  const collectable = Number(collectableBalance || 0);
  if (!(amount > 0) || !(collectable > 0)) return;
  if (amount + 0.009 >= collectable) return;

  const allowed = await loadAcceptPartialPaymentsForInvoice(invoice);
  if (!allowed) {
    throw Object.assign(
      new Error('Partial payments are not allowed for this HOA community.'),
      { status: 400, statusCode: 400, code: 'PARTIAL_PAYMENTS_DISABLED' },
    );
  }
}

module.exports = {
  loadAcceptPartialPaymentsForInvoice,
  loadAcceptPartialPaymentsForHoa,
  assertHoaAcceptsPartialPaymentForInvoice,
};
