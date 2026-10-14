'use strict';

/**
 * Phase 4/5 — Owner/Board → Vendor electronic payment engine.
 *
 * Amount rule: invoicePaymentAmount + PropMV convenience fee (same billing settings as HOA Owner pay).
 * Settlement authority: resolvePayloadPayinSettlementAction only.
 * Default deposit bank only — no first-bank fallback.
 * Execute does not create/update payer PMs or Vendor deposit methods.
 * Charge processing_id / processing_method_id are always Vendor — never HOA rails.
 */

const crypto = require('crypto');
const mongoose = require('mongoose');
const payloadConfig = require('../../../../../../config/payload.config');
const logger = require('../../../../../../common/logger');
const { PayloadClient } = require('../client/payload.client');
const PayloadVendorPayin = require('../model/payloadVendorPayin.model');
const PayloadPaymentMethod = require('../model/payloadPaymentMethod.model');
const PayloadUser = require('../model/payloadUser.model');
const PayloadAccount = require('../model/payloadAccount.model');
const {
  ENTITY_TYPE,
  MERCHANT_ONBOARDING_STATUS,
  PAYMENT_METHOD_STATUS,
  PAYMENT_METHOD_TYPE,
} = require('../constants/payload.constants');
const {
  resolvePayloadPayinSettlementAction,
  mapPayloadTransactionToPayinFields,
  dollarsToMinorUnits,
  roundMoney,
  invoiceMethodLabel,
  PAYIN_STATUS,
  isCardLikeMethodType,
} = require('../utils/payloadPayinSettlement.util');
const {
  buildPayloadTransactionChargeBody,
  classifyPayloadPaymentMethodScope,
  isInvalidPayloadChargeCustomerId,
} = require('../utils/payloadPayinCharge.util');
const { buildHoaOwnerPayloadScopeKey } = require('../utils/payloadHoaOwnerCustomerContext.util');
const { calculatePayloadProcessingFee } = require('../utils/payloadPayinFee.util');
const {
  normalizeBillingSettings,
} = require('../../../../billing-settings/service/billingSettings.service');
const BillingSettings = require('../../../../billing-settings/model/billingSettings.model');
const {
  findVendorPayloadAccount,
  isDepositBankEligible,
} = require('./payloadVendorEligibility.service');
const {
  PayloadDepositMethod,
} = require('../model/payloadDepositMethod.model');
function gatewayHelper() {
  // Lazy so gate runners can stub exports before first settlement call.
  // eslint-disable-next-line global-require
  return require('../../../../../../portals/hoa-board/modules/vendor-invoice/helpers/vendorInvoiceGatewayPayment.helper');
}

const IN_FLIGHT_STATUSES = new Set([
  PAYIN_STATUS.CREATED,
  PAYIN_STATUS.PROCESSING,
  PAYIN_STATUS.IN_REVIEW,
]);

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function assertVendorPayEnabled() {
  if (!payloadConfig.payload.enabled) {
    const err = new Error('Payload payments are not enabled.');
    err.statusCode = 403;
    err.code = 'PAYLOAD_DISABLED';
    throw err;
  }
  if (!payloadConfig.payload.vendorMerchantEnabled) {
    const err = new Error('Vendor Payload merchant mode is not enabled.');
    err.statusCode = 403;
    err.code = 'VENDOR_MERCHANT_DISABLED';
    throw err;
  }
  if (!payloadConfig.payload.vendorPayEnabled) {
    const err = new Error('Vendor electronic pay is not enabled.');
    err.statusCode = 403;
    err.code = 'VENDOR_PAY_DISABLED';
    throw err;
  }
}

function getVendorInvoiceService() {
  // eslint-disable-next-line global-require
  return require('../../../../../../portals/hoa-board/modules/vendor-invoice/service/vendorInvoice.service');
}

function buildVendorPayinIdempotencyKey({ userId, vendorInvoiceId, paymentAttemptId }) {
  const seed = [
    String(userId || ''),
    String(vendorInvoiceId || ''),
    String(paymentAttemptId || ''),
    'vendor_payin',
  ].join('|');
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 48);
}

async function resolveVendorPayBillingSettings(hoaId) {
  const oid = toObjectId(hoaId);
  if (!oid) return normalizeBillingSettings();
  const doc = await BillingSettings.findOne({ hoaId: oid }).lean();
  return normalizeBillingSettings(doc);
}

/**
 * Authoritative vendor pay amount calculation — used by validate, execute, persist, settle, UI.
 * When methodType is omitted (legacy callers), fee stays 0.
 */
