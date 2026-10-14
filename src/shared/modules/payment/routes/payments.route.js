/**
 * ------------------------------------------------------------------
 * File: payments.route.js
 * Module: Payment Module
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * app
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../../../../middleware/auth');
const authorize = require('../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../middleware/lockCheck');
const csrfProtection = require('../../../../middleware/csrfProtection');
const { validateBody, validateParams } = require('../../../../middleware/requestValidator');
const { captureAuditBefore } = require('../../audit/middleware/auditBeforeCapture.middleware');
const {
  loadPaymentBankAccountBefore,
  loadPaymentCustomerBefore,
} = require('../../audit/loaders/auditBeforeLoaders');
const {
  createCustomerSchema,
  updateCustomerSchema,
  linkBankAccountSchema,
  updateBankAccountSchema,
  createChargeSchema,
  createPayoutSchema,
  idParamSchema,
  createBridgeSessionSchema,
  startOwnerBankLinkSchema,
  startVendorBankLinkSchema,
  completeOwnerBankLinkSchema,
  sendPaymentVerifyOtpSchema,
  verifyPaymentVerifyOtpSchema,
} = require('../validators/payment.validator');
const {
  createCustomer, updateCustomer, syncCustomer, deleteCustomer,
  getCustomers, getCustomerById,
  linkBankAccount, getBankAccounts, getBankAccountById, updateBankAccount, verifyBankAccount,
  syncBankAccount, deleteBankAccount,
  createCharge, getCharges, getChargeById,
  createPayout, getPayouts, getPayoutById,
  createBridgeSession,
  startOwnerBankLink,
  startVendorBankLink,
  completeOwnerBankLink,
  sendPaymentVerifyOtp,
  verifyPaymentVerifyOtp,
} = require('../controller/payment.controller');

const guard = [authMiddleware, authorize, lockCheckMiddleware];
const mutatingGuard = [csrfProtection, authMiddleware, authorize, lockCheckMiddleware];

const beforeCustomerMutation = captureAuditBefore(loadPaymentCustomerBefore);
const beforeBankMutation = captureAuditBefore(loadPaymentBankAccountBefore);

// Creates / updates customer in Straddle (SaaS-scoped via Straddle-Account-Id)
router.post('/customers', ...mutatingGuard, validateBody(createCustomerSchema), createCustomer);
router.put('/customers/:id', ...mutatingGuard, beforeCustomerMutation, validateParams(idParamSchema), validateBody(updateCustomerSchema), updateCustomer);
router.post('/customers/:id/sync', ...mutatingGuard, validateParams(idParamSchema), syncCustomer);
router.delete('/customers/:id', ...mutatingGuard, beforeCustomerMutation, validateParams(idParamSchema), deleteCustomer);
router.get('/customers', ...guard, getCustomers);
router.get('/customers/:id', ...guard, validateParams(idParamSchema), getCustomerById);

// Links bank account to Straddle only (Stripe commented out)
router.post('/bank-accounts', ...mutatingGuard, validateBody(linkBankAccountSchema), linkBankAccount);
router.get('/bank-accounts', ...guard, getBankAccounts);           // ?customerId=<id>
router.get('/bank-accounts/:id', ...guard, validateParams(idParamSchema), getBankAccountById);
router.put('/bank-accounts/:id', ...mutatingGuard, beforeBankMutation, validateParams(idParamSchema), validateBody(updateBankAccountSchema), updateBankAccount);
router.patch('/bank-accounts/:id/verify', ...mutatingGuard, validateParams(idParamSchema), verifyBankAccount);
router.post('/bank-accounts/:id/sync', ...mutatingGuard, validateParams(idParamSchema), syncBankAccount);
router.delete('/bank-accounts/:id', ...mutatingGuard, beforeBankMutation, validateParams(idParamSchema), deleteBankAccount);

// ── HOA Owner: Add Bank (silent customer + Bridge session) ────────────────────
router.post('/owner/start-bank-link', ...mutatingGuard, validateBody(startOwnerBankLinkSchema), startOwnerBankLink);
router.post('/owner/complete-bank-link', ...mutatingGuard, validateBody(completeOwnerBankLinkSchema), completeOwnerBankLink);

// ── Vendor: Add Bank (platform scope - no HOA community required) ─────────────
router.post('/vendor/start-bank-link', ...guard, validateBody(startVendorBankLinkSchema), startVendorBankLink);
router.post('/vendor/complete-bank-link', ...guard, validateBody(completeOwnerBankLinkSchema), completeOwnerBankLink);

// ── Owner payment identity verification (email OTP) ─────────────────────────
router.post(
  '/verify-account/send-otp',
  ...mutatingGuard,
  validateBody(sendPaymentVerifyOtpSchema),
  sendPaymentVerifyOtp
);
router.post(
  '/verify-account/verify-otp',
  ...mutatingGuard,
  validateBody(verifyPaymentVerifyOtpSchema),
  verifyPaymentVerifyOtp
);

// ── Charges (ACH debit via Straddle) ─────────────────────────────────────────
router.post('/charges', ...mutatingGuard, validateBody(createChargeSchema), createCharge);
router.get('/charges', ...guard, getCharges);
router.get('/charges/:id', ...guard, validateParams(idParamSchema), getChargeById);

// ── Payouts (landlord withdrawal via Straddle) ────────────────────────────────
router.post('/payouts', ...mutatingGuard, validateBody(createPayoutSchema), createPayout);
router.get('/payouts', ...guard, getPayouts);
router.get('/payouts/:id', ...guard, validateParams(idParamSchema), getPayoutById);

// ── Bridge Session (POST /v1/bridge/initialize under the hood) ────────────────
router.post('/bridge/session', ...mutatingGuard, validateBody(createBridgeSessionSchema), createBridgeSession);

module.exports = router;
