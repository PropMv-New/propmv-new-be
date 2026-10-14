const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildRemovalCopy,
  isFutureOwnershipEffectiveDate,
} = require('../ownerRemovalNoticeEmailHelper');

describe('ownerRemovalNoticeEmailHelper', () => {
  it('uses scheduled copy for future effective dates', () => {
    const copy = buildRemovalCopy({
      action: 'remove',
      effectiveDate: '2099-12-31',
      balanceSettlement: 'MARK_PAID',
    });

    assert.match(copy.headline, /scheduled to end/i);
    assert.match(copy.introParagraph, /is scheduled to end effective/i);
    assert.match(copy.subject, /scheduled to end/i);
    assert.doesNotMatch(copy.introParagraph, /has ended/i);
  });

  it('uses past-tense copy for today or past effective dates', () => {
    const copy = buildRemovalCopy({
      action: 'remove',
      effectiveDate: '2020-01-01',
      balanceSettlement: null,
    });

    assert.match(copy.headline, /has ended/i);
    assert.match(copy.subject, /has ended/i);
  });

  it('detects future calendar effective dates', () => {
    assert.equal(isFutureOwnershipEffectiveDate('2099-12-31'), true);
    assert.equal(isFutureOwnershipEffectiveDate('2020-01-01'), false);
  });
});