async function resolveVendorPayinAmounts(invoicePaymentAmount, options = {}) {
  const amount = roundMoney(invoicePaymentAmount);
  if (!(amount > 0)) {
    const err = new Error('Payment amount must be greater than zero.');
    err.statusCode = 400;
    err.code = 'INVALID_AMOUNT';
    throw err;
  }

  const methodType = options.methodType
    ? String(options.methodType).toUpperCase()
    : null;
  if (!methodType) {
    return {
      invoicePaymentAmount: amount,
      chargeAmountDollars: amount,
      chargeAmountCents: dollarsToMinorUnits(amount),
      processingFeeAmount: 0,
      processingFeePaidBy: '',
      platformFeeCents: 0,
    };
  }

  const billingSettings = options.billingSettings
    || await resolveVendorPayBillingSettings(options.hoaId);
  const feeQuote = calculatePayloadProcessingFee({
    invoicePaymentAmount: amount,
    methodType,
    billingSettings,
    applyFee: true,
  });

  return {
    invoicePaymentAmount: feeQuote.invoicePaymentAmount,
    chargeAmountDollars: feeQuote.chargeAmount,
    chargeAmountCents: dollarsToMinorUnits(feeQuote.chargeAmount),
    processingFeeAmount: feeQuote.processingFeeAmount,
    processingFeePaidBy: feeQuote.processingFeePaidBy || '',
    platformFeeCents: feeQuote.platformFeeCents || 0,
  };
}

/**
 * Default deposit bank only — never first-eligible fallback.
 */
async function resolveRequiredDefaultDepositBank(account) {
  if (!account?._id) return null;
  return PayloadDepositMethod.findOne({
    payloadAccountRef: account._id,
    isDeleted: { $ne: true },
    $or: [{ defaultDepositMethod: true }, { isPrimaryPayout: true }],
  }).sort({ defaultDepositMethod: -1, isPrimaryPayout: -1, updatedAt: -1 });
}

async function sumInFlightElectronic(vendorInvoiceId) {
  const rows = await PayloadVendorPayin.find({
    vendorInvoiceId: toObjectId(vendorInvoiceId),
    isDeleted: { $ne: true },
    status: { $in: [...IN_FLIGHT_STATUSES] },
    settledAt: null,
  }).select('invoicePaymentAmount status').lean();
  return roundMoney(rows.reduce((sum, r) => sum + Number(r.invoicePaymentAmount || 0), 0));
}

async function assertCollectableAllowsPayment({ invoice, invoicePaymentAmount }) {
  const subAmount = roundMoney(invoice.subAmount);
  const amountPaid = roundMoney(invoice.amountPaid);
  const inFlight = await sumInFlightElectronic(invoice._id);
  const next = roundMoney(amountPaid + inFlight + invoicePaymentAmount);
  if (next > subAmount + 0.001) {
    const err = new Error(
      `Payment exceeds collectable balance (paid ${amountPaid} + in-flight ${inFlight} + new ${invoicePaymentAmount} > ${subAmount}).`,
    );
    err.statusCode = 409;
    err.code = 'VENDOR_INVOICE_OVERPAY';
    err.details = { amountPaid, inFlightElectronic: inFlight, invoicePaymentAmount, subAmount };
    throw err;
  }
  return {
    amountPaid,
    inFlightElectronic: inFlight,
    subAmount,
    remainingCollectable: roundMoney(subAmount - amountPaid - inFlight),
  };
}

/**
 * Electronic pay auth (Phase 5):
 * - Assigned Owner, or
 * - HOA Board Member for the invoice's HOA (mirrors Record Payment scope).
 * Non-assignee Owners, wrong-HOA Board, Vendor, and unauthorized users are denied.
 */
function assertVendorPayPayerAuthorized({ invoice, actorId, hoaContext = null }) {
  const assigneeId = String(invoice.assignedTo?._id || invoice.assignedTo || '');
  const actor = String(actorId || '');
  if (assigneeId && actor === assigneeId) {
    return { payerRole: 'owner' };
  }

  const isBoard = Boolean(hoaContext?.isHOABoardMember);
  const invoiceHoa = invoice.hoaId ? String(invoice.hoaId._id || invoice.hoaId) : '';
  const ctxHoa = hoaContext?.hoaId ? String(hoaContext.hoaId) : '';

  if (isBoard) {
    if (!invoiceHoa || !ctxHoa) {
      const err = new Error('HOA Board context is required to electronically pay this Vendor invoice.');
      err.statusCode = 403;
      err.code = 'VENDOR_PAY_BOARD_HOA_CONTEXT_REQUIRED';
      throw err;
    }
    if (invoiceHoa !== ctxHoa) {
      const err = new Error('Board member is not authorized for this Vendor invoice HOA.');
      err.statusCode = 403;
      err.code = 'VENDOR_PAY_BOARD_HOA_MISMATCH';
      throw err;
    }
    return { payerRole: 'board' };
  }

  const err = new Error(
    assigneeId
      ? 'Only the assigned Owner or an HOA Board Member for this community may electronically pay this Vendor invoice.'
      : 'Not authorized to electronically pay this Vendor invoice.',
  );
  err.statusCode = 403;
  err.code = assigneeId ? 'VENDOR_PAY_ASSIGNEE_ONLY' : 'VENDOR_PAY_UNAUTHORIZED';
  throw err;
}

