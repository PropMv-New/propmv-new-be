'use strict';

const { PayloadClient } = require('../client/payload.client');
const payloadConfig = require('../../../../../../config/payload.config');

const client = new PayloadClient();

/**
 * Intent shapes follow Payload UI authentication:
 * https://docs.payload.com/ui/authentication/
 * https://docs.payload.com/ui/processing-account-form/integrated-form/
 *
 * processing_account_plugin MUST use intent.type — nested
 * intent.processing_account_plugin is rejected by Payload:
 * "intent[processing_account_plugin] (...: Not a valid field)".
 * The plugin creates NEW processing accounts; existing accounts use application_link.
 */
function buildProcessingAccountPluginIntent(_processingId = null) {
  void _processingId;
  return { type: 'processing_account_plugin' };
}

function buildPaymentMethodFormIntent({
  processingId,
  customerId,
  paymentMethodId = null,
  transferType = 'send-only',
  bankAccountDefaults = null,
  accountHolder = null,
  billingAddressDefaults = null,
  paymentMethodType = null,
}) {
  const paymentMethod = {
    transfer_type: transferType,
  };

  if (paymentMethodId) {
    paymentMethod.id = String(paymentMethodId);
  }

  if (paymentMethodType) {
    paymentMethod.type = String(paymentMethodType);
  }

  if (accountHolder) {
    paymentMethod.account_holder = String(accountHolder);
  }

  // PaymentMethod API accepts customer_id (owner wallet) or account_id (merchant deposit bank).
  // Do NOT send processing_id — Payload rejects it on POST /payment_methods
  // ("processing_id": "Not a valid field" → UI "Payment method setup failed.").
  // Owner processing account is bound via Customer.primary_processing_id at customer create time.
  if (customerId) {
    paymentMethod.customer_id = String(customerId);
  } else if (processingId) {
    paymentMethod.account_id = String(processingId);
  }

  // account_class must live under bank_account (top-level account_class is rejected by POST /payment_methods).
  if (bankAccountDefaults && typeof bankAccountDefaults === 'object') {
    paymentMethod.bank_account = { ...bankAccountDefaults };
  }

  if (billingAddressDefaults && typeof billingAddressDefaults === 'object') {
    paymentMethod.billing_address = { ...billingAddressDefaults };
  }

  return {
    payment_method_form: {
      payment_method: paymentMethod,
    },
  };
}

function buildPaymentFormIntent({ processingId, customerId, amount, description }) {
  const payment = {
    ...(amount != null ? { amount } : {}),
    ...(description ? { description } : {}),
    ...(processingId ? { processing_id: processingId } : {}),
    ...(customerId ? { customer_id: customerId } : {}),
  };

  return {
    payment_form: {
      payment,
    },
  };
}

async function createEphemeralClientToken(intent) {
  const attempts = [{ type: 'client', intent }];

  let lastErr = null;
  for (const body of attempts) {
    try {
      const token = await client.createClientToken(body);
      const clientToken = token?.id || token?.client_token || '';
      if (!clientToken) {
        const err = new Error('Payload did not return a client token.');
        err.statusCode = 502;
        throw err;
      }

      return {
        sessionKey: clientToken,
        sessionId: token?.id || clientToken,
        expiresAt: token?.expires_at || token?.expiration || null,
        clientToken,
        intentId: token?.intent?.id || null,
        intentType: token?.intent?.type || null,
        payloadIntent: token?.intent || null,
      };
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error('Unable to create Payload client token.');
}

async function createProcessingAccountPluginToken({ processingId = null } = {}) {
  // Docs-only shape. Nested processing_account_plugin / processing_id on this intent
  // is invalid. Callers that need to edit an existing account must use
  // createMerchantOnboardingSession (application_link) instead.
  void processingId;
  return createEphemeralClientToken(buildProcessingAccountPluginIntent());
}

async function createPaymentMethodClientToken({
  processingId,
  customerId,
  paymentMethodId = null,
  allowedMethods = 'CARD',
  transferType = 'send-only',
  bankAccountDefaults = null,
  accountHolder = null,
  billingAddressDefaults = null,
  paymentMethodType = null,
}) {
  void allowedMethods;
  return createEphemeralClientToken(buildPaymentMethodFormIntent({
    processingId,
    customerId,
    paymentMethodId,
    transferType,
    bankAccountDefaults,
    accountHolder,
    billingAddressDefaults,
    paymentMethodType,
  }));
}

async function createMerchantOnboardingSession({ merchantId, applicationLinkUrl = null }) {
  // Prefer a freshly minted application link. Stale metadata URLs often fail after
  // the iframe loads for already-submitted / active processing accounts.
  if (applicationLinkUrl && !merchantId) {
    return {
      sessionKey: applicationLinkUrl,
      sessionId: merchantId || null,
      expiresAt: null,
      applicationLinkUrl,
    };
  }

  if (!merchantId) {
    const err = new Error('Payload processing account id is required to open an application link.');
    err.statusCode = 400;
    throw err;
  }

  const link = await client.createProcessingApplicationLink(merchantId);
  const url = link?.url || link?.application_link?.url || applicationLinkUrl || '';
  if (!url) {
    const err = new Error('Payload did not return a processing account application link.');
    err.statusCode = 502;
    throw err;
  }
  return {
    sessionKey: url,
    sessionId: merchantId,
    expiresAt: null,
    applicationLinkUrl: url,
  };
}

async function createPaymentMethodSession({
  merchantId,
  customerId,
  paymentMethodId = null,
  allowedMethods,
  accountHolder = null,
  bankAccountDefaults = null,
  billingAddressDefaults = null,
  paymentMethodType = null,
}) {
  const upper = String(allowedMethods || '').toUpperCase().replace(/\s/g, '');
  const achOnly = upper === 'ACH'
    || (upper.includes('ACH') && !upper.includes('CARD') && !upper.includes('APPLE'));
  const bankDefaults = achOnly
    ? { account_class: 'personal', ...(bankAccountDefaults && typeof bankAccountDefaults === 'object' ? bankAccountDefaults : {}) }
    : (bankAccountDefaults && typeof bankAccountDefaults === 'object' ? { ...bankAccountDefaults } : null);
  return createPaymentMethodClientToken({
    // Owner wallet: customer_id only. Merchant deposit: account_id from processingId.
    processingId: customerId ? null : (merchantId || null),
    customerId,
    paymentMethodId,
    allowedMethods,
    transferType: 'send-only',
    bankAccountDefaults: bankDefaults,
    accountHolder: accountHolder || null,
    billingAddressDefaults: billingAddressDefaults || null,
    paymentMethodType: paymentMethodType
      || (achOnly ? 'bank_account' : (paymentMethodId ? 'card' : null)),
  });
}

async function createDepositMethodSession({ merchantId }) {
  return createPaymentMethodClientToken({
    processingId: merchantId,
    allowedMethods: 'ACH',
    transferType: 'receive-only',
    bankAccountDefaults: { account_class: 'business' },
  });
}

async function createMerchantHubSession({ merchantId, applicationLinkUrl = null }) {
  return createMerchantOnboardingSession({ merchantId, applicationLinkUrl });
}

module.exports = {
  buildProcessingAccountPluginIntent,
  buildPaymentMethodFormIntent,
  buildPaymentFormIntent,
  createEphemeralClientToken,
  createMerchantOnboardingSession,
  createPaymentMethodSession,
  createDepositMethodSession,
  createMerchantHubSession,
  createPaymentMethodClientToken,
  createProcessingAccountPluginToken,
};
