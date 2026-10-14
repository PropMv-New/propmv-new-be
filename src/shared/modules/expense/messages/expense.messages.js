/**
 * ------------------------------------------------------------------
 * File: expense.messages.js
 * Module: Expense Module
 *
 * Purpose:
 * Backend utility/module providing helper functions for expense.messages.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * Expense Module - User-Friendly Error Messages
 * 
 * This file contains all error messages for the Expense module.
 * Messages are designed to be easily understood by end users.
 */

module.exports = {
  // Expense Details Errors
  TAXABLE_ENTITY_REQUIRED: 'Please select the taxable entity for this expense',
  BANK_ACCOUNT_REQUIRED: 'Please select which bank account will be used for this expense',
  PROPERTY_REQUIRED: 'Please select the property associated with this expense',
  PROPERTY_ID_INVALID: 'The property ID format is invalid',
  UNIT_REQUIRED: 'Please select the unit associated with this expense',
  PAYEES_REQUIRED: 'Please add at least one payee (vendor or service provider)',
  
  // Payee Errors
  PAYEE_NAME_REQUIRED: 'Please enter the payee name (vendor or service provider)',
  PAYEE_NAME_MAX_LENGTH: 'Payee name cannot be longer than 200 characters',
  PAYEE_CONTACT_MAX_LENGTH: 'Contact information cannot be longer than 200 characters',
  PAYEE_PHONE_MAX_LENGTH: 'Phone number cannot be longer than 50 characters',
  PAYEE_EMAIL_INVALID: 'Please enter a valid email address for the payee',
  PAYEE_WEBSITE_INVALID: 'Please enter a valid website URL (e.g., https://example.com)',
  
  // Expense Item Errors
  EXPENSE_ITEMS_REQUIRED: 'Please add at least one expense item',
  EXPENSE_DATE_REQUIRED: 'Please enter the date when this expense occurred',
  EXPENSE_CATEGORY_REQUIRED: 'Please select a category for this expense (e.g., Maintenance, Utilities)',
  EXPENSE_CATEGORY_MAX_LENGTH: 'Category name cannot be longer than 100 characters',
  EXPENSE_DESCRIPTION_REQUIRED: 'Please enter a description of this expense',
  EXPENSE_DESCRIPTION_MAX_LENGTH: 'Description cannot be longer than 500 characters',
  EXPENSE_AMOUNT_REQUIRED: 'Please enter the expense amount',
  EXPENSE_AMOUNT_INVALID: 'Expense amount must be a positive number (e.g., 150.00)',
  
  // Date Errors
  EXPENSE_DATE_FIELD_REQUIRED: 'Please enter the expense date',
  DUE_DATE_REQUIRED: 'Please enter when this expense payment is due',
  PAYMENT_DATE_INVALID: 'Please enter a valid payment date',
  START_DATE_REQUIRED: 'Please enter a start date for the date range filter',
  END_DATE_REQUIRED: 'Please enter an end date for the date range filter',
  DATE_RANGE_INVALID: 'Both start date and end date are required when filtering by date range',
  DUE_DATE_RANGE_INVALID: 'Both due start date and due end date are required when filtering by due date',
  PAYMENT_DATE_RANGE_INVALID: 'Both payment start date and payment end date are required when filtering by payment date',
  
  // Amount Errors
  MIN_AMOUNT_INVALID: 'Minimum amount must be a positive number',
  MAX_AMOUNT_INVALID: 'Maximum amount must be a positive number',
  AMOUNT_RANGE_INVALID: 'Minimum amount cannot be greater than maximum amount',
  
  // Status Errors
  STATUS_INVALID: 'Status must be one of: Pending, Paid, Unpaid, or Overdue',
  
  // Document Errors
  DOCUMENT_METADATA_ID_INVALID: 'The document ID format is invalid',
  
  // Query Errors
  EXPENSE_ID_REQUIRED: 'Expense ID is required to complete this action',
  EXPENSE_ID_INVALID: 'The expense ID format is invalid',
  LANDLORD_ID_INVALID: 'The landlord ID format is invalid',
  PAGE_NUMBER_INVALID: 'Page number must be 1 or greater',
  PAGE_SIZE_INVALID: 'Page size must be between 1 and 100',
  
  // Update Errors
  UPDATE_DATA_REQUIRED: 'Please provide at least one field to update',
  
  // Not Found Errors
  EXPENSE_NOT_FOUND: 'The expense you are looking for could not be found',
  
  // General Errors
  EXPORT_FORMAT_INVALID: 'Export format must be one of: CSV, Excel (XLSX), or JSON',
};
