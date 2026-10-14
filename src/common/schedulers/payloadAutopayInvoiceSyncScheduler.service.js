'use strict';

const cron = require('node-cron');
const payloadConfig = require('../../config/payload.config');
const logger = require('../logger');
const { dailySchedule } = require('../../config/dailySchedule.config');

function startPayloadAutopayInvoiceSyncScheduler() {
  if (!payloadConfig.payload.ownerAutopayEnabled) {
    logger.info('[PayloadAutopaySync] Skipped (PAYLOAD_OWNER_AUTOPAY_ENABLED=false)');
    return null;
  }

  const expression = dailySchedule.cronExpression;
  const task = cron.schedule(
    expression,
    async () => {
      try {
        const OwnerPayloadAutopay = require('../../shared/modules/payment/providers/payload/model/ownerPayloadAutopay.model');
        const PayloadPaymentMethod = require('../../shared/modules/payment/providers/payload/model/payloadPaymentMethod.model');
        const { syncOpenInvoicesForOwner } = require('../../shared/modules/payment/providers/payload/service/payloadInvoiceSync.service');

        const enrollments = await OwnerPayloadAutopay.find({ enabled: true }).limit(500);
        let syncedOwners = 0;
        for (const row of enrollments) {
          const paymentMethod = row.payloadPaymentMethodLocalId
            ? await PayloadPaymentMethod.findOne({
              _id: row.payloadPaymentMethodLocalId,
              userId: row.userId,
              isDeleted: { $ne: true },
            })
            : null;
          if (!paymentMethod) continue;
          await syncOpenInvoicesForOwner({
            userId: row.userId,
            hoaId: row.hoaId,
            enrollment: row,
            paymentMethod,
          });
          syncedOwners += 1;
        }
        // Safety-net repair only — primary sync is event-driven (§17.5).
        logger.info('[PayloadAutopaySync] Daily mirror invoice sync complete', {
          enrollments: enrollments.length,
          syncedOwners,
        });
      } catch (err) {
        logger.error('[PayloadAutopaySync] Daily sync failed', { message: err.message });
      }
    },
    { timezone: dailySchedule.timezone },
  );

  logger.info('[PayloadAutopaySync] Scheduled', {
    cron: expression,
    timezone: dailySchedule.timezone,
  });
  return task;
}

module.exports = {
  startPayloadAutopayInvoiceSyncScheduler,
};
