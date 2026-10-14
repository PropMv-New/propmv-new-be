/**
 * ------------------------------------------------------------------
 * File: invoiceCreditReconcile.helper.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for invoiceCreditReconcile.helper.
 *
 * Used By:
 * invoice.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Property = require('../../property/model/property.model');
const LedgerEntry = require('../../owners/models/ledgerEntry.model');
const { ClockService, DateUtil } = require('../../../../../common/date');
const {
  roundMoney,
  sumCreditAppliedOnInvoice,
  getPaymentTransactionNetTowardInvoice,
} = require('./invoicePaymentTransactions.helper');

const formatMoney = (value) => `$${roundMoney(value).toFixed(2)}`;

/**
 * preview Credit Reconcile On Reduction
 *
 * Performs logic operations for previewCreditReconcileOnReduction.
 *
 * @param options - Request/input argument
 * @param creditApplied - Request/input argument
 * @param oldSub - Request/input argument
 * @returns Operations result
 */
function previewCreditReconcileOnReduction({
  totalPaid,
  creditApplied,
  oldSub,
  newSub,
  processingAmount = 0,
  waivedAmount = 0,
}) {
  const newAlreadyPaid = roundMoney(Math.min(totalPaid, newSub));
  const returnToPool = roundMoney(totalPaid - newAlreadyPaid);
  const creditReturnPortion = roundMoney(Math.min(returnToPool, creditApplied));
  const newCreditApplied = roundMoney(Math.max(0, creditApplied - creditReturnPortion));
  const newBalanceDue = roundMoney(
    Math.max(
      0,
      newSub
      - newAlreadyPaid
      - roundMoney(processingAmount || 0)
      - roundMoney(waivedAmount || 0)
    )
  );

  return {
    oldSub: roundMoney(oldSub),
    newSub: roundMoney(newSub),
    newAlreadyPaid,
    returnToPool,
    creditReturnPortion,
    newCreditApplied,
    newBalanceDue,
  };
}

/** Open remaining after an amount edit: subtotal minus paid, in-flight processing, and waived. */
function computeBalanceAfterAmountEdit({
  subAmount,
  alreadyPaid = 0,
  processingAmount = 0,
  waivedAmount = 0,
}) {
  return roundMoney(
    Math.max(
      0,
      roundMoney(subAmount)
      - roundMoney(alreadyPaid || 0)
      - roundMoney(processingAmount || 0)
      - roundMoney(waivedAmount || 0)
    )
  );
}

/**
 * Reconcile applied credit and invoice totals when subAmount changes on edit.
 * Returns excess applied amounts to Property.remainingCredit and writes audit rows.
 */
