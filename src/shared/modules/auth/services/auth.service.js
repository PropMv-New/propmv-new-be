/**
 * ------------------------------------------------------------------
 * File: auth.service.js
 * Module: Src Shared Modules Auth Services
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * auth.controller
 * ------------------------------------------------------------------
 */
const bcrypt = require('bcryptjs');
const User = require('../../users/models/user.model');
const logger = require('../../../../common/logger');
const {
  assertUniqueUserEmail,
  assertUniqueUserPhone,
  normalizeUserEmail,
  normalizeUserPhone,
  findUserByEmail,
  findUserByPhone,
  DUPLICATE_EMAIL_MESSAGE,
  DUPLICATE_PHONE_MESSAGE,
  mapUserPersistenceError,
} = require('../../users/helpers/userIdentityValidation');
const { generateAccessToken, generateRefreshToken, verifyRefreshToken } = require('../../../../common/helpers/jwtHelper');
const { ClockService, DateUtil } = require('../../../../common/date');
const crypto = require('crypto');
const { PORTAL_ONBOARDING_STATUS } = require('../../../../common/constants/portalOnboarding');
const otpResendLimiter = require('../../../../services/otpResendLimiter.service');
const playStoreTestAuth = require('../helpers/playStoreTestAuth.helper');

const MFA_SESSION_VALIDITY_HOURS = Number(
  process.env.MFA_SESSION_VALIDITY_HOURS ||
  process.env.MFA_LOGIN_WINDOW_HOURS ||
  6
);
const MFA_LOGIN_WINDOW_MS = MFA_SESSION_VALIDITY_HOURS * 60 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS_HISTORY = 50;
const { parseAddressString } = require('../../../../common/helpers/addressHelper');

function isDevLikeEnv() {
  return (
    !process.env.NODE_ENV ||
    process.env.NODE_ENV === 'development' ||
    process.env.NODE_ENV === 'test'
  );
}

/** Local/dev only: include OTP in API responses when AUTH_EXPOSE_OTP_IN_RESPONSE=true */
function shouldExposeDevOtp() {
  return isDevLikeEnv() && String(process.env.AUTH_EXPOSE_OTP_IN_RESPONSE).toLowerCase() === 'true';
}

function maybeDevOtp(otp) {
  return shouldExposeDevOtp() ? { devOtp: String(otp) } : {};
}

function withTrustedDeviceDays(payload = {}) {
  const { getTrustedDeviceDays } = require('../helpers/deviceFingerprint.helper');
  return {
    ...payload,
    trustedDeviceDays: getTrustedDeviceDays(),
  };
}

/** Self-serve signup pending email OTP (not portal-invite onboarding). */
function needsSignupEmailVerification(user) {
  if (!user) return false;
  if (
    user.portalOnboardingStatus === PORTAL_ONBOARDING_STATUS.INVITATION_SENT ||
    user.portalOnboardingStatus === PORTAL_ONBOARDING_STATUS.PENDING_VERIFICATION
  ) {
    return false;
  }
  if (user.emailVerifiedAt instanceof Date) return false;
  if (user.emailVerifiedAt === null) return true;
  // Legacy unfinished signup: OTP action still signup
  return user.mfaOtpAction === 'signup';
}

function generateMfaOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/** Record that a verification code was issued. The code itself is never logged. */
function logOtpGenerated(email, action) {
  logger.info(`[Auth] Verification code generated (${action}) for ${email}`);
}

const getEmailSendTimeoutMs = () => Number(process.env.AUTH_EMAIL_TIMEOUT_MS) || 15000;

async function sendSignupOrLoginOtpEmail(email, otp, firstName, action) {
  if (playStoreTestAuth.shouldSkipOtpDelivery(email)) {
    logger.info('[Auth] Skipping OTP delivery for Play Store reviewer account', { email, action });
    return false;
  }
  const { sendMfaOtpEmail } = require('../../../../common/helpers/emailHelper');
  let emailDeliveryFailed = false;

  const sendPromise = sendMfaOtpEmail(email, otp, firstName || 'User', action);
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Email send timeout')), getEmailSendTimeoutMs())
  );

  try {
    await Promise.race([sendPromise, timeoutPromise]);
  } catch (emailError) {
    const timedOut = emailError?.message === 'Email send timeout';
    if (timedOut) {
      // Do not flag delivery failure on timeout - SMTP may still be sending (common locally).
      sendPromise.catch((bgError) => {
        logger.warn('[Auth] Background email send failed after timeout:', bgError.message);
      });
    } else {
      emailDeliveryFailed = true;
      logger.warn('[Auth] Email sending failed:', emailError.message);
      // Let the send continue in background so it can still deliver if SMTP recovers
      sendPromise.catch(() => { });
    }
  }
  return emailDeliveryFailed;
}

/**
 * Issue a fresh signup verification OTP and attempt email delivery.
 * @returns {{ emailDeliveryFailed: boolean, otp: string }}
 */
async function issueSignupVerificationOtp(userDoc, { saveOpts } = {}) {
  const otp = generateMfaOtp();
  userDoc.mfaOtp = otp;
  userDoc.mfaOtpExpiresAt = DateUtil.fromEpoch(ClockService.nowEpoch() + 10 * 60 * 1000);
  userDoc.mfaOtpAction = 'signup';
  if (userDoc.emailVerifiedAt !== null) {
    userDoc.emailVerifiedAt = null;
  }
  logOtpGenerated(userDoc.email, 'signup');
  if (saveOpts) {
    await userDoc.save(saveOpts);
  } else {
    await userDoc.save();
  }
  const emailDeliveryFailed = await sendSignupOrLoginOtpEmail(
    userDoc.email,
    otp,
    userDoc.firstName,
    'signup'
  );
  return { emailDeliveryFailed, otp };
}

/**
 * apply Signup Address From Additional Info
 *
 * Performs logic operations for applySignupAddressFromAdditionalInfo.
 *
 * @param userFields - Request/input argument
 * @param additionalInfo - Request/input argument
 * @returns Operations result
 */
function applySignupAddressFromAdditionalInfo(userFields, additionalInfo) {
  if (!additionalInfo) return;

  const line1 =
    (additionalInfo.address != null ? String(additionalInfo.address).trim() : '') ||
    (additionalInfo.businessAddress != null ? String(additionalInfo.businessAddress).trim() : '') ||
    (additionalInfo.propertyAddress != null ? String(additionalInfo.propertyAddress).trim() : '');
  const city = additionalInfo.city != null ? String(additionalInfo.city).trim() : '';
  const state = additionalInfo.state != null ? String(additionalInfo.state).trim() : '';
  const zipCode = additionalInfo.zipCode != null ? String(additionalInfo.zipCode).trim() : '';

  if (!line1 && !city && !state && !zipCode) return;

  if (city || state || zipCode) {
    userFields.address = line1 || null;
    userFields.city = city || null;
    userFields.state = state || null;
    userFields.zipCode = zipCode || null;
    return;
  }

  const parsed = parseAddressString(line1);
  if (parsed && (parsed.city || parsed.state || parsed.zipCode)) {
    const addressParts = [parsed.line1, parsed.line2].filter(Boolean);
    userFields.address = addressParts.length > 0 ? addressParts.join(', ') : null;
    userFields.city = parsed.city || null;
    userFields.state = parsed.state || null;
    userFields.zipCode = parsed.zipCode || null;
    return;
  }

  userFields.address = line1 || null;
}

/**
 * apply Hoa Board Signup Info
 *
 * Performs logic operations for applyHoaBoardSignupInfo.
 *
 * @param userFields - Request/input argument
 * @param selectedRole - Request/input argument
 * @param additionalInfo - Request/input argument
 * @returns Operations result
 */
