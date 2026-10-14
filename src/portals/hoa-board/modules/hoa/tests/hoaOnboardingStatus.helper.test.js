const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isHoaSettingsComplete,
  isLinkedBankActiveForDeposit,
  isLinkedBankSelectable,
  isRainforestDepositSelectable,
  isRainforestDepositActiveForPayout,
  isPayloadDepositSelectable,
  isPayloadDepositActiveForPayout,
  isPayloadDepositActiveForOnboarding,
  formatCommunityDepositLabel,
} = require('../helpers/hoaOnboardingStatus.helper');

describe('isHoaSettingsComplete', () => {
  it('returns true when recurring fee, payment term, and late fee rules are satisfied', () => {
    assert.equal(
      isHoaSettingsComplete({
        recurringFee: { enabled: true, amount: 100, frequency: 'monthly', tenure: 1 },
        paymentTerm: { dueDay: 1, gracePeriodDays: 0 },
        lateFee: { enabled: false },
        lateFees: [],
      }),
      true
    );
  });

  it('returns false when recurring fee is missing', () => {
    assert.equal(
      isHoaSettingsComplete({
        recurringFee: { enabled: false },
        paymentTerm: { dueDay: 1, gracePeriodDays: 0 },
        lateFee: { enabled: false },
      }),
      false
    );
  });
});

describe('linked bank helpers', () => {
  it('treats active linked banks as deposit-ready', () => {
    assert.equal(isLinkedBankActiveForDeposit({ status: 'active', last4: '1234' }), true);
    assert.equal(isLinkedBankActiveForDeposit({ status: 'created', last4: '1234' }), false);
  });

  it('skips rejected linked banks for onboarding counts', () => {
    assert.equal(isLinkedBankSelectable({ status: 'rejected', last4: '1234' }), false);
    assert.equal(isLinkedBankSelectable({ status: 'created', last4: '1234' }), true);
  });
});

describe('rainforest deposit helpers', () => {
  it('treats active rainforest deposit methods as payout-ready', () => {
    assert.equal(isRainforestDepositActiveForPayout({ status: 'ACTIVE', depositMethodId: 'dmt_1' }), true);
    assert.equal(isRainforestDepositActiveForPayout({ status: 'CREATED', depositMethodId: 'dmt_1' }), false);
  });

  it('skips replaced rainforest deposit methods for onboarding counts', () => {
    assert.equal(isRainforestDepositSelectable({ status: 'REPLACED', depositMethodId: 'dmt_1' }), false);
    assert.equal(isRainforestDepositSelectable({ status: 'ACTIVE', depositMethodId: 'dmt_1' }), true);
  });
});

describe('community deposit label', () => {
  it('builds a display label from bank name and last4', () => {
    assert.equal(
      formatCommunityDepositLabel({ bankName: 'Chase', last4: '4321', holderName: 'HOA' }),
      'Chase ••••4321'
    );
  });
});

describe('payload deposit helpers', () => {
  it('treats active payload deposit methods as payout-ready', () => {
    assert.equal(isPayloadDepositActiveForPayout({ status: 'ACTIVE', depositMethodId: 'pm_1' }), true);
    assert.equal(isPayloadDepositActiveForPayout({ status: 'CREATED', depositMethodId: 'pm_1' }), false);
    assert.equal(isPayloadDepositActiveForPayout({ status: 'inactive', depositMethodId: 'pm_1' }), false);
  });

  it('skips replaced or disconnected payload deposit methods for onboarding counts', () => {
    assert.equal(isPayloadDepositSelectable({ status: 'REPLACED', depositMethodId: 'pm_1' }), false);
    assert.equal(isPayloadDepositSelectable({ status: 'ACTIVE', depositMethodId: 'pm_1' }), true);
    assert.equal(isPayloadDepositSelectable({ status: 'ACTIVE', last4: '4321' }), true);
  });

  it('counts CREATED payload deposit banks for board onboarding step', () => {
    assert.equal(isPayloadDepositActiveForOnboarding({ status: 'CREATED', depositMethodId: 'pm_1' }), true);
    assert.equal(isPayloadDepositActiveForOnboarding({ status: 'ACTIVE', depositMethodId: 'pm_1' }), true);
    assert.equal(isPayloadDepositActiveForOnboarding({ status: 'REPLACED', depositMethodId: 'pm_1' }), false);
    assert.equal(isPayloadDepositActiveForPayout({ status: 'CREATED', depositMethodId: 'pm_1' }), false);
  });
});
