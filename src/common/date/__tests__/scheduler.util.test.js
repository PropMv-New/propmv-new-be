'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { ClockService, SchedulerUtil } = require('../index');

describe('SchedulerUtil', () => {
  afterEach(() => ClockService.reset());

  it('msUntilNextDailyRun schedules in business timezone, not server local', () => {
    // 2026-07-25 10:00 UTC = 06:00 ET - next 3am ET is tomorrow
    ClockService.setFixedTime('2026-07-25T10:00:00.000Z');
    const delay = SchedulerUtil.msUntilNextDailyRun(3, 0);
    assert.ok(delay > 0);
    assert.ok(delay < 24 * 60 * 60 * 1000);
  });

  it('msUntilNextScheduledRuns picks nearest future slot', () => {
    ClockService.setFixedTime('2026-07-25T10:00:00.000Z');
    const delay = SchedulerUtil.msUntilNextScheduledRuns([4, 16], 30);
    assert.ok(delay > 0);
  });
});
