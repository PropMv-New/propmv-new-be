/**
 * ------------------------------------------------------------------
 * File: lease.messages.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for lease.messages.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * Leasing Module - User-Friendly Error Messages
 * 
 * This file contains all error messages for the Leasing module.
 * Messages are designed to be easily understood by end users.
 */

module.exports = {
  // Lease Basic Errors
  PROPERTY_ID_REQUIRED: 'Please select the property for this lease',
  PROPERTY_ID_INVALID: 'The property ID format is invalid',
  LEASE_TERM_REQUIRED: 'Please enter the lease term (e.g., 12 months, 1 year)',
  LEASE_TYPE_REQUIRED: 'Please select a lease type (Fixed Term or Month-to-Month)',
  START_DATE_REQUIRED: 'Please enter when the lease starts',
  END_DATE_REQUIRED: 'Please enter when the lease ends (required for fixed-term leases)',
  SWITCH_MONTH_TO_MONTH_REQUIRED: 'Please specify if the lease should automatically switch to month-to-month after the fixed term ends',
  
  // Rent Details Errors
  RENT_DETAILS_REQUIRED: 'Please provide rent payment details',
  RENT_AMOUNT_REQUIRED: 'Please enter the monthly rent amount',
  RENT_AMOUNT_INVALID: 'Rent amount must be a positive number (e.g., 1500.00)',
  FIRST_RENTAL_INVOICE_DUE_REQUIRED: 'Please enter the date when the first rent payment is due',
  
  // Deposit Details Errors
  DEPOSIT_AMOUNT_INVALID: 'Security deposit amount must be a positive number (e.g., 1500.00)',
  DEPOSIT_DUE_REQUIRED: 'Please enter when the security deposit payment is due',
  DEPOSIT_COLLECTED_REQUIRED: 'Please specify if the security deposit has already been collected',
  
  // Additional Fees Errors
  FEE_NAME_REQUIRED: 'Please enter a name for this fee (e.g., Pet Fee, Parking Fee, Cleaning Fee)',
  FEE_DESCRIPTION_REQUIRED: 'Please enter a description for this fee',
  FEE_QUANTITY_REQUIRED: 'Please enter the quantity for this fee',
  FEE_QUANTITY_INVALID: 'Fee quantity must be a positive number',
  FEE_RATE_REQUIRED: 'Please enter the rate (price per unit) for this fee',
  FEE_RATE_INVALID: 'Fee rate must be a positive number',
  FEE_AMOUNT_REQUIRED: 'Please enter the total amount for this fee',
  FEE_AMOUNT_INVALID: 'Fee amount must be a positive number',
  TOTAL_AMOUNT_REQUIRED: 'Please enter the total amount for all fees',
  TOTAL_AMOUNT_INVALID: 'Total amount must be a positive number',
  ALREADY_PAID_REQUIRED: 'Please enter the amount already paid (enter 0 if nothing has been paid)',
  ALREADY_PAID_INVALID: 'Amount already paid must be a positive number or zero',
  BALANCE_AMOUNT_REQUIRED: 'Please enter the remaining balance amount',
  BALANCE_AMOUNT_INVALID: 'Balance amount must be a positive number or zero',
  RECURRING_INVOICE_REQUIRED: 'Please specify if this fee should be charged on a recurring basis',
  LINE_ITEM_ON_RENTAL_REQUIRED: 'Please specify if this fee should appear as a line item on the rental invoice',
  FREQUENCY_REQUIRED: 'Please select how often this recurring fee should be charged (Monthly, Weekly, etc.)',
  
  // Rent Distribution Errors
  ALL_TENANTS_RESPONSIBLE_REQUIRED: 'Please specify if all tenants are equally responsible for the full rent amount',
  PARTIAL_PAYMENT_ALLOWED_REQUIRED: 'Please specify if tenants can make partial rent payments',
  RENT_DISTRIBUTION_TYPE_REQUIRED: 'Please select how rent should be split among tenants (Equal, Percentage, or Custom Amount)',
  DEPOSIT_DISTRIBUTION_TYPE_REQUIRED: 'Please select how the security deposit should be split among tenants',
  SPLIT_REQUIRED: 'Please provide payment split details for at least one tenant',
  TENANT_ID_REQUIRED: 'Tenant ID is required in the payment split details',
  TENANT_ID_INVALID: 'The tenant ID format is invalid',
  RENT_AMOUNT_SPLIT_REQUIRED: 'Please enter the rent amount for this tenant',
  RENT_AMOUNT_SPLIT_INVALID: 'Tenant rent amount must be a positive number',
  RENT_PERCENTAGE_REQUIRED: 'Please enter the rent percentage for this tenant',
  RENT_PERCENTAGE_INVALID: 'Rent percentage must be between 0 and 100',
  DEPOSIT_AMOUNT_SPLIT_REQUIRED: 'Please enter the deposit amount for this tenant',
  DEPOSIT_AMOUNT_SPLIT_INVALID: 'Tenant deposit amount must be a positive number',
  DEPOSIT_PERCENTAGE_REQUIRED: 'Please enter the deposit percentage for this tenant',
  DEPOSIT_PERCENTAGE_INVALID: 'Deposit percentage must be between 0 and 100',
  
  // Document Errors
  DOCUMENT_METADATA_ID_REQUIRED: 'Document ID is required',
  DOCUMENT_METADATA_ID_INVALID: 'The document ID format is invalid',
  
  // Query Errors
  LEASE_ID_REQUIRED: 'Lease ID is required to complete this action',
  LEASE_ID_INVALID: 'The lease ID format is invalid',
  LANDLORD_ID_REQUIRED: 'Landlord ID is required to complete this action',
  LANDLORD_ID_INVALID: 'The landlord ID format is invalid',
  PAGE_NUMBER_INVALID: 'Page number must be 1 or greater',
  PAGE_SIZE_INVALID: 'Page size must be 1 or greater',
  
  // Renew Lease Errors
  RENEW_TYPE_REQUIRED: 'Please select a renewal type (Renew and Extend or Renew with New Lease)',
  RENEW_TYPE_INVALID: 'Renewal type must be either "Renew And Extend" or "Renew With New Lease"',
  
  // Not Found Errors
  LEASE_NOT_FOUND: 'The lease you are looking for could not be found',
  
  // General Errors
  EXPORT_FORMAT_INVALID: 'Export format must be one of: CSV, Excel (XLSX), or JSON',
};
