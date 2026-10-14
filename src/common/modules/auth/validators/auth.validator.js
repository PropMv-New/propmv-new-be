/**
 * ------------------------------------------------------------------
 * File: auth.validator.js
 * Module: Src Common Modules Auth Validators
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * auth, auth.routes, auth.service
 * ------------------------------------------------------------------
 */

const Joi = require('joi');

const signupSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
  phone: Joi.string().optional(),
  firstName: Joi.string().min(1).required(),
  lastName: Joi.string().min(1).required(),
  address: Joi.string().optional(),
  state: Joi.string().optional(),
  zipCode: Joi.string().optional(),
  role: Joi.string().optional(),
  profilePic: Joi.any().optional(),
  dob: Joi.any().optional(),
  gender: Joi.any().optional(),
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
});

const forgotPasswordSchema = Joi.object({
  email: Joi.string().email().required(),
});

const verifyOtpSchema = Joi.object({
  email: Joi.string().email().required(),
  otp: Joi.string().required(),
  newPassword: Joi.string().required(),
  confirmPassword: Joi.string().required(),
});

const resetPasswordSchema = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: Joi.string().required(),
  confirmPassword: Joi.string().required(),
});

const lockAccountSchema = Joi.object({ userId: Joi.string().required() });
const unlockAccountSchema = Joi.object({ userId: Joi.string().required() });
const refreshTokenSchema = Joi.object({ refreshToken: Joi.string().required() });

const sendMfaOtpSchema = Joi.object({
  email: Joi.string().email().required(),
  action: Joi.string().valid('login', 'signup').required(),
});

const verifyMfaOtpSchema = Joi.object({
  email: Joi.string().email().required(),
  otp: Joi.string().required(),
});

const decryptedPasswordSchema = Joi.object({
  password: Joi.string().min(10).pattern(/[a-zA-Z]/).pattern(/[0-9]/).pattern(/[!@#$%^&*()_+\-=[\]{}|;:,.<>?]/).required()
});

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

const createRoleSchema = Joi.object({
  name: Joi.string().min(1).required(),
  description: Joi.string().allow('', null).optional(),
  functions: Joi.array().items(Joi.string().pattern(objectIdRegex)).min(1).required()
});

const updateRoleSchema = Joi.object({
  name: Joi.string().min(1).optional(),
  description: Joi.string().allow('', null).optional(),
  functions: Joi.array().items(Joi.string().pattern(objectIdRegex)).min(1).required()
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

module.exports = {
  signupSchema,
  loginSchema,
  forgotPasswordSchema,
  verifyOtpSchema,
  resetPasswordSchema,
  lockAccountSchema,
  unlockAccountSchema,
  refreshTokenSchema,
  sendMfaOtpSchema,
  verifyMfaOtpSchema,
  decryptedPasswordSchema,
  createRoleSchema,
  updateRoleSchema,
  createFunctionSchema,
  updateFunctionSchema,
  idParamSchema,
};
