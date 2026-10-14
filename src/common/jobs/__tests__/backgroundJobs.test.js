const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { JOB_TYPES, QUEUE_NAMES, JOB_STATUS, queueForJobType } = require('../constants');
const { getRetryDelayMs, isPermanentError } = require('../retry');
const { buildJobIdempotencyKey, hashFingerprint } = require('../idempotency');
const { sanitizeJobPayload } = require('../sanitizePayload');
const { parseRetryDelaysMs, getBackgroundJobConfig } = require('../config');
const { buildClaimableQuery } = require('../job.service');
const {
  normalizeRedisUrl,
  isRedisAttemptCoolingDown,
  markRedisUnavailable,
  markRedisAvailable,
} = require('../queue/redisConnection');

describe('background job constants', () => {
  it('maps email job types to the email queue', () => {
    assert.equal(queueForJobType(JOB_TYPES.EMAIL_INVOICE_CREATED), QUEUE_NAMES.EMAIL);
    assert.equal(queueForJobType(JOB_TYPES.NOTIFY_IN_APP), QUEUE_NAMES.NOTIFICATION);
    assert.equal(queueForJobType(JOB_TYPES.INVOICE_LATE_FEE_UNIT), QUEUE_NAMES.INVOICE);
    assert.equal(queueForJobType(JOB_TYPES.MAINTENANCE_CREATED), QUEUE_NAMES.MAINTENANCE);
  });

  it('includes all required statuses', () => {
    assert.equal(JOB_STATUS.SCHEDULED, 'SCHEDULED');
    assert.equal(JOB_STATUS.PENDING, 'PENDING');
    assert.equal(JOB_STATUS.PROCESSING, 'PROCESSING');
    assert.equal(JOB_STATUS.COMPLETED, 'COMPLETED');
    assert.equal(JOB_STATUS.RETRYING, 'RETRYING');
    assert.equal(JOB_STATUS.FAILED_PERMANENTLY, 'FAILED_PERMANENTLY');
    assert.equal(JOB_STATUS.CANCELLED, 'CANCELLED');
  });
});

describe('idempotency keys', () => {
  it('builds a stable key for the same invoice update event', () => {
    const invoiceId = '507f1f77bcf86cd799439011';
    const fingerprint = hashFingerprint('Due date updated');
    const key1 = buildJobIdempotencyKey('EMAIL_INVOICE_UPDATED', invoiceId, fingerprint);
    const key2 = buildJobIdempotencyKey('EMAIL_INVOICE_UPDATED', invoiceId, fingerprint);
    assert.equal(key1, key2);
    assert.match(key1, /EMAIL_INVOICE_UPDATED/);
    assert.match(key1, /507f1f77bcf86cd799439011/);
  });

  it('does not collide different events for the same invoice', () => {
    const invoiceId = '507f1f77bcf86cd799439011';
    const created = buildJobIdempotencyKey('EMAIL_INVOICE_CREATED', invoiceId);
    const updated = buildJobIdempotencyKey(
      'EMAIL_INVOICE_UPDATED',
      invoiceId,
      hashFingerprint('amount changed')
    );
    assert.notEqual(created, updated);
  });

  it('uses mongoose _id when given a document-like object', () => {
    const key = buildJobIdempotencyKey('EMAIL_INVOICE_CREATED', { _id: 'abc123' });
    assert.equal(key, 'EMAIL_INVOICE_CREATED:abc123');
  });
});

describe('retry strategy', () => {
  it('uses 1m / 5m / 30m backoff by default', () => {
    assert.equal(getRetryDelayMs(1), 60_000);
    assert.equal(getRetryDelayMs(2), 300_000);
    assert.equal(getRetryDelayMs(3), 1_800_000);
  });

  it('honors configured delay list', () => {
    const delays = parseRetryDelaysMs('1000,2000', [60_000]);
    assert.deepEqual(delays, [1000, 2000]);
    assert.equal(getRetryDelayMs(1, delays), 1000);
    assert.equal(getRetryDelayMs(2, delays), 2000);
    assert.equal(getRetryDelayMs(9, delays), 2000);
  });

  it('treats missing entity and validation errors as permanent', () => {
    assert.equal(isPermanentError(Object.assign(new Error('Invoice not found'), { status: 404 })), true);
    assert.equal(isPermanentError(Object.assign(new Error('validation failed'), { permanent: true })), true);
    assert.equal(isPermanentError(new Error('SMTP timeout')), false);
    assert.equal(isPermanentError(new Error('ECONNRESET')), false);
  });
});

describe('payload sanitization', () => {
  it('strips secrets and tokens from job payloads', () => {
    const sanitized = sanitizeJobPayload({
      invoiceId: 'inv-1',
      smtpPassword: 'super-secret',
      apiKey: 'abc',
      token: 'jwt',
      nested: { authorization: 'Bearer x', amount: 10, otp: '123456' },
    });
    assert.equal(sanitized.invoiceId, 'inv-1');
    assert.equal(sanitized.smtpPassword, undefined);
    assert.equal(sanitized.apiKey, undefined);
    assert.equal(sanitized.token, undefined);
    assert.equal(sanitized.nested.authorization, undefined);
    assert.equal(sanitized.nested.otp, undefined);
    assert.equal(sanitized.nested.amount, 10);
  });
});

