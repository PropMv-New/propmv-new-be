/**
 * ------------------------------------------------------------------
 * File: income.messages.js
 * Module: Income Module
 *
 * Purpose:
 * Backend utility/module providing helper functions for income.messages.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * Income Module - User-Friendly Error Messages
 * 
 * This file contains all error messages for the Income module.
 * Messages are designed to be easily understood by end users.
 */

module.exports = {
  // Income Basic Errors
  PROPERTY_ID_REQUIRED: 'Please select the property for this income record',
  PROPERTY_ID_INVALID: 'The property ID format is invalid',
  UNIT_REQUIRED: 'Please select the unit for this income record',
  INCOME_TYPE_REQUIRED: 'Please select an income type (Rent, Late Fee, Utility Reimbursement, etc.)',
  AMOUNT_REQUIRED: 'Please enter the income amount',
  AMOUNT_INVALID: 'Income amount must be a positive number (e.g., 1500.00)',
  DATE_REQUIRED: 'Please enter the date when this income was received',
  DESCRIPTION_REQUIRED: 'Please enter a description for this income',
  
  // Payer Errors
  PAYER_NAME_REQUIRED: 'Please enter the name of the person or entity who paid',
  
  // Query Errors
  INCOME_ID_REQUIRED: 'Income ID is required to complete this action',
  INCOME_ID_INVALID: 'The income ID format is invalid',
  LANDLORD_ID_INVALID: 'The landlord ID format is invalid',
  PAGE_NUMBER_INVALID: 'Page number must be 1 or greater',
  PAGE_SIZE_INVALID: 'Page size must be 1 or greater',
  
  // Date Range Errors
  DATE_RANGE_INVALID: 'Both start date and end date are required when filtering by date range',
  
  // Amount Range Errors
  MIN_AMOUNT_INVALID: 'Minimum amount must be a positive number',
  MAX_AMOUNT_INVALID: 'Maximum amount must be a positive number',
  AMOUNT_RANGE_INVALID: 'Minimum amount cannot be greater than maximum amount',
  
  // Update Errors
  UPDATE_DATA_REQUIRED: 'Please provide at least one field to update',
  
  // Not Found Errors
  INCOME_NOT_FOUND: 'The income record you are looking for could not be found',
  
  // General Errors
  EXPORT_FORMAT_INVALID: 'Export format must be one of: CSV, Excel (XLSX), or JSON',
};
