/**
 * ------------------------------------------------------------------
 * File: portalOnboarding.js
 * Module: Src Common Constants
 *
 * Purpose:
 * Backend utility/module providing helper functions for portalOnboarding.
 *
 * Used By:
 * owner.service, application.service, leaseAutoApproval.service, tenant.service
 * ------------------------------------------------------------------
 */

/**
 * Portal invitation / verification lifecycle for invited Tenant and HOA Owner accounts.
 * null/undefined on user = not in this flow (legacy or password provided at creation).
 */
const PORTAL_ONBOARDING_STATUS = {
  INVITATION_SENT: 'invitation_sent',
  PENDING_VERIFICATION: 'pending_verification',
  ACTIVE: 'active',
};

const PORTAL_INVITATION_PORTAL = {
  LANDLORD_TENANT: 'landlord_tenant',
  HOA_OWNER: 'hoa_owner',
  VENDOR: 'vendor',
};

const PORTAL_INVITATION_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  EXPIRED: 'expired',
  SUPERSEDED: 'superseded',
  REVOKED: 'revoked',
};

module.exports = {
  PORTAL_ONBOARDING_STATUS,
  PORTAL_INVITATION_PORTAL,
  PORTAL_INVITATION_STATUS,
};
