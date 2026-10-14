'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildPaymentMethodFormIntent, buildProcessingAccountPluginIntent } = require('./payloadComponentSession.service');

describe('payloadComponentSession payment method edit intent', () => {
  it('includes payment method id in payment_method_form for Secure Input updates', () => {
    const intent = buildPaymentMethodFormIntent({
      customerId: 'acct_customer',
      paymentMethodId: 'pm_existing',
      transferType: 'send-only',
      bankAccountDefaults: { account_class: 'personal', account_type: 'savings' },
      accountHolder: 'diwakar pra',
      paymentMethodType: 'bank_account',
    });

    assert.equal(intent.payment_method_form.payment_method.id, 'pm_existing');
    assert.equal(intent.payment_method_form.payment_method.customer_id, 'acct_customer');
    assert.equal(intent.payment_method_form.payment_method.type, 'bank_account');
    assert.equal(intent.payment_method_form.payment_method.account_holder, 'diwakar pra');
    assert.equal(intent.payment_method_form.payment_method.bank_account.account_type, 'savings');
  });

  it('uses customer_id only for owner wallet (never processing_id on payment_method_form)', () => {
    const intent = buildPaymentMethodFormIntent({
      processingId: 'acct_processing',
      customerId: 'acct_customer',
      transferType: 'send-only',
    });

    assert.equal(intent.payment_method_form.payment_method.customer_id, 'acct_customer');
    assert.equal(intent.payment_method_form.payment_method.processing_id, undefined);
    assert.equal(intent.payment_method_form.payment_method.account_id, undefined);
  });

  it('uses account_id for merchant deposit banks without customer', () => {
    const intent = buildPaymentMethodFormIntent({
      processingId: 'acct_processing',
      transferType: 'receive-only',
      bankAccountDefaults: { account_class: 'business' },
    });

    assert.equal(intent.payment_method_form.payment_method.account_id, 'acct_processing');
    assert.equal(intent.payment_method_form.payment_method.customer_id, undefined);
    assert.equal(intent.payment_method_form.payment_method.processing_id, undefined);
  });

  it('uses intent.type for processing_account_plugin (never nested processing_account_plugin key)', () => {
    const createIntent = buildProcessingAccountPluginIntent();
    const editAttemptIntent = buildProcessingAccountPluginIntent('acct_existing');
    assert.deepEqual(createIntent, { type: 'processing_account_plugin' });
    assert.deepEqual(editAttemptIntent, { type: 'processing_account_plugin' });
    assert.equal(Object.prototype.hasOwnProperty.call(createIntent, 'processing_account_plugin'), false);
  });
});
