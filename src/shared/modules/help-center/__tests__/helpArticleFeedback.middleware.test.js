'use strict';

require('../../../../config/loadEnv');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const optionalAuth = require('../middleware/optionalAuth.middleware');
const config = require('../../../../config/default');

describe('Help Center Feedback - Comprehensive optionalAuth Middleware Tests', () => {
  const secret = process.env.JWT_SECRET || config.jwt.secret || 'default_jwt_secret';

  test('1. No Authorization header: request proceeds and req.userId remains undefined', () => {
    const req = { headers: {} };
    const res = {};
    let nextCalled = false;

    optionalAuth(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(req.userId, undefined);
    assert.equal(req.user, undefined);
  });

  test('2 & 3. Valid Bearer token: req.userId is derived and req.user is populated correctly', () => {
    const payload = {
      sub: '507f1f77bcf86cd799439011',
      role: 'BoardMember',
      email: 'board@propmv.com',
    };
    const token = jwt.sign(payload, secret, { expiresIn: '1h' });

    const req = {
      headers: { authorization: `Bearer ${token}` },
    };
    const res = {};
    let nextCalled = false;

    optionalAuth(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(req.userId, '507f1f77bcf86cd799439011');
    assert.ok(req.user, 'req.user must be populated');
    assert.equal(req.user._id, '507f1f77bcf86cd799439011');
    assert.equal(req.user.id, '507f1f77bcf86cd799439011');
    assert.equal(req.user.role, 'BoardMember');
  });

  test('4. Malformed token: public request proceeds without throwing or becoming HTTP 401', () => {
    const malformedTokens = [
      'Bearer not-a-jwt',
      'Bearer abc.def',
      'Bearer ',
      'Bearer null',
    ];

    for (const authHeader of malformedTokens) {
      const req = { headers: { authorization: authHeader } };
      const res = {};
      let nextCalled = false;

      optionalAuth(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true, `Expected next() to be called for ${authHeader}`);
      assert.equal(req.userId, undefined);
      assert.equal(req.user, undefined);
    }
  });

  test('5. Expired token: public request proceeds anonymously without failing', () => {
    const payload = { sub: '507f1f77bcf86cd799439011', role: 'Owner' };
    const expiredToken = jwt.sign(payload, secret, { expiresIn: -10 }); // expired 10 seconds ago

    const req = {
      headers: { authorization: `Bearer ${expiredToken}` },
    };
    const res = {};
    let nextCalled = false;

    optionalAuth(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(req.userId, undefined);
    assert.equal(req.user, undefined);
  });

  test('6. Invalid token signature: public request proceeds anonymously', () => {
    const payload = { sub: '507f1f77bcf86cd799439011' };
    const forgedToken = jwt.sign(payload, 'wrong_untrusted_secret_key');

    const req = {
      headers: { authorization: `Bearer ${forgedToken}` },
    };
    const res = {};
    let nextCalled = false;

    optionalAuth(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(req.userId, undefined);
    assert.equal(req.user, undefined);
  });

  test('7. Client cannot inject req.userId through arbitrary request fields', () => {
    const maliciousReq = {
      headers: {
        'x-user-id': 'hacked_admin_id',
        'x-authenticated-user': 'hacked_admin_id',
      },
      body: {
        userId: 'hacked_admin_id',
      },
      query: {
        userId: 'hacked_admin_id',
      },
      params: {
        userId: 'hacked_admin_id',
      },
    };
    const res = {};
    let nextCalled = false;

    optionalAuth(maliciousReq, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(maliciousReq.userId, undefined);
    assert.equal(maliciousReq.user, undefined);
  });

  test('8. Non-Bearer Authorization headers are ignored safely', () => {
    const nonBearerHeaders = [
      'Basic dXNlcjpwYXNz',
      'Token some_api_token',
      'Digest username="test"',
      'BearerNoSpace',
    ];

    for (const authorization of nonBearerHeaders) {
      const req = { headers: { authorization } };
      let nextCalled = false;
      optionalAuth(req, {}, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);
      assert.equal(req.userId, undefined);
    }
  });

  test('9. If req.userId is already established upstream, optionalAuth preserves it', () => {
    const req = {
      userId: 'pre_existing_authenticated_user',
      user: { _id: 'pre_existing_authenticated_user' },
      headers: {},
    };
    let nextCalled = false;
    optionalAuth(req, {}, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(req.userId, 'pre_existing_authenticated_user');
  });
});
