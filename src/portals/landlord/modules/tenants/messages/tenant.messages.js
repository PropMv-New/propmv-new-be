/**
 * ------------------------------------------------------------------
 * File: tenant.messages.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for tenant.messages.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * Tenant Module - User-Friendly Error Messages
 * 
 * This file contains all error messages for the Tenant module.
 * Messages are designed to be easily understood by end users.
 */

/**
 * Tenant validation and error messages.
 * These are user-facing UI strings only - not credentials or secrets.
 */
module.exports = {
  // Required Field Errors
  EMAIL_REQUIRED: 'Please enter the tenant email address',
  EMAIL_INVALID: 'Please enter a valid email address (e.g., user@domain.com)',
  PASSWORD_REQUIRED: 'Please enter a login password for the tenant account',
  PHONE_REQUIRED: 'Please enter the tenant phone number',
  PHONE_INVALID: 'Please enter a valid phone number (e.g., 234-567-8900 or (234) 567-8900)',
  FIRST_NAME_REQUIRED: 'Please enter the tenant first name',
  LAST_NAME_REQUIRED: 'Please enter the tenant last name',
  ADDRESS_REQUIRED: 'Please enter the tenant address',
  STATE_REQUIRED: 'Please enter the tenant state',
  ZIP_CODE_REQUIRED: 'Please enter the tenant ZIP code',
  ZIP_CODE_INVALID: 'Please enter a valid ZIP code (e.g., 12345 or 12345-6789)',
  LANDLORD_ID_REQUIRED: 'Landlord information is required to create a tenant',
  LANDLORD_ID_INVALID: 'The landlord ID format is invalid',

  // Tenant Setup Errors
  TENANTS_REQUIRED: 'Please add at least one tenant to the lease',
  TENANT_KEY_REQUIRED: 'Tenant key is required for identification',
  LEASE_REQUIRED: 'Lease information is required to set up the tenant',
  PROPERTY_ID_REQUIRED: 'Please select a property for this lease',
  PROPERTY_ID_INVALID: 'The property ID format is invalid',
  LEASE_TERM_REQUIRED: 'Please enter the lease term (e.g., 12 months)',
  LEASE_TYPE_REQUIRED: 'Please select a lease type (Fixed Term or Month-to-Month)',
  START_DATE_REQUIRED: 'Please enter the lease start date',
  END_DATE_REQUIRED: 'Please enter the lease end date for fixed-term leases',
  SWITCH_MONTH_TO_MONTH_REQUIRED: 'Please specify if the lease should switch to month-to-month after the fixed term ends',

  // Rent Details Errors
  RENT_DETAILS_REQUIRED: 'Please provide rent payment details',
  RENT_FREQUENCY_REQUIRED: 'Please select how often rent is paid (Monthly, Weekly, etc.)',
  RENT_AMOUNT_REQUIRED: 'Please enter the monthly rent amount',
  RENT_AMOUNT_INVALID: 'Rent amount must be a positive number (e.g., 1500.00)',
  FIRST_RENTAL_INVOICE_DUE_REQUIRED: 'Please enter the date when the first rent payment is due',

  // Deposit Details Errors
  DEPOSIT_AMOUNT_INVALID: 'Security deposit amount must be a positive number',
  DEPOSIT_DUE_REQUIRED: 'Please enter when the security deposit is due',
  DEPOSIT_COLLECTED_REQUIRED: 'Please specify if the security deposit has already been collected',

  // Additional Fees Errors
  FEE_NAME_REQUIRED: 'Please enter a name for this fee (e.g., Pet Fee, Parking Fee)',
  FEE_DESCRIPTION_REQUIRED: 'Please enter a description for this fee',
  FEE_QUANTITY_REQUIRED: 'Please enter the quantity for this fee',
  FEE_QUANTITY_INVALID: 'Fee quantity must be a positive number',
  FEE_RATE_REQUIRED: 'Please enter the rate for this fee',
  FEE_RATE_INVALID: 'Fee rate must be a positive number',
  FEE_AMOUNT_REQUIRED: 'Please enter the total amount for this fee',
  FEE_AMOUNT_INVALID: 'Fee amount must be a positive number',

  // Rent Distribution Errors
  RENT_DISTRIBUTION_REQUIRED: 'Please specify how rent and deposit will be split among tenants',
  ALL_TENANTS_RESPONSIBLE_REQUIRED: 'Please specify if all tenants are equally responsible for rent',
  PARTIAL_PAYMENT_ALLOWED_REQUIRED: 'Please specify if tenants can make partial rent payments',
  RENT_DISTRIBUTION_TYPE_REQUIRED: 'Please select how rent should be distributed (Equal, Percentage, or Custom)',
  DEPOSIT_DISTRIBUTION_TYPE_REQUIRED: 'Please select how the security deposit should be distributed',
  SPLIT_REQUIRED: 'Please provide payment split details for at least one tenant',
  SPLIT_KEY_REQUIRED: 'Split key is required for tenant identification',
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
  TENANT_ID_REQUIRED: 'Tenant ID is required to complete this action',
  TENANT_ID_INVALID: 'The tenant ID format is invalid',
  PAGE_NUMBER_INVALID: 'Page number must be 1 or greater',
  PAGE_SIZE_INVALID: 'Page size must be 1 or greater',

  // Resend Invite Errors
  RESEND_PROPERTY_ID_REQUIRED: 'Property ID is required to resend the tenant invitation',
  RESEND_TENANT_ID_REQUIRED: 'Tenant ID is required to resend the invitation',

  // Not Found Errors
  TENANT_NOT_FOUND: 'The tenant you are looking for could not be found',

  // General Errors
  UPDATE_DATA_REQUIRED: 'Please provide at least one field to update',
  LEASE_ID_REQUIRED: 'Lease ID is required to update tenant information',
};
