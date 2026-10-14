const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const {
  buildOwnerPropertyPickerClause,
  mergeFilterClauses,
} = require('../service/propertyPicker.service');
const { lookupRequiredPrivilegesForRoute } = require('../../../../../middleware/apiPrivilegeCheck');
const { PRIVILEGE_MAPS } = require('../../../../../privileges');
const { checkApiPrivilegeSync } = require('../../../../../middleware/apiPrivilegeCheck');

describe('property picker HOA owner access', () => {
  it('maps HOA property picker route', () => {
    const result = lookupRequiredPrivilegesForRoute(
      'GET',
      '/api/v1/hoa/property/picker',
      PRIVILEGE_MAPS,
    );
    assert.equal(result.found, true);
    assert.ok(result.privileges.includes('VIEW_PROPERTY'));
    assert.ok(result.privileges.includes('VIEW_EMAIL'));
    assert.ok(result.privileges.includes('VIEW_INCOME'));
  });

  it('allows HOA owner privileges through picker gate', () => {
    const { privileges } = lookupRequiredPrivilegesForRoute(
      'GET',
      '/api/v1/hoa/property/picker',
      PRIVILEGE_MAPS,
    );
    const ownerPrivileges = ['VIEW_DASHBOARD', 'VIEW_EMAIL', 'VIEW_INCOME'];
    assert.equal(checkApiPrivilegeSync(ownerPrivileges, privileges), true);
    assert.equal(checkApiPrivilegeSync(['VIEW_MAINTENANCE'], privileges), false);
  });

  it('scopes HOA owner picker queries to assigned properties', () => {
    const hoaId = new mongoose.Types.ObjectId();
    const ownerPropertyId = new mongoose.Types.ObjectId();
    const clause = buildOwnerPropertyPickerClause({
      isHOAOwner: true,
      userId: 'owner-user-1',
      hoaId: hoaId.toString(),
      ownerPropertyIds: [ownerPropertyId],
    });

    assert.ok(clause.$and);
    assert.deepEqual(clause.$and[0], { hoaId });
    assert.deepEqual(clause.$and[1], {
      $or: [
        { associatedOwnerIds: 'owner-user-1' },
        { _id: { $in: [ownerPropertyId] } },
      ],
    });
  });

  it('merges base, owner, and text clauses with $and', () => {
    const merged = mergeFilterClauses(
      { isDeleted: { $ne: true } },
      { associatedOwnerIds: 'owner-1' },
      { $or: [{ name: /unit/i }] },
    );
    assert.deepEqual(merged, {
      $and: [
        { isDeleted: { $ne: true } },
        { associatedOwnerIds: 'owner-1' },
        { $or: [{ name: /unit/i }] },
      ],
    });
  });
});
