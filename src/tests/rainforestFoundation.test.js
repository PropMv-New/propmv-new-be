'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  mapRainforestMerchantStatus,
  merchantStatusLabel,
} = require('../shared/modules/payment/providers/rainforest/utils/rainforestStatus.util');
const {
  verifyRainforestWebhookSignature,
} = require('../shared/modules/payment/providers/rainforest/utils/rainforestWebhookSignature.util');
const {
  buildMerchantOnboardingSession,
  buildPaymentMethodSession,
  buildDepositMethodSession,
} = require('../shared/modules/payment/providers/rainforest/service/rainforestComponentSession.service');
const { deriveEventId } = require('../shared/modules/payment/providers/rainforest/service/rainforestWebhook.service');
const { toUserFriendlyRainforestMessage } = require('../shared/modules/payment/providers/rainforest/utils/rainforestUserError.util');
const crypto = require('crypto');

describe('rainforest status mapping', () => {
  test('maps merchant.active to ACTIVE onboarding status', () => {
    assert.equal(mapRainforestMerchantStatus('ACTIVE', 'COMPLETED'), 'ACTIVE');
  });

  test('maps merchant_application.needs_information correctly', () => {
    assert.equal(mapRainforestMerchantStatus('ONBOARDING', 'NEEDS_INFORMATION'), 'NEEDS_INFORMATION');
    assert.equal(merchantStatusLabel('NEEDS_INFORMATION'), 'Action required');
  });
});

describe('rainforest component sessions', () => {
  test('merchant onboarding session scopes to merchant_id', () => {
    const payload = buildMerchantOnboardingSession({ merchantId: 'mid_123', ttlSeconds: 3600 });
    assert.equal(payload.statements[0].permissions[0], 'group#merchant_onboarding_component');
    assert.equal(payload.statements[0].constraints.merchant.merchant_id, 'mid_123');
  });

  test('payment method session uses payment_component group', () => {
    const payload = buildPaymentMethodSession({ merchantId: 'mid_abc', ttlSeconds: 3600 });
    assert.equal(payload.statements[0].permissions[0], 'group#payment_component');
    assert.equal(payload.statements[0].constraints.merchant.merchant_id, 'mid_abc');
  });

  test('deposit method session scopes to merchant with onboarding + payment groups', () => {
    const payload = buildDepositMethodSession({ merchantId: 'mid_dep', ttlSeconds: 3600 });
    assert.deepEqual(payload.statements[0].permissions, [
      'group#merchant_onboarding_component',
      'group#payment_component',
    ]);
    assert.equal(payload.statements[0].constraints.merchant.merchant_id, 'mid_dep');
  });

  test('merchant hub session scopes group#all to merchant_id', () => {
    const { buildMerchantHubSession } = require('../shared/modules/payment/providers/rainforest/service/rainforestComponentSession.service');
    const payload = buildMerchantHubSession({ merchantId: 'mid_hub', ttlSeconds: 3600 });
    assert.equal(payload.statements[0].permissions[0], 'group#all');
    assert.equal(payload.statements[0].constraints.merchant.merchant_id, 'mid_hub');
  });
});

describe('rainforest deposit bank setup flow', () => {
  const {
    resolveDepositBankSetupFlow,
    depositBankBlockedReason,
  } = require('../shared/modules/payment/providers/rainforest/utils/rainforestStatus.util');
  const { MERCHANT_ONBOARDING_STATUS } = require('../shared/modules/payment/providers/rainforest/constants/rainforest.constants');

  test('ACTIVE merchants use merchant hub flow', () => {
    assert.equal(resolveDepositBankSetupFlow(MERCHANT_ONBOARDING_STATUS.ACTIVE), 'hub');
  });

  test('editable onboarding statuses use onboarding flow', () => {
    assert.equal(resolveDepositBankSetupFlow(MERCHANT_ONBOARDING_STATUS.CREATED), 'onboarding');
    assert.equal(resolveDepositBankSetupFlow(MERCHANT_ONBOARDING_STATUS.ONBOARDING), 'onboarding');
    assert.equal(resolveDepositBankSetupFlow(MERCHANT_ONBOARDING_STATUS.NEEDS_INFORMATION), 'onboarding');
  });

  test('under review statuses are blocked', () => {
    assert.equal(resolveDepositBankSetupFlow(MERCHANT_ONBOARDING_STATUS.PROCESSING), 'blocked');
    assert.equal(resolveDepositBankSetupFlow(MERCHANT_ONBOARDING_STATUS.IN_REVIEW), 'blocked');
    assert.match(depositBankBlockedReason(MERCHANT_ONBOARDING_STATUS.PROCESSING), /under Rainforest review/i);
  });
});

