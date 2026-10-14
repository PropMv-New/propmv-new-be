const { INVOICE_STATUS } = require('../../../../../common/constants/invoice');
const Invoice = require('../model/invoice.model');
const Property = require('../../property/model/property.model');
const StraddleTransaction = require('../../../../../shared/modules/payment/model/straddleTransaction.model');
const ledgerService = require('../../owners/services/ledger.service');
const { logActivity } = require('../../dashboard/service/activity.service');
const { recalculateInvoiceStatus } = require('./invoicePaymentReversal.helper');
const { ClockService, DateUtil } = require('../../../../../common/date');
const {
  roundMoney,
  activePaymentTransactions,
  recalculateInvoiceTotalsFromTransactions,
  getInvoiceCollectableBalance,
  removeStaleDuplicateGatewayProcessingRows,
  PAYMENT_TX_STATUS,
  isProcessingPaymentTransaction,
  isCompletedPaymentTransaction,
} = require('./invoicePaymentTransactions.helper');

const GATEWAY_SETTLED_STATUSES = new Set(['paid', 'completed', 'succeeded', 'settled']);
const GATEWAY_FAILED_STATUSES = new Set(['failed', 'cancelled', 'canceled', 'reversed', 'returned']);

function isGatewayPaymentSettledStatus(status) {
  return GATEWAY_SETTLED_STATUSES.has(String(status || '').toLowerCase());
}

function isGatewayPaymentFailedStatus(status) {
  return GATEWAY_FAILED_STATUSES.has(String(status || '').toLowerCase());
}

function normalizeDepositBankLabel(name) {
  return String(name || '').trim();
}

async function snapshotDepositBankFromProperty(propertyId) {
  if (!propertyId) return null;
  const property = await Property.findById(propertyId)
    .select('depositBankAccountId depositBankAccountName')
    .lean();
  if (!property?.depositBankAccountId) return null;
  return {
    depositBankAccountId: property.depositBankAccountId,
    depositBankAccountName: normalizeDepositBankLabel(property.depositBankAccountName),
  };
}

async function lockInvoiceDepositBankFromUnit(invoiceDoc) {
  if (!invoiceDoc || invoiceDoc.depositBankLocked) return;
  const unitBank = await snapshotDepositBankFromProperty(invoiceDoc.propertyId);
  if (!unitBank?.depositBankAccountId) return;
  invoiceDoc.depositBankAccountId = unitBank.depositBankAccountId;
  invoiceDoc.depositBankAccountName = unitBank.depositBankAccountName;
  invoiceDoc.depositBankLocked = true;
}

function recalculateInvoiceStatusAfterGateway(invoice) {
  if (roundMoney(invoice.processingAmount || 0) > 0) {
    invoice.status = INVOICE_STATUS.PROCESSING;
    return;
  }
  recalculateInvoiceStatus(invoice);
  if (invoice.status === INVOICE_STATUS.PAID) {
    invoice.paidOn = invoice.paidOn || ClockService.now();
  }
}

function findProcessingTransactionForGateway(invoice, { gatewayTransactionId, gatewayExternalId } = {}) {
  const externalId = String(gatewayExternalId || '').trim();
  const gatewayId = gatewayTransactionId ? String(gatewayTransactionId) : '';

  return activePaymentTransactions(invoice).find((tx) => {
    if (!isProcessingPaymentTransaction(tx)) return false;
    if (externalId && String(tx.gatewayExternalId || '') === externalId) return true;
    if (gatewayId && tx.gatewayTransactionId && String(tx.gatewayTransactionId) === gatewayId) return true;
    return false;
  }) || null;
}

function hasCompletedGatewayTransaction(invoice, { gatewayExternalId, gatewayTransactionId } = {}) {
  const linked = findGatewayPaymentTransaction(invoice, { gatewayExternalId, gatewayTransactionId });
  return linked ? isCompletedPaymentTransaction(linked) : false;
}

async function logGatewaySettlementActivity(invoice, amount, method) {
  const property = await Property.findById(invoice.propertyId).select('name').lean();
  const propertyName = property?.name || 'Unknown Property';
  const userId = invoice.paymentTransactions?.find((tx) => tx.amount === amount)?.paidBy || undefined;

  await logActivity({
    userId,
    action: 'PAYMENT_SUCCESS',
    module: 'Invoice',
    entityId: invoice._id,
    entityName: 'HOA Invoice',
    description: `Online payment received for ${propertyName} · $${roundMoney(amount).toFixed(2)} via ${method || 'ACH'}`,
    meta: {
      type: invoice.type,
      amount: invoice.subAmount,
      propertyName,
      source: 'gateway_webhook',
    },
  });
}

function hasActiveProcessingPayment(invoice) {
  return activePaymentTransactions(invoice).some(isProcessingPaymentTransaction);
}