function applyHoaBoardSignupInfo(userFields, selectedRole, additionalInfo) {
  if (!selectedRole || selectedRole.name !== 'HOA Board Member' || !additionalInfo) return;

  const communityName = String(additionalInfo.communityName || additionalInfo.hoaName || '').trim();
  const propertyAddress = additionalInfo.propertyAddress != null
    ? String(additionalInfo.propertyAddress).trim()
    : '';
  const associationType = additionalInfo.associationType != null
    ? String(additionalInfo.associationType).trim()
    : '';
  const numberOfUnits = additionalInfo.numberOfUnits != null
    ? Number(additionalInfo.numberOfUnits)
    : undefined;

  if (!communityName && numberOfUnits == null && !associationType && !propertyAddress) return;

  userFields.hoaInfo = {
    ...(communityName ? { communityName } : {}),
    ...(numberOfUnits != null && !Number.isNaN(numberOfUnits) ? { numberOfUnits } : {}),
    ...(associationType ? { associationType } : {}),
    ...(propertyAddress ? { propertyAddress } : {}),
  };
}

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
function appendLoginAttempt(userDoc, {
  success,
  reason,
  ip,
  userAgent,
  browser = null,
  os = null,
  deviceType = null,
  city = null,
  state = null,
  country = null,
  timezone = null,
  isLocalDevelopment = false,
  requiresMfa = false,
  mfaDecision = null,
  mfaReason = null,
  deviceFingerprintHash = null,
}) {
  const attempts = Array.isArray(userDoc.loginAttempts) ? userDoc.loginAttempts : [];
  attempts.push({
    at: ClockService.now(),
    success: !!success,
    reason: reason || null,
    ip: ip || null,
    userAgent: userAgent || null,
    browser: browser || null,
    os: os || null,
    deviceType: deviceType || null,
    city: city || null,
    state: state || null,
    country: country || null,
    timezone: timezone || null,
    isLocalDevelopment: !!isLocalDevelopment,
    requiresMfa: !!requiresMfa,
    mfaDecision: mfaDecision || null,
    mfaReason: mfaReason || reason || null,
    deviceFingerprintHash: deviceFingerprintHash || null,
  });
  userDoc.loginAttempts = attempts.slice(-MAX_LOGIN_ATTEMPTS_HISTORY);
}

/** Pull location / device fields from loginMeta for loginAttempts persistence. */
function loginAttemptLocationFields(loginMeta = {}, ip = null, userAgent = null) {
  const { parseUserAgentMeta } = require('../helpers/deviceFingerprint.helper');
  const uaMeta = parseUserAgentMeta(userAgent || loginMeta.userAgent);
  return {
    ip: ip || loginMeta.ip || null,
    userAgent: userAgent || loginMeta.userAgent || null,
    browser: loginMeta.browser || uaMeta.browser || null,
    os: loginMeta.os || uaMeta.os || null,
    deviceType: loginMeta.deviceType || uaMeta.deviceType || null,
    city: loginMeta.city || null,
    state: loginMeta.state || null,
    country: loginMeta.country || null,
    timezone: loginMeta.timezone || null,
    isLocalDevelopment: !!loginMeta.isLocalDevelopment,
  };
}

/**
 * Register a new user with role-based signup and MFA OTP verification
 */
async function register({ email, password, confirmPassword, phone, firstName, lastName, roleId, profilePic, additionalInfo }) {
  const { checkTransactionSupport } = require('../../../../common/helpers/transactionHelper');
  const mongoose = require('mongoose');
  const transactionsSupported = await checkTransactionSupport();
  let session;
  if (transactionsSupported) {
    session = await mongoose.startSession();
    session.startTransaction();
  }
  try {
    // Validate email format (additional server-side check)
    const emailRegex = /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(email)) {
      throw new Error('Email contains invalid characters. Only letters, numbers, dots (.), hyphens (-), underscores (_), and plus (+) are allowed');
    }

    // Check for consecutive dots
    if (email.includes('..')) {
      throw new Error('Email cannot contain consecutive dots');
    }

    // Check if local part starts or ends with dot
    const localPart = email.split('@')[0];
    if (localPart.startsWith('.') || localPart.endsWith('.')) {
      throw new Error('Email cannot start or end with a dot');
    }

    // Check email length
    if (email.length > 254) {
      throw new Error('Email address is too long (maximum 254 characters)');
    }
    if (localPart.length > 64) {
      throw new Error('Email local part (before @) is too long (maximum 64 characters)');
    }

    // Validate phone number if provided
    if (phone) {
      const digitsOnly = phone.replace(/\D/g, '');

      // Check digit count
      if (digitsOnly.length < 10 || digitsOnly.length > 15) {
        throw new Error('Phone number must be between 10 and 15 digits');
      }

      // US phone number validation (10 digits)
      if (digitsOnly.length === 10) {
        const usPhoneRegex = /^[2-9]\d{2}[2-9]\d{6}$/;
        if (!usPhoneRegex.test(digitsOnly)) {
          throw new Error('Invalid US phone number. Must start with area code (2-9) and be 10 digits');
        }
      }

      // US phone number with country code (11 digits starting with 1)
      if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) {
        const usPhoneRegex = /^1[2-9]\d{2}[2-9]\d{6}$/;
        if (!usPhoneRegex.test(digitsOnly)) {
          throw new Error('Invalid US phone number with country code (+1)');
        }
      }

      // Check for valid characters
      if (!/^[0-9+\-\s()]+$/.test(phone)) {
        throw new Error('Phone number can only contain digits, +, -, spaces, and ()');
      }
    }

    const { isValidEncryptedPassword, decryptIfEnabled, isEncryptionEnabled } = require('../../../../common/helpers/cryptoHelper');
    const { decryptedPasswordSchema } = require('../validators/auth.validator');
    let plainPassword = password;
    let plainConfirmPassword = confirmPassword;
    if (isEncryptionEnabled()) {
      if (!isValidEncryptedPassword(password) || !isValidEncryptedPassword(confirmPassword)) {
        throw new Error('Passwords must be encrypted using AES-256-CBC base64 encoding');
      }
      plainPassword = decryptIfEnabled(password);
      plainConfirmPassword = decryptIfEnabled(confirmPassword);
    }

    // Validate passwords match
    if (plainPassword !== plainConfirmPassword) {
      throw new Error('Passwords do not match');
    }

    const pwValidation = decryptedPasswordSchema.validate({ password: plainPassword }, { abortEarly: false });
    if (pwValidation.error) throw new Error('Password validation failed: ' + pwValidation.error.details.map(d => d.message).join('; '));

    const existingByEmail = await findUserByEmail(email, null, session);
    if (existingByEmail && needsSignupEmailVerification(existingByEmail)) {
      // Resume unverified signup: do not create a duplicate; refresh OTP and password
      if (phone) {
        await assertUniqueUserPhone(phone, existingByEmail._id, session);
      }
      existingByEmail.password = await bcrypt.hash(plainPassword, 10);
      if (firstName != null) existingByEmail.firstName = firstName;
      if (lastName != null) existingByEmail.lastName = lastName;
      if (phone != null) existingByEmail.phone = phone;
      existingByEmail.emailVerifiedAt = null;
      const otp = generateMfaOtp();
      existingByEmail.mfaOtp = otp;
      existingByEmail.mfaOtpExpiresAt = DateUtil.fromEpoch(ClockService.nowEpoch() + 10 * 60 * 1000);
      existingByEmail.mfaOtpAction = 'signup';
      logOtpGenerated(existingByEmail.email, 'signup');
      if (session) {
        await existingByEmail.save({ session });
        await session.commitTransaction();
        session.endSession();
      } else {
        await existingByEmail.save();
      }
      const emailDeliveryFailed = await sendSignupOrLoginOtpEmail(
        existingByEmail.email,
        otp,
        existingByEmail.firstName,
        'signup'
      );
      return withTrustedDeviceDays({
        email: existingByEmail.email,
        mfaRequired: true,
        emailVerificationRequired: true,
        existingUnverifiedAccount: true,
        emailDeliveryFailed,
        ...maybeDevOtp(otp),
      });
    }

    await assertUniqueUserEmail(email, null, session);
    if (phone) {
      await assertUniqueUserPhone(phone, null, session);
    }

    // Validate roleId exists in PropMv company
    const Company = require('../../company/models/company.model');
    const propMvCompany = transactionsSupported
      ? await Company.findOne({ name: 'PropMv', isDeleted: { $ne: true } }).session(session)
      : await Company.findOne({ name: 'PropMv', isDeleted: { $ne: true } });

    if (!propMvCompany) {
      throw new Error('Default company not found. Please contact support.');
    }

    // Find the selected role in PropMv company
    const selectedRole = propMvCompany.roles.find(
      r => r._id.toString() === roleId.toString() && r.isActive
    );

    if (!selectedRole) {
      throw new Error('Invalid role selected');
    }

    const hashed = await bcrypt.hash(plainPassword, 10);
    const { USER_VERSION, USER_STATUSES } = require('../../../../common/constants/user');

    const userFields = {
      email: normalizeUserEmail(email) || null,
      password: hashed,
      phone: phone ?? null,
      firstName: firstName ?? null,
      lastName: lastName ?? null,
      address: null,
      city: null,
      state: null,
      zipCode: null,
      status: USER_STATUSES.ACTIVE,
      version: USER_VERSION || null,
      profilePic: profilePic ?? null,
      resetPasswordToken: null,
      resetPasswordExpiresAt: null,
      resetPasswordOtp: null,
      resetPasswordOtpExpiresAt: null,
      mfaOtp: null,
      mfaOtpExpiresAt: null,
      mfaOtpAction: null,
      mfaLoginVerifiedAt: null,
      emailVerifiedAt: null,
      refreshToken: null,
      lockAccount: false,
      failedLoginAttempts: 0,
      lockUntil: null,
      loginAttempts: []
    };

    // Store role-specific signup info in dedicated fields
    if (additionalInfo && Object.keys(additionalInfo).length > 0) {
      applySignupAddressFromAdditionalInfo(userFields, additionalInfo);
      applyHoaBoardSignupInfo(userFields, selectedRole, additionalInfo);
    }

    let user;
    if (transactionsSupported) {
      const userDoc = await User.create([userFields], { session });
      user = userDoc[0];
    } else {
      user = await User.create(userFields);
    }

    // Generate MFA OTP for signup (email sent after commit)
    const otp = generateMfaOtp();

    // Set OTP expiration time (10 minutes from now)
    const otpExpiresAt = DateUtil.fromEpoch(ClockService.nowEpoch() + 10 * 60 * 1000);
    user.mfaOtp = otp;
    user.mfaOtpExpiresAt = otpExpiresAt;
    user.mfaOtpAction = 'signup';
    user.emailVerifiedAt = null;
    logOtpGenerated(user.email, 'signup');

    // Auto-create company for Property Manager users OR assign to PropMv company for other roles
    const isPropertyManager = selectedRole.name === 'Property Manager';

    try {
      if (isPropertyManager) {
        // Create a new company for Property Manager
        const { createCompanyForPropertyManager } = require('../../company/helpers/companyCreation.helper');
        const company = await createCompanyForPropertyManager({
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          _id: user._id,
        });

        logger.info('Company created for Property Manager', { companyId: String(company._id) });

        // Find the Administrator role from company's embedded roles
        const adminRole = company.roles.find(r => r.name === 'Administrator' && r.isActive);
        if (!adminRole) {
          throw new Error('Administrator role not found in company');
        }

        // Update user with company role
        user.companyId = company._id;
        user.companyRoleId = adminRole._id;

        logger.info('Administrator role assigned for Property Manager');
      } else {
        // Assign user to PropMv company with selected role
        user.companyId = propMvCompany._id;
        user.companyRoleId = selectedRole._id;

        logger.info('User assigned to PropMv company', { role: selectedRole.name });
      }
    } catch (companyError) {
      logger.warn('Company assignment failed during registration', { error: companyError.message });
      // Don't fail the registration if company assignment fails
      // The user can still be created, company/role can be assigned manually later
    }

    if (transactionsSupported) {
      await user.save({ session });
      logger.info('User saved with company assignment', { success: true });
      await session.commitTransaction();
      session.endSession();
    } else {
      await user.save();
      logger.info('User saved with company assignment', { success: true });
    }

    // Send MFA OTP email - user is already committed, so never fail signup with 500 on SMTP errors
    const emailDeliveryFailed = await sendSignupOrLoginOtpEmail(
      user.email,
      otp,
      user.firstName,
      'signup'
    );

    const otpResendMeta = await otpResendLimiter.recordInitialOtpSent('signup', user.email);

    return withTrustedDeviceDays({
      email: user.email,
      mfaRequired: true,
      emailVerificationRequired: true,
      emailDeliveryFailed,
      role: selectedRole.name,
      companyCreated: isPropertyManager && !!user.companyId,
      assignedToDefaultCompany: !isPropertyManager && !!user.companyId,
      otpResendMeta,
      ...maybeDevOtp(otp),
    });
  } catch (err) {
    if (transactionsSupported && session) {
      await session.abortTransaction();
      session.endSession();
    }
    throw mapUserPersistenceError(err);
  }
}

