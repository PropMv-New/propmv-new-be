const User = require('../../users/models/user.model');
const { normalizeUserPhone } = require('../../users/helpers/userIdentityValidation');
const { ClockService, DateUtil } = require('../../../../common/date');
const otpResendLimiter = require('../../../../services/otpResendLimiter.service');
const logger = require('../../../../common/logger');

const PAYMENT_VERIFY_SCOPE = 'payment-verify';
const OTP_VALIDITY_MS = 10 * 60 * 1000;

function isDevLikeEnv() {
  return (
    !process.env.NODE_ENV ||
    process.env.NODE_ENV === 'development' ||
    process.env.NODE_ENV === 'test'
  );
}

function shouldExposeDevOtp() {
  return isDevLikeEnv() && String(process.env.AUTH_EXPOSE_OTP_IN_RESPONSE).toLowerCase() === 'true';
}

function maybeDevOtp(otp) {
  return shouldExposeDevOtp() ? { devOtp: String(otp) } : {};
}

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendPaymentVerifyOtp({ userId, phone, resend = false }) {
  const normalizedPhone = normalizeUserPhone(phone);
  if (!normalizedPhone) {
    throw new Error('Phone number format is invalid');
  }

  await otpResendLimiter.assertCanResend(PAYMENT_VERIFY_SCOPE, userId);

  const userDoc = await User.findOne({ _id: userId, isDeleted: { $ne: true } });
  if (!userDoc) {
    throw new Error('User not found');
  }

  const otp = generateOtp();
  const otpExpiresAt = DateUtil.fromEpoch(ClockService.nowEpoch() + OTP_VALIDITY_MS);

  userDoc.mfaOtp = otp;
  userDoc.mfaOtpExpiresAt = otpExpiresAt;
  userDoc.mfaOtpAction = 'payment-verify';
  userDoc.phone = normalizedPhone;
  await userDoc.save();

  logger.info('[PaymentVerify] Verification code generated');

  const { sendMfaOtpEmail } = require('../../../../common/helpers/emailHelper');
  let emailDeliveryFailed = false;
  try {
    await sendMfaOtpEmail(
      userDoc.email,
      otp,
      userDoc.firstName || 'User',
      'payment-verify'
    );
  } catch (emailError) {
    emailDeliveryFailed = true;
    logger.warn('[PaymentVerify] Email sending failed:', emailError.message);
  }

  const otpResendMeta = await otpResendLimiter.recordOtpSent(
    PAYMENT_VERIFY_SCOPE,
    userId,
    resend ? 'resend' : 'initial'
  );

  return {
    email: userDoc.email,
    emailDeliveryFailed,
    otpResendMeta,
    ...maybeDevOtp(otp),
  };
}

async function verifyPaymentVerifyOtp({ userId, phone, otp }) {
  const normalizedPhone = normalizeUserPhone(phone);
  const normalizedOtp = String(otp || '').trim();
  if (!normalizedPhone) {
    throw new Error('Phone number format is invalid');
  }
  if (!normalizedOtp) {
    throw new Error('Verification code is required');
  }

  const userDoc = await User.findOne({ _id: userId, isDeleted: { $ne: true } });
  if (!userDoc) {
    throw new Error('User not found');
  }

  if (userDoc.mfaOtpAction !== 'payment-verify') {
    throw new Error('No active payment verification code. Please request a new code.');
  }
  if (!userDoc.mfaOtp || String(userDoc.mfaOtp).trim() !== normalizedOtp) {
    throw new Error('Invalid verification code');
  }
  if (!userDoc.mfaOtpExpiresAt || userDoc.mfaOtpExpiresAt < ClockService.now()) {
    throw new Error('Verification code has expired. Please request a new one.');
  }

  userDoc.phone = normalizedPhone;
  userDoc.mfaOtp = undefined;
  userDoc.mfaOtpExpiresAt = undefined;
  userDoc.mfaOtpAction = undefined;
  await userDoc.save();

  return { verified: true };
}

module.exports = {
  sendPaymentVerifyOtp,
  verifyPaymentVerifyOtp,
};