function resolveGatewayPaymentActor(tx) {
  return tx?.paidBy || tx?.recordedBy || null;
}

function resolveGatewayPaymentTransactionId(tx) {
  if (tx?._id) return String(tx._id);
  return String(tx?.gatewayExternalId || tx?.gatewayTransactionId || '');
}

/**
 * Owner gateway settlement uses the same email + in-app payment notifications
 * as board-recorded payments. Returns null when there is nothing to notify.
 */
function buildGatewayPaymentSettledNotification({
  invoice,
  processingTx,
  settledAmount,
  completedAt,
} = {}) {
  const amount = roundMoney(settledAmount);
  if (!invoice || amount <= 0) return null;

  const paidAt = processingTx?.paidAt || completedAt;
  const recordedAt = processingTx?.completedAt || completedAt || paidAt;
  const recordedByUserId = resolveGatewayPaymentActor(processingTx);
  const paymentTransactionId = resolveGatewayPaymentTransactionId(processingTx);

  return {
    emailPayload: {
      invoice,
      paymentAmount: amount,
      paymentMethod: processingTx?.method || 'ACH',
      balanceAfter: invoice.balanceDue,
      paidAt,
      recordedAt,
      recordedByUserId,
      paymentTransactionId,
    },
    inApp: {
      invoice,
      actorUserId: recordedByUserId,
      amount,
      eventSuffix: paymentTransactionId || String(amount),
    },
  };
}

function notifyGatewayPaymentSettledInBackground(args = {}) {
  const built = buildGatewayPaymentSettledNotification(args);
  if (!built) return false;
  try {
    const { notifyPaymentRecordedInBackground } = require('../../../../../common/helpers/invoiceLifecycleEmail.service');
    const { notifyPaymentReceivedInAppInBackground } = require('../../../../../common/helpers/hoaInAppNotify.helper');
    notifyPaymentRecordedInBackground(built.emailPayload);
    notifyPaymentReceivedInAppInBackground(
      built.inApp.invoice,
      built.inApp.actorUserId,
      built.inApp.amount,
      built.inApp.eventSuffix
    );
  } catch (err) {
    const logger = require('../../../../../common/logger');
    logger.error('[invoice] gateway payment notify failed:', err?.message || err);
  }
  return true;
}

/**
 * Notify owners/board when an electronic payment enters Processing.
 * Uses invoice-updated email (not payment-recorded) so settlement can still
 * send the payment-recorded notice without idempotency collision.
 */
function notifyGatewayPaymentProcessingInBackground({
  invoice,
  processingTx,
  amount,
} = {}) {
  const paymentAmount = roundMoney(amount != null ? amount : processingTx?.amount);
  if (!invoice || paymentAmount <= 0) return false;

  const actorUserId = resolveGatewayPaymentActor(processingTx);
  const paymentTransactionId = resolveGatewayPaymentTransactionId(processingTx);
  const methodLabel = processingTx?.method || 'electronic payment';
  const amountLabel = `$${paymentAmount.toFixed(2)}`;

  try {
    const { notifyInvoiceUpdatedInBackground } = require('../../../../../common/helpers/invoiceLifecycleEmail.service');
    const { notifyPaymentProcessingInAppInBackground } = require('../../../../../common/helpers/hoaInAppNotify.helper');
    notifyInvoiceUpdatedInBackground({
      invoice,
      recordedByUserId: actorUserId,
      activityIntro:
        `An electronic payment of ${amountLabel} via ${methodLabel} is being processed for your invoice.`,
      changeDescriptions: [
        `Electronic payment of ${amountLabel} submitted (${methodLabel}).`,
        'Funds will post to the invoice once the payment settles.',
      ],
      occurredAt: processingTx?.paidAt || processingTx?.recordedAt || undefined,
    });
    notifyPaymentProcessingInAppInBackground(
      invoice,
      actorUserId,
      paymentAmount,
      paymentTransactionId || String(paymentAmount)
    );
  } catch (err) {
    const logger = require('../../../../../common/logger');
    logger.error('[invoice] gateway processing notify failed:', err?.message || err);
  }
  return true;
}

function notifyGatewayPaymentFailedInBackground({
  invoice,
  processingTx,
  failedAmount,
  failedAt,
  failureReason = '',
} = {}) {
  const amount = roundMoney(failedAmount != null ? failedAmount : processingTx?.amount);
  if (!invoice || amount <= 0) return false;

  const actorUserId = resolveGatewayPaymentActor(processingTx);
  const paymentTransactionId = resolveGatewayPaymentTransactionId(processingTx);

  try {
    const { notifyPaymentFailedInBackground } = require('../../../../../common/helpers/invoiceNotificationEmailHelper');
    const { notifyPaymentFailedInAppInBackground } = require('../../../../../common/helpers/hoaInAppNotify.helper');
    notifyPaymentFailedInBackground({
      invoice,
      paymentAmount: amount,
      failureReason: failureReason || processingTx?.note || '',
      failedAt: failedAt || processingTx?.completedAt || undefined,
      paymentTransactionId,
    });
    notifyPaymentFailedInAppInBackground(
      invoice,
      actorUserId,
      amount,
      paymentTransactionId || String(amount)
    );
  } catch (err) {
    const logger = require('../../../../../common/logger');
    logger.error('[invoice] gateway payment failed notify failed:', err?.message || err);
  }
  return true;
}