/**
 * Authenticate user login with MFA OTP verification.
 * MFA skip is per trusted device fingerprint for the configured trust window.
 */
async function login({ email, password, loginMeta, deviceFingerprint }) {
  const { isValidEncryptedPassword, decryptIfEnabled, isEncryptionEnabled } = require('../../../../common/helpers/cryptoHelper');
  const {
    evaluateDeviceTrust,
    touchTrustedDevice,
  } = require('./trustedDevice.service');
  const { truncateFingerprintHash, normalizeIp } = require('../helpers/deviceFingerprint.helper');
  const ip = normalizeIp(loginMeta && loginMeta.ip ? loginMeta.ip : null);
  const userAgent = loginMeta && loginMeta.userAgent ? loginMeta.userAgent : null;
  const attemptMeta = loginAttemptLocationFields(loginMeta || {}, ip, userAgent);
  let plainPassword = password;
  if (isEncryptionEnabled()) {
    if (!isValidEncryptedPassword(password)) throw new Error('Password must be encrypted using AES-256-CBC base64 encoding');
    plainPassword = decryptIfEnabled(password);
  }

  // Use lean() for faster query and select only needed fields
  const normalizedLoginEmail = normalizeUserEmail(email);
  const userDoc = await User.findOne({ email: normalizedLoginEmail, isDeleted: { $ne: true } })
    .select('+password +failedLoginAttempts +lockAccount +lockUntil +mfaOtp +mfaOtpExpiresAt +mfaOtpAction +refreshToken companyId companyRoleId emailVerifiedAt portalOnboardingStatus status isDeleted')
    .lean();

  // Fetch privileges from company role
  let privileges = [];
  let roleName = undefined;

  // Check if user has company role (Property Manager)
  if (userDoc && userDoc.companyId && userDoc.companyRoleId) {
    try {
      const Company = require('../../company/models/company.model');
      const company = await Company.findOne({ _id: userDoc.companyId, isDeleted: { $ne: true } }).lean();
      if (company && company.roles) {
        const companyRole = company.roles.find(
          role => role._id.toString() === userDoc.companyRoleId.toString() && role.isActive
        );
        if (companyRole) {
          privileges = Array.isArray(companyRole.privileges) ? companyRole.privileges : [];
          roleName = companyRole.name;
        }
      }
    } catch (error) {
      logger.error('Error fetching company role:', error.message);
    }
  }

  if (!userDoc || userDoc.isDeleted === true || (userDoc.status && userDoc.status.toLowerCase() === 'inactive')) {
    // User doesn't exist or is inactive/deleted - return specific error
    throw new Error('No account found with this email address. Please check your email or sign up.');
  }

  if (
    userDoc.portalOnboardingStatus === PORTAL_ONBOARDING_STATUS.INVITATION_SENT ||
    userDoc.portalOnboardingStatus === PORTAL_ONBOARDING_STATUS.PENDING_VERIFICATION
  ) {
    throw new Error(
      'Please use the invitation link from your email to set your password before signing in. If the link expired, ask your administrator to resend the invitation.'
    );
  }

  // Convert lean document back to mongoose document for save operations
  const user = await User.findOne({ _id: userDoc._id, isDeleted: { $ne: true } });
  if (!user || user.isDeleted === true || (user.status && user.status.toLowerCase() === 'inactive')) {
    throw new Error('No account found with this email address. Please check your email or sign up.');
  }

  await checkAndUnlockExpiredAccount(user);

  if (user.lockAccount) {
    if (user.lockUntil && user.lockUntil > ClockService.now()) {
      const lockMinutesRemaining = Math.ceil((user.lockUntil - ClockService.now()) / (60 * 1000));
      appendLoginAttempt(user, {
        success: false,
        reason: 'account_locked',
        ...attemptMeta,
        requiresMfa: false,
      });
      await user.save();
      throw new Error(`Account is temporarily locked due to multiple failed login attempts. Please try again in ${lockMinutesRemaining} minute(s).`);
    } else if (!user.lockUntil) {
      appendLoginAttempt(user, {
        success: false,
        reason: 'account_locked',
        ...attemptMeta,
        requiresMfa: false,
      });
      await user.save();
      throw new Error('Account locked. Please contact support.');
    }
  }

  const valid = await bcrypt.compare(plainPassword, user.password);

  if (!valid) {
    user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
    const remainingAttempts = 5 - user.failedLoginAttempts;

    if (user.failedLoginAttempts >= 5) {
      user.lockAccount = true;
      user.lockUntil = DateUtil.fromEpoch(ClockService.nowEpoch() + 30 * 60 * 1000);
      appendLoginAttempt(user, {
        success: false,
        reason: 'invalid_password_account_locked',
        ...attemptMeta,
        requiresMfa: false,
      });
      await user.save();
      throw new Error('Account locked due to too many failed login attempts. Your account has been locked for 30 minutes. Please try again later or use "Forgot Password" to reset your password.');
    }

    appendLoginAttempt(user, {
      success: false,
      reason: 'invalid_password',
      ...attemptMeta,
      requiresMfa: false,
    });
    await user.save();

    // Provide helpful message with remaining attempts
    if (remainingAttempts > 0) {
      throw new Error(`Incorrect password. You have ${remainingAttempts} attempt(s) remaining before your account is locked.`);
    } else {
      throw new Error('Incorrect password.');
    }
  }

  user.failedLoginAttempts = 0;
  user.lockAccount = false;
  user.lockUntil = null;

  // Unverified self-serve signup: force email verification (signup OTP), not login MFA
  if (needsSignupEmailVerification(user)) {
    const { hashDeviceFingerprint: hashFp } = require('../helpers/deviceFingerprint.helper');
    const { emailDeliveryFailed, otp: signupOtp } = await issueSignupVerificationOtp(user);
    appendLoginAttempt(user, {
      success: true,
      reason: 'password_verified_email_verification_required',
      ...attemptMeta,
      requiresMfa: true,
      mfaDecision: 'required',
      mfaReason: 'signup_email_unverified',
      deviceFingerprintHash: deviceFingerprint
        ? truncateFingerprintHash(hashFp(deviceFingerprint))
        : undefined,
    });
    await user.save();
    return withTrustedDeviceDays({
      email: user.email,
      mfaRequired: true,
      emailVerificationRequired: true,
      emailDeliveryFailed,
      privileges,
      ...maybeDevOtp(signupOtp),
    });
  }

  // Ensure Property Manager has a company (check and create if needed)
  const isPropertyManager = user.companyId && roleName === 'Administrator';

  if (isPropertyManager) {
    try {
      const { ensurePropertyManagerCompany } = require('../../company/helpers/companyCreation.helper');
      await ensurePropertyManagerCompany(user);

      // Reload user to get updated companyId and companyRoleId
      const updatedUser = await User.findById(user._id);
      user.companyId = updatedUser.companyId;
      user.companyRoleId = updatedUser.companyRoleId;
    } catch (companyError) {
      logger.warn('Company ensure failed during login', { error: companyError.message });
      // Don't fail login if company creation fails
    }
  }

  const { assertHoaBoardMemberCanAuthenticate } = require('../../../../common/helpers/hoaBoardMemberAccess.helper');
  await assertHoaBoardMemberCanAuthenticate(user._id);

  const trustEval = await evaluateDeviceTrust(user._id, deviceFingerprint, ip);
  const fingerprintHashTrunc = truncateFingerprintHash(trustEval.fingerprintHash);

  if (trustEval.trusted) {
    const finalRoleName = roleName;
    const finalPrivileges = privileges;

    const accessToken = generateAccessToken({ sub: user._id.toString(), role: finalRoleName }, finalPrivileges);
    const refreshToken = generateRefreshToken({ sub: user._id.toString() });
    user.refreshToken = refreshToken;
    user.mfaOtp = undefined;
    user.mfaOtpExpiresAt = undefined;
    user.mfaOtpAction = undefined;
    // Keep informational stamp; skip decision is device-scoped, not this field alone
    user.mfaLoginVerifiedAt = ClockService.now();
    appendLoginAttempt(user, {
      success: true,
      reason: 'login_success_mfa_skipped_trusted_device',
      ...attemptMeta,
      requiresMfa: false,
      mfaDecision: 'skipped',
      mfaReason: trustEval.reason,
      deviceFingerprintHash: fingerprintHashTrunc,
    });
    await user.save();
    await touchTrustedDevice(trustEval.device._id, { ip, userAgent });
    if (trustEval.ipChanged) {
      logger.info('[Auth] Trusted device MFA skipped with IP change', {
        userId: String(user._id),
        fingerprintHash: fingerprintHashTrunc,
      });
    }

    const userResponse = await user.toSafeJSON();
    const mfaValidUntil = trustEval.device.trustedUntil
      ? DateUtil.toISO(trustEval.device.trustedUntil)
      : DateUtil.toISO(DateUtil.fromEpoch(ClockService.nowEpoch() + MFA_LOGIN_WINDOW_MS));
    return {
      accessToken,
      refreshToken,
      user: userResponse,
      mfaRequired: false,
      mfaSkipped: true,
      mfaValidUntil,
      privileges: finalPrivileges,
    };
  }

  const isPlayStoreReviewer = playStoreTestAuth.isPlayStoreTestAccount(user.email);
  const otp = isPlayStoreReviewer ? null : generateMfaOtp();
  const otpExpiresAt = DateUtil.fromEpoch(
    ClockService.nowEpoch() + (isPlayStoreReviewer ? 24 * 60 * 60 * 1000 : 10 * 60 * 1000)
  );
  user.mfaOtp = isPlayStoreReviewer ? undefined : otp;
  user.mfaOtpExpiresAt = otpExpiresAt;
  user.mfaOtpAction = 'login';
  if (!isPlayStoreReviewer) {
    logOtpGenerated(user.email, 'login');
  } else {
    logger.info('[Auth] Play Store reviewer login MFA session started without OTP delivery', {
      email: user.email,
    });
  }
  appendLoginAttempt(user, {
    success: true,
    reason: isPlayStoreReviewer
      ? 'password_verified_mfa_required_play_store_reviewer'
      : 'password_verified_mfa_required',
    ...attemptMeta,
    requiresMfa: true,
    mfaDecision: 'required',
    mfaReason: isPlayStoreReviewer ? 'play_store_reviewer' : trustEval.reason,
    deviceFingerprintHash: fingerprintHashTrunc,
  });
  await user.save();

  // Never fail login with 500 after password OK / OTP stored - surface delivery status to UI
  const emailDeliveryFailed = isPlayStoreReviewer
    ? false
    : await sendSignupOrLoginOtpEmail(
      user.email,
      otp,
      user.firstName,
      'login'
    );

  const otpResendMeta = isPlayStoreReviewer
    ? null
    : await otpResendLimiter.recordInitialOtpSent('login', user.email);

  return withTrustedDeviceDays({
    email: user.email,
    mfaRequired: true,
    emailDeliveryFailed,
    privileges,
    ...(otpResendMeta ? { otpResendMeta } : {}),
    ...(otp ? maybeDevOtp(otp) : {}),
  });
}

