'use strict';

const AUDIT_SOURCES = Object.freeze({
  USER: 'USER',
  ADMIN: 'ADMIN',
  WEBHOOK: 'WEBHOOK',
  SCHEDULER: 'SCHEDULER',
  SYSTEM: 'SYSTEM',
});

/**
 * Derive the origin of an auditable action from the request context.
 * Explicit req.auditSource overrides inference.
 */
function deriveAuditSource(req = {}) {
  if (req.auditSource && AUDIT_SOURCES[req.auditSource]) {
    return req.auditSource;
  }

  const path = `${req.baseUrl || ''}${req.path || ''}`.toLowerCase();
  if (path.includes('/webhooks')) return AUDIT_SOURCES.WEBHOOK;

  if (req.auditScheduler === true) return AUDIT_SOURCES.SCHEDULER;

  const isAdmin =
    req.authUser?.isAdministrator === true
    || req.user?.isAdministrator === true
    || req.isAdministrator === true;

  if (isAdmin) return AUDIT_SOURCES.ADMIN;

  const actorId = req.userId || req.user?._id || req.user?.id;
  if (actorId) return AUDIT_SOURCES.USER;

  return AUDIT_SOURCES.SYSTEM;
}

module.exports = {
  AUDIT_SOURCES,
  deriveAuditSource,
};
