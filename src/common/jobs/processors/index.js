'use strict';

const { QUEUE_NAMES } = require('../constants');

async function processJobByQueue(job) {
  switch (job.queue) {
    case QUEUE_NAMES.EMAIL: {
      const { processEmailJob } = require('./email.processor');
      return processEmailJob(job);
    }
    case QUEUE_NAMES.NOTIFICATION: {
      const { processNotificationJob } = require('./notification.processor');
      return processNotificationJob(job);
    }
    case QUEUE_NAMES.INVOICE: {
      const { processInvoiceJob } = require('./invoice.processor');
      return processInvoiceJob(job);
    }
    case QUEUE_NAMES.MAINTENANCE: {
      const { processMaintenanceJob } = require('./maintenance.processor');
      return processMaintenanceJob(job);
    }
    case QUEUE_NAMES.REPORT: {
      const { processReportJob } = require('./report.processor');
      return processReportJob(job);
    }
    default: {
      const err = new Error(`Unknown job queue: ${job.queue}`);
      err.permanent = true;
      throw err;
    }
  }
}

module.exports = {
  processJobByQueue,
};
