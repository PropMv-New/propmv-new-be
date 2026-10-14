/**
 * ------------------------------------------------------------------
 * File: auditLog.service.js
 * Module: Audit Logging Module
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * auditLogger.middleware, portalInvitation.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const AuditLog = require('../model/auditLog.model');
const { ClockService, DateUtil } = require('../../../../common/date');
const { getRequestIpAddress } = require('../../../utils/requestIp.util');
const logger = require('../../../../common/logger');
const { redactForAudit } = require('../utils/auditRedact.util');
const { AUDIT_SOURCES, deriveAuditSource } = require('../utils/auditSource.util');
const { isCriticalAuditModule } = require('../utils/auditCriticalModules.util');
const { enqueueAuditEvent } = require('./auditOutbox.service');

const OUTBOX_ENABLED = process.env.AUDIT_OUTBOX_ENABLED !== 'false';

/**
 * as Object Id Or Undefined
 *
 * Performs logic operations for asObjectIdOrUndefined.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function asObjectIdOrUndefined(value) {
  if (!value) return undefined;
  const str = String(value);
  if (!mongoose.Types.ObjectId.isValid(str)) return undefined;
  return new mongoose.Types.ObjectId(str);
}

/**
 * clone Safe
 *
 * Performs logic operations for cloneSafe.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function cloneSafe(value) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (err) {
    return value;
  }
}

/**
 * pick User Name
 *
 * Performs logic operations for pickUserName.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function pickUserName(req) {
  const user = req?.authUser || req?.user;
  if (!user) return '';
  const first = user.firstName || '';
  const last = user.lastName || '';
  const full = `${first} ${last}`.trim();
  return full || user.email || '';
}

/**
 * pick User Role
 *
 * Performs logic operations for pickUserRole.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function pickUserRole(req) {
  if (req?.auditUserRole) return String(req.auditUserRole);
  if (req?.userRoleName) return String(req.userRoleName);

  const requestUser = req?.user;
  if (requestUser?.role?.name) return String(requestUser.role.name);
  if (typeof requestUser?.role === 'string' && requestUser.role.trim()) {
    return requestUser.role.trim();
  }
  if (requestUser?.roleName) return String(requestUser.roleName);

  const authUser = req?.authUser;
  if (authUser?.role?.name) return String(authUser.role.name);
  if (typeof authUser?.role === 'string' && authUser.role.trim()) {
    return authUser.role.trim();
  }
  if (authUser?.roleName) return String(authUser.roleName);
  return '';
}

/**
 * pick Entity From Request
 *
 * Performs logic operations for pickEntityFromRequest.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function pickEntityFromRequest(req) {
  if (req?.auditEntity) return String(req.auditEntity);
  const params = req?.params || {};
  if (params.bankId) return 'LinkedBankAccount';
  if (params.paymentMethodId) return 'PaymentCard';
  if (params.id) return deriveEntityFromPath(req);
  if (params.ownerId) return 'Owner';
  if (params.propertyId) return 'Property';
  if (params.invoiceId) return 'Invoice';
  return deriveEntityFromPath(req);
}

/**
 * pick Entity Id From Request
 *
 * Performs logic operations for pickEntityIdFromRequest.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function pickEntityIdFromRequest(req) {
  if (req?.auditEntityId) return String(req.auditEntityId);
  const params = req?.params || {};
  return (
    params.bankId
    || params.paymentMethodId
    || params.id
    || params.ownerId
    || params.propertyId
    || params.invoiceId
    || params.jobId
    || ''
  );
}

/**
 * derive Entity From Path
 *
 * Performs logic operations for deriveEntityFromPath.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function deriveEntityFromPath(req) {
  const path = `${req?.baseUrl || ''}${req?.path || ''}`.toLowerCase();
  if (path.includes('/billing-settings')) return 'BillingSettings';
  if (path.includes('/bank-accounts') || path.includes('/banks')) return 'BankAccount';
  if (path.includes('/charges')) return 'PaymentCharge';
  if (path.includes('/payouts')) return 'PaymentPayout';
  if (path.includes('/customers')) return 'PaymentCustomer';
  if (path.includes('/cards') || path.includes('/setup-intent')) return 'PaymentCard';
  if (path.includes('/accounts')) return 'StraddleAccount';
  if (path.includes('/owners')) return 'Owner';
  if (path.includes('/invoice')) return 'Invoice';
  if (path.includes('/property')) return 'Property';
  if (path.includes('/expense')) return 'Expense';
  if (path.includes('/maintenance')) return 'Maintenance';
  if (path.includes('/messaging')) return 'Message';
  if (path.includes('/email')) return 'Email';
  if (path.includes('/documents')) return 'Document';
  if (path.includes('/board-members')) return 'HOAMembership';
  return 'Record';
}

/**
 * derive Portal
 *
 * Performs logic operations for derivePortal.
 *
 * @param req - Request/input argument
 * @param sourceLabel - Request/input argument
 * @returns Operations result
 */
