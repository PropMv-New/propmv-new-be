'use strict';

const { createAuditLogInBackground, AUDIT_SOURCES } = require('../../../../modules/audit/service/auditLog.service');
const { AUDIT_EVENTS } = require('../constants/account.constants');
const { buildAuditIdempotencyKey } = require('../../../../modules/audit/utils/auditIdempotency.util');

function auditAccount({
  event,
  createdBy,
  before = null,
  after = null,
  ipAddress = '',
  req = null,
  source = null,
  entity = 'StraddleAccount',
  entityId = '',
  success = true,
  failureReason = '',
  idempotencyKey = null,
}) {
  const resolvedSource = source || (req ? undefined : AUDIT_SOURCES.WEBHOOK);
  const resolvedIdempotencyKey = idempotencyKey || buildAuditIdempotencyKey({
    module: 'StraddleAccount',
    event,
    after,
    source: resolvedSource || AUDIT_SOURCES.WEBHOOK,
    entity,
    entityId,
    createdBy,
    success,
  });

  createAuditLogInBackground({
    module: 'StraddleAccount',
    event,
    entity,
    entityId: entityId || (after?.entityId ? String(after.entityId) : '') || (after?.bankId ? String(after.bankId) : ''),
    createdBy,
    before,
    after,
    ipAddress,
    req,
    source: resolvedSource,
    success,
    failureReason,
    idempotencyKey: resolvedIdempotencyKey,
  });
}

module.exports = { auditAccount, AUDIT_EVENTS };