function notifyGatewayPaymentReversedInBackground({
  invoice,
  gatewayTx,
  refundAmount,
  refundedAt,
  recordedBy,
} = {}) {
  const amount = roundMoney(refundAmount);
  if (!invoice || amount <= 0) return false;

  const actorUserId = recordedBy || resolveGatewayPaymentActor(gatewayTx);
  const paymentTransactionId = resolveGatewayPaymentTransactionId(gatewayTx);

  try {
    const { notifyPaymentDeletedInBackground } = require('../../../../../common/helpers/invoiceLifecycleEmail.service');
    const { notifyPaymentDeletedInAppInBackground } = require('../../../../../common/helpers/hoaInAppNotify.helper');
    notifyPaymentDeletedInBackground({
      invoice,
      paymentAmount: amount,
      paymentMethod: gatewayTx?.method || 'Payment',
      paidAt: gatewayTx?.paidAt || undefined,
      deletedAt: refundedAt || undefined,
      recordedByUserId: actorUserId,
      paymentTransactionId: paymentTransactionId
        ? `refund:${paymentTransactionId}:${amount}`
        : undefined,
    });
    notifyPaymentDeletedInAppInBackground(
      invoice,
      actorUserId,
      amount,
      paymentTransactionId ? `refund:${paymentTransactionId}:${amount}` : String(amount)
    );
  } catch (err) {
    const logger = require('../../../../../common/logger');
    logger.error('[invoice] gateway refund notify failed:', err?.message || err);
  }
  return true;
}

function sumProcessingAmount(invoice) {
  return roundMoney(
    activePaymentTransactions(invoice)
      .filter(isProcessingPaymentTransaction)
      .reduce((sum, tx) => sum + Number(tx.amount || 0), 0)
  );
}

/**
 * Record an in-flight gateway payment on the invoice.
 * @returns {Promise<object|null>} Updated invoice document or null if skipped
 */
async function initiateInvoiceProcessingPayment({
  invoiceId,
  amount,
  method,
  paidBy,
  recordedBy,
  gatewayTransactionId,
  gatewayExternalId,
  note,
  skipOwnerPaymentAssert = false,
  skipNotify = false,
}) {
  const paymentAmount = roundMoney(amount);
  if (!invoiceId || paymentAmount <= 0) return null;

  const invoice = await Invoice.findOne({ _id: invoiceId, isDeleted: { $ne: true } });
  if (!invoice) return null;
  if (invoice.status === INVOICE_STATUS.PAID) return null;

  const linkedGatewayTx = findGatewayPaymentTransaction(invoice, {
    gatewayTransactionId,
    gatewayExternalId,
  });
  if (linkedGatewayTx) {
    return invoice;
  }

  // Allow supplemental online payments when a prior payment is still in-flight
  // but the invoice still has remaining balance (partial Processing). Only block
  // when the invoice is fully covered by processing cash (balanceDue = 0).
  const remainingBeforePayment = getInvoiceCollectableBalance(invoice);
  if (hasActiveProcessingPayment(invoice) && remainingBeforePayment <= 0.009) {
    const err = new Error('A payment is already being processed for this invoice.');
    err.statusCode = 409;
    throw err;
  }

  if (!skipOwnerPaymentAssert) {
    try {
      await ledgerService.assertOwnerOnlinePaymentAllowed(invoice, paymentAmount);
    } catch (validationErr) {
      const err = new Error(validationErr.message || 'Payment validation failed');
      err.statusCode = validationErr.status || validationErr.statusCode || 400;
      throw err;
    }
  }

  const openBalance = getInvoiceCollectableBalance(invoice);
  const appliedAmount = roundMoney(Math.min(paymentAmount, openBalance > 0 ? openBalance : 0));
  if (appliedAmount <= 0) {
    const err = new Error('Payment amount cannot exceed your total outstanding generated invoice balance.');
    err.statusCode = 400;
    throw err;
  }

  const now = ClockService.now();
  const projectedProcessing = roundMoney(Number(invoice.processingAmount || 0) + appliedAmount);
  const projectedBalance = roundMoney(
    Math.max(
      0,
      Number(invoice.subAmount || 0)
      - Number(invoice.alreadyPaid || 0)
      - projectedProcessing
      - Number(invoice.waivedAmount || 0)
    )
  );

  invoice.paymentTransactions.push({
    amount: appliedAmount,
    method: method || 'ACH',
    isManual: false,
    status: PAYMENT_TX_STATUS.PROCESSING,
    gatewayTransactionId: gatewayTransactionId || undefined,
    gatewayExternalId: gatewayExternalId || '',
    paidBy: paidBy || undefined,
    recordedBy: recordedBy || paidBy || undefined,
    note: note || '',
    balanceAfter: projectedBalance,
    paidAt: now,
    recordedAt: now,
  });

  const totals = recalculateInvoiceTotalsFromTransactions(invoice);
  invoice.processingAmount = totals.processingAmount;
  invoice.alreadyPaid = totals.alreadyPaid;
  invoice.balanceDue = totals.balanceDue;
  invoice.status = INVOICE_STATUS.PROCESSING;
  invoice.updatedBy = recordedBy || paidBy || invoice.updatedBy;

  await invoice.save();

  if (!skipNotify) {
    const createdTx = invoice.paymentTransactions[invoice.paymentTransactions.length - 1];
    notifyGatewayPaymentProcessingInBackground({
      invoice,
      processingTx: createdTx,
      amount: appliedAmount,
    });
  }

  return invoice;
}

