/**
 * ------------------------------------------------------------------
 * File: uploads.js
 * Module: Src Common Constants
 *
 * Purpose:
 * Backend utility/module providing helper functions for uploads.
 *
 * Used By:
 * mockS3, invoice.routes, lease.controller, lease.service
 * ------------------------------------------------------------------
 */

const path = require('path');
const config = require('../../config/default');

// Resolve base uploads dir
const UPLOAD_DIR_BASE = path.resolve(
  (config.uploads && config.uploads.base) || path.join(__dirname, '../../uploads')
);

// Per-type subdirectories - prefer config values, fall back to sensible defaults
const UPLOAD_PROPERTY_SUBDIR = (config.uploads && config.uploads.propertySubdir) || 'property-images';
const UPLOAD_TENANT_SUBDIR = (config.uploads && config.uploads.tenantSubdir) || 'tenant-documents';
const UPLOAD_PROFILE_SUBDIR = (config.uploads && config.uploads.profileSubdir) || 'profile-pictures';
const UPLOAD_MAINTENANCE_SUBDIR = (config.uploads && config.uploads.maintenanceSubdir) || 'maintenance-attachments';
const UPLOAD_LEASE_SUBDIR = (config.uploads && config.uploads.leaseSubdir) || 'lease-documents';
const UPLOAD_INVOICE_SUBDIR = (config.uploads && config.uploads.invoiceSubdir) || 'invoice-documents';

const UPLOAD_LISTING_SUBDIR = (config.uploads && config.uploads.listingSubdir) || 'listing-images';
const UPLOAD_MESSAGE_SUBDIR = (config.uploads && config.uploads.messageSubdir) || 'message-attachments';
const UPLOAD_EMAIL_SUBDIR = (config.uploads && config.uploads.emailSubdir) || 'email-attachments';

module.exports = {
  UPLOAD_DIR_BASE,
  UPLOAD_PROPERTY_SUBDIR,
  UPLOAD_TENANT_SUBDIR,
  UPLOAD_PROFILE_SUBDIR,
  UPLOAD_MAINTENANCE_SUBDIR,
  UPLOAD_LEASE_SUBDIR,
  UPLOAD_INVOICE_SUBDIR,
  UPLOAD_LISTING_SUBDIR,
  UPLOAD_MESSAGE_SUBDIR,
  UPLOAD_EMAIL_SUBDIR,
};
