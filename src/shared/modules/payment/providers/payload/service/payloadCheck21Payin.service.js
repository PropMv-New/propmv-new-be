'use strict';

/**
 * Production Check21 (board Record Payment → Upload Check).
 * PayloadPayin + webhook spine; never marks invoice Paid on submit.
 */

const crypto = require('crypto');
const mongoose = require('mongoose');
const { ClockService } = require('../../../../../../common/date');
const payloadConfig = require('../../../../../../config/payload.config');
const logger = require('../../../../../../common/logger');
const Invoice = require('../../../../../../portals/hoa-board/modules/invoice/model/invoice.model');
const {
  reconcileInvoiceStoredTotals,
  ensureGatewayProcessingPaymentRecorded,
} = require('../../../../../../portals/hoa-board/modules/invoice/helpers/invoiceProcessingPayment.helper');
const {
  getInvoiceCollectableBalance,
} = require('../../../../../../portals/hoa-board/modules/invoice/helpers/invoicePaymentTransactions.helper');
const {
  assertManualRecordPaymentAllowed,
} = require('../../../../../../portals/hoa-board/modules/invoice/helpers/invoiceManualRecordPayment.helper');
const PayloadPayin = require('../model/payloadPayin.model');
const { PayloadClient } = require('../client/payload.client');
const {
  ensurePayloadEnabled,
  listMerchantAccounts,
  findAccountById,
  assertPayloadMerchantAccess,
} = require('./payloadMerchant.service');
const {
  ENTITY_TYPE,
  MERCHANT_STATUS,
  PAYMENT_METHOD_TYPE,
  PAYIN_STATUS,
  AUDIT_EVENTS,
} = require('../constants/payload.constants');
const {
  roundMoney,
  dollarsToMinorUnits,
  invoiceMethodLabel,
} = require('../utils/payloadPayinSettlement.util');
const {
  buildCheck21MultipartForm,
  sanitizePayloadErrorForLog,
  toCheck21UserFriendlyMessage,
  assertCheck21ImageFile,
  buildCheck21OrderNumber,
} = require('../utils/payloadCheck21.util');
const { buildPayinIdempotencyKey, sanitizePayin } = require('./payloadPayin.service');
const { auditPayload } = require('./payloadAudit.helper');
const { resolvePayloadAccountForDepositBank } = require('../utils/resolvePayloadPayinMerchant.util');

const client = new PayloadClient();

const OPEN_CHECK21_STATUSES = [
  PAYIN_STATUS.CREATED,
  PAYIN_STATUS.PROCESSING,
  PAYIN_STATUS.IN_REVIEW,
];

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function ensureCheck21Enabled() {
  ensurePayloadEnabled();
  if (!payloadConfig.payload.check21Enabled) {
    const err = new Error('Check21 payments are not enabled.');
    err.statusCode = 403;
    throw err;
  }
}

function unwrapTransaction(remote) {
  if (!remote || typeof remote !== 'object') return remote;
  if (remote.data && typeof remote.data === 'object' && !Array.isArray(remote.data)) {
    return remote.data;
  }
  return remote;
}

