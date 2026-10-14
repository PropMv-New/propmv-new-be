/**
 * Ownership Change Regression Suite (TC-01 .. TC-12 helpers)
 *
 * Ensures property/owner current-ownership resolution matches calendar-day
 * effective dates - the same semantics used when ownership-effective emails fire.
 *
 * Run:
 *   node --test src/portals/hoa-board/modules/owners/tests/ownershipEffectiveDateTransition.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  getCurrentOwnerIdsFromUnit,
  resolveOwnershipPeriodForOwner,
  isFutureCalendarEffectiveDate,
  toDateAtStartOfDay,
  ownershipActivityAtForCurrentAssociation,
  getActiveOwnerIdsFromRecords,
} = require('../services/unit.service');

const ANNU = '6a9433a2d554af121cc20392';
const JAI = '6a945190012d896ac575ae68';
const PROPMV_TEAM = '6a944bebd554af121cc24842';

const buildTransferUnit = ({
  previousOwnerId = ANNU,
  newOwnerIds = [JAI, PROPMV_TEAM],
  previousStart = '2026-09-01',
  effectiveDate = '2026-09-06',
  associatedOwnerIds,
} = {}) => {
  const effectiveNoon = toDateAtStartOfDay(effectiveDate);
  const previousStartNoon = toDateAtStartOfDay(previousStart);
  const nextIds = newOwnerIds.map(String);
  return {
    _id: '6a986bb19f041c078830bf17',
    associatedOwnerIds: associatedOwnerIds !== undefined ? associatedOwnerIds : nextIds,
    ownershipRecords: [
      {
        ownerId: previousOwnerId,
        startDate: previousStartNoon,
        endDate: effectiveNoon,
      },
      ...nextIds.map((ownerId) => ({
        ownerId,
        startDate: effectiveNoon,
        endDate: null,
      })),
    ],
    ownershipLogs: [
      {
        action: 'CHANGE',
        ownerIds: nextIds,
        effectiveDate: effectiveNoon,
        details: {
          previousOwnerIds: [previousOwnerId],
          newOwnerIds: nextIds,
          effectiveDateKey: effectiveDate,
          isFutureScheduled: false,
          effectiveTransferProcessed: true,
        },
      },
    ],
    createdAt: previousStartNoon,
  };
};

const sorted = (ids) => [...ids].map(String).sort();

describe('Ownership Change Regression - effective date transition', () => {
  // TC-01 - Future ownership should not become current early
  it('TC-01 Future ownership protection: keeps previous owner before effective calendar day', () => {
    const unit = buildTransferUnit({ effectiveDate: '2026-09-10' });
    const now = new Date('2026-09-06T15:00:00.000Z');

    assert.equal(isFutureCalendarEffectiveDate(toDateAtStartOfDay('2026-09-10'), now), true);
    assert.deepEqual(sorted(getCurrentOwnerIdsFromUnit(unit, now)), sorted([ANNU]));
    assert.equal(resolveOwnershipPeriodForOwner(unit, ANNU, now).status, 'scheduled_removal');
    assert.equal(resolveOwnershipPeriodForOwner(unit, JAI, now).status, 'previous');
    assert.equal(resolveOwnershipPeriodForOwner(unit, PROPMV_TEAM, now).status, 'previous');
  });

  // TC-02 - Ownership becomes current on effective date (before wall-clock noon)
  it('TC-02 Effective date transition: activates both new owners before noon on effective day', () => {
    const unit = buildTransferUnit({ effectiveDate: '2026-09-06' });
    const morning = new Date('2026-09-06T09:00:00.000Z');

    assert.deepEqual(
      sorted(getCurrentOwnerIdsFromUnit(unit, morning)),
      sorted([JAI, PROPMV_TEAM])
    );
    assert.equal(resolveOwnershipPeriodForOwner(unit, JAI, morning).status, 'current');
    assert.equal(resolveOwnershipPeriodForOwner(unit, PROPMV_TEAM, morning).status, 'current');
    assert.equal(resolveOwnershipPeriodForOwner(unit, ANNU, morning).status, 'removed');
  });

  // TC-03 - Ownership remains current after effective date
  it('TC-03 Post-effective ownership: new owners remain current the next day', () => {
    const unit = buildTransferUnit({ effectiveDate: '2026-09-06' });
    const nextDay = new Date('2026-09-07T15:00:00.000Z');

    assert.deepEqual(
      sorted(getCurrentOwnerIdsFromUnit(unit, nextDay)),
      sorted([JAI, PROPMV_TEAM])
    );
    assert.equal(resolveOwnershipPeriodForOwner(unit, ANNU, nextDay).status, 'removed');
  });

  // TC-04 - Multiple new owners
  it('TC-04 Multiple owners: both new owners are associated after effective date', () => {
    const unit = buildTransferUnit({
      newOwnerIds: [JAI, PROPMV_TEAM],
      effectiveDate: '2026-09-06',
    });
    const morning = new Date('2026-09-06T11:55:00.000Z');
    const current = getCurrentOwnerIdsFromUnit(unit, morning);

    assert.equal(current.length, 2);
    assert.ok(current.includes(JAI));
    assert.ok(current.includes(PROPMV_TEAM));
    assert.ok(!current.includes(ANNU));
  });

  // TC-05 / TC-06 / TC-07 / TC-08 - listing/detail/owner assignment share one resolver
  it('TC-05..08 Property/owner listing source of truth uses getCurrentOwnerIdsFromUnit', () => {
    const unit = buildTransferUnit();
    const morning = new Date('2026-09-06T08:00:00.000Z');
    const current = new Set(getCurrentOwnerIdsFromUnit(unit, morning));

    // Property listing / detail current owners
    assert.deepEqual(sorted([...current]), sorted([JAI, PROPMV_TEAM]));

    // Owner listing: new owners have the property; previous does not
    assert.equal(current.has(JAI), true);
    assert.equal(current.has(PROPMV_TEAM), true);
    assert.equal(current.has(ANNU), false);

    // Effective dates for new owners
    const jaiPeriod = resolveOwnershipPeriodForOwner(unit, JAI, morning);
    assert.equal(jaiPeriod.startDate.toISOString(), '2026-09-06T12:00:00.000Z');
    assert.equal(jaiPeriod.status, 'current');
  });

  // TC-09 - Browser refresh (deterministic re-read)
  it('TC-09 Browser refresh: repeated reads stay consistent after effective date', () => {
    const unit = buildTransferUnit();
    const morning = new Date('2026-09-06T10:00:00.000Z');
    const first = sorted(getCurrentOwnerIdsFromUnit(unit, morning));
    const second = sorted(getCurrentOwnerIdsFromUnit(unit, morning));
    assert.deepEqual(first, second);
    assert.deepEqual(first, sorted([JAI, PROPMV_TEAM]));
  });

  // TC-10 - Automatic transition (no manual property edit)
  it('TC-10 Automatic transition: write-path association and read-path agree on effective day', () => {
    const effectiveDate = toDateAtStartOfDay('2026-09-06');
    const morning = new Date('2026-09-06T09:30:00.000Z');
    const records = [
      { ownerId: ANNU, startDate: toDateAtStartOfDay('2026-09-01'), endDate: effectiveDate },
      { ownerId: JAI, startDate: effectiveDate, endDate: null },
      { ownerId: PROPMV_TEAM, startDate: effectiveDate, endDate: null },
    ];

    const writePathIds = getActiveOwnerIdsFromRecords(
      records,
      ownershipActivityAtForCurrentAssociation(effectiveDate, morning)
    );
    const unit = {
      associatedOwnerIds: writePathIds,
      ownershipRecords: records,
      createdAt: toDateAtStartOfDay('2026-09-01'),
    };
    const readPathIds = getCurrentOwnerIdsFromUnit(unit, morning);

    assert.deepEqual(sorted(writePathIds), sorted([JAI, PROPMV_TEAM]));
    assert.deepEqual(sorted(readPathIds), sorted(writePathIds));
  });

  // TC-11 - Direct URL access (unit payload with healed/stale associatedOwnerIds)
  it('TC-11 Direct URL access: timeline wins even if associatedOwnerIds still list previous owner', () => {
    const unit = buildTransferUnit({
      associatedOwnerIds: [ANNU], // stale heal from pre-fix read path
    });
    const morning = new Date('2026-09-06T11:00:00.000Z');

    assert.deepEqual(
      sorted(getCurrentOwnerIdsFromUnit(unit, morning)),
      sorted([JAI, PROPMV_TEAM])
    );
  });

  // TC-12 - Email vs UI consistency
  it('TC-12 Email/UI consistency: planned newOwnerIds match current owners on effective day', () => {
    const unit = buildTransferUnit();
    const morning = new Date('2026-09-06T07:00:00.000Z');
    const log = unit.ownershipLogs[0];
    const emailNewOwnerIds = sorted(log.details.newOwnerIds);
    const uiCurrentOwnerIds = sorted(getCurrentOwnerIdsFromUnit(unit, morning));

    assert.deepEqual(uiCurrentOwnerIds, emailNewOwnerIds);
    assert.deepEqual(sorted(log.details.previousOwnerIds), sorted([ANNU]));
    assert.ok(!uiCurrentOwnerIds.includes(ANNU));
  });

  it('regression: does not activate future same-calendar-month transfers early', () => {
    const unit = buildTransferUnit({ effectiveDate: '2026-09-20' });
    const now = new Date('2026-09-06T11:55:00.000Z');
    assert.deepEqual(sorted(getCurrentOwnerIdsFromUnit(unit, now)), sorted([ANNU]));
  });

  it('regression: after noon on effective day still returns new owners', () => {
    const unit = buildTransferUnit();
    const afternoon = new Date('2026-09-06T15:00:00.000Z');
    assert.deepEqual(
      sorted(getCurrentOwnerIdsFromUnit(unit, afternoon)),
      sorted([JAI, PROPMV_TEAM])
    );
  });
});