async function refreshToken(refreshToken) {
  const payload = verifyRefreshToken(refreshToken);
  const userDoc = await User.findOne({ _id: payload.sub, isDeleted: { $ne: true } })
    .select('companyId companyRoleId refreshToken');
  if (!userDoc || userDoc.refreshToken !== refreshToken) {
    throw new Error('Invalid refresh token');
  }

  const { assertHoaBoardMemberCanAuthenticate } = require('../../../../common/helpers/hoaBoardMemberAccess.helper');
  await assertHoaBoardMemberCanAuthenticate(userDoc._id);

  // Fetch privileges from company role
  let privileges = [];
  let roleName = undefined;

  // Check if user has company role (Property Manager)
  if (userDoc.companyId && userDoc.companyRoleId) {
    try {
      const Company = require('../../company/models/company.model');
      const company = await Company.findOne({ _id: userDoc.companyId, isDeleted: { $ne: true } }).lean();
      if (company && company.roles) {
        const companyRole = company.roles.find(
          role => role._id.toString() === userDoc.companyRoleId.toString() && role.isActive
        );
        if (companyRole) {
          privileges = Array.isArray(companyRole.privileges) ? companyRole.privileges : [];
          roleName = companyRole.name;
        }
      }
    } catch (error) {
      logger.error('Error fetching company role:', error.message);
    }
  }

  const finalRoleName = roleName;
  const accessToken = generateAccessToken({ sub: userDoc._id.toString(), role: finalRoleName }, privileges);
  return { accessToken, privileges };
}