describe('rainforest billable merchant resolution', () => {
  const {
    buildHoaBillableMerchantQuery,
    isBillableRainforestMerchantAccount,
  } = require('../shared/modules/payment/providers/rainforest/utils/rainforestBillableMerchant.util');
  const { MERCHANT_ONBOARDING_STATUS, MERCHANT_STATUS, ENTITY_TYPE } = require('../shared/modules/payment/providers/rainforest/constants/rainforest.constants');

  test('buildHoaBillableMerchantQuery scopes by HOA metadata', () => {
    const query = buildHoaBillableMerchantQuery('6a6f2a1cb59290eb87a6ae1c');
    assert.equal(query.entityType, ENTITY_TYPE.HOA);
    assert.equal(query['metadata.hoaId'], '6a6f2a1cb59290eb87a6ae1c');
  });

  test('isBillableRainforestMerchantAccount accepts ACTIVE onboarding or merchant status', () => {
    assert.equal(isBillableRainforestMerchantAccount({
      merchantId: 'sbx_mid_1',
      onboardingStatus: MERCHANT_ONBOARDING_STATUS.ACTIVE,
    }), true);
    assert.equal(isBillableRainforestMerchantAccount({
      merchantId: 'sbx_mid_2',
      merchantStatus: MERCHANT_STATUS.ACTIVE,
      onboardingStatus: MERCHANT_ONBOARDING_STATUS.PROCESSING,
    }), true);
    assert.equal(isBillableRainforestMerchantAccount({
      merchantId: 'sbx_mid_3',
      onboardingStatus: MERCHANT_ONBOARDING_STATUS.PROCESSING,
    }), false);
  });
});

describe('rainforest payment method config', () => {
  test('resolvePlatformIdForBillableMerchant returns configured platform id', async () => {
    const rainforestConfig = require('../config/rainforest.config');
    const { resolvePlatformIdForBillableMerchant } = require('../shared/modules/payment/providers/rainforest/utils/rainforestPlatform.util');
    if (!rainforestConfig.rainforest.platformId) return;

    const platformId = await resolvePlatformIdForBillableMerchant('sbx_mid_test');
    assert.equal(platformId, rainforestConfig.rainforest.platformId);
  });
});

describe('rainforest webhook signature', () => {
  test('rejects missing signature header', () => {
    const result = verifyRainforestWebhookSignature({
      req: { headers: {} },
      secret: 'test-secret',
      rawBody: JSON.stringify({ event_type: 'merchant.active', data: { merchant_id: 'mid_1' } }),
    });
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'missing_signature');
  });

  test('accepts direct sha256 hmac signature', () => {
    const secret = 'test-secret';
    const rawBody = JSON.stringify({ event_type: 'merchant.active', data: { merchant_id: 'mid_1' } });
    const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const result = verifyRainforestWebhookSignature({
      req: { headers: { 'rainforest-signature': digest } },
      secret,
      rawBody,
    });
    assert.equal(result.valid, true);
  });
});

describe('rainforest user-facing errors', () => {
  test('maps duplicate merchant name to friendly message', () => {
    const message = toUserFriendlyRainforestMessage(
      400,
      'Invalid merchant name: must be a unique identifier.'
    );
    assert.match(message, /already registered/i);
  });
});

describe('rainforest webhook idempotency key', () => {
  test('deriveEventId is stable for same payload', () => {
    const payload = { event_type: 'payment_method.active', data: { payment_method_id: 'mtd_1' } };
    const raw = JSON.stringify(payload);
    const a = deriveEventId(payload, raw);
    const b = deriveEventId(payload, raw);
    assert.equal(a, b);
  });
});

