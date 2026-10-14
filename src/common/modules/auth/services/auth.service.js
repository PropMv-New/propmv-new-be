/**
 * ------------------------------------------------------------------
 * File: auth.service.js
 * Module: Src Common Modules Auth Services
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * auth.controller, auth
 * ------------------------------------------------------------------
 */

const bcrypt = require('bcryptjs');
const logger = require('../../../logger');
const { generateAccessToken, generateRefreshToken, verifyRefreshToken } = require('../../../helpers/jwtHelper');

const MFA_SESSION_VALIDITY_HOURS = Number(
  process.env.MFA_SESSION_VALIDITY_HOURS ||
    process.env.MFA_LOGIN_WINDOW_HOURS ||
    6
);
const MFA_LOGIN_WINDOW_MS = MFA_SESSION_VALIDITY_HOURS * 60 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS_HISTORY = 50;

/**
 * append Login Attempt
 *
 * Performs logic operations for appendLoginAttempt.
 *
 * @param userDoc - Request/input argument
 * @param options - Request/input argument
 * @param reason - Request/input argument
 * @param ip - Request/input argument
 * @param userAgent - Request/input argument
 * @param requiresMfa - Request/input argument
 * @returns Operations result
 */
function appendLoginAttempt(userDoc, { success, reason, ip, userAgent, requiresMfa = false }) {
  const attempts = Array.isArray(userDoc.loginAttempts) ? userDoc.loginAttempts : [];
  attempts.push({
    at: new Date(),
    success: !!success,
    reason: reason || null,
    ip: ip || null,
    userAgent: userAgent || null,
    requiresMfa: !!requiresMfa,
  });
  userDoc.loginAttempts = attempts.slice(-MAX_LOGIN_ATTEMPTS_HISTORY);
}