async function loadPayerPaymentMethodImmutable({
  paymentMethodLocalId,
  actorId,
  hoaId,
}) {
  const methodOid = toObjectId(paymentMethodLocalId);
  const userOid = toObjectId(actorId);
  const hoaOid = toObjectId(hoaId);
  if (!methodOid || !userOid) {
    const err = new Error('Payment method is required.');
    err.statusCode = 400;
    throw err;
  }

  const method = await PayloadPaymentMethod.findOne({
    _id: methodOid,
    userId: userOid,
    isDeleted: { $ne: true },
  });
  if (!method) {
    const err = new Error('Payment method not found.');
    err.statusCode = 404;
    err.code = 'PAYER_PM_NOT_FOUND';
    throw err;
  }

  const status = String(method.status || '').toUpperCase();
  if (![PAYMENT_METHOD_STATUS.ACTIVE, PAYMENT_METHOD_STATUS.CREATED, 'ACTIVE', 'CREATED'].includes(status)) {
    const err = new Error('Payment method is not eligible for payment.');
    err.statusCode = 400;
    err.code = 'PAYER_PM_INELIGIBLE';
    throw err;
  }

  const scopeKey = hoaOid ? buildHoaOwnerPayloadScopeKey(String(hoaOid)) : null;
  const scoped =
    (method.entityType === ENTITY_TYPE.HOA && hoaOid && String(method.entityId) === String(hoaOid))
    || (scopeKey && method.billableMerchantId === scopeKey)
    || (!method.entityType && !hoaOid);
  if (hoaOid && !scoped) {
    const err = new Error('Payment method is not scoped to this HOA.');
    err.statusCode = 403;
    err.code = 'PAYER_PM_WRONG_SCOPE';
    throw err;
  }

  const providerPaymentMethodId = String(method.providerPaymentMethodId || '').trim();
  if (!providerPaymentMethodId.startsWith('pm_')) {
    const err = new Error('Payment method is missing a Payload id.');
    err.statusCode = 400;
    throw err;
  }

  return method;
}

/** @deprecated Use loadPayerPaymentMethodImmutable */
const loadOwnerPaymentMethodImmutable = loadPayerPaymentMethodImmutable;

/**
 * Hard invariant: charge processing_id / processing_method_id must be Vendor,
 * never an HOA Processing Account or HOA merchant bank for the invoice community.
 */
async function assertVendorChargeDestinationNotHoa({
  hoaId,
  processingId,
  processingMethodId,
  vendorProcessingId,
  vendorDepositMethodId,
}) {
  const vendorPa = String(vendorProcessingId || '').trim();
  const vendorBank = String(vendorDepositMethodId || '').trim();
  const procId = String(processingId || '').trim();
  const procMethodId = String(processingMethodId || '').trim();

  if (!vendorPa || procId !== vendorPa) {
    const err = new Error('Charge processing_id must equal the Vendor Processing Account.');
    err.statusCode = 400;
    err.code = 'VENDOR_PROCESSING_ID_MISMATCH';
    throw err;
  }
  if (!vendorBank || procMethodId !== vendorBank) {
    const err = new Error('Charge processing_method_id must equal the Vendor default deposit bank.');
    err.statusCode = 400;
    err.code = 'VENDOR_PROCESSING_METHOD_MISMATCH';
    throw err;
  }

  if (!hoaId) return;

  const hoaAccounts = await PayloadAccount.find({
    entityType: ENTITY_TYPE.HOA,
    'metadata.hoaId': String(hoaId),
    isDeleted: { $ne: true },
  }).select('_id merchantId').lean();

  const hoaMerchantIds = new Set(
    hoaAccounts.map((a) => String(a.merchantId || '').trim()).filter(Boolean),
  );
  if (hoaMerchantIds.has(procId)) {
    const err = new Error('HOA Processing Account cannot be used as Vendor payment processing_id.');
    err.statusCode = 400;
    err.code = 'HOA_PROCESSING_ID_FORBIDDEN';
    throw err;
  }

  const hoaAccountIds = hoaAccounts.map((a) => a._id).filter(Boolean);
  if (hoaAccountIds.length) {
    const hoaBanks = await PayloadDepositMethod.find({
      payloadAccountRef: { $in: hoaAccountIds },
      isDeleted: { $ne: true },
    }).select('depositMethodId').lean();
    const hoaBankPms = new Set(
      hoaBanks.map((b) => String(b.depositMethodId || '').trim()).filter(Boolean),
    );
    if (hoaBankPms.has(procMethodId)) {
      const err = new Error('HOA merchant bank cannot be used as Vendor payment processing_method_id.');
      err.statusCode = 400;
      err.code = 'HOA_PROCESSING_METHOD_FORBIDDEN';
      throw err;
    }
  }
}

/**
 * Assert payer Customer + PM belong to actor (never silently create).
 */
