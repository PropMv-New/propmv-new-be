'use strict';

/**
 * Phase 4 — VendorInvoice book updates for electronic Owner→Vendor payins.
 * Does NOT use HOA settleInvoiceGatewayPayment.
 */

const mongoose = require('mongoose');
const VendorInvoice = require('../model/vendorInvoice.model');
const { VENDOR_INVOICE_STATUS } = require('../model/vendorInvoice.model');

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function deriveStatus(subAmount, amountPaid, explicitStatus) {
  if (explicitStatus === VENDOR_INVOICE_STATUS.CANCELLED) {
    return VENDOR_INVOICE_STATUS.CANCELLED;
  }
  if (amountPaid >= subAmount && subAmount > 0) {
    return VENDOR_INVOICE_STATUS.PAID;
  }
  if (explicitStatus === VENDOR_INVOICE_STATUS.PROCESSING) {
    return VENDOR_INVOICE_STATUS.PROCESSING;
  }
  if (amountPaid > 0 && amountPaid < subAmount) {
    return VENDOR_INVOICE_STATUS.PENDING;
  }
  return explicitStatus === VENDOR_INVOICE_STATUS.PAID
    ? VENDOR_INVOICE_STATUS.PAID
    : VENDOR_INVOICE_STATUS.PENDING;
}

