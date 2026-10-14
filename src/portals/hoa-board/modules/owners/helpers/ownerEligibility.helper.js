const { PORTAL_ONBOARDING_STATUS } = require('../../../../../common/constants/portalOnboarding');
const { USER_STATUSES } = require('../../../../../common/constants/user');

const PROPERTY_ASSIGNMENT_ERROR =
  'This owner cannot be assigned to a property.';
const MAINTENANCE_REQUEST_ERROR =
  'A maintenance ticket cannot be created for an owner who is not verified and active.';

/**
 * Portal-verified owners completed invite onboarding. Legacy owners (null status)
 * created with a password at signup are treated as verified when not in the invite flow.
 */
function isOwnerPortalVerified(owner) {
  if (!owner) return false;
  const portalStatus = owner.portalOnboardingStatus;
  if (portalStatus === PORTAL_ONBOARDING_STATUS.ACTIVE) return true;
  if (portalStatus == null) return true;
  return false;
}

function isOwnerAccountActive(owner) {
  if (!owner) return false;
  if (owner.isDeleted === true || owner.isArchived === true) return false;
  return owner.status === USER_STATUSES.ACTIVE;
}

function isOwnerEligibleForInvoiceGeneration(owner) {
  return isOwnerPortalVerified(owner) && isOwnerAccountActive(owner);
}

/**
 * Board can associate owners to units regardless of verification or inactive status.
 * Archived, deleted, and locked accounts remain blocked.
 */
function isOwnerEligibleForAssignment(owner) {
  if (!owner) return false;
  if (owner.isDeleted === true || owner.isArchived === true) return false;
  if (owner.status === USER_STATUSES.LOCKED) return false;
  return true;
}

function isOwnerEligibleForMaintenanceRequest(owner) {
  return isOwnerPortalVerified(owner) && isOwnerAccountActive(owner);
}

function getOwnerAssignmentBlockReason(owner) {
  if (!owner) return 'Owner not found';
  if (owner.isArchived === true) return 'Owner is archived';
  if (owner.isDeleted === true) return 'Owner has been deleted';
  if (owner.status === USER_STATUSES.LOCKED) return 'Owner account is locked';
  return null;
}

function getOwnerInvoiceDeferralReason(owner) {
  if (!owner || isOwnerEligibleForInvoiceGeneration(owner)) return null;
  const portalStatus = owner.portalOnboardingStatus;
  if (portalStatus === PORTAL_ONBOARDING_STATUS.INVITATION_SENT) {
    return 'Invitation sent - invoices generate after the owner verifies their account';
  }
  if (portalStatus === PORTAL_ONBOARDING_STATUS.PENDING_VERIFICATION) {
    return 'Verification is pending - invoices generate after the owner verifies their account';
  }
  if (owner.status === USER_STATUSES.INACTIVE) {
    return 'Owner is inactive - invoices generate after the owner is verified and active';
  }
  return 'Invoices generate after this owner verifies their account';
}

function getOwnerIneligibilityReason(owner) {
  if (!owner) return 'Owner not found';
  if (owner.isArchived === true) return 'Owner is archived';
  if (owner.isDeleted === true) return 'Owner has been deleted';

  if (!isOwnerAccountActive(owner)) {
    if (owner.status === USER_STATUSES.INACTIVE) return 'Owner is inactive';
    if (owner.status === USER_STATUSES.LOCKED) return 'Owner account is locked';
    if (owner.status === USER_STATUSES.PENDING) return 'Owner account is pending';
    return 'Owner is not active';
  }

  const portalStatus = owner.portalOnboardingStatus;
  if (portalStatus === PORTAL_ONBOARDING_STATUS.INVITATION_SENT) {
    return 'Invitation sent - owner must verify their account first';
  }
  if (portalStatus === PORTAL_ONBOARDING_STATUS.PENDING_VERIFICATION) {
    return 'Verification is pending';
  }
  if (!isOwnerPortalVerified(owner)) {
    return 'Owner must be verified and active';
  }

  return null;
}

function shouldGenerateInvoicesForOwnerAssignment(owner, existingInvoiceCount = 0) {
  if (Number(existingInvoiceCount) > 0) return false;
  return isOwnerEligibleForInvoiceGeneration(owner);
}

function buildOwnerEligibilityFields(owner) {
  const eligible = isOwnerEligibleForAssignment(owner);
  const invoiceReady = isOwnerEligibleForInvoiceGeneration(owner);
  const maintenanceEligible = isOwnerEligibleForMaintenanceRequest(owner);
  return {
    isEligibleForAssignment: eligible,
    ineligibilityReason: eligible ? null : getOwnerAssignmentBlockReason(owner),
    isEligibleForMaintenance: maintenanceEligible,
    maintenanceIneligibilityReason: maintenanceEligible ? null : getOwnerIneligibilityReason(owner),
    invoiceGenerationDeferred: eligible && !invoiceReady,
    invoiceGenerationDeferredReason:
      eligible && !invoiceReady ? getOwnerInvoiceDeferralReason(owner) : null,
  };
}

function assertOwnerEligibleForPropertyAssignment(owner) {
  if (isOwnerEligibleForAssignment(owner)) return;
  const err = new Error(getOwnerAssignmentBlockReason(owner) || PROPERTY_ASSIGNMENT_ERROR);
  err.status = 400;
  err.details = getOwnerAssignmentBlockReason(owner);
  throw err;
}

function assertOwnerEligibleForMaintenanceRequest(owner) {
  if (isOwnerEligibleForMaintenanceRequest(owner)) return;
  const err = new Error(MAINTENANCE_REQUEST_ERROR);
  err.status = 400;
  err.details = getOwnerIneligibilityReason(owner);
  throw err;
}

function assertOwnersEligibleForPropertyAssignment(owners) {
  const list = Array.isArray(owners) ? owners : [owners];
  for (const owner of list) {
    assertOwnerEligibleForPropertyAssignment(owner);
  }
}

module.exports = {
  PROPERTY_ASSIGNMENT_ERROR,
  MAINTENANCE_REQUEST_ERROR,
  isOwnerPortalVerified,
  isOwnerAccountActive,
  isOwnerEligibleForAssignment,
  isOwnerEligibleForInvoiceGeneration,
  isOwnerEligibleForMaintenanceRequest,
  shouldGenerateInvoicesForOwnerAssignment,
  getOwnerIneligibilityReason,
  getOwnerAssignmentBlockReason,
  getOwnerInvoiceDeferralReason,
  buildOwnerEligibilityFields,
  assertOwnerEligibleForPropertyAssignment,
  assertOwnerEligibleForMaintenanceRequest,
  assertOwnersEligibleForPropertyAssignment,
};