async function resolveCheck21ProcessingAccount({
  invoice,
  userId,
  businessId,
  accountIdHint = null,
}) {
  const userOid = toObjectId(userId);
  const Property = require('../../../../../../portals/hoa-board/modules/property/model/property.model');

  let property = null;
  let hoaId = invoice.hoaId ? String(invoice.hoaId) : null;
  if (invoice.propertyId) {
    property = await Property.findById(invoice.propertyId)
      .select('hoaId depositBankAccountId')
      .lean();
    if (property?.hoaId) hoaId = String(property.hoaId);
  }
  if (!hoaId) {
    const err = new Error('Invoice HOA context is required for Check21.');
    err.statusCode = 422;
    throw err;
  }

  if (accountIdHint) {
    const account = await findAccountById(accountIdHint);
    assertPayloadMerchantAccess(account, { businessId, userId: userOid });
    if (String(account.metadata?.hoaId || '') !== String(hoaId)
      && String(account.entityId || '') !== String(hoaId)) {
      const err = new Error('Processing account does not belong to this HOA.');
      err.statusCode = 403;
      throw err;
    }
    const processingAccountId = String(account.merchantId || '').trim();
    if (!/^acct_[A-Za-z0-9]+$/.test(processingAccountId)) {
      const err = new Error('Selected merchant is not linked to a Payload processing account.');
      err.statusCode = 422;
      throw err;
    }
    if (
      account.merchantStatus !== MERCHANT_STATUS.ACTIVE
      && account.onboardingStatus !== 'ACTIVE'
    ) {
      const err = new Error('Processing account must be active for Check21.');
      err.statusCode = 422;
      throw err;
    }
    return { account, processingAccountId, hoaId };
  }

  let depositContext = null;
  if (property?.depositBankAccountId) {
    depositContext = await resolvePayloadAccountForDepositBank(property.depositBankAccountId);
  }

  let account = depositContext?.account || null;
  if (!account) {
    const accounts = await listMerchantAccounts({
      entityType: ENTITY_TYPE.HOA,
      createdBy: userOid,
      hoaId: String(hoaId),
    });
    account = accounts.find(
      (row) => row.merchantId
        && String(row.merchantId).startsWith('acct_')
        && (row.merchantStatus === MERCHANT_STATUS.ACTIVE
          || row.onboardingStatus === 'ACTIVE'),
    ) || accounts.find((row) => row.merchantId && String(row.merchantId).startsWith('acct_'));
    if (account) {
      account = await findAccountById(account.id || account._id);
    }
  } else {
    account = await findAccountById(account._id || account.id);
  }

  if (!account) {
    const err = new Error(
      'No Payload processing account is available. Complete HOA Bank Accounts onboarding first.',
    );
    err.statusCode = 422;
    throw err;
  }

  assertPayloadMerchantAccess(account, { businessId, userId: userOid });
  const processingAccountId = String(account.merchantId || '').trim();
  if (!/^acct_[A-Za-z0-9]+$/.test(processingAccountId)) {
    const err = new Error('Selected merchant is not linked to a Payload processing account.');
    err.statusCode = 422;
    throw err;
  }

  return { account, processingAccountId, hoaId };
}

async function claimOpenCheck21Payin({ invoiceId, idempotencyKey }) {
  const openExisting = await PayloadPayin.findOne({
    invoiceId,
    methodType: { $in: [PAYMENT_METHOD_TYPE.CHECK, PAYMENT_METHOD_TYPE.CHECK21] },
    status: { $in: OPEN_CHECK21_STATUSES },
    isDeleted: { $ne: true },
  });
  if (openExisting && openExisting.idempotencyKey !== idempotencyKey) {
    const err = new Error(
      'A Check21 payment is already processing for this invoice. Wait for it to finish before submitting another.',
    );
    err.statusCode = 409;
    err.code = 'CHECK21_OPEN_PAYIN_EXISTS';
    throw err;
  }
  return openExisting;
}

/**
 * Board Upload Check → Payload Check21 Transaction.create (multipart).
 */