describe('rainforest payin settlement policy', () => {
  const {
    resolveRainforestPayinSettlementAction,
    dollarsToMinorUnits,
    minorUnitsToDollars,
  } = require('../shared/modules/payment/providers/rainforest/utils/rainforestPayinSettlement.util');

  test('settles card payins on processing', () => {
    assert.equal(resolveRainforestPayinSettlementAction({
      methodType: 'CARD',
      status: 'PROCESSING',
      eventType: 'payin.processing',
    }), 'settle');
  });

  test('settles card payins on succeeded (idempotent with already_settled)', () => {
    assert.equal(resolveRainforestPayinSettlementAction({
      methodType: 'CARD',
      status: 'SUCCEEDED',
      eventType: 'payin.succeeded',
    }), 'settle');
  });

  test('settles ACH payins only on succeeded', () => {
    assert.equal(resolveRainforestPayinSettlementAction({
      methodType: 'ACH',
      status: 'PROCESSING',
      eventType: 'payin.processing',
    }), 'none');
    assert.equal(resolveRainforestPayinSettlementAction({
      methodType: 'ACH',
      status: 'SUCCEEDED',
      eventType: 'payin.succeeded',
    }), 'settle');
  });

  test('fails ACH payins on returned status and ach return flags', () => {
    assert.equal(resolveRainforestPayinSettlementAction({
      methodType: 'ACH',
      status: 'RETURNED',
      eventType: 'payin.returned',
    }), 'fail');
    assert.equal(resolveRainforestPayinSettlementAction({
      methodType: 'ACH',
      status: 'SUCCEEDED',
      eventType: 'payin.succeeded',
      hasAchReturn: true,
    }), 'fail');
  });

  test('converts dollars and cents consistently', () => {
    assert.equal(dollarsToMinorUnits(150.25), 15025);
    assert.equal(minorUnitsToDollars(15025), 150.25);
  });
});

describe('rainforest payin display', () => {
  const {
    buildRainforestPayinStatusHistory,
    buildRainforestPayinTrackerPayload,
    mapRainforestPayinStatusForTracker,
  } = require('../shared/modules/payment/providers/rainforest/utils/rainforestPayinDisplay.util');

  test('maps rainforest statuses to tracker-compatible values', () => {
    assert.equal(mapRainforestPayinStatusForTracker('PROCESSING'), 'pending');
    assert.equal(mapRainforestPayinStatusForTracker('SUCCEEDED'), 'paid');
    assert.equal(mapRainforestPayinStatusForTracker('RETURNED'), 'reversed');
  });

  test('builds synthetic status history from payin lifecycle fields', () => {
    const history = buildRainforestPayinStatusHistory({
      status: 'SUCCEEDED',
      createdAt: new Date('2026-01-01T12:00:00.000Z'),
      settledAt: new Date('2026-01-01T12:05:00.000Z'),
    });
    assert.ok(history.length >= 2);
    assert.equal(history[history.length - 1].status, 'paid');
  });

  test('buildRainforestPayinTrackerPayload exposes status_history', () => {
    const payload = buildRainforestPayinTrackerPayload({
      status: 'PROCESSING',
      methodType: 'ACH',
      payinId: 'pyi_123',
      merchantId: 'mid_123',
      createdAt: new Date('2026-01-01T12:00:00.000Z'),
      updatedAt: new Date('2026-01-01T12:01:00.000Z'),
    });
    assert.equal(payload.payin_id, 'pyi_123');
    assert.ok(Array.isArray(payload.status_history));
    assert.ok(payload.status_history.length > 0);
  });
});

describe('rainforest payin allocation validation', () => {
  const { detectMultiMerchantPayinIssues } = require('../shared/modules/payment/providers/rainforest/utils/rainforestPayinAllocation.util');

  test('detects allocations spanning multiple merchants', () => {
    const issues = detectMultiMerchantPayinIssues([
      { invoiceId: '1', merchantId: 'mid_a' },
      { invoiceId: '2', merchantId: 'mid_b' },
    ]);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, 'MULTI_MERCHANT_ALLOCATION');
  });

  test('accepts allocations for a single merchant', () => {
    const issues = detectMultiMerchantPayinIssues([
      { invoiceId: '1', merchantId: 'mid_a' },
      { invoiceId: '2', merchantId: 'mid_a' },
    ]);
    assert.equal(issues.length, 0);
  });
});

