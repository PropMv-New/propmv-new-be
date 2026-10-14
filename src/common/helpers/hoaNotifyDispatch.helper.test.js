const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractHoaIdFromNotification,
  withHoaMetadata,
  toIdString,
} = require('./hoaNotifyDispatch.helper');

describe('hoaNotifyDispatch.helper', () => {
  it('toIdString reads ObjectId-like objects and strings', () => {
    assert.equal(toIdString('507f1f77bcf86cd799439011'), '507f1f77bcf86cd799439011');
    assert.equal(toIdString({ _id: '507f1f77bcf86cd799439011' }), '507f1f77bcf86cd799439011');
    assert.equal(toIdString(null), '');
  });

  it('withHoaMetadata always stamps hoaId so community filtering can keep the notification', () => {
    const meta = withHoaMetadata({ entityType: 'invoice', entityId: '1' }, 'aaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(meta.hoaId, 'aaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(meta.entityType, 'invoice');
  });

  it('extractHoaIdFromNotification reads top-level metadata.hoaId', () => {
    assert.equal(
      extractHoaIdFromNotification({ metadata: { hoaId: 'hoa-1' } }),
      'hoa-1'
    );
  });

  it('extractHoaIdFromNotification reads nested eventData.hoaId', () => {
    assert.equal(
      extractHoaIdFromNotification({ metadata: { eventData: { hoaId: 'hoa-2' } } }),
      'hoa-2'
    );
  });

  it('extractHoaIdFromNotification returns null when hoaId is missing', () => {
    assert.equal(extractHoaIdFromNotification({ metadata: {} }), null);
  });
});
