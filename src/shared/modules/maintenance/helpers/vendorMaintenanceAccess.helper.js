'use strict';

/**
 * Vendor ticket mutations that are allowed. Everything else is denied.
 * Status: vendors may only mark tickets Completed (via PUT or resolve route).
 * Notes go through POST /request/:id/notes.
 * Comments go through POST /request/:id/comments and are limited to assigned tickets.
 * Attachments: assigned vendors may upload via POST /request/:id/documents
 * (used when attaching files to notes/comments). Document delete remains board/owner only.
 */
const VENDOR_ALLOWED_MAINTENANCE_ACTIONS = new Set([
  'view',
  'add_note',
  'update_note',
  'delete_note',
  'add_comment',
  'upload_document',
  'update_status',
  'resolve',
]);

function isVendorMaintenanceActionAllowed(action) {
  return VENDOR_ALLOWED_MAINTENANCE_ACTIONS.has(String(action || ''));
}

function vendorMaintenanceDeniedError() {
  const err = new Error(
    'Vendors may only mark tickets as Completed, manage their own notes, and upload attachments on assigned tickets'
  );
  err.status = 403;
  return err;
}

/**
 * Sync role name for maintenance authz.
 * Prefer auth middleware's resolved company role, then JWT / user.role claim.
 * Never call async resolveUserRoleName here - an un-awaited Promise was treated as a
 * non-vendor role and allowed vendors to reassign tickets.
 */
function resolveMaintenanceActorRoleName(req = {}) {
  if (req.userRoleName) return String(req.userRoleName);
  const role = req.user && req.user.role;
  if (typeof role === 'string' && role.trim()) return role.trim();
  if (role && typeof role === 'object' && role.name) return String(role.name);
  return '';
}

function normalizeMaintenanceStatusValue(status) {
  return String(status || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/** Vendors may only transition ticket status to Completed. */
function isVendorAllowedMaintenanceStatus(status) {
  return normalizeMaintenanceStatusValue(status) === 'completed';
}

module.exports = {
  VENDOR_ALLOWED_MAINTENANCE_ACTIONS,
  isVendorMaintenanceActionAllowed,
  vendorMaintenanceDeniedError,
  resolveMaintenanceActorRoleName,
  normalizeMaintenanceStatusValue,
  isVendorAllowedMaintenanceStatus,
};
