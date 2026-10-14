const express = require('express');
const router  = express.Router();

const authMiddleware      = require('../../../../middleware/auth');
const authorize           = require('../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../middleware/lockCheck');
const csrfProtection      = require('../../../../middleware/csrfProtection');
const { validateBody, validateParams }  = require('../../../../middleware/requestValidator');
const { paymentMethodIdParam }           = require('../validators/card.validator');
const { chargeCardSchema }               = require('../validators/cardCharge.validator');
const { createSetupIntent, listCards, deleteCard, setDefaultCard, chargeCard } = require('../controller/card.controller');
const { captureAuditBefore } = require('../../audit/middleware/auditBeforeCapture.middleware');
const { loadPaymentCardBeforeDelete } = require('../../audit/loaders/auditBeforeLoaders');

const guard         = [authMiddleware, authorize, lockCheckMiddleware];
const mutatingGuard = [csrfProtection, authMiddleware, authorize, lockCheckMiddleware];

router.post('/setup-intent',              ...mutatingGuard, createSetupIntent);
router.get('/',                           ...guard, listCards);
router.post('/charge',                    ...mutatingGuard, validateBody(chargeCardSchema), chargeCard);
router.delete('/:paymentMethodId', ...mutatingGuard, captureAuditBefore(loadPaymentCardBeforeDelete), validateParams(paymentMethodIdParam), deleteCard);
router.patch('/default/:paymentMethodId', ...mutatingGuard, validateParams(paymentMethodIdParam), setDefaultCard);

module.exports = router;
