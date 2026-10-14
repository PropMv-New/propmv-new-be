/**
 * ------------------------------------------------------------------
 * File: auth.validator.js
 * Module: Src Shared Modules Auth Validators
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * auth.routes, functions.routes, roles.routes, auth.service
 * ------------------------------------------------------------------
 */

const Joi = require('joi');
const { personNameFieldJoi } = require('../../../utils/personNameValidation.util');

/** Injected by HOA SPA axios interceptor; ignored by auth handlers */
const optionalPortalContextQuery = Joi.string().valid('hoa-board').optional().allow('', null);

// Custom phone number validation for US and international formats
const phoneValidation = Joi.string()
  .optional()
  .allow('', null)
  .pattern(/^[0-9+\-\s()]+$/)
  .min(10)
  .max(20)
  .custom((value, helpers) => {
    if (!value) return value; // Allow empty

    const digitsOnly = value.replace(/\D/g, '');

    // Check digit count
    if (digitsOnly.length < 10 || digitsOnly.length > 15) {
      return helpers.error('any.invalid');
    }

    // US phone number validation (10 digits)
    if (digitsOnly.length === 10) {
      const usPhoneRegex = /^[2-9]\d{2}[2-9]\d{6}$/;
      if (!usPhoneRegex.test(digitsOnly)) {
        return helpers.error('any.invalid');
      }
    }

    // US phone number with country code (11 digits starting with 1)
    if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) {
      const usPhoneRegex = /^1[2-9]\d{2}[2-9]\d{6}$/;
      if (!usPhoneRegex.test(digitsOnly)) {
        return helpers.error('any.invalid');
      }
    }

    return value;
  })
  .messages({
    'string.pattern.base': 'Phone number can only contain digits, +, -, spaces, and ()',
    'string.min': 'Phone number must be at least 10 characters',
    'string.max': 'Phone number must not exceed 20 characters',
    'any.invalid': 'Invalid phone number format. US numbers must be 10 digits starting with area code (2-9)'
  });

// Custom email validation that follows RFC 5322 standards
// Allows: letters, numbers, dots (.), hyphens (-), underscores (_), plus (+)
// Does NOT allow: !, #, $, %, &, *, etc.
const strictEmailValidation = Joi.string()
  .email({ tlds: { allow: true } })
  .pattern(/^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/)
  .max(254)
  .required()
  .messages({
    'string.email': 'Please enter a valid email address',
    'string.pattern.base': 'Email contains invalid characters. Only letters, numbers, dots (.), hyphens (-), underscores (_), and plus (+) are allowed',
    'string.max': 'Email address is too long (maximum 254 characters)',
    'any.required': 'Email is required'
  });

// Enhanced signup schema with role-based fields
const signupSchema = Joi.object({
  email: strictEmailValidation,
  password: Joi.string().required(),
  confirmPassword: Joi.string().required(),
  firstName: personNameFieldJoi('First name'),
  lastName: personNameFieldJoi('Last name'),
  phone: phoneValidation,
  profilePic: Joi.any().optional(),
  roleId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),

  // Additional role-specific fields
  additionalInfo: Joi.object({
    // Landlord fields
    numberOfProperties: Joi.string().valid('1-5', '5-20', '20+').optional(),
    companyName: Joi.string().optional().allow('', null),
    businessAddress: Joi.string().optional().allow('', null),

    // Property Manager fields
    portfolioSize: Joi.number().optional(),
    teamSize: Joi.number().optional(),

    // HOA Board Member fields
    hoaName: Joi.string().optional().allow('', null),
    communityName: Joi.string().optional().allow('', null),
    numberOfUnits: Joi.number().optional(),
    propertyAddress: Joi.string().optional().allow('', null),
    associationType: Joi.string().trim().max(100).optional().allow('', null),
    address: Joi.string().optional().allow('', null),
    city: Joi.string().optional().allow('', null),
    state: Joi.string().optional().allow('', null),
    zipCode: Joi.string().optional().allow('', null),
  }).optional(),
});

const deviceFingerprintField = Joi.string().trim().min(8).max(512).optional().allow('', null);

const loginSchema = Joi.object({
  email: strictEmailValidation,
  password: Joi.string().required(),
  /** Stable client device fingerprint; missing → MFA always required */
  deviceFingerprint: deviceFingerprintField,
});

const forgotPasswordSchema = Joi.object({
  email: strictEmailValidation,
  resend: Joi.boolean().optional().default(false),
});

const verifyResetOtpSchema = Joi.object({
  email: strictEmailValidation,
  otp: Joi.string().required(),
});

const verifyOtpSchema = Joi.object({
  email: strictEmailValidation,
  otp: Joi.string().required(),
  newPassword: Joi.string().required(), // encrypted
  confirmPassword: Joi.string().required(), // encrypted
});

