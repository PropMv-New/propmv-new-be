/**
 * ------------------------------------------------------------------
 * File: invoice.js
 * Module: Src Common Constants
 *
 * Purpose:
 * Backend utility/module providing helper functions for invoice.
 *
 * Used By:
 * invoiceLifecycleEmail.service, landlordInvoiceStatus.helper, dashboard.service, invoicePaymentReversal.helper
 * ------------------------------------------------------------------
 */

const INVOICE_TYPES = {
  RENT: 'Rent',
  DEPOSIT: 'Deposit',
  MISCELLANEOUS: 'Miscellaneous',
  OTHER: 'Other',
  LATE_FEE: 'Late Fee',
  /** Canonical HOA assessment / monthly dues - sole type for new HOA invoices */
  HOA_FEE: 'HOA Fee',
};

/** @deprecated Use INVOICE_TYPES.HOA_FEE */
INVOICE_TYPES.FEES = INVOICE_TYPES.HOA_FEE;

/** Stored on invoices created before HOA_FEE canonicalization */
const LEGACY_STORED_HOA_FEE_TYPE = 'Fees';

const INVOICE_STATUS = {
  PENDING: 'Pending',
  PAID: 'Paid',
  PARTIALLY_PAID: 'Partially Paid',
  OVERDUE: 'Overdue',
  /** Payment / settlement in progress (HOA flows; persisted on invoice when set) */
  PROCESSING: 'Processing',
  WAIVED: 'Waived',
};

const GROUP_BY = {
  PROPERTY: 'Property',
  TENANT: 'Tenant',
  NA: 'NA',
};

/**
 * HOA assessment types for queries (canonical + legacy DB values).
 * Rent included for very old HOA unit-schedule rows.
 */
const HOA_ASSESSMENT_INVOICE_TYPES = [
  INVOICE_TYPES.HOA_FEE,
  LEGACY_STORED_HOA_FEE_TYPE,
  INVOICE_TYPES.RENT,
];

const HOA_UNIT_SCHEDULE_INVOICE_TYPES = HOA_ASSESSMENT_INVOICE_TYPES;
const HOA_BOARD_FEE_INVOICE_TYPES = HOA_ASSESSMENT_INVOICE_TYPES;

/** Mongoose enum + API validation (canonical types + legacy stored value) */
const INVOICE_TYPE_ENUM_VALUES = [...new Set([...Object.values(INVOICE_TYPES), LEGACY_STORED_HOA_FEE_TYPE])];

const HOA_ASSESSMENT_TYPE_SET = new Set(HOA_ASSESSMENT_INVOICE_TYPES);

/**
 * is Hoa Assessment Invoice Type
 *
 * Performs logic operations for isHoaAssessmentInvoiceType.
 *
 * @param type - Request/input argument
 * @returns Operations result
 */
function isHoaAssessmentInvoiceType(type) {
  return HOA_ASSESSMENT_TYPE_SET.has(String(type || '').trim());
}

/** Normalize inbound / legacy HOA assessment types to the canonical stored value. */
function normalizeHoaInvoiceType(type) {
  const trimmed = String(type || '').trim();
  if (!trimmed || isHoaAssessmentInvoiceType(trimmed)) {
    return INVOICE_TYPES.HOA_FEE;
  }
  return trimmed;
}

/** Expand HOA Fee filter to match canonical and legacy stored types. */
function expandHoaFeeTypeFilter(invoiceType) {
  if (isHoaAssessmentInvoiceType(invoiceType)) {
    return { $in: HOA_ASSESSMENT_INVOICE_TYPES };
  }
  return invoiceType;
}

module.exports = {
  INVOICE_TYPES,
  INVOICE_STATUS,
  GROUP_BY,
  LEGACY_STORED_HOA_FEE_TYPE,
  HOA_ASSESSMENT_INVOICE_TYPES,
  HOA_UNIT_SCHEDULE_INVOICE_TYPES,
  HOA_BOARD_FEE_INVOICE_TYPES,
  INVOICE_TYPE_ENUM_VALUES,
  isHoaAssessmentInvoiceType,
  normalizeHoaInvoiceType,
  expandHoaFeeTypeFilter,
};
