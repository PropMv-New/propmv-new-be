'use strict';

process.env.JWT_SECRET = 'test-jwt-secret-for-trusted-device';
process.env.DEVICE_FINGERPRINT_SECRET = 'test-device-fingerprint-secret';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { ClockService, DateUtil } = require('../../../../common/date');
const { hashDeviceFingerprint } = require('../helpers/deviceFingerprint.helper');
const TrustedDevice = require('../models/trustedDevice.model');
const { evaluateDeviceTrust } = require('../services/trustedDevice.service');

describe('trustedDevice.service evaluateDeviceTrust', () => {
  let originalFindOne;

  beforeEach(() => {
    ClockService.setFixedTime('2026-09-18T20:14:00.000Z');
    originalFindOne = TrustedDevice.findOne;
  });

  afterEach(() => {
    ClockService.reset();
    TrustedDevice.findOne = originalFindOne;
  });

  it('skips MFA for a trusted fingerprint even when IP changed', async () => {
    const fingerprint = 'stable-device-fingerprint-abc12345';
    const fingerprintHash = hashDeviceFingerprint(fingerprint);
    const trustedUntil = DateUtil.fromEpoch(ClockService.nowEpoch() + 7 * 24 * 60 * 60 * 1000);

    TrustedDevice.findOne = () => ({
      lean: async () => ({
        _id: 'dev1',
        userId: 'user1',
        fingerprintHash,
        trustedUntil,
        lastIp: '203.0.113.10',
        isRevoked: false,
      }),
    });

    const result = await evaluateDeviceTrust('user1', fingerprint, '198.51.100.20');
    assert.equal(result.trusted, true);
    assert.equal(result.reason, 'skipped_trusted_device');
    assert.equal(result.ipChanged, true);
  });

  it('requires MFA when trust window has expired', async () => {
    const fingerprint = 'stable-device-fingerprint-abc12345';
    const fingerprintHash = hashDeviceFingerprint(fingerprint);
    const trustedUntil = DateUtil.fromEpoch(ClockService.nowEpoch() - 1000);

    TrustedDevice.findOne = () => ({
      lean: async () => ({
        _id: 'dev1',
        userId: 'user1',
        fingerprintHash,
        trustedUntil,
        lastIp: '203.0.113.10',
        isRevoked: false,
      }),
    });

    const result = await evaluateDeviceTrust('user1', fingerprint, '203.0.113.10');
    assert.equal(result.trusted, false);
    assert.equal(result.reason, 'required_expired');
  });

  it('requires MFA when fingerprint is missing', async () => {
    const result = await evaluateDeviceTrust('user1', '', '203.0.113.10');
    assert.equal(result.trusted, false);
    assert.equal(result.reason, 'required_missing_fingerprint');
  });
});
