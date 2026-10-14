/**
 * ------------------------------------------------------------------
 * File: maintenanceNotificationEmailQueue.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for maintenanceNotificationEmailQueue.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */
const emailHelper = require('./emailHelper');
const { buildMaintenanceTicketPreheader } = require('./emailDisplayHelper');
const logger = require('../logger');
const { enqueueOrRunInBackground } = require('../jobs/enqueue');
const { JOB_TYPES } = require('../jobs/constants');
const { buildJobIdempotencyKey } = require('../jobs/idempotency');

/**
 * enqueue Maintenance Notification Email
 *
 * Performs logic operations for enqueueMaintenanceNotificationEmail.
 *
 * @param job - Request/input argument
 * @returns Operations result
 */
function enqueueMaintenanceNotificationEmail(job) {
  if (!job || !job.toEmail || !job.data) return;
  enqueueOrRunInBackground({
    jobType: JOB_TYPES.EMAIL_MAINTENANCE_NOTIFICATION,
    entityType: 'Maintenance',
    entityId: job.maintenanceId || job.data?.ticketId || '',
    recipientId: job.toEmail,
    idempotencyKey: buildJobIdempotencyKey(
      'EMAIL_MAINTENANCE_NOTIFICATION',
      job.maintenanceId || job.data?.ticketId,
      job.toEmail,
      job.data?.eventMessage
    ),
    payload: {
      toEmail: job.toEmail,
      data: job.data,
      subject: job.subject,
      preheaderText: job.preheaderText,
      maintenanceId: job.maintenanceId || '',
    },
    run: () => emailHelper.sendEmail('maintenance-ticket-notification', job.toEmail, job.data, {
      template: 'maintenance-ticket-notification',
      subject: job.subject || 'New maintenance ticket',
      preheaderText:
        job.preheaderText ||
        buildMaintenanceTicketPreheader({
          eventMessage: job.data?.eventMessage,
          ticketTitle: job.data?.ticketTitle || job.data?.requestTitle,
        }),
    }),
  });
}

module.exports = {
  enqueueMaintenanceNotificationEmail,
};
