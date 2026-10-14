/**
 * ------------------------------------------------------------------
 * File: company.js
 * Module: Src Common Constants
 *
 * Purpose:
 * Backend utility/module providing helper functions for company.
 *
 * Used By:
 * companyRoleHelper, tenant.service
 * ------------------------------------------------------------------
 */

/**
 * Company and Organization Constants
 * 
 * IMPORTANT: These constants should be used throughout the application
 * to avoid hardcoding company names. Update these values if company
 * name or branding changes.
 */

const COMPANY_NAME = 'PropMv';

const COMPANY_INFO = {
  NAME: COMPANY_NAME,
  FULL_NAME: 'PropMv Property Management',
  /** Used as CC on all system-generated outbound emails */
  SUPPORT_EMAIL: 'support@propmv.com',
  /** Used as the From address for all automated/system-generated emails */
  FROM_EMAIL: 'noreply@propmv.com',
};

module.exports = {
  COMPANY_NAME,
  COMPANY_INFO,
};
