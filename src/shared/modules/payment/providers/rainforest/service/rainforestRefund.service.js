'use strict';

const mongoose = require('mongoose');
const { ClockService } = require('../../../../../../common/date');
const RainforestRefund = require('../model/rainforestRefund.model');
const RainforestPayin = require('../model/rainforestPayin.model');
const Invoice = require('../../../../../../portals/hoa-board/modules/invoice/model/invoice.model');
const HOAMembership = require('../../../../../../portals/hoa-board/modules/hoa/model/hoaMembership.model');
const { RainforestClient } = require('../client/rainforest.client');
const { ensureRainforestEnabled } = require('./rainforestMerchant.service');
const { reverseInvoiceGatewayPayment } = require('../../../../../../portals/hoa-board/modules/invoice/helpers/invoiceProcessingPayment.helper');
const {
  isElectronicPaymentTransaction,
  isCompletedPaymentTransaction,
  isProcessingPaymentTransaction,
} = require('../../../../../../portals/hoa-board/modules/invoice/helpers/invoicePaymentTransactions.helper');
const {
  AUDIT_EVENTS,
  REFUND_STATUS,
  REFUND_VOID_TYPE,
  REFUND_REASON,
} = require('../constants/rainforest.constants');
const {
  roundMoney,
} = require('../utils/rainforestPayinSettlement.util');
const {
  normalizeRefundStatus,
  resolveRainforestRefundLifecycleAction,
  buildRefundIdempotencyKey,
  mapInvoiceRefundToPayinMinorUnits,
  remainingInvoiceRefundableAmount,
} = require('../utils/rainforestRefundSettlement.util');
const { buildRainforestRefundAmountSplits } = require('../utils/rainforestPayinFee.util');
const { isHOABoardMemberRole } = require('../../../../../../common/helpers/hoaBoardRole');
const { ROLE_NAMES } = require('../../../../../../common/constants/roleNames');
const { auditRainforest } = require('./rainforestAudit.helper');
const logger = require('../../../../../../common/logger');

const client = new RainforestClient();