/**
 * Idempotent wrapper for gateway-initiated processing rows (Payload / Rainforest payins).
 */
async function ensureGatewayProcessingPaymentRecorded({
  invoiceId,
  amount,
  method,
  paidBy,
  recordedBy,
  gatewayTransactionId,
  gatewayExternalId,
  note,
  skipOwnerPaymentAssert = false,
  skipNotify = false,
}) {
  const paymentAmount = roundMoney(amount);
  if (!invoiceId || paymentAmount <= 0) {
    return { recorded: false, reason: 'invalid_input' };
  }

  const invoice = await Invoice.findOne({ _id: invoiceId, isDeleted: { $ne: true } });
  if (!invoice) return { recorded: false, reason: 'invoice_not_found' };
  if (invoice.status === INVOICE_STATUS.PAID) {
    return { recorded: false, reason: 'already_paid' };
  }

  removeStaleDuplicateGatewayProcessingRows(invoice);

  const linkedGatewayTx = findGatewayPaymentTransaction(invoice, {
    gatewayTransactionId,
    gatewayExternalId,
  });
  if (linkedGatewayTx) {
    if (isProcessingPaymentTransaction(linkedGatewayTx)) {
      return { recorded: true, duplicate: true };
    }
    if (isCompletedPaymentTransaction(linkedGatewayTx)) {
      return { recorded: true, duplicate: true, completed: true };
    }
  }

  await initiateInvoiceProcessingPayment({
    invoiceId,
    amount: paymentAmount,
    method,
    paidBy,
    recordedBy,
    gatewayTransactionId,
    gatewayExternalId,
    note,
    skipOwnerPaymentAssert,
    skipNotify,
  });

  return { recorded: true, duplicate: false };
}

async function reconcileInvoiceStoredTotals(invoice) {
  if (!invoice?._id) return invoice;
  removeStaleDuplicateGatewayProcessingRows(invoice);
  const totals = recalculateInvoiceTotalsFromTransactions(invoice);
  const storedBalance = roundMoney(invoice.balanceDue || 0);
  const storedPaid = roundMoney(invoice.alreadyPaid || 0);
  const storedProcessing = roundMoney(invoice.processingAmount || 0);
  const drift =
    Math.abs(storedBalance - totals.balanceDue) > 0.009
    || Math.abs(storedPaid - totals.alreadyPaid) > 0.009
    || Math.abs(storedProcessing - totals.processingAmount) > 0.009;
  if (!drift) return invoice;

  invoice.processingAmount = totals.processingAmount;
  invoice.alreadyPaid = totals.alreadyPaid;
  invoice.balanceDue = totals.balanceDue;
  if (typeof invoice.save === 'function') {
    await invoice.save();
  }
  return invoice;
}

/**
 * Mark all in-flight processing transactions as completed and recalculate invoice totals.
 * @returns {number} Total amount moved from processing to paid
 */
function completeProcessingPaymentsOnInvoice(invoice, { recordedBy, completedAt } = {}) {
  const now = DateUtil.toUTC(completedAt) || ClockService.now();
  let completedTotal = 0;

  for (const tx of invoice.paymentTransactions || []) {
    if (!isProcessingPaymentTransaction(tx)) continue;
    tx.status = PAYMENT_TX_STATUS.COMPLETED;
    tx.completedAt = now;
    if (recordedBy) tx.recordedBy = recordedBy;
    completedTotal += Number(tx.amount || 0);
  }

  const totals = recalculateInvoiceTotalsFromTransactions(invoice);
  invoice.processingAmount = totals.processingAmount;
  invoice.alreadyPaid = totals.alreadyPaid;
  invoice.balanceDue = totals.balanceDue;

  return roundMoney(completedTotal);
}

