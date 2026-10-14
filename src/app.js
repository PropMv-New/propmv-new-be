/**
 * ------------------------------------------------------------------
 * File: app.js
 * Module: Src
 *
 * Purpose:
 * Backend utility/module providing helper functions for app.
 *
 * Used By:
 * server
 * ------------------------------------------------------------------
 */

// src/app.js

// Allow self-signed certificates for sandbox-style integrations that are still in testing.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Allow self-signed certs for external APIs (e.g. Straddle sandbox)
require('./config/loadEnv');
const { validateEnv } = require('./config/validateEnv');
validateEnv();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");
const path = require("path");
const { setupSwagger } = require("./config/swagger.config");
const { connectDB } = require("./config/db.config");
const { createAuditLoggerMiddleware } = require('./shared/modules/audit/middleware/auditLogger.middleware');
const config = require('./config/default');
const logger = require('./common/logger');

const app = express();

// Honor proxy/CDN client IP headers in deployed environments (see config/trustProxy.js).
const { applyTrustProxy } = require('./config/trustProxy');
applyTrustProxy(app, process.env, {
  log: {
    info: (msg) => logger.info(msg),
    warn: (msg) => logger.warn(msg),
  },
});

app.use(
  compression({
    // Do not gzip binary download streams — mangled Content-Encoding is a common
    // cause of "file is corrupt / cannot open" after download.
    filter(req, res) {
      const url = String(req.originalUrl || req.url || '');
      if (/\/download(?:\?|$)/i.test(url)) return false;
      if (String(res.getHeader('Cache-Control') || '').includes('no-transform')) return false;
      return compression.filter(req, res);
    },
  })
);

const jsonBodyLimit = process.env.JSON_BODY_LIMIT || '1mb';
app.use(express.json({ limit: jsonBodyLimit }));
app.use(express.urlencoded({ extended: true, limit: jsonBodyLimit }));

const corsOriginsConfig = require('./config/corsOrigins');
const { resolveCorsOrigins, isOriginAllowed } = corsOriginsConfig;
const { origins: corsOrigins, isProdLike, allowAll: corsAllowAll } = resolveCorsOrigins();

app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser / same-origin requests (no Origin header)
      if (!origin) return callback(null, true);
      if (isOriginAllowed(origin, { origins: corsOrigins, isProdLike, allowAll: corsAllowAll })) {
        return callback(null, true);
      }
      // Deny without throwing - Error callbacks can surface as opaque CORS/502s
      return callback(null, false);
    },
    credentials: true,
    // Let the SPA read download filenames / types from blob responses
    exposedHeaders: ['Content-Disposition', 'Content-Type', 'Content-Length'],
  })
);
app.use(helmet({
  // Allow frontend (different port) to load mock S3 / upload images in local dev
  crossOriginResourcePolicy: config.s3?.useMock
    ? { policy: 'cross-origin' }
    : true,
}));

const { requestTimingMiddleware } = require('./middleware/requestTiming');
app.use(requestTimingMiddleware);

// Universal HTTP request/response logger - assigns req.requestId, logs every API call.
const { httpLoggerMiddleware } = require('./middleware/httpLogger.middleware');
app.use(httpLoggerMiddleware);

// Normalize all controller responses into a consistent envelope so client apps can rely on one response shape.
const responseFormatter = require('./middleware/responseFormatter');
app.use(responseFormatter);

const { apiRateLimitMiddleware } = require('./middleware/rateLimit');
app.use(apiRateLimitMiddleware);

// Liveness endpoint for deploy health checks (process up, no DB dependency)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Serve static files (uploaded images)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Zillow bulk feed static file (public URL Zillow polls - static path, no timestamps)
const zillowConfig = require('./integrations/syndication/zillow/zillow.config');
const { setupZillowMock } = require('./integrations/syndication/zillow/mock/setupZillowMock');
setupZillowMock(app, config);
app.use(zillowConfig.bulkFeedPublicPath, express.static(zillowConfig.bulkFeedLocalDir));

// Zillow Real-Time API callback (public - no auth)
const zillowRoutes = require('./integrations/syndication/zillow/zillow.routes');
app.use(zillowConfig.routes.apiPrefix, zillowRoutes);

// Setup mock S3 static serving (decoupled)
const { setupMockS3 } = require('./config/static.config');
setupMockS3(app, config, process.env);

