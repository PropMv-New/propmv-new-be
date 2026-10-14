'use strict';

const express = require('express');
const router  = express.Router();

const authMiddleware  = require('../../../../../middleware/auth');
const authorize       = require('../../../../../middleware/authorize');
const csrfProtection  = require('../../../../../middleware/csrfProtection');
const { validateBody, validateParams } = require('../../../../../middleware/requestValidator');
const {
  createAccountSchema,
  updateAccountSchema,
  idParamSchema,
  addBankSchema,
  updateBankSchema,
  bankIdParamSchema,
  createRepresentativeSchema,
  updateRepresentativeSchema,
  repIdParamSchema,
  onboardingStepSchema,
  submitOnboardingSchema,
} = require('../validators/account.validator');
const {
  createAccount,
  listAccounts,
  getAccountByEntity,
  getAccountById,
  updateAccount,
  syncAccount,
  deleteAccount,
  handleAccountWebhook,
  addBankToAccount,
  listBanksForAccount,
  getBankForAccount,
  deleteBankFromAccount,
  updateBankOnAccount,
  verifyBankOnAccount,
  createBridgeSessionForAccount,
  listRepresentativesForAccount,
  addRepresentativeToAccount,
  updateRepresentativeOnAccount,
  updateOnboardingStep,
  submitAccountOnboarding,
  getOnboardingEnvironment,
  setPrimaryBankOnAccount,
} = require('../controller/account.controller');

const guard = [authMiddleware, authorize];
const writeGuard = [csrfProtection, authMiddleware, authorize];

// ── Account lifecycle ─────────────────────────────────────────────────────────
router.post('/',                              ...writeGuard, validateBody(createAccountSchema),  createAccount);
router.get('/',                               ...guard,                                          listAccounts);
router.get('/onboarding/environment',         ...guard,                                          getOnboardingEnvironment);
router.get('/entity/:entityType/:entityId',   ...guard,                                          getAccountByEntity);
router.get('/:id',                            ...guard, validateParams(idParamSchema),            getAccountById);
router.patch('/:id',                          ...writeGuard, validateParams(idParamSchema), validateBody(updateAccountSchema), updateAccount);
router.post('/:id/sync',                      ...writeGuard, validateParams(idParamSchema),       syncAccount);
router.delete('/:id',                         ...writeGuard, validateParams(idParamSchema),       deleteAccount);

// ── Linked Bank Accounts (Embed) - parent is Straddle Account ─────────────────
// Customer paykey banks remain on /api/v1/payments/bank-accounts (unchanged).
router.post('/:id/banks',                     ...writeGuard, validateParams(idParamSchema), validateBody(addBankSchema), addBankToAccount);
router.get('/:id/banks',                      ...guard, validateParams(idParamSchema),                                   listBanksForAccount);
router.get('/:id/banks/:bankId',              ...guard, validateParams(bankIdParamSchema),                               getBankForAccount);
router.put('/:id/banks/:bankId',              ...writeGuard, validateParams(bankIdParamSchema), validateBody(updateBankSchema), updateBankOnAccount);
router.delete('/:id/banks/:bankId',           ...writeGuard, validateParams(bankIdParamSchema),                           deleteBankFromAccount);
router.patch('/:id/banks/:bankId/verify',     ...writeGuard, validateParams(bankIdParamSchema),                           verifyBankOnAccount); // sync status
router.post('/:id/banks/:bankId/sync',        ...writeGuard, validateParams(bankIdParamSchema),                           verifyBankOnAccount);
router.post('/:id/bridge/session',            ...writeGuard, validateParams(idParamSchema),                               createBridgeSessionForAccount);

router.patch('/:id/onboarding/step',          ...writeGuard, validateParams(idParamSchema), validateBody(onboardingStepSchema), updateOnboardingStep);
router.post('/:id/onboarding/submit',         ...writeGuard, validateParams(idParamSchema), validateBody(submitOnboardingSchema), submitAccountOnboarding);

router.get('/:id/representatives',            ...guard, validateParams(idParamSchema),                                   listRepresentativesForAccount);
router.post('/:id/representatives',           ...writeGuard, validateParams(idParamSchema), validateBody(createRepresentativeSchema), addRepresentativeToAccount);
router.patch('/:id/representatives/:repId',   ...writeGuard, validateParams(repIdParamSchema), validateBody(updateRepresentativeSchema), updateRepresentativeOnAccount);

router.patch('/:id/banks/:bankId/primary',    ...writeGuard, validateParams(bankIdParamSchema),                           setPrimaryBankOnAccount);

// ── Webhooks (no JWT, no CSRF - Straddle server-to-server calls) ────────────
// Security: validated by Straddle-Signature header + rawBody HMAC in AccountWebhookService.
// These paths are listed in EXEMPT_PREFIXES in csrfProtection.js.
router.post('/webhooks/account',
  express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }),
  handleAccountWebhook
);

// Same processor handles linked_bank_account.* events (configure URL in Straddle dashboard)
router.post('/webhooks/linked-bank-account',
  express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }),
  handleAccountWebhook
);

module.exports = router;