/**
 * Settle a processing gateway payment when Straddle reports success (webhook).
 */
async function settleInvoiceGatewayPayment({
  straddleId,
  payinId,
  status,
  invoiceId: metadataInvoiceId,
  gatewayTransactionId,
  completedAt,
}) {
  if (!isGatewayPaymentSettledStatus(status) && status !== 'settled') {
    return { settled: false, reason: 'not_settled_status' };
  }

  const externalId = payinId || straddleId;
  let rainforestTx = null;
  let payloadTx = null;
  if (payinId) {
    const RainforestPayin = require('../../../../../shared/modules/payment/providers/rainforest/model/rainforestPayin.model');
    rainforestTx = await RainforestPayin.findOne({ payinId: String(payinId) }).lean();
    if (!rainforestTx) {
      const PayloadPayin = require('../../../../../shared/modules/payment/providers/payload/model/payloadPayin.model');
      payloadTx = await PayloadPayin.findOne({ payinId: String(payinId), isDeleted: { $ne: true } }).lean();
    }
  }

  const straddleTx = !rainforestTx && !payloadTx && straddleId
    ? await StraddleTransaction.findOne({ straddleId }).lean()
    : null;
  const gatewayDoc = rainforestTx || payloadTx || straddleTx;
  const invoiceId =
    metadataInvoiceId
    || rainforestTx?.invoiceId
    || rainforestTx?.metadata?.invoiceId
    || payloadTx?.invoiceId
    || straddleTx?.invoiceId
    || straddleTx?.metadata?.invoiceId
    || straddleTx?.metadata?.invoice_id;

  if (!invoiceId) return { settled: false, reason: 'no_invoice' };

  const invoice = await Invoice.findOne({ _id: invoiceId, isDeleted: { $ne: true } });
  if (!invoice) return { settled: false, reason: 'invoice_not_found' };

  if (hasCompletedGatewayTransaction(invoice, { gatewayExternalId: externalId })) {
    return { settled: false, reason: 'already_settled', duplicate: true };
  }

  const gatewayTxId = gatewayTransactionId || gatewayDoc?._id;
  let processingTx = findProcessingTransactionForGateway(invoice, {
    gatewayTransactionId: gatewayTxId,
    gatewayExternalId: externalId,
  });

  // Repair missing in-flight rows (e.g. Rainforest immediate SUCCEEDED skipped initiate).
  // Skip processing notify here — settlement notify is the user-facing confirmation.
  if (!processingTx) {
    const repairAmount = roundMoney(
      rainforestTx?.invoicePaymentAmount
      || payloadTx?.invoicePaymentAmount
      || (straddleTx?.amount != null
        ? (Number(straddleTx.amount) >= 100 ? Number(straddleTx.amount) / 100 : Number(straddleTx.amount))
        : 0)
    );
    if (repairAmount > 0) {
      try {
        const methodType = String(rainforestTx?.methodType || payloadTx?.methodType || '').toLowerCase();
        await ensureGatewayProcessingPaymentRecorded({
          invoiceId: invoice._id,
          amount: repairAmount,
          method: methodType.includes('card') ? 'card' : 'ACH',
          paidBy: rainforestTx?.userId || payloadTx?.userId || straddleTx?.createdBy || undefined,
          recordedBy: rainforestTx?.userId || payloadTx?.userId || straddleTx?.createdBy || undefined,
          gatewayTransactionId: gatewayTxId,
          gatewayExternalId: externalId,
          note: `Auto-repaired processing payment before settlement - ${externalId || invoice._id}`,
          skipOwnerPaymentAssert: true,
          skipNotify: true,
        });
        const refreshed = await Invoice.findOne({ _id: invoiceId, isDeleted: { $ne: true } });
        if (refreshed) {
          invoice.paymentTransactions = refreshed.paymentTransactions;
          invoice.processingAmount = refreshed.processingAmount;
          invoice.alreadyPaid = refreshed.alreadyPaid;
          invoice.balanceDue = refreshed.balanceDue;
          invoice.status = refreshed.status;
          processingTx = findProcessingTransactionForGateway(invoice, {
            gatewayTransactionId: gatewayTxId,
            gatewayExternalId: externalId,
          });
        }
      } catch (repairErr) {
        const logger = require('../../../../../common/logger');
        logger.warn('[invoice] settle repair failed:', repairErr?.message || repairErr);
      }
    }
  }

  if (!processingTx) {
    return { settled: false, reason: 'no_processing_tx' };
  }

  const now = completedAt ? DateUtil.toUTC(completedAt) : ClockService.now();
  processingTx.status = PAYMENT_TX_STATUS.COMPLETED;
  processingTx.completedAt = now;

  const totals = recalculateInvoiceTotalsFromTransactions(invoice);
  invoice.processingAmount = totals.processingAmount;
  invoice.alreadyPaid = totals.alreadyPaid;
  invoice.balanceDue = totals.balanceDue;
  processingTx.balanceAfter = totals.balanceDue;

  recalculateInvoiceStatusAfterGateway(invoice);
  await lockInvoiceDepositBankFromUnit(invoice);

  if (invoice.status === INVOICE_STATUS.PARTIALLY_PAID) {
    const unitBank = await snapshotDepositBankFromProperty(invoice.propertyId);
    if (unitBank?.depositBankAccountId) {
      invoice.balanceDepositBankAccountId = unitBank.depositBankAccountId;
      invoice.balanceDepositBankAccountName = unitBank.depositBankAccountName;
    }
  }

  await invoice.save();

  try {
    const { schedulePayloadAutopayMirrorSync } = require('../../../../../shared/modules/payment/providers/payload/helpers/schedulePayloadAutopayMirrorSync');
    schedulePayloadAutopayMirrorSync(invoice._id, { reason: 'gateway_settled' });
  } catch (_) { /* autopay optional */ }

  const settledAmount = roundMoney(processingTx.amount || 0);
  if (settledAmount > 0) {
    await ledgerService.recordPayment(invoice.propertyId, settledAmount, invoice._id, {
      source: 'gateway_webhook',
      invoiceId: invoice._id,
      invoiceNumber: invoice.invoiceId,
      paymentMethod: processingTx.method || 'ACH',
      paymentNotes: processingTx.note || '',
      paidBy: processingTx.paidBy || undefined,
      balanceAfter: totals.balanceDue,
      paidAt: processingTx.paidAt || now,
      gatewayExternalId: externalId || undefined,
    });
    await logGatewaySettlementActivity(invoice, settledAmount, processingTx.method);
    notifyGatewayPaymentSettledInBackground({
      invoice,
      processingTx,
      settledAmount,
      completedAt: now,
    });
    if (invoice.propertyId) {
      await ledgerService.applyAllUnappliedCreditToDueInvoices(invoice.propertyId);
    }
  }

  return {
    settled: true,
    invoiceId: String(invoice._id),
    amount: settledAmount,
    status: invoice.status,
  };
}

