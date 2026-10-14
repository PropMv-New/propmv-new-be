/**
 * ------------------------------------------------------------------
 * File: emailStatus.js
 * Module: Src Common Constants
 *
 * Purpose:
 * Backend utility/module providing helper functions for emailStatus.
 *
 * Used By:
 * email.controller, email.model, email.service
 * ------------------------------------------------------------------
 */

/**
 * Email Status Constants
 * Centralized email status definitions used across the application
 */

const EMAIL_STATUS = {
  DRAFT: 'draft',
  SENDING: 'sending',
  SENT: 'sent',
  FAILED: 'failed',
  DELETED: 'deleted',
};

// Array of all valid email statuses
const ALL_EMAIL_STATUSES = Object.values(EMAIL_STATUS);

// Array of statuses that can be deleted/discarded
const DELETABLE_STATUSES = [
  EMAIL_STATUS.DRAFT,
  EMAIL_STATUS.SENDING,
  EMAIL_STATUS.FAILED,
  EMAIL_STATUS.SENT,
];

// Array of statuses that should be displayed in the UI
const DISPLAYABLE_STATUSES = [
  EMAIL_STATUS.DRAFT,
  EMAIL_STATUS.FAILED,
  EMAIL_STATUS.SENT,
];

module.exports = {
  EMAIL_STATUS,
  ALL_EMAIL_STATUSES,
  DELETABLE_STATUSES,
  DISPLAYABLE_STATUSES,
};
