'use strict';

/**
 * Phase 4 — Owner → Vendor payin unit tests (no live Payload transactions).
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const path = require('path');
const Module = require('module');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '../../../../../../../.env') });
} catch {
  // optional
}

const vendorInvoiceServicePath = require.resolve(
  '../../../../../../portals/hoa-board/modules/vendor-invoice/service/vendorInvoice.service',
);

const vendorInvoiceStub = {
  getVendorInvoiceById: async () => {
    throw new Error('not configured');
  },
};

describe('payloadVendorPayin Phase 4', () => {
  let payloadConfig;
  let payinService;
  let settlementUtil;
  let originalVendorPay;
  let originalVendorMerchant;
  let originalEnabled;
  let originalLoad;

  beforeEach(() => {
    require.cache[vendorInvoiceServicePath] = {
      id: vendorInvoiceServicePath,
      filename: vendorInvoiceServicePath,
      loaded: true,
      exports: vendorInvoiceStub,
    };
    originalLoad = Module._load;
    Module._load = function patched(request, parent, isMain) {
      if (typeof request === 'string' && request.includes('vendorInvoice.service')) {
        return vendorInvoiceStub;
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    delete require.cache[require.resolve('../../../../../../config/payload.config')];
    delete require.cache[require.resolve('./payloadVendorPayin.service')];
    payloadConfig = require('../../../../../../config/payload.config');
    originalVendorPay = payloadConfig.payload.vendorPayEnabled;
    originalVendorMerchant = payloadConfig.payload.vendorMerchantEnabled;
    originalEnabled = payloadConfig.payload.enabled;
    payloadConfig.payload.enabled = true;
    payloadConfig.payload.vendorMerchantEnabled = true;
    payloadConfig.payload.vendorPayEnabled = true;
    payinService = require('./payloadVendorPayin.service');
    settlementUtil = require('../utils/payloadPayinSettlement.util');
  });

  afterEach(() => {
    Module._load = originalLoad;
    payloadConfig.payload.vendorPayEnabled = originalVendorPay;
    payloadConfig.payload.vendorMerchantEnabled = originalVendorMerchant;
    payloadConfig.payload.enabled = originalEnabled;
    delete require.cache[vendorInvoiceServicePath];
  });

  it('resolveVendorPayinAmounts without methodType charges invoice amount only (fee=0)', async () => {
    const amounts = await payinService.resolveVendorPayinAmounts(100.5);
    assert.equal(amounts.invoicePaymentAmount, 100.5);
    assert.equal(amounts.chargeAmountDollars, 100.5);
    assert.equal(amounts.chargeAmountCents, 10050);
    assert.equal(amounts.processingFeeAmount, 0);
  });

  it('resolveVendorPayinAmounts applies HOA billing convenience fee for card', async () => {
    const { normalizeBillingSettings } = require('../../../../billing-settings/service/billingSettings.service');
    const amounts = await payinService.resolveVendorPayinAmounts(100, {
      methodType: 'CARD',
      billingSettings: normalizeBillingSettings(),
    });
    assert.equal(amounts.invoicePaymentAmount, 100);
    assert.ok(amounts.processingFeeAmount > 0);
    assert.equal(amounts.chargeAmountDollars, 100 + amounts.processingFeeAmount);
  });

  it('resolveVendorPayinAmounts rejects non-positive amounts', async () => {
    await assert.rejects(
      () => payinService.resolveVendorPayinAmounts(0),
      (err) => err.statusCode === 400,
    );
  });

  it('buildVendorPayinIdempotencyKey is stable per attempt', () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const invoiceId = new mongoose.Types.ObjectId().toString();
    const a = payinService.buildVendorPayinIdempotencyKey({
      userId,
      vendorInvoiceId: invoiceId,
      paymentAttemptId: 'attempt-1',
    });
    const b = payinService.buildVendorPayinIdempotencyKey({
      userId,
      vendorInvoiceId: invoiceId,
      paymentAttemptId: 'attempt-1',
    });
    const c = payinService.buildVendorPayinIdempotencyKey({
      userId,
      vendorInvoiceId: invoiceId,
      paymentAttemptId: 'attempt-2',
    });
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  it('settlement util is sole authority — ACH PROCESSING does not settle', () => {
    const action = settlementUtil.resolvePayloadPayinSettlementAction({
      methodType: 'ACH',
      status: 'PROCESSING',
      eventType: 'authorized',
      alreadySettled: false,
    });
    assert.equal(action, 'none');
  });

  it('settlement util settles card on PROCESSING', () => {
    const action = settlementUtil.resolvePayloadPayinSettlementAction({
      methodType: 'CARD',
      status: 'PROCESSING',
      eventType: 'authorized',
      alreadySettled: false,
    });
    assert.equal(action, 'settle');
  });

  it('settlement util settles card on immediate SUCCEEDED/processed (no intermediate PROCESSING)', () => {
    assert.equal(
      settlementUtil.resolvePayloadPayinSettlementAction({
        methodType: 'CARD',
        status: 'SUCCEEDED',
        eventType: '',
        alreadySettled: false,
      }),
      'settle',
    );
    assert.equal(
      settlementUtil.resolvePayloadPayinSettlementAction({
        methodType: 'CARD',
        status: 'SUCCEEDED',
        eventType: 'processed',
        alreadySettled: true,
      }),
      'none',
    );
  });

  it('settlement util settles ACH only on SUCCEEDED', () => {
    assert.equal(
      settlementUtil.resolvePayloadPayinSettlementAction({
        methodType: 'ACH',
        status: 'SUCCEEDED',
        eventType: 'processed',
        alreadySettled: false,
      }),
      'settle',
    );
  });

  it('assertVendorPayEnabled rejects when pay flag off', async () => {
    payloadConfig.payload.vendorPayEnabled = false;
    vendorInvoiceStub.getVendorInvoiceById = async () => ({
      _id: new mongoose.Types.ObjectId(),
      assignedTo: new mongoose.Types.ObjectId(),
      status: 'Pending',
      balanceDue: 10,
      subAmount: 10,
      amountPaid: 0,
      vendorId: new mongoose.Types.ObjectId(),
      hoaId: new mongoose.Types.ObjectId(),
    });
    await assert.rejects(
      () => payinService.validateVendorInvoicePayin({
        vendorInvoiceId: new mongoose.Types.ObjectId().toString(),
        actorId: new mongoose.Types.ObjectId().toString(),
        invoicePaymentAmount: 10,
        paymentMethodLocalId: new mongoose.Types.ObjectId().toString(),
      }),
      (err) => err.code === 'VENDOR_PAY_DISABLED' || err.statusCode === 403,
    );
  });

  it('assertVendorPayPayerAuthorized allows assignee Owner', () => {
    const assignee = new mongoose.Types.ObjectId();
    const hoaId = new mongoose.Types.ObjectId();
    const result = payinService.assertVendorPayPayerAuthorized({
      invoice: { assignedTo: assignee, hoaId },
      actorId: String(assignee),
      hoaContext: null,
    });
    assert.equal(result.payerRole, 'owner');
  });

  it('assertVendorPayPayerAuthorized allows Board of invoice HOA', () => {
    const hoaId = new mongoose.Types.ObjectId();
    const result = payinService.assertVendorPayPayerAuthorized({
      invoice: {
        assignedTo: new mongoose.Types.ObjectId(),
        hoaId,
      },
      actorId: String(new mongoose.Types.ObjectId()),
      hoaContext: { isHOABoardMember: true, hoaId: String(hoaId) },
    });
    assert.equal(result.payerRole, 'board');
  });

  it('assertVendorPayPayerAuthorized denies non-assignee Owner', () => {
    assert.throws(
      () => payinService.assertVendorPayPayerAuthorized({
        invoice: {
          assignedTo: new mongoose.Types.ObjectId(),
          hoaId: new mongoose.Types.ObjectId(),
        },
        actorId: String(new mongoose.Types.ObjectId()),
        hoaContext: null,
      }),
      (err) => err.code === 'VENDOR_PAY_ASSIGNEE_ONLY' && err.statusCode === 403,
    );
  });

  it('assertVendorPayPayerAuthorized denies wrong-HOA Board', () => {
    assert.throws(
      () => payinService.assertVendorPayPayerAuthorized({
        invoice: {
          assignedTo: new mongoose.Types.ObjectId(),
          hoaId: new mongoose.Types.ObjectId(),
        },
        actorId: String(new mongoose.Types.ObjectId()),
        hoaContext: {
          isHOABoardMember: true,
          hoaId: String(new mongoose.Types.ObjectId()),
        },
      }),
      (err) => err.code === 'VENDOR_PAY_BOARD_HOA_MISMATCH' && err.statusCode === 403,
    );
  });

  it('assertVendorChargeDestinationNotHoa rejects HOA processing_id', async () => {
    const hoaId = new mongoose.Types.ObjectId();
    const PayloadAccount = require('../model/payloadAccount.model');
    const originalFind = PayloadAccount.find;
    PayloadAccount.find = () => ({
      select: () => ({
        lean: async () => [{ _id: new mongoose.Types.ObjectId(), merchantId: 'acct_hoa_forbidden' }],
      }),
    });
    try {
      await assert.rejects(
        () => payinService.assertVendorChargeDestinationNotHoa({
          hoaId: String(hoaId),
          processingId: 'acct_hoa_forbidden',
          processingMethodId: 'pm_vendor_bank',
          vendorProcessingId: 'acct_hoa_forbidden',
          vendorDepositMethodId: 'pm_vendor_bank',
        }),
        (err) => err.code === 'HOA_PROCESSING_ID_FORBIDDEN',
      );
    } finally {
      PayloadAccount.find = originalFind;
    }
  });

  it('assertVendorChargeDestinationNotHoa requires Vendor processing ids', async () => {
    await assert.rejects(
      () => payinService.assertVendorChargeDestinationNotHoa({
        hoaId: String(new mongoose.Types.ObjectId()),
        processingId: 'acct_wrong',
        processingMethodId: 'pm_bank',
        vendorProcessingId: 'acct_vendor',
        vendorDepositMethodId: 'pm_bank',
      }),
      (err) => err.code === 'VENDOR_PROCESSING_ID_MISMATCH',
    );
  });

  it('idempotency key differs by payer userId (Owner vs Board)', () => {
    const invoiceId = new mongoose.Types.ObjectId().toString();
    const ownerKey = payinService.buildVendorPayinIdempotencyKey({
      userId: 'owner-user',
      vendorInvoiceId: invoiceId,
      paymentAttemptId: 'attempt-shared',
    });
    const boardKey = payinService.buildVendorPayinIdempotencyKey({
      userId: 'board-user',
      vendorInvoiceId: invoiceId,
      paymentAttemptId: 'attempt-shared',
    });
    assert.notEqual(ownerKey, boardKey);
  });

  it('resolveRequiredDefaultDepositBank requires default/primary on Vendor PA only', async () => {
    const vendorPaId = new mongoose.Types.ObjectId();
    const hoaPaId = new mongoose.Types.ObjectId();
    const { PayloadDepositMethod } = require('../model/payloadDepositMethod.model');
    const originalFindOne = PayloadDepositMethod.findOne;
    const queries = [];

    PayloadDepositMethod.findOne = (query) => {
      queries.push(query);
      return {
        sort: async () => {
          // HOA bank linked to HOA PA must never satisfy Vendor destination lookup.
          if (String(query.payloadAccountRef) === String(hoaPaId)) {
            return {
              _id: new mongoose.Types.ObjectId(),
              payloadAccountRef: hoaPaId,
              depositMethodId: 'pm_hoa_bank',
              defaultDepositMethod: true,
              isPrimaryPayout: true,
              status: 'ACTIVE',
            };
          }
          if (String(query.payloadAccountRef) === String(vendorPaId)
            && query.$or
          ) {
            return {
              _id: new mongoose.Types.ObjectId(),
              payloadAccountRef: vendorPaId,
              depositMethodId: 'pm_vendor_default',
              defaultDepositMethod: true,
              isPrimaryPayout: true,
              status: 'ACTIVE',
            };
          }
          return null;
        },
      };
    };

    try {
      const missing = await payinService.resolveRequiredDefaultDepositBank({
        _id: vendorPaId,
      });
      // First call uses vendor PA — mock returns default bank
      assert.equal(missing?.depositMethodId, 'pm_vendor_default');
      assert.equal(String(queries[0].payloadAccountRef), String(vendorPaId));
      assert.ok(queries[0].$or.some((c) => c.defaultDepositMethod === true));

      const hoaLookup = await payinService.resolveRequiredDefaultDepositBank({ _id: hoaPaId });
      // Even if an HOA bank exists under an HOA PA id, Vendor validate scopes by Vendor PA only.
      assert.equal(hoaLookup?.depositMethodId, 'pm_hoa_bank');
      assert.equal(String(queries[1].payloadAccountRef), String(hoaPaId));
    } finally {
      PayloadDepositMethod.findOne = originalFindOne;
    }
  });
});
