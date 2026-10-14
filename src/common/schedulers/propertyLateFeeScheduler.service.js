'use strict';

const Property = require('../../portals/hoa-board/modules/property/model/property.model');
const logger = require('../logger');
const { ensureLateFeeInvoicesForUnit } = require('../../portals/hoa-board/modules/owners/services/unitLateFee.service');
const {
  generateAllLateFeeInvoices,
  findOverdueRentInvoices,
} = require('../../portals/landlord/modules/invoice/service/lateFeeInvoice.service');
const { enqueueBackgroundJob } = require('../jobs/enqueue');
const { JOB_TYPES } = require('../jobs/constants');
const { buildJobIdempotencyKey } = require('../jobs/idempotency');
const { isBackgroundJobsEnabled } = require('../jobs/config');
const { getDateKeyInTimeZone } = require('../helpers/hoaBillingDates');
const { ClockService, SchedulerUtil } = require('../date');
const { getBillingTimezonesAtLocalHour, resolvePropertyBillingTimezone } = require('../helpers/billingCalendar');
const { buildTimezonePropertyFilter } = require('../helpers/billingTimezone.constants');

const STARTUP_DELAY_MS = Number(process.env.LATE_FEE_STARTUP_DELAY_MS) || 60_000;
const HOURLY_ENABLED = process.env.LATE_FEE_HOURLY_SCHEDULER_ENABLED !== 'false';

let schedulerTimer = null;
let isRunning = false;

async function processHoaLateFeesForTimezone(timezone) {
  const tzFilter = buildTimezonePropertyFilter(timezone);
  const units = await Property.find({
    ...tzFilter,
    hoaId: { $exists: true, $ne: null },
    isDeleted: { $ne: true },
  })
    .select('_id billingTimezone')
    .lean();

  let created = 0;
  let failed = 0;

  for (const unit of units) {
    try {
      if (isBackgroundJobsEnabled()) {
        const dateKey = getDateKeyInTimeZone(ClockService.now(), timezone);
        const result = await enqueueBackgroundJob({
          jobType: JOB_TYPES.INVOICE_LATE_FEE_UNIT,
          entityType: 'Property',
          entityId: unit._id,
          idempotencyKey: buildJobIdempotencyKey('INVOICE_LATE_FEE_UNIT', unit._id, dateKey, timezone),
          payload: {
            unitId: String(unit._id),
            billingTimezone: unit.billingTimezone || timezone,
            scheduledRun: true,
          },
        });
        if (!result.duplicate) created += 1;
      } else {
        const rows = await ensureLateFeeInvoicesForUnit(unit._id, {
          billingTimezone: unit.billingTimezone || timezone,
          scheduledRun: true,
        });
        created += Array.isArray(rows) ? rows.length : 0;
      }
    } catch (error) {
      failed += 1;
      logger.warn(
        '[propertyLateFeeScheduler] HOA unit failed:',
        String(unit._id),
        error?.message || error
      );
    }
  }

  return { processed: units.length, created, failed };
}

async function processLandlordLateFeesForTimezone(timezone) {
  if (!isBackgroundJobsEnabled()) {
    const result = await generateAllLateFeeInvoices({
      billingTimezone: timezone,
      scheduledRun: true,
    });
    return {
      processed: result.processed || 0,
      created: result.generated || 0,
      failed: Array.isArray(result.errors) ? result.errors.length : 0,
    };
  }

  const overdue = await findOverdueRentInvoices();
  let processed = 0;
  let created = 0;
  let failed = 0;
  const dateKey = getDateKeyInTimeZone(ClockService.now(), timezone);

  for (const invoice of overdue) {
    try {
      const propertyId = String(invoice.propertyId || '');
      const property = propertyId
        ? await Property.findOne({ _id: invoice.propertyId, isDeleted: { $ne: true } })
          .select('billingTimezone')
          .lean()
        : null;
      const propertyTimezone = resolvePropertyBillingTimezone(property || {});
      if (propertyTimezone !== timezone) continue;
      processed += 1;
      const result = await enqueueBackgroundJob({
        jobType: JOB_TYPES.INVOICE_LATE_FEE_LANDLORD,
        entityType: 'Invoice',
        entityId: invoice._id,
        idempotencyKey: buildJobIdempotencyKey('INVOICE_LATE_FEE_LANDLORD', invoice._id, dateKey, timezone),
        payload: { invoiceId: String(invoice._id), billingTimezone: timezone, scheduledRun: true },
      });
      if (!result.duplicate) created += 1;
    } catch (error) {
      failed += 1;
      logger.warn('[propertyLateFeeScheduler] Landlord enqueue failed', {
        invoiceId: String(invoice._id),
        error: error?.message || error,
      });
    }
  }

  return { processed, created, failed };
}