function personDisplayName(user) {
  if (!user || typeof user === 'string') return null;
  return `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email || user.name || null;
}

async function resolveActorDisplayName(userIdOrName) {
  const raw = String(userIdOrName || '').trim();
  if (!raw) return '';
  if (raw === 'system') return 'System';
  if (!/^[0-9a-fA-F]{24}$/.test(raw)) return raw;
  try {
    const User = require('../../../../../shared/modules/users/models/user.model');
    const user = await User.findOne({ _id: raw, isDeleted: { $ne: true } })
      .select('firstName lastName name email')
      .lean();
    return personDisplayName(user) || 'User';
  } catch {
    return 'User';
  }
}

function electronicPaymentNote(methodLabel) {
  const method = String(methodLabel || 'online').trim() || 'online';
  return `Electronic ${method} payment`;
}

/**
 * Mark invoice Processing when an electronic payin is in flight (no amount applied yet).
 */
async function markVendorInvoiceElectronicProcessing({
  vendorInvoiceId,
  recordedBy = 'system',
  note = 'Electronic payment initiated',
}) {
  const oid = new mongoose.Types.ObjectId(String(vendorInvoiceId));
  const invoice = await VendorInvoice.findOne({ _id: oid, isDeleted: { $ne: true } });
  if (!invoice) {
    const err = new Error('Vendor invoice not found');
    err.status = 404;
    throw err;
  }
  if (invoice.status === VENDOR_INVOICE_STATUS.PAID || invoice.status === VENDOR_INVOICE_STATUS.CANCELLED) {
    return invoice.toObject();
  }

  const previousStatus = invoice.status;
  if (invoice.status !== VENDOR_INVOICE_STATUS.PROCESSING) {
    const changedByName = await resolveActorDisplayName(recordedBy);
    invoice.status = VENDOR_INVOICE_STATUS.PROCESSING;
    invoice.activityTimeline = invoice.activityTimeline || [];
    invoice.activityTimeline.push({
      kind: 'status_change',
      at: new Date(),
      previousStatus,
      newStatus: VENDOR_INVOICE_STATUS.PROCESSING,
      changedBy: changedByName || recordedBy,
      note: String(note || '').replace(/txn_[A-Za-z0-9]+/g, '').trim() || 'Electronic payment initiated',
    });
    await invoice.save();
  }
  return invoice.toObject();
}

/**
 * Apply settled electronic payment amount to VendorInvoice (idempotent per payin via caller).
 */
async function settleVendorInvoiceGatewayPayment({
  vendorInvoiceId,
  paymentAmount,
  methodLabel = 'payload',
  recordedBy = 'system',
  paidBy = '',
  payinId = '',
}) {
  const amount = roundMoney(paymentAmount);
  if (!(amount > 0)) {
    const err = new Error('Settlement amount must be positive');
    err.status = 400;
    throw err;
  }

  const oid = new mongoose.Types.ObjectId(String(vendorInvoiceId));
  const invoice = await VendorInvoice.findOne({ _id: oid, isDeleted: { $ne: true } });
  if (!invoice) {
    const err = new Error('Vendor invoice not found');
    err.status = 404;
    throw err;
  }

  const previousPaid = roundMoney(invoice.amountPaid);
  const subAmount = roundMoney(invoice.subAmount);
  const nextPaid = roundMoney(previousPaid + amount);
  if (nextPaid > subAmount + 0.001) {
    const err = new Error('Settlement would overpay Vendor invoice');
    err.status = 409;
    err.code = 'VENDOR_INVOICE_OVERPAY';
    throw err;
  }

  invoice.amountPaid = nextPaid;
  invoice.balanceDue = Math.max(0, roundMoney(subAmount - nextPaid));
  // Do not keep Processing after a settlement lands — in-flight holds are
  // re-applied by the payin service when another payin is still open.
  const statusBasis = invoice.status === VENDOR_INVOICE_STATUS.PROCESSING
    ? VENDOR_INVOICE_STATUS.PENDING
    : invoice.status;
  invoice.status = deriveStatus(subAmount, nextPaid, statusBasis);
  if (invoice.status === VENDOR_INVOICE_STATUS.PAID && !invoice.paidAt) {
    invoice.paidAt = new Date();
  }

  const paidByName = await resolveActorDisplayName(paidBy || recordedBy);
  const recordedByName = await resolveActorDisplayName(recordedBy);
  const settledAt = new Date();

  invoice.activityTimeline = invoice.activityTimeline || [];
  invoice.activityTimeline.push({
    kind: 'payment',
    at: settledAt,
    amount,
    method: methodLabel,
    note: electronicPaymentNote(methodLabel),
    balanceAfter: invoice.balanceDue,
    recordedBy: recordedByName || recordedBy,
    paidBy: paidByName || recordedByName || recordedBy,
    paidOn: settledAt.toISOString().slice(0, 10),
  });
  void payinId; // retained for callers / future audit field; not shown in UI note

  await invoice.save();

  try {
    const { ensureExpenseForPaidVendorInvoice } = require('./vendorInvoiceExpense.helper');
    if (invoice.status === VENDOR_INVOICE_STATUS.PAID) {
      await ensureExpenseForPaidVendorInvoice(invoice);
    }
  } catch {
    // expense creation is best-effort; settlement already committed
  }

  // Notify on every settled amount (partial or full) — not gated on Paid status.
  try {
    const {
      notifyVendorInvoicePaymentEmailInBackground,
    } = require('./vendorInvoicePaymentEmail.helper');
    notifyVendorInvoicePaymentEmailInBackground({
      invoice: invoice.toObject ? invoice.toObject() : invoice,
      paymentAmount: amount,
      paymentMethod: methodLabel,
      balanceAfter: invoice.balanceDue,
      actorUserId: null,
      paidOn: new Date().toISOString().slice(0, 10),
    });
  } catch {
    // payment email is best-effort; settlement already committed
  }

  return invoice.toObject();
}

/**
 * Fail path: if no remaining in-flight electronic holds and not paid, move Processing → Pending.
 */
async function failVendorInvoiceGatewayPayment({
  vendorInvoiceId,
  hasOtherInFlight = false,
  recordedBy = 'system',
  note = 'Electronic payment failed',
}) {
  const oid = new mongoose.Types.ObjectId(String(vendorInvoiceId));
  const invoice = await VendorInvoice.findOne({ _id: oid, isDeleted: { $ne: true } });
  if (!invoice) return null;

  invoice.activityTimeline = invoice.activityTimeline || [];
  invoice.activityTimeline.push({
    kind: 'payment',
    at: new Date(),
    amount: 0,
    method: 'payload',
    note,
    balanceAfter: invoice.balanceDue,
    recordedBy,
  });

  if (
    !hasOtherInFlight
    && invoice.status === VENDOR_INVOICE_STATUS.PROCESSING
    && roundMoney(invoice.amountPaid) < roundMoney(invoice.subAmount)
  ) {
    const previousStatus = invoice.status;
    invoice.status = deriveStatus(invoice.subAmount, invoice.amountPaid, VENDOR_INVOICE_STATUS.PENDING);
    invoice.activityTimeline.push({
      kind: 'status_change',
      at: new Date(),
      previousStatus,
      newStatus: invoice.status,
      changedBy: recordedBy,
      note,
    });
  }

  await invoice.save();
  return invoice.toObject();
}

/**
 * Reverse a previously settled electronic amount.
 */
async function reverseVendorInvoiceGatewayPayment({
  vendorInvoiceId,
  paymentAmount,
  recordedBy = 'system',
  note = 'Electronic payment reversed',
  payinId = '',
}) {
  const amount = roundMoney(paymentAmount);
  const oid = new mongoose.Types.ObjectId(String(vendorInvoiceId));
  const invoice = await VendorInvoice.findOne({ _id: oid, isDeleted: { $ne: true } });
  if (!invoice) {
    const err = new Error('Vendor invoice not found');
    err.status = 404;
    throw err;
  }

  const previousPaid = roundMoney(invoice.amountPaid);
  const nextPaid = Math.max(0, roundMoney(previousPaid - amount));
  const subAmount = roundMoney(invoice.subAmount);
  invoice.amountPaid = nextPaid;
  invoice.balanceDue = Math.max(0, roundMoney(subAmount - nextPaid));
  invoice.paidAt = invoice.status === VENDOR_INVOICE_STATUS.PAID && nextPaid >= subAmount
    ? invoice.paidAt
    : null;
  invoice.status = deriveStatus(subAmount, nextPaid, VENDOR_INVOICE_STATUS.PENDING);

  const recordedByName = await resolveActorDisplayName(recordedBy);
  invoice.activityTimeline = invoice.activityTimeline || [];
  invoice.activityTimeline.push({
    kind: 'payment',
    at: new Date(),
    amount: -amount,
    method: 'payload',
    note: note || 'Electronic payment reversed',
    balanceAfter: invoice.balanceDue,
    recordedBy: recordedByName || recordedBy,
  });
  void payinId;

  await invoice.save();
  return invoice.toObject();
}

module.exports = {
  roundMoney,
  deriveStatus,
  markVendorInvoiceElectronicProcessing,
  settleVendorInvoiceGatewayPayment,
  failVendorInvoiceGatewayPayment,
  reverseVendorInvoiceGatewayPayment,
};
