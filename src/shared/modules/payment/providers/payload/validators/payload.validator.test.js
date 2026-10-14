'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  listPaymentMethodsQuerySchema,
  listMerchantsQuerySchema,
  initializeMerchantSchema,
  enableOwnerAutopaySchema,
  executePayloadPayinSchema,
} = require('./payload.validator');

describe('payload.validator listPaymentMethodsQuerySchema', () => {
  it('normalizes entityType to lowercase (HOA → hoa)', () => {
    const { error, value } = listPaymentMethodsQuerySchema.validate({
      entityType: 'HOA',
      entityId: '6aaa3daec282fe37e2549bcf',
    });
    assert.equal(error, undefined);
    assert.equal(value.entityType, 'hoa');
    assert.equal(value.entityId, '6aaa3daec282fe37e2549bcf');
  });

  it('rejects unknown entityType values', () => {
    const { error } = listPaymentMethodsQuerySchema.validate({
      entityType: 'tenant',
      entityId: '6aaa3daec282fe37e2549bcf',
    });
    assert.ok(error);
  });

  it('rejects vendor on owner payment-method schemas (Phase 1 merchant-only)', () => {
    const { error } = listPaymentMethodsQuerySchema.validate({
      entityType: 'vendor',
      entityId: '6aaa3daec282fe37e2549bcf',
    });
    assert.ok(error);
  });
});

describe('payload.validator merchant vendor entityType (Phase 1)', () => {
  const vendorId = '6aaa3daec282fe37e2549bcf';

  it('accepts entityType=vendor on list merchants', () => {
    const { error, value } = listMerchantsQuerySchema.validate({
      entityType: 'Vendor',
      entityId: vendorId,
    });
    assert.equal(error, undefined);
    assert.equal(value.entityType, 'vendor');
  });

  it('accepts entityType=vendor on initialize merchant', () => {
    const { error, value } = initializeMerchantSchema.validate({
      entityType: 'vendor',
      entityId: vendorId,
      accountName: 'Vendor Services LLC',
    });
    assert.equal(error, undefined);
    assert.equal(value.entityType, 'vendor');
    assert.equal(value.accountName, 'Vendor Services LLC');
  });
});

describe('payload.validator enableOwnerAutopaySchema', () => {
  it('requires confirmAutopay=true', () => {
    const hoaId = '6aaa3daec282fe37e2549bcf';
    const paymentMethodLocalId = '6aaa3daec282fe37e2549bd0';
    const { error: missing } = enableOwnerAutopaySchema.validate({
      hoaId,
      paymentMethodLocalId,
    });
    assert.ok(missing);

    const { error, value } = enableOwnerAutopaySchema.validate({
      hoaId,
      paymentMethodLocalId,
      confirmAutopay: true,
    });
    assert.equal(error, undefined);
    assert.equal(value.confirmAutopay, true);
  });
});