async function runHourlyLateFeeBatch() {
  if (isRunning) {
    logger.warn('[propertyLateFeeScheduler] Skipping run - previous batch still in progress');
    return { skipped: true };
  }

  isRunning = true;
  const startedAt = ClockService.nowEpoch();
  const now = ClockService.now();
  const midnightZones = getBillingTimezonesAtLocalHour(0, now);

  if (midnightZones.length === 0) {
    isRunning = false;
    return { skipped: true, reason: 'no_midnight_zones', elapsedMs: ClockService.nowEpoch() - startedAt };
  }

  let hoaProcessed = 0;
  let hoaCreated = 0;
  let hoaFailed = 0;
  let llProcessed = 0;
  let llCreated = 0;
  let llFailed = 0;

  try {
    for (const timezone of midnightZones) {
      const hoa = await processHoaLateFeesForTimezone(timezone);
      hoaProcessed += hoa.processed;
      hoaCreated += hoa.created;
      hoaFailed += hoa.failed;

      const ll = await processLandlordLateFeesForTimezone(timezone);
      llProcessed += ll.processed;
      llCreated += ll.created;
      llFailed += ll.failed;
    }

    const elapsedMs = ClockService.nowEpoch() - startedAt;
    logger.info(
      `[propertyLateFeeScheduler] Completed zones=${midnightZones.join(',')} hoaUnits=${hoaProcessed} hoaFees=${hoaCreated} landlordProcessed=${llProcessed} landlordFees=${llCreated} failed=${hoaFailed + llFailed} elapsedMs=${elapsedMs}`
    );

    return {
      midnightZones,
      hoaProcessed,
      hoaCreated,
      hoaFailed,
      llProcessed,
      llCreated,
      llFailed,
      elapsedMs,
    };
  } finally {
    isRunning = false;
  }
}

function scheduleNextHourlyRun() {
  const delay = SchedulerUtil.msUntilNextHourlyRun();
  schedulerTimer = setTimeout(async () => {
    try {
      await runHourlyLateFeeBatch();
    } catch (error) {
      logger.error('[propertyLateFeeScheduler] Hourly run failed:', error?.message || error);
    } finally {
      scheduleNextHourlyRun();
    }
  }, delay);

  if (typeof schedulerTimer.unref === 'function') {
    schedulerTimer.unref();
  }
}

function startPropertyLateFeeScheduler() {
  if (!HOURLY_ENABLED) {
    logger.info('[propertyLateFeeScheduler] Disabled via LATE_FEE_HOURLY_SCHEDULER_ENABLED=false');
    return;
  }

  const startupTimer = setTimeout(async () => {
    try {
      await runHourlyLateFeeBatch();
    } catch (error) {
      logger.error('[propertyLateFeeScheduler] Startup run failed:', error?.message || error);
    }
  }, STARTUP_DELAY_MS);

  if (typeof startupTimer.unref === 'function') {
    startupTimer.unref();
  }

  scheduleNextHourlyRun();
  logger.info('[propertyLateFeeScheduler] Started (hourly, property-local midnight buckets)');
}

module.exports = {
  startPropertyLateFeeScheduler,
  runHourlyLateFeeBatch,
  processHoaLateFeesForTimezone,
  processLandlordLateFeesForTimezone,
};