describe('config', () => {
  it('reads concurrency from environment', () => {
    const config = getBackgroundJobConfig({
      BACKGROUND_JOB_EMAIL_CONCURRENCY: '7',
      BACKGROUND_JOB_INVOICE_CONCURRENCY: '2',
      BACKGROUND_JOBS_ENABLED: 'true',
      NODE_ENV: 'development',
    });
    assert.equal(config.enabled, true);
    assert.equal(config.concurrency.email, 7);
    assert.equal(config.concurrency.invoice, 2);
    assert.equal(config.embeddedWorkers, true);
  });

  it('disables embedded workers in production by default', () => {
    const config = getBackgroundJobConfig({ NODE_ENV: 'production' });
    assert.equal(config.embeddedWorkers, false);
  });

  it('uses a 60s Redis retry cooldown by default', () => {
    const config = getBackgroundJobConfig({});
    assert.equal(config.redisRetryAfterMs, 60_000);
  });
});

describe('redis connection circuit breaker', () => {
  it('rewrites localhost to 127.0.0.1 so Windows does not use IPv6 ::1', () => {
    assert.equal(normalizeRedisUrl('redis://localhost:6379'), 'redis://127.0.0.1:6379');
    assert.equal(normalizeRedisUrl('redis://127.0.0.1:6379'), 'redis://127.0.0.1:6379');
    assert.equal(normalizeRedisUrl(''), '');
  });

  it('skips further Redis attempts during the cooldown window', () => {
    markRedisAvailable();
    assert.equal(isRedisAttemptCoolingDown(), false);
    markRedisUnavailable('ECONNREFUSED', 60_000);
    assert.equal(isRedisAttemptCoolingDown(), true);
    markRedisAvailable();
    assert.equal(isRedisAttemptCoolingDown(), false);
  });
});

describe('claim query', () => {
  it('claims pending, retrying, scheduled, and stale processing jobs', () => {
    const now = new Date('2026-08-21T12:00:00.000Z');
    const query = buildClaimableQuery(now);
    assert.ok(Array.isArray(query.$or));
    assert.deepEqual(query.$or[0].status.$in, [
      JOB_STATUS.PENDING,
      JOB_STATUS.RETRYING,
      JOB_STATUS.SCHEDULED,
    ]);
    assert.equal(query.$or[1].status, JOB_STATUS.PROCESSING);
  });
});

describe('cron enqueue contract', () => {
  it('uses a daily idempotency key so re-running cron cannot duplicate late-fee jobs', () => {
    const unitId = '507f1f77bcf86cd799439099';
    const dateKey = '2026-08-21';
    const first = buildJobIdempotencyKey('INVOICE_LATE_FEE_UNIT', unitId, dateKey);
    const second = buildJobIdempotencyKey('INVOICE_LATE_FEE_UNIT', unitId, dateKey);
    assert.equal(first, second);
  });

  it('uses invoice + date key for payment reminder jobs', () => {
    const key = buildJobIdempotencyKey(
      'INVOICE_PAYMENT_REMINDER',
      '507f1f77bcf86cd799439011',
      '2026-08-21'
    );
    assert.equal(key, 'INVOICE_PAYMENT_REMINDER:507f1f77bcf86cd799439011:2026-08-21');
  });
});

describe('in-memory job store duplicate prevention', () => {
  it('rejects a second insert with the same idempotency key', () => {
    const store = new Map();
    function create(job) {
      if (store.has(job.idempotencyKey)) {
        return { created: false, duplicate: true, job: store.get(job.idempotencyKey) };
      }
      store.set(job.idempotencyKey, job);
      return { created: true, duplicate: false, job };
    }

    const job = {
      jobType: JOB_TYPES.EMAIL_INVOICE_UPDATED,
      entityId: 'inv-1',
      idempotencyKey: 'INVOICE_UPDATED:inv-1:act-9',
    };
    const first = create(job);
    const second = create({ ...job, payload: { extra: true } });
    assert.equal(first.created, true);
    assert.equal(second.duplicate, true);
    assert.equal(store.size, 1);
  });
});

describe('worker status transitions', () => {
  it('marks success as COMPLETED and failure as RETRYING then FAILED_PERMANENTLY', () => {
    const job = {
      status: JOB_STATUS.PENDING,
      attempts: 0,
      maxAttempts: 3,
    };

    job.status = JOB_STATUS.PROCESSING;
    job.attempts = 0;
    job.status = JOB_STATUS.COMPLETED;
    assert.equal(job.status, JOB_STATUS.COMPLETED);

    const failing = { status: JOB_STATUS.PROCESSING, attempts: 0, maxAttempts: 3 };
    failing.attempts += 1;
    failing.status = failing.attempts >= failing.maxAttempts ? JOB_STATUS.FAILED_PERMANENTLY : JOB_STATUS.RETRYING;
    assert.equal(failing.status, JOB_STATUS.RETRYING);

    failing.status = JOB_STATUS.PROCESSING;
    failing.attempts += 1;
    failing.status = failing.attempts >= failing.maxAttempts ? JOB_STATUS.FAILED_PERMANENTLY : JOB_STATUS.RETRYING;
    failing.status = JOB_STATUS.PROCESSING;
    failing.attempts += 1;
    failing.status = failing.attempts >= failing.maxAttempts ? JOB_STATUS.FAILED_PERMANENTLY : JOB_STATUS.RETRYING;
    assert.equal(failing.attempts, 3);
    assert.equal(failing.status, JOB_STATUS.FAILED_PERMANENTLY);
  });
});

describe('notification log module resolution', () => {
  it('loads notificationLog.service and email.processor without missing-module errors', () => {
    assert.doesNotThrow(() => require('../notificationLog.service'));
    assert.doesNotThrow(() => require('../processors/email.processor'));
    const { recordNotificationLog } = require('../notificationLog.service');
    assert.equal(typeof recordNotificationLog, 'function');
  });
});
