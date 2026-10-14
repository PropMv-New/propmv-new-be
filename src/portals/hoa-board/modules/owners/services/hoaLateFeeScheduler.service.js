/**
 * ------------------------------------------------------------------
 * File: hoaLateFeeScheduler.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * hoaInvoiceExtensionScheduler.service, server
 * ------------------------------------------------------------------
 */
const Property = require('../../property/model/property.model');

const logger = require('../../../../../common/logger');

const { ClockService } = require('../../../../../common/date');

const { enqueueBackgroundJob } = require('../../../../../common/jobs/enqueue');

const { JOB_TYPES } = require('../../../../../common/jobs/constants');

const { buildJobIdempotencyKey } = require('../../../../../common/jobs/idempotency');

const { isBackgroundJobsEnabled } = require('../../../../../common/jobs/config');

const { getDateKeyInTimeZone } = require('../../../../../common/helpers/hoaBillingDates');

const { ensureLateFeeInvoicesForUnit } = require('./unitLateFee.service');

const { startScheduledDailyRun } = require('../../../../../common/schedulers/scheduledDailyRun.service');

const { dailySchedule } = require('../../../../../config/dailySchedule.config');



const STARTUP_DELAY_MS = Number(process.env.HOA_LATE_FEE_STARTUP_DELAY_MS) || 60_000;



let schedulerHandle = null;



async function processAllHoaUnitsLateFees() {

  const startedAt = ClockService.nowEpoch();

  let processed = 0;

  let created = 0;

  let failed = 0;



  try {

    const units = await Property.find({

      hoaId: { $exists: true, $ne: null },

      isDeleted: { $ne: true }

    })

      .select('_id')

      .lean();



    for (const unit of units) {

      processed += 1;

      try {

        if (isBackgroundJobsEnabled()) {

          const dateKey = getDateKeyInTimeZone(ClockService.now(), dailySchedule.timezone);

          const result = await enqueueBackgroundJob({

            jobType: JOB_TYPES.INVOICE_LATE_FEE_UNIT,

            entityType: 'Property',

            entityId: unit._id,

            idempotencyKey: buildJobIdempotencyKey('INVOICE_LATE_FEE_UNIT', unit._id, dateKey),

            payload: { unitId: String(unit._id), scheduledRun: true },

          });

          if (!result.duplicate) created += 1;

        } else {

          const rows = await ensureLateFeeInvoicesForUnit(unit._id);

          created += Array.isArray(rows) ? rows.length : 0;

        }

      } catch (error) {

        failed += 1;

        logger.warn(

          '[hoaLateFeeScheduler] Unit late fee processing failed:',

          String(unit._id),

          error?.message || error

        );

      }

    }



    const elapsedMs = ClockService.nowEpoch() - startedAt;

    logger.info(

      `[hoaLateFeeScheduler] Completed: units=${processed}, created=${created}, failed=${failed}, elapsedMs=${elapsedMs}`

    );

    return { processed, created, failed, elapsedMs };

  } catch (error) {

    logger.error('[hoaLateFeeScheduler] Batch failed:', error?.message || error);

    throw error;

  }

}

/**
 * start Hoa Late Fee Scheduler
 *
 * Performs logic operations for startHoaLateFeeScheduler.
 *
 * @returns Operations result
 */
function startHoaLateFeeScheduler() {

  if (process.env.HOA_LATE_FEE_SCHEDULER_ENABLED === 'false') {

    logger.info('[hoaLateFeeScheduler] Disabled via HOA_LATE_FEE_SCHEDULER_ENABLED=false');

    return;

  }



  const legacyStartupSkip = dailySchedule.skipStartupRun

    || process.env.HOA_LATE_FEE_SKIP_STARTUP_RUN === 'true';



  schedulerHandle = startScheduledDailyRun({

    name: 'hoaLateFeeScheduler',

    hour: dailySchedule.hour,

    minute: dailySchedule.minute,

    timeZone: dailySchedule.timezone,

    enabled: true,

    skipStartupRun: legacyStartupSkip,

    startupDelayMs: STARTUP_DELAY_MS,

    onRun: processAllHoaUnitsLateFees,

  });



  logger.info(

    `[hoaLateFeeScheduler] Legacy daily late-fee sweep at ${dailySchedule.label} (${dailySchedule.timezoneLabel})`

  );

}



module.exports = {

  startHoaLateFeeScheduler,

  processAllHoaUnitsLateFees,

};

