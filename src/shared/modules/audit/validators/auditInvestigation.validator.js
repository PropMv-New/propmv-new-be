'use strict';

const Joi = require('joi');

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);
const auditEventId = Joi.string().trim().max(120);

const auditSearchQuerySchema = Joi.object({
  createdBy: objectId.optional(),
  hoaId: objectId.optional(),
  entity: Joi.string().trim().max(120).optional(),
  entityId: Joi.string().trim().max(120).optional(),
  module: Joi.string().trim().max(120).optional(),
  event: Joi.string().trim().max(120).optional(),
  source: Joi.string().valid('USER', 'ADMIN', 'WEBHOOK', 'SCHEDULER', 'SYSTEM').optional(),
  success: Joi.boolean().optional(),
  requestId: Joi.string().trim().max(120).optional(),
  correlationId: Joi.string().trim().max(120).optional(),
  auditEventId: auditEventId.optional(),
  from: Joi.date().iso().optional(),
  to: Joi.date().iso().optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(25),
}).custom((value, helpers) => {
  const hasFilter = Boolean(
    value.createdBy
    || value.hoaId
    || value.entityId
    || value.requestId
    || value.correlationId
    || value.auditEventId
    || value.from
    || value.to
  );
  if (!hasFilter) {
    return helpers.error('any.custom', {
      message: 'At least one filter is required (createdBy, hoaId, entityId, requestId, correlationId, auditEventId, or date range).',
    });
  }
  if (value.from && value.to) {
    const fromMs = new Date(value.from).getTime();
    const toMs = new Date(value.to).getTime();
    const maxSpanMs = 93 * 24 * 60 * 60 * 1000;
    if (toMs < fromMs) {
      return helpers.error('any.custom', { message: '"to" must be after "from".' });
    }
    if (toMs - fromMs > maxSpanMs) {
      return helpers.error('any.custom', { message: 'Date range cannot exceed 93 days.' });
    }
  }
  if ((value.from && !value.to) || (!value.from && value.to)) {
    return helpers.error('any.custom', { message: 'Both "from" and "to" are required for date range filters.' });
  }
  return value;
});

const outboxFailedQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(25),
  module: Joi.string().trim().max(120).optional(),
  event: Joi.string().trim().max(120).optional(),
});

const outboxReplayParamsSchema = Joi.object({
  eventId: auditEventId.required(),
});

const auditDetailParamsSchema = Joi.object({
  id: Joi.string().trim().max(120).required(),
});

module.exports = {
  auditSearchQuerySchema,
  outboxFailedQuerySchema,
  outboxReplayParamsSchema,
  auditDetailParamsSchema,
};
