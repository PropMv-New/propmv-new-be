const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const EVENTS = require('../../../../../common/notifications/notificationEvents');
const { effectiveDateKey } = require('../services/ownershipChangeNotification.service');

describe('ownership change notifications', () => {
  it('defines scheduled and effective notification events', () => {
    assert.equal(EVENTS.OWNERSHIP_CHANGE_SCHEDULED.type, 'ownership_change_scheduled');
    assert.equal(EVENTS.OWNERSHIP_CHANGE_EFFECTIVE.type, 'ownership_change_effective');

    const scheduledMessage = EVENTS.OWNERSHIP_CHANGE_SCHEDULED.message({
      unitLabel: 'Sunset Garden · 43',
      currentOwnerNames: 'Owner A',
      futureOwnerNames: 'Owner B',
      effectiveDateLabel: 'September 1, 2026',
    });
    assert.match(scheduledMessage, /has not taken effect yet/i);
    assert.match(scheduledMessage, /Owner A/);
    assert.match(scheduledMessage, /Owner B/);

    const effectiveMessage = EVENTS.OWNERSHIP_CHANGE_EFFECTIVE.message({
      unitLabel: 'Sunset Garden · 43',
      previousOwnerNames: 'Owner A',
      newOwnerNames: 'Owner B',
      effectiveDateLabel: 'September 1, 2026',
    });
    assert.match(effectiveMessage, /now effective/i);
    assert.match(effectiveMessage, /Owner B/);
  });

  it('builds stable effective date keys for idempotency', () => {
    const key = effectiveDateKey(new Date('2026-09-01T12:00:00.000Z'));
    assert.equal(key, '2026-09-01');
  });
});