/**
 * Mark a processing gateway payment failed/cancelled and restore invoice balances.
 */
async function failInvoiceGatewayPayment({
  straddleId,
  payinId,
  invoiceId: metadataInvoiceId,
  gatewayTransactionId,
  failedAt,
}) {
  const externalId = payinId || straddleId;
  let rainforestTx = null;
  let payloadTx = null;
  if (payinId) {
    const RainforestPayin = require('../../../../../shared/modules/payment/providers/rainforest/model/rainforestPayin.model');
    rainforestTx = await RainforestPayin.findOne({ payinId: String(payinId) }).lean();
    if (!rainforestTx) {
      const PayloadPayin = require('../../../../../shared/modules/payment/providers/payload/model/payloadPayin.model');
      payloadTx = await PayloadPayin.findOne({ payinId: String(payinId), isDeleted: { $ne: true } }).lean();
    }
  }

  const straddleTx = !rainforestTx && !payloadTx && straddleId
    ? await StraddleTransaction.findOne({ straddleId }).lean()
    : null;
  const invoiceId =
    metadataInvoiceId
    || rainforestTx?.invoiceId
    || rainforestTx?.metadata?.invoiceId
    || payloadTx?.invoiceId
    || straddleTx?.invoiceId
    || straddleTx?.metadata?.invoiceId
    || straddleTx?.metadata?.invoice_id;

  if (!invoiceId) return { failed: false, reason: 'no_invoice' };

  const invoice = await Invoice.findOne({ _id: invoiceId, isDeleted: { $ne: true } });
  if (!invoice) return { failed: false, reason: 'invoice_not_found' };

  const processingTx = findProcessingTransactionForGateway(invoice, {
    gatewayTransactionId: gatewayTransactionId || rainforestTx?._id || payloadTx?._id || straddleTx?._id,
    gatewayExternalId: externalId,
  });

  if (!processingTx) {
    return { failed: false, reason: 'no_processing_tx', duplicate: true };
  }

  const now = failedAt ? DateUtil.toUTC(failedAt) : ClockService.now();
  processingTx.status = PAYMENT_TX_STATUS.FAILED;
  processingTx.completedAt = now;

  const totals = recalculateInvoiceTotalsFromTransactions(invoice);
  invoice.processingAmount = totals.processingAmount;
  invoice.alreadyPaid = totals.alreadyPaid;
  invoice.balanceDue = totals.balanceDue;

  recalculateInvoiceStatusAfterGateway(invoice);
  await invoice.save();

  try {
    const { schedulePayloadAutopayMirrorSync } = require('../../../../../shared/modules/payment/providers/payload/helpers/schedulePayloadAutopayMirrorSync');
    schedulePayloadAutopayMirrorSync(invoice._id, { reason: 'gateway_failed' });
  } catch (_) { /* autopay optional */ }

  const failedAmount = roundMoney(processingTx.amount || 0);
  if (failedAmount > 0) {
    notifyGatewayPaymentFailedInBackground({
      invoice,
      processingTx,
      failedAmount,
      failedAt: now,
      failureReason: processingTx.note || '',
    });
  }

  return {
    failed: true,
    invoiceId: String(invoice._id),
    amount: failedAmount,
    status: invoice.status,
  };
}

