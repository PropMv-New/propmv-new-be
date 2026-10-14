'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const jobsEnqueue = require('../../../../../common/jobs/enqueue');
const jobsConfig = require('../../../../../common/jobs/config');
const { ClockService } = require('../../../../../common/date');
const { JOB_TYPES } = require('../../../../../common/jobs/constants');
const {
  enqueueMidnightInvoiceExtensions,
} = require('../services/hoaInvoiceExtensionScheduler.service');

describe('enqueueMidnightInvoiceExtensions', () => {
  const originalEnqueue = jobsEnqueue.enqueueBackgroundJob;
  const originalEnabled = jobsConfig.isBackgroundJobsEnabled;
  let seenKeys;
  let enqueueCalls;

  beforeEach(() => {
    seenKeys = new Set();
    enqueueCalls = [];
    jobsConfig.isBackgroundJobsEnabled = () => true;
    jobsEnqueue.enqueueBackgroundJob = async (job) => {
      enqueueCalls.push(job);
      if (seenKeys.has(job.idempotencyKey)) {
        return { duplicate: true };
      }
      seenKeys.add(job.idempotencyKey);
      return { duplicate: false };
    };
  });

  afterEach(() => {
    jobsEnqueue.enqueueBackgroundJob = originalEnqueue;
    jobsConfig.isBackgroundJobsEnabled = originalEnabled;
    ClockService.reset();
  });

  it('returns empty totals when no property is at midnight', async () => {
    const result = await enqueueMidnightInvoiceExtensions({ midnightZones: [] });
    assert.deepEqual(result, {
      processed: 0,
      enqueued: 0,
      duplicate: 0,
      failed: 0,
      midnightZones: [],
    });
    assert.equal(enqueueCalls.length, 0);
  });

  it('enqueues one next-year job per midnight timezone and isolates NY from LA', async () => {
    ClockService.setFixedTime('2026-09-14T04:00:00.000Z');
    const result = await enqueueMidnightInvoiceExtensions({
      midnightZones: ['America/New_York', 'America/Los_Angeles'],
    });

    assert.equal(result.enqueued, 2);
    assert.equal(result.duplicate, 0);
    assert.equal(enqueueCalls.length, 2);
    assert.equal(enqueueCalls[0].jobType, JOB_TYPES.INVOICE_EXTENSION_ALL);
    assert.equal(enqueueCalls[0].payload.billingTimezone, 'America/New_York');
    assert.equal(enqueueCalls[1].payload.billingTimezone, 'America/Los_Angeles');
    assert.notEqual(enqueueCalls[0].idempotencyKey, enqueueCalls[1].idempotencyKey);
  });

  it('second enqueue for the same timezone and date is duplicate, not a second invoice run', async () => {
    ClockService.setFixedTime('2026-09-14T04:00:00.000Z');
    const first = await enqueueMidnightInvoiceExtensions({
      midnightZones: ['America/New_York'],
    });
    const second = await enqueueMidnightInvoiceExtensions({
      midnightZones: ['America/New_York'],
    });

    assert.equal(first.enqueued, 1);
    assert.equal(first.duplicate, 0);
    assert.equal(second.enqueued, 0);
    assert.equal(second.duplicate, 1);
    assert.equal(enqueueCalls.length, 2);
    assert.equal(enqueueCalls[0].idempotencyKey, enqueueCalls[1].idempotencyKey);
  });
});
