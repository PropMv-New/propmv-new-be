/**
 * ------------------------------------------------------------------
 * File: leaseDb.util.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for leaseDb.util.
 *
 * Used By:
 * lease.service, leaseActivation.service, leaseAutoApproval.service
 * ------------------------------------------------------------------
 */

const { runInTransaction } = require('../../../../../common/helpers/transactionHelper');

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

async function createOne(Model, doc, session) {
  if (session) {
    const created = await Model.create([doc], { session });
    return created[0];
  }
  return Model.create(doc);
}

async function findOneAndUpdateOne(Model, filter, update, options = {}, session) {
  const query = applySession(Model.findOneAndUpdate(filter, update, options), session);
  return query;
}

async function updateOne(Model, filter, update, options = {}, session) {
  const query = applySession(Model.updateOne(filter, update, options), session);
  return query;
}

module.exports = {
  runInTransaction,
  applySession,
  withSession,
  createOne,
  findOneAndUpdateOne,
  updateOne,
};
