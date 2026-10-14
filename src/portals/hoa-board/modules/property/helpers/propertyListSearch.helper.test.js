const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

describe('propertyListSearch.helper', () => {
  let helper;
  let User;
  let originalUserFind;
  let originalBuildHOAOwnerUserFilter;
  let hoaOwnerRole;

  beforeEach(() => {
    // Clear cached modules so spies apply to freshly loaded helpers.
    delete require.cache[require.resolve('./propertyListSearch.helper')];
    delete require.cache[require.resolve('../../../../../shared/modules/users/models/user.model')];
    delete require.cache[require.resolve('../../../../../common/helpers/hoaOwnerRole')];

    User = require('../../../../../shared/modules/users/models/user.model');
    hoaOwnerRole = require('../../../../../common/helpers/hoaOwnerRole');
    originalUserFind = User.find;
    originalBuildHOAOwnerUserFilter = hoaOwnerRole.buildHOAOwnerUserFilter;

    hoaOwnerRole.buildHOAOwnerUserFilter = async () => ({ companyRoleId: 'hoa-owner-role' });

    helper = require('./propertyListSearch.helper');
  });

  afterEach(() => {
    User.find = originalUserFind;
    hoaOwnerRole.buildHOAOwnerUserFilter = originalBuildHOAOwnerUserFilter;
  });

  it('builds a text search clause for property name, unit, address, and owner fields', () => {
    const clause = helper.buildPropertyTextSearchClause('Oak');
    assert.ok(clause);
    assert.ok(clause.$or.some((c) => c.name && c.name.$regex === 'Oak'));
    assert.ok(clause.$or.some((c) => c['unitDetails.unitName']));
    assert.ok(clause.$or.some((c) => c['address.street']));
    assert.ok(clause.$or.some((c) => c['address.city']));
    assert.ok(clause.$or.some((c) => c['address.state']));
    assert.ok(clause.$or.some((c) => c['address.zip']));
    assert.ok(clause.$or.some((c) => c.ownerName));
    assert.ok(clause.$or.some((c) => c.ownerEmail));
    assert.ok(clause.$or.some((c) => c.ownerPhone));
  });

  it('returns null for blank search', () => {
    assert.equal(helper.buildPropertyTextSearchClause(''), null);
    assert.equal(helper.buildPropertyTextSearchClause('   '), null);
  });

  it('pushes search under existing HOA $and without dropping isolation', () => {
    const filter = {
      $and: [
        { isDeleted: { $ne: true } },
        { hoaId: 'hoa-1' },
      ],
    };
    const searchClause = helper.buildPropertyTextSearchClause('Oak');
    helper.mergeSearchClauseIntoFilter(filter, searchClause);
    assert.equal(filter.$and.length, 3);
    assert.deepEqual(filter.$and[2], searchClause);
    assert.equal(filter.$or, undefined);
  });

  it('wraps existing isolation $or with search under $and (board member bug)', () => {
    const filter = {
      isDeleted: { $ne: true },
      $or: [{ createdBy: 'u1' }, { landlord_id: 'u1' }],
    };
    const searchClause = helper.buildPropertyTextSearchClause('Oak');
    helper.mergeSearchClauseIntoFilter(filter, searchClause);
    assert.equal(filter.$or, undefined);
    assert.ok(Array.isArray(filter.$and));
    assert.equal(filter.$and.length, 2);
    assert.deepEqual(filter.$and[0].$or, [{ createdBy: 'u1' }, { landlord_id: 'u1' }]);
    assert.deepEqual(filter.$and[1], searchClause);
  });

  it('assigns search $or when filter has no prior $and/$or', () => {
    const filter = { isDeleted: { $ne: true } };
    const searchClause = helper.buildPropertyTextSearchClause('Oak');
    helper.mergeSearchClauseIntoFilter(filter, searchClause);
    assert.deepEqual(filter.$or, searchClause.$or);
  });

  it('matches partial full names via concatenated first+last clause', () => {
    const clauses = helper.buildOwnerUserMatchClauses('John Sm');
    assert.ok(clauses.some((c) => c.firstName));
    assert.ok(clauses.some((c) => c.lastName));
    const concatClause = clauses.find((c) => c.$expr?.$regexMatch);
    assert.ok(concatClause);
    assert.equal(concatClause.$expr.$regexMatch.regex, 'John Sm');
    assert.equal(concatClause.$expr.$regexMatch.options, 'i');
  });

  it('adds associatedOwnerIds and propertyIds from matching owners to list search', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const propertyId = new mongoose.Types.ObjectId();

    User.find = () => ({
      select: () => ({
        limit: () => ({
          lean: async () => [{ _id: ownerId, propertyIds: [propertyId] }],
        }),
      }),
    });

    const clause = await helper.buildPropertyTextSearchClauseWithOwners('John Sm');
    assert.ok(clause);
    assert.ok(
      clause.$or.some(
        (c) => c.associatedOwnerIds
          && Array.isArray(c.associatedOwnerIds.$in)
          && String(c.associatedOwnerIds.$in[0]) === String(ownerId),
      ),
      'expected associatedOwnerIds match for resolved owner',
    );
    assert.ok(
      clause.$or.some(
        (c) => c._id
          && Array.isArray(c._id.$in)
          && String(c._id.$in[0]) === String(propertyId),
      ),
      'expected _id match from owner.propertyIds',
    );
  });

  it('keeps denormalized ownerName search when no owners match', async () => {
    User.find = () => ({
      select: () => ({
        limit: () => ({
          lean: async () => [],
        }),
      }),
    });

    const clause = await helper.buildPropertyTextSearchClauseWithOwners('Legacy Owner');
    assert.ok(clause.$or.some((c) => c.ownerName && c.ownerName.$regex === 'Legacy Owner'));
    assert.equal(
      clause.$or.some((c) => c.associatedOwnerIds),
      false,
    );
  });
});
