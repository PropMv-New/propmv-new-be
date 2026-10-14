/**
 * ------------------------------------------------------------------
 * File: hoaBoardRole.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for hoaBoardRole.
 *
 * Used By:
 * contacts.service, hoaDataIsolation, hoaOwnerPropertyAccess, requireRole
 * ------------------------------------------------------------------
 */

/**
 * Normalizes role display names from DB (e.g. "HOA Board Member") vs legacy slugs ("hoa_board").
 */
function isHOABoardMemberRole(role) {
  if (!role) return false;
  const name = typeof role === 'object' && role !== null && role.name ? String(role.name) : String(role);
  const n = name.toLowerCase().replace(/\s+/g, ' ').trim();
  return n === 'hoa board member' || n === 'hoa_board' || n === 'hoa board';
}

module.exports = { isHOABoardMemberRole };
