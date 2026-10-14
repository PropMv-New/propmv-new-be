'use strict';

const mongoose = require('mongoose');
const RainforestPayin = require('../model/rainforestPayin.model');
const RainforestWebhookEvent = require('../model/rainforestWebhookEvent.model');
const Invoice = require('../../../../../../portals/hoa-board/modules/invoice/model/invoice.model');
const LedgerEntry = require('../../../../../../portals/hoa-board/modules/owners/models/ledgerEntry.model');
const HOAMembership = require('../../../../../../portals/hoa-board/modules/hoa/model/hoaMembership.model');
const { ROLE_NAMES } = require('../../../../../../common/constants/roleNames');
const { isHOABoardMemberRole } = require('../../../../../../common/helpers/hoaBoardRole');
const { ensureRainforestEnabled } = require('./rainforestMerchant.service');
const { auditRainforest } = require('./rainforestAudit.helper');
const { AUDIT_EVENTS } = require('../constants/rainforest.constants');
const {
  assessRainforestPayinRow,
  assessFailedWebhookEvent,
  summarizeReconciliationIssues,
} = require('../utils/rainforestReconciliation.util');
const logger = require('../../../../../../common/logger');

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

async function assertRainforestOpsAccess(userId, hoaId, req) {
  const userOid = toObjectId(userId);
  if (!userOid) {
    const err = new Error('Invalid user context.');
    err.statusCode = 400;
    throw err;
  }

  const roleName = req?.user?.userRoleName || req?.userRoleName || '';
  if (
    roleName === ROLE_NAMES.PROPERTY_MANAGER
    || roleName === 'Landlord'
    || req?.user?.isAdministrator
  ) {
    return;
  }

  if (isHOABoardMemberRole(roleName)) {
    const membershipQuery = {
      userId: userOid,
      status: 'active',
    };
    if (hoaId) membershipQuery.hoaId = hoaId;
    const membership = await HOAMembership.findOne(membershipQuery).lean();
    if (membership) return;
  }

  const err = new Error('You do not have permission to run Rainforest reconciliation.');
  err.statusCode = 403;
  throw err;
}

async function runRainforestReconciliation({
  userId,
  hoaId,
  since,
  limit = 100,
  includeFailedWebhooks = true,
  staleInReviewHours,
  staleProcessingHours,
  req = null,
} = {}) {
  ensureRainforestEnabled();

  const hoaOid = toObjectId(hoaId);
  if (!hoaOid) {
    const err = new Error('hoaId is required for Rainforest reconciliation.');
    err.statusCode = 400;
    throw err;
  }

  await assertRainforestOpsAccess(userId, hoaOid, req);

  const payinQuery = {
    isDeleted: { $ne: true },
    payinId: { $ne: null },
  };
  if (since) {
    payinQuery.updatedAt = { $gte: new Date(since) };
  }

  const scopedInvoiceIds = await Invoice.find({
    hoaId: hoaOid,
    isDeleted: { $ne: true },
  }).distinct('_id');

  if (!scopedInvoiceIds.length) {
    return {
      hoaId: String(hoaOid),
      scannedPayins: 0,
      scannedWebhooks: 0,
      issues: [],
      summary: summarizeReconciliationIssues([]),
    };
  }

  payinQuery.invoiceId = { $in: scopedInvoiceIds };

  const payins = await RainforestPayin.find(payinQuery)
    .sort({ updatedAt: -1 })
    .limit(Math.max(1, Math.min(Number(limit) || 100, 500)))
    .lean();

  const invoiceIds = [...new Set(payins.map((row) => String(row.invoiceId)))];
  const invoices = await Invoice.find({ _id: { $in: invoiceIds }, isDeleted: { $ne: true } })
    .select('_id hoaId propertyId paymentTransactions invoiceId')
    .lean();
  const invoiceById = new Map(invoices.map((row) => [String(row._id), row]));

  const propertyIds = [...new Set(invoices.map((row) => String(row.propertyId)).filter(Boolean))];
  const ledgerEntries = propertyIds.length
    ? await LedgerEntry.find({
      unitId: { $in: propertyIds },
      type: 'payment',
      referenceId: { $in: invoiceIds },
    }).lean()
    : [];

  const ledgerByInvoiceId = new Map();
  for (const entry of ledgerEntries) {
    const key = String(entry.referenceId || '');
    if (!ledgerByInvoiceId.has(key)) ledgerByInvoiceId.set(key, []);
    ledgerByInvoiceId.get(key).push(entry);
  }

  const issues = [];
  for (const payin of payins) {
    const invoice = invoiceById.get(String(payin.invoiceId)) || null;
    const invoiceLedger = ledgerByInvoiceId.get(String(payin.invoiceId)) || [];
    issues.push(...assessRainforestPayinRow({
      payin,
      invoice,
      ledgerEntries: invoiceLedger,
      staleInReviewHours,
      staleProcessingHours,
    }));
  }

  let scannedWebhooks = 0;
  if (includeFailedWebhooks) {
    const payinIds = payins.map((row) => String(row.payinId || '')).filter(Boolean);
    if (payinIds.length) {
      const failedEvents = await RainforestWebhookEvent.find({
        processingStatus: 'failed',
        resourceId: { $in: payinIds },
      })
        .sort({ updatedAt: -1 })
        .limit(50)
        .lean();
      scannedWebhooks = failedEvents.length;
      for (const eventDoc of failedEvents) {
        const issue = assessFailedWebhookEvent(eventDoc);
        if (issue) issues.push(issue);
      }
    }
  }

  const summary = summarizeReconciliationIssues(issues);

  auditRainforest({
    event: AUDIT_EVENTS.RECONCILIATION_RUN,
    entity: 'RainforestReconciliation',
    createdBy: toObjectId(userId),
    after: {
      hoaId: String(hoaOid),
      scannedPayins: payins.length,
      scannedWebhooks,
      issueCount: summary.total,
      byCode: summary.byCode,
    },
    req,
  });

  logger.info('[RainforestReconciliation] Scan complete', {
    hoaId: String(hoaOid),
    scannedPayins: payins.length,
    issueCount: summary.total,
  });

  return {
    hoaId: String(hoaOid),
    scannedPayins: payins.length,
    scannedWebhooks,
    issues,
    summary,
  };
}

module.exports = {
  runRainforestReconciliation,
  assertRainforestOpsAccess,
};
