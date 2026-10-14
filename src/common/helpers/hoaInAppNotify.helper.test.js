const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  excludeActor,
} = require('./hoaInAppNotify.helper');
const EVENTS = require('../notifications/notificationEvents');

describe('excludeActor', () => {
  it('deduplicates and removes the acting user', () => {
    const actor = '507f1f77bcf86cd799439011';
    const other = '507f1f77bcf86cd799439012';
    assert.deepEqual(
      excludeActor([actor, other, other, actor], actor),
      [other]
    );
  });

  it('returns all ids when actor is missing', () => {
    const a = '507f1f77bcf86cd799439011';
    const b = '507f1f77bcf86cd799439012';
    assert.deepEqual(excludeActor([a, b], null), [a, b]);
  });
});

describe('HOA notification events registry', () => {
  it('includes maintenance and HOA document/expense events', () => {
    assert.equal(typeof EVENTS.MAINTENANCE_REQUEST_CREATED.message, 'function');
    assert.equal(typeof EVENTS.MAINTENANCE_REQUEST_UPDATED.message, 'function');
    assert.equal(typeof EVENTS.MAINTENANCE_COMMENT_ADDED.message, 'function');
    assert.equal(typeof EVENTS.MAINTENANCE_NOTE_ADDED.message, 'function');
    assert.equal(typeof EVENTS.MAINTENANCE_DOCUMENTS_UPDATED.message, 'function');
    assert.equal(typeof EVENTS.DOCUMENT_UPLOADED.message, 'function');
    assert.equal(typeof EVENTS.EXPENSE_CREATED.message, 'function');
    assert.equal(typeof EVENTS.EXPENSE_UPDATED.message, 'function');
  });

  it('formats payment received owner/board notification copy', () => {
    assert.equal(EVENTS.PAYMENT_RECEIVED.type, 'payment_received');
    assert.equal(
      EVENTS.PAYMENT_RECEIVED.message({ amount: '100.00', unitName: '4B' }),
      'Payment of $100.00 has been received for unit "4B".'
    );
  });

  it('formats payment deleted owner notification copy', () => {
    assert.equal(EVENTS.PAYMENT_DELETED.type, 'payment_deleted');
    assert.equal(
      EVENTS.PAYMENT_DELETED.message({ amount: '150.00', unitName: '4B' }),
      'A payment of $150.00 has been removed for unit "4B".'
    );
  });

  it('formats payment failed and processing owner/board notification copy', () => {
    assert.equal(EVENTS.PAYMENT_FAILED.type, 'payment_failed');
    assert.equal(
      EVENTS.PAYMENT_FAILED.message({ amount: '80.00', unitName: '4B' }),
      'A payment of $80.00 for unit "4B" could not be processed.'
    );
    assert.equal(EVENTS.PAYMENT_PROCESSING.type, 'payment_processing');
    assert.equal(
      EVENTS.PAYMENT_PROCESSING.message({ amount: '80.00', unitName: '4B' }),
      'A payment of $80.00 for unit "4B" is being processed.'
    );
  });

  it('formats invoice waived notification copy', () => {
    assert.equal(EVENTS.INVOICE_WAIVED.type, 'invoice_waived');
    assert.equal(
      EVENTS.INVOICE_WAIVED.message({ amount: '75.00', unitName: '12A' }),
      '$75.00 has been waived on the invoice for unit "12A".'
    );
  });

  it('supports customMessage override on maintenance update', () => {
    const msg = EVENTS.MAINTENANCE_REQUEST_UPDATED.message({
      title: 'Leak',
      customMessage: 'Custom update body',
    });
    assert.equal(msg, 'Custom update body');
  });

  it('falls back to status message when customMessage is absent', () => {
    const msg = EVENTS.MAINTENANCE_REQUEST_UPDATED.message({
      title: 'Leak',
      status: 'Open',
    });
    assert.match(msg, /updated to status "Open"/);
  });

  it('formats resolved/completed maintenance notifications like the resolve email', () => {
    assert.equal(EVENTS.MAINTENANCE_REQUEST_COMPLETED.title, 'Maintenance Request Resolved');
    assert.equal(
      EVENTS.MAINTENANCE_REQUEST_COMPLETED.message({ title: 'Leak', unitName: '4B' }),
      'Maintenance request "Leak" for unit "4B" has been marked as resolved.'
    );
    assert.equal(
      EVENTS.MAINTENANCE_REQUEST_COMPLETED.message({
        title: 'Leak',
        customMessage: 'A maintenance ticket was marked as resolved.',
      }),
      'A maintenance ticket was marked as resolved.'
    );
  });
});
