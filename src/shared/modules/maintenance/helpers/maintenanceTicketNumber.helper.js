/**
 * ------------------------------------------------------------------
 * File: maintenanceTicketNumber.helper.js
 * Module: Maintenance Module
 *
 * Purpose:
 * Backend utility/module providing helper functions for maintenanceTicketNumber.helper.
 *
 * Used By:
 * backfill-maintenance-ticket-numbers, maintenanceEmailHelper, maintenanceRequest.model, maintenance.service
 * ------------------------------------------------------------------
 */

const SHORT_MAINTENANCE_TICKET_NUMBER_PATTERN = /^MNT\d{6}$/;

/**
 * make Maintenance Ticket Number
 *
 * Performs logic operations for makeMaintenanceTicketNumber.
 *
 * @returns Operations result
 */
function makeMaintenanceTicketNumber() {
  return `MNT${Math.floor(100000 + Math.random() * 900000)}`;
}

/**
 * is Short Maintenance Ticket Number
 *
 * Performs logic operations for isShortMaintenanceTicketNumber.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function isShortMaintenanceTicketNumber(value) {
  return typeof value === 'string' && SHORT_MAINTENANCE_TICKET_NUMBER_PATTERN.test(value.trim());
}

/**
 * Human-readable ticket number for emails and UI (falls back to legacy id suffix).
 */
function resolveMaintenanceTicketNumber(doc) {
  if (!doc) return null;
  if (doc.ticketNumber && isShortMaintenanceTicketNumber(doc.ticketNumber)) {
    return doc.ticketNumber.trim();
  }
  if (doc._id) {
    return String(doc._id);
  }
  return null;
}

async function allocateUniqueMaintenanceTicketNumber(options = {}) {
  const MaintenanceRequest = require('../model/maintenanceRequest.model');
  const { session } = options;
  const assigned = new Set();
  let attempts = 0;

  while (attempts < 20) {
    attempts += 1;
    let candidate = makeMaintenanceTicketNumber();
    let guard = 0;
    while (assigned.has(candidate) && guard < 20) {
      candidate = makeMaintenanceTicketNumber();
      guard += 1;
    }

    let query = MaintenanceRequest.findOne({
      ticketNumber: candidate,
      isDeleted: { $ne: true },
    }).select('_id').lean();
    if (session) query = query.session(session);
    const exists = await query;
    if (!exists) return candidate;
    assigned.add(candidate);
  }

  throw new Error('Failed to generate unique maintenance ticket number');
}

module.exports = {
  makeMaintenanceTicketNumber,
  isShortMaintenanceTicketNumber,
  resolveMaintenanceTicketNumber,
  allocateUniqueMaintenanceTicketNumber,
};
