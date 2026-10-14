'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_HOA_PAYMENT_DUE_DAY,
  normalizePaymentDueDay,
  resolvePaymentDueDayFromSources,
} = require('./paymentDueDay.helper');

describe('paymentDueDay.helper', () => {
  it('defaults to 1 when no sources are provided', () => {
    assert.equal(DEFAULT_HOA_PAYMENT_DUE_DAY, 1);
    assert.equal(resolvePaymentDueDayFromSources(), 1);
  });

  it('prefers explicit day over requestPayload and HOA settings', () => {
    assert.equal(
      resolvePaymentDueDayFromSources({
        explicitDay: 15,
        requestPayload: { paymentDueDay: 5 },
        hoaSettings: { paymentTerm: { dueDay: 1 } },
      }),
      15,
    );
  });

  it('uses HOA settings when requestPayload is missing', () => {
    assert.equal(
      resolvePaymentDueDayFromSources({
        hoaSettings: { paymentTerm: { dueDay: 1 } },
      }),
      1,
    );
  });

  it('uses requestPayload snapshot before HOA settings', () => {
    assert.equal(
      resolvePaymentDueDayFromSources({
        requestPayload: { paymentDueDay: 10 },
        hoaSettings: { paymentTerm: { dueDay: 1 } },
      }),
      10,
    );
  });

  it('prefers HOA settings over stale requestPayload when preferHoaSettings is true', () => {
    assert.equal(
      resolvePaymentDueDayFromSources({
        requestPayload: { paymentDueDay: 5 },
        hoaSettings: { paymentTerm: { dueDay: 1 } },
        preferHoaSettings: true,
      }),
      1,
    );
  });

  it('clamps invalid values via normalizePaymentDueDay', () => {
    assert.equal(normalizePaymentDueDay(0), 1);
    assert.equal(normalizePaymentDueDay(40), 31);
  });
});