async function assertPayerCustomerOwnership({
  actorId,
  customerId,
  method,
  hoaId,
}) {
  if (String(method.userId) !== String(actorId)) {
    const err = new Error('Payment method does not belong to the payer.');
    err.statusCode = 403;
    err.code = 'PAYER_PM_OWNERSHIP';
    throw err;
  }

  const cust = String(customerId || '').trim();
  if (!cust || isInvalidPayloadChargeCustomerId(cust)) {
    const err = new Error('Payer Payload customer is missing. Add a payment method in Settings before paying.');
    err.statusCode = 400;
    err.code = 'PAYER_CUSTOMER_MISSING';
    throw err;
  }

  const userOid = toObjectId(actorId);
  const scopeKey = hoaId ? buildHoaOwnerPayloadScopeKey(String(hoaId)) : null;
  if (userOid) {
    const payloadUser = await PayloadUser.findOne({
      userId: userOid,
      provider: 'PAYLOAD',
      ...(scopeKey ? { billableMerchantId: scopeKey } : {}),
      isDeleted: { $ne: true },
    }).lean();
    const fromUser = String(payloadUser?.metadata?.payloadCustomerId || '').trim();
    const fromMethod = String(method.metadata?.payloadCustomerId || '').trim();
    if (fromUser && fromUser !== cust && fromMethod && fromMethod !== cust) {
      const err = new Error('Payload customer does not belong to the payer for this HOA.');
      err.statusCode = 403;
      err.code = 'PAYER_CUSTOMER_OWNERSHIP';
      throw err;
    }
    if (payloadUser && fromUser && fromUser !== cust && !fromMethod) {
      const err = new Error('Payload customer does not belong to the payer for this HOA.');
      err.statusCode = 403;
      err.code = 'PAYER_CUSTOMER_OWNERSHIP';
      throw err;
    }
  }
}

/**
 * Read-only customer id resolution. Never creates/updates PM or PayloadUser.
 */
async function resolveExistingCustomerId({ method, actorId, remotePaymentMethod }) {
  const remoteCustomerId = String(
    remotePaymentMethod?.customer_id || remotePaymentMethod?.customerId || '',
  ).trim();
  if (remoteCustomerId && !isInvalidPayloadChargeCustomerId(remoteCustomerId)) {
    return remoteCustomerId;
  }

  const localFromMethod = String(method.metadata?.payloadCustomerId || '').trim();
  if (localFromMethod && !isInvalidPayloadChargeCustomerId(localFromMethod)) {
    return localFromMethod;
  }

  const userOid = toObjectId(actorId);
  if (userOid) {
    const payloadUser = await PayloadUser.findOne({
      userId: userOid,
      provider: 'PAYLOAD',
      ...(method.billableMerchantId ? { billableMerchantId: method.billableMerchantId } : {}),
    }).lean();
    const fromUser = String(payloadUser?.metadata?.payloadCustomerId || '').trim();
    if (fromUser && !isInvalidPayloadChargeCustomerId(fromUser)) {
      return fromUser;
    }
  }

  const err = new Error('Payer Payload customer is missing. Add a payment method in Settings before paying.');
  err.statusCode = 400;
  err.code = 'PAYER_CUSTOMER_MISSING';
  throw err;
}

function sanitizeVendorPayin(doc) {
  if (!doc) return null;
  const plain = doc.toObject ? doc.toObject() : doc;
  return {
    id: String(plain._id),
    vendorInvoiceId: String(plain.vendorInvoiceId),
    transactionId: plain.transactionId || null,
    status: plain.status,
    methodType: plain.methodType,
    invoicePaymentAmount: plain.invoicePaymentAmount,
    chargeAmountCents: plain.chargeAmountCents,
    processingFeeAmount: plain.processingFeeAmount || 0,
    paymentAttemptId: plain.paymentAttemptId || '',
    payerUserId: plain.payerUserId ? String(plain.payerUserId) : null,
    payerRole: plain.payerRole || 'owner',
    merchantId: plain.merchantId,
    destinationDepositMethodId: plain.destinationDepositMethodId,
    providerPaymentMethodId: plain.providerPaymentMethodId,
    customerId: plain.customerId || '',
    settledAt: plain.settledAt || null,
    failedAt: plain.failedAt || null,
    refusalCode: plain.refusalCode || '',
    refusalDesc: plain.refusalDesc || '',
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
  };
}

