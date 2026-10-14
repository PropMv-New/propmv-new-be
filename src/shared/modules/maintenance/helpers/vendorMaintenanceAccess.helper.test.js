const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isVendorMaintenanceActionAllowed,
  vendorMaintenanceDeniedError,
  resolveMaintenanceActorRoleName,
  isVendorAllowedMaintenanceStatus,
} = require('./vendorMaintenanceAccess.helper');
const { isVendorRole } = require('../../../../common/helpers/hoaVendorRole');

describe('vendor maintenance access', () => {
  it('allows view, notes, comments, attachment upload, status updates, and resolve (complete)', () => {
    assert.equal(isVendorMaintenanceActionAllowed('view'), true);
    assert.equal(isVendorMaintenanceActionAllowed('add_note'), true);
    assert.equal(isVendorMaintenanceActionAllowed('update_note'), true);
    assert.equal(isVendorMaintenanceActionAllowed('delete_note'), true);
    assert.equal(isVendorMaintenanceActionAllowed('add_comment'), true);
    assert.equal(isVendorMaintenanceActionAllowed('upload_document'), true);
    assert.equal(isVendorMaintenanceActionAllowed('update_status'), true);
    assert.equal(isVendorMaintenanceActionAllowed('resolve'), true);
  });

  it('denies reject, reopen, assign, create, and delete ticket actions', () => {
    for (const action of [
      'reject',
      'update',
      'reopen',
      'assign',
      'create',
      'delete',
      'delete_document',
    ]) {
      assert.equal(isVendorMaintenanceActionAllowed(action), false);
    }
  });

  it('allows only Completed as vendor status transition', () => {
    assert.equal(isVendorAllowedMaintenanceStatus('Completed'), true);
    assert.equal(isVendorAllowedMaintenanceStatus('completed'), true);
    assert.equal(isVendorAllowedMaintenanceStatus('Resolved'), false);
    assert.equal(isVendorAllowedMaintenanceStatus('InProgress'), false);
    assert.equal(isVendorAllowedMaintenanceStatus('Open'), false);
    assert.equal(isVendorAllowedMaintenanceStatus('Rejected'), false);
  });

  it('returns a 403 denial error', () => {
    const err = vendorMaintenanceDeniedError();
    assert.equal(err.status, 403);
    assert.match(err.message, /manage their own notes/i);
    assert.match(err.message, /upload attachments/i);
  });

  it('resolves vendor role from JWT role claim and auth middleware name', () => {
    assert.equal(
      resolveMaintenanceActorRoleName({ user: { role: 'Vendor' } }),
      'Vendor'
    );
    assert.equal(
      resolveMaintenanceActorRoleName({ userRoleName: 'Vendor', user: { role: 'Other' } }),
      'Vendor'
    );
    assert.equal(
      resolveMaintenanceActorRoleName({ user: { role: { name: 'Vendor' } } }),
      'Vendor'
    );
    assert.equal(isVendorRole(resolveMaintenanceActorRoleName({ user: { role: 'Vendor' } })), true);
  });
});
