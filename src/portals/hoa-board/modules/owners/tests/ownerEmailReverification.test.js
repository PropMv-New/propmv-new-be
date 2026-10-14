const { describe, test, mock, beforeEach, afterEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { PORTAL_ONBOARDING_STATUS } = require('../../../../../common/constants/portalOnboarding');

const OWNER_ID = '507f1f77bcf86cd799439011';
const BOARD_MEMBER_ID = '507f1f77bcf86cd799439012';
const HOA_OWNER_COMPANY_ID = '507f1f77bcf86cd799439099';
const HOA_OWNER_ROLE_ID = '507f1f77bcf86cd799439098';

const User = require('../../../../../shared/modules/users/models/user.model');
const activityServicePath = require.resolve('../../dashboard/service/activity.service');
const ownerServicePath = require.resolve('../service/owner.service');
const portalInvitationService = require('../../../../../shared/modules/auth/services/portalInvitation.service');
const hoaOwnerRole = require('../../../../../common/helpers/hoaOwnerRole');

function buildOwner(overrides = {}) {
  return {
    _id: OWNER_ID,
    isDeleted: false,
    email: 'old@example.com',
    firstName: 'Jane',
    lastName: 'Owner',
    portalOnboardingStatus: PORTAL_ONBOARDING_STATUS.ACTIVE,
    refreshToken: 'existing-session-token',
    hoaBoardMemberId: BOARD_MEMBER_ID,
    propertyIds: [],
    isDifferentMailingAddress: false,
    ...overrides,
  };
}

function makeUserFindByIdMock(getRecord) {
  return mock.fn(() => {
    const record = getRecord();
    return {
      lean: async () => ({ ...record }),
      then(resolve, reject) {
        Promise.resolve(record).then(resolve, reject);
      },
    };
  });
}

describe('owner email re-verification', () => {
  let ownerService;
  let ownerRecord;
  let findByIdAndUpdateArgs;
  let originalFindById;
  let originalFindByIdAndUpdate;
  let originalFindOne;
  let originalUpdateOne;
  let originalIssueHoaOwnerPortalInvite;
  let originalAssertInviterRole;
  let originalLogActivity;
  let originalGetHOAOwnerRoleRefs;

  before(() => {
    const activityService = require(activityServicePath);
    originalLogActivity = activityService.logActivity;
    activityService.logActivity = mock.fn(async () => {});

    originalGetHOAOwnerRoleRefs = hoaOwnerRole.getHOAOwnerRoleRefs;
    hoaOwnerRole.getHOAOwnerRoleRefs = mock.fn(async () => ({
      companyId: HOA_OWNER_COMPANY_ID,
      roleId: HOA_OWNER_ROLE_ID,
      role: { name: 'HOA Owner' },
    }));
    hoaOwnerRole.buildHOAOwnerUserFilter = mock.fn(async (extra = {}) => ({
      companyId: HOA_OWNER_COMPANY_ID,
      companyRoleId: HOA_OWNER_ROLE_ID,
      isDeleted: { $ne: true },
      ...extra,
    }));

    delete require.cache[ownerServicePath];
    ownerService = require(ownerServicePath);
  });

  after(() => {
    const activityService = require(activityServicePath);
    activityService.logActivity = originalLogActivity;
    hoaOwnerRole.getHOAOwnerRoleRefs = originalGetHOAOwnerRoleRefs;
    delete require.cache[ownerServicePath];
  });

  beforeEach(() => {
    ownerRecord = buildOwner();
    findByIdAndUpdateArgs = null;
    process.env.EMAIL_VALIDATE_MX = 'false';
    process.env.EMAIL_VALIDATION_LOG = 'false';
    process.env.EMAIL_SUPPRESSION_ENABLED = 'false';
    process.env.EMAIL_BLOCK_TYPO_DOMAINS = 'false';
    process.env.EMAIL_BLOCK_DISPOSABLE_DOMAINS = 'false';
    process.env.EMAIL_MAILBOX_VERIFY_ENABLED = 'false';
    process.env.EMAIL_REQUIRE_EMAIL_CONFIRM = 'true';
    delete process.env.OWNER_INVITE_SEND_TIMEOUT_MS;

    originalFindById = User.findById;
    originalFindByIdAndUpdate = User.findByIdAndUpdate;
    originalFindOne = User.findOne;
    originalUpdateOne = User.updateOne;
    originalIssueHoaOwnerPortalInvite = portalInvitationService.issueHoaOwnerPortalInvite;
    originalAssertInviterRole = portalInvitationService.assertInviterRole;

    User.findById = makeUserFindByIdMock(() => ownerRecord);
    User.findOne = mock.fn((query = {}) => {
      const andClauses = Array.isArray(query.$and) ? query.$and : [];
      const looksLikeOwnerById =
        String(query._id || '') === OWNER_ID ||
        andClauses.some((clause) => String(clause?._id || '') === OWNER_ID);
      const result = looksLikeOwnerById ? { ...ownerRecord } : null;
      return {
        session() {
          return this;
        },
        lean() {
          return this;
        },
        exec: async () => result,
        then(resolve, reject) {
          Promise.resolve(result).then(resolve, reject);
        },
      };
    });
    User.findByIdAndUpdate = mock.fn((_id, ops) => {
      findByIdAndUpdateArgs = ops;
      ownerRecord = {
        ...ownerRecord,
        ...ops.$set,
      };
      if (ops.$unset?.refreshToken) {
        delete ownerRecord.refreshToken;
      }
      return {
        lean: async () => ({ ...ownerRecord }),
      };
    });
    User.updateOne = mock.fn(async () => ({}));

    portalInvitationService.issueHoaOwnerPortalInvite = mock.fn(async () => ({ invitationId: 'inv-1' }));
    portalInvitationService.assertInviterRole = mock.fn(async () => {});
  });

  test('updateOwner resets verification and flags emailVerificationRequired when email changes on active owner', async () => {
    process.env.EMAIL_VALIDATE_MX = 'false';
    process.env.EMAIL_VALIDATION_LOG = 'false';
    process.env.EMAIL_SUPPRESSION_ENABLED = 'false';
    process.env.EMAIL_REQUIRE_EMAIL_CONFIRM = 'true';

    const result = await ownerService.updateOwner(
      OWNER_ID,
      { email: 'new@example.com', emailConfirm: 'new@example.com' },
      { userId: BOARD_MEMBER_ID },
    );

    assert.equal(result.email, 'new@example.com');
    assert.equal(result.portalOnboardingStatus, PORTAL_ONBOARDING_STATUS.INVITATION_SENT);
    assert.equal(result.emailVerificationRequired, true);
    assert.equal(result.invitationResent, true);

    assert.ok(findByIdAndUpdateArgs);
    assert.equal(findByIdAndUpdateArgs.$set.portalOnboardingStatus, PORTAL_ONBOARDING_STATUS.INVITATION_SENT);
    assert.equal(findByIdAndUpdateArgs.$set.email, 'new@example.com');
    assert.deepEqual(findByIdAndUpdateArgs.$unset, { refreshToken: '' });

    assert.equal(portalInvitationService.issueHoaOwnerPortalInvite.mock.calls.length, 1);
    assert.deepEqual(portalInvitationService.issueHoaOwnerPortalInvite.mock.calls[0].arguments[0], {
      inviteeUserId: OWNER_ID,
      inviterUserId: BOARD_MEMBER_ID,
      tenantName: 'Jane',
      hoaContext: null,
      skipRecipientValidation: true,
    });
  });

  test('updateOwner rejects email change without confirm when required', async () => {
    process.env.EMAIL_REQUIRE_EMAIL_CONFIRM = 'true';
    process.env.EMAIL_VALIDATE_MX = 'false';
    process.env.EMAIL_VALIDATION_LOG = 'false';

    await assert.rejects(
      () =>
        ownerService.updateOwner(
          OWNER_ID,
          { email: 'new@example.com' },
          { userId: BOARD_MEMBER_ID },
        ),
      (err) => {
        assert.equal(err.status, 400);
        assert.equal(err.field, 'emailConfirm');
        return true;
      }
    );
    assert.equal(portalInvitationService.issueHoaOwnerPortalInvite.mock.calls.length, 0);
  });

  test('updateOwner allows email change without confirm when confirm requirement is unset', async () => {
    delete process.env.EMAIL_REQUIRE_EMAIL_CONFIRM;
    process.env.EMAIL_VALIDATE_MX = 'false';
    process.env.EMAIL_VALIDATION_LOG = 'false';

    const result = await ownerService.updateOwner(
      OWNER_ID,
      { email: 'new@example.com' },
      { userId: BOARD_MEMBER_ID },
    );

    assert.equal(result.email, 'new@example.com');
    assert.equal(result.emailVerificationRequired, true);
    assert.equal(result.invitationResent, true);
    assert.equal(portalInvitationService.issueHoaOwnerPortalInvite.mock.calls.length, 1);
  });

  test('updateOwner returns invitation error when verification invite times out', async () => {
    process.env.EMAIL_REQUIRE_EMAIL_CONFIRM = 'true';
    process.env.OWNER_INVITE_SEND_TIMEOUT_MS = '1';
    portalInvitationService.issueHoaOwnerPortalInvite = mock.fn(() => new Promise(() => {}));

    const result = await ownerService.updateOwner(
      OWNER_ID,
      { email: 'new@example.com', emailConfirm: 'new@example.com' },
      { userId: BOARD_MEMBER_ID },
    );

    assert.equal(result.email, 'new@example.com');
    assert.equal(result.emailVerificationRequired, true);
    assert.equal(result.invitationResent, false);
    assert.match(result.invitationError, /having trouble sending the verification email/i);
    assert.equal(portalInvitationService.issueHoaOwnerPortalInvite.mock.calls.length, 1);
  });

  test('updateOwner does not trigger re-verification when email is unchanged', async () => {
    const result = await ownerService.updateOwner(
      OWNER_ID,
      { email: 'old@example.com', firstName: 'Janet' },
      { userId: BOARD_MEMBER_ID },
    );

    assert.equal(result.emailVerificationRequired, false);
    assert.equal(result.invitationResent, false);
    assert.equal(result.portalOnboardingStatus, PORTAL_ONBOARDING_STATUS.ACTIVE);
    assert.equal(findByIdAndUpdateArgs?.$unset, undefined);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(portalInvitationService.issueHoaOwnerPortalInvite.mock.calls.length, 0);
  });

  test('resendOwnerInvite rejects already verified owners', async () => {
    ownerRecord = buildOwner({ portalOnboardingStatus: PORTAL_ONBOARDING_STATUS.ACTIVE });
    User.findById = makeUserFindByIdMock(() => ownerRecord);

    await assert.rejects(
      () => ownerService.resendOwnerInvite(OWNER_ID, { userId: BOARD_MEMBER_ID }),
      (err) => {
        assert.equal(err.status, 400);
        assert.match(err.message, /already completed invitation onboarding/i);
        return true;
      },
    );
  });

  test('resendOwnerInvite queues portal invite delivery in the background', async () => {
    ownerRecord = buildOwner({ portalOnboardingStatus: PORTAL_ONBOARDING_STATUS.INVITATION_SENT });
    User.findById = makeUserFindByIdMock(() => ownerRecord);
    process.env.EMAIL_VALIDATE_MX = 'false';
    process.env.EMAIL_VALIDATION_LOG = 'false';

    const result = await ownerService.resendOwnerInvite(OWNER_ID, { userId: BOARD_MEMBER_ID });

    assert.equal(result.emailedTo, 'old@example.com');
    assert.equal(result.invitationQueued, true);
    assert.equal(portalInvitationService.issueHoaOwnerPortalInvite.mock.calls.length, 0);

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(portalInvitationService.issueHoaOwnerPortalInvite.mock.calls.length, 1);
    assert.deepEqual(portalInvitationService.issueHoaOwnerPortalInvite.mock.calls[0].arguments[0], {
      inviteeUserId: OWNER_ID,
      inviterUserId: BOARD_MEMBER_ID,
      tenantName: 'Jane',
      hoaContext: null,
      skipRecipientValidation: true,
    });
  });

  afterEach(() => {
    User.findById = originalFindById;
    User.findByIdAndUpdate = originalFindByIdAndUpdate;
    User.findOne = originalFindOne;
    User.updateOne = originalUpdateOne;
    portalInvitationService.issueHoaOwnerPortalInvite = originalIssueHoaOwnerPortalInvite;
    portalInvitationService.assertInviterRole = originalAssertInviterRole;
  });
});