async function reconcileInvoiceCreditOnAmountChange({
  invoice,
  previousSubAmount,
  newSubAmount,
  userId,
  session = null,
}) {
  const oldSub = roundMoney(previousSubAmount);
  const newSub = roundMoney(newSubAmount);
  if (newSub === oldSub || !invoice?.propertyId) return null;

  const opts = session ? { session } : {};
  const totalPaid = roundMoney(invoice.alreadyPaid || 0);
  const processingAmount = roundMoney(invoice.processingAmount || 0);
  const waivedAmount = roundMoney(invoice.waivedAmount || 0);
  const creditApplied = sumCreditAppliedOnInvoice(invoice);

  const editChanges = [];
  const now = ClockService.now();
  const recorderId =
    userId && mongoose.Types.ObjectId.isValid(String(userId))
      ? new mongoose.Types.ObjectId(String(userId))
      : undefined;

  if (newSub > oldSub) {
    // Keep electronic processing + settled cash applied so Remaining stays
    // newSub - alreadyPaid - processing - waived (e.g. $120 - $100 = $20).
    const newBalanceDue = computeBalanceAfterAmountEdit({
      subAmount: newSub,
      alreadyPaid: totalPaid,
      processingAmount,
      waivedAmount,
    });
    editChanges.push(
      `Invoice amount changed from ${formatMoney(oldSub)} to ${formatMoney(newSub)}.`,
      newBalanceDue > 0
        ? `Outstanding balance updated to ${formatMoney(newBalanceDue)}.`
        : 'Invoice remains fully paid after amount increase.'
    );

    return {
      alreadyPaid: totalPaid,
      balanceDue: newBalanceDue,
      creditReturned: 0,
      creditBalanceBefore: null,
      creditBalanceAfter: null,
      appliedCreditBefore: creditApplied,
      appliedCreditAfter: creditApplied,
      previousSubAmount: oldSub,
      newSubAmount: newSub,
      editChanges,
      amountIncreased: true,
    };
  }

  const {
    newAlreadyPaid,
    returnToPool,
    creditReturnPortion,
    newCreditApplied,
    newBalanceDue,
  } = previewCreditReconcileOnReduction({
    totalPaid,
    creditApplied,
    oldSub,
    newSub,
    processingAmount,
    waivedAmount,
  });

  editChanges.push(
    `Invoice amount changed from ${formatMoney(oldSub)} to ${formatMoney(newSub)}.`
  );

  if (creditApplied > 0) {
    editChanges.push(
      `Applied credit adjusted from ${formatMoney(creditApplied)} to ${formatMoney(newCreditApplied)}.`
    );
  }

  let creditBalanceBefore = null;
  let creditBalanceAfter = null;

  if (returnToPool > 0) {
    let propQuery = Property.findById(invoice.propertyId).select('remainingCredit name');
    if (session) propQuery = propQuery.session(session);
    const propertyDoc = await propQuery;
    if (!propertyDoc) {
      throw Object.assign(new Error('Property not found for credit reconciliation'), { status: 404 });
    }

    creditBalanceBefore = roundMoney(Number(propertyDoc.remainingCredit || 0));
    creditBalanceAfter = roundMoney(creditBalanceBefore + returnToPool);

    await Property.findByIdAndUpdate(
      invoice.propertyId,
      { $set: { remainingCredit: creditBalanceAfter } },
      opts
    );

    await new LedgerEntry({
      unitId: invoice.propertyId,
      type: 'adjustment',
      amount: -returnToPool,
      referenceId: invoice._id,
      metadata: {
        reason: 'Invoice amount reduced',
        paymentMethod: 'Credit Adjustment',
        source: `Invoice ${invoice.invoiceId || invoice._id} Update`,
        invoiceId: invoice._id,
        invoiceNumber: invoice.invoiceId,
        previousSubAmount: oldSub,
        newSubAmount: newSub,
        creditReturned: returnToPool,
        creditReturnFromAppliedCredit: creditReturnPortion,
        creditBalanceBefore,
        creditBalanceAfter,
        createdBy: recorderId,
      },
    }).save(opts);

    if (creditReturnPortion > 0) {
      editChanges.push(
        `${formatMoney(creditReturnPortion)} returned to owner's credit balance.`
      );
    }
    if (returnToPool > creditReturnPortion) {
      editChanges.push(
        `${formatMoney(returnToPool - creditReturnPortion)} of overpayment returned to owner's credit balance.`
      );
    }
    editChanges.push(
      `Credit balance updated: ${formatMoney(creditBalanceBefore)} → ${formatMoney(creditBalanceAfter)}.`
    );

    invoice.paymentTransactions = invoice.paymentTransactions || [];
    invoice.paymentTransactions.push({
      amount: returnToPool,
      method: 'Credit Returned',
      note: `Returned ${formatMoney(returnToPool)} to owner credit balance (invoice amount reduced from ${formatMoney(oldSub)} to ${formatMoney(newSub)})`,
      balanceAfter: newBalanceDue,
      paidAt: now,
      recordedAt: now,
      recordedBy: recorderId,
    });
  } else if (newBalanceDue === 0 && newAlreadyPaid < totalPaid) {
    editChanges.push('Applied payments realigned to the reduced invoice amount.');
  }

  return {
    alreadyPaid: newAlreadyPaid,
    balanceDue: newBalanceDue,
    creditReturned: returnToPool,
    creditBalanceBefore,
    creditBalanceAfter,
    appliedCreditBefore: creditApplied,
    appliedCreditAfter: newCreditApplied,
    previousSubAmount: oldSub,
    newSubAmount: newSub,
    editChanges,
    amountIncreased: false,
  };
}

module.exports = {
  reconcileInvoiceCreditOnAmountChange,
  sumCreditAppliedOnInvoice,
  previewCreditReconcileOnReduction,
  computeBalanceAfterAmountEdit,
  roundMoney,
  formatMoney,
};
