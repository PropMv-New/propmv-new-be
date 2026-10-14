const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const HOA_ID = '507f1f77bcf86cd799439099';
const ADMIN_ID = '507f1f77bcf86cd799439011';
const CREATOR_ID = '507f1f77bcf86cd799439012';
const MEMBER_ID = '507f1f77bcf86cd799439013';
const SENDER_ID = '507f1f77bcf86cd799439014';

const servicePath = require.resolve('./communityEmailContext.service');
const User = require('../../shared/modules/users/models/user.model');
const HOA = require('../../portals/hoa-board/modules/hoa/model/hoa.model');
const HOAMembership = require('../../portals/hoa-board/modules/hoa/model/hoaMembership.model');

function loadService() {
  delete require.cache[servicePath];
  return require('./communityEmailContext.service');
}

function makeLeanQuery(result) {
  return {
    select: () => ({
      lean: async () => result,
    }),
  };
}

function makeMembershipQuery(result) {
  return {
    sort: () => ({
      select: () => ({
        lean: async () => result,
      }),
    }),
  };
}

function userRecord(id, overrides = {}) {
  return {
    _id: id,
    email: `${id}@example.com`,
    firstName: 'Test',
    lastName: 'User',
    isDeleted: false,
    ...overrides,
  };
}

describe('communityEmailContext.service', () => {
  const originalEnv = { ...process.env };
  let originalUserFindById;
  let originalHoaFindById;
  let originalMembershipFindOne;

  beforeEach(() => {
    process.env.FROM_EMAIL = 'noreply@propmv.com';
    process.env.FROM_NAME = 'PropMv';
    process.env.REPLY_TO = 'help@propmv.com';
    process.env.REPLY_TO_NAME = 'PropMv Support';
    process.env.COMMUNITY_EMAIL_CONTEXT_TIMEOUT_MS = '5000';
    process.env.COMMUNITY_EMAIL_CONTEXT_CACHE_TTL_MS = '300000';

    originalUserFindById = User.findById;
    originalHoaFindById = HOA.findById;
    originalMembershipFindOne = HOAMembership.findOne;

    const { clearCommunityEmailContextCacheForTests } = loadService();
    clearCommunityEmailContextCacheForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    User.findById = originalUserFindById;
    HOA.findById = originalHoaFindById;
    HOAMembership.findOne = originalMembershipFindOne;
    delete require.cache[servicePath];
  });

  it('returns null when no community context is provided', async () => {
    const { resolveCommunityEmailEnvelope } = loadService();
    const envelope = await resolveCommunityEmailEnvelope({});
    assert.equal(envelope, null);
  });

  it('uses community name for from and default reply-to when only name is provided', async () => {
    const { resolveCommunityEmailEnvelope } = loadService();
    const envelope = await resolveCommunityEmailEnvelope({ communityName: 'Ashiyana' });
    assert.equal(envelope.from.name, 'Ashiyana');
    assert.equal(envelope.from.address, 'noreply@propmv.com');
    assert.deepEqual(envelope.replyTo, {
      name: 'PropMv Support',
      address: 'help@propmv.com',
    });
  });

  it('preserves explicit replyTo override', async () => {
    const { resolveCommunityEmailEnvelope } = loadService();
    const explicit = { name: 'John Doe', address: 'johndoe@gmail.com' };
    const envelope = await resolveCommunityEmailEnvelope({
      communityName: 'Ashiyana',
      replyTo: explicit,
    });
    assert.deepEqual(envelope.replyTo, explicit);
  });

  it('applyCommunityEnvelope updates mail options for community sends', async () => {
    const { applyCommunityEnvelope } = loadService();
    const updated = await applyCommunityEnvelope(
      { from: { name: 'PropMv', address: 'noreply@propmv.com' }, to: 'a@b.com' },
      { communityName: 'Ashiyana' }
    );
    assert.equal(updated.from.name, 'Ashiyana');
    assert.ok(updated.replyTo);
  });

  it('prefers active admin membership for HOA reply-to', async () => {
    HOA.findById = mock.fn(() =>
      makeLeanQuery({ name: 'Sunset HOA', createdBy: CREATOR_ID })
    );
    HOAMembership.findOne = mock.fn((query) => {
      if (query.role === 'admin') {
        return makeMembershipQuery({ userId: ADMIN_ID });
      }
      return makeMembershipQuery(null);
    });
    User.findById = mock.fn((id) =>
      makeLeanQuery(userRecord(String(id), { email: 'admin@hoa.com', firstName: 'Board', lastName: 'Admin' }))
    );

    const { resolveCommunityEmailEnvelope } = loadService();
    const envelope = await resolveCommunityEmailEnvelope({ hoaId: HOA_ID });

    assert.equal(envelope.from.name, 'Sunset HOA');
    assert.deepEqual(envelope.replyTo, {
      name: 'Board Admin',
      address: 'admin@hoa.com',
    });
    assert.equal(HOAMembership.findOne.mock.calls.length, 1);
  });

  it('falls back to HOA createdBy when no admin membership contact exists', async () => {
    HOA.findById = mock.fn(() =>
      makeLeanQuery({ name: 'Lakeview HOA', createdBy: CREATOR_ID })
    );
    HOAMembership.findOne = mock.fn(() => makeMembershipQuery(null));
    User.findById = mock.fn((id) => {
      if (String(id) === CREATOR_ID) {
        return makeLeanQuery(
          userRecord(CREATOR_ID, { email: 'creator@hoa.com', firstName: 'Hoa', lastName: 'Creator' })
        );
      }
      return makeLeanQuery(null);
    });

    const { resolveCommunityEmailEnvelope } = loadService();
    const envelope = await resolveCommunityEmailEnvelope({ hoaId: HOA_ID });

    assert.deepEqual(envelope.replyTo, {
      name: 'Hoa Creator',
      address: 'creator@hoa.com',
    });
    assert.equal(HOAMembership.findOne.mock.calls.length, 1);
  });

  it('falls back to earliest active member when admin and creator are unavailable', async () => {
    HOA.findById = mock.fn(() =>
      makeLeanQuery({ name: 'Pine HOA', createdBy: CREATOR_ID })
    );
    HOAMembership.findOne = mock.fn((query) => {
      if (query.role === 'admin') return makeMembershipQuery(null);
      return makeMembershipQuery({ userId: MEMBER_ID });
    });
    User.findById = mock.fn((id) => {
      if (String(id) === MEMBER_ID) {
        return makeLeanQuery(
          userRecord(MEMBER_ID, { email: 'member@hoa.com', firstName: 'Active', lastName: 'Member' })
        );
      }
      return makeLeanQuery(null);
    });

    const { resolveCommunityEmailEnvelope } = loadService();
    const envelope = await resolveCommunityEmailEnvelope({ hoaId: HOA_ID });

    assert.deepEqual(envelope.replyTo, {
      name: 'Active Member',
      address: 'member@hoa.com',
    });
  });

  it('prefers senderUserId over HOA board contact for reply-to', async () => {
    HOA.findById = mock.fn(() =>
      makeLeanQuery({ name: 'Sender Priority HOA', createdBy: CREATOR_ID })
    );
    HOAMembership.findOne = mock.fn(() => makeMembershipQuery({ userId: ADMIN_ID }));
    User.findById = mock.fn((id) => {
      const key = String(id);
      if (key === SENDER_ID) {
        return makeLeanQuery(
          userRecord(SENDER_ID, { email: 'sender@hoa.com', firstName: 'Acting', lastName: 'Sender' })
        );
      }
      if (key === ADMIN_ID) {
        return makeLeanQuery(
          userRecord(ADMIN_ID, { email: 'admin@hoa.com', firstName: 'Board', lastName: 'Admin' })
        );
      }
      return makeLeanQuery(null);
    });

    const { resolveCommunityEmailEnvelope } = loadService();
    const envelope = await resolveCommunityEmailEnvelope({
      hoaId: HOA_ID,
      senderUserId: SENDER_ID,
    });

    assert.deepEqual(envelope.replyTo, {
      name: 'Acting Sender',
      address: 'sender@hoa.com',
    });
  });

  it('falls back to env reply-to when HOA lookup times out', async () => {
    process.env.COMMUNITY_EMAIL_CONTEXT_TIMEOUT_MS = '50';
    process.env.REPLY_TO = 'fallback@propmv.com';
    process.env.REPLY_TO_NAME = 'Fallback Support';

    HOA.findById = mock.fn(() => ({
      select: () => ({
        lean: () =>
          new Promise((resolve) => {
            setTimeout(
              () => resolve({ name: 'Slow HOA', createdBy: CREATOR_ID }),
              200
            );
          }),
      }),
    }));

    const warn = mock.method(console, 'warn', () => {});
    const { resolveCommunityEmailEnvelope } = loadService();
    const envelope = await resolveCommunityEmailEnvelope({ hoaId: HOA_ID });

    assert.deepEqual(envelope.replyTo, {
      name: 'Fallback Support',
      address: 'fallback@propmv.com',
    });
    assert.ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes('HOA contact lookup failed')));
    warn.mock.restore();
  });

  it('falls back to env reply-to when HOA lookup throws', async () => {
    HOA.findById = mock.fn(() => {
      throw new Error('db unavailable');
    });

    const warn = mock.method(console, 'warn', () => {});
    const { resolveCommunityEmailEnvelope } = loadService();
    const envelope = await resolveCommunityEmailEnvelope({ hoaId: HOA_ID });

    assert.deepEqual(envelope.replyTo, {
      name: 'PropMv Support',
      address: 'help@propmv.com',
    });
    assert.ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes('HOA contact lookup failed')));
    warn.mock.restore();
  });

  it('caches HOA contact resolution to avoid repeated DB hits', async () => {
    HOA.findById = mock.fn(() =>
      makeLeanQuery({ name: 'Cached HOA', createdBy: CREATOR_ID })
    );
    HOAMembership.findOne = mock.fn(() => makeMembershipQuery({ userId: ADMIN_ID }));
    User.findById = mock.fn(() =>
      makeLeanQuery(userRecord(ADMIN_ID, { email: 'admin@cached.com', firstName: 'Cached', lastName: 'Admin' }))
    );

    const { resolveCommunityEmailEnvelope } = loadService();
    await resolveCommunityEmailEnvelope({ hoaId: HOA_ID });
    await resolveCommunityEmailEnvelope({ hoaId: HOA_ID });

    assert.equal(HOA.findById.mock.calls.length, 1);
    assert.equal(HOAMembership.findOne.mock.calls.length, 1);
  });

  it('formatReplyTo returns address-only when name is missing', () => {
    const { formatReplyTo } = loadService();
    assert.equal(formatReplyTo({ email: 'only@example.com' }), 'only@example.com');
    assert.deepEqual(formatReplyTo({ name: 'Named', email: 'named@example.com' }), {
      name: 'Named',
      address: 'named@example.com',
    });
  });

  it('resolveCommunityName returns HOA name from direct lookup', async () => {
    HOA.findById = mock.fn(() => makeLeanQuery({ name: 'Sunset Valley HOA' }));

    const { resolveCommunityName } = loadService();
    const name = await resolveCommunityName(HOA_ID);
    assert.equal(name, 'Sunset Valley HOA');
    assert.equal(HOA.findById.mock.calls.length, 1);
  });

  it('buildCommunityEmailSubject appends community name without PropMv fallback', () => {
    const { buildCommunityEmailSubject } = loadService();
    assert.equal(
      buildCommunityEmailSubject('New invoice #INV597909', 'Sunset Valley HOA'),
      'New invoice #INV597909 - Sunset Valley HOA'
    );
    assert.equal(buildCommunityEmailSubject('Payment reminder', ''), 'Payment reminder');
  });
});
