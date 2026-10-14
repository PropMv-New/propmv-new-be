const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCompanyRoleUserFilter,
  userMatchesInvitationRole,
  normalizeRoleName,
  findActiveRoleByName,
} = require('./companyRoleHelper');

describe('companyRoleHelper', () => {
  test('buildCompanyRoleUserFilter scopes by company role', () => {
    const filter = buildCompanyRoleUserFilter({
      companyId: 'company1',
      companyRoleId: 'role1',
    });
    assert.deepEqual(filter.companyId, 'company1');
    assert.deepEqual(filter.companyRoleId, 'role1');
    assert.deepEqual(filter.isDeleted, { $ne: true });
  });

  test('userMatchesInvitationRole accepts company role match', () => {
    const user = { companyId: 'c1', companyRoleId: 'r1' };
    const inv = { intendedCompanyId: 'c1', intendedRoleId: 'r1' };
    assert.equal(userMatchesInvitationRole(user, inv), true);
  });

  test('userMatchesInvitationRole rejects company mismatch', () => {
    const user = { companyId: 'c1', companyRoleId: 'r1' };
    const inv = { intendedCompanyId: 'c2', intendedRoleId: 'r1' };
    assert.equal(userMatchesInvitationRole(user, inv), false);
  });

  test('userMatchesInvitationRole rejects users without company role', () => {
    const user = { role: 'legacy1' };
    const inv = { intendedRoleId: 'legacy1' };
    assert.equal(userMatchesInvitationRole(user, inv), false);
  });

  test('findActiveRoleByName is case-insensitive', () => {
    const roles = [{ name: 'HOA Owner', isActive: true }];
    const found = findActiveRoleByName(roles, 'hoa owner');
    assert.equal(found.name, 'HOA Owner');
    assert.equal(normalizeRoleName('  HOA   Owner '), 'hoa owner');
  });
});