const ACTIVE_REFUND_STATUSES = new Set([
  REFUND_STATUS.CREATED,
  REFUND_STATUS.PROCESSING,
]);

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function sanitizeRefund(row) {
  if (!row) return null;
  const doc = typeof row.toObject === 'function' ? row.toObject() : row;
  return {
    id: String(doc._id),
    refundId: doc.refundId || null,
    payinId: doc.payinId,
    invoiceId: doc.invoiceId ? String(doc.invoiceId) : null,
    paymentTransactionId: doc.paymentTransactionId ? String(doc.paymentTransactionId) : null,
    merchantId: doc.merchantId,
    voidOrRefundType: doc.voidOrRefundType || REFUND_VOID_TYPE.REFUND,
    status: doc.status,
    reason: doc.reason || REFUND_REASON.REQUESTED_BY_CUSTOMER,
    invoiceRefundAmount: roundMoney(doc.invoiceRefundAmount),
    amountCents: doc.amountCents,
    currency: doc.currency || 'USD',
    refundAttemptId: doc.refundAttemptId || '',
    completedAt: doc.completedAt || null,
    failedAt: doc.failedAt || null,
    refusalCode: doc.refusalCode || '',
    refusalDesc: doc.refusalDesc || '',
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

async function assertBoardRefundAccess(userId, invoice, req) {
  const userOid = toObjectId(userId);
  if (!userOid) {
    const err = new Error('Invalid user context.');
    err.statusCode = 400;
    throw err;
  }

  const roleName = req?.user?.userRoleName || req?.userRoleName || '';
  if (
    roleName === ROLE_NAMES.PROPERTY_MANAGER
    || roleName === 'Landlord'
    || req?.user?.isAdministrator
  ) {
    return;
  }

  if (isHOABoardMemberRole(roleName)) {
    const membershipQuery = {
      userId: userOid,
      status: 'active',
    };
    if (invoice?.hoaId) {
      membershipQuery.hoaId = invoice.hoaId;
    }
    const membership = await HOAMembership.findOne(membershipQuery).lean();
    if (membership) return;
  }

  const err = new Error('You do not have permission to refund this payment.');
  err.statusCode = 403;
  throw err;
}

async function resolvePayinForPaymentTransaction(invoice, paymentTx) {
  const gatewayTxId = paymentTx?.gatewayTransactionId
    ? String(paymentTx.gatewayTransactionId)
    : '';
  const gatewayExtId = paymentTx?.gatewayExternalId
    ? String(paymentTx.gatewayExternalId)
    : '';

  if (gatewayTxId && mongoose.Types.ObjectId.isValid(gatewayTxId)) {
    const byLocal = await RainforestPayin.findOne({
      _id: gatewayTxId,
      isDeleted: { $ne: true },
    }).lean();
    if (byLocal) return byLocal;
  }

  if (gatewayExtId) {
    const byPayinId = await RainforestPayin.findOne({
      payinId: gatewayExtId,
      isDeleted: { $ne: true },
    }).lean();
    if (byPayinId) return byPayinId;

    const byConfig = await RainforestPayin.findOne({
      payinConfigId: gatewayExtId,
      invoiceId: invoice._id,
      isDeleted: { $ne: true },
    }).sort({ createdAt: -1 }).lean();
    if (byConfig) return byConfig;
  }

  if (gatewayTxId && mongoose.Types.ObjectId.isValid(gatewayTxId)) {
    return RainforestPayin.findOne({
      _id: gatewayTxId,
      invoiceId: invoice._id,
      isDeleted: { $ne: true },
    }).lean();
  }

  return null;
}

async function syncRefundRecordFromRemote(doc, remote = {}, responseData = {}) {
  if (!doc) return null;

  const payload = { ...responseData, ...remote };
  doc.refundId = payload.refund_id || payload.refundId || doc.refundId;
  doc.status = normalizeRefundStatus(payload.status || payload.refund_status || doc.status);
  doc.voidOrRefundType = payload.type || payload.void_or_refund_type || doc.voidOrRefundType;
  doc.amountCents = Number(
    payload.amount != null ? payload.amount : doc.amountCents
  );
  doc.refusalCode = payload.refusal_code || payload.refusalCode || doc.refusalCode || '';
  doc.refusalDesc = payload.refusal_desc || payload.refusalDesc || doc.refusalDesc || '';
  doc.raw = payload;
  doc.lastWebhookAt = ClockService.now();
  await doc.save();
  return doc;
}

async function completeRefundOnInvoice(refundDoc, remotePayload = {}) {
  if (!refundDoc) return { completed: false, reason: 'missing_refund' };

  if (
    refundDoc.status === REFUND_STATUS.SUCCEEDED
    && refundDoc.completedAt
  ) {
    return { completed: false, duplicate: true, reason: 'already_completed' };
  }

  const result = await reverseInvoiceGatewayPayment({
    payinId: refundDoc.payinId,
    refundId: refundDoc.refundId,
    invoiceId: refundDoc.invoiceId,
    gatewayTransactionId: refundDoc.paymentTransactionId,
    refundAmount: refundDoc.invoiceRefundAmount,
    refundedAt: remotePayload.updated_at || remotePayload.updatedAt,
    recordedBy: refundDoc.requestedBy,
    note: refundDoc.refundId
      ? `Rainforest refund completed (${refundDoc.refundId})`
      : 'Rainforest refund completed',
  });

  refundDoc.status = REFUND_STATUS.SUCCEEDED;
  refundDoc.completedAt = ClockService.now();
  refundDoc.failedAt = null;
  refundDoc.lastWebhookAt = ClockService.now();
  await refundDoc.save();

  auditRainforest({
    event: AUDIT_EVENTS.REFUND_COMPLETED,
    entity: 'RainforestRefund',
    entityId: refundDoc._id,
    after: {
      refundId: refundDoc.refundId,
      invoiceId: String(refundDoc.invoiceId),
      amount: refundDoc.invoiceRefundAmount,
      reversed: !!result.reversed,
    },
  });

  return { completed: true, result };
}

async function requestInvoicePaymentRefund({
  userId,
  invoiceId,
  paymentTransactionId,
  amount,
  reason,
  refundAttemptId,
  req = null,
}) {
  ensureRainforestEnabled();

  const userOid = toObjectId(userId);
  const invoiceOid = toObjectId(invoiceId);
  const paymentTxOid = toObjectId(paymentTransactionId);
  if (!userOid || !invoiceOid || !paymentTxOid) {
    const err = new Error('Invalid refund request.');
    err.statusCode = 400;
    throw err;
  }

  const invoice = await Invoice.findOne({ _id: invoiceOid, isDeleted: { $ne: true } });
  if (!invoice) {
    const err = new Error('Invoice not found.');
    err.statusCode = 404;
    throw err;
  }

  await assertBoardRefundAccess(userOid, invoice, req);

  const paymentTx = (invoice.paymentTransactions || []).id(paymentTxOid);
  if (!paymentTx || paymentTx.isDeleted) {
    const err = new Error('Payment record not found.');
    err.statusCode = 404;
    throw err;
  }

  if (!isElectronicPaymentTransaction(paymentTx)) {
    const err = new Error('Only electronic Rainforest payments can be refunded through this action.');
    err.statusCode = 400;
    throw err;
  }

  const payin = await resolvePayinForPaymentTransaction(invoice, paymentTx);
  if (!payin?.payinId) {
    const err = new Error('This payment is not linked to a Rainforest payin.');
    err.statusCode = 400;
    throw err;
  }

  const remainingRefundable = remainingInvoiceRefundableAmount(paymentTx);
  if (remainingRefundable <= 0) {
    const err = new Error('This payment has already been fully refunded.');
    err.statusCode = 409;
    throw err;
  }

  const isProcessingPayment = isProcessingPaymentTransaction(paymentTx);
  const isCompletedPayment = isCompletedPaymentTransaction(paymentTx);
  if (!isProcessingPayment && !isCompletedPayment) {
    const err = new Error('Only completed or in-flight Rainforest payments can be voided or refunded.');
    err.statusCode = 400;
    throw err;
  }

  const requestedInvoiceAmount = roundMoney(
    amount != null ? amount : remainingRefundable
  );

  if (requestedInvoiceAmount <= 0 || requestedInvoiceAmount > remainingRefundable + 0.009) {
    const err = new Error('Refund amount exceeds the remaining refundable balance for this payment.');
    err.statusCode = 400;
    throw err;
  }

  if (
    isProcessingPayment
    && requestedInvoiceAmount + 0.009 < remainingRefundable
  ) {
    const err = new Error('In-flight Rainforest payments can only be voided in full.');
    err.statusCode = 400;
    throw err;
  }

  const normalizedReason = Object.values(REFUND_REASON).includes(reason)
    ? reason
    : REFUND_REASON.REQUESTED_BY_CUSTOMER;

  const attemptKey = String(refundAttemptId || ClockService.nowEpoch());
  const idempotencyKey = buildRefundIdempotencyKey({
    userId: userOid,
    invoiceId: invoiceOid,
    paymentTransactionId: paymentTxOid,
    refundAttemptId: attemptKey,
  });

  const existing = await RainforestRefund.findOne({
    idempotencyKey,
    isDeleted: { $ne: true },
  });
  if (existing) {
    return {
      duplicate: true,
      item: sanitizeRefund(existing),
    };
  }

  const pendingRefund = await RainforestRefund.findOne({
    invoiceId: invoice._id,
    paymentTransactionId: paymentTx._id,
    status: { $in: [...ACTIVE_REFUND_STATUSES] },
    isDeleted: { $ne: true },
  });
  if (pendingRefund) {
    const err = new Error('A refund is already in progress for this payment.');
    err.statusCode = 409;
    throw err;
  }

  const isFullRefund = requestedInvoiceAmount + 0.009 >= remainingRefundable;
  const amountCents = isFullRefund
    ? 0
    : mapInvoiceRefundToPayinMinorUnits(requestedInvoiceAmount, payin);
  const refundChargeCents = isFullRefund
    ? Number(payin.chargeAmountCents || 0)
    : amountCents;
  const refundAmountSplits = buildRainforestRefundAmountSplits(payin, refundChargeCents);

  let refundDoc = await RainforestRefund.create({
    payinId: payin.payinId,
    payinLocalId: payin._id,
    invoiceId: invoice._id,
    paymentTransactionId: paymentTx._id,
    merchantId: payin.merchantId,
    requestedBy: userOid,
    voidOrRefundType: isProcessingPayment ? REFUND_VOID_TYPE.VOID : REFUND_VOID_TYPE.REFUND,
    status: REFUND_STATUS.CREATED,
    reason: normalizedReason,
    invoiceRefundAmount: requestedInvoiceAmount,
    amountCents: isFullRefund ? Number(payin.chargeAmountCents || 0) : amountCents,
    currency: payin.currency || 'USD',
    idempotencyKey,
    refundAttemptId: attemptKey,
    metadata: {
      invoiceId: String(invoice._id),
      paymentTransactionId: String(paymentTx._id),
      refundAttemptId: attemptKey,
    },
  });

  auditRainforest({
    event: AUDIT_EVENTS.REFUND_REQUESTED,
    entity: 'RainforestRefund',
    entityId: refundDoc._id,
    createdBy: userOid,
    after: {
      payinId: payin.payinId,
      invoiceId: String(invoice._id),
      paymentTransactionId: String(paymentTx._id),
      invoiceRefundAmount: requestedInvoiceAmount,
    },
    req,
  });

  let remoteResponse;
  try {
    const voidOrRefundPayload = {
      idempotency_key: idempotencyKey,
      amount: amountCents,
      reason: normalizedReason,
      metadata: {
        invoiceId: String(invoice._id),
        paymentTransactionId: String(paymentTx._id),
        refundAttemptId: attemptKey,
        propmv_refund_id: String(refundDoc._id),
        propmv_user_id: String(userOid),
      },
    };
    if (refundAmountSplits) {
      voidOrRefundPayload.amount_splits = refundAmountSplits;
    }

    remoteResponse = await client.voidOrRefundPayin(
      payin.payinId,
      voidOrRefundPayload,
      { idempotencyKey }
    );
  } catch (err) {
    refundDoc.status = REFUND_STATUS.FAILED;
    refundDoc.failedAt = ClockService.now();
    refundDoc.refusalDesc = err.message || 'Rainforest refund request failed.';
    await refundDoc.save();

    auditRainforest({
      event: AUDIT_EVENTS.REFUND_FAILED,
      entity: 'RainforestRefund',
      entityId: refundDoc._id,
      success: false,
      failureReason: refundDoc.refusalDesc,
    });

    throw err;
  }

  const responseData = remoteResponse?.data || remoteResponse || {};
  const responseType = String(responseData.type || responseData.void_or_refund_type || '').toUpperCase();
  refundDoc.voidOrRefundType = responseType === REFUND_VOID_TYPE.VOID
    ? REFUND_VOID_TYPE.VOID
    : REFUND_VOID_TYPE.REFUND;
  refundDoc.refundId = responseData.refund_id || responseData.refundId || refundDoc.refundId;
  refundDoc.status = normalizeRefundStatus(
    responseData.refund_status
    || responseData.status
    || (responseType === REFUND_VOID_TYPE.VOID ? REFUND_STATUS.SUCCEEDED : REFUND_STATUS.PROCESSING)
  );
  refundDoc.amountCents = Number(
    responseData.amount != null ? responseData.amount : refundDoc.amountCents
  );
  refundDoc.raw = responseData;
  await refundDoc.save();

  auditRainforest({
    event: AUDIT_EVENTS.REFUND_STATUS_UPDATED,
    entity: 'RainforestRefund',
    entityId: refundDoc._id,
    after: {
      refundId: refundDoc.refundId,
      status: refundDoc.status,
      voidOrRefundType: refundDoc.voidOrRefundType,
    },
  });

  if (
    refundDoc.voidOrRefundType === REFUND_VOID_TYPE.REFUND
    && refundDoc.refundId
    && resolveRainforestRefundLifecycleAction({
      status: refundDoc.status,
    }) === 'complete'
  ) {
    await completeRefundOnInvoice(refundDoc, responseData);
  }

  return {
    duplicate: false,
    item: sanitizeRefund(refundDoc),
  };
}

async function applyRefundWebhookUpdate({
  refundId,
  remotePayload = {},
  eventType = '',
}) {
  const externalRefundId = String(refundId || remotePayload.refund_id || remotePayload.refundId || '').trim();
  if (!externalRefundId) {
    return { processed: false, reason: 'missing_refund_id' };
  }

  let doc = await RainforestRefund.findOne({
    refundId: externalRefundId,
    isDeleted: { $ne: true },
  });

  if (!doc) {
    const metadata = remotePayload.metadata || {};
    const payinId = remotePayload.payin_id || remotePayload.payinId || '';
    const paymentTransactionId = metadata.paymentTransactionId || metadata.payment_transaction_id;
    const invoiceId = metadata.invoiceId || metadata.invoice_id;

    if (payinId && invoiceId && paymentTransactionId) {
      doc = await RainforestRefund.findOne({
        payinId: String(payinId),
        invoiceId,
        paymentTransactionId,
        isDeleted: { $ne: true },
      }).sort({ createdAt: -1 });
      if (doc && !doc.refundId) {
        doc.refundId = externalRefundId;
        await doc.save();
      }
    }
  }

  if (!doc) {
    logger.warn('[RainforestRefund] Webhook refund not linked locally', {
      refundId: externalRefundId,
      eventType,
    });
    return { processed: false, reason: 'refund_not_found' };
  }

  await syncRefundRecordFromRemote(doc, remotePayload);

  const action = resolveRainforestRefundLifecycleAction({
    status: doc.status,
    eventType,
  });

  if (action === 'complete') {
    const result = await completeRefundOnInvoice(doc, remotePayload);
    return { processed: true, action: 'complete', result };
  }

  if (action === 'fail') {
    doc.failedAt = ClockService.now();
    await doc.save();
    auditRainforest({
      event: AUDIT_EVENTS.REFUND_FAILED,
      entity: 'RainforestRefund',
      entityId: doc._id,
      success: false,
      failureReason: doc.refusalDesc || doc.status,
      after: {
        refundId: doc.refundId,
        status: doc.status,
      },
    });
    return { processed: true, action: 'fail' };
  }

  auditRainforest({
    event: AUDIT_EVENTS.REFUND_STATUS_UPDATED,
    entity: 'RainforestRefund',
    entityId: doc._id,
    after: {
      refundId: doc.refundId,
      status: doc.status,
      eventType,
    },
  });

  return { processed: true, action: 'none', status: doc.status };
}

async function getRefundForBoard({ userId, refundRef, req = null }) {
  ensureRainforestEnabled();

  const userOid = toObjectId(userId);
  if (!userOid) {
    const err = new Error('Invalid user context.');
    err.statusCode = 400;
    throw err;
  }

  const ref = String(refundRef || '').trim();
  let doc = null;
  if (mongoose.Types.ObjectId.isValid(ref) && ref.length === 24) {
    doc = await RainforestRefund.findOne({ _id: ref, isDeleted: { $ne: true } });
  }
  if (!doc) {
    doc = await RainforestRefund.findOne({ refundId: ref, isDeleted: { $ne: true } });
  }
  if (!doc) {
    const err = new Error('Rainforest refund not found.');
    err.statusCode = 404;
    throw err;
  }

  const invoice = await Invoice.findOne({ _id: doc.invoiceId, isDeleted: { $ne: true } }).lean();
  if (!invoice) {
    const err = new Error('Invoice not found.');
    err.statusCode = 404;
    throw err;
  }

  await assertBoardRefundAccess(userOid, invoice, req);

  if (doc.refundId) {
    try {
      const remote = await client.getRefund(doc.refundId);
      await syncRefundRecordFromRemote(doc, remote?.data || remote || {});
    } catch (err) {
      logger.warn('[RainforestRefund] Remote refresh failed', {
        refundId: doc.refundId,
        message: err.message,
      });
    }
  }

  return sanitizeRefund(doc);
}

module.exports = {
  requestInvoicePaymentRefund,
  applyRefundWebhookUpdate,
  getRefundForBoard,
  sanitizeRefund,
  buildRefundIdempotencyKey,
  mapInvoiceRefundToPayinMinorUnits,
  remainingInvoiceRefundableAmount,
};