function derivePortal(req, sourceLabel = '') {
  const actorRole = pickUserRole(req);
  if (actorRole) return actorRole;

  const base = String(req?.baseUrl || '').toLowerCase();
  if (base.includes('/hoa')) return 'HOA';
  if (base.includes('/landlord')) return 'Landlord';
  if (base.includes('/auth')) return 'Auth';
  if (base.includes('/users')) return 'Users';
  if (base.includes('/payments')) return 'Payments';
  if (base.includes('/accounts')) return 'Accounts';
  return sourceLabel || 'Shared';
}

/**
 * build Audit Context
 *
 * Performs logic operations for buildAuditContext.
 *
 * @param req - Request/input argument
 * @param sourceLabel - Request/input argument
 * @returns Operations result
 */
function buildAuditContext(req = {}, sourceLabel = '') {
  const headers = req.headers || {};
  return {
    ipAddress: getRequestIpAddress(req),
    userName: pickUserName(req),
    userRole: pickUserRole(req),
    entity: pickEntityFromRequest(req),
    entityId: String(pickEntityIdFromRequest(req) || ''),
    portal: derivePortal(req, sourceLabel),
    hoaId: asObjectIdOrUndefined(req?.hoaContext?.hoaId || headers['x-hoa-id']),
    deviceInfo: String(headers['x-device-info'] || headers['sec-ch-ua-platform'] || '').slice(0, 250),
    browserInfo: String(headers['user-agent'] || '').slice(0, 500),
    sessionId: String(headers['x-session-id'] || req?.sessionId || '').slice(0, 120),
    correlationId: String(headers['x-correlation-id'] || headers['x-request-id'] || '').slice(0, 120),
    requestId: String(
      req?.landlordRequestId
      || headers['x-request-id']
      || req?.id
      || uuidv4()
    ).slice(0, 120),
    source: deriveAuditSource(req),
  };
}

function prepareAuditEntry(entry = {}) {
  const context = entry.req ? buildAuditContext(entry.req, entry.sourceLabel) : {};
  const prepared = {
    ...context,
    ...entry,
    ipAddress: entry.ipAddress || context.ipAddress,
    source: entry.source || context.source || AUDIT_SOURCES.SYSTEM,
  };
  delete prepared.req;
  delete prepared.sourceLabel;
  delete prepared.forceOutbox;
  delete prepared.idempotencyKey;
  return prepared;
}

function entryUsesOutbox(prepared, entry = {}) {
  if (entry.skipOutbox === true) return false;
  return prepared.forceOutbox === true || prepared.source === AUDIT_SOURCES.WEBHOOK;
}

function shouldUseAuditOutbox(prepared = {}, entry = {}) {
  if (!OUTBOX_ENABLED) return false;
  if (entry.skipOutbox === true) return false;
  if (entryUsesOutbox(prepared, entry)) return true;
  return isCriticalAuditModule(prepared.module, prepared);
}

