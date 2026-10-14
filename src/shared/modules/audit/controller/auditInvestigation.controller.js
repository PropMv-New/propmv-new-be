'use strict';

const responseHelper = require('../../../../common/helpers/responseHelper');
const auditInvestigationService = require('../service/auditInvestigation.service');
const {
  getOutboxMetrics,
  listFailedOutboxEvents,
  getOutboxEventByEventId,
  replayFailedOutboxEvent,
} = require('../service/auditOutbox.service');
const {
  formatOutboxForInvestigation,
} = require('../utils/auditInvestigationResponse.util');

const searchAuditEvents = async (req, res) => {
  try {
    const result = await auditInvestigationService.searchAuditEvents(req.query, req.query, req);
    return responseHelper.success(res, result, 'Audit events retrieved', 200);
  } catch (err) {
    return responseHelper.error(res, err.message || 'Failed to search audit events', err.status || 500);
  }
};

const getAuditEventDetail = async (req, res) => {
  try {
    const item = await auditInvestigationService.getAuditEventDetail(req.params.id, req);
    return responseHelper.success(res, { item }, 'Audit event retrieved', 200);
  } catch (err) {
    return responseHelper.error(res, err.message || 'Failed to retrieve audit event', err.status || 404);
  }
};

const getOutboxDiagnostics = async (req, res) => {
  try {
    const metrics = await getOutboxMetrics();
    return responseHelper.success(res, { metrics }, 'Audit outbox diagnostics', 200);
  } catch (err) {
    return responseHelper.error(res, err.message || 'Failed to load outbox diagnostics', err.status || 500);
  }
};

const listFailedOutbox = async (req, res) => {
  try {
    const result = await listFailedOutboxEvents(req.query, req.query);
    return responseHelper.success(res, {
      items: result.items.map(formatOutboxForInvestigation),
      pagination: result.pagination,
    }, 'Failed outbox events retrieved', 200);
  } catch (err) {
    return responseHelper.error(res, err.message || 'Failed to list failed outbox events', err.status || 500);
  }
};

const getFailedOutboxDetail = async (req, res) => {
  try {
    const row = await getOutboxEventByEventId(req.params.eventId);
    if (!row || row.status !== 'failed') {
      return responseHelper.error(res, 'Failed outbox event not found', 404);
    }
    return responseHelper.success(res, { item: formatOutboxForInvestigation(row) }, 'Failed outbox event retrieved', 200);
  } catch (err) {
    return responseHelper.error(res, err.message || 'Failed to retrieve outbox event', err.status || 500);
  }
};

const replayFailedOutbox = async (req, res) => {
  try {
    const initiatedBy = req.userId || req.user?._id || req.user?.id;
    const result = await replayFailedOutboxEvent(req.params.eventId, {
      initiatedBy,
      req,
    });
    return responseHelper.success(res, result, 'Outbox event replay processed', 200);
  } catch (err) {
    return responseHelper.error(res, err.message || 'Failed to replay outbox event', err.status || 500);
  }
};

module.exports = {
  searchAuditEvents,
  getAuditEventDetail,
  getOutboxDiagnostics,
  listFailedOutbox,
  getFailedOutboxDetail,
  replayFailedOutbox,
};
