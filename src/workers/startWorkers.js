'use strict';

require('../config/loadEnv');
const { validateEnv } = require('../config/validateEnv');
validateEnv();

const { connectDB } = require('../config/db.config');
const logger = require('../common/logger');
const { startBackgroundJobRuntime, stopBackgroundJobRuntime } = require('../common/jobs/runtime');

async function main() {
  logger.info('[BackgroundJobs] Starting standalone workers');
  await connectDB();
  process.env.BACKGROUND_JOBS_EXIT_ON_SIGNAL = process.env.BACKGROUND_JOBS_EXIT_ON_SIGNAL || 'true';
  await startBackgroundJobRuntime({ embedded: false, immediate: true });
  logger.info('[BackgroundJobs] Workers ready');
}

process.on('unhandledRejection', (reason) => {
  logger.error('[BackgroundJobs] Unhandled rejection', { error: reason?.message || String(reason) });
});

main().catch(async (err) => {
  logger.error('[BackgroundJobs] Failed to start workers', { error: err.message });
  try {
    await stopBackgroundJobRuntime();
  } catch {
    // ignore
  }
  process.exit(1);
});
