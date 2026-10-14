/**
 * ------------------------------------------------------------------
 * File: maintenance.messages.js
 * Module: Maintenance Module
 *
 * Purpose:
 * Backend utility/module providing helper functions for maintenance.messages.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * Maintenance Module - User-Friendly Error Messages
 * 
 * This file contains all error messages for the Maintenance module.
 * Messages are designed to be easily understood by end users.
 */

module.exports = {
  // Request Basic Errors
  PROPERTY_ID_REQUIRED: 'Please select the property for this maintenance request',
  PROPERTY_ID_INVALID: 'The property ID format is invalid',
  UNITS_REQUIRED: 'Please select which unit needs maintenance',
  TITLE_REQUIRED: 'Please enter a title for this maintenance request (e.g., Leaking Faucet)',
  TITLE_MAX_LENGTH: 'Title cannot be longer than 150 characters',
  DESCRIPTION_REQUIRED: 'Please describe the maintenance issue in detail',
  CATEGORY_REQUIRED: 'Please select a category for this maintenance request',
  CATEGORY_INVALID: 'Category must be one of: Plumbing, Electrical, HVAC, Appliance, Structural, Pest Control, Landscaping, or Other',
  PRIORITY_REQUIRED: 'Please select the priority level (Low, Medium, High, or Emergency)',
  PRIORITY_INVALID: 'Priority must be one of: Low, Medium, High, or Emergency',
  IS_URGENT_REQUIRED: 'Please specify if this maintenance request is urgent',
  REQUESTED_BY_REQUIRED: 'Please specify who is requesting this maintenance',
  REQUESTED_BY_INVALID: 'The requester ID format is invalid',
  NOTIFY_TENANT_REQUIRED: 'Please specify if the tenant should be notified about this maintenance request',
  
  // Assignment Errors
  ASSIGNED_TO_INVALID: 'The assigned person ID format is invalid',
  
  // Date Errors
  COMPLETED_DATE_INVALID: 'Please enter a valid completion date',
  
  // Cost Errors
  ESTIMATED_COST_INVALID: 'Estimated cost must be a positive number (e.g., 150.00)',
  ACTUAL_COST_INVALID: 'Actual cost must be a positive number (e.g., 175.50)',
  
  // Status Errors
  STATUS_INVALID: 'The selected maintenance request status is not valid',
  
  // Comment Errors
  COMMENT_TEXT_REQUIRED: 'Please enter a comment or note',
  COMMENT_TEXT_MIN_LENGTH: 'Comment must be at least 1 character long',
  COMMENT_TEXT_MAX_LENGTH: 'Comment cannot be longer than 1000 characters',
  
  // File Upload Errors
  FILE_TYPE_INVALID: 'Only image files (JPG, JPEG, PNG) are allowed for maintenance requests',
  TOO_MANY_FILES: 'You can upload a maximum of 5 images per maintenance request',
  FILE_TOO_LARGE: 'One or more files exceed the maximum size limit of 50MB',
  
  // Query Errors
  REQUEST_ID_REQUIRED: 'Maintenance request ID is required to complete this action',
  REQUEST_ID_INVALID: 'The maintenance request ID format is invalid',
  LANDLORD_ID_INVALID: 'The landlord ID format is invalid',
  PAGE_NUMBER_INVALID: 'Page number must be 1 or greater',
  PAGE_SIZE_INVALID: 'Page size must be between 1 and 100',
  
  // Update Errors
  UPDATE_DATA_REQUIRED: 'Please provide at least one field to update',
  
  // Not Found Errors
  REQUEST_NOT_FOUND: 'The maintenance request you are looking for could not be found',
  
  // General Errors
  EXPORT_FORMAT_INVALID: 'Export format must be one of: CSV, Excel (XLSX), or JSON',
};


