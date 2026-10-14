'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatPayloadDueDate,
  isInvoiceEligibleForAutopaySync,
} = require('./payloadInvoiceSync.util');

describe('payloadInvoiceSync.util', () => {
  it('formats due dates for Payload invoices', () => {
    assert.equal(formatPayloadDueDate(new Date('2026-04-15T12:00:00Z')), '2026-04-15');
    assert.equal(formatPayloadDueDate('invalid'), '');
  });

  it('detects invoices eligible for autopay mirror sync', () => {
    assert.equal(
      isInvoiceEligibleForAutopaySync({
        balanceDue: 50,
        dueDate: new Date('2026-04-01'),
        status: 'Unpaid',
      }),
      true,
    );
    assert.equal(
      isInvoiceEligibleForAutopaySync({
        balanceDue: 0,
        dueDate: new Date('2026-04-01'),
        status: 'Unpaid',
      }),
      false,
    );
    assert.equal(
      isInvoiceEligibleForAutopaySync({
        balanceDue: 10,
        dueDate: new Date('2026-04-01'),
        status: 'Paid',
      }),
      false,
    );
  });
});