async function resolveChargeContext({
  vendorInvoiceId,
  actorId,
  hoaContext,
  invoicePaymentAmount,
  paymentMethodLocalId,
}) {
  assertVendorPayEnabled();

  const invoice = await getVendorInvoiceService().getVendorInvoiceById(
    vendorInvoiceId,
    actorId,
    hoaContext,
  );
  const { payerRole } = assertVendorPayPayerAuthorized({ invoice, actorId, hoaContext });

  const status = String(invoice.status || '');
  if (status === 'Paid' || status === 'Cancelled') {
    const err = new Error(`Invoice status ${status} is not payable.`);
    err.statusCode = 400;
    err.code = 'INVOICE_NOT_PAYABLE';
    throw err;
  }

  const vendorUserId = String(invoice.vendorId?._id || invoice.vendorId);
  const hoaId = invoice.hoaId ? String(invoice.hoaId._id || invoice.hoaId) : null;

  const method = await loadPayerPaymentMethodImmutable({
    paymentMethodLocalId,
    actorId,
    hoaId,
  });

  const methodType = String(method.type || PAYMENT_METHOD_TYPE.CARD).toUpperCase();
  // Vendor Invoice pay: ACH/Card only for now (Plaid remains available for HOA rent / settings).
  if (methodType.includes('PLAID')) {
    const err = new Error(
      'Plaid is not available for Vendor Invoice payments. Use a linked bank (ACH) or card.',
    );
    err.statusCode = 400;
    err.code = 'VENDOR_PLAID_NOT_SUPPORTED';
    throw err;
  }
  const amounts = await resolveVendorPayinAmounts(invoicePaymentAmount, {
    methodType,
    hoaId,
  });
  const collectable = await assertCollectableAllowsPayment({
    invoice,
    invoicePaymentAmount: amounts.invoicePaymentAmount,
  });

  const vendorAccountSetupMessage =
    'The vendor’s payment account has not been set up, so electronic payment cannot proceed.';
  const vendorAccount = await findVendorPayloadAccount(vendorUserId);
  if (!vendorAccount) {
    const err = new Error(vendorAccountSetupMessage);
    err.statusCode = 400;
    err.code = 'VENDOR_PA_MISSING';
    throw err;
  }
  const merchantId = String(vendorAccount.merchantId || '').trim();
  if (!merchantId) {
    const err = new Error(vendorAccountSetupMessage);
    err.statusCode = 400;
    err.code = 'VENDOR_PA_UNLINKED';
    throw err;
  }
  if (String(vendorAccount.onboardingStatus || '').toUpperCase() !== MERCHANT_ONBOARDING_STATUS.ACTIVE) {
    const err = new Error(vendorAccountSetupMessage);
    err.statusCode = 400;
    err.code = 'VENDOR_PA_NOT_ACTIVE';
    throw err;
  }

  const defaultBank = await resolveRequiredDefaultDepositBank(vendorAccount);
  if (!defaultBank) {
    const err = new Error(vendorAccountSetupMessage);
    err.statusCode = 400;
    err.code = 'VENDOR_DEFAULT_BANK_MISSING';
    throw err;
  }
  const bankCheck = isDepositBankEligible(defaultBank);
  if (!bankCheck.ok) {
    const err = new Error(vendorAccountSetupMessage);
    err.statusCode = 400;
    err.code = 'VENDOR_DEFAULT_BANK_INELIGIBLE';
    throw err;
  }
  if (String(defaultBank.payloadAccountRef) !== String(vendorAccount._id)) {
    const err = new Error('Vendor default bank does not belong to this Processing Account.');
    err.statusCode = 403;
    err.code = 'VENDOR_BANK_WRONG_ACCOUNT';
    throw err;
  }

  const destinationDepositMethodId = String(defaultBank.depositMethodId || '').trim();
  await assertVendorChargeDestinationNotHoa({
    hoaId,
    processingId: merchantId,
    processingMethodId: destinationDepositMethodId,
    vendorProcessingId: merchantId,
    vendorDepositMethodId: destinationDepositMethodId,
  });

  return {
    invoice,
    amounts,
    collectable,
    vendorUserId,
    hoaId,
    vendorAccount,
    merchantId,
    defaultBank,
    method,
    payerRole,
  };
}

async function validateVendorInvoicePayin({
  vendorInvoiceId,
  actorId,
  hoaContext = null,
  invoicePaymentAmount,
  paymentMethodLocalId,
}) {
  const ctx = await resolveChargeContext({
    vendorInvoiceId,
    actorId,
    hoaContext,
    invoicePaymentAmount,
    paymentMethodLocalId,
  });

  return {
    ok: true,
    vendorInvoiceId: String(ctx.invoice._id),
    invoiceNumber: ctx.invoice.invoiceNumber || '',
    amounts: ctx.amounts,
    collectable: ctx.collectable,
    vendor: {
      payloadAccountId: String(ctx.vendorAccount._id),
      processingAccountId: ctx.merchantId,
      onboardingStatus: ctx.vendorAccount.onboardingStatus,
    },
    destinationBank: {
      paymentMethodId: ctx.defaultBank.depositMethodId,
      isDefaultDepositMethod: true,
      last4: ctx.defaultBank.last4 || null,
    },
    paymentMethod: {
      id: String(ctx.method._id),
      providerPaymentMethodId: ctx.method.providerPaymentMethodId,
      type: ctx.method.type,
      status: ctx.method.status,
    },
    amountCalculation: {
      rule: 'hoa_owner_convenience_fee_v1',
      invoicePaymentAmount: ctx.amounts.invoicePaymentAmount,
      chargeAmountDollars: ctx.amounts.chargeAmountDollars,
      chargeAmountCents: ctx.amounts.chargeAmountCents,
      processingFeeAmount: ctx.amounts.processingFeeAmount,
      processingFeePaidBy: ctx.amounts.processingFeePaidBy || '',
    },
  };
}

