/**
 * ------------------------------------------------------------------
 * File: ensureHoaIndexes.js
 * Module: Src Common Db
 *
 * Purpose:
 * Backend utility/module providing helper functions for ensureHoaIndexes.
 *
 * Used By:
 * ensureHoaIndexes, app
 * ------------------------------------------------------------------
 */

/**
 * Ensures HOA-critical MongoDB indexes exist (idempotent via syncIndexes).
 * Loaded after mongoose.connect in app startup.
 */

const mongoose = require('mongoose');
const logger = require('../../common/logger');

const MODEL_PATHS = [
  '../../portals/hoa-board/modules/invoice/model/invoice.model',
  '../../portals/hoa-board/modules/property/model/property.model',
  '../../portals/hoa-board/modules/expense/model/expense.model',
  '../../portals/hoa-board/modules/expense/model/payee.model',
  '../../portals/hoa-board/modules/owners/models/ledgerEntry.model',
  '../../portals/hoa-board/modules/leasing/model/lease.model',
  '../../portals/hoa-board/modules/hoa/model/hoa.model',
  '../../portals/hoa-board/modules/hoa/model/hoaMembership.model',
  '../../portals/hoa-board/modules/dashboard/model/activity.model',
  '../../shared/modules/users/models/user.model',
  '../../shared/modules/maintenance/model/maintenanceRequest.model',
  '../../shared/modules/documents/model/hoaDocument.model',
  '../../shared/modules/documents/model/documentMetadata.model',
  '../../common/jobs/models/backgroundJob.model',
  '../../common/jobs/models/notificationLog.model',
  '../../shared/modules/help-center/model/helpArticleFeedback.model',
];

async function ensureHoaIndexes() {
  if (mongoose.connection.readyState !== 1) {
    logger.warn('[ensureHoaIndexes] Skipped - MongoDB not connected');
    return;
  }

  const results = [];
  for (const relPath of MODEL_PATHS) {
    try {
      const Model = require(relPath);
      if (!Model || typeof Model.syncIndexes !== 'function') continue;
      const syncResult = await Model.syncIndexes();
      results.push({ model: Model.modelName, syncResult });
    } catch (err) {
      logger.warn('[ensureHoaIndexes] index sync failed', { path: relPath, error: err.message });
    }
  }

  if (process.env.QUERY_PROFILER === '1') {
    logger.debug('[ensureHoaIndexes] sync complete', { count: results.length });
  }
}

module.exports = { ensureHoaIndexes };
