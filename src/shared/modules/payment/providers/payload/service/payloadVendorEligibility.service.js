'use strict';

/**
 * Phase 3 — Vendor electronic pay readiness (read-only).
 * Resolves eligibility for a future Owner/Board → Vendor payment.
 * NEVER creates Payload transactions, payment attempts, or Board Customer infrastructure.
 */

const mongoose = require('mongoose');
const payloadConfig = require('../../../../../../config/payload.config');
const PayloadAccount = require('../model/payloadAccount.model');
const {
  PayloadDepositMethod,
  DEPOSIT_METHOD_STATUS,
} = require('../model/payloadDepositMethod.model');
const PayloadPaymentMethod = require('../model/payloadPaymentMethod.model');
const {
  ENTITY_TYPE,
  MERCHANT_ONBOARDING_STATUS,
  PAYMENT_METHOD_STATUS,
} = require('../constants/payload.constants');
const { buildHoaOwnerPayloadScopeKey } = require('../utils/payloadHoaOwnerCustomerContext.util');

/** Lazy-load to keep unit tests free of vendor-invoice → email ESM graph. */
function getVendorInvoiceService() {
  // eslint-disable-next-line global-require
  return require('../../../../../../portals/hoa-board/modules/vendor-invoice/service/vendorInvoice.service');
}

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function blocker(code, message) {
  return { code, message };
}

/**
 * Board Customer resolution — Phase 5 activates reuse of HOA-scoped wallet.
 * Pay Invoice never creates Customer/PM; Board Settings onboarding does.
 */
function boardCustomerResolutionStrategy() {
  return {
    status: 'active',
    phase3CreatesInfrastructure: false,
    recommendedPattern: 'reuse_ensurePayloadUserContext_hoa_scoped',
    summary:
      'Board → Vendor reuses ensurePayloadUserContext / listUserPaymentMethods with entityType=hoa '
      + 'and billableMerchantId=hoa:{hoaId} as Customer/wallet scope only. Charge processing_id is always '
      + 'the Vendor Processing Account; processing_method_id is always the Vendor default deposit bank.',
  };
}

function isDepositBankEligible(bank) {
  if (!bank) return { ok: false, reason: 'missing' };
  const status = String(bank.status || '').toUpperCase();
  const statusOk = status === DEPOSIT_METHOD_STATUS.ACTIVE || status === 'ACTIVE' || status === 'CREATED';
  if (!statusOk) return { ok: false, reason: `status_${status || 'unknown'}` };

  const verification = String(bank.verificationStatus || '').toLowerCase();
  // Empty verification is allowed in sandbox incomplete flows; reject explicit failures.
  if (verification && ['failed', 'unverified', 'canceled', 'cancelled'].includes(verification)) {
    return { ok: false, reason: `verification_${verification}` };
  }

  const transfer = String(bank.transferType || '').toLowerCase();
  if (transfer && transfer !== 'receive-only' && transfer !== 'two-way') {
    // send-only banks are not Vendor receiving destinations
    if (transfer === 'send-only') return { ok: false, reason: 'transfer_send_only' };
  }

  if (!String(bank.depositMethodId || '').startsWith('pm_')) {
    return { ok: false, reason: 'missing_pm_id' };
  }

  return { ok: true, reason: null };
}

async function findVendorPayloadAccount(vendorUserId) {
  const oid = toObjectId(vendorUserId);
  if (!oid) return null;
  const vendorKey = String(oid);
  // Match payloadMerchant ownership: createdBy OR entityId (Vendor user id), plus stable externalId.
  return PayloadAccount.findOne({
    entityType: ENTITY_TYPE.VENDOR,
    isDeleted: { $ne: true },
    $or: [
      { createdBy: oid },
      { entityId: oid },
      { externalId: `payload_vendor_${vendorKey}` },
      { 'metadata.vendorUserId': vendorKey },
    ],
  });
}

/**
 * Default deposit bank only — never fall back to first eligible bank
 * (Phase 4 mandatory: missing/invalid default blocks electronic pay).
 */
async function findDefaultDepositBank(account) {
  if (!account?._id) return null;
  return PayloadDepositMethod.findOne({
    payloadAccountRef: account._id,
    isDeleted: { $ne: true },
    $or: [{ defaultDepositMethod: true }, { isPrimaryPayout: true }],
  }).sort({ defaultDepositMethod: -1, isPrimaryPayout: -1, updatedAt: -1 });
}

/**
 * Read-only Owner payer readiness for a future Vendor payment.
 * Does not create PayloadUser or payment methods.
 */