function findGatewayPaymentTransaction(invoice, { gatewayTransactionId, gatewayExternalId } = {}) {
  const externalId = String(gatewayExternalId || '').trim();
  const gatewayId = gatewayTransactionId ? String(gatewayTransactionId) : '';

  return activePaymentTransactions(invoice).find((tx) => {
    if (externalId && String(tx.gatewayExternalId || '') === externalId) return true;
    if (gatewayId && tx.gatewayTransactionId && String(tx.gatewayTransactionId) === gatewayId) return true;
    return false;
  }) || null;
}

/**
 * Reverse a settled Rainforest gateway payment after void/refund succeeds.
 * Supports full and partial refunds via refundedAmount / refundedAt on the payment row.
 */
async function reverseInvoiceGatewayPayment({
  payinId,
  refundId,
  invoiceId: metadataInvoiceId,
  gatewayTransactionId,
  refundAmount,
  refundedAt,
  recordedBy,
  note,
}) {
  const externalPayinId = payinId ? String(payinId) : '';
  let rainforestTx = null;
  if (externalPayinId) {
    const RainforestPayin = require('../../../../../shared/modules/payment/providers/rainforest/model/rainforestPayin.model');
    rainforestTx = await RainforestPayin.findOne({ payinId: externalPayinId, isDeleted: { $ne: true } }).lean();
  }

  const invoiceId =
    metadataInvoiceId
    || rainforestTx?.invoiceId
    || rainforestTx?.metadata?.invoiceId;

  if (!invoiceId) return { reversed: false, reason: 'no_invoice' };

  const invoice = await Invoice.findOne({ _id: invoiceId, isDeleted: { $ne: true } });
  if (!invoice) return { reversed: false, reason: 'invoice_not_found' };

  const gatewayTx = findGatewayPaymentTransaction(invoice, {
    gatewayTransactionId: gatewayTransactionId || rainforestTx?._id,
    gatewayExternalId: externalPayinId,
  });

  if (!gatewayTx) {
    return { reversed: false, reason: 'no_gateway_tx', duplicate: true };
  }

  if (refundId && String(gatewayTx.note || '').includes(String(refundId))) {
    return { reversed: false, reason: 'already_reversed', duplicate: true };
  }

  const grossAmount = roundMoney(gatewayTx.amount || 0);
  const priorRefunded = roundMoney(gatewayTx.refundedAmount || 0);
  const requested = roundMoney(
    refundAmount != null ? refundAmount : Math.max(0, grossAmount - priorRefunded)
  );
  const remainingRefundable = roundMoney(Math.max(0, grossAmount - priorRefunded));

  if (requested <= 0 || requested > remainingRefundable + 0.009) {
    return { reversed: false, reason: 'invalid_refund_amount' };
  }

  const now = refundedAt ? DateUtil.toUTC(refundedAt) : ClockService.now();
  gatewayTx.refundedAmount = roundMoney(priorRefunded + requested);
  if (gatewayTx.refundedAmount + 0.009 >= grossAmount) {
    gatewayTx.refundedAt = now;
  }
  if (refundId) {
    gatewayTx.refundExternalId = String(refundId);
  }
  if (note) {
    gatewayTx.note = gatewayTx.note
      ? `${gatewayTx.note} | ${note}`
      : note;
  }

  const totals = recalculateInvoiceTotalsFromTransactions(invoice);
  invoice.processingAmount = totals.processingAmount;
  invoice.alreadyPaid = totals.alreadyPaid;
  invoice.balanceDue = totals.balanceDue;
  gatewayTx.balanceAfter = totals.balanceDue;

  recalculateInvoiceStatusAfterGateway(invoice);

  invoice.editHistory = invoice.editHistory || [];
  invoice.editHistory.push({
    changes: [
      'Rainforest Refund',
      `$${requested.toFixed(2)} refunded for invoice payment${refundId ? ` (${refundId})` : ''}.`,
      `Updated balance due: $${totals.balanceDue.toFixed(2)}.`,
    ],
    editedBy: recordedBy && String(recordedBy).length === 24
      ? recordedBy
      : undefined,
    editedAt: ClockService.now(),
  });

  await invoice.save();

  if (invoice.propertyId && requested > 0) {
    const LedgerEntry = require('../../owners/models/ledgerEntry.model');
    await new LedgerEntry({
      unitId: invoice.propertyId,
      type: 'adjustment',
      amount: requested,
      referenceId: invoice._id,
      metadata: {
        source: 'rainforest_refund',
        refundId: refundId || undefined,
        payinId: externalPayinId || undefined,
        invoiceId: String(invoice._id),
        invoiceNumber: invoice.invoiceId || '',
        paymentTransactionId: gatewayTx._id ? String(gatewayTx._id) : undefined,
        refundedAmount: requested,
      },
    }).save();

    await ledgerService.applyAllUnappliedCreditToDueInvoices(invoice.propertyId);
  }

  if (requested > 0) {
    notifyGatewayPaymentReversedInBackground({
      invoice,
      gatewayTx,
      refundAmount: requested,
      refundedAt: now,
      recordedBy,
    });
  }

  return {
    reversed: true,
    invoiceId: String(invoice._id),
    amount: requested,
    totalRefunded: roundMoney(gatewayTx.refundedAmount || 0),
    status: invoice.status,
  };
}

