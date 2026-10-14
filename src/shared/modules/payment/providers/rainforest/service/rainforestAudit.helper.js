'use strict';

const { createAuditLogInBackground } = require('../../../../audit/service/auditLog.service');
const { AUDIT_EVENTS } = require('../constants/rainforest.constants');

function auditRainforest({
  event,
  entity = 'Rainforest',
  entityId = '',
  createdBy = null,
  before = null,
  after = null,
  req = null,
  success = true,
  failureReason = '',
}) {
  createAuditLogInBackground({
    module: 'Rainforest',
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
  auditRainforest,
  AUDIT_EVENTS,
};
