/**
 * ------------------------------------------------------------------
 * File: property.messages.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for property.messages.
 *
 * Used By:
 * property.controller, property.validator
 * ------------------------------------------------------------------
 */

/**
 * Property Module - User-Friendly Error Messages
 * 
 * This file contains all error messages for the Property module.
 * Messages are designed to be easily understood by end users.
 */

module.exports = {
  // Required Field Errors
  PROPERTY_NAME_REQUIRED: 'Please enter a property name',
  PROPERTY_TYPE_REQUIRED: 'Please select a property type',
  OWNERSHIP_TYPE_REQUIRED: 'Please select an ownership type',
  OWNER_NAME_REQUIRED: 'Please enter the owner name',
  OWNER_EMAIL_REQUIRED: 'Please enter the owner email address',
  OWNER_EMAIL_INVALID: 'Please enter a valid email address for the owner',
  OWNER_PHONE_REQUIRED: 'Please enter the owner phone number',
  OWNER_PHONE_INVALID: 'Please enter a valid phone number (e.g., +1-234-567-8900 or 234-567-8900)',
  OWNER_TYPE_REQUIRED: 'Please select an owner type',
  
  // Address Errors
  ADDRESS_REQUIRED: 'Please provide the property address',
  STREET_REQUIRED: 'Please enter the street address',
  CITY_REQUIRED: 'Please enter the city name',
  STATE_REQUIRED: 'Please enter the state',
  ZIP_REQUIRED: 'Please enter the ZIP code',
  COUNTRY_REQUIRED: 'Please enter the country',
  
  // Unit Details Errors
  UNIT_DETAILS_REQUIRED: 'Please add at least one unit to the property',
  UNIT_NAME_REQUIRED: 'Please enter a name for the unit',
  UNIT_TYPE_REQUIRED: 'Please select a unit type (e.g., Residential, Commercial)',
  SQUARE_FEET_REQUIRED: 'Please enter the square footage of the unit',
  BEDROOMS_REQUIRED: 'Please enter the number of bedrooms for this residential unit',
  BATHROOMS_REQUIRED: 'Please enter the number of bathrooms for this residential unit',
  AMENITIES_REQUIRED: 'Amenities are optional for this residential unit', // Amenities are now optional - this message should not be used
  
  // Bank Account Errors
  BANK_ACCOUNT_REQUIRED: 'Please provide bank account information for this property',
  ENTITY_TYPE_REQUIRED: 'Please select an entity type (Individual, LLC, Corporation, Partnership, or Trust)',
  FIRST_NAME_REQUIRED: 'Please enter the account holder first name',
  LAST_NAME_REQUIRED: 'Please enter the account holder last name',
  EMAIL_REQUIRED: 'Please enter the account holder email address',
  PHONE_REQUIRED: 'Please enter the account holder phone number',
  DOB_REQUIRED: 'Please enter the account holder date of birth',
  DOB_AGE_INVALID: 'Account holder must be at least 18 years old',
  SSN_REQUIRED: 'Please enter the Social Security Number',
  BUSINESS_NAME_REQUIRED: 'Please enter the business name',
  EIN_REQUIRED: 'Please enter the Employer Identification Number (EIN)',
  STATE_OF_FORMATION_REQUIRED: 'Please enter the state where the business was formed',
  BANK_NAME_REQUIRED: 'Please enter the name of the bank',
  ACCOUNT_TYPE_REQUIRED: 'Please select an account type (Checking or Savings)',
  ROUTING_NUMBER_REQUIRED: 'Please enter the bank routing number',
  ACCOUNT_NUMBER_REQUIRED: 'Please enter the bank account number',
  BANK_ADDRESS_REQUIRED: 'Please provide the bank address',
  
  // Joint Ownership Errors
  JOINT_OWNER_NAME_REQUIRED: 'Please enter the joint owner full name',
  JOINT_OWNER_EMAIL_REQUIRED: 'Please enter the joint owner email address',
  JOINT_OWNER_EMAIL_INVALID: 'Please enter a valid email address for the joint owner',
  JOINT_OWNER_PHONE_REQUIRED: 'Please enter the joint owner phone number',
  JOINT_OWNER_PHONE_INVALID: 'Please enter a valid phone number for the joint owner (e.g., +1-234-567-8900)',
  OWNERSHIP_PERCENT_REQUIRED: 'Please enter the ownership percentage for this joint owner',
  OWNERSHIP_PERCENT_INVALID: 'Ownership percentage must be between 0 and 100',
  ROLE_REQUIRED: 'Please select a role for this joint owner (Primary or Secondary)',
  ROLE_INVALID: 'Role must be either Primary or Secondary',
  PAYOUT_PERCENT_REQUIRED: 'Please enter the payout percentage for this joint owner',
  PAYOUT_PERCENT_INVALID: 'Payout percentage must be between 0 and 100',
  TOTAL_OWNERSHIP_INVALID: 'The total ownership percentage of all joint owners must equal 100%',
  TOTAL_PAYOUT_INVALID: 'The total payout percentage of all joint owners must equal 100%',
  
  // Late Fee Errors
  LATE_FEE_TYPE_REQUIRED: 'Please select a late fee type',
  FEE_AMOUNT_REQUIRED: 'Please enter the late fee amount',
  FEE_AMOUNT_INVALID: 'Late fee amount must be a positive number',
  GRACE_PERIOD_REQUIRED: 'Please enter the grace period in days',
  GRACE_PERIOD_INVALID: 'Grace period must be a positive number',
  IS_REPEAT_REQUIRED: 'Please specify if the late fee should repeat',
  REPEAT_EVERY_REQUIRED: 'Please specify how often the late fee should repeat',
  REPEAT_END_AFTER_REQUIRED: 'Please specify when the late fee should stop repeating',
  APPLICABLE_UNITS_REQUIRED: 'Please select at least one unit where this late fee applies',
  CHARGE_EACH_TENANT_REQUIRED: 'Please specify if the late fee should be charged to each unpaid tenant',
  
  // ID and Query Errors
  PROPERTY_ID_REQUIRED: 'Property ID is required to complete this action',
  PROPERTY_ID_INVALID: 'The property ID format is invalid',
  
  // Pagination Errors
  PAGE_NUMBER_INVALID: 'Page number must be 1 or greater',
  PAGE_SIZE_INVALID: 'Page size must be 1 or greater',
  
  // Not Found Errors
  PROPERTY_NOT_FOUND: 'The property you are looking for could not be found',
  
  // File Upload Errors
  NO_FILES_UPLOADED: 'Please select at least one image file to upload',
  TOO_MANY_FILES: 'You can upload a maximum of 10 images at a time',
  INVALID_FILE_TYPE: 'Only image files (JPG, PNG, GIF) are allowed',
  FILE_TOO_LARGE: 'One or more files exceed the maximum size limit of 10MB',
  
  // Note Errors
  NOTE_DESCRIPTION_REQUIRED: 'Please enter a description for the note',
  TOO_MANY_ATTACHMENTS: 'You can attach a maximum of 10 files to a note',
  
  // General Errors
  PROPERTY_DATA_REQUIRED: 'Property information is required to complete this action',
  UPDATE_DATA_REQUIRED: 'Please provide at least one field to update',
  PROPERTY_SETTINGS_REQUIRED: 'Property settings are required',
};