// Initialize the shared MongoDB connection and perform background startup tasks once the server boots.
(async () => {
  try {
    await connectDB();
    logger.info('MongoDB connected');
  } catch (err) {
    logger.error('MongoDB connection failed', { error: err.message });
    process.exit(1);
  }

  try {
    const { ensureHoaIndexes } = require('./common/db/ensureHoaIndexes');
    const { ensureLandlordIndexes } = require('./common/db/ensureLandlordIndexes');
    ensureHoaIndexes()
      .then(() => logger.info('HOA MongoDB indexes synced'))
      .catch((err) => logger.warn('HOA index sync failed', { error: err.message }));
    ensureLandlordIndexes()
      .then(() => logger.info('Landlord MongoDB indexes synced'))
      .catch((err) => logger.warn('Landlord index sync failed', { error: err.message }));
  } catch (err) {
    logger.warn('Index sync setup failed', { error: err.message });
  }

  // Clear all company/role in-memory caches so the first request always
  // fetches fresh data from DB (prevents stale cache after role changes).
  try {
    const { clearPropMvCompanyCache } = require('./common/helpers/companyRoleHelper');
    const { clearVendorRoleCache } = require('./common/helpers/hoaVendorRole');
    clearPropMvCompanyCache();
    clearVendorRoleCache();
    logger.info('Company/role caches cleared on startup');
  } catch (err) {
    logger.warn('Cache clear on startup failed', { error: err.message });
  }

  // Initialize notification client
  try {
    const notificationClient = require('./integrations/notification');
    await notificationClient.initialize();
    logger.info('Notification client initialized');
  } catch (notifErr) {
    logger.warn('Notification client initialization failed', { error: notifErr.message });
  }

  // Initialize rate limit service
  try {
    const rateLimitService = require('./services/rateLimit.service');
    await rateLimitService.init();
    logger.info('Rate limit service initialized');
  } catch (rateLimitErr) {
    logger.warn('Rate limit service initialization failed', { error: rateLimitErr.message });
  }

  try {
    const otpResendLimiter = require('./services/otpResendLimiter.service');
    await otpResendLimiter.init();
    logger.info('OTP resend limiter initialized');
  } catch (otpLimiterErr) {
    logger.warn('OTP resend limiter initialization failed', { error: otpLimiterErr.message });
  }
})();

// Register shared auth and user routes that are used by both portals and do not depend on a specific portal namespace.
const authRouter = require('./shared/modules/auth/routes/auth.routes');
const usersRouter = require('./shared/modules/users/routes/userProfile.routes');
app.use('/api/v1/auth', createAuditLoggerMiddleware({ sourceLabel: 'Auth' }), authRouter);
app.use('/api/v1/users', createAuditLoggerMiddleware({ sourceLabel: 'Users' }), usersRouter);

// Load shared users routes (portal-agnostic for user profile)
// const usersRouter = require('./shared/modules/users/routes/userProfile.routes');
// app.use('/api/v1/users', usersRouter);

// Load shared documents routes (portal-agnostic for documents)
const documentsRouter = require('./shared/modules/documents/routes/documents.routes');
app.use('/api/v1/documents', createAuditLoggerMiddleware({ sourceLabel: 'Documents' }), documentsRouter);

// Load shared master data routes (portal-agnostic for master data)
const masterDataRouter = require('./shared/modules/master/routes/masterData.routes');
app.use('/api/v1/master', createAuditLoggerMiddleware({ sourceLabel: 'Master' }), masterDataRouter);

// Load Straddle payment routes
const paymentsRouter = require('./shared/modules/payment/routes/payments.route');
app.use('/api/v1/payments', createAuditLoggerMiddleware({ sourceLabel: 'Payments' }), paymentsRouter);

// Load Straddle account routes
const accountRouter = require('./shared/modules/payment/account/routes/account.routes');
app.use('/api/v1/accounts', accountRouter);

// Load Stripe card routes
const cardsRouter = require('./shared/modules/payment/routes/cards.route');
app.use('/api/v1/payments/cards', createAuditLoggerMiddleware({ sourceLabel: 'PaymentCards' }), cardsRouter);

// Load Rainforest provider routes (additive; Stripe/Straddle unchanged)
const rainforestRouter = require('./shared/modules/payment/providers/rainforest/routes/rainforest.routes');
app.use('/api/v1/payments/rainforest', createAuditLoggerMiddleware({ sourceLabel: 'Rainforest' }), rainforestRouter);

const payloadRouter = require('./shared/modules/payment/providers/payload/routes/payload.routes');
app.use('/api/v1/payments/payload', createAuditLoggerMiddleware({ sourceLabel: 'Payload' }), payloadRouter);