async function resolveOwnerPayerReadiness({ ownerUserId, hoaId }) {
  const userOid = toObjectId(ownerUserId);
  const hoaOid = toObjectId(hoaId);
  if (!userOid || !hoaOid) {
    return {
      ready: false,
      eligiblePaymentMethodCount: 0,
      hasPayloadCustomerContext: false,
      blockers: [blocker('OWNER_CONTEXT_MISSING', 'Owner or HOA context is missing for payer readiness.')],
    };
  }

  const blockers = [];
  let count = 0;
  const scopeKey = buildHoaOwnerPayloadScopeKey(String(hoaOid));

  try {
    // Read-only local lookup — never creates PayloadUser / Customers / transactions.
    count = await PayloadPaymentMethod.countDocuments({
      userId: userOid,
      isDeleted: { $ne: true },
      status: {
        $in: [
          PAYMENT_METHOD_STATUS.ACTIVE,
          PAYMENT_METHOD_STATUS.CREATED,
          'ACTIVE',
          'CREATED',
        ],
      },
      $or: [
        { entityType: ENTITY_TYPE.HOA, entityId: hoaOid },
        ...(scopeKey ? [{ billableMerchantId: scopeKey }] : []),
      ],
    });
  } catch (err) {
    blockers.push(blocker('OWNER_PAYER_LOOKUP_FAILED', err.message || 'Unable to resolve Owner payment methods.'));
    return {
      ready: false,
      eligiblePaymentMethodCount: 0,
      hasPayloadCustomerContext: false,
      blockers,
    };
  }

  if (count < 1) {
    blockers.push(blocker(
      'OWNER_NO_PAYMENT_METHOD',
      'Owner has no eligible saved Payload payment method for this HOA.',
    ));
  }

  return {
    ready: blockers.length === 0 && count > 0,
    eligiblePaymentMethodCount: count,
    hasPayloadCustomerContext: count > 0,
    blockers,
  };
}

const VENDOR_CREATE_INVOICE_BANK_REQUIRED_MESSAGE =
  'Add a bank account in Payment Settings before creating an invoice. '
  + 'Your payment account has not been set up, so invoices cannot be created yet.';

/**
 * When Vendor Payload merchant mode is enabled, require an ACTIVE processing
 * account plus an eligible default deposit bank before invoice create.
 * No-ops when merchant mode is off (manual settlement path preserved).
 */
async function assertVendorReadyToCreateInvoice(vendorUserId) {
  const merchantModeEnabled = Boolean(
    payloadConfig.payload.enabled && payloadConfig.payload.vendorMerchantEnabled,
  );
  if (!merchantModeEnabled) {
    return { required: false, ok: true };
  }

  const vendorAccount = await findVendorPayloadAccount(vendorUserId);
  if (!vendorAccount) {
    const err = new Error(VENDOR_CREATE_INVOICE_BANK_REQUIRED_MESSAGE);
    err.status = 400;
    err.code = 'VENDOR_PA_MISSING';
    throw err;
  }

  const merchantId = String(vendorAccount.merchantId || '').trim();
  const onboarding = String(vendorAccount.onboardingStatus || '').toUpperCase();
  if (!merchantId || onboarding !== MERCHANT_ONBOARDING_STATUS.ACTIVE) {
    const err = new Error(VENDOR_CREATE_INVOICE_BANK_REQUIRED_MESSAGE);
    err.status = 400;
    err.code = merchantId ? 'VENDOR_PA_NOT_ACTIVE' : 'VENDOR_PA_UNLINKED';
    throw err;
  }

  const defaultBank = await findDefaultDepositBank(vendorAccount);
  if (!defaultBank) {
    const err = new Error(VENDOR_CREATE_INVOICE_BANK_REQUIRED_MESSAGE);
    err.status = 400;
    err.code = 'VENDOR_DEFAULT_BANK_MISSING';
    throw err;
  }

  const bankIsDefault = Boolean(defaultBank.defaultDepositMethod || defaultBank.isPrimaryPayout);
  const bankCheck = isDepositBankEligible(defaultBank);
  if (!bankIsDefault || !bankCheck.ok) {
    const err = new Error(VENDOR_CREATE_INVOICE_BANK_REQUIRED_MESSAGE);
    err.status = 400;
    err.code = bankIsDefault ? 'VENDOR_BANK_INELIGIBLE' : 'VENDOR_DEFAULT_BANK_MISSING';
    throw err;
  }

  return {
    required: true,
    ok: true,
    vendorPayloadAccountId: String(vendorAccount._id),
    defaultDepositMethodId: String(defaultBank._id),
  };
}

/**
 * Resolve Vendor invoice electronic-pay eligibility (read-only).
 * Uses existing VendorInvoice visibility/assignment authorization via getVendorInvoiceById.
 */
