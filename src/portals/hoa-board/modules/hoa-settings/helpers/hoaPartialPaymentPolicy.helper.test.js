'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  assertHoaAcceptsPartialPaymentForInvoice,
  loadAcceptPartialPaymentsForHoa,
} = require('./hoaPartialPaymentPolicy.helper');

describe('hoaPartialPaymentPolicy.helper', () => {
  it('loadAcceptPartialPaymentsForHoa returns false without hoaId', async () => {
    assert.equal(await loadAcceptPartialPaymentsForHoa(null), false);
  });

  it('assertHoaAcceptsPartialPaymentForInvoice allows full balance payments without settings lookup', async () => {
    await assertHoaAcceptsPartialPaymentForInvoice(
      { propertyId: null },
      100,
      100,
    );
  });
});
