/**
 * ------------------------------------------------------------------
 * File: masterDataKeys.js
 * Module: Src Common Constants
 *
 * Purpose:
 * Backend utility/module providing helper functions for masterDataKeys.
 *
 * Used By:
 * associationTypeHelper, seedAssociationTypes, auth.routes
 * ------------------------------------------------------------------
 */

/**
 * Masterdata keys used across signup, validation, payments, and public APIs.
 *
 * Frontend mirror: PropMv-UI/src/shared/constants/masterDataKeys.ts
 * These strings are sent as repeated `keys` query params to GET /api/v1/master/keys.
 * They are CASE-SENSITIVE - keep both files in sync.
 */
const MASTER_DATA_KEYS = {
  HOA_ASSOCIATION_TYPES: 'HOA_Association_Types',

  /** Electronic owner/tenant pay rails (card, echeck, …). */
  PAYMENT_METHODS: 'Payment_Methods',
  /** Manual board-recorded methods (cash, check, money order, …). */
  MANUAL_PAYMENT_METHODS: 'Manual_Payment_Methods',
  PAYMENT_STATUSES: 'Payment_Statuses',
  ACCOUNT_TYPES: 'Account_Types',
  CARD_TYPES: 'Card_Types',
};

module.exports = { MASTER_DATA_KEYS };