async function getVendorInvoicePayEligibility({
  vendorInvoiceId,
  actorId,
  hoaContext = null,
}) {
  const merchantModeEnabled = Boolean(
    payloadConfig.payload.enabled && payloadConfig.payload.vendorMerchantEnabled,
  );
  const vendorPayEnabled = Boolean(
    merchantModeEnabled && payloadConfig.payload.vendorPayEnabled,
  );

  const invoice = await getVendorInvoiceService().getVendorInvoiceById(
    vendorInvoiceId,
    actorId,
    hoaContext,
  );

  const vendorUserId = String(invoice.vendorId?._id || invoice.vendorId);
  const hoaId = invoice.hoaId ? String(invoice.hoaId) : null;
  const assigneeId = String(invoice.assignedTo?._id || invoice.assignedTo || '');
  const balanceDue = Number(invoice.balanceDue || 0);
  const status = String(invoice.status || '');

  const blockers = [];
  const warnings = [];

  if (!merchantModeEnabled) {
    blockers.push(blocker(
      'VENDOR_MERCHANT_DISABLED',
      'Vendor Payload merchant mode is not enabled.',
    ));
  }

  if (!payloadConfig.payload.enabled) {
    blockers.push(blocker('PAYLOAD_DISABLED', 'Payload payments are not enabled.'));
  }

  if (status === 'Paid' || status === 'Cancelled') {
    blockers.push(blocker('INVOICE_NOT_PAYABLE', `Invoice status ${status} is not payable.`));
  } else if (!(balanceDue > 0)) {
    blockers.push(blocker('INVOICE_ZERO_BALANCE', 'Invoice has no remaining balance.'));
  }

  let vendorAccount = null;
  let defaultBank = null;
  let bankIsDefault = false;

  if (merchantModeEnabled) {
    vendorAccount = await findVendorPayloadAccount(vendorUserId);
    if (!vendorAccount) {
      blockers.push(blocker(
        'VENDOR_PA_MISSING',
        'The vendor’s payment account has not been set up, so electronic payment cannot proceed.',
      ));
    } else {
      const onboarding = String(vendorAccount.onboardingStatus || '').toUpperCase();
      const merchantId = String(vendorAccount.merchantId || '').trim();
      if (!merchantId) {
        blockers.push(blocker(
          'VENDOR_PA_UNLINKED',
          'The vendor’s payment account has not been set up, so electronic payment cannot proceed.',
        ));
      }
      if (onboarding !== MERCHANT_ONBOARDING_STATUS.ACTIVE) {
        blockers.push(blocker(
          'VENDOR_PA_NOT_ACTIVE',
          'The vendor’s payment account has not been set up, so electronic payment cannot proceed.',
        ));
      }

      defaultBank = await findDefaultDepositBank(vendorAccount);
      if (!defaultBank) {
        blockers.push(blocker(
          'VENDOR_DEFAULT_BANK_MISSING',
          'The vendor’s payment account has not been set up, so electronic payment cannot proceed.',
        ));
      } else {
        bankIsDefault = Boolean(defaultBank.defaultDepositMethod || defaultBank.isPrimaryPayout);
        if (!bankIsDefault) {
          blockers.push(blocker(
            'VENDOR_DEFAULT_BANK_MISSING',
            'The vendor’s payment account has not been set up, so electronic payment cannot proceed.',
          ));
        }
        const bankCheck = isDepositBankEligible(defaultBank);
        if (!bankCheck.ok) {
          blockers.push(blocker(
            'VENDOR_BANK_INELIGIBLE',
            'The vendor’s payment account has not been set up, so electronic payment cannot proceed.',
          ));
        }
      }
    }
  }

  if (merchantModeEnabled && !vendorPayEnabled) {
    warnings.push(blocker(
      'VENDOR_PAY_DISABLED',
      'Vendor electronic pay flag is off (readiness only).',
    ));
  }

  // Payer readiness — assignee Owner and/or Board of invoice HOA (Phase 5).
  // Pay Invoice never creates Customer/PM; missing PM is a prerequisite blocker.
  const actorIsAssignee = Boolean(assigneeId && String(actorId) === assigneeId);
  const ctxHoa = hoaContext?.hoaId ? String(hoaContext.hoaId) : '';
  const actorIsBoardForInvoice = Boolean(
    hoaContext?.isHOABoardMember
    && hoaId
    && ctxHoa
    && ctxHoa === String(hoaId),
  );

  let ownerPayer = {
    evaluated: false,
    ready: false,
    eligiblePaymentMethodCount: 0,
    hasPayloadCustomerContext: false,
    blockers: [],
  };
  let boardPayer = {
    evaluated: false,
    ready: false,
    eligiblePaymentMethodCount: 0,
    hasPayloadCustomerContext: false,
    blockers: [],
  };

  if (actorIsAssignee && hoaId && merchantModeEnabled) {
    ownerPayer = {
      evaluated: true,
      ...(await resolveOwnerPayerReadiness({ ownerUserId: actorId, hoaId })),
    };
    for (const b of ownerPayer.blockers || []) {
      blockers.push(b);
    }
  }

  if (actorIsBoardForInvoice && hoaId && merchantModeEnabled) {
    const readiness = await resolveOwnerPayerReadiness({ ownerUserId: actorId, hoaId });
    boardPayer = {
      evaluated: true,
      ready: readiness.ready,
      eligiblePaymentMethodCount: readiness.eligiblePaymentMethodCount,
      hasPayloadCustomerContext: readiness.hasPayloadCustomerContext,
      blockers: (readiness.blockers || []).map((b) => (
        b.code === 'OWNER_NO_PAYMENT_METHOD'
          ? blocker(
            'BOARD_NO_PAYMENT_METHOD',
            'Board member has no eligible saved payment method for this HOA. Add one in Settings → Payer payment methods before paying.',
          )
          : b.code === 'OWNER_CONTEXT_MISSING'
            ? blocker('BOARD_CONTEXT_MISSING', b.message)
            : b
      )),
    };
    for (const b of boardPayer.blockers || []) {
      blockers.push(b);
    }
  }

  const vendorSideReady = merchantModeEnabled
    && blockers.every((b) => ![
      'VENDOR_MERCHANT_DISABLED',
      'PAYLOAD_DISABLED',
      'VENDOR_PA_MISSING',
      'VENDOR_PA_UNLINKED',
      'VENDOR_PA_NOT_ACTIVE',
      'VENDOR_DEFAULT_BANK_MISSING',
      'VENDOR_BANK_INELIGIBLE',
      'INVOICE_NOT_PAYABLE',
      'INVOICE_ZERO_BALANCE',
    ].includes(b.code));

  let payerReady = true;
  if (actorIsAssignee) payerReady = ownerPayer.ready;
  else if (actorIsBoardForInvoice) payerReady = boardPayer.ready;

  const electronicPayReady = vendorSideReady && payerReady;
  const electronicPayAvailable = vendorPayEnabled && electronicPayReady;
  const electronicPayExecutable = electronicPayAvailable
    && (actorIsAssignee || actorIsBoardForInvoice);

  return {
    vendorInvoiceId: String(invoice._id),
    invoiceNumber: invoice.invoiceNumber || '',
    status,
    balanceDue,
    hoaId,
    vendorUserId,
    assignedToUserId: assigneeId || null,
    merchantModeEnabled,
    vendorPayEnabled,
    /**
     * Broken HOA OwnerPaymentDialog path stays gated when merchant mode is on,
     * unless Vendor pay flag enables the dedicated Vendor execute path.
     */
    electronicPayAvailable,
    electronicPayExecutable,
    electronicPayReady,
    brokenHoaPayinPathGated: merchantModeEnabled && !vendorPayEnabled,
    manualRecordPaymentPreserved: true,
    vendor: vendorAccount ? {
      payloadAccountId: String(vendorAccount._id),
      // Server-resolved only — clients must not supply these for charge.
      processingAccountId: vendorAccount.merchantId || null,
      onboardingStatus: vendorAccount.onboardingStatus || null,
      entityType: vendorAccount.entityType,
    } : null,
    destinationBank: defaultBank ? {
      payloadDepositMethodLocalId: String(defaultBank._id),
      paymentMethodId: defaultBank.depositMethodId || null,
      isDefaultDepositMethod: bankIsDefault,
      status: defaultBank.status || null,
      verificationStatus: defaultBank.verificationStatus || null,
      transferType: defaultBank.transferType || null,
      last4: defaultBank.last4 || null,
      bankName: defaultBank.bankName || null,
    } : null,
    ownerPayer,
    boardPayer,
    boardCustomerStrategy: boardCustomerResolutionStrategy(),
    actorIsAssignee,
    actorIsBoardForInvoice,
    blockers,
    warnings,
    phase: vendorPayEnabled
      ? (actorIsBoardForInvoice ? 'phase5_board_pay_enabled' : 'phase4_pay_enabled')
      : 'phase3_readiness_only',
    amountCalculation: {
      rule: 'hoa_owner_convenience_fee_v1',
      note: 'Convenience fee uses the same HOA billing settings as Owner HOA invoice pay.',
    },
  };
}

module.exports = {
  getVendorInvoicePayEligibility,
  assertVendorReadyToCreateInvoice,
  findVendorPayloadAccount,
  findDefaultDepositBank,
  resolveOwnerPayerReadiness,
  isDepositBankEligible,
  boardCustomerResolutionStrategy,
  VENDOR_CREATE_INVOICE_BANK_REQUIRED_MESSAGE,
};
