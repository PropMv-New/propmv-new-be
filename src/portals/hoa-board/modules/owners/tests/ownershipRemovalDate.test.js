const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { INVOICE_STATUS } = require('../../../../../common/constants/invoice');
const {
  getActiveOwnerIdsFromRecords,
  ownershipActivityAtAfterEffectiveDate,
  ownershipActivityAtForCurrentAssociation,
  findOwnershipRecordForRemoval,
  resolveRemainingOwnerIdsAfterRemoval,
  ownershipRecordOverlapsEffectiveDate,
  toDateAtStartOfDay,
  CO_OWNER_REMOVE_INVOICE_REASSIGN_STATUSES,
  assertOwnershipEffectiveDateNotInPast,
  isFutureCalendarEffectiveDate,
  removalEndInstantForEffectiveDate,
} = require('../services/unit.service');

describe('ownership removal date helpers', () => {
  const ownerId = '6a77038d58c4a71f29801ede';
  const coOwnerId = '6a7ae99a630e813ee633f348';

  it('excludes owners ended at noon when evaluating after the effective date', () => {
    const noon = new Date('2026-08-11T12:00:00.000Z');
    const morning = new Date('2026-08-11T08:23:00.000Z');
    const records = [
      {
        ownerId,
        startDate: new Date('2026-08-02T12:00:00.000Z'),
        endDate: noon,
      },
    ];

    // Bug regression: evaluating at morning still treated noon-ended owner as active
    assert.deepEqual(getActiveOwnerIdsFromRecords(records, morning), [ownerId]);

    const at = ownershipActivityAtAfterEffectiveDate(noon, morning);
    assert.deepEqual(getActiveOwnerIdsFromRecords(records, at), []);
  });

  it('heals associated owner whose timeline already ended on the selected day', () => {
    const noon = new Date('2026-08-11T12:00:00.000Z');
    const now = new Date('2026-08-11T08:32:00.000Z');
    const records = [
      {
        ownerId,
        startDate: new Date('2026-08-02T12:00:00.000Z'),
        endDate: noon,
      },
    ];

    const found = findOwnershipRecordForRemoval({
      ownershipRecords: records,
      ownerId,
      associatedOwnerIds: [ownerId],
      removalEndDate: now,
      effectiveKey: '2026-08-11',
      now,
    });

    assert.ok(found);
    assert.equal(found.ownerId, ownerId);
    assert.equal(found.endDate.toISOString(), noon.toISOString());
  });

  it('finds a still-open record for a normal today removal', () => {
    const now = new Date('2026-08-11T08:32:00.000Z');
    const records = [
      {
        ownerId,
        startDate: new Date('2026-08-02T12:00:00.000Z'),
        endDate: null,
      },
    ];

    const found = findOwnershipRecordForRemoval({
      ownershipRecords: records,
      ownerId,
      associatedOwnerIds: [ownerId],
      removalEndDate: now,
      effectiveKey: '2026-08-11',
      now,
    });

    assert.ok(found);
    assert.equal(found.endDate, null);
  });

  it('keeps co-owners when removing one owner before calendar-noon start anchors', () => {
    const noon = new Date('2026-08-11T12:00:00.000Z');
    const morning = new Date('2026-08-11T09:32:00.000Z');
    const records = [
      {
        ownerId,
        startDate: noon,
        endDate: morning, // closed by this removal
      },
      {
        ownerId: coOwnerId,
        startDate: noon,
        endDate: null,
      },
    ];

    // Timeline-only evaluation wrongly looks ownerless before noon
    const at = ownershipActivityAtAfterEffectiveDate(morning, morning);
    assert.deepEqual(getActiveOwnerIdsFromRecords(records, at), []);

    const remaining = resolveRemainingOwnerIdsAfterRemoval({
      previousOwnerIds: [ownerId, coOwnerId],
      removedOwnerId: ownerId,
      ownershipRecords: records,
      removalEndDate: morning,
      isRemovalToday: true,
      now: morning,
    });

    assert.deepEqual(remaining, [coOwnerId]);
  });

  it('treats sole associated owner removal as last-owner', () => {
    const noon = new Date('2026-08-11T12:00:00.000Z');
    const morning = new Date('2026-08-11T09:32:00.000Z');
    const records = [
      {
        ownerId,
        startDate: noon,
        endDate: morning,
      },
    ];

    const remaining = resolveRemainingOwnerIdsAfterRemoval({
      previousOwnerIds: [ownerId],
      removedOwnerId: ownerId,
      ownershipRecords: records,
      removalEndDate: morning,
      isRemovalToday: true,
      now: morning,
    });

    assert.deepEqual(remaining, []);
  });

  it('allows re-add after same-day remove when start date is YYYY-MM-DD', () => {
    const {
      toDateAtStartOfDay,
      ownershipRecordOverlapsEffectiveDate,
    } = require('../services/unit.service');

    // Date-only strings must not shift back a day in America/New_York.
    const effectiveDate = toDateAtStartOfDay('2026-08-11');
    assert.equal(effectiveDate.toISOString(), '2026-08-11T12:00:00.000Z');

    const closedSameMorning = {
      ownerId,
      startDate: new Date('2026-08-10T12:00:00.000Z'),
      endDate: new Date('2026-08-11T09:59:01.047Z'),
    };
    const closedSameAfternoon = {
      ownerId,
      startDate: new Date('2026-08-10T12:00:00.000Z'),
      endDate: new Date('2026-08-11T20:16:00.000Z'),
    };
    const invertedNoonRow = {
      ownerId,
      startDate: new Date('2026-08-11T12:00:00.000Z'),
      endDate: new Date('2026-08-11T09:57:31.221Z'),
    };

    assert.equal(ownershipRecordOverlapsEffectiveDate(closedSameMorning, effectiveDate), false);
    assert.equal(ownershipRecordOverlapsEffectiveDate(closedSameAfternoon, effectiveDate), false);
    assert.equal(ownershipRecordOverlapsEffectiveDate(invertedNoonRow, effectiveDate), false);

    const stillOpen = {
      ownerId,
      startDate: new Date('2026-08-10T12:00:00.000Z'),
      endDate: null,
    };
    assert.equal(ownershipRecordOverlapsEffectiveDate(stillOpen, effectiveDate), true);
  });

  it('still blocks re-add while a future-dated removal keeps the owner active', () => {
    const effectiveDate = toDateAtStartOfDay('2026-08-24');
    const scheduledEnd = {
      ownerId,
      startDate: new Date('2026-08-01T12:00:00.000Z'),
      endDate: new Date('2026-09-01T12:00:00.000Z'),
    };

    assert.equal(ownershipRecordOverlapsEffectiveDate(scheduledEnd, effectiveDate), true);
    assert.equal(
      ownershipRecordOverlapsEffectiveDate(scheduledEnd, toDateAtStartOfDay('2026-09-01')),
      false
    );
  });

  it('reassigns open unpaid invoices, including overdue, when removing a co-owner', () => {
    // Regression: Owner A + Owner B on an overdue invoice → remove Owner A
    // must rewrite invoice.tenants to remaining owners, not keep Owner A.
    assert.deepEqual(CO_OWNER_REMOVE_INVOICE_REASSIGN_STATUSES, [
      INVOICE_STATUS.PENDING,
      INVOICE_STATUS.PARTIALLY_PAID,
      INVOICE_STATUS.OVERDUE,
    ]);
    assert.equal(
      CO_OWNER_REMOVE_INVOICE_REASSIGN_STATUSES.includes(INVOICE_STATUS.PROCESSING),
      false
    );
    assert.equal(
      CO_OWNER_REMOVE_INVOICE_REASSIGN_STATUSES.includes(INVOICE_STATUS.PAID),
      false
    );
  });

  it('rejects past ownership effective dates', () => {
    assert.throws(
      () => assertOwnershipEffectiveDateNotInPast('2020-01-01', 'Effective date'),
      (err) => err?.status === 400 && /cannot be in the past/i.test(err.message)
    );
  });

  it('allows today and future ownership effective dates for remove flow', () => {
    assert.doesNotThrow(() => assertOwnershipEffectiveDateNotInPast(new Date()));
    assert.doesNotThrow(() =>
      assertOwnershipEffectiveDateNotInPast('2099-12-31', 'Effective transfer date')
    );
  });

  it('rejects add/change effective dates before Balance as of', () => {
    const {
      assertOwnershipEffectiveDateWithinBalanceWindow,
    } = require('../services/unit.service');
    assert.throws(
      () =>
        assertOwnershipEffectiveDateWithinBalanceWindow(
          '2026-02-28',
          '2026-03-01',
          'Effective date'
        ),
      (err) => err?.status === 400 && /Balance as of/i.test(err.message)
    );
  });

  it('allows add/change effective dates from Balance as of through today', () => {
    const {
      assertOwnershipEffectiveDateWithinBalanceWindow,
    } = require('../services/unit.service');
    const { getDateKeyInTimeZone } = require('../../../../../common/helpers/hoaBillingDates');
    const { ClockService } = require('../../../../../common/date');
    const todayKey = getDateKeyInTimeZone(ClockService.now());
    assert.doesNotThrow(() =>
      assertOwnershipEffectiveDateWithinBalanceWindow(todayKey, '2026-03-01', 'Effective date')
    );
    assert.doesNotThrow(() =>
      assertOwnershipEffectiveDateWithinBalanceWindow('2026-03-01', '2026-03-01', 'Effective date')
    );
  });

  it('rejects add/change future effective dates', () => {
    const {
      assertOwnershipEffectiveDateWithinBalanceWindow,
    } = require('../services/unit.service');
    assert.throws(
      () =>
        assertOwnershipEffectiveDateWithinBalanceWindow(
          '2099-12-31',
          '2026-03-01',
          'Effective transfer date'
        ),
      (err) => err?.status === 400 && /cannot be in the future/i.test(err.message)
    );
  });

  it('resolves ownership period status for scheduled future removal', () => {
    const {
      resolveOwnershipPeriodForOwner,
    } = require('../services/unit.service');
    const ownerId = '6a77038d58c4a71f29801ede';
    const now = new Date('2026-08-29T15:00:00.000Z');
    const endDate = new Date('2026-09-05T12:00:00.000Z');
    const unit = {
      associatedOwnerIds: [ownerId],
      ownershipRecords: [
        {
          ownerId,
          startDate: new Date('2026-03-01T12:00:00.000Z'),
          endDate,
        },
      ],
      createdAt: new Date('2026-01-01T12:00:00.000Z'),
    };

    const period = resolveOwnershipPeriodForOwner(unit, ownerId, now);
    assert.equal(period.status, 'scheduled_removal');
    assert.equal(period.endDate.toISOString(), endDate.toISOString());
  });

  it('resolves ownership period status as removed after end date', () => {
    const {
      resolveOwnershipPeriodForOwner,
    } = require('../services/unit.service');
    const ownerId = '6a77038d58c4a71f29801ede';
    const now = new Date('2026-09-06T15:00:00.000Z');
    const unit = {
      associatedOwnerIds: [],
      ownershipRecords: [
        {
          ownerId,
          startDate: new Date('2026-03-01T12:00:00.000Z'),
          endDate: new Date('2026-09-05T12:00:00.000Z'),
        },
      ],
      createdAt: new Date('2026-01-01T12:00:00.000Z'),
    };

    const period = resolveOwnershipPeriodForOwner(unit, ownerId, now);
    assert.equal(period.status, 'removed');
  });

  it('resolves ownership effective date from timeline startDate', () => {
    const {
      resolveOwnershipEffectiveDateForOwner,
    } = require('../services/unit.service');
    const ownerId = '6a77038d58c4a71f29801ede';
    const start = new Date('2026-03-01T12:00:00.000Z');
    const unit = {
      associatedOwnerIds: [ownerId],
      ownershipRecords: [
        {
          ownerId,
          startDate: start,
          endDate: null,
        },
      ],
      createdAt: new Date('2026-01-01T12:00:00.000Z'),
    };
    const resolved = resolveOwnershipEffectiveDateForOwner(unit, ownerId);
    assert.ok(resolved);
    assert.equal(resolved.toISOString(), start.toISOString());
  });

  it('keeps current owners associated when change ownership effective date is in the future', () => {
    const now = new Date('2026-08-24T15:00:00.000Z');
    const futureEffective = toDateAtStartOfDay('2026-09-01');
    const ownerA = '6a77038d58c4a71f29801ede';
    const ownerB = '6a7ae99a630e813ee633f348';
    const records = [
      {
        ownerId: ownerA,
        startDate: new Date('2026-01-01T12:00:00.000Z'),
        endDate: futureEffective,
      },
      {
        ownerId: ownerB,
        startDate: futureEffective,
        endDate: null,
      },
    ];

    const atFutureAssociation = ownershipActivityAtForCurrentAssociation(futureEffective, now);
    assert.equal(atFutureAssociation.toISOString(), now.toISOString());
    assert.deepEqual(getActiveOwnerIdsFromRecords(records, atFutureAssociation), [ownerA]);
    assert.deepEqual(getActiveOwnerIdsFromRecords(records, new Date('2026-09-01T15:00:00.000Z')), [ownerB]);
  });

  it('activates new owners immediately for same-day change ownership', () => {
    const now = new Date('2026-08-24T09:00:00.000Z');
    const todayEffective = toDateAtStartOfDay('2026-08-24');
    const ownerA = '6a77038d58c4a71f29801ede';
    const ownerB = '6a7ae99a630e813ee633f348';
    const records = [
      {
        ownerId: ownerA,
        startDate: new Date('2026-01-01T12:00:00.000Z'),
        endDate: todayEffective,
      },
      {
        ownerId: ownerB,
        startDate: todayEffective,
        endDate: null,
      },
    ];

    const at = ownershipActivityAtForCurrentAssociation(todayEffective, now);
    assert.deepEqual(getActiveOwnerIdsFromRecords(records, at), [ownerB]);

    // Read path must match write path before wall-clock noon (email/UI consistency).
    const {
      getCurrentOwnerIdsFromUnit,
    } = require('../services/unit.service');
    const unit = {
      associatedOwnerIds: [ownerB],
      ownershipRecords: records,
      createdAt: new Date('2026-01-01T12:00:00.000Z'),
    };
    assert.deepEqual(getCurrentOwnerIdsFromUnit(unit, now), [ownerB]);
  });

  it('treats same-day noon start as current before wall-clock noon', () => {
    const {
      getCurrentOwnerIdsFromUnit,
    } = require('../services/unit.service');
    const ownerId = '6a77038d58c4a71f29801ede';
    const morning = new Date('2026-08-25T09:00:00.000Z');
    const noon = new Date('2026-08-25T12:00:00.000Z');
    const unit = {
      associatedOwnerIds: [ownerId],
      ownershipRecords: [
        {
          ownerId,
          startDate: noon,
          endDate: null,
        },
      ],
      createdAt: new Date('2026-01-01T12:00:00.000Z'),
    };

    assert.deepEqual(getCurrentOwnerIdsFromUnit(unit, morning), [ownerId]);
  });

  it('falls back to associatedOwnerIds when timeline has no active row', () => {
    const {
      getCurrentOwnerIdsFromUnit,
    } = require('../services/unit.service');
    const ownerId = '6a77038d58c4a71f29801ede';
    const unit = {
      associatedOwnerIds: [ownerId],
      ownershipRecords: [
        {
          ownerId,
          startDate: new Date('2026-09-01T12:00:00.000Z'),
          endDate: null,
        },
      ],
      createdAt: new Date('2026-01-01T12:00:00.000Z'),
    };

    assert.deepEqual(
      getCurrentOwnerIdsFromUnit(unit, new Date('2026-08-25T15:00:00.000Z')),
      [ownerId]
    );
  });

  it('detects future calendar effective dates for invoice sync gating', () => {
    const now = new Date('2026-08-24T15:00:00.000Z');
    assert.equal(isFutureCalendarEffectiveDate(toDateAtStartOfDay('2026-08-24'), now), false);
    assert.equal(isFutureCalendarEffectiveDate(toDateAtStartOfDay('2026-09-01'), now), true);
    assert.equal(isFutureCalendarEffectiveDate(toDateAtStartOfDay('2026-08-23'), now), false);
  });

  it('anchors future scheduled removal at midnight business timezone on the effective day', () => {
    const effectiveDate = toDateAtStartOfDay('2026-08-30');
    const endInstant = removalEndInstantForEffectiveDate(effectiveDate, false);
    const endParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      hourCycle: 'h23',
    }).formatToParts(endInstant);
    const lookup = Object.fromEntries(endParts.map((part) => [part.type, part.value]));
    assert.equal(lookup.year, '2026');
    assert.equal(lookup.month, '08');
    assert.equal(lookup.day, '30');
    assert.equal(Number(lookup.hour), 0);
    assert.equal(Number(lookup.minute), 0);
  });

  it('keeps future-scheduled owner active until the effective calendar day begins', () => {
    const effectiveDate = toDateAtStartOfDay('2026-08-30');
    const endInstant = removalEndInstantForEffectiveDate(effectiveDate, false);
    const records = [
      {
        ownerId,
        startDate: new Date('2026-03-01T12:00:00.000Z'),
        endDate: endInstant,
      },
    ];
    const dayBefore = new Date(endInstant.getTime() - 60_000);
    assert.deepEqual(getActiveOwnerIdsFromRecords(records, dayBefore), [ownerId]);
    assert.deepEqual(getActiveOwnerIdsFromRecords(records, endInstant), []);
    assert.deepEqual(getActiveOwnerIdsFromRecords(records, new Date(endInstant.getTime() + 60_000)), []);
  });
});
