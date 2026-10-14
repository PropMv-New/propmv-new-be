/**
 * ------------------------------------------------------------------
 * File: server.js
 * Module: Src
 *
 * Purpose:
 * Backend utility/module providing helper functions for server.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// src/server.js
require('./config/loadEnv');
const http = require('http');
const app = require("./app");
const websocketManager = require('./shared/messaging/service/websocket.manager');
const logger = require('./common/logger');

const PORT = process.env.PORT || 5000;

// Create the HTTP server and attach the websocket manager so realtime features can share the same listener.
const server = http.createServer(app);

websocketManager.initialize(server);

server.listen(PORT, '0.0.0.0', () => {
  logger.info(`Server running on port ${PORT}`, { port: PORT });

  try {
    const straddleConfig = require('./config/straddle.config');
    const { apiKey, organizationId, baseURL } = straddleConfig.straddle;
    if (!apiKey || !organizationId) {
      logger.warn('[straddle] NOT CONFIGURED - set STRADDLE_API_KEY and STRADDLE_ORGANIZATION_ID in .env.production');
    } else {
      logger.info('[straddle] configured', { baseURL, organizationId: organizationId.slice(0, 8) });
    }
  } catch {
    // optional
  }

  try {
    const quota = require('./shared/modules/address/services/quota.service');
    logger.info('[address] config', {
      googleLimit: quota.getGoogleMonthlyLimit(),
      mapbox: quota.isMapboxConfigured() ? 'on' : 'off',
    });
  } catch {
    // optional
  }

  try {
    const { startAllSchedulers } = require('./common/schedulers/schedulerRegistry.service');
    startAllSchedulers();
  } catch (err) {
    logger.warn('[SchedulerRegistry] Failed to start schedulers', { error: err?.message || err });
  }

  try {
    const { startBackgroundJobRuntime } = require('./common/jobs/runtime');
    const { getBackgroundJobConfig } = require('./common/jobs/config');
    const jobConfig = getBackgroundJobConfig();
    if (jobConfig.embeddedWorkers) {
      startBackgroundJobRuntime({ embedded: true }).catch((err) => {
        logger.warn('[BackgroundJobs] Failed to start embedded workers', { error: err?.message || err });
      });
    } else {
      logger.info('[BackgroundJobs] Embedded workers disabled - start standalone via npm run workers');
    }
  } catch (err) {
    logger.warn('[BackgroundJobs] Failed to start runtime', { error: err?.message || err });
  }

  try {
    const {
      logProductionEmailSafetyWarning,
    } = require('./common/helpers/emailSmtpRcptVerify.service');
    logProductionEmailSafetyWarning();
  } catch (err) {
    logger.warn('[EmailValidation] Failed to log safety warning', { error: err?.message || err });
  }
});

server.on('error', (err) => {
  logger.error('Server error', { error: err.message, code: err.code });
  if (err.code === 'EADDRINUSE') {
    logger.error(`Port ${PORT} is already in use`);
    // Exit so nodemon/npm do not leave a half-started process holding resources.
    process.exit(1);
  }
});

let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Shutting down (${signal})...`);

  try {
    const { stopBackgroundJobRuntime } = require('./common/jobs/runtime');
    await stopBackgroundJobRuntime();
  } catch (err) {
    logger.warn('[shutdown] Background jobs stop failed', { error: err?.message || err });
  }

  try {
    if (typeof websocketManager.close === 'function') {
      await websocketManager.close();
    } else if (websocketManager.io && typeof websocketManager.io.close === 'function') {
      await new Promise((resolve) => websocketManager.io.close(resolve));
    }
  } catch (err) {
    logger.warn('[shutdown] WebSocket close failed', { error: err?.message || err });
  }

  await new Promise((resolve) => {
    server.close(() => resolve());
    // Force-exit if open connections hang (keep-alive / sockets).
    setTimeout(resolve, 8_000).unref();
  });

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => {
  gracefulShutdown('SIGINT').catch(() => process.exit(1));
});
process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM').catch(() => process.exit(1));
});

// Safety net: log unhandled promise rejections instead of crashing the process
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection', { error: reason?.message || String(reason) });
});

// Safety net: log uncaught exceptions and keep the process alive
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', { error: err.message });
});
