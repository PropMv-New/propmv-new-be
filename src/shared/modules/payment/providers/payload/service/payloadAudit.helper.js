'use strict';

const { createAuditLogInBackground } = require('../../../../audit/service/auditLog.service');
const { AUDIT_EVENTS } = require('../constants/payload.constants');

function auditPayload({
  event,
  entity = 'Payload',
  entityId = '',
  createdBy = null,
  before = null,
  after = null,
  req = null,
  success = true,
  failureReason = '',
}) {
  createAuditLogInBackground({
    module: 'Payload',
    event,
    entity,
    entityId: String(entityId || ''),
    createdBy,
    before,
    after,
    req,
    success,
    failureReason,
    skipOutbox: false,
  });
}

module.exports = {
  auditPayload,
  AUDIT_EVENTS,
};