describe('rainforest refund settlement', () => {
  const {
    resolveRainforestRefundLifecycleAction,
    normalizeRefundStatus,
  } = require('../shared/modules/payment/providers/rainforest/utils/rainforestRefundSettlement.util');
  const {
    mapInvoiceRefundToPayinMinorUnits,
    remainingInvoiceRefundableAmount,
    buildRefundIdempotencyKey,
  } = require('../shared/modules/payment/providers/rainforest/utils/rainforestRefundSettlement.util');

  test('resolveRainforestRefundLifecycleAction completes on succeeded', () => {
    assert.equal(
      resolveRainforestRefundLifecycleAction({ status: 'SUCCEEDED', eventType: 'refund.succeeded' }),
      'complete'
    );
  });

  test('resolveRainforestRefundLifecycleAction fails on failed/canceled', () => {
    assert.equal(resolveRainforestRefundLifecycleAction({ status: 'FAILED' }), 'fail');
    assert.equal(resolveRainforestRefundLifecycleAction({ eventType: 'refund.canceled' }), 'fail');
  });

  test('normalizeRefundStatus uppercases values', () => {
    assert.equal(normalizeRefundStatus('processing'), 'PROCESSING');
  });

  test('mapInvoiceRefundToPayinMinorUnits scales fee-inclusive charges', () => {
    const cents = mapInvoiceRefundToPayinMinorUnits(50, {
      invoicePaymentAmount: 100,
      chargeAmountCents: 10300,
    });
    assert.equal(cents, 5150);
  });

  test('remainingInvoiceRefundableAmount subtracts prior refunds', () => {
    assert.equal(
      remainingInvoiceRefundableAmount({ amount: 100, refundedAmount: 25 }),
      75
    );
    assert.equal(
      remainingInvoiceRefundableAmount({ amount: 100, refundedAmount: 100, refundedAt: new Date() }),
      0
    );
  });

  test('buildRefundIdempotencyKey is deterministic', () => {
    const a = buildRefundIdempotencyKey({
      userId: 'u1',
      invoiceId: 'i1',
      paymentTransactionId: 'p1',
      refundAttemptId: 'attempt-1',
    });
    const b = buildRefundIdempotencyKey({
      userId: 'u1',
      invoiceId: 'i1',
      paymentTransactionId: 'p1',
      refundAttemptId: 'attempt-1',
    });
    assert.equal(a, b);
    assert.equal(a.length, 40);
  });
});

