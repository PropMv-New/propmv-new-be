/**
 * ------------------------------------------------------------------
 * File: user.js
 * Module: Src Common Constants
 *
 * Purpose:
 * Backend utility/module providing helper functions for user.
 *
 * Used By:
 * auth.service, owner.service, application.service, leaseAutoApproval.service
 * ------------------------------------------------------------------
 */

// src/common/constants/user.js

const USER_STATUSES = {
  ACTIVE: 'Active',
  PENDING: 'Pending',
  INACTIVE: 'Inactive',
  LOCKED: 'Locked',
};

module.exports = {
  USER_VERSION: process.env.USER_VERSION || null, // Set via env or CI/CD, not hardcoded
  USER_STATUSES,
};