async function submitCheck21ForInvoice({
  userId,
  businessId,
  invoiceId,
  proposedAmount,
  paymentAttemptId,
  accountId = null,
  frontFile,
  backFile,
  description = '',
  req = null,
}) {
  ensureCheck21Enabled();

  const userOid = toObjectId(userId);
  const invoiceOid = toObjectId(invoiceId);
  if (!userOid || !invoiceOid) {
    const err = new Error('Invalid Check21 submit request.');
    err.statusCode = 400;
    throw err;
  }

  // Magic-byte + size validation before any DB work
  assertCheck21ImageFile(frontFile, 'Check front');
  assertCheck21ImageFile(backFile, 'Check back');

  const invoice = await Invoice.findOne({ _id: invoiceOid, isDeleted: { $ne: true } });
  if (!invoice) {
    const err = new Error('Invoice not found.');
    err.statusCode = 404;
    throw err;
  }
  await reconcileInvoiceStoredTotals(invoice);

  const collectable = roundMoney(getInvoiceCollectableBalance(invoice));
  const proposed = roundMoney(proposedAmount);
  if (!(proposed > 0) || proposed > collectable + 0.009) {
    const err = new Error(
      collectable <= 0
        ? 'Invoice has no remaining balance.'
        : `Amount must be greater than zero and at most $${collectable.toFixed(2)}.`,
    );
    err.statusCode = 400;
    err.code = 'CHECK21_AMOUNT_INVALID';
    throw err;
  }

  // Same gate family as manual Record Payment (blocks early gateway phase over-allocation)
  await assertManualRecordPaymentAllowed(invoice, proposed);

  const serverAmount = proposed;
  const attemptKey = String(paymentAttemptId || ClockService.nowEpoch());
  const idempotencyKey = buildPayinIdempotencyKey({
    userId: userOid,
    invoiceId: invoiceOid,
    paymentAttemptId: attemptKey,
  });

  const existingByKey = await PayloadPayin.findOne({
    idempotencyKey,
    isDeleted: { $ne: true },
  });
  if (existingByKey?.payinId) {
    return {
      duplicate: true,
      item: sanitizePayin(existingByKey),
      payloadTransactionId: existingByKey.payinId,
      status: existingByKey.status,
      message: 'Check submitted — processing',
    };
  }

  await claimOpenCheck21Payin({ invoiceId: invoiceOid, idempotencyKey });

  const { account, processingAccountId, hoaId } = await resolveCheck21ProcessingAccount({
    invoice,
    userId: userOid,
    businessId,
    accountIdHint: accountId,
  });

  const orderNumber = buildCheck21OrderNumber(invoiceOid, attemptKey);
  const payinConfigId = `${idempotencyKey}_c21`;

  let payinDoc = existingByKey;
  if (!payinDoc) {
    try {
      payinDoc = await PayloadPayin.create({
        payinConfigId,
        merchantId: processingAccountId,
        payloadAccountRef: account._id,
        invoiceId: invoice._id,
        propertyId: invoice.propertyId || null,
        userId: userOid,
        paymentMethodLocalId: null,
        providerPaymentMethodId: `check21:${orderNumber}`,
        methodType: PAYMENT_METHOD_TYPE.CHECK21,
        status: PAYIN_STATUS.CREATED,
        invoicePaymentAmount: serverAmount,
        chargeAmountCents: dollarsToMinorUnits(serverAmount),
        processingFeeAmount: 0,
        processingFeePaidBy: '',
        platformFeeCents: 0,
        currency: 'USD',
        paymentAttemptId: attemptKey,
        idempotencyKey,
        metadata: {
          check21: true,
          orderNumber,
          hoaId: String(hoaId),
          invoiceNumber: invoice.invoiceId || '',
          paymentAttemptId: attemptKey,
        },
      });
    } catch (createErr) {
      if (createErr?.code === 11000) {
        const raced = await PayloadPayin.findOne({ idempotencyKey, isDeleted: { $ne: true } });
        if (raced?.payinId) {
          return {
            duplicate: true,
            item: sanitizePayin(raced),
            payloadTransactionId: raced.payinId,
            status: raced.status,
            message: 'Check submitted — processing',
          };
        }
      }
      throw createErr;
    }
  }

  const { form, meta } = buildCheck21MultipartForm({
    processingAccountId,
    frontFile,
    backFile,
    amount: serverAmount,
    description: description || `Invoice ${invoice.invoiceId || invoice._id} Check21`,
    orderNumber,
    localAttrs: {
      propmv_check21: '1',
      invoiceId: String(invoice._id),
    },
  });

  logger.info('[Check21] Submitting Check21 for invoice', {
    invoiceId: String(invoice._id),
    userId: String(userOid),
    processingAccountId,
    amount: serverAmount,
    orderNumber,
    frontBytes: meta.check_front.bytes,
    backBytes: meta.check_back.bytes,
  });

  let remote;
  try {
    remote = unwrapTransaction(
      await client.createCheck21PaymentTransaction(form, {
        idempotencyKey: `${idempotencyKey}_payload`,
      }),
    );
  } catch (err) {
    payinDoc.status = PAYIN_STATUS.FAILED;
    payinDoc.refusalDesc = toCheck21UserFriendlyMessage(
      err?.statusCode || err?.status || 502,
      err?.message,
      err?.payloadError,
    );
    payinDoc.failedAt = ClockService.now();
    await payinDoc.save();
    logger.warn('[Check21] Payload submit failed', {
      invoiceId: String(invoice._id),
      status: err?.statusCode || err?.status,
      payloadError: sanitizePayloadErrorForLog(err?.payloadError),
    });
    const mapped = new Error(payinDoc.refusalDesc);
    mapped.statusCode = err?.statusCode || err?.status || 502;
    mapped.payloadError = err?.payloadError;
    mapped.isCheck21Error = true;
    throw mapped;
  }

  const payloadTransactionId = String(remote?.id || remote?.transaction_id || '').trim();
  if (!payloadTransactionId) {
    payinDoc.status = PAYIN_STATUS.FAILED;
    payinDoc.refusalDesc = 'Payload did not return a transaction id for Check21 submission.';
    payinDoc.failedAt = ClockService.now();
    await payinDoc.save();
    const err = new Error(payinDoc.refusalDesc);
    err.statusCode = 502;
    err.isCheck21Error = true;
    throw err;
  }

  // Persist remote id first (recovery before invoice sync)
  payinDoc.payinId = payloadTransactionId;
  payinDoc.status = PAYIN_STATUS.PROCESSING;
  payinDoc.raw = {
    id: payloadTransactionId,
    status: remote?.status,
    funding_status: remote?.funding_status,
  };
  payinDoc.metadata = {
    ...(payinDoc.metadata || {}),
    check21: true,
    orderNumber,
    recoveryNeeded: false,
    remoteStatus: remote?.status,
    fundingStatus: remote?.funding_status || null,
  };
  const ocrCheckNumber = remote?.check_number
    || remote?.attrs?.check_number
    || remote?.payment_method?.account_number
    || null;
  if (ocrCheckNumber) {
    payinDoc.metadata.checkNumber = String(ocrCheckNumber).slice(0, 64);
  }
  payinDoc.markModified('metadata');
  await payinDoc.save();

  try {
    await ensureGatewayProcessingPaymentRecorded({
      invoiceId: payinDoc.invoiceId,
      amount: payinDoc.invoicePaymentAmount,
      method: invoiceMethodLabel(payinDoc.methodType),
      paidBy: payinDoc.userId,
      recordedBy: payinDoc.userId,
      gatewayTransactionId: payinDoc._id,
      gatewayExternalId: payloadTransactionId,
      note: description || `Check21 submitted - ${payloadTransactionId}`,
      skipOwnerPaymentAssert: true,
    });
  } catch (syncErr) {
    payinDoc.metadata.recoveryNeeded = true;
    payinDoc.metadata.recoveryError = String(syncErr.message || 'invoice_sync_failed').slice(0, 200);
    payinDoc.markModified('metadata');
    await payinDoc.save();
    logger.error('[Check21] Payload OK but invoice processing sync failed — marked recoveryNeeded', {
      invoiceId: String(invoice._id),
      payinId: payloadTransactionId,
      message: syncErr.message,
    });
  }

  auditPayload({
    event: AUDIT_EVENTS.PAYIN_CREATED,
    entity: 'PayloadPayin',
    entityId: payinDoc._id,
    createdBy: userOid,
    after: {
      payinId: payloadTransactionId,
      invoiceId: String(invoice._id),
      methodType: PAYMENT_METHOD_TYPE.CHECK21,
      amount: serverAmount,
    },
    req,
  });

  return {
    duplicate: false,
    item: sanitizePayin(payinDoc),
    payloadTransactionId,
    status: payinDoc.status,
    message: 'Check submitted — processing',
  };
}

