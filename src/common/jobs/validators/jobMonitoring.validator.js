'use strict';

const Joi = require('joi');
const { JOB_STATUS, QUEUE_NAMES } = require('../constants');

const jobListQuerySchema = Joi.object({
  status: Joi.string().valid(...Object.values(JOB_STATUS)).optional(),
  jobType: Joi.string().trim().max(80).optional(),
  entityId: Joi.string().trim().max(64).optional(),
  recipientId: Joi.string().trim().max(64).optional(),
  queue: Joi.string().valid(...Object.values(QUEUE_NAMES)).optional(),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
});

const jobIdParamsSchema = Joi.object({
  jobId: Joi.string().trim().required(),
});

module.exports = {
  jobListQuerySchema,
  jobIdParamsSchema,
};
