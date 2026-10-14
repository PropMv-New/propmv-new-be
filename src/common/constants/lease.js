/**
 * ------------------------------------------------------------------
 * File: lease.js
 * Module: Src Common Constants
 *
 * Purpose:
 * Backend utility/module providing helper functions for lease.
 *
 * Used By:
 * contacts.service, invoice.controller, invoice.service, lease.model
 * ------------------------------------------------------------------
 */

// Lease-related constants

const LEASE_STATUSES = {
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved',
  ACTIVE: 'Active',
  EXPIRED: 'Expired',
  TERMINATED: 'Terminated',
  REJECTED: 'Rejected',
};

// Lease types (avoid hardcoded strings scattered through the code)
const LEASE_TYPES = {
  FIXED_TERM: 'FixedTerm',
  MONTH_TO_MONTH: 'MonthToMonth',
};

// Frequency types for rent payments
const FREQUENCY_TYPES = {
  MONTHLY: 'monthly',
  BI_MONTHLY: 'bi-monthly',
  WEEKLY: 'weekly',
  BI_WEEKLY: 'bi-weekly',
  SEMI_ANNUALLY: 'semi-annually',
  CUSTOM: 'custom',
};

// Weekday constants (0-6, Sunday-Saturday)
const WEEKDAYS = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};

// Weekday names for display
const WEEKDAY_NAMES = {
  0: 'Sunday',
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
};

module.exports = {
  LEASE_STATUSES,
  LEASE_TYPES,
  FREQUENCY_TYPES,
  WEEKDAYS,
  WEEKDAY_NAMES,
};
