'use strict';

const { JOB_TYPES } = require('../constants');

async function processMaintenanceJob(job) {
  const payload = job.payload || {};
  if (job.jobType === JOB_TYPES.MAINTENANCE_CREATED || job.jobType === JOB_TYPES.EMAIL_MAINTENANCE_CREATED) {
    const { processEmailJob } = require('./email.processor');
    return processEmailJob({ ...job, jobType: JOB_TYPES.EMAIL_MAINTENANCE_CREATED });
  }
  if (job.jobType === JOB_TYPES.EMAIL_MAINTENANCE_NOTIFICATION) {
    const { processEmailJob } = require('./email.processor');
    return processEmailJob(job);
  }
  const err = new Error(`Unsupported maintenance job type: ${job.jobType}`);
  err.permanent = true;
  throw err;
}

module.exports = {
  processMaintenanceJob,
};
