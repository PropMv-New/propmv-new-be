/**
 * ------------------------------------------------------------------
 * File: maintenanceDb.util.js
 * Module: Maintenance Module
 *
 * Purpose:
 * Backend utility/module providing helper functions for maintenanceDb.util.
 *
 * Used By:
 * maintenanceAuditHelper, damageReport.service, maintenance.service
 * ------------------------------------------------------------------
 */

const { runInTransaction } = require('../../../../common/helpers/transactionHelper');

/**
 * apply Session
 *
 * Performs logic operations for applySession.
 *
 * @param query - Request/input argument
 * @param session - Request/input argument
 * @returns Operations result
 */
function applySession(query, session) {
  if (session && query && typeof query.session === 'function') {
    return query.session(session);
  }
  return query;
}

/**
 * with Session
 *
 * Performs logic operations for withSession.
 *
 * @param options - Request/input argument
 * @param session - Request/input argument
 * @returns Operations result
 */
function withSession(options = {}, session) {
  if (!session) return options;
  return { ...options, session };
}

/**
 * Run `fn(session)` inside a transaction unless caller passed options.session.
 * @param {function(import('mongoose').ClientSession): Promise<*>} fn
 * @param {{ session?: import('mongoose').ClientSession }} [options]
 */
async function withMaintenanceTransaction(fn, options = {}) {
  if (options.session) {
    return fn(options.session);
  }
  return runInTransaction(fn);
}

module.exports = {
  runInTransaction,
  applySession,
  withSession,
  withMaintenanceTransaction,
};