// Load webhook routes (no auth required for webhooks)
const webhookRouter = require('./shared/modules/payment/routes/webhook.routes');
app.use('/api/webhooks', webhookRouter);
const rainforestWebhookRouter = require('./shared/modules/payment/providers/rainforest/routes/rainforestWebhook.routes');
app.use('/api/webhooks/rainforest', rainforestWebhookRouter);
const payloadWebhookRouter = require('./shared/modules/payment/providers/payload/routes/payloadWebhook.routes');
app.use('/api/webhooks/payload', payloadWebhookRouter);
const docusealWebhookRouter = require('./shared/modules/docuseal/routes/docusealWebhook.routes');
app.use('/api/webhooks/docuseal', docusealWebhookRouter);

// System email bounce ingest (secret-protected; used for Hostinger DSN forwarding)
const emailBounceRouter = require('./shared/modules/system/routes/emailBounce.routes');
app.use('/api/v1/system', emailBounceRouter);

// Administrator audit investigation & outbox operations (JWT + Administrator role)
const auditInvestigationRouter = require('./shared/modules/audit/routes/auditInvestigation.routes');
app.use('/api/v1/system/audit', auditInvestigationRouter);

const jobMonitoringRouter = require('./common/jobs/routes/jobMonitoring.routes');
app.use('/api/v1/system/jobs', jobMonitoringRouter);

// System reporting routes: HOA onboarding metrics and automation (internal staff only)
const systemReportsRouter = require('./shared/modules/system/reports/routes/hoaOnboardingReport.routes');
app.use('/api/v1/system/reports', createAuditLoggerMiddleware({ sourceLabel: 'SystemReports' }), systemReportsRouter);

// Load shared company routes (portal-agnostic for company management)
const companyRouter = require('./shared/modules/company/routes/company.routes');
app.use('/api/v1/company', createAuditLoggerMiddleware({ sourceLabel: 'Company' }), companyRouter);

// Load shared address routes (portal-agnostic address autocomplete with Google->Mapbox failover)
const addressRouter = require('./shared/modules/address/routes/address.routes');
app.use('/api/v1/address', addressRouter);

// Load shared support routes (portal-agnostic contact-support form → Google Sheets + email)
const supportRouter = require('./shared/modules/support/routes/support.routes');
app.use('/api/v1/support', supportRouter);

// DocuSeal e-sign / form builder (JWT minting + DocuSeal REST proxy)
const docusealRouter = require('./shared/modules/docuseal/routes/docuseal.routes');
app.use('/api/v1/docuseal', createAuditLoggerMiddleware({ sourceLabel: 'DocuSeal' }), docusealRouter);

// Load shared marketing routes (public email subscriptions for coming-soon, etc.)
const marketingRouter = require('./shared/modules/marketing/routes/marketing.routes');
app.use('/api/v1/marketing', marketingRouter);
require('./shared/modules/address/services/quota.service').verifyAddressFailoverConfig();

// Load shared Help Center routes (public article feedback)
const helpCenterRouter = require('./shared/modules/help-center/routes/helpArticleFeedback.routes');
app.use('/api/v1/help-center', helpCenterRouter);

// Register portal-specific routes under their own API prefixes.
const landlordRouter = require('./portals/landlord');
const hoaBoardRouter = require('./portals/hoa-board');
// Landlord portal - Step 1 tracing MUST be first middleware (assigns req.landlordRequestId).
// Full pipeline: README_LANDLORD_LOGGING.md
const { landlordRequestLoggerMiddleware } = require('./portals/landlord/middleware/landlordRequestLogger.middleware');

app.use('/api/v1/landlord', landlordRequestLoggerMiddleware, createAuditLoggerMiddleware({ sourceLabel: 'Landlord' }), landlordRouter);
app.use('/api/v1/hoa', createAuditLoggerMiddleware({ sourceLabel: 'HOA' }), hoaBoardRouter);

const notificationRouter = require('./shared/modules/notifications/routes/notification.routes');
app.use('/api/v1/notifications', createAuditLoggerMiddleware({ sourceLabel: 'Notifications' }), notificationRouter);

logger.info('Portal routes loaded: auth, users, documents, payments, accounts, webhooks, master, company, address, marketing, help-center, docuseal, landlord, hoa');

// Swagger Docs
setupSwagger(app);

// Global error handler (must come after routes)
const errorHandler = require('./middleware/errorHandler');
app.use(errorHandler);

module.exports = app;