/**
 * Backfill a processing transaction for legacy Processing invoices (no embedded tx).
 */
async function backfillLegacyProcessingPayment(invoice, straddleTx) {
  if (!invoice || !straddleTx) return { backfilled: false, reason: 'missing_input' };
  if (hasActiveProcessingPayment(invoice)) return { backfilled: false, reason: 'already_has_processing_tx' };

  const chargeCents = Number(straddleTx.amount || 0);
  const chargeDollars = roundMoney(chargeCents >= 100 ? chargeCents / 100 : chargeCents);
  if (chargeDollars <= 0) return { backfilled: false, reason: 'invalid_amount' };

  const openBalance = roundMoney(
    Math.max(
      0,
      Number(invoice.subAmount || 0)
      - Number(invoice.alreadyPaid || 0)
      - Number(invoice.waivedAmount || 0)
    )
  );
  const appliedAmount = roundMoney(Math.min(chargeDollars, openBalance > 0 ? openBalance : chargeDollars));
  if (appliedAmount <= 0) return { backfilled: false, reason: 'nothing_to_apply' };

  const initiatedAt = straddleTx.createdAt ? DateUtil.toUTC(straddleTx.createdAt) : ClockService.now();
  const projectedBalance = roundMoney(
    Math.max(0, Number(invoice.subAmount || 0) - Number(invoice.alreadyPaid || 0) - appliedAmount - Number(invoice.waivedAmount || 0))
  );

  invoice.paymentTransactions.push({
    amount: appliedAmount,
    method: 'ACH',
    isManual: false,
    status: PAYMENT_TX_STATUS.PROCESSING,
    gatewayTransactionId: straddleTx._id,
    gatewayExternalId: straddleTx.straddleId || '',
    paidBy: straddleTx.createdBy || undefined,
    recordedBy: straddleTx.createdBy || undefined,
    note: `Backfilled processing payment - ${straddleTx.straddleId || straddleTx._id}`,
    balanceAfter: projectedBalance,
    paidAt: initiatedAt,
    recordedAt: initiatedAt,
  });

  const totals = recalculateInvoiceTotalsFromTransactions(invoice);
  invoice.processingAmount = totals.processingAmount;
  invoice.alreadyPaid = totals.alreadyPaid;
  invoice.balanceDue = totals.balanceDue;
  invoice.status = INVOICE_STATUS.PROCESSING;

  await invoice.save();
  return { backfilled: true, amount: appliedAmount, invoiceId: String(invoice._id) };
}

module.exports = {
  GATEWAY_SETTLED_STATUSES,
  GATEWAY_FAILED_STATUSES,
  isGatewayPaymentSettledStatus,
  isGatewayPaymentFailedStatus,
  isProcessingPaymentTransaction,
  hasActiveProcessingPayment,
  sumProcessingAmount,
  initiateInvoiceProcessingPayment,
  buildGatewayPaymentSettledNotification,
  notifyGatewayPaymentSettledInBackground,
  notifyGatewayPaymentProcessingInBackground,
  notifyGatewayPaymentFailedInBackground,
  notifyGatewayPaymentReversedInBackground,
  ensureGatewayProcessingPaymentRecorded,
  reconcileInvoiceStoredTotals,
  completeProcessingPaymentsOnInvoice,
  settleInvoiceGatewayPayment,
  failInvoiceGatewayPayment,
  reverseInvoiceGatewayPayment,
  findGatewayPaymentTransaction,
  backfillLegacyProcessingPayment,
  findProcessingTransactionForGateway,
  recalculateInvoiceStatusAfterGateway,
};
