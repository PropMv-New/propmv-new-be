'use strict';

const express = require('express');
const router = express.Router();

const authMiddleware = require('../../../../../middleware/auth');
const requireInternalStaff = require('../../../../../middleware/requireInternalStaff');
const csrfProtection = require('../../../../../middleware/csrfProtection');
const {
  validateQuery,
  validateBody,
} = require('../../../../../middleware/requestValidator');
const {
  listHoasQuerySchema,
  sendEmailBodySchema,
} = require('../validators/hoaOnboardingReport.validator');
const controller = require('../controllers/hoaOnboardingReport.controller');

// All system reporting routes require authentication + internal PropMv staff authorization
router.use(authMiddleware);
router.use(requireInternalStaff);

/**
 * GET /api/v1/system/reports/hoa-onboarding/summary
 * Returns today, weekly, and monthly onboarding metrics.
 */
router.get('/hoa-onboarding/summary', controller.getSummary);

/**
 * GET /api/v1/system/reports/hoa-onboarding/hoas
 * Returns paginated, searchable, filterable HOA records.
 */
router.get(
  '/hoa-onboarding/hoas',
  validateQuery(listHoasQuerySchema),
  controller.getHoas
);

/**
 * POST /api/v1/system/reports/hoa-onboarding/send-email
 * Manually trigger daily report email (recipients resolved server-side).
 */
router.post(
  '/hoa-onboarding/send-email',
  csrfProtection,
  validateBody(sendEmailBodySchema),
  controller.sendEmailNow
);

module.exports = router;
