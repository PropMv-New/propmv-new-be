const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveRateLimitRules } = require('../middleware/rateLimit/ruleMatcher');
const rateLimitService = require('../services/rateLimit.service');

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

test('signup is limited by IP at 5 per 15 minutes', () => {
  const rules = resolveRateLimitRules(
    mockReq({ method: 'POST', url: '/api/v1/auth/signup' })
  );
  assert.equal(rules.length, 1);
  assert.equal(rules[0].name, 'auth:signup');
  assert.equal(rules[0].limit, 5);
  assert.equal(rules[0].windowMs, 15 * 60 * 1000);
  assert.equal(rules[0].keyType, 'ip');
});

test('login is limited by user+IP at 10 per 15 minutes', () => {
  const rules = resolveRateLimitRules(
    mockReq({ method: 'POST', url: '/api/v1/auth/login', body: { email: 'a@example.com' } })
  );
  assert.equal(rules[0].name, 'auth:login');
  assert.equal(rules[0].limit, 10);
  assert.equal(rules[0].keyType, 'userIp');
});

test('send MFA applies send limit without fixed cooldown rule', () => {
  const rules = resolveRateLimitRules(
    mockReq({ method: 'POST', url: '/api/v1/auth/send-mfa-otp', body: { email: 'a@example.com' } })
  );
  assert.equal(rules.length, 1);
  assert.equal(rules[0].name, 'auth:send-otp');
  assert.equal(rules[0].limit, 4);
});

test('bulk upload maps to bulk tier', () => {
  const rules = resolveRateLimitRules(
    mockReq({
      method: 'POST',
      url: '/api/v1/landlord/tenants/import',
      headers: { authorization: 'Bearer test' },
    })
  );
  assert.equal(rules[0].name, 'upload:bulk');
  assert.equal(rules[0].limit, 3);
  assert.equal(rules[0].windowMs, 10 * 60 * 1000);
});

test('webhooks are exempt from rate limiting', () => {
  const rules = resolveRateLimitRules(
    mockReq({ method: 'POST', url: '/api/webhooks/straddle/payment-event' })
  );
  assert.equal(rules.length, 0);
});

test('notification GET uses dedicated tier (not CRUD read bucket)', () => {
  const rules = resolveRateLimitRules(
    mockReq({
      method: 'GET',
      url: '/api/v1/notifications?unread=true&hoaId=abc',
      headers: { authorization: 'Bearer test' },
    })
  );
  assert.equal(rules.length, 1);
  assert.equal(rules[0].name, 'notifications:get');
  assert.equal(rules[0].limit, 300);
});

test('authenticated GET uses CRUD read tier', () => {
  const rules = resolveRateLimitRules(
    mockReq({
      method: 'GET',
      url: '/api/v1/hoa/property',
      headers: { authorization: 'Bearer test' },
    })
  );
  assert.equal(rules[0].name, 'crud:get');
  assert.equal(rules[0].limit, 120);
});

test('owner create invite is rate-limited more tightly than CRUD POST', () => {
  const rules = resolveRateLimitRules(
    mockReq({ method: 'POST', url: '/api/v1/hoa/owners', userId: 'u1' })
  );
  assert.equal(rules.length, 1);
  assert.equal(rules[0].name, 'email-invite:create-owner');
  assert.equal(rules[0].limit, 20);
  assert.equal(rules[0].keyType, 'user');
});

test('owner resend-invite is rate-limited', () => {
  const rules = resolveRateLimitRules(
    mockReq({
      method: 'POST',
      url: '/api/v1/hoa/owners/507f1f77bcf86cd799439011/resend-invite',
      userId: 'u1',
    })
  );
  assert.equal(rules[0].name, 'email-invite:resend');
  assert.equal(rules[0].limit, 5);
});

test('system bounce webhook paths are exempt from rate limiting', () => {
  const rules = resolveRateLimitRules(
    mockReq({ method: 'POST', url: '/api/v1/system/email-bounces' })
  );
  assert.deepEqual(rules, []);
});

test('system email-suppressions paths are exempt from rate limiting', () => {
  const rules = resolveRateLimitRules(
    mockReq({ method: 'GET', url: '/api/v1/system/email-suppressions' })
  );
  assert.deepEqual(rules, []);
});

test('in-memory sliding window blocks after limit', async () => {
  const key = `test:${Date.now()}`;
  const limit = 3;
  const windowMs = 60 * 1000;

  const first = await rateLimitService.consume(key, limit, windowMs);
  const second = await rateLimitService.consume(key, limit, windowMs);
  const third = await rateLimitService.consume(key, limit, windowMs);
  const fourth = await rateLimitService.consume(key, limit, windowMs);

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(third.allowed, true);
  assert.equal(fourth.allowed, false);
  assert.ok(fourth.retryAfterSeconds >= 1);
});
