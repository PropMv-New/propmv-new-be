/**
 * Unit tests: landlord / Property Manager / HOA property visibility filters (no database).
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { PROPERTY_SOURCE_PORTAL } = require('../common/constants/property');
const {
  buildPropertyOwnerFilter,
  resolvePropertyOwnerFilter,
  combineLandlordPropertyVisibilityFilter,
  resolvePropertySourcePortal,
  buildLandlordPropertyVisibilityFilter,
} = require('../shared/utils/creatorScope.util');

const USER_ID = '6a870d2697be4d02d373dfb5';

function flattenAndClauses(filter) {
  const parts = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.$and)) {
      node.$and.forEach(walk);
      return;
    }
    parts.push(node);
  };
  walk(filter);
  return parts;
}

function hasHoaExclusion(filter) {
  return flattenAndClauses(filter).some((part) => {
    const ors = part.$or;
    if (!Array.isArray(ors)) return false;
    return ors.some((clause) => clause.hoaId === null)
      && ors.some((clause) => clause.hoaId && clause.hoaId.$exists === false);
  });
}

function hasSourcePortal(filter, portal) {
  return flattenAndClauses(filter).some((part) => {
    const ors = part.$or;
    if (!Array.isArray(ors)) return false;
    return ors.some((clause) => clause.sourcePortal === portal);
  });
}

describe('property visibility scope', () => {
  test('buildPropertyOwnerFilter(admin object) returns empty match-all filter (legacy trap)', () => {
    const filter = buildPropertyOwnerFilter({
      userId: USER_ID,
      isAdministrator: true,
      companyId: new mongoose.Types.ObjectId(),
    });
    assert.deepEqual(filter, {});
  });

  test('resolvePropertyOwnerFilter(admin without company) scopes to the actor, not every property', async () => {
    const filter = await resolvePropertyOwnerFilter({
      userId: USER_ID,
      isAdministrator: true,
      companyId: null,
    });
    assert.notDeepEqual(filter, {});
    assert.ok(Array.isArray(filter.$or));
    const createdByIn = filter.$or.find((clause) => clause.createdBy && clause.createdBy.$in);
    assert.ok(createdByIn);
    const ids = createdByIn.createdBy.$in.map((id) => String(id));
    assert.ok(ids.includes(USER_ID));
  });

  test('landlord visibility excludes HOA-scoped properties and keeps landlord portal rows', async () => {
    const filter = await buildLandlordPropertyVisibilityFilter(USER_ID, PROPERTY_SOURCE_PORTAL.LANDLORD);
    assert.ok(hasHoaExclusion(filter));
    assert.ok(hasSourcePortal(filter, PROPERTY_SOURCE_PORTAL.LANDLORD));
    assert.equal(hasSourcePortal(filter, PROPERTY_SOURCE_PORTAL.PROPERTY_MANAGER), false);
  });

  test('property manager visibility excludes HOA-scoped properties and keeps PM portal rows', async () => {
    const filter = await buildLandlordPropertyVisibilityFilter(USER_ID, PROPERTY_SOURCE_PORTAL.PROPERTY_MANAGER);
    assert.ok(hasHoaExclusion(filter));
    assert.ok(hasSourcePortal(filter, PROPERTY_SOURCE_PORTAL.PROPERTY_MANAGER));
    assert.equal(hasSourcePortal(filter, PROPERTY_SOURCE_PORTAL.LANDLORD), false);
  });

  test('empty owner filter does not become a match-all visibility query', () => {
    const filter = combineLandlordPropertyVisibilityFilter({}, PROPERTY_SOURCE_PORTAL.PROPERTY_MANAGER);
    assert.deepEqual(filter, { _id: { $in: [] } });
  });

  test('resolvePropertySourcePortal maps Landlord vs Property Manager vs Administrator', async () => {
    assert.equal(
      await resolvePropertySourcePortal({ role: 'Landlord' }),
      PROPERTY_SOURCE_PORTAL.LANDLORD,
    );
    assert.equal(
      await resolvePropertySourcePortal({ role: 'Property Manager' }),
      PROPERTY_SOURCE_PORTAL.PROPERTY_MANAGER,
    );
    assert.equal(
      await resolvePropertySourcePortal({ role: 'Administrator', isAdministrator: true }),
      PROPERTY_SOURCE_PORTAL.PROPERTY_MANAGER,
    );
  });
});