async function createAuditLog(entry = {}) {
  const event = String(entry.event || entry.action || '').trim();
  const resolvedSource = entry.source
    ? String(entry.source).trim()
    : (entry.req ? deriveAuditSource(entry.req) : AUDIT_SOURCES.SYSTEM);

  const auditEventId = entry.auditEventId ? String(entry.auditEventId).trim() : '';

  if (auditEventId) {
    const existing = await AuditLog.findOne({ auditEventId }).lean();
    if (existing) return existing;
  }

  const payload = {
    module: String(entry.module || '').trim(),
    event,
    action: String(entry.action || event).trim(),
    entity: String(entry.entity || '').trim(),
    entityId: String(entry.entityId || '').trim(),
    portal: String(entry.portal || '').trim(),
    hoaId: asObjectIdOrUndefined(entry.hoaId),
    createdBy: asObjectIdOrUndefined(entry.createdBy),
    userName: String(entry.userName || '').trim(),
    userRole: String(entry.userRole || '').trim(),
    createdAt: (() => {
      const ms = DateUtil.toEpoch(entry.createdAt);
      return ms != null ? DateUtil.fromEpoch(ms) : ClockService.now();
    })(),
    before: redactForAudit(cloneSafe(entry.before ?? null)),
    after: redactForAudit(cloneSafe(entry.after ?? null)),
    ipAddress: entry.ipAddress ? String(entry.ipAddress) : '',
    deviceInfo: String(entry.deviceInfo || '').trim(),
    browserInfo: String(entry.browserInfo || '').trim(),
    sessionId: String(entry.sessionId || '').trim(),
    correlationId: String(entry.correlationId || '').trim(),
    requestId: String(entry.requestId || '').trim(),
    success: entry.success !== false,
    failureReason: String(entry.failureReason || '').trim(),
    source: resolvedSource,
    auditEventId,
  };

  if (!payload.module) {
    throw Object.assign(new Error('module is required for audit log'), { status: 400 });
  }
  if (!payload.event) {
    throw Object.assign(new Error('event is required for audit log'), { status: 400 });
  }

  try {
    const created = await AuditLog.create(payload);
    return created.toObject();
  } catch (err) {
    if (err && err.code === 11000 && auditEventId) {
      const existing = await AuditLog.findOne({ auditEventId }).lean();
      if (existing) return existing;
    }
    throw err;
  }
}

function logAuditWriteFailure(err, prepared = {}) {
  logger.error('[AuditLog] Failed to write audit log', {
    error: err.message,
    module: prepared.module || '',
    event: prepared.event || prepared.action || '',
    entity: prepared.entity || '',
    entityId: prepared.entityId || '',
    createdBy: prepared.createdBy ? String(prepared.createdBy) : '',
    requestId: prepared.requestId || '',
    correlationId: prepared.correlationId || '',
    source: prepared.source || '',
    success: prepared.success,
  });
}

/**
 * create Audit Log In Background
 *
 * Performs logic operations for createAuditLogInBackground.
 *
 * @param entry - Request/input argument
 * @returns Operations result
 */
function createAuditLogInBackground(entry = {}) {
  setImmediate(async () => {
    let prepared = null;
    try {
      prepared = prepareAuditEntry(entry);

      if (shouldUseAuditOutbox({ ...prepared, forceOutbox: entry.forceOutbox }, entry)) {
        await enqueueAuditEvent(prepared, {
          idempotencyKey: entry.idempotencyKey,
          eventId: entry.auditEventId,
        });
        return;
      }

      await createAuditLog(prepared);
    } catch (err) {
      logAuditWriteFailure(err, prepared || entry);
    }
  });
}

async function searchAuditLogs(filters = {}, options = {}) {
  const query = {};
  if (filters.module) query.module = String(filters.module);
  if (filters.event) query.event = String(filters.event);
  if (filters.portal) query.portal = String(filters.portal);
  if (filters.entity) query.entity = String(filters.entity);
  if (filters.entityId) query.entityId = String(filters.entityId);
  if (filters.source) query.source = String(filters.source);
  if (filters.createdBy) query.createdBy = asObjectIdOrUndefined(filters.createdBy);
  if (filters.hoaId) query.hoaId = asObjectIdOrUndefined(filters.hoaId);
  if (filters.success !== undefined) query.success = Boolean(filters.success);
  if (filters.from || filters.to) {
    query.createdAt = {};
    if (filters.from) {
      const fromMs = DateUtil.toEpoch(filters.from);
      if (fromMs != null) query.createdAt.$gte = DateUtil.fromEpoch(fromMs);
    }
    if (filters.to) {
      const toMs = DateUtil.toEpoch(filters.to);
      if (toMs != null) query.createdAt.$lte = DateUtil.fromEpoch(toMs);
    }
  }

  const limit = Math.max(1, Math.min(Number(options.limit) || 50, 200));
  const page = Math.max(1, Number(options.page) || 1);
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    AuditLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(query),
  ]);

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit) || 1,
    },
  };
}

module.exports = {
  createAuditLog,
  createAuditLogInBackground,
  prepareAuditEntry,
  shouldUseAuditOutbox,
  searchAuditLogs,
  buildAuditContext,
  deriveAuditSource,
  AUDIT_SOURCES,
  redactForAudit,
};
