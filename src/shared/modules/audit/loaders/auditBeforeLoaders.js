'use strict';

const mongoose = require('mongoose');
const billingSettingsService = require('../../billing-settings/service/billingSettings.service');

function toObjectId(value) {
  const str = String(value || '').trim();
  if (!mongoose.Types.ObjectId.isValid(str)) return null;
  return str;
}

/**
 * Safe snapshot of a legacy PaymentBankAccount (excludes full routing number).
 */
function snapshotPaymentBankAccount(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    holderName: doc.holderName || '',
    last4: doc.last4 || '',
    accountType: doc.accountType || '',
    verificationStatus: doc.verificationStatus || '',
    straddleReady: !!doc.straddleReady,
    paymentCustomerId: doc.paymentCustomerId ? String(doc.paymentCustomerId) : null,
  };
}

function snapshotPaymentCard(pm, defaultPmId = null) {
  if (!pm || !pm.card) return null;
  return {
    paymentMethodId: pm.id,
    brand: pm.card.brand || '',
    last4: pm.card.last4 || '',
    expiryMonth: pm.card.exp_month || null,
    expiryYear: pm.card.exp_year || null,
    funding: pm.card.funding || '',
    fingerprint: pm.card.fingerprint || '',
    isDefault: pm.id === defaultPmId,
  };
}

/**
 * Load current billing settings before a PUT update.
 */
async function loadBillingSettingsBefore(req) {
  const userId = req.userId || req.user?._id || req.user?.id;
  if (!userId) return null;

  const base = String(req.baseUrl || '').toLowerCase();
  try {
    if (base.includes('/hoa')) {
      return await billingSettingsService.getHoaBillingSettings(userId, req.hoaContext || null);
    }
    return await billingSettingsService.getOperatorBillingSettings(userId);
  } catch (_err) {
    return null;
  }
}

/**
 * Load legacy payment bank account state before PUT/PATCH/DELETE.
 */
async function loadPaymentBankAccountBefore(req) {
  const id = toObjectId(req.params?.id);
  if (!id) return null;

  const PaymentBankAccount = require('../../payment/model/paymentBankAccount.model');
  const userId = req.userId || req.user?._id || req.user?.id;

  const query = { _id: id };
  if (userId) query.createdBy = userId;

  const doc = await PaymentBankAccount.findOne(query)
    .select('holderName last4 accountType verificationStatus straddleReady paymentCustomerId createdBy')
    .lean();

  return snapshotPaymentBankAccount(doc);
}

/**
 * Load payment customer state before PUT/DELETE.
 */
async function loadPaymentCustomerBefore(req) {
  const id = toObjectId(req.params?.id);
  if (!id) return null;

  const PaymentCustomer = require('../../payment/model/paymentCustomer.model');
  const userId = req.userId || req.user?._id || req.user?.id;

  const query = { _id: id };
  if (userId) query.createdBy = userId;

  const doc = await PaymentCustomer.findOne(query)
    .select('displayName email status straddleCustomerId straddleAccountId createdBy')
    .lean();

  if (!doc) return null;
  return {
    id: String(doc._id),
    displayName: doc.displayName || '',
    email: doc.email || '',
    status: doc.status || '',
    straddleCustomerId: doc.straddleCustomerId || null,
    straddleAccountId: doc.straddleAccountId ? String(doc.straddleAccountId) : null,
  };
}

/**
 * Load Stripe card metadata before DELETE (masked fields only).
 */
async function loadPaymentCardBeforeDelete(req) {
  const paymentMethodId = String(req.params?.paymentMethodId || '').trim();
  const userId = req.user?._id || req.user?.id || req.userId;
  if (!paymentMethodId || !userId) return null;

  try {
    const StripeCustomer = require('../../payment/model/stripeCustomer.model');
    const { StripeService } = require('../../payment/service/stripe.service');

    const record = await StripeCustomer.findOne({ userId }).lean();
    if (!record?.stripeCustomerId) return { paymentMethodId };

    const stripe = new StripeService();
    const pm = await stripe.stripe.paymentMethods.retrieve(paymentMethodId);
    if (pm.customer !== record.stripeCustomerId) return null;

    const customer = await stripe.getCustomer(record.stripeCustomerId);
    const defaultPmId = customer.invoice_settings?.default_payment_method ?? null;
    return snapshotPaymentCard(pm, defaultPmId);
  } catch (_err) {
    return { paymentMethodId };
  }
}

module.exports = {
  loadBillingSettingsBefore,
  loadPaymentBankAccountBefore,
  loadPaymentCustomerBefore,
  loadPaymentCardBeforeDelete,
  snapshotPaymentBankAccount,
  snapshotPaymentCard,
};
