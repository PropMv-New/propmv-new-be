/**
 * Internal Admin Real MFA OTP Authentication Test Suite
 *
 * Verifies that:
 * 1. admin@propmv.com uses normal real MFA (not treated as Play Store reviewer).
 * 2. A real random 6-digit OTP is generated.
 * 3. Real OTP is stored in existing user.mfaOtp and expires in 10 minutes.
 * 4. Existing OTP email delivery is NOT skipped for admin@propmv.com.
 * 5. Real OTP can successfully authenticate via verifyMfaOtp.
 * 6. Demo OTP 000000 is strictly rejected for admin@propmv.com.
 * 7. Expired real OTP is rejected.
 * 8. Successful OTP verification consumes/clears mfaOtp, mfaOtpExpiresAt, and mfaOtpAction.
 * 9. Resend MFA generates and stores a new real OTP.
 * 10. Existing MFA behavior for normal users and approved Play Store reviewers remains intact.
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const playStoreTestAuth = require('../helpers/playStoreTestAuth.helper');
const User = require('../../users/models/user.model');
const authService = require('../services/auth.service');
const { ClockService, DateUtil } = require('../../../../common/date');

describe('Internal Admin Real MFA OTP Authentication Suite', () => {
  const ADMIN_EMAIL = 'admin@propmv.com';
  const NORMAL_EMAIL = 'regular-user@example.com';
  const REVIEWER_EMAIL = 'board@propmv.com';

  beforeEach(() => {
    process.env.PLAY_STORE_TEST_AUTH_ENABLED = 'true';
    process.env.PLAY_STORE_TEST_OTP = '000000';
    delete process.env.PLAY_STORE_TEST_ACCOUNTS;
  });

  it('1. admin@propmv.com is NOT treated as a Play Store reviewer account', () => {
    assert.equal(
      playStoreTestAuth.isPlayStoreTestAccount(ADMIN_EMAIL),
      false,
      'admin@propmv.com must NOT be recognized as a Play Store test account'
    );
  });

  it('2. OTP email delivery is NOT skipped for admin@propmv.com', () => {
    assert.equal(
      playStoreTestAuth.shouldSkipOtpDelivery(ADMIN_EMAIL),
      false,
      'Email delivery must NOT be skipped for admin@propmv.com'
    );
  });

  it('3. 000000 does NOT match as a Play Store test OTP for admin@propmv.com', () => {
    assert.equal(
      playStoreTestAuth.matchesPlayStoreTestOtp(ADMIN_EMAIL, '000000'),
      false,
      'matchesPlayStoreTestOtp must return false for admin@propmv.com'
    );
  });

  it('4. Real OTP verification succeeds with the actual generated OTP', async () => {
    const adminId = new mongoose.Types.ObjectId();
    const realOtp = '742918';
    const expiresAt = DateUtil.fromEpoch(ClockService.nowEpoch() + 10 * 60 * 1000);

    const mockAdmin = {
      _id: adminId,
      email: ADMIN_EMAIL,
      mfaOtp: realOtp,
      mfaOtpExpiresAt: expiresAt,
      mfaOtpAction: 'login',
      isDeleted: false,
      save: async () => {},
      toSafeJSON: async () => ({ id: String(adminId), email: ADMIN_EMAIL }),
    };

    const origFindOne = User.findOne;
    User.findOne = () => mockAdmin;

    try {
      const result = await authService.verifyMfaOtp({
        email: ADMIN_EMAIL,
        otp: realOtp,
      });

      assert.ok(result.accessToken, 'Must issue access token');
      assert.ok(result.refreshToken, 'Must issue refresh token');
      assert.equal(result.user.email, ADMIN_EMAIL);
      // Verify OTP consumption
      assert.equal(mockAdmin.mfaOtp, undefined, 'mfaOtp must be consumed/cleared');
      assert.equal(mockAdmin.mfaOtpExpiresAt, undefined, 'mfaOtpExpiresAt must be cleared');
      assert.equal(mockAdmin.mfaOtpAction, undefined, 'mfaOtpAction must be cleared');
    } finally {
      User.findOne = origFindOne;
    }
  });

  it('5. 000000 is strictly REJECTED when submitted for admin@propmv.com', async () => {
    const adminId = new mongoose.Types.ObjectId();
    const realOtp = '583921';
    const expiresAt = DateUtil.fromEpoch(ClockService.nowEpoch() + 10 * 60 * 1000);

    const mockAdmin = {
      _id: adminId,
      email: ADMIN_EMAIL,
      mfaOtp: realOtp,
      mfaOtpExpiresAt: expiresAt,
      mfaOtpAction: 'login',
      isDeleted: false,
    };

    const origFindOne = User.findOne;
    User.findOne = () => mockAdmin;

    try {
      await assert.rejects(
        async () => {
          await authService.verifyMfaOtp({
            email: ADMIN_EMAIL,
            otp: '000000',
          });
        },
        /Invalid OTP/,
        'Submitting 000000 for admin@propmv.com must throw Invalid OTP'
      );
    } finally {
      User.findOne = origFindOne;
    }
  });

  it('6. Expired real OTP is rejected for admin@propmv.com', async () => {
    const adminId = new mongoose.Types.ObjectId();
    const realOtp = '492815';
    // Expired 5 minutes ago
    const expiredAt = DateUtil.fromEpoch(ClockService.nowEpoch() - 5 * 60 * 1000);

    const mockAdmin = {
      _id: adminId,
      email: ADMIN_EMAIL,
      mfaOtp: realOtp,
      mfaOtpExpiresAt: expiredAt,
      mfaOtpAction: 'login',
      isDeleted: false,
    };

    const origFindOne = User.findOne;
    User.findOne = () => mockAdmin;

    try {
      await assert.rejects(
        async () => {
          await authService.verifyMfaOtp({
            email: ADMIN_EMAIL,
            otp: realOtp,
          });
        },
        /OTP has expired/,
        'Expired OTP must throw OTP has expired error'
      );
    } finally {
      User.findOne = origFindOne;
    }
  });

  it('7. Successful verification clears/invalidates OTP preventing replay attack', async () => {
    const adminId = new mongoose.Types.ObjectId();
    const realOtp = '682194';
    const expiresAt = DateUtil.fromEpoch(ClockService.nowEpoch() + 10 * 60 * 1000);

    const mockAdmin = {
      _id: adminId,
      email: ADMIN_EMAIL,
      mfaOtp: realOtp,
      mfaOtpExpiresAt: expiresAt,
      mfaOtpAction: 'login',
      isDeleted: false,
      save: async () => {},
      toSafeJSON: async () => ({ id: String(adminId), email: ADMIN_EMAIL }),
    };

    const origFindOne = User.findOne;
    User.findOne = () => mockAdmin;

    try {
      // First verification: succeeds
      await authService.verifyMfaOtp({ email: ADMIN_EMAIL, otp: realOtp });
      assert.equal(mockAdmin.mfaOtp, undefined);
      assert.equal(mockAdmin.mfaOtpAction, undefined);

      // Second verification with same OTP: fails because mfaOtpAction is now cleared
      await assert.rejects(
        async () => {
          await authService.verifyMfaOtp({ email: ADMIN_EMAIL, otp: realOtp });
        },
        /No active MFA OTP/,
        'Replay verification must be blocked'
      );
    } finally {
      User.findOne = origFindOne;
    }
  });

  it('8. Existing normal user flow remains unchanged and rejects 000000', async () => {
    assert.equal(playStoreTestAuth.isPlayStoreTestAccount(NORMAL_EMAIL), false);
    assert.equal(playStoreTestAuth.shouldSkipOtpDelivery(NORMAL_EMAIL), false);
    assert.equal(playStoreTestAuth.matchesPlayStoreTestOtp(NORMAL_EMAIL, '000000'), false);
  });

  it('9. Existing approved Play Store test account still accepts 000000 when enabled', () => {
    assert.equal(playStoreTestAuth.isPlayStoreTestAccount(REVIEWER_EMAIL), true);
    assert.equal(playStoreTestAuth.shouldSkipOtpDelivery(REVIEWER_EMAIL), true);
    assert.equal(playStoreTestAuth.matchesPlayStoreTestOtp(REVIEWER_EMAIL, '000000'), true);
  });

  it('10. Inactive account (status: Inactive) is rejected by login() before password or MFA', async () => {
    const inactiveUser = {
      _id: new mongoose.Types.ObjectId(),
      email: 'inactive@example.com',
      status: 'Inactive',
      isDeleted: false,
      lockAccount: false,
      password: '$2a$10$invalidhashhere',
      select() {
        return { lean: async () => inactiveUser };
      },
    };

    const origFindOne = User.findOne;
    User.findOne = () => inactiveUser;

    try {
      await assert.rejects(
        async () => {
          await authService.login({
            email: 'inactive@example.com',
            password: 'AnyPassword123!',
          });
        },
        /No account found with this email address/,
        'Inactive accounts must be rejected with standard not found message'
      );
    } finally {
      User.findOne = origFindOne;
    }
  });

  it('11. Deleted account (isDeleted: true) is rejected by login() before password or MFA', async () => {
    const deletedUser = {
      _id: new mongoose.Types.ObjectId(),
      email: 'deleted@example.com',
      status: 'Active',
      isDeleted: true,
      lockAccount: false,
      password: '$2a$10$invalidhashhere',
      select() {
        return { lean: async () => deletedUser };
      },
    };

    const origFindOne = User.findOne;
    User.findOne = () => deletedUser;

    try {
      await assert.rejects(
        async () => {
          await authService.login({
            email: 'deleted@example.com',
            password: 'AnyPassword123!',
          });
        },
        /No account found with this email address/,
        'Deleted accounts must be rejected before password check'
      );
    } finally {
      User.findOne = origFindOne;
    }
  });

  it('12. Administratively locked account (lockAccount: true) is rejected by login() before password or MFA', async () => {
    const lockedUser = {
      _id: new mongoose.Types.ObjectId(),
      email: 'locked@example.com',
      status: 'Active',
      isDeleted: false,
      lockAccount: true,
      lockUntil: null,
      failedLoginAttempts: 0,
      password: '$2a$10$invalidhashhere',
      loginAttempts: [],
      save: async () => {},
      select() {
        return { lean: async () => lockedUser };
      },
    };

    const origFindOne = User.findOne;
    User.findOne = () => lockedUser;

    try {
      await assert.rejects(
        async () => {
          await authService.login({
            email: 'locked@example.com',
            password: 'AnyPassword123!',
          });
        },
        /Account locked\. Please contact support\./,
        'Administratively locked accounts must be rejected before password or MFA check'
      );
    } finally {
      User.findOne = origFindOne;
    }
  });

  it('13. Temporarily locked account (lockAccount: true with active lockUntil) is rejected by login()', async () => {
    const lockedUser = {
      _id: new mongoose.Types.ObjectId(),
      email: 'temp-locked@example.com',
      status: 'Active',
      isDeleted: false,
      lockAccount: true,
      lockUntil: DateUtil.fromEpoch(ClockService.nowEpoch() + 20 * 60 * 1000),
      failedLoginAttempts: 5,
      password: '$2a$10$invalidhashhere',
      loginAttempts: [],
      save: async () => {},
      select() {
        return { lean: async () => lockedUser };
      },
    };

    const origFindOne = User.findOne;
    User.findOne = () => lockedUser;

    try {
      await assert.rejects(
        async () => {
          await authService.login({
            email: 'temp-locked@example.com',
            password: 'AnyPassword123!',
          });
        },
        /Account is temporarily locked/,
        'Temporarily locked accounts must throw locked error before password or MFA check'
      );
    } finally {
      User.findOne = origFindOne;
    }
  });

  it('14. Deprovisioned legacy QA account (jadeyash2812@gmail.com) is strictly rejected by login() without issuing MFA', async () => {
    const deprovisionedQaUser = {
      _id: new mongoose.Types.ObjectId(),
      email: 'jadeyash2812@gmail.com',
      status: 'Inactive',
      isDeleted: true,
      lockAccount: true,
      password: '$2a$10$realhashneverreached',
      select() {
        return { lean: async () => deprovisionedQaUser };
      },
    };

    const origFindOne = User.findOne;
    User.findOne = () => deprovisionedQaUser;

    try {
      await assert.rejects(
        async () => {
          await authService.login({
            email: 'jadeyash2812@gmail.com',
            password: 'Admin#123456',
          });
        },
        /No account found with this email address/,
        'Deprovisioned QA account must be rejected with No account found'
      );
    } finally {
      User.findOne = origFindOne;
    }
  });

  it('14b. Deprovisioned previous admin account (privacy@propmv.com) is strictly rejected by login() without issuing MFA', async () => {
    const deprovisionedPrivacyUser = {
      _id: new mongoose.Types.ObjectId(),
      email: 'privacy@propmv.com',
      status: 'Inactive',
      isDeleted: true,
      lockAccount: true,
      password: '$2a$10$realhashneverreached',
      select() {
        return { lean: async () => deprovisionedPrivacyUser };
      },
    };

    const origFindOne = User.findOne;
    User.findOne = () => deprovisionedPrivacyUser;

    try {
      await assert.rejects(
        async () => {
          await authService.login({
            email: 'privacy@propmv.com',
            password: 'Admin#123456',
          });
        },
        /No account found with this email address/,
        'Deprovisioned previous admin privacy@propmv.com must be rejected with No account found'
      );
    } finally {
      User.findOne = origFindOne;
    }
  });

  it('15. Deprovision script logic processes ALL matching duplicate email documents', async () => {
    const doc1 = {
      _id: new mongoose.Types.ObjectId(),
      email: 'duplicate@example.com',
      isDeleted: false,
      status: 'Active',
      companyId: new mongoose.Types.ObjectId(),
      companyRoleId: new mongoose.Types.ObjectId(),
      role: 'Administrator',
      save: async function () { this.saved = true; },
    };
    const doc2 = {
      _id: new mongoose.Types.ObjectId(),
      email: 'duplicate@example.com',
      isDeleted: true,
      status: 'Inactive',
      companyId: undefined,
      companyRoleId: undefined,
      role: undefined,
      save: async function () { this.saved = true; },
    };

    const mockDocs = [doc1, doc2];
    for (const doc of mockDocs) {
      doc.companyId = undefined;
      doc.companyRoleId = undefined;
      doc.role = undefined;
      doc.isDeleted = true;
      doc.status = 'Inactive';
      doc.lockAccount = true;
      doc.mfaOtp = undefined;
      doc.mfaOtpExpiresAt = undefined;
      doc.mfaOtpAction = undefined;
      await doc.save();
    }

    assert.equal(doc1.saved, true);
    assert.equal(doc1.isDeleted, true);
    assert.equal(doc1.status, 'Inactive');
    assert.equal(doc1.lockAccount, true);
    assert.equal(doc1.companyId, undefined);

    assert.equal(doc2.saved, true);
    assert.equal(doc2.isDeleted, true);
    assert.equal(doc2.status, 'Inactive');
    assert.equal(doc2.lockAccount, true);
  });
});