/**
 * Reconcile open Check21 payins (missing webhook / recoveryNeeded).
 */
async function reconcileOpenCheck21Payins({ olderThanMinutes = 15, limit = 50 } = {}) {
  if (!payloadConfig.payload?.enabled || !payloadConfig.payload?.check21Enabled) {
    return { scanned: 0, recovered: 0, reason: 'check21_disabled' };
  }

  const cutoff = new Date(Date.now() - Math.max(1, Number(olderThanMinutes) || 15) * 60 * 1000);
  const rows = await PayloadPayin.find({
    methodType: { $in: [PAYMENT_METHOD_TYPE.CHECK, PAYMENT_METHOD_TYPE.CHECK21] },
    isDeleted: { $ne: true },
    $or: [
      { 'metadata.recoveryNeeded': true, payinId: { $ne: null } },
      {
        status: { $in: OPEN_CHECK21_STATUSES },
        payinId: { $ne: null },
        updatedAt: { $lte: cutoff },
      },
    ],
  })
    .sort({ updatedAt: 1 })
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 200));

  const { applyPayloadPayinLifecycle } = require('./payloadPayin.service');
  let recovered = 0;
  for (const doc of rows) {
    try {
      const remote = unwrapTransaction(await client.getTransaction(doc.payinId));
      if (doc.metadata?.recoveryNeeded) {
        await ensureGatewayProcessingPaymentRecorded({
          invoiceId: doc.invoiceId,
          amount: doc.invoicePaymentAmount,
          method: invoiceMethodLabel(doc.methodType),
          paidBy: doc.userId,
          recordedBy: doc.userId,
          gatewayTransactionId: doc._id,
          gatewayExternalId: doc.payinId,
          note: `Check21 recovery - ${doc.payinId}`,
          skipOwnerPaymentAssert: true,
        }).catch(() => null);
        doc.metadata.recoveryNeeded = false;
        doc.markModified('metadata');
        await doc.save();
      }
      await applyPayloadPayinLifecycle({
        payinDoc: doc,
        remotePayload: remote,
        eventType: 'processed',
        completedAt: remote?.updated_at || remote?.updatedAt,
      });
      recovered += 1;
    } catch (err) {
      logger.warn('[Check21] Reconcile payin failed', {
        payinId: doc.payinId,
        message: err.message,
      });
    }
  }

  return { scanned: rows.length, recovered };
}

module.exports = {
  ensureCheck21Enabled,
  submitCheck21ForInvoice,
  reconcileOpenCheck21Payins,
  resolveCheck21ProcessingAccount,
  claimOpenCheck21Payin,
  OPEN_CHECK21_STATUSES,
};
