/**
 * ------------------------------------------------------------------
 * File: tenant.js
 * Module: Src Common Constants
 *
 * Purpose:
 * Backend utility/module providing helper functions for tenant.
 *
 * Used By:
 * tenant.service, tenant.validator
 * ------------------------------------------------------------------
 */

// Tenant-related constants

const TENANT_STATUSES = {
  ACTIVE: 'Active',
  FUTURE: 'Future', 
  PAST: 'Past',
  ARCHIVED: 'Archived'
};

module.exports = {
  TENANT_STATUSES
};