const logger = require('../../../../../common/logger');
const { ClockService } = require('../../../../../common/date');
const { processDueOwnershipTransfers } = require('./unit.service');
const { startScheduledDailyRun } = require('../../../../../common/schedulers/scheduledDailyRun.service');
const { automatedNotificationSchedule } = require('../../../../../config/automatedNotificationSchedule.config');

let schedulerHandle = null;

async function processOwnershipTransferBatch(referenceDate = ClockService.now()) {
  const startedAt = ClockService.nowEpoch();

  try {
    const result = await processDueOwnershipTransfers(referenceDate);
    const elapsedMs = ClockService.nowEpoch() - startedAt;
    logger.info(
      `[hoaOwnershipTransferScheduler] processed=${result.processed || 0}, skipped=${result.skipped || 0}, elapsedMs=${elapsedMs}`
    );
    return { ...result, elapsedMs };
  } catch (error) {
    logger.error('[hoaOwnershipTransferScheduler] Batch failed:', error?.message || error);
    throw error;
  }
}

function startHoaOwnershipTransferScheduler() {
  const { ownershipTransfer, timezone, timezoneLabel, skipStartupRun } = automatedNotificationSchedule;

  if (!ownershipTransfer.enabled) {
    logger.info('[hoaOwnershipTransferScheduler] Disabled via HOA_OWNERSHIP_TRANSFER_SCHEDULER_ENABLED=false');
    return;
  }

  const ownershipStartupSkip = skipStartupRun
    || process.env.HOA_OWNERSHIP_TRANSFER_SKIP_STARTUP_RUN === 'true';

  schedulerHandle = startScheduledDailyRun({
    name: 'hoaOwnershipTransferScheduler',
    hour: ownershipTransfer.hour,
    minute: ownershipTransfer.minute,
    timeZone: timezone,
    enabled: true,
    skipStartupRun: ownershipStartupSkip,
    startupDelayMs: ownershipTransfer.startupDelayMs,
    onRun: () => processOwnershipTransferBatch(ClockService.now()),
  });

  logger.info(
    `[hoaOwnershipTransferScheduler] Ownership transfers at ${ownershipTransfer.label} (${timezoneLabel})`
  );
}

module.exports = {
  startHoaOwnershipTransferScheduler,
  processOwnershipTransferBatch,
};
