'use strict';

const mongoose = require('mongoose');
const AuditLog = require('../model/auditLog.model');
const User = require('../../users/models/user.model');
const { DateUtil } = require('../../../../common/date');
const {
  formatAuditLogForInvestigation,
  isValidObjectId,
} = require('../utils/auditInvestigationResponse.util');

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

function asObjectId(value) {
  const str = String(value || '').trim();
  if (!isValidObjectId(str)) return null;
  return new mongoose.Types.ObjectId(str);
}

async function buildCompanyScopeFilter(req) {
  const companyId = req.user?.companyId;
  if (!companyId) return null;

  const memberIds = await User.find({
    companyId,
    isDeleted: { $ne: true },
  }).distinct('_id');

  if (!memberIds.length) {
    return { createdBy: { $in: [] } };
  }

  return { createdBy: { $in: memberIds } };
}

function buildAuditSearchQuery(filters = {}) {
  const query = {};

  if (filters.module) query.module = String(filters.module);
  if (filters.event) query.event = String(filters.event);
  if (filters.entity) query.entity = String(filters.entity);
  if (filters.entityId) query.entityId = String(filters.entityId);
  if (filters.source) query.source = String(filters.source);
  if (filters.success !== undefined) query.success = Boolean(filters.success);
  if (filters.requestId) query.requestId = String(filters.requestId);
  if (filters.correlationId) query.correlationId = String(filters.correlationId);
  if (filters.auditEventId) query.auditEventId = String(filters.auditEventId);

  const createdBy = asObjectId(filters.createdBy);
  if (createdBy) query.createdBy = createdBy;

  const hoaId = asObjectId(filters.hoaId);
  if (hoaId) query.hoaId = hoaId;

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

  return query;
}

async function searchAuditEvents(filters = {}, options = {}, req = {}) {
  const baseQuery = buildAuditSearchQuery(filters);
  const companyScope = await buildCompanyScopeFilter(req);

  const query = companyScope
    ? { $and: [baseQuery, companyScope] }
    : baseQuery;

  const limit = Math.max(1, Math.min(Number(options.limit) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));
  const page = Math.max(1, Number(options.page) || 1);
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    AuditLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(query),
  ]);

  return {
    items: items.map(formatAuditLogForInvestigation),
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit) || 1,
    },
  };
}

async function getAuditEventDetail(id, req = {}) {
  const lookup = String(id || '').trim();
  if (!lookup) {
    const err = new Error('Audit event id is required');
    err.status = 400;
    throw err;
  }

  let doc = null;
  if (isValidObjectId(lookup)) {
    doc = await AuditLog.findById(lookup).lean();
  }
  if (!doc) {
    doc = await AuditLog.findOne({ auditEventId: lookup }).lean();
  }

  if (!doc) {
    const err = new Error('Audit event not found');
    err.status = 404;
    throw err;
  }

  const companyScope = await buildCompanyScopeFilter(req);
  if (companyScope?.createdBy?.$in?.length) {
    const allowed = companyScope.createdBy.$in.some(
      (oid) => doc.createdBy && String(oid) === String(doc.createdBy)
    );
    if (!allowed) {
      const err = new Error('Audit event not found');
      err.status = 404;
      throw err;
    }
  }

  return formatAuditLogForInvestigation(doc);
}

module.exports = {
  searchAuditEvents,
  getAuditEventDetail,
  buildAuditSearchQuery,
  buildCompanyScopeFilter,
};
