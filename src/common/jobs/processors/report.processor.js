'use strict';

const { JOB_TYPES } = require('../constants');

async function processReportJob(job) {
  const payload = job.payload || {};
  if (typeof payload.run === 'string') {
    const err = new Error('Report runner callbacks cannot be serialized; use a named report type');
    err.permanent = true;
    throw err;
  }
  if (job.jobType !== JOB_TYPES.REPORT_GENERIC) {
    const err = new Error(`Unsupported report job type: ${job.jobType}`);
    err.permanent = true;
    throw err;
  }
  return { skipped: true, reason: 'no_report_handler', reportType: payload.reportType || '' };
}

module.exports = {
  processReportJob,
};
