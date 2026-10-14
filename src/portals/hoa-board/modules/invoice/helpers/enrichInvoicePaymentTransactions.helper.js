'use strict';

const StraddleTransaction = require('../../../../../shared/modules/payment/model/straddleTransaction.model');
const PaymentStatus = require('../../../../../shared/modules/payment/model/paymentStatus.model');
const RainforestPayin = require('../../../../../shared/modules/payment/providers/rainforest/model/rainforestPayin.model');
const RainforestRefund = require('../../../../../shared/modules/payment/providers/rainforest/model/rainforestRefund.model');
const PayloadPayin = require('../../../../../shared/modules/payment/providers/payload/model/payloadPayin.model');
const { buildRainforestPayinTrackerPayload } = require('../../../../../shared/modules/payment/providers/rainforest/utils/rainforestPayinDisplay.util');
const {
  invoiceMethodLabel,
} = require('../../../../../shared/modules/payment/providers/payload/utils/payloadPayinSettlement.util');
const { buildPayloadPayinTrackerPayload } = require('../../../../../shared/modules/payment/providers/payload/utils/payloadPayinDisplay.util');
const {
  resolveRemotePaymentMethodType,
} = require('../../../../../shared/modules/payment/providers/payload/utils/payloadPaymentMethodType.util');
const logger = require('../../../../../common/logger');

function toPlainTransaction(tx) {
  return tx && typeof tx.toObject === 'function' ? tx.toObject() : { ...(tx || {}) };
}

function attachStraddleData(plain, straddleByAmount, latestStatusByStraddleId) {
  const cents = Math.round(Number(plain.amount) * 100);
  const straddleTransaction = straddleByAmount.get(cents);
  if (!straddleTransaction) return plain;

  const paymentStatus = latestStatusByStraddleId.get(straddleTransaction.straddleId);
  if (!paymentStatus?.data) return plain;

  return {
    ...plain,
    straddleData: {
      status: paymentStatus.data.status,
      status_history: paymentStatus.data.status_history,
      status_details: paymentStatus.data.status_details,
      payment_rail: paymentStatus.data.payment_rail,
      paykey: paymentStatus.data.paykey,
      customer_details: paymentStatus.data.customer_details,
    },
  };
}

function resolvePayloadPayinMethodType(payin = {}) {
  const fromRaw = resolveRemotePaymentMethodType(payin.raw || {});
  if (fromRaw) return fromRaw;
  return String(payin.methodType || '').trim();
}

function attachPayloadData(plain, payins = []) {
  if (!Array.isArray(payins) || payins.length === 0) return plain;

  const gatewayTransactionId = plain.gatewayTransactionId
    ? String(plain.gatewayTransactionId)
    : '';
  const gatewayExternalId = plain.gatewayExternalId
    ? String(plain.gatewayExternalId)
    : '';

  let payin = null;
  if (gatewayTransactionId) {
    payin = payins.find((row) => String(row._id) === gatewayTransactionId) || null;
  }
  if (!payin && gatewayExternalId) {
    payin = payins.find((row) => {
      const payinId = String(row.payinId || '');
      const configId = String(row.payinConfigId || '');
      return (payinId && payinId === gatewayExternalId)
        || (configId && configId === gatewayExternalId);
    }) || null;
  }
  if (!payin) {
    const cents = Math.round(Number(plain.amount) * 100);
    payin = payins.find((row) => Number(row.invoicePaymentAmount || 0) * 100 === cents) || null;
  }

  if (!payin) return plain;

  const methodType = resolvePayloadPayinMethodType(payin);
  const method = methodType ? invoiceMethodLabel(methodType) : plain.method;
  const payloadData = buildPayloadPayinTrackerPayload(payin);

  return {
    ...plain,
    method: method || plain.method,
    payloadData,
  };
}

