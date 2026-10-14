/**
 * ------------------------------------------------------------------
 * File: dashboard.js
 * Module: Src Common Constants
 *
 * Purpose:
 * Backend utility/module providing helper functions for dashboard.
 *
 * Used By:
 * dashboard.service
 * ------------------------------------------------------------------
 */

// Dashboard-related constants

// Number of latest submitted leases to return in dashboard summary (configurable)
const LATEST_SUBMITTED_LEASES = 3;
// Number of latest maintenance requests to return in dashboard summary (configurable)
const LATEST_MAINTENANCE_REQUESTS = 3;
// Number of latest applications to return in dashboard summary (configurable)
const LATEST_APPLICATIONS = 3;

module.exports = {
  LATEST_SUBMITTED_LEASES,
  LATEST_MAINTENANCE_REQUESTS,
  LATEST_APPLICATIONS,
};
