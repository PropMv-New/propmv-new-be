const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUserId } = require('../../../../common/helpers/maintenanceEmailRecipients');

function maintenanceIdString(id) {
  if (!id) return '';
  return id.toString ? id.toString() : String(id);
}

describe('maintenance vendor assignedTo id extraction', () => {
  it('normalizeUserId reads populated assignedTo user references', () => {
    const vendorId = '507f1f77bcf86cd799439011';
    const populated = { _id: vendorId, firstName: 'Jane', lastName: 'Vendor' };

    assert.equal(normalizeUserId(populated), vendorId);
    assert.equal(normalizeUserId(vendorId), vendorId);
  });

  it('maintenanceIdString fails on populated assignedTo (regression guard)', () => {
    const vendorId = '507f1f77bcf86cd799439011';
    const populated = { _id: vendorId, firstName: 'Jane', lastName: 'Vendor' };

    assert.notEqual(maintenanceIdString(populated), vendorId);
    assert.equal(maintenanceIdString(populated), '[object Object]');
  });
});