const resetPasswordSchema = Joi.object({
  currentPassword: Joi.string().required(), // encrypted
  newPassword: Joi.string().required(), // encrypted
  confirmPassword: Joi.string().required(), // encrypted
});

const lockAccountSchema = Joi.object({ userId: Joi.string().required() });
const unlockAccountSchema = Joi.object({ userId: Joi.string().required() });
const refreshTokenSchema = Joi.object({ refreshToken: Joi.string().required() });

const sendMfaOtpSchema = Joi.object({
  email: strictEmailValidation,
  action: Joi.string().valid('login', 'signup').required(),
});

const verifyMfaOtpSchema = Joi.object({
  email: strictEmailValidation,
  otp: Joi.string().required(),
  deviceFingerprint: deviceFingerprintField,
  trustDevice: Joi.boolean().optional().default(false),
  deviceName: Joi.string().trim().max(120).optional().allow('', null),
});

const renameTrustedDeviceSchema = Joi.object({
  deviceName: Joi.string().trim().min(1).max(120).required(),
});

const portalInviteValidateQuerySchema = Joi.object({
  userId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
  token: Joi.string().min(16).max(512).required(),
  /** Optional; injected by HOA SPA axios interceptor - ignored by the handler */
  context: Joi.string().max(64).optional().allow('', null),
});

const portalInviteCompleteSchema = Joi.object({
  userId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
  token: Joi.string().min(16).max(256).required(),
  newPassword: Joi.string().required(),
  confirmPassword: Joi.string().required(),
});

// schema for decrypted password validation (after decrypting in controller)
// Rules: 8–128 chars, upper, lower, digit, special - see validationHelper.validatePassword
const { validatePassword } = require('../../../../common/helpers/validationHelper');
const decryptedPasswordSchema = Joi.object({
  password: Joi.string()
    .required()
    .custom((value, helpers) => {
      const result = validatePassword(value);
      if (!result.isValid) {
        return helpers.message(result.errors[0] || 'Password validation failed');
      }
      return value;
    })
    .messages({
      'any.required': 'New password is required',
      'string.empty': 'New password is required',
    }),
});

// --- Roles & Functions validators ---
const objectIdRegex = /^[0-9a-fA-F]{24}$/;

const createRoleSchema = Joi.object({
  name: Joi.string().min(1).required(),
  description: Joi.string().allow('', null).optional(),
  // functions should be privilege names (strings), not ObjectIds
  functions: Joi.array().items(Joi.string().min(1)).min(1).required()
});

const updateRoleSchema = Joi.object({
  name: Joi.string().min(1).optional(),
  description: Joi.string().allow('', null).optional(),
  // functions should be privilege names (strings), not ObjectIds
  functions: Joi.array().items(Joi.string().min(1)).min(1).required()
});

const idParamSchema = Joi.object({ id: Joi.string().pattern(objectIdRegex).required() });

const createFunctionSchema = Joi.object({
  name: Joi.string().min(1).required(),
  description: Joi.string().allow('', null).optional()
});

const updateFunctionSchema = Joi.object({
  name: Joi.string().min(1).optional(),
  description: Joi.string().allow('', null).optional()
});

const optionalStrictEmailValidation = Joi.string()
  .email({ tlds: { allow: true } })
  .pattern(/^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/)
  .max(254)
  .optional()
  .allow('', null)
  .messages({
    'string.email': 'Please enter a valid email address',
    'string.pattern.base': 'Email contains invalid characters. Only letters, numbers, dots (.), hyphens (-), underscores (_), and plus (+) are allowed',
    'string.max': 'Email address is too long (maximum 254 characters)',
  });

const checkIdentityQuerySchema = Joi.object({
  email: optionalStrictEmailValidation,
  phone: phoneValidation,
  context: optionalPortalContextQuery,
})
  .custom((value, helpers) => {
    const hasEmail = value.email && String(value.email).trim();
    const hasPhone = value.phone && String(value.phone).trim();
    if (!hasEmail && !hasPhone) {
      return helpers.error('object.missing');
    }
    return value;
  })
  .messages({
    'object.missing': 'At least one of email or phone is required',
  });

module.exports = {
  signupSchema,
  checkIdentityQuerySchema,
  loginSchema,
  forgotPasswordSchema,
  verifyResetOtpSchema,
  verifyOtpSchema,
  resetPasswordSchema,
  lockAccountSchema,
  unlockAccountSchema,
  refreshTokenSchema,
  sendMfaOtpSchema,
  verifyMfaOtpSchema,
  renameTrustedDeviceSchema,
  portalInviteValidateQuerySchema,
  portalInviteCompleteSchema,
  decryptedPasswordSchema,
  createRoleSchema,
  updateRoleSchema,
  createFunctionSchema,
  updateFunctionSchema,
  idParamSchema,
};