/**
 * Logout user and invalidate refresh token for security
 * 
 * This function handles user logout with the following features:
 * - Secure session termination by removing refresh token
 * - Database cleanup to prevent token reuse
 * - No input validation required as userId comes from authenticated middleware
 * - Immediate token invalidation for enhanced security
 * 
 * Security Features:
 * - Removes refresh token from database to prevent reuse
 * - Uses MongoDB $unset operator for clean token removal
 * - No sensitive data returned in response
 * - Immediate session termination
 * 
 * @param {string} userId - User ID from authenticated JWT token (required)
 * @returns {boolean} - Always returns true on successful logout
 * @throws {Error} - If logout process fails (rare database errors)
 */
async function logout(userId) {
  const mongoose = require('mongoose');
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // Remove refresh token from user document to invalidate session
    // This prevents the token from being used for future requests
    await User.findOneAndUpdate({ _id: userId, isDeleted: { $ne: true } }, { $unset: { refreshToken: 1 } }, { session });
    await session.commitTransaction();
    session.endSession();
    // Return success indicator
    return true;
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

/**
 * Send OTP to user's email for password reset
 * 
 * This function handles the forgot password flow with the following features:
 * - Generates secure 6-digit OTP
 * - Stores OTP with expiration time in user document
 * - Sends OTP to user's email via nodemailer
 * - Provides security against email enumeration attacks
 * 
 * Security Features:
 * - OTP generation with 10-minute expiration
 * - Email sending via nodemailer with HTML template
 * - No email existence revelation (always returns success)
 * - Secure OTP storage with expiration
 * 
 * @param {object} emailData - Email data
 * @param {string} emailData.email - User's email address (required)
 * @returns {boolean} - Always returns true (doesn't reveal if email exists)
 * @throws {Error} - If email sending fails (rare internal errors)
 */
async function forgotPassword({ email, resend = false }) {
  const normalizedEmail = normalizeUserEmail(email);
  await otpResendLimiter.assertCanResend('forgot-password', normalizedEmail);

  const mongoose = require('mongoose');
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // Find user by email
    const userDoc = await User.findOne({ email, isDeleted: { $ne: true } }).session(session);
    if (!userDoc) {
      await session.abortTransaction();
      session.endSession();
      throw new Error('Email not found');
    }
    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    // Set OTP expiration time (10 minutes from now)
    const otpExpiresAt = DateUtil.fromEpoch(ClockService.nowEpoch() + 10 * 60 * 1000); // 10 minutes
    // Store OTP and expiration in user document
    userDoc.resetPasswordOtp = otp;
    userDoc.resetPasswordOtpExpiresAt = otpExpiresAt;
    logOtpGenerated(email, 'forgot-password');
    await userDoc.save({ session });
    // Send OTP email
    const { sendForgotPasswordEmail } = require('../../../../common/helpers/emailHelper');
    try {
      await sendForgotPasswordEmail(email, otp, userDoc.firstName || 'User');
    } catch (emailError) {
      logger.warn('[Auth] Email sending failed:', emailError.message);
      // Always return success for forgot password to prevent email enumeration
    }
    await session.commitTransaction();
    session.endSession();

    const otpResendMeta = await otpResendLimiter.recordOtpSent(
      'forgot-password',
      normalizedEmail,
      resend ? 'resend' : 'initial'
    );

    return { otpResendMeta };
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

/**
 * Verify OTP and reset password for user
 * 
 * This function handles OTP verification and password reset with the following features:
 * - Validates OTP against stored value and expiration
 * - Confirms new password matches confirmation
 * - Securely hashes new password with bcrypt
 * - Clears OTP data after successful reset
 * 
 * Security Features:
 * - OTP validation with expiration check
 * - Password confirmation matching
 * - Password strength validation (length, characters, special chars, digits)
 * - Secure password hashing with salt rounds of 10
 * - OTP cleanup after successful use
 * 
 * Validation Process:
 * 1. Find user by email
 * 2. Verify OTP matches stored value
 * 3. Check OTP hasn't expired
 * 4. Confirm new password matches confirmation
 * 5. Hash new password securely
 * 6. Update user password and clear OTP data
 * 
 * @param {object} resetData - Password reset data
 * @param {string} resetData.email - User's email address (required)
 * @param {string} resetData.otp - OTP received via email (required)
 * @param {string} resetData.newPassword - New password (required, plaintext)
 * @param {string} resetData.confirmPassword - Password confirmation (required, plaintext)
 * @returns {boolean} - Always returns true on successful password reset
 * @throws {Error} - If validation fails or password reset fails
 */
async function verifyOtpAndResetPassword({ email, otp, newPassword, confirmPassword }) {
  const mongoose = require('mongoose');
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // Decrypt and validate new passwords
    const { isValidEncryptedPassword, decryptIfEnabled, isEncryptionEnabled } = require('../../../../common/helpers/cryptoHelper');
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

    // Find user by email
    const userDoc = await User.findOne({ email, isDeleted: { $ne: true } }).session(session);
    if (!userDoc) {
      throw new Error('Invalid email or OTP');
    }
    // Verify OTP matches stored value
    if (userDoc.resetPasswordOtp !== otp) {
      throw new Error('Invalid OTP');
    }
    // Check if OTP has expired
    if (!userDoc.resetPasswordOtpExpiresAt || userDoc.resetPasswordOtpExpiresAt < ClockService.now()) {
      throw new Error('OTP has expired. Please request a new one.');
    }
    // Hash new password securely using bcrypt
    const hashedNewPassword = await bcrypt.hash(plainNew, 10);
    // Update user password and clear OTP data + invalidate sessions/trust
    userDoc.password = hashedNewPassword;
    userDoc.resetPasswordOtp = undefined;
    userDoc.resetPasswordOtpExpiresAt = undefined;
    userDoc.refreshToken = undefined;
    userDoc.mfaLoginVerifiedAt = undefined;
    userDoc.credentialsChangedAt = ClockService.now();
    await userDoc.save({ session });
    const { revokeAllTrustedDevicesForUser } = require('./trustedDevice.service');
    await revokeAllTrustedDevicesForUser(userDoc._id);
    await session.commitTransaction();
    session.endSession();
    return true;
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

/**
 * Reset password for authenticated user with comprehensive validation
 * 
 * This function handles password reset for authenticated users with the following features:
 * - Current password verification for security
 * - New password confirmation validation
 * - Secure password hashing with bcrypt
 * - User authentication validation
 * - Password strength validation (if enabled)
 * 
 * Security Features:
 * - Current password verification using bcrypt comparison
 * - New password confirmation matching
 * - Password strength validation (length, characters, special chars, digits)
 * - Secure password hashing with salt rounds of 10
 * - User authentication requirement
 * - Password encryption/decryption support
 * 
 * Validation Process:
 * 1. Verify current password matches stored hash
 * 2. Confirm new password matches confirmation
 * 3. Hash new password securely
 * 4. Update user password in database
 * 
 * @param {object} passwordData - Password reset data
 * @param {string} passwordData.userId - User ID from authenticated session (required)
 * @param {string} passwordData.currentPassword - Current password (required, plaintext)
 * @param {string} passwordData.newPassword - New password (required, plaintext)
 * @param {string} passwordData.confirmPassword - Password confirmation (required, plaintext)
 * @returns {boolean} - Always returns true on successful password reset
 * @throws {Error} - If validation fails or password reset fails
 */
async function resetPassword({ userId, currentPassword, newPassword, confirmPassword }) {
  const mongoose = require('mongoose');
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // Decrypt and validate passwords
    const { isValidEncryptedPassword, decryptIfEnabled, isEncryptionEnabled } = require('../../../../common/helpers/cryptoHelper');
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

    // Normalize: trim before validation/compare (reject pure whitespace)
    plainCurrent = typeof plainCurrent === 'string' ? plainCurrent.trim() : '';
    plainNew = typeof plainNew === 'string' ? plainNew.trim() : '';
    plainConfirm = typeof plainConfirm === 'string' ? plainConfirm.trim() : '';

    if (!plainCurrent) throw new Error('Current password is required');
    if (!plainNew) throw new Error('New password is required');
    if (!plainConfirm) throw new Error('Confirm password is required');

    const pwValidation = decryptedPasswordSchema.validate({ password: plainNew }, { abortEarly: false });
    if (pwValidation.error) {
      const firstMsg = pwValidation.error.details[0]?.message || 'Password validation failed';
      throw new Error(firstMsg);
    }
    if (plainNew !== plainConfirm) throw new Error('Passwords do not match');
    if (plainNew === plainCurrent) throw new Error('New password must be different from current password');

    // Find user by ID
    const userDoc = await User.findOne({ _id: userId, isDeleted: { $ne: true } }).session(session);
    if (!userDoc) throw new Error('User not found');
    // Verify current password for security
    const isValidCurrentPassword = await bcrypt.compare(plainCurrent, userDoc.password);
    if (!isValidCurrentPassword) {
      throw new Error('Current password is incorrect');
    }
    // Hash new password securely using bcrypt (invalidates prior hash)
    const hashedNewPassword = await bcrypt.hash(plainNew, 10);
    // Update user password and invalidate sessions + trusted devices
    userDoc.password = hashedNewPassword;
    userDoc.refreshToken = undefined;
    userDoc.mfaLoginVerifiedAt = undefined;
    userDoc.credentialsChangedAt = ClockService.now();
    await userDoc.save({ session });
    const { revokeAllTrustedDevicesForUser } = require('./trustedDevice.service');
    await revokeAllTrustedDevicesForUser(userDoc._id);
    await session.commitTransaction();
    session.endSession();
    return true;
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

/**
 * Check and automatically unlock accounts that have passed their lock expiration time
 * This function should be called before any authentication operations to ensure
 * expired locks are automatically released without manual intervention
 * 
 * @param {object} userDoc - User document from database
 * @returns {object} - Updated user document with lock status
 */
async function checkAndUnlockExpiredAccount(userDoc) {
  // Check if account is locked and lock has expired
  if (userDoc.lockAccount && userDoc.lockUntil && userDoc.lockUntil <= ClockService.now()) {
    // Automatically unlock the account
    userDoc.lockAccount = false;
    userDoc.lockUntil = null;
    userDoc.failedLoginAttempts = 0; // Reset failed attempts on auto-unlock
    await userDoc.save();

  logger.info('Account auto-unlocked after lock expiration', { userId: String(userDoc._id) });
  }

  return userDoc;
}

/**
 * Toggle account lock status (simple flag toggle)
 * 
 * This function handles account locking/unlocking with the following features:
 * - Simple toggle mechanism: if locked, unlock; if unlocked, lock
 * - No time-based expiration (manual toggle only)
 * - Immediate lock/unlock status change
 * - Clear status indication in response
 * 
 * Toggle Behavior:
 * - If account is currently unlocked: locks the account
 * - If account is currently locked: unlocks the account
 * - Resets failed login attempts when unlocking
 * 
 * @param {string} userId - User ID to toggle lock status (required)
 * @returns {object} - Toggle result with current status and message
 * @throws {Error} - If user not found or toggle fails
 */
async function lockAccount(userId) {
  const userDoc = await User.findOne({ _id: userId, isDeleted: { $ne: true } });
  if (!userDoc) throw new Error('User not found');

  // Toggle the lock status
  const wasLocked = userDoc.lockAccount || false;
  userDoc.lockAccount = !wasLocked;

  // If unlocking, reset failed attempts and clear lock time
  if (!userDoc.lockAccount) {
    userDoc.failedLoginAttempts = 0;
    userDoc.lockUntil = null;
  } else {
    // If locking, set a lock time (optional, for reference)
    userDoc.lockUntil = DateUtil.fromEpoch(ClockService.nowEpoch() + 30 * 60 * 1000); // 30 minutes from now
  }

  await userDoc.save();

  return {
    message: userDoc.lockAccount ? 'Account locked successfully' : 'Account unlocked successfully',
    isLocked: userDoc.lockAccount,
    lockedAt: userDoc.lockAccount ? ClockService.now() : null,
    unlockedAt: !userDoc.lockAccount ? ClockService.now() : null
  };
}

/**
 * Unlock user account (simple unlock operation)
 * 
 * This function handles account unlocking with the following features:
 * - Simple unlock mechanism: sets lockAccount to false
 * - Immediate unlock status change
 * - Resets failed login attempts counter
 * - Clears lock expiration time
 * - Provides clear unlock confirmation
 * 
 * Unlock Behavior:
 * - Sets lockAccount to false (unlocks the account)
 * - Resets failedLoginAttempts to 0
 * - Clears lockUntil timestamp
 * - Returns unlock confirmation with timestamp
 * 
 * @param {string} userId - User ID to unlock (required)
 * @returns {object} - Unlock result with message and timestamp
 * @throws {Error} - If user not found or unlock fails
 */
async function unlockAccount(userId, requestedById) {
  // Prevent users from unlocking themselves
  if (requestedById && String(requestedById) === String(userId)) {
    throw new Error('Users cannot unlock their own account. Please contact an administrator.');
  }
  const userDoc = await User.findOne({ _id: userId, isDeleted: { $ne: true } });
  if (!userDoc) throw new Error('User not found');

  // Unlock the account by setting lock flag to false
  userDoc.lockAccount = false;
  userDoc.lockUntil = null;
  userDoc.failedLoginAttempts = 0; // Reset failed attempts on unlock

  await userDoc.save();

  return {
    message: 'Account unlocked successfully',
    isLocked: false,
    unlockedAt: ClockService.now(),
    failedAttemptsReset: true
  };
}

/**
 * Get comprehensive user session information
 * 
 * This function retrieves detailed session information with the following features:
 * - Complete user profile data (safe information only)
 * - Account lock status and expiration details
 * - Failed login attempt tracking
 * - Last activity timestamps
 * - Automatic expired lock checking and cleanup
 * 
 * Session Information Includes:
 * - User profile: email, name, role, profile details (password excluded)
 * - Security status: lock status, lock expiration time
 * - Activity tracking: failed attempts, last login time
 * - Real-time status: current lock state after auto-unlock check
 * 
 * Security Features:
 * - Automatically checks and unlocks expired accounts
 * - Returns safe user data (no sensitive information)
 * - Real-time lock status calculation
 * - Comprehensive security state information
 * 
 * @param {string} userId - User ID to get session information for (required)
 * @returns {object} - Complete session data with user info and security status
 * @throws {Error} - If user not found or session retrieval fails
 */
async function getSession(userId) {
  const { assertHoaBoardMemberCanAuthenticate } = require('../../../../common/helpers/hoaBoardMemberAccess.helper');
  await assertHoaBoardMemberCanAuthenticate(userId);

  // Find user by ID
  const userDoc = await User.findOne({ _id: userId, isDeleted: { $ne: true } });
  if (!userDoc) throw new Error('User not found');

  // Check and automatically unlock expired accounts
  await checkAndUnlockExpiredAccount(userDoc);

  // Fetch privileges from company role
  let privileges = [];
  if (userDoc.companyId && userDoc.companyRoleId) {
    try {
      const Company = require('../../company/models/company.model');
      const company = await Company.findOne({ _id: userDoc.companyId, isDeleted: { $ne: true } }).lean();
      if (company && company.roles) {
        const companyRole = company.roles.find(
          role => role._id.toString() === userDoc.companyRoleId.toString() && role.isActive
        );
        if (companyRole) {
          privileges = Array.isArray(companyRole.privileges) ? companyRole.privileges : [];
        }
      }
    } catch (error) {
      logger.error('Error fetching company role:', error.message);
    }
  }

  // Return comprehensive session information
  return {
    // User profile information (safe data only)
    user: await userDoc.toSafeJSON(),

    // Security and lock status information
    isLocked: userDoc.lockAccount && userDoc.lockUntil && userDoc.lockUntil > ClockService.now(),
    lockUntil: userDoc.lockUntil,

    // Activity and attempt tracking
    failedAttempts: userDoc.failedLoginAttempts,
    lastLogin: userDoc.updatedAt,

    // Additional session metadata
    sessionRetrievedAt: ClockService.now(),
    accountStatus: userDoc.lockAccount ? 'locked' : 'active',
    privileges
  };
}

/**
 * Send MFA OTP to user's email for login/signup verification
 */
async function sendMfaOtp({ email, action }) {
  const normalizedEmail = normalizeUserEmail(email);
  const scope = action === 'signup' ? 'signup' : action === 'forgot-password' ? 'forgot-password' : 'login';
  await otpResendLimiter.assertCanResend(scope, normalizedEmail);

  const mongoose = require('mongoose');
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const normalizedEmail = normalizeUserEmail(email);
    const userDoc = await User.findOne({ email: normalizedEmail, isDeleted: { $ne: true } }).session(session);
    if (!userDoc || userDoc.isDeleted === true || (userDoc.status && userDoc.status.toLowerCase() === 'inactive') || userDoc.lockAccount === true) {
      await session.commitTransaction();
      session.endSession();
      // Don't reveal if email doesn't exist or is inactive/locked
      return { emailDeliveryFailed: false };
    }
    const effectiveAction = needsSignupEmailVerification(userDoc) ? 'signup' : action;
    const isPlayStoreReviewer = playStoreTestAuth.isPlayStoreTestAccount(userDoc.email);
    const otp = isPlayStoreReviewer ? null : generateMfaOtp();
    const otpExpiresAt = DateUtil.fromEpoch(
      ClockService.nowEpoch() + (isPlayStoreReviewer ? 24 * 60 * 60 * 1000 : 10 * 60 * 1000)
    );
    userDoc.mfaOtp = isPlayStoreReviewer ? undefined : otp;
    userDoc.mfaOtpExpiresAt = otpExpiresAt;
    userDoc.mfaOtpAction = effectiveAction;
    if (effectiveAction === 'signup') {
      userDoc.emailVerifiedAt = null;
    }
    if (!isPlayStoreReviewer) {
      logOtpGenerated(userDoc.email, effectiveAction);
    }
    await userDoc.save({ session });
    await session.commitTransaction();
    session.endSession();

    // Send email after commit so SMTP failures never roll back the OTP
    const emailDeliveryFailed = isPlayStoreReviewer
      ? false
      : await sendSignupOrLoginOtpEmail(
        userDoc.email,
        otp,
        userDoc.firstName,
        effectiveAction
      );
    const otpResendMeta = isPlayStoreReviewer
      ? null
      : await otpResendLimiter.recordResendSent(scope, normalizedEmail);
    return {
      emailDeliveryFailed,
      ...(otpResendMeta ? { otpResendMeta } : {}),
      ...(otp ? maybeDevOtp(otp) : {}),
    };
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

/**
 * Verify MFA OTP for login/signup
 */
async function verifyMfaOtp({ email, otp, loginMeta, deviceFingerprint, trustDevice, deviceName }) {
  const {
    upsertTrustedDevice,
  } = require('./trustedDevice.service');
  const {
    truncateFingerprintHash,
    normalizeIp,
    hashDeviceFingerprint,
    getTrustedDeviceDays,
  } = require('../helpers/deviceFingerprint.helper');

  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedOtp = String(otp || '').trim();
  const ip = normalizeIp(loginMeta && loginMeta.ip ? loginMeta.ip : null);
  const userAgent = loginMeta && loginMeta.userAgent ? loginMeta.userAgent : null;
  const attemptMeta = loginAttemptLocationFields(loginMeta || {}, ip, userAgent);
  const shouldTrustDevice = trustDevice === true || trustDevice === 'true';

  // Query user with all necessary fields
  const userDoc = await User.findOne({ email: normalizedEmail, isDeleted: { $ne: true } });

  if (!userDoc || userDoc.isDeleted === true || (userDoc.status && userDoc.status.toLowerCase() === 'inactive') || userDoc.lockAccount === true) {
    throw new Error('Invalid email or OTP');
  }
  if (!userDoc.mfaOtpAction) {
    throw new Error('No active MFA OTP. Please request a new MFA OTP.');
  }

  const acceptedPlayStoreOtp = playStoreTestAuth.matchesPlayStoreTestOtp(normalizedEmail, normalizedOtp);
  if (!acceptedPlayStoreOtp) {
    if (!userDoc.mfaOtp) {
      throw new Error('Invalid OTP');
    }
    if (String(userDoc.mfaOtp).trim() !== normalizedOtp) throw new Error('Invalid OTP');
    if (!userDoc.mfaOtpExpiresAt || userDoc.mfaOtpExpiresAt < ClockService.now()) {
      throw new Error('OTP has expired. Please request a new one.');
    }
  } else if (!userDoc.mfaOtpExpiresAt || userDoc.mfaOtpExpiresAt < ClockService.now()) {
    throw new Error('OTP has expired. Please request a new one.');
  }

  // Fetch privileges from company role
  let privileges = [];
  let roleName = undefined;

  // Check if user has company role (Property Manager)
  if (userDoc.companyId && userDoc.companyRoleId) {
    try {
      const Company = require('../../company/models/company.model');
      const company = await Company.findOne({ _id: userDoc.companyId, isDeleted: { $ne: true } }).lean();
      if (company && company.roles) {
        const companyRole = company.roles.find(
          role => role._id.toString() === userDoc.companyRoleId.toString() && role.isActive
        );
        if (companyRole) {
          privileges = Array.isArray(companyRole.privileges) ? companyRole.privileges : [];
          roleName = companyRole.name;
        }
      }
    } catch (error) {
      logger.error('Error fetching company role:', error.message);
    }
  }

  const action = userDoc.mfaOtpAction;
  const wasSignup = action === 'signup';
  userDoc.mfaOtp = undefined;
  userDoc.mfaOtpExpiresAt = undefined;
  userDoc.mfaOtpAction = undefined;
  if (wasSignup || userDoc.emailVerifiedAt == null) {
    userDoc.emailVerifiedAt = ClockService.now();
  }

  let trustedDevice = null;
  const fingerprintHashTrunc = truncateFingerprintHash(hashDeviceFingerprint(deviceFingerprint));

  if (action === 'login') {
    userDoc.mfaLoginVerifiedAt = ClockService.now();
    if (shouldTrustDevice) {
      if (!deviceFingerprint) {
        logger.warn('[Auth] Trust device requested but fingerprint missing after MFA');
      } else {
        try {
          trustedDevice = await upsertTrustedDevice({
            userId: userDoc._id,
            rawFingerprint: deviceFingerprint,
            ip,
            userAgent,
            deviceName,
          });
        } catch (trustErr) {
          logger.error('[Auth] Failed to trust device after MFA:', {
            message: trustErr.message,
            userId: String(userDoc._id),
            fingerprintHash: fingerprintHashTrunc,
          });
        }
      }
    }
    appendLoginAttempt(userDoc, {
      success: true,
      reason: shouldTrustDevice && trustedDevice
        ? 'mfa_verified_login_success_device_trusted'
        : 'mfa_verified_login_success',
      ...attemptMeta,
      requiresMfa: true,
      mfaDecision: 'verified',
      mfaReason: shouldTrustDevice && trustedDevice ? 'device_trusted' : 'otp_verified',
      deviceFingerprintHash: fingerprintHashTrunc,
    });
  }

  // Ensure Property Manager has a company (check and create if needed)
  const isPropertyManager = userDoc.companyId && roleName === 'Administrator';

  if (isPropertyManager) {
    try {
      const { ensurePropertyManagerCompany } = require('../../company/helpers/companyCreation.helper');
      await ensurePropertyManagerCompany(userDoc);
    } catch (companyError) {
      logger.warn('Company ensure failed during MFA verify', { error: companyError.message });
      // Don't fail login if company creation fails
    }
  }

  if (roleName === 'HOA Board Member') {
    const { assertHoaBoardMemberCanAuthenticate } = require('../../../../common/helpers/hoaBoardMemberAccess.helper');
    await assertHoaBoardMemberCanAuthenticate(userDoc._id);

    try {
      const { ensurePrimaryHOAFromUserProfile } = require('../../../../portals/hoa-board/modules/hoa/service/hoa.service');
      await ensurePrimaryHOAFromUserProfile(userDoc._id);
    } catch (hoaError) {
      logger.warn('HOA membership provision failed', { error: hoaError.message });
    }
  }

  const finalRoleName = roleName;
  const accessToken = generateAccessToken({ sub: userDoc._id.toString(), role: finalRoleName }, privileges);
  const refreshToken = generateRefreshToken({ sub: userDoc._id.toString() });
  userDoc.refreshToken = refreshToken;
  await userDoc.save();

  // Prepare user response with role information
  const userResponse = await userDoc.toSafeJSON();

  const result = { accessToken, refreshToken, user: userResponse, action, privileges };
  if (action === 'login') {
    if (trustedDevice?.trustedUntil) {
      result.mfaValidUntil = DateUtil.toISO(trustedDevice.trustedUntil);
      result.deviceTrusted = true;
    } else if (userDoc.mfaLoginVerifiedAt) {
      // Informational only - next login still requires trusted device
      result.mfaValidUntil = DateUtil.toISO(
        DateUtil.fromEpoch(
          DateUtil.toEpoch(userDoc.mfaLoginVerifiedAt) + getTrustedDeviceDays() * 24 * 60 * 60 * 1000
        )
      );
      result.deviceTrusted = false;
    }
  }

  if (wasSignup && userDoc.email) {
    const { notifyWelcomeEmailInBackground } = require('../../../../common/helpers/emailHelper');
    notifyWelcomeEmailInBackground(userDoc.email, {
      userName: userDoc.firstName || userDoc.email,
      roleName: finalRoleName || '',
    });
  }

  return result;
}

async function listTrustedDevices(userId) {
  const { listTrustedDevices: list } = require('./trustedDevice.service');
  return list(userId);
}

async function renameTrustedDevice(userId, deviceId, deviceName) {
  const { renameTrustedDevice: rename } = require('./trustedDevice.service');
  return rename(userId, deviceId, deviceName);
}

async function revokeTrustedDevice(userId, deviceId) {
  const { revokeTrustedDevice: revoke } = require('./trustedDevice.service');
  return revoke(userId, deviceId);
}

async function getLoginHistory(userId, {
  limit = 10,
  offset = 0,
  from = null,
  to = null,
  sort = 'newest',
  q = null,
  status = null,
} = {}) {
  const { parseUserAgentMeta } = require('../helpers/deviceFingerprint.helper');
  const pageSize = Math.min(Math.max(Number(limit) || 10, 1), MAX_LOGIN_ATTEMPTS_HISTORY);
  const pageOffset = Math.max(Number(offset) || 0, 0);

  const user = await User.findOne({ _id: userId, isDeleted: { $ne: true } })
    .select('loginAttempts')
    .lean();
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });

  const attempts = Array.isArray(user.loginAttempts) ? user.loginAttempts : [];
  const fromMs = from ? DateUtil.toEpoch(from) : null;
  const toMs = to ? DateUtil.toEpoch(to) : null;
  const query = q ? String(q).trim().toLowerCase() : '';
  const statusFilter = status ? String(status).trim().toLowerCase() : '';

  const { isPrivateOrLoopbackIp } = require('../../../utils/requestIp.util');

  let enriched = attempts.map((a, index) => {
    const uaMeta = parseUserAgentMeta(a.userAgent);
    const city = a.city || a.location?.city || null;
    const state = a.state || a.location?.state || null;
    const country = a.country || a.location?.country || null;
    const timezone = a.timezone || a.location?.timezone || null;
    const isLocalDevelopment =
      a.isLocalDevelopment === true ||
      (!city && !state && !country && isPrivateOrLoopbackIp(a.ip));
    const trustedDevice =
      a.mfaDecision === 'skipped' ||
      a.mfaReason === 'device_trusted' ||
      a.mfaReason === 'skipped_trusted_device';
    return {
      id: a._id ? String(a._id) : `${a.at ? DateUtil.toISO(a.at) : 'na'}-${index}`,
      at: a.at,
      success: !!a.success,
      reason: a.reason || null,
      ip: a.ip || null,
      userAgent: a.userAgent || null,
      browser: a.browser || uaMeta.browser,
      os: a.os || uaMeta.os,
      deviceType: a.deviceType || uaMeta.deviceType,
      city,
      state,
      country,
      timezone,
      isLocalDevelopment,
      requiresMfa: !!a.requiresMfa,
      mfaDecision: a.mfaDecision || null,
      mfaReason: a.mfaReason || null,
      deviceFingerprintHash: a.deviceFingerprintHash || null,
      trustedDevice,
      isCurrentSession: false,
    };
  });

  // Newest successful auth marks current session when present
  const newestSuccess = enriched
    .filter((e) => e.success && (e.mfaDecision === 'skipped' || e.mfaDecision === 'verified' || e.reason?.includes('success')))
    .sort((a, b) => (DateUtil.toEpoch(b.at) ?? 0) - (DateUtil.toEpoch(a.at) ?? 0))[0];
  if (newestSuccess) {
    newestSuccess.isCurrentSession = true;
  }

  enriched = enriched.filter((e) => {
    const atMs = e.at ? DateUtil.toEpoch(e.at) : NaN;
    if (fromMs != null && !Number.isNaN(fromMs) && (Number.isNaN(atMs) || atMs < fromMs)) return false;
    if (toMs != null && !Number.isNaN(toMs) && (Number.isNaN(atMs) || atMs > toMs)) return false;

    if (statusFilter === 'success' && !e.success) return false;
    if (statusFilter === 'failed' && e.success) return false;
    if (statusFilter === 'mfa_required' && !(e.mfaDecision === 'required' || e.requiresMfa)) return false;
    if (statusFilter === 'trusted' && !e.trustedDevice) return false;

    if (query) {
      const haystack = [
        e.ip,
        e.browser,
        e.os,
        e.deviceType,
        e.city,
        e.state,
        e.country,
        e.timezone,
        e.isLocalDevelopment ? 'local development environment' : '',
        e.reason,
        e.mfaDecision,
        e.mfaReason,
        e.userAgent,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  enriched.sort((a, b) => {
    const aMs = a.at ? DateUtil.toEpoch(a.at) ?? 0 : 0;
    const bMs = b.at ? DateUtil.toEpoch(b.at) ?? 0 : 0;
    return sort === 'oldest' ? aMs - bMs : bMs - aMs;
  });

  const total = enriched.length;
  const items = enriched.slice(pageOffset, pageOffset + pageSize);
  return {
    items,
    total,
    limit: pageSize,
    offset: pageOffset,
    hasMore: pageOffset + items.length < total,
  };
}

/**
 * Verify forgot-password OTP without resetting the password
 */
async function verifyResetOtp({ email, otp }) {
  const userDoc = await User.findOne({ email, isDeleted: { $ne: true } });
  if (!userDoc) throw new Error('Invalid email or OTP');
  if (userDoc.resetPasswordOtp !== String(otp).trim()) throw new Error('Invalid OTP');
  if (!userDoc.resetPasswordOtpExpiresAt || userDoc.resetPasswordOtpExpiresAt < ClockService.now()) {
    throw new Error('OTP has expired. Please request a new one.');
  }
  return true;
}

/**
 * Check whether email and/or phone are available for a new account (globally unique).
 * @param {{ email?: string, phone?: string }} query
 */
async function checkIdentityAvailability({ email, phone } = {}) {
  const result = {};
  const normalizedEmail = normalizeUserEmail(email);
  const normalizedPhone = normalizeUserPhone(phone);

  if (normalizedEmail) {
    const existingEmail = await findUserByEmail(normalizedEmail);
    if (existingEmail && needsSignupEmailVerification(existingEmail)) {
      // Allow form submit; register will resume verification instead of 409
      result.email = {
        available: true,
        unverifiedAccount: true,
        message: 'An unverified account exists for this email. Continue to verify your email.',
      };
    } else {
      result.email = existingEmail
        ? { available: false, message: DUPLICATE_EMAIL_MESSAGE }
        : { available: true };
    }
  }

  if (phone && String(phone).trim() && normalizedPhone.length >= 10) {
    const existingPhone = await findUserByPhone(phone);
    if (existingPhone) {
      const phoneOwner = await User.findById(existingPhone._id)
        .select('emailVerifiedAt mfaOtpAction portalOnboardingStatus')
        .lean();
      if (phoneOwner && needsSignupEmailVerification(phoneOwner)) {
        result.phone = {
          available: true,
          unverifiedAccount: true,
          message: 'Continue registration to verify the existing unverified account.',
        };
      } else {
        result.phone = { available: false, message: DUPLICATE_PHONE_MESSAGE };
      }
    } else {
      result.phone = { available: true };
    }
  }

  return result;
}

module.exports = {
  register,
  login,
  refreshToken,
  logout,
  forgotPassword,
  verifyResetOtp,
  verifyOtpAndResetPassword,
  resetPassword,
  lockAccount,
  unlockAccount,
  getSession,
  sendMfaOtp,
  verifyMfaOtp,
  checkIdentityAvailability,
  listTrustedDevices,
  renameTrustedDevice,
  revokeTrustedDevice,
  getLoginHistory,
};
