/**
 * ------------------------------------------------------------------
 * File: property.js
 * Module: Src Common Constants
 *
 * Purpose:
 * Backend utility/module providing helper functions for property.
 *
 * Used By:
 * dashboard.service, property.service, maintenanceRequest.model, maintenance.service
 * ------------------------------------------------------------------
 */

// Common constants for property module
const PROPERTY_DEFAULTS = {
  PAGE: 1,
  LIMIT: 10,
  SORT_BY: 'created_at',
  ORDER: 'asc',
  LEASE_EXPIRING_DAYS: 30,
};

const PROPERTY_STATUS = {
  OCCUPIED: 'Occupied',
  VACANT: 'Vacant',
};

// Individual maintenance status constants (preferred) + grouped arrays for compatibility
const MAINTENANCE_STATUS = {
  SUBMITTED: 'Submitted',
  INPROGRESS: 'InProgress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  // grouped lists kept for backward compatibility; use individual constants where possible
  OPEN: ['Submitted', 'InProgress'],
  CLOSED: ['Completed'],
};

const MAINTENANCE_REQUEST_STATUS = {
  OPEN: 'Open',
  IN_PROGRESS: 'InProgress',
  RESOLVED: 'Resolved',
  COMPLETED: 'Completed',
  /** Legacy only - new rejections are blocked; kept so existing tickets still load. */
  REJECTED: 'Rejected',
};

const RENT_STATUS = {
  OVERDUE: 'overdue',
  ON_TIME: 'on time',
};

/** Portal that created the property - used to keep HOA, Landlord, and Property Manager inventories isolated. */
const PROPERTY_SOURCE_PORTAL = {
  HOA: 'hoa',
  LANDLORD: 'landlord',
  PROPERTY_MANAGER: 'property-manager',
};

module.exports = {
  PROPERTY_DEFAULTS,
  PROPERTY_STATUS,
  MAINTENANCE_STATUS,
  MAINTENANCE_REQUEST_STATUS,
  RENT_STATUS,
  PROPERTY_SOURCE_PORTAL,
};
