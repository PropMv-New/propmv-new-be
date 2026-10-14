const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PORTAL_ONBOARDING_STATUS } = require('../../../../../common/constants/portalOnboarding');
const { USER_STATUSES } = require('../../../../../common/constants/user');
const {
  isOwnerEligibleForAssignment,
  isOwnerEligibleForInvoiceGeneration,
  isOwnerEligibleForMaintenanceRequest,
  shouldGenerateInvoicesForOwnerAssignment,
  getOwnerIneligibilityReason,
  getOwnerInvoiceDeferralReason,
  assertOwnerEligibleForPropertyAssignment,
  assertOwnerEligibleForMaintenanceRequest,
  buildOwnerEligibilityFields,
  MAINTENANCE_REQUEST_ERROR,
} = require('./ownerEligibility.helper');

const activeVerifiedOwner = {
  portalOnboardingStatus: PORTAL_ONBOARDING_STATUS.ACTIVE,
  status: USER_STATUSES.ACTIVE,
  isArchived: false,
  isDeleted: false,
};

describe('ownerEligibility.helper', () => {
  it('allows verified and active owners for assignment, invoices, and maintenance', () => {
    assert.equal(isOwnerEligibleForAssignment(activeVerifiedOwner), true);
    assert.equal(isOwnerEligibleForInvoiceGeneration(activeVerifiedOwner), true);
    assert.equal(shouldGenerateInvoicesForOwnerAssignment(activeVerifiedOwner, 0), true);
    assert.doesNotThrow(() => assertOwnerEligibleForPropertyAssignment(activeVerifiedOwner));
    assert.doesNotThrow(() => assertOwnerEligibleForMaintenanceRequest(activeVerifiedOwner));
  });

  it('allows legacy owners with null portal status when account is active', () => {
    const legacyOwner = {
      portalOnboardingStatus: null,
      status: USER_STATUSES.ACTIVE,
      isArchived: false,
      isDeleted: false,
    };
    assert.equal(isOwnerEligibleForAssignment(legacyOwner), true);
    assert.equal(isOwnerEligibleForInvoiceGeneration(legacyOwner), true);
  });

  it('INV-SC-029: allows invitation_sent owners to be assigned but defers invoices', () => {
    const owner = {
      ...activeVerifiedOwner,
      portalOnboardingStatus: PORTAL_ONBOARDING_STATUS.INVITATION_SENT,
    };
    assert.equal(isOwnerEligibleForAssignment(owner), true);
    assert.doesNotThrow(() => assertOwnerEligibleForPropertyAssignment(owner));
    assert.equal(isOwnerEligibleForInvoiceGeneration(owner), false);
    assert.equal(shouldGenerateInvoicesForOwnerAssignment(owner, 0), false);
    assert.match(getOwnerInvoiceDeferralReason(owner), /Invitation sent/i);
    assert.throws(
      () => assertOwnerEligibleForMaintenanceRequest(owner),
      (err) => err.message === MAINTENANCE_REQUEST_ERROR && err.status === 400,
    );
    const fields = buildOwnerEligibilityFields(owner);
    assert.equal(fields.isEligibleForAssignment, true);
    assert.equal(fields.invoiceGenerationDeferred, true);
    assert.equal(fields.isEligibleForMaintenance, false);
  });

  it('INV-SC-029: allows pending_verification owners to be assigned but defers invoices', () => {
    const owner = {
      ...activeVerifiedOwner,
      portalOnboardingStatus: PORTAL_ONBOARDING_STATUS.PENDING_VERIFICATION,
    };
    assert.equal(isOwnerEligibleForAssignment(owner), true);
    assert.equal(isOwnerEligibleForInvoiceGeneration(owner), false);
    assert.match(getOwnerInvoiceDeferralReason(owner), /pending/i);
  });

  it('INV-SC-029: allows inactive owners to be assigned but does not generate invoices', () => {
    const owner = {
      ...activeVerifiedOwner,
      status: USER_STATUSES.INACTIVE,
    };
    assert.equal(isOwnerEligibleForAssignment(owner), true);
    assert.equal(isOwnerEligibleForInvoiceGeneration(owner), false);
    assert.equal(shouldGenerateInvoicesForOwnerAssignment(owner, 0), false);
    assert.equal(isOwnerEligibleForMaintenanceRequest(owner), false);
    assert.match(getOwnerIneligibilityReason(owner), /inactive/i);
    assert.throws(
      () => assertOwnerEligibleForMaintenanceRequest(owner),
      (err) => err.message === MAINTENANCE_REQUEST_ERROR && err.status === 400,
    );
  });

  it('does not generate duplicate invoices when the unit already has invoices', () => {
    assert.equal(shouldGenerateInvoicesForOwnerAssignment(activeVerifiedOwner, 3), false);
    assert.equal(shouldGenerateInvoicesForOwnerAssignment(activeVerifiedOwner, 0), true);
  });

  it('blocks archived owners from assignment', () => {
    const owner = {
      ...activeVerifiedOwner,
      isArchived: true,
    };
    assert.equal(isOwnerEligibleForAssignment(owner), false);
    assert.match(getOwnerIneligibilityReason(owner), /archived/i);
    assert.throws(() => assertOwnerEligibleForPropertyAssignment(owner));
  });

  it('blocks locked owners from assignment', () => {
    const owner = {
      ...activeVerifiedOwner,
      status: USER_STATUSES.LOCKED,
    };
    assert.equal(isOwnerEligibleForAssignment(owner), false);
    assert.throws(() => assertOwnerEligibleForPropertyAssignment(owner));
  });

  it('blocks deleted owners and missing owners from assignment', () => {
    assert.equal(isOwnerEligibleForAssignment(null), false);
    assert.equal(isOwnerEligibleForAssignment({
      ...activeVerifiedOwner,
      isDeleted: true,
    }), false);
    assert.throws(() => assertOwnerEligibleForPropertyAssignment({
      ...activeVerifiedOwner,
      isDeleted: true,
    }));
  });

  it('INV-SC-029: status matrix separates assignment, invoices, and maintenance', () => {
    const cases = [
      {
        name: 'unverified invitation sent',
        owner: { ...activeVerifiedOwner, portalOnboardingStatus: PORTAL_ONBOARDING_STATUS.INVITATION_SENT },
        assign: true,
        invoice: false,
        maintenance: false,
      },
      {
        name: 'pending verification',
        owner: { ...activeVerifiedOwner, portalOnboardingStatus: PORTAL_ONBOARDING_STATUS.PENDING_VERIFICATION },
        assign: true,
        invoice: false,
        maintenance: false,
      },
      {
        name: 'inactive verified portal',
        owner: { ...activeVerifiedOwner, status: USER_STATUSES.INACTIVE },
        assign: true,
        invoice: false,
        maintenance: false,
      },
      {
        name: 'pending account',
        owner: { ...activeVerifiedOwner, status: USER_STATUSES.PENDING },
        assign: true,
        invoice: false,
        maintenance: false,
      },
      {
        name: 'verified active',
        owner: activeVerifiedOwner,
        assign: true,
        invoice: true,
        maintenance: true,
      },
      {
        name: 'legacy null portal',
        owner: { ...activeVerifiedOwner, portalOnboardingStatus: null },
        assign: true,
        invoice: true,
        maintenance: true,
      },
      {
        name: 'archived',
        owner: { ...activeVerifiedOwner, isArchived: true },
        assign: false,
        invoice: false,
        maintenance: false,
      },
      {
        name: 'deleted',
        owner: { ...activeVerifiedOwner, isDeleted: true },
        assign: false,
        invoice: false,
        maintenance: false,
      },
      {
        name: 'locked',
        owner: { ...activeVerifiedOwner, status: USER_STATUSES.LOCKED },
        assign: false,
        invoice: false,
        maintenance: false,
      },
    ];

    for (const row of cases) {
      assert.equal(isOwnerEligibleForAssignment(row.owner), row.assign, `${row.name} assign`);
      assert.equal(isOwnerEligibleForInvoiceGeneration(row.owner), row.invoice, `${row.name} invoice`);
      assert.equal(isOwnerEligibleForMaintenanceRequest(row.owner), row.maintenance, `${row.name} maintenance`);
      assert.equal(
        shouldGenerateInvoicesForOwnerAssignment(row.owner, 0),
        row.invoice,
        `${row.name} generate`,
      );
    }
  });

  it('buildOwnerEligibilityFields returns picker contract fields', () => {
    const deferred = buildOwnerEligibilityFields({
      ...activeVerifiedOwner,
      portalOnboardingStatus: PORTAL_ONBOARDING_STATUS.INVITATION_SENT,
    });
    assert.deepEqual(
      Object.keys(deferred).sort(),
      [
        'ineligibilityReason',
        'invoiceGenerationDeferred',
        'invoiceGenerationDeferredReason',
        'isEligibleForAssignment',
        'isEligibleForMaintenance',
        'maintenanceIneligibilityReason',
      ],
    );
    assert.equal(deferred.isEligibleForAssignment, true);
    assert.equal(deferred.invoiceGenerationDeferred, true);
    assert.equal(deferred.isEligibleForMaintenance, false);
    assert.equal(deferred.ineligibilityReason, null);

    const ready = buildOwnerEligibilityFields(activeVerifiedOwner);
    assert.equal(ready.invoiceGenerationDeferred, false);
    assert.equal(ready.invoiceGenerationDeferredReason, null);
    assert.equal(ready.isEligibleForMaintenance, true);
  });
});
