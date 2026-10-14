/**
 * ------------------------------------------------------------------
 * File: policyTerm.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for policyTerm.
 *
 * Used By:
 * invoice.service, invoicePolicyTerm.service
 * ------------------------------------------------------------------
 */

/** Policy-term creates above this count run asynchronously with progress polling. */
const POLICY_TERM_ASYNC_THRESHOLD = 100;

/** Chunk size for bulk inserts during large async policy-term jobs. */
const POLICY_TERM_INSERT_BATCH_SIZE = 100;

module.exports = {
  POLICY_TERM_ASYNC_THRESHOLD,
  POLICY_TERM_INSERT_BATCH_SIZE,
};