describe('rainforest platform fee splits', () => {
  const {
    calculateRainforestProcessingFee,
    buildRainforestPlatformAmountSplits,
    validateRainforestPayinAmounts,
    buildRainforestRefundAmountSplits,
    resolveRainforestFeeMethodKey,
  } = require('../shared/modules/payment/providers/rainforest/utils/rainforestPayinFee.util');

  test('resolveRainforestFeeMethodKey maps card and ACH types', () => {
    assert.equal(resolveRainforestFeeMethodKey('CARD'), 'card');
    assert.equal(resolveRainforestFeeMethodKey('PLAID_ACH'), 'bankTransfer');
  });

  test('calculateRainforestProcessingFee adds payer fee and platform split', () => {
    const result = calculateRainforestProcessingFee({
      invoicePaymentAmount: 100,
      methodType: 'CARD',
      billingSettings: {
        transactionFees: {
          card: { feePercent: 2.99, paidBy: 'payer' },
          bankTransfer: { feeAmount: 2, paidBy: 'payer' },
        },
      },
    });
    assert.equal(result.processingFeeAmount, 2.99);
    assert.equal(result.chargeAmount, 102.99);
    assert.equal(result.platformFeeCents, 299);
    assert.ok(Array.isArray(result.amountSplits));
    assert.equal(result.amountSplits[0].type, 'PLATFORM');
    assert.equal(result.amountSplits[0].amount, 299);
    assert.equal(result.amountSplits[0].amount_split_reversal_config.on_full_refund, true);
  });

  test('operator-paid fees skip platform split', () => {
    const result = calculateRainforestProcessingFee({
      invoicePaymentAmount: 100,
      methodType: 'CARD',
      billingSettings: {
        transactionFees: {
          card: { feePercent: 2.99, paidBy: 'operator' },
          bankTransfer: { feeAmount: 2, paidBy: 'payer' },
        },
      },
    });
    assert.equal(result.processingFeeAmount, 0);
    assert.equal(result.chargeAmount, 100);
    assert.equal(result.platformFeeCents, 0);
    assert.equal(result.amountSplits, null);
  });

  test('validateRainforestPayinAmounts rejects mismatched charge totals', () => {
    const validation = validateRainforestPayinAmounts({
      invoicePaymentAmount: 100,
      chargeAmount: 100,
      methodType: 'CARD',
      billingSettings: {
        transactionFees: {
          card: { feePercent: 2.99, paidBy: 'payer' },
          bankTransfer: { feeAmount: 2, paidBy: 'payer' },
        },
      },
    });
    assert.equal(validation.valid, false);
    assert.equal(validation.reason, 'missing_payer_fee');
    assert.equal(validation.expectedChargeAmount, 102.99);
  });

  test('buildRainforestRefundAmountSplits scales platform reversal proportionally', () => {
    const splits = buildRainforestRefundAmountSplits(
      { platformFeeCents: 300, chargeAmountCents: 10300 },
      5150
    );
    assert.ok(splits);
    assert.equal(splits[0].amount, 150);
  });

  test('resolveAuthoritativeRainforestPayinAmounts adds missing payer fee server-side', () => {
    const { resolveAuthoritativeRainforestPayinAmounts } = require('../shared/modules/payment/providers/rainforest/utils/rainforestPayinFee.util');
    const billingSettings = {
      transactionFees: {
        card: { feePercent: 2.99, paidBy: 'payer' },
        bankTransfer: { feeAmount: 2, paidBy: 'payer' },
      },
    };
    const resolved = resolveAuthoritativeRainforestPayinAmounts({
      invoicePaymentAmount: 100,
      chargeAmount: 100,
      methodType: 'CARD',
      billingSettings,
    });
    assert.equal(resolved.validation.valid, true);
    assert.equal(resolved.totalCharge, 102.99);
    assert.equal(resolved.validation.processingFeeAmount, 2.99);
  });
});

