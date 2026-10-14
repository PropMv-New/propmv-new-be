'use strict';

const responseHelper = require('../../helpers/responseHelper');
const { getJobMetrics, getEmailMetrics, getWorkerMetrics, listJobs } = require('../metrics.service');
const { getJobByJobId, retryPermanentJob } = require('../job.service');
const { dispatchJob } = require('../enqueue');

const getMetrics = async (req, res) => {
  try {
    const [jobs, emails, workers] = await Promise.all([
      getJobMetrics(),
      getEmailMetrics(),
      getWorkerMetrics(),
    ]);
    return responseHelper.success(res, { jobs, emails, workers }, 'Background job metrics', 200);
  } catch (err) {
    return responseHelper.error(res, err.message || 'Failed to load job metrics', err.status || 500);
  }
};

const listBackgroundJobs = async (req, res) => {
  try {
    const result = await listJobs(req.query, req.query);
    return responseHelper.success(res, result, 'Background jobs retrieved', 200);
  } catch (err) {
    return responseHelper.error(res, err.message || 'Failed to list jobs', err.status || 500);
  }
};

const getBackgroundJob = async (req, res) => {
  try {
    const item = await getJobByJobId(req.params.jobId);
    if (!item) {
      return responseHelper.error(res, 'Job not found', 404);
    }
    return responseHelper.success(res, { item }, 'Background job retrieved', 200);
  } catch (err) {
    return responseHelper.error(res, err.message || 'Failed to load job', err.status || 500);
  }
};

const retryBackgroundJob = async (req, res) => {
  try {
    const job = await retryPermanentJob(req.params.jobId);
    await dispatchJob(job);
    return responseHelper.success(res, { item: job }, 'Job queued for retry', 200);
  } catch (err) {
    return responseHelper.error(res, err.message || 'Failed to retry job', err.status || 500);
  }
};

module.exports = {
  getMetrics,
  listBackgroundJobs,
  getBackgroundJob,
  retryBackgroundJob,
};
