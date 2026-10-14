/**
 * ------------------------------------------------------------------
 * File: roleNames.js
 * Module: Src Common Constants
 *
 * Purpose:
 * Backend utility/module providing helper functions for roleNames.
 *
 * Used By:
 * create-default-propmv-company, hoaOwnerRole, hoaTenantRole, billingSettings.routes
 * ------------------------------------------------------------------
 */

/**
 * Role Name Constants
 * 
 * IMPORTANT: These constants should match the role names in the database.
 * Use these constants instead of hardcoding role names throughout the application.
 */

const ROLE_NAMES = {
  LANDLORD: 'Landlord',
  TENANT: 'Tenant',
  PROPERTY_MANAGER: 'Property Manager',
  HOA_BOARD_MEMBER: 'HOA Board Member',
  HOA_OWNER: 'HOA Owner',
  VENDOR: 'Vendor',
  HOMEOWNER: 'Homeowner',
  ADMIN: 'Admin',
  SUPER_ADMIN: 'Super Admin',
};

module.exports = {
  ROLE_NAMES,
};
