'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('hoaOnboardingStatus.helper exports', () => {
  it('exports resolveActiveHoaId for Payload owner payment scoping', () => {
    const helpers = require('./hoaOnboardingStatus.helper');
    assert.equal(typeof helpers.resolveActiveHoaId, 'function');
  });

  it('exports assertUserCanAccessHoaCommunity for owner Payload payment scoping', () => {
    const helpers = require('./hoaOnboardingStatus.helper');
    assert.equal(typeof helpers.assertUserCanAccessHoaCommunity, 'function');
  });
});
