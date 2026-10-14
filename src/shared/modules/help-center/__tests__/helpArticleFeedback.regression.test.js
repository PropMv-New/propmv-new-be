'use strict';

require('../../../../config/loadEnv');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { resolveRateLimitRules } = require('../../../../middleware/rateLimit/ruleMatcher');
const csrfProtection = require('../../../../middleware/csrfProtection');

describe('Help Center Feedback - Regression & Security Architecture Tests', () => {
  describe('Rate Limiting Regression (STEP 8)', () => {
    function mockReq({ method = 'GET', url = '/', headers = {}, body = {}, userId = null } = {}) {
      return {
        method,
        originalUrl: url,
        url,
        headers,
        body,
        userId,
      };
    }

    test('1. Anonymous GET uses public:endpoints rate limit tier with IP keyType', () => {
      const rules = resolveRateLimitRules(
        mockReq({
          method: 'GET',
          url: '/api/v1/help-center/articles/sample-article/feedback',
          headers: {},
        })
      );
      assert.equal(rules.length, 1);
      assert.equal(rules[0].name, 'public:endpoints');
      assert.equal(rules[0].keyType, 'ip');
    });

    test('2. Anonymous POST uses public:endpoints rate limit tier with IP keyType', () => {
      const rules = resolveRateLimitRules(
        mockReq({
          method: 'POST',
          url: '/api/v1/help-center/articles/sample-article/feedback',
          headers: { 'x-requested-with': 'XMLHttpRequest' },
        })
      );
      assert.equal(rules.length, 1);
      assert.equal(rules[0].name, 'public:endpoints');
      assert.equal(rules[0].keyType, 'ip');
    });

    test('3. Authenticated GET uses crud:get tier with user keyType', () => {
      const rules = resolveRateLimitRules(
        mockReq({
          method: 'GET',
          url: '/api/v1/help-center/articles/sample-article/feedback',
          headers: { authorization: 'Bearer some_token' },
          userId: '507f1f77bcf86cd799439011',
        })
      );
      assert.equal(rules.length, 1);
      assert.equal(rules[0].name, 'crud:get');
      assert.equal(rules[0].keyType, 'user');
    });

    test('4. Authenticated POST uses crud:post tier with user keyType', () => {
      const rules = resolveRateLimitRules(
        mockReq({
          method: 'POST',
          url: '/api/v1/help-center/articles/sample-article/feedback',
          headers: {
            authorization: 'Bearer some_token',
            'x-requested-with': 'XMLHttpRequest',
          },
          userId: '507f1f77bcf86cd799439011',
        })
      );
      assert.equal(rules.length, 1);
      assert.equal(rules[0].name, 'crud:post');
      assert.equal(rules[0].keyType, 'user');
    });

    test('5. No duplicate feedback-specific limiter was introduced', () => {
      const rules = resolveRateLimitRules(
        mockReq({
          method: 'POST',
          url: '/api/v1/help-center/articles/sample-article/feedback',
        })
      );
      assert.equal(
        rules.some((r) => r.name.includes('feedback')),
        false,
        'Should not introduce custom feedback limiter'
      );
    });

    test('6. Existing rate limit rules for unrelated paths remain unaffected', () => {
      const authRules = resolveRateLimitRules(
        mockReq({ method: 'POST', url: '/api/v1/auth/login', body: { email: 'test@example.com' } })
      );
      assert.equal(authRules[0].name, 'auth:login');

      const webhookRules = resolveRateLimitRules(
        mockReq({ method: 'POST', url: '/api/webhooks/straddle/test' })
      );
      assert.equal(webhookRules.length, 0);
    });
  });

  describe('CSRF Architecture Regression (STEP 7)', () => {
    test('1. Help Center feedback POST is NOT exempt from CSRF', () => {
      let nextCalled = false;
      let statusResult = null;
      let jsonResult = null;

      const req = {
        method: 'POST',
        path: '/api/v1/help-center/articles/sample-article/feedback',
        headers: {}, // Missing X-Requested-With
      };
      const res = {
        status: (code) => {
          statusResult = code;
          return {
            json: (data) => {
              jsonResult = data;
            },
          };
        },
      };

      csrfProtection(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false, 'Mutating Help Center request without CSRF must not proceed');
      assert.equal(statusResult, 403);
      assert.match(jsonResult.message, /X-Requested-With/i);
    });

    test('2. Unrelated public auth endpoints remain exempt from CSRF', () => {
      const exemptEndpoints = [
        '/api/v1/auth/login',
        '/api/v1/auth/signup',
        '/api/v1/auth/forgot-password',
      ];

      for (const ep of exemptEndpoints) {
        let nextCalled = false;
        const req = { method: 'POST', path: ep, headers: {} };
        csrfProtection(req, {}, () => {
          nextCalled = true;
        });
        assert.equal(nextCalled, true, `Endpoint ${ep} should remain exempt`);
      }
    });
  });

  describe('Module Independence & Clean Boundary Regression (STEP 9 & 10)', () => {
    test('1. Help Center route does NOT require HOA context, x-hoa-id, or Board privileges', () => {
      const routesFile = fs.readFileSync(
        path.resolve(__dirname, '../routes/helpArticleFeedback.routes.js'),
        'utf8'
      );

      // Verify no HOA middleware is referenced in help center routes
      assert.equal(routesFile.includes('hoaContext'), false);
      assert.equal(routesFile.includes('hoaBoard'), false);
      assert.equal(routesFile.includes('authorize'), false);
      assert.equal(routesFile.includes('lockCheckMiddleware'), false);
    });

    test('2. App route registration mounts at /api/v1/help-center without duplicate prefix', () => {
      const appFile = fs.readFileSync(
        path.resolve(__dirname, '../../../../app.js'),
        'utf8'
      );

      assert.ok(
        appFile.includes("app.use('/api/v1/help-center', helpCenterRouter);"),
        'helpCenterRouter must be mounted at /api/v1/help-center in app.js'
      );
      assert.equal(
        appFile.includes('/api/v1/api/v1/help-center'),
        false,
        'Duplicate /api/v1 prefix must not exist'
      );
    });

    test('3. ensureHoaIndexes registers helpArticleFeedback model for startup index sync', () => {
      const ensureHoaFile = fs.readFileSync(
        path.resolve(__dirname, '../../../../common/db/ensureHoaIndexes.js'),
        'utf8'
      );

      assert.ok(
        ensureHoaFile.includes('../../shared/modules/help-center/model/helpArticleFeedback.model'),
        'ensureHoaIndexes MODEL_PATHS must include helpArticleFeedback.model'
      );
    });

    test('4. Backend Help Center feedback does not query MongoDB for Sanity article documents', () => {
      const serviceFile = fs.readFileSync(
        path.resolve(__dirname, '../service/helpArticleFeedback.service.js'),
        'utf8'
      );

      // Service interacts ONLY with HelpArticleFeedback model
      assert.ok(serviceFile.includes("require('../model/helpArticleFeedback.model')"));
      assert.equal(serviceFile.includes("require('../../../../common/models/article')"), false);
      assert.equal(serviceFile.includes('SanityClient'), false);
    });
  });

  describe('Anonymous ID API Surface Verification (STEP 11)', () => {
    const { validateAnonymousId } = require('../validators/helpArticleFeedback.validator');

    test('1. Canonical x-anonymous-id UUID is accepted', () => {
      const canonicalId = '550e8400-e29b-41d4-a716-446655440000';
      assert.equal(validateAnonymousId(canonicalId, true), canonicalId);
    });

    test('2. Query/body fallback values use same strict UUID validation', () => {
      const queryFallback = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
      assert.equal(validateAnonymousId(queryFallback, true), queryFallback);

      const invalidFallback = 'malicious_non_uuid_script';
      assert.throws(
        () => validateAnonymousId(invalidFallback, true),
        /Invalid anonymous identifier format/
      );
    });
  });
});