async function executeVendorInvoicePayin({
  vendorInvoiceId,
  actorId,
  hoaContext = null,
  invoicePaymentAmount,
  paymentMethodLocalId,
  paymentAttemptId,
  description = '',
}) {
  const ctx = await resolveChargeContext({
    vendorInvoiceId,
    actorId,
    hoaContext,
    invoicePaymentAmount,
    paymentMethodLocalId,
  });

  const attemptKey = String(paymentAttemptId || '').trim();
  if (!attemptKey) {
    const err = new Error('paymentAttemptId is required.');
    err.statusCode = 400;
    throw err;
  }

  const idempotencyKey = buildVendorPayinIdempotencyKey({
    userId: actorId,
    vendorInvoiceId: ctx.invoice._id,
    paymentAttemptId: attemptKey,
  });

  const existing = await PayloadVendorPayin.findOne({
    idempotencyKey,
    isDeleted: { $ne: true },
  });
  if (existing?.transactionId) {
    return { duplicate: true, item: sanitizeVendorPayin(existing) };
  }

  const client = new PayloadClient();
  if (!client.isConfigured()) {
    const err = new Error('Payload is not configured.');
    err.statusCode = 503;
    throw err;
  }

  const providerPaymentMethodId = String(ctx.method.providerPaymentMethodId).trim();
  let remotePaymentMethod;
  try {
    remotePaymentMethod = await client.getPaymentMethod(providerPaymentMethodId);
  } catch (pmErr) {
    const err = new Error('Payload could not verify this saved payment method. Choose another method.');
    err.statusCode = pmErr.statusCode === 404 ? 400 : (pmErr.statusCode || 400);
    err.code = 'PAYER_PM_REMOTE_UNAVAILABLE';
    throw err;
  }

  // Read-only — never create/update PM or PayloadUser on Pay Invoice
  const customerId = await resolveExistingCustomerId({
    method: ctx.method,
    actorId,
    remotePaymentMethod,
  });
  const scope = classifyPayloadPaymentMethodScope(remotePaymentMethod);
  if (scope === 'customer' && !customerId) {
    const err = new Error('Payer Payload customer is missing. Add a payment method in Settings before paying.');
    err.statusCode = 400;
    err.code = 'PAYER_CUSTOMER_MISSING';
    throw err;
  }

  await assertPayerCustomerOwnership({
    actorId,
    customerId,
    method: ctx.method,
    hoaId: ctx.hoaId,
  });

  const destinationDepositMethodId = String(ctx.defaultBank.depositMethodId || '').trim();
  await assertVendorChargeDestinationNotHoa({
    hoaId: ctx.hoaId,
    processingId: ctx.merchantId,
    processingMethodId: destinationDepositMethodId,
    vendorProcessingId: ctx.merchantId,
    vendorDepositMethodId: destinationDepositMethodId,
  });

  const methodType = String(ctx.method.type || PAYMENT_METHOD_TYPE.CARD).toUpperCase();
  const phaseTag = ctx.payerRole === 'board'
    ? 'phase5_board_vendor_pay'
    : 'phase4_vendor_owner_pay';

  let doc = existing;
  if (!doc) {
    try {
      doc = await PayloadVendorPayin.create({
        provider: 'PAYLOAD',
        vendorInvoiceId: ctx.invoice._id,
        hoaId: ctx.hoaId ? toObjectId(ctx.hoaId) : null,
        vendorUserId: toObjectId(ctx.vendorUserId),
        payerUserId: toObjectId(actorId),
        payerRole: ctx.payerRole || 'owner',
        payloadAccountRef: ctx.vendorAccount._id,
        merchantId: ctx.merchantId,
        destinationDepositMethodId,
        paymentMethodLocalId: ctx.method._id,
        providerPaymentMethodId,
        customerId,
        methodType,
        status: PAYIN_STATUS.CREATED,
        invoicePaymentAmount: ctx.amounts.invoicePaymentAmount,
        chargeAmountCents: ctx.amounts.chargeAmountCents,
        processingFeeAmount: ctx.amounts.processingFeeAmount || 0,
        paymentAttemptId: attemptKey,
        idempotencyKey,
        metadata: {
          phase: phaseTag,
          amountRule: 'hoa_owner_convenience_fee_v1',
          invoiceNumber: ctx.invoice.invoiceNumber || '',
          payerRole: ctx.payerRole || 'owner',
        },
      });
    } catch (createErr) {
      if (createErr?.code === 11000) {
        const raced = await PayloadVendorPayin.findOne({ idempotencyKey, isDeleted: { $ne: true } });
        if (raced?.transactionId) {
          return { duplicate: true, item: sanitizeVendorPayin(raced) };
        }
        doc = raced;
      } else {
        throw createErr;
      }
    }
  }

  if (!doc) {
    const err = new Error('Unable to create payment attempt.');
    err.statusCode = 500;
    throw err;
  }

  const transactionPayload = buildPayloadTransactionChargeBody({
    netAmount: ctx.amounts.invoicePaymentAmount,
    totalCharge: ctx.amounts.chargeAmountDollars,
    amountValidation: {
      processingFeeAmount: ctx.amounts.processingFeeAmount || 0,
      processingFeePaidBy: ctx.amounts.processingFeePaidBy || '',
    },
    customerId,
    paymentMethodId: providerPaymentMethodId,
    merchantId: ctx.merchantId,
    settlementBankId: destinationDepositMethodId,
    description: description || `Vendor invoice ${ctx.invoice.invoiceNumber || ctx.invoice._id}`,
    metadata: {
      propmv_vendor_invoice_id: String(ctx.invoice._id),
      propmv_payment_attempt_id: attemptKey,
      propmv_phase: phaseTag,
      propmv_payer_role: ctx.payerRole || 'owner',
    },
  });

  const chargeProcessingId = String(
    transactionPayload.processing_id || transactionPayload.processingId || '',
  ).trim();
  const chargeProcessingMethodId = String(
    transactionPayload.processing_method_id || transactionPayload.processingMethodId || '',
  ).trim();
  await assertVendorChargeDestinationNotHoa({
    hoaId: ctx.hoaId,
    processingId: chargeProcessingId,
    processingMethodId: chargeProcessingMethodId,
    vendorProcessingId: ctx.merchantId,
    vendorDepositMethodId: destinationDepositMethodId,
  });

  let remote;
  try {
    remote = await client.createPaymentTransaction(transactionPayload, {
      idempotencyKey: `${idempotencyKey}_vendor_payin`,
    });
  } catch (chargeErr) {
    const code = String(chargeErr?.payloadError?.status_code || chargeErr?.payloadError?.error || '').toLowerCase();
    const msg = String(chargeErr.message || '').toLowerCase();
    const isDuplicateAttempt = code.includes('duplicate') || msg.includes('duplicate_attempt');

    if (isDuplicateAttempt) {
      const local = await PayloadVendorPayin.findOne({ idempotencyKey, isDeleted: { $ne: true } });
      if (local?.transactionId) {
        return { duplicate: true, item: sanitizeVendorPayin(local) };
      }
      doc.status = PAYIN_STATUS.FAILED;
      doc.failedAt = new Date();
      doc.refusalCode = 'PAYLOAD_DUPLICATE_ATTEMPT';
      doc.refusalDesc = chargeErr.message || 'Payload duplicate_attempt without local transaction id';
      doc.raw = chargeErr.payloadError || null;
      await doc.save();
      const err = new Error('Duplicate payment attempt could not be reconciled. Contact support if funds were charged.');
      err.statusCode = 409;
      err.code = 'PAYLOAD_DUPLICATE_ATTEMPT';
      throw err;
    }

    doc.status = PAYIN_STATUS.FAILED;
    doc.failedAt = new Date();
    doc.refusalCode = String(chargeErr?.payloadError?.status_code || chargeErr.statusCode || 'CHARGE_FAILED');
    doc.refusalDesc = chargeErr.message || 'Charge failed';
    doc.raw = chargeErr.payloadError || null;
    await doc.save();
    throw chargeErr;
  }

  const mapped = mapPayloadTransactionToPayinFields(remote);
  doc.transactionId = mapped.payinId || remote?.id || doc.transactionId;
  doc.status = mapped.status || PAYIN_STATUS.PROCESSING;
  doc.refusalCode = mapped.refusalCode || '';
  doc.refusalDesc = mapped.refusalDesc || '';
  doc.raw = remote;
  await doc.save();

  await gatewayHelper().markVendorInvoiceElectronicProcessing({
    vendorInvoiceId: ctx.invoice._id,
    recordedBy: String(actorId),
    note: `Electronic payment ${doc.transactionId || 'pending'}`,
  });

  // Settlement only via util — never settle from raw status alone
  const settleAction = resolvePayloadPayinSettlementAction({
    methodType: doc.methodType,
    status: doc.status,
    eventType: '',
    hasAchReturn: mapped.hasAchReturn,
    fundingStatus: mapped.fundingStatus,
    alreadySettled: Boolean(doc.settledAt),
  });

  if (settleAction === 'settle') {
    await applyVendorPayinSettlement(doc, { actorId });
  } else if (settleAction === 'fail') {
    await applyVendorPayinFailure(doc, { actorId });
  }

  const fresh = await PayloadVendorPayin.findById(doc._id);
  return { duplicate: false, item: sanitizeVendorPayin(fresh) };
}

