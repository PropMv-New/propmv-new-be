/**
 * ------------------------------------------------------------------
 * File: invoiceId.helper.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for invoiceId.helper.
 *
 * Used By:
 * invoice.model
 * ------------------------------------------------------------------
 */

const crypto = require('crypto');

const INVOICE_NUMBER_PREFIX = 'INV';
/** INV + 32 hex chars from UUID v4 */
const INVOICE_NUMBER_PATTERN = /^INV[A-F0-9]{32}$/i;

/**
 * generate Landlord Invoice Number
 *
 * Performs logic operations for generateLandlordInvoiceNumber.
 *
 * @returns Operations result
 */
function generateLandlordInvoiceNumber() {
  return `${INVOICE_NUMBER_PREFIX}${crypto.randomUUID().replace(/-/g, '').toUpperCase()}`;
}

/**
 * is Landlord Invoice Number
 *
 * Performs logic operations for isLandlordInvoiceNumber.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function isLandlordInvoiceNumber(value) {
  return typeof value === 'string' && INVOICE_NUMBER_PATTERN.test(value.trim());
}

/**
 * Allocate a globally unique landlord invoice number (INV + UUID hex).
 * UUID v4 collision risk is negligible; rely on the unique index as the hard guarantee
 * instead of a findOne round-trip per invoice (critical for lease activation batches).
 */
async function allocateUniqueLandlordInvoiceNumber(_InvoiceModel, _options = {}) {
  return generateLandlordInvoiceNumber();
}

module.exports = {
  INVOICE_NUMBER_PREFIX,
  INVOICE_NUMBER_PATTERN,
  generateLandlordInvoiceNumber,
  isLandlordInvoiceNumber,
  allocateUniqueLandlordInvoiceNumber,
};
