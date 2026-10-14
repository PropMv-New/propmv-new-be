const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  makeMaintenanceTicketNumber,
  isShortMaintenanceTicketNumber,
  resolveMaintenanceTicketNumber,
} = require('./maintenanceTicketNumber.helper');

describe('maintenanceTicketNumber.helper', () => {
  it('generates MNT###### format', () => {
    const value = makeMaintenanceTicketNumber();
    assert.match(value, /^MNT\d{6}$/);
    assert.equal(isShortMaintenanceTicketNumber(value), true);
  });

  it('resolves stored ticket number', () => {
    assert.equal(
      resolveMaintenanceTicketNumber({ ticketNumber: 'MNT123456', _id: '507f1f77bcf86cd799439011' }),
      'MNT123456'
    );
  });

  it('falls back to document id for legacy tickets', () => {
    const id = '507f1f77bcf86cd799439011';
    assert.equal(resolveMaintenanceTicketNumber({ _id: id }), id);
  });
});
