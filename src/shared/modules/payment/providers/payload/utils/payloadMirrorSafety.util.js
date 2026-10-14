'use strict';

const { roundMoney } = require('./payloadPayinSettlement.util');

/** Allowed rounding drift between PropMV and Payload mirror amounts (USD). */
const MIRROR_AMOUNT_EPSILON = 0.01;

function mirrorAmountExceedsExpected(remoteAmountDue, expectedCharge) {
  return roundMoney(remoteAmountDue) > roundMoney(expectedCharge) + MIRROR_AMOUNT_EPSILON;
}

function mirrorAmountBelowExpected(remoteAmountDue, expectedCharge) {
  return roundMoney(remoteAmountDue) < roundMoney(expectedCharge) - MIRROR_AMOUNT_EPSILON;
}

/**
 * Pick the primary charge line item to update on mirror upsert (avoid payment-type rows).
 */
function pickPrimaryChargeLineItem(items = []) {
  const list = Array.isArray(items) ? items : [];
  const charges = list.filter((row) => {
    const entryType = String(row?.entry_type || row?.entryType || 'charge').trim().toLowerCase();
    return entryType === 'charge';
  });
  if (!charges.length) return null;
  return charges.sort((a, b) => roundMoney(b.amount || 0) - roundMoney(a.amount || 0))[0];
}

function buildMirrorChargeItems({ remoteItems, chargeAmount, description }) {
  const existing = pickPrimaryChargeLineItem(remoteItems);
  const item = {
    entry_type: 'charge',
    amount: roundMoney(chargeAmount),
    description: String(description || '').slice(0, 120),
  };
  const existingId = String(existing?.id || '').trim();
  if (existingId) {
    item.id = existingId;
  }
  return [item];
}

/**
 * Last-line defense before ledger settlement for automatic Payload payments.
 */
function assertAutopaySettlementAmountAllowed({ invoice, invoicePaymentAmount }) {
  const balanceDue = roundMoney(invoice?.balanceDue || 0);
  const txnPrincipal = roundMoney(invoicePaymentAmount || 0);
  if (balanceDue <= 0 && txnPrincipal > MIRROR_AMOUNT_EPSILON) {
    return { allowed: false, reason: 'invoice_already_paid' };
  }
  if (txnPrincipal > balanceDue + MIRROR_AMOUNT_EPSILON) {
    return {
      allowed: false,
      reason: 'txn_exceeds_balance_due',
      balanceDue,
      txnPrincipal,
    };
  }
  return { allowed: true, balanceDue, txnPrincipal };
}

module.exports = {
  MIRROR_AMOUNT_EPSILON,
  mirrorAmountExceedsExpected,
  mirrorAmountBelowExpected,
  pickPrimaryChargeLineItem,
  buildMirrorChargeItems,
  assertAutopaySettlementAmountAllowed,
};