async function countOtherInFlight(vendorInvoiceId, excludeId) {
  return PayloadVendorPayin.countDocuments({
    vendorInvoiceId: toObjectId(vendorInvoiceId),
    _id: { $ne: excludeId },
    isDeleted: { $ne: true },
    status: { $in: [...IN_FLIGHT_STATUSES] },
    settledAt: null,
  });
}

async function applyVendorPayinSettlement(doc, { actorId = 'system' } = {}) {
  if (doc.settledAt) return doc;
  await gatewayHelper().settleVendorInvoiceGatewayPayment({
    vendorInvoiceId: doc.vendorInvoiceId,
    paymentAmount: doc.invoicePaymentAmount,
    methodLabel: invoiceMethodLabel(doc.methodType),
    recordedBy: String(actorId || doc.payerUserId || 'system'),
    paidBy: String(doc.payerUserId || ''),
    payinId: doc.transactionId || String(doc._id),
  });
  doc.settledAt = new Date();
  doc.status = PAYIN_STATUS.SUCCEEDED;
  await doc.save();

  // Settlement clears Processing via helper; re-mark Processing only if another payin is in flight.
  const others = await countOtherInFlight(doc.vendorInvoiceId, doc._id);
  if (others > 0) {
    await gatewayHelper().markVendorInvoiceElectronicProcessing({
      vendorInvoiceId: doc.vendorInvoiceId,
      recordedBy: String(actorId || doc.payerUserId || 'system'),
      note: 'Electronic payment in progress',
    });
  }
  return doc;
}