async function register({ email, password, phone, firstName, lastName, address, state, zipCode, role, profilePic, dob, gender, UserModel }) {
  const { checkTransactionSupport } = require('../../../helpers/transactionHelper');
  const mongoose = require('mongoose');
  const transactionsSupported = await checkTransactionSupport();
  let session;
  if (transactionsSupported) {
    session = await mongoose.startSession();
    session.startTransaction();
  }
  try {
    const existing = transactionsSupported
      ? await UserModel.findOne({ email }).session(session)
      : await UserModel.findOne({ email });
    if (existing) throw new Error('Email already exists');

    const { isValidEncryptedPassword, decryptIfEnabled, isEncryptionEnabled } = require('../../../helpers/cryptoHelper');
    const { decryptedPasswordSchema } = require('../validators/auth.validator');
    let plainPassword = password;
    if (isEncryptionEnabled()) {
      if (!isValidEncryptedPassword(password)) throw new Error('Password must be encrypted using AES-256-CBC base64 encoding');
      plainPassword = decryptIfEnabled(password);
    }
    const pwValidation = decryptedPasswordSchema.validate({ password: plainPassword }, { abortEarly: false });
    if (pwValidation.error) throw new Error('Password validation failed: ' + pwValidation.error.details.map(d => d.message).join('; '));

    const hashed = await bcrypt.hash(plainPassword, 10);
    const { USER_VERSION } = require('../../../constants/user');
    const userFields = {
      email: email ?? null,
      password: hashed,
      phone: phone ?? null,
      firstName: firstName ?? null,
      lastName: lastName ?? null,
      address: address ?? null,
      state: state ?? null,
      zipCode: zipCode ?? null,
      role: role ?? null,
      version: (typeof version === 'string' && version.trim()) ? version : (USER_VERSION || null),
      profilePic: profilePic ?? null,
      dob: dob ?? null,
      gender: gender ?? null,
      resetPasswordToken: null,
      resetPasswordExpiresAt: null,
      resetPasswordOtp: null,
      resetPasswordOtpExpiresAt: null,
      mfaOtp: null,
      mfaOtpExpiresAt: null,
      mfaOtpAction: null,
      mfaLoginVerifiedAt: null,
      refreshToken: null,
      lockAccount: false,
      failedLoginAttempts: 0,
      lockUntil: null,
      loginAttempts: []
    };

    let user;
    if (transactionsSupported) {
      const userDoc = await UserModel.create([userFields], { session });
      user = userDoc[0];
    } else {
      user = await UserModel.create(userFields);
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
    user.mfaOtp = otp;
    user.mfaOtpExpiresAt = otpExpiresAt;
    user.mfaOtpAction = 'signup';
    
    if (transactionsSupported) {
      await user.save({ session });
      await session.commitTransaction();
      session.endSession();
    } else {
      await user.save();
    }

    const { sendMfaOtpEmail } = require('../../../helpers/emailHelper');
    let emailDeliveryFailed = false;
    try {
      await sendMfaOtpEmail(email, otp, user.firstName || 'User', 'signup');
    } catch (emailErr) {
      emailDeliveryFailed = true;
      logger.warn('[Auth] Signup OTP email failed:', emailErr.message);
    }
    return { email: user.email, mfaRequired: true, emailDeliveryFailed };
  } catch (err) {
    if (transactionsSupported && session) {
      await session.abortTransaction();
      session.endSession();
    }
    throw err;
  }
}

async function login({ email, password, UserModel, loginMeta }) {
  const { isValidEncryptedPassword, decryptIfEnabled, isEncryptionEnabled } = require('../../../helpers/cryptoHelper');
  const ip = loginMeta && loginMeta.ip ? loginMeta.ip : null;
  const userAgent = loginMeta && loginMeta.userAgent ? loginMeta.userAgent : null;
  let plainPassword = password;
  if (isEncryptionEnabled()) {
    if (!isValidEncryptedPassword(password)) throw new Error('Password must be encrypted using AES-256-CBC base64 encoding');
    plainPassword = decryptIfEnabled(password);
  }
  const userDoc = await UserModel.findOne({ email }).populate({
    path: 'role',
    populate: {
      path: 'functions',
      select: 'name',
      model: 'Function'
    }
  });
  if (!userDoc) throw new Error('Invalid credentials');

  await checkAndUnlockExpiredAccount(userDoc);

  if (userDoc.lockAccount && userDoc.lockUntil && userDoc.lockUntil > new Date()) {
    appendLoginAttempt(userDoc, {
      success: false,
      reason: 'account_locked',
      ip,
      userAgent,
      requiresMfa: false,
    });
    await userDoc.save();
    throw new Error('Account is temporarily locked due to multiple failed login attempts');
  }

  const valid = await bcrypt.compare(plainPassword, userDoc.password);
  
  if (!valid) {
    userDoc.failedLoginAttempts = (userDoc.failedLoginAttempts || 0) + 1;
    if (userDoc.failedLoginAttempts >= 5) {
      userDoc.lockAccount = true;
      userDoc.lockUntil = new Date(Date.now() + 30 * 60 * 1000);
    }
    appendLoginAttempt(userDoc, {
      success: false,
      reason: userDoc.failedLoginAttempts >= 5 ? 'invalid_password_account_locked' : 'invalid_password',
      ip,
      userAgent,
      requiresMfa: false,
    });
    await userDoc.save();
    throw new Error('Invalid credentials');
  }

  userDoc.failedLoginAttempts = 0;
  userDoc.lockAccount = false;
  userDoc.lockUntil = null;

  const now = Date.now();
  const hasValidMfaWindow = !!(userDoc.mfaLoginVerifiedAt && (new Date(userDoc.mfaLoginVerifiedAt).getTime() + MFA_LOGIN_WINDOW_MS > now));
  if (hasValidMfaWindow) {
    const roleName = userDoc.role && userDoc.role.name ? userDoc.role.name : undefined;
    // Fetch user privileges to include in token - use role.privileges field directly
    const privileges = (userDoc.role && Array.isArray(userDoc.role.privileges)) 
      ? userDoc.role.privileges
      : [];
    const accessToken = generateAccessToken({ sub: userDoc._id.toString(), role: roleName }, privileges);
    const refreshToken = generateRefreshToken({ sub: userDoc._id.toString() });
    userDoc.refreshToken = refreshToken;
    userDoc.mfaOtp = undefined;
    userDoc.mfaOtpExpiresAt = undefined;
    userDoc.mfaOtpAction = undefined;
    appendLoginAttempt(userDoc, {
      success: true,
      reason: 'login_success_mfa_skipped_trusted_window',
      ip,
      userAgent,
      requiresMfa: false,
    });
    await userDoc.save();
    const mfaValidUntil = new Date(new Date(userDoc.mfaLoginVerifiedAt).getTime() + MFA_LOGIN_WINDOW_MS).toISOString();
    return { accessToken, refreshToken, user: userDoc.toSafeJSON(), mfaRequired: false, mfaSkipped: true, mfaValidUntil, privileges };
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  userDoc.mfaOtp = otp;
  userDoc.mfaOtpExpiresAt = otpExpiresAt;
  userDoc.mfaOtpAction = 'login';
  appendLoginAttempt(userDoc, {
    success: true,
    reason: 'password_verified_mfa_required',
    ip,
    userAgent,
    requiresMfa: true,
  });
  await userDoc.save();

  const { sendMfaOtpEmail } = require('../../../helpers/emailHelper');
  let emailDeliveryFailed = false;
  try {
    await sendMfaOtpEmail(email, otp, userDoc.firstName || 'User', 'login');
  } catch (emailErr) {
    emailDeliveryFailed = true;
    logger.warn('[Auth] Login OTP email failed:', emailErr.message);
  }
  return { email: userDoc.email, mfaRequired: true, emailDeliveryFailed };
}

async function refreshToken(refreshToken, UserModel) {
  const payload = verifyRefreshToken(refreshToken);
  const userDoc = await UserModel.findById(payload.sub).populate({
    path: 'role',
    populate: {
      path: 'functions',
      select: 'name',
      model: 'Function'
    }
  });
  if (!userDoc || userDoc.refreshToken !== refreshToken) {
    throw new Error('Invalid refresh token');
  }
  const roleName = userDoc.role && userDoc.role.name ? userDoc.role.name : undefined;
  // Fetch user privileges to include in new token - use role.privileges field directly
  const privileges = (userDoc.role && Array.isArray(userDoc.role.privileges)) 
    ? userDoc.role.privileges
    : [];
  const accessToken = generateAccessToken({ sub: userDoc._id.toString(), role: roleName }, privileges);
  return { accessToken, privileges };
}

async function logout(userId, UserModel) {
  const mongoose = require('mongoose');
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    await UserModel.findByIdAndUpdate(userId, { $unset: { refreshToken: 1 } }, { session });
    await session.commitTransaction();
    session.endSession();
    return true;
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

async function forgotPassword({ email, UserModel }) {
  const mongoose = require('mongoose');
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const userDoc = await UserModel.findOne({ email }).session(session);
    if (!userDoc) {
      await session.commitTransaction();
      session.endSession();
      return true;
    }
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
    userDoc.resetPasswordOtp = otp;
    userDoc.resetPasswordOtpExpiresAt = otpExpiresAt;
    await userDoc.save({ session });
    await session.commitTransaction();
    session.endSession();
    const { sendForgotPasswordEmail } = require('../../../helpers/emailHelper');
    let emailDeliveryFailed = false;
    try {
      await sendForgotPasswordEmail(email, otp, userDoc.firstName || 'User');
    } catch (emailErr) {
      emailDeliveryFailed = true;
      logger.warn('[Auth] Forgot password email failed:', emailErr.message);
    }
    return { emailDeliveryFailed };
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

async function verifyOtpAndResetPassword({ email, otp, newPassword, confirmPassword, UserModel }) {
  const mongoose = require('mongoose');
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { isValidEncryptedPassword, decryptIfEnabled, isEncryptionEnabled } = require('../../../helpers/cryptoHelper');
    const { decryptedPasswordSchema } = require('../validators/auth.validator');
    let plainNew = newPassword;
    let plainConfirm = confirmPassword;
    if (isEncryptionEnabled()) {
      if (!isValidEncryptedPassword(newPassword) || !isValidEncryptedPassword(confirmPassword)) {
        throw new Error('Passwords must be encrypted using AES-256-CBC base64 encoding');
      }
      plainNew = decryptIfEnabled(newPassword);
      plainConfirm = decryptIfEnabled(confirmPassword);
    }
    const pwValidation = decryptedPasswordSchema.validate({ password: plainNew }, { abortEarly: false });
    if (pwValidation.error) throw new Error('Password validation failed: ' + pwValidation.error.details.map(d => d.message).join('; '));
    if (plainNew !== plainConfirm) throw new Error('New password and confirm password do not match');

    const userDoc = await UserModel.findOne({ email }).session(session);
    if (!userDoc) {
      throw new Error('Invalid email or OTP');
    }
    if (userDoc.resetPasswordOtp !== otp) {
      throw new Error('Invalid OTP');
    }
    if (!userDoc.resetPasswordOtpExpiresAt || userDoc.resetPasswordOtpExpiresAt < new Date()) {
      throw new Error('OTP has expired. Please request a new one.');
    }
    const hashedNewPassword = await bcrypt.hash(plainNew, 10);
    userDoc.password = hashedNewPassword;
    userDoc.resetPasswordOtp = undefined;
    userDoc.resetPasswordOtpExpiresAt = undefined;
    await userDoc.save({ session });
    await session.commitTransaction();
    session.endSession();
    return true;
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

async function resetPassword({ userId, currentPassword, newPassword, confirmPassword, UserModel }) {
  const mongoose = require('mongoose');
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { isValidEncryptedPassword, decryptIfEnabled, isEncryptionEnabled } = require('../../../helpers/cryptoHelper');
    const { decryptedPasswordSchema } = require('../validators/auth.validator');
    let plainCurrent = currentPassword;
    let plainNew = newPassword;
    let plainConfirm = confirmPassword;
    if (isEncryptionEnabled()) {
      if (!isValidEncryptedPassword(currentPassword) || !isValidEncryptedPassword(newPassword) || !isValidEncryptedPassword(confirmPassword)) {
        throw new Error('Passwords must be encrypted using AES-256-CBC base64 encoding');
      }
      plainCurrent = decryptIfEnabled(currentPassword);
      plainNew = decryptIfEnabled(newPassword);
      plainConfirm = decryptIfEnabled(confirmPassword);
    }
    const pwValidation = decryptedPasswordSchema.validate({ password: plainNew }, { abortEarly: false });
    if (pwValidation.error) throw new Error('Password validation failed: ' + pwValidation.error.details.map(d => d.message).join('; '));
    if (plainNew !== plainConfirm) throw new Error('New password and confirm password do not match');

    const userDoc = await UserModel.findById(userId).session(session);
    if (!userDoc) throw new Error('User not found');
    const isValidCurrentPassword = await bcrypt.compare(plainCurrent, userDoc.password);
    if (!isValidCurrentPassword) {
      throw new Error('Current password is incorrect');
    }
    const hashedNewPassword = await bcrypt.hash(plainNew, 10);
    userDoc.password = hashedNewPassword;
    await userDoc.save({ session });
    await session.commitTransaction();
    session.endSession();
    return true;
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

async function checkAndUnlockExpiredAccount(userDoc) {
  if (userDoc.lockAccount && userDoc.lockUntil && userDoc.lockUntil <= new Date()) {
    userDoc.lockAccount = false;
    userDoc.lockUntil = null;
    userDoc.failedLoginAttempts = 0;
    await userDoc.save();
    logger.info(`Account ${userDoc.email} automatically unlocked after lock expiration`);
  }
  return userDoc;
}

async function lockAccount(userId, UserModel) {
  const userDoc = await UserModel.findById(userId);
  if (!userDoc) throw new Error('User not found');
  
  const wasLocked = userDoc.lockAccount || false;
  userDoc.lockAccount = !wasLocked;
  
  if (!userDoc.lockAccount) {
    userDoc.failedLoginAttempts = 0;
    userDoc.lockUntil = null;
  } else {
    userDoc.lockUntil = new Date(Date.now() + 30 * 60 * 1000);
  }
  
  await userDoc.save();
  
  return { 
    message: userDoc.lockAccount ? 'Account locked successfully' : 'Account unlocked successfully',
    isLocked: userDoc.lockAccount,
    lockedAt: userDoc.lockAccount ? new Date() : null,
    unlockedAt: !userDoc.lockAccount ? new Date() : null
  };
}

async function unlockAccount(userId, requestedById, UserModel) {
  if (requestedById && String(requestedById) === String(userId)) {
    throw new Error('Users cannot unlock their own account. Please contact an administrator.');
  }
  const userDoc = await UserModel.findById(userId);
  if (!userDoc) throw new Error('User not found');
  
  userDoc.lockAccount = false;
  userDoc.lockUntil = null;
  userDoc.failedLoginAttempts = 0;
  
  await userDoc.save();
  
  return { 
    message: 'Account unlocked successfully',
    isLocked: false,
    unlockedAt: new Date(),
    failedAttemptsReset: true
  };
}

async function getSession(userId, UserModel) {
  const userDoc = await UserModel.findById(userId);
  if (!userDoc) throw new Error('User not found');
  
  await checkAndUnlockExpiredAccount(userDoc);
  
  return {
    user: userDoc.toSafeJSON(),
    isLocked: userDoc.lockAccount && userDoc.lockUntil && userDoc.lockUntil > new Date(),
    lockUntil: userDoc.lockUntil,
    failedAttempts: userDoc.failedLoginAttempts,
    lastLogin: userDoc.updatedAt,
    sessionRetrievedAt: new Date(),
    accountStatus: userDoc.lockAccount ? 'locked' : 'active'
  };
}

async function sendMfaOtp({ email, action, UserModel }) {
  const mongoose = require('mongoose');
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const userDoc = await UserModel.findOne({ email }).session(session);
    if (!userDoc) {
      await session.commitTransaction();
      session.endSession();
      return true;
    }
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
    userDoc.mfaOtp = otp;
    userDoc.mfaOtpExpiresAt = otpExpiresAt;
    userDoc.mfaOtpAction = action;
    await userDoc.save({ session });
    await session.commitTransaction();
    session.endSession();
    const { sendMfaOtpEmail } = require('../../../helpers/emailHelper');
    let emailDeliveryFailed = false;
    try {
      await sendMfaOtpEmail(email, otp, userDoc.firstName || 'User', action);
    } catch (emailErr) {
      emailDeliveryFailed = true;
      logger.warn('[Auth] MFA OTP email failed:', emailErr.message);
    }
    return { emailDeliveryFailed };
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

async function verifyMfaOtp({ email, otp, UserModel, loginMeta }) {
  const ip = loginMeta && loginMeta.ip ? loginMeta.ip : null;
  const userAgent = loginMeta && loginMeta.userAgent ? loginMeta.userAgent : null;
  const userDoc = await UserModel.findOne({ email }).populate({
    path: 'role',
    populate: {
      path: 'functions',
      select: 'name',
      model: 'Function'
    }
  });
  if (!userDoc) throw new Error('Invalid email or OTP');
  if (userDoc.mfaOtp !== otp) throw new Error('Invalid OTP');
  if (!userDoc.mfaOtpExpiresAt || userDoc.mfaOtpExpiresAt < new Date()) {
    throw new Error('OTP has expired. Please request a new one.');
  }
  
  const action = userDoc.mfaOtpAction;
  const wasSignup = action === 'signup';
  userDoc.mfaOtp = undefined;
  userDoc.mfaOtpExpiresAt = undefined;
  userDoc.mfaOtpAction = undefined;
  if (action === 'login') {
    userDoc.mfaLoginVerifiedAt = new Date();
    appendLoginAttempt(userDoc, {
      success: true,
      reason: 'mfa_verified_login_success',
      ip,
      userAgent,
      requiresMfa: false,
    });
  }
  
  const roleName = userDoc.role && userDoc.role.name ? userDoc.role.name : undefined;
  // Fetch user privileges to include in token - use role.privileges field directly
  const privileges = (userDoc.role && Array.isArray(userDoc.role.privileges)) 
    ? userDoc.role.privileges
    : [];
  const accessToken = generateAccessToken({ sub: userDoc._id.toString(), role: roleName }, privileges);
  const refreshToken = generateRefreshToken({ sub: userDoc._id.toString() });
  userDoc.refreshToken = refreshToken;
  await userDoc.save();
  
  const result = { accessToken, refreshToken, user: userDoc.toSafeJSON(), action, privileges };
  if (action === 'login' && userDoc.mfaLoginVerifiedAt) {
    result.mfaValidUntil = new Date(
      new Date(userDoc.mfaLoginVerifiedAt).getTime() + MFA_LOGIN_WINDOW_MS
    ).toISOString();
  }

  if (wasSignup && userDoc.email) {
    const { notifyWelcomeEmailInBackground } = require('../../../helpers/emailHelper');
    notifyWelcomeEmailInBackground(userDoc.email, {
      userName: userDoc.firstName || userDoc.email,
      roleName: roleName || '',
    });
  }

  return result;
}

module.exports = {
  register,
  login,
  refreshToken,
  logout,
  forgotPassword,
  verifyOtpAndResetPassword,
  resetPassword,
  lockAccount,
  unlockAccount,
  getSession,
  sendMfaOtp,
  verifyMfaOtp,
};
