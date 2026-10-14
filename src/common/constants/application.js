/**
 * ------------------------------------------------------------------
 * File: application.js
 * Module: Src Common Constants
 *
 * Purpose:
 * Backend utility/module providing helper functions for application.
 *
 * Used By:
 * application.model, application.service
 * ------------------------------------------------------------------
 */

const APPLICATION_STATUS = {
  SUBMITTED: 'submitted',
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  LEASE_CREATED: 'lease_created',
};

const BACKGROUND_CHECK_STATUS = {
  PENDING: 'pending',
  CLEAR: 'clear',
  ISSUES_FOUND: 'issues_found',
  FAILED: 'failed',
};

const INCOME_VERIFICATION_STATUS = {
  PENDING: 'pending',
  VERIFIED: 'verified',
  UNVERIFIED: 'unverified',
  INSUFFICIENT: 'insufficient',
};

const EVICTION_REPORT_STATUS = {
  PENDING: 'pending',
  NO_RECORDS: 'no_records',
  RECORDS_FOUND: 'records_found',
};

module.exports = {
  APPLICATION_STATUS,
  BACKGROUND_CHECK_STATUS,
  INCOME_VERIFICATION_STATUS,
  EVICTION_REPORT_STATUS,
};