async function applyVendorPayinFailure(doc, { actorId = 'system' } = {}) {
  if (doc.settledAt) return doc;
  const others = await countOtherInFlight(doc.vendorInvoiceId, doc._id);
  await gatewayHelper().failVendorInvoiceGatewayPayment({
    vendorInvoiceId: doc.vendorInvoiceId,
    hasOtherInFlight: others > 0,
    recordedBy: String(actorId || 'system'),
    note: doc.refusalDesc || 'Electronic payment failed',
  });
  doc.failedAt = doc.failedAt || new Date();
  if (![PAYIN_STATUS.FAILED, PAYIN_STATUS.RETURNED, PAYIN_STATUS.CANCELED].includes(doc.status)) {
    doc.status = PAYIN_STATUS.FAILED;
  }
  await doc.save();
  return doc;
}

async function applyVendorPayinReverse(doc, { actorId = 'system' } = {}) {
  if (!doc.settledAt) return doc;
  if (doc.metadata?.reversedAt) return doc;
  await gatewayHelper().reverseVendorInvoiceGatewayPayment({
    vendorInvoiceId: doc.vendorInvoiceId,
    paymentAmount: doc.invoicePaymentAmount,
    recordedBy: String(actorId || 'system'),
    payinId: doc.transactionId || String(doc._id),
  });
  doc.metadata = { ...(doc.metadata || {}), reversedAt: new Date().toISOString() };
  doc.markModified('metadata');
  doc.status = PAYIN_STATUS.RETURNED;
  await doc.save();
  return doc;
}

async function applyVendorPayinWebhookUpdate({
  transactionId,
  remotePayload,
  eventType,
}) {
  const txnId = String(transactionId || remotePayload?.id || '').trim();
  if (!txnId) return null;

  let doc = await PayloadVendorPayin.findOne({
    transactionId: txnId,
    isDeleted: { $ne: true },
  });

  // Optional match by processing_id when local row not yet linked (rare)
  if (!doc) {
    const processingId = String(
      remotePayload?.processing_id || remotePayload?.processingId || '',
    ).trim();
    if (processingId) {
      doc = await PayloadVendorPayin.findOne({
        merchantId: processingId,
        status: { $in: [...IN_FLIGHT_STATUSES] },
        isDeleted: { $ne: true },
        'metadata.propmv_vendor_invoice_id': remotePayload?.attrs?.propmv_vendor_invoice_id,
      }).sort({ createdAt: -1 });
    }
  }

  if (!doc) return null;

  const mapped = mapPayloadTransactionToPayinFields(remotePayload || {});
  doc.status = mapped.status || doc.status;
  doc.refusalCode = mapped.refusalCode || doc.refusalCode;
  doc.refusalDesc = mapped.refusalDesc || doc.refusalDesc;
  doc.raw = remotePayload;
  doc.lastWebhookAt = new Date();
  if (!doc.transactionId && mapped.payinId) doc.transactionId = mapped.payinId;
  await doc.save();

  const action = resolvePayloadPayinSettlementAction({
    methodType: doc.methodType,
    status: doc.status,
    eventType,
    hasAchReturn: mapped.hasAchReturn,
    fundingStatus: mapped.fundingStatus,
    alreadySettled: Boolean(doc.settledAt),
  });

  if (action === 'settle') {
    await applyVendorPayinSettlement(doc);
  } else if (action === 'fail') {
    await applyVendorPayinFailure(doc);
  } else if (action === 'reverse') {
    await applyVendorPayinReverse(doc);
  }

  return sanitizeVendorPayin(await PayloadVendorPayin.findById(doc._id));
}

async function getVendorPayinById({ vendorPayinId, actorId, hoaContext = null }) {
  assertVendorPayEnabled();
  const oid = toObjectId(vendorPayinId);
  if (!oid) {
    const err = new Error('Invalid vendor payin id');
    err.statusCode = 400;
    throw err;
  }
  const doc = await PayloadVendorPayin.findOne({ _id: oid, isDeleted: { $ne: true } });
  if (!doc) {
    const err = new Error('Vendor payin not found');
    err.statusCode = 404;
    throw err;
  }
  // Auth via invoice visibility
  await getVendorInvoiceService().getVendorInvoiceById(
    doc.vendorInvoiceId,
    actorId,
    hoaContext,
  );
  return sanitizeVendorPayin(doc);
}

module.exports = {
  resolveVendorPayinAmounts,
  buildVendorPayinIdempotencyKey,
  resolveRequiredDefaultDepositBank,
  assertCollectableAllowsPayment,
  sumInFlightElectronic,
  assertVendorPayPayerAuthorized,
  assertVendorChargeDestinationNotHoa,
  validateVendorInvoicePayin,
  executeVendorInvoicePayin,
  getVendorPayinById,
  applyVendorPayinWebhookUpdate,
  sanitizeVendorPayin,
  IN_FLIGHT_STATUSES,
  isCardLikeMethodType,
};
