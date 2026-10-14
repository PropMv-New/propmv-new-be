/**
 * ------------------------------------------------------------------
 * File: invoice.messages.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for invoice.messages.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * Invoice Module - User-Friendly Error Messages
 * 
 * This file contains all error messages for the Invoice module.
 * Messages are designed to be easily understood by end users.
 */

module.exports = {
  // Invoice Basic Errors
  INVOICE_TYPE_REQUIRED: 'Please select an invoice type (Rental, Utility, Late Fee, etc.)',
  INVOICE_TYPE_INVALID: 'The selected invoice type is not valid',
  PARTIAL_PAYMENT_REQUIRED: 'Please specify if tenants can make partial payments on this invoice',
  PROPERTY_ID_REQUIRED: 'Please select the property for this invoice',
  PROPERTY_ID_INVALID: 'The property ID format is invalid',
  UNIT_REQUIRED: 'Please select the unit for this invoice',
  TERM_REQUIRED: 'Please enter the billing term (e.g., January 2024)',
  TENANTS_REQUIRED: 'Please select at least one tenant for this invoice',
  TENANT_ID_INVALID: 'The tenant ID format is invalid',
  ALL_TENANTS_SELECTED_REQUIRED: 'Please specify if this invoice applies to all tenants in the unit',
  
  // Invoice Item Errors
  INVOICE_ITEMS_REQUIRED: 'Please add at least one item to this invoice',
  INVOICE_ITEM_NAME_REQUIRED: 'Please enter a name for this invoice item (e.g., Monthly Rent)',
  INVOICE_ITEM_DESCRIPTION_REQUIRED: 'Please enter a description for this invoice item',
  INVOICE_ITEM_QUANTITY_REQUIRED: 'Please enter the quantity for this item',
  INVOICE_ITEM_QUANTITY_INVALID: 'Quantity must be a positive number',
  INVOICE_ITEM_RATE_REQUIRED: 'Please enter the rate (price per unit) for this item',
  INVOICE_ITEM_RATE_INVALID: 'Rate must be a positive number',
  INVOICE_ITEM_AMOUNT_REQUIRED: 'Please enter the total amount for this item',
  INVOICE_ITEM_AMOUNT_INVALID: 'Amount must be a positive number',
  
  // Amount Errors
  SUB_AMOUNT_REQUIRED: 'Please enter the subtotal amount',
  SUB_AMOUNT_INVALID: 'Subtotal must be a positive number',
  ALREADY_PAID_REQUIRED: 'Please enter the amount already paid (enter 0 if nothing has been paid)',
  ALREADY_PAID_INVALID: 'Amount already paid must be a positive number or zero',
  BALANCE_DUE_REQUIRED: 'Please enter the balance due',
  BALANCE_DUE_INVALID: 'Balance due must be a positive number or zero',
  
  // Recurring Invoice Errors
  RECURRING_INVOICE_REQUIRED: 'Please specify if this is a recurring invoice',
  LINE_ITEM_ON_RENTAL_INVALID: 'Line item on rental invoice can only be enabled for recurring invoices',
  LINE_ITEM_REQUIRES_ALL_TENANTS: 'Line item on rental invoice requires all tenants in the unit to be selected',
  FREQUENCY_REQUIRED: 'Please select how often this invoice should recur (Monthly, Weekly, etc.)',
  DUE_ON_DATE_REQUIRED: 'Please enter which day of the month this recurring invoice is due (1-31)',
  DUE_ON_DATE_INVALID: 'Due date must be between 1 and 31',
  START_DATE_REQUIRED: 'Please enter when this recurring invoice should start',
  END_DATE_REQUIRED: 'Please enter when this recurring invoice should end',
  
  // Date Errors
  DUE_DATE_REQUIRED: 'Please enter when this invoice payment is due',
  DATE_RANGE_INVALID: 'Both start date and end date are required when filtering by date range',
  
  // Query Errors
  INVOICE_ID_REQUIRED: 'Invoice ID is required to complete this action',
  INVOICE_ID_INVALID: 'The invoice ID format is invalid',
  LANDLORD_ID_INVALID: 'The landlord ID format is invalid',
  LEASE_ID_INVALID: 'The lease ID format is invalid',
  PAGE_NUMBER_INVALID: 'Page number must be 1 or greater',
  PAGE_SIZE_INVALID: 'Page size must be 1 or greater',
  STATUS_INVALID: 'The selected invoice status is not valid',
  
  // Amount Range Errors
  MIN_AMOUNT_INVALID: 'Minimum amount must be a positive number',
  MAX_AMOUNT_INVALID: 'Maximum amount must be a positive number',
  AMOUNT_RANGE_INVALID: 'Minimum amount cannot be greater than maximum amount',
  
  // Comment Errors
  COMMENT_TEXT_REQUIRED: 'Please enter a comment',
  COMMENT_TEXT_MIN_LENGTH: 'Comment must be at least 1 character long',
  
  // Not Found Errors
  INVOICE_NOT_FOUND: 'The invoice you are looking for could not be found',
  
  // General Errors
  UPDATE_DATA_REQUIRED: 'Please provide at least one field to update',
  EXPORT_FORMAT_INVALID: 'Export format must be one of: CSV, Excel (XLSX), or JSON',
};