describe('payload.validator executePayloadPayinSchema', () => {
  const invoiceId = '6aaa3daec282fe37e2549bcf';
  const paymentMethodId = '6aaa3daec282fe37e2549bd0';
  const coveredA = '6aaa3daec282fe37e2549bd1';
  const coveredB = '6aaa3daec282fe37e2549bd2';

  const base = {
    invoiceId,
    invoicePaymentAmount: 100,
    paymentMethodId,
    paymentAttemptId: 'attempt-1',
  };

  it('accepts single-invoice execute without multi-pay fields (backward compatible)', () => {
    const { error, value } = executePayloadPayinSchema.validate(base);
    assert.equal(error, undefined);
    assert.equal(value.invoicePaymentAmount, 100);
    assert.equal(value.skipPayerFeeAutofill, undefined);
    assert.equal(value.coveredInvoiceIds, undefined);
  });

  it('accepts first multi-invoice leg with fee (skip false / omitted) and empty covered list', () => {
    const { error, value } = executePayloadPayinSchema.validate({
      ...base,
      chargeAmount: 102.9,
      skipPayerFeeAutofill: false,
      coveredInvoiceIds: [],
      description: 'Invoice #INV-OLD – HOA payment',
    });
    assert.equal(error, undefined);
    assert.equal(value.skipPayerFeeAutofill, false);
    assert.deepEqual(value.coveredInvoiceIds, []);
    assert.equal(value.chargeAmount, 102.9);
  });

  it('accepts sibling multi-invoice leg with skipPayerFeeAutofill + coveredInvoiceIds', () => {
    const { error, value } = executePayloadPayinSchema.validate({
      ...base,
      chargeAmount: 100,
      skipPayerFeeAutofill: true,
      coveredInvoiceIds: [coveredA, coveredB],
      description: 'Invoice #INV-NEW – HOA payment',
    });
    assert.equal(error, undefined);
    assert.equal(value.skipPayerFeeAutofill, true);
    assert.deepEqual(value.coveredInvoiceIds, [coveredA, coveredB]);
  });

  it('does not reject the exact owner-pay body shape that previously returned 400', () => {
    // Reproduces the production bug: frontend always sends these on multi-pay legs.
    const { error } = executePayloadPayinSchema.validate({
      invoiceId,
      invoicePaymentAmount: 50,
      chargeAmount: 50,
      paymentMethodId,
      paymentAttemptId: 'attempt-1:6aaa3daec282fe37e2549bcf',
      description: 'Invoice #INV2 – HOA payment',
      skipPayerFeeAutofill: true,
      coveredInvoiceIds: [coveredA],
    }, { abortEarly: false });

    assert.equal(error, undefined);
  });

  it('rejects unknown top-level keys (still strict)', () => {
    const { error } = executePayloadPayinSchema.validate({
      ...base,
      unexpectedField: true,
    });
    assert.ok(error);
    assert.match(String(error.message), /unexpectedField/i);
  });

  it('rejects invalid coveredInvoiceIds entries', () => {
    const { error } = executePayloadPayinSchema.validate({
      ...base,
      coveredInvoiceIds: ['not-an-id'],
    });
    assert.ok(error);
  });

  it('rejects non-boolean skipPayerFeeAutofill', () => {
    const { error } = executePayloadPayinSchema.validate({
      ...base,
      skipPayerFeeAutofill: 'yes',
    });
    assert.ok(error);
  });

  it('rejects more than 50 coveredInvoiceIds', () => {
    const ids = Array.from({ length: 51 }, (_, i) => {
      const hex = i.toString(16).padStart(24, '0');
      return hex;
    });
    const { error } = executePayloadPayinSchema.validate({
      ...base,
      coveredInvoiceIds: ids,
    });
    assert.ok(error);
  });

  it('still requires core payin fields', () => {
    const { error } = executePayloadPayinSchema.validate({
      skipPayerFeeAutofill: true,
      coveredInvoiceIds: [coveredA],
    });
    assert.ok(error);
  });
});

describe('owner multi-pay execute wiring (source contracts)', () => {
  it('controller forwards skipPayerFeeAutofill and coveredInvoiceIds into executeInvoicePayin', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../controller/payload.controller.js'),
      'utf8',
    );
    assert.match(src, /skipPayerFeeAutofill/);
    assert.match(src, /coveredInvoiceIds/);
    assert.match(
      src,
      /executeInvoicePayin\(\{[\s\S]*skipPayerFeeAutofill:\s*Boolean\(skipPayerFeeAutofill\)[\s\S]*coveredInvoiceIds:/,
    );
  });

  it('payin service passes coveredInvoiceIds into assertOwnerOnlinePaymentAllowed', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../service/payloadPayin.service.js'),
      'utf8',
    );
    assert.match(src, /skipPayerFeeAutofill:\s*Boolean\(skipPayerFeeAutofill\)/);
    assert.match(
      src,
      /assertOwnerOnlinePaymentAllowed\([\s\S]*coveredInvoiceIds:\s*Array\.isArray\(coveredInvoiceIds\)/,
    );
  });

  it('route still validates execute body with executePayloadPayinSchema', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../routes/payload.routes.js'),
      'utf8',
    );
    assert.match(
      src,
      /payins\/execute[\s\S]*validateBody\(executePayloadPayinSchema\)/,
    );
  });
});
