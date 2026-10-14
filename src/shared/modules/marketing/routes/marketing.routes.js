const express = require('express');
const router = express.Router();

const emailSubscriptionController = require('../controller/emailSubscription.controller');
const siteVisitController = require('../controller/siteVisit.controller');
const demoRequestController = require('../controller/demoRequest.controller');
const {
  emailSubscriptionSchema,
  listEmailSubscriptionsQuerySchema,
  announceLaunchSchema,
} = require('../validators/emailSubscription.validator');
const {
  recordSiteVisitSchema,
  listSiteVisitsQuerySchema,
} = require('../validators/siteVisit.validator');
const {
  demoRequestSchema,
  listDemoRequestsQuerySchema,
} = require('../validators/demoRequest.validator');
const { validateBody, validateQuery } = require('../../../../middleware/requestValidator');
const emailSubscriptionRateLimit = require('../middleware/rateLimit');
const siteVisitRateLimit = require('../middleware/visitRateLimit');
const demoRequestRateLimit = require('../middleware/demoRequestRateLimit');
const csrfProtection = require('../../../../middleware/csrfProtection');
const authMiddleware = require('../../../../middleware/auth');
const { requireMarketingAdministrator } = require('../middleware/requireMarketingAdministrator');

// Public: coming-soon / marketing email capture (no auth)
router.post(
  '/email-subscriptions',
  emailSubscriptionRateLimit,
  validateBody(emailSubscriptionSchema),
  emailSubscriptionController.createEmailSubscription
);

// Admin: launch list management
router.get(
  '/email-subscriptions/export',
  authMiddleware,
  requireMarketingAdministrator,
  validateQuery(listEmailSubscriptionsQuerySchema),
  emailSubscriptionController.exportEmailSubscriptions
);

router.post(
  '/email-subscriptions/announce-launch',
  csrfProtection,
  authMiddleware,
  requireMarketingAdministrator,
  validateBody(announceLaunchSchema),
  emailSubscriptionController.sendLaunchAnnouncement
);

router.get(
  '/email-subscriptions',
  authMiddleware,
  requireMarketingAdministrator,
  validateQuery(listEmailSubscriptionsQuerySchema),
  emailSubscriptionController.getEmailSubscriptions
);

// Public: marketing site page-view tracking (no auth)
router.post(
  '/visits',
  siteVisitRateLimit,
  validateBody(recordSiteVisitSchema),
  siteVisitController.createSiteVisit
);

// Authenticated: visitor analytics for internal review
router.get(
  '/visits/stats',
  authMiddleware,
  validateQuery(listSiteVisitsQuerySchema),
  siteVisitController.getVisitStats
);

router.get(
  '/visits',
  authMiddleware,
  validateQuery(listSiteVisitsQuerySchema),
  siteVisitController.getVisitList
);

// Public: "Schedule a demo" from the marketing site (no auth)
router.post(
  '/demo-requests',
  demoRequestRateLimit,
  validateBody(demoRequestSchema),
  demoRequestController.submitDemoRequest
);

// Internal: review incoming demo requests
router.get(
  '/demo-requests',
  authMiddleware,
  requireMarketingAdministrator,
  validateQuery(listDemoRequestsQuerySchema),
  demoRequestController.getDemoRequests
);

module.exports = router;