function attachRainforestData(plain, payins = [], refunds = []) {
  if (!Array.isArray(payins) || payins.length === 0) return plain;

  const gatewayTransactionId = plain.gatewayTransactionId
    ? String(plain.gatewayTransactionId)
    : '';
  const gatewayExternalId = plain.gatewayExternalId
    ? String(plain.gatewayExternalId)
    : '';
  const paymentTransactionId = plain._id ? String(plain._id) : '';

  let payin = null;
  if (gatewayTransactionId) {
    payin = payins.find((row) => String(row._id) === gatewayTransactionId) || null;
  }
  if (!payin && gatewayExternalId) {
    payin = payins.find((row) => String(row.payinId || '') === gatewayExternalId) || null;
  }
  if (!payin) {
    const cents = Math.round(Number(plain.amount) * 100);
    payin = payins.find((row) => Number(row.invoicePaymentAmount || 0) * 100 === cents) || null;
  }

  if (!payin) return plain;

  const paymentRefunds = Array.isArray(refunds)
    ? refunds.filter((row) => {
      const txId = row.paymentTransactionId ? String(row.paymentTransactionId) : '';
      return txId && paymentTransactionId && txId === paymentTransactionId;
    })
    : [];
  const latestRefund = paymentRefunds.sort(
    (a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0)
  )[0] || null;

  return {
    ...plain,
    rainforestData: {
      ...buildRainforestPayinTrackerPayload(payin),
      refund: latestRefund
        ? {
          refundId: latestRefund.refundId || null,
          status: latestRefund.status || null,
          voidOrRefundType: latestRefund.voidOrRefundType || null,
          invoiceRefundAmount: latestRefund.invoiceRefundAmount ?? null,
          completedAt: latestRefund.completedAt || null,
          failedAt: latestRefund.failedAt || null,
        }
        : null,
    },
  };
}

async function enrichInvoicePaymentTransactions(invoiceId, paymentTransactions = []) {
  const rows = Array.isArray(paymentTransactions) ? paymentTransactions : [];
  if (rows.length === 0) return [];

  const plainRows = rows.map(toPlainTransaction);

  try {
    const amountCentsSet = new Set(
      rows.map((tx) => Math.round(Number(tx.amount) * 100))
    );
    const amountCents = [...amountCentsSet].filter((n) => Number.isFinite(n));

    const [straddleTransactions, rainforestPayins, rainforestRefunds, payloadPayins] = await Promise.all([
      amountCents.length
        ? StraddleTransaction.find({
          invoiceId,
          amount: { $in: amountCents },
        }).lean()
        : [],
      RainforestPayin.find({
        invoiceId,
        isDeleted: { $ne: true },
      }).lean(),
      RainforestRefund.find({
        invoiceId,
        isDeleted: { $ne: true },
      }).lean(),
      PayloadPayin.find({
        invoiceId,
        isDeleted: { $ne: true },
      }).lean(),
    ]);

    const straddleByAmount = new Map();
    for (const st of straddleTransactions) {
      if (!straddleByAmount.has(st.amount)) {
        straddleByAmount.set(st.amount, st);
      }
    }

    const straddleIds = straddleTransactions
      .map((st) => st.straddleId)
      .filter(Boolean);

    const paymentStatuses = straddleIds.length
      ? await PaymentStatus.find({ 'data.id': { $in: straddleIds } })
        .sort({ createdAt: -1 })
        .lean()
      : [];

    const latestStatusByStraddleId = new Map();
    for (const status of paymentStatuses) {
      const id = status?.data?.id;
      if (id && !latestStatusByStraddleId.has(id)) {
        latestStatusByStraddleId.set(id, status);
      }
    }

    return plainRows.map((plain) => {
      const withStraddle = attachStraddleData(plain, straddleByAmount, latestStatusByStraddleId);
      const withPayload = attachPayloadData(withStraddle, payloadPayins);
      return attachRainforestData(withPayload, rainforestPayins, rainforestRefunds);
    });
  } catch (err) {
    logger.error('[invoice] Error enriching payment transactions:', err);
    return plainRows;
  }
}

module.exports = {
  enrichInvoicePaymentTransactions,
};