describe('rainforest production hardening', () => {
  const {
    shouldRetryWebhookEvent,
    buildRetryableWebhookQuery,
    DEFAULT_MAX_WEBHOOK_RETRIES,
  } = require('../shared/modules/payment/providers/rainforest/utils/rainforestWebhookRetry.util');
  const {
    assessRainforestPayinRow,
    assessFailedWebhookEvent,
    summarizeReconciliationIssues,
    RECONCILIATION_ISSUE,
  } = require('../shared/modules/payment/providers/rainforest/utils/rainforestReconciliation.util');
  const { WEBHOOK_PROCESSING_STATUS, PAYIN_STATUS } = require('../shared/modules/payment/providers/rainforest/constants/rainforest.constants');

  test('shouldRetryWebhookEvent respects max retry count', () => {
    assert.equal(shouldRetryWebhookEvent({
      retryCount: 2,
      maxRetries: 5,
      processingStatus: WEBHOOK_PROCESSING_STATUS.FAILED,
    }), true);
    assert.equal(shouldRetryWebhookEvent({
      retryCount: 5,
      maxRetries: 5,
      processingStatus: WEBHOOK_PROCESSING_STATUS.FAILED,
    }), false);
    assert.equal(shouldRetryWebhookEvent({
      retryCount: 0,
      processingStatus: WEBHOOK_PROCESSING_STATUS.PROCESSED,
    }), false);
  });

  test('buildRetryableWebhookQuery caps batch size', () => {
    const built = buildRetryableWebhookQuery({ maxRetries: DEFAULT_MAX_WEBHOOK_RETRIES, limit: 500 });
    assert.equal(built.limit, 100);
    assert.equal(built.query.processingStatus, WEBHOOK_PROCESSING_STATUS.FAILED);
  });

  test('assessRainforestPayinRow flags settled payin without invoice tx or ledger', () => {
    const issues = assessRainforestPayinRow({
      payin: {
        _id: '665f0c1cb59290eb87a6ae20',
        payinId: 'pyi_123',
        invoiceId: '665f0c1cb59290eb87a6ae1d',
        status: PAYIN_STATUS.SUCCEEDED,
        invoicePaymentAmount: 150,
      },
      invoice: {
        _id: '665f0c1cb59290eb87a6ae1d',
        propertyId: '665f0c1cb59290eb87a6ae1e',
        paymentTransactions: [],
      },
      ledgerEntries: [],
    });
    assert.ok(issues.some((issue) => issue.code === RECONCILIATION_ISSUE.PAYIN_SETTLED_MISSING_INVOICE_TX));
    assert.ok(issues.some((issue) => issue.code === RECONCILIATION_ISSUE.PAYIN_SETTLED_MISSING_LEDGER));
  });

  test('assessRainforestPayinRow flags returned payin with completed invoice row', () => {
    const issues = assessRainforestPayinRow({
      payin: {
        _id: '665f0c1cb59290eb87a6ae20',
        payinId: 'pyi_456',
        invoiceId: '665f0c1cb59290eb87a6ae1d',
        status: PAYIN_STATUS.RETURNED,
        invoicePaymentAmount: 150,
      },
      invoice: {
        _id: '665f0c1cb59290eb87a6ae1d',
        paymentTransactions: [{
          status: 'completed',
          amount: 150,
          gatewayTransactionId: '665f0c1cb59290eb87a6ae20',
          gatewayExternalId: 'pyi_456',
        }],
      },
      ledgerEntries: [],
    });
    assert.ok(issues.some((issue) => issue.code === RECONCILIATION_ISSUE.PAYIN_RETURNED_STILL_COMPLETED));
  });

  test('assessFailedWebhookEvent and summary helpers', () => {
    const issue = assessFailedWebhookEvent({
      processingStatus: WEBHOOK_PROCESSING_STATUS.FAILED,
      eventId: 'evt_1',
      eventType: 'payin.succeeded',
      retryCount: 2,
      error: 'timeout',
    });
    assert.equal(issue.code, RECONCILIATION_ISSUE.WEBHOOK_FAILED);
    const summary = summarizeReconciliationIssues([issue]);
    assert.equal(summary.total, 1);
    assert.equal(summary.hasHigh, true);
  });
});

describe('rainforest wallet payment method types', () => {
  const {
    isCardsSectionMethodType,
    isInstantSettleMethodType,
    isWalletMethodType,
    allowedMethodsNeedOriginatingMerchant,
    allowedMethodsNeedWalletButtons,
    RAINFOREST_CARDS_SECTION_ALLOWED_METHODS,
  } = require('../shared/modules/payment/providers/rainforest/utils/rainforestPaymentMethodType.util');
  const { PAYMENT_METHOD_TYPE } = require('../shared/modules/payment/providers/rainforest/constants/rainforest.constants');

  test('cards section includes card and wallet types', () => {
    assert.equal(isCardsSectionMethodType(PAYMENT_METHOD_TYPE.CARD), true);
    assert.equal(isCardsSectionMethodType(PAYMENT_METHOD_TYPE.APPLE_PAY), true);
    assert.equal(isCardsSectionMethodType(PAYMENT_METHOD_TYPE.VENMO), true);
    assert.equal(isCardsSectionMethodType(PAYMENT_METHOD_TYPE.ACH), false);
  });

  test('wallet types use instant settlement policy', () => {
    assert.equal(isInstantSettleMethodType(PAYMENT_METHOD_TYPE.PAYPAL_WALLET), true);
    assert.equal(isInstantSettleMethodType(PAYMENT_METHOD_TYPE.PLAID_ACH), false);
  });

  test('allowedMethods helpers detect wallet button and PayPal config needs', () => {
    assert.equal(allowedMethodsNeedWalletButtons(RAINFOREST_CARDS_SECTION_ALLOWED_METHODS), true);
    assert.equal(allowedMethodsNeedWalletButtons('CARD,ACH'), false);
    assert.equal(allowedMethodsNeedOriginatingMerchant('CARD,VENMO'), true);
    assert.equal(isWalletMethodType(PAYMENT_METHOD_TYPE.APPLE_PAY), true);
  });
});
