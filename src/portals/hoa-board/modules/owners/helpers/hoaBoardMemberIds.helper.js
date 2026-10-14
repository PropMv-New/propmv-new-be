/**
 * ------------------------------------------------------------------
 * File: hoaBoardMemberIds.helper.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for hoaBoardMemberIds.helper.
 *
 * Used By:
 * invoiceLifecycleEmail.service, invoiceScheduleNotify.service
 * ------------------------------------------------------------------
 */

/**
 * Returns all active board-member user IDs for an HOA.
 * Delegates to loadHoaMemberUserIds so schedule/legacy callers stay in sync
 * with the centralized notification recipient resolver.
 */
const { loadHoaMemberUserIds } = require('../../../../../middleware/hoaDataIsolation');

async function resolveBoardMemberUserIds(hoaId) {
  return loadHoaMemberUserIds(hoaId);
}

module.exports = {
  resolveBoardMemberUserIds,
};
