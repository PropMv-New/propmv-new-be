/**
 * ------------------------------------------------------------------
 * File: user.validator.js
 * Module: Users Module
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * userProfile.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');
const { personNameFieldJoi, optionalPersonNameFieldJoi } = require('../../../utils/personNameValidation.util');

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

const idParamSchema = Joi.object({ id: Joi.string().pattern(objectIdRegex).required() });

const updateProfileSchema = Joi.object({
  phone: Joi.string().optional().allow(null, ''),
  firstName: optionalPersonNameFieldJoi('First name'),
  lastName: optionalPersonNameFieldJoi('Last name'),
  address: Joi.string().optional().allow(null, ''),
  city: Joi.string().optional().allow(null, ''),
  state: Joi.string().optional().allow(null, ''),
  zipCode: Joi.string().optional().allow(null, ''),
  secondaryPhone: Joi.string().optional().allow(null, ''),
  isDifferentMailingAddress: Joi.boolean().optional(),
  mailingAddress: Joi.object({
    line1: Joi.string().optional().allow(null, ''),
    line2: Joi.string().optional().allow(null, ''),
    city: Joi.string().optional().allow(null, ''),
    state: Joi.string().optional().allow(null, ''),
    zipCode: Joi.string().optional().allow(null, ''),
  }).optional().allow(null),
  auxiliaryEmails: Joi.array().items(Joi.string().email()).optional().allow(null),
  emergencyContact: Joi.object({
    firstName: optionalPersonNameFieldJoi('Emergency contact first name'),
    lastName: optionalPersonNameFieldJoi('Emergency contact last name'),
    phone: Joi.string().optional().allow(null, ''),
    email: Joi.string().email().optional().allow(null, ''),
  }).optional().allow(null),
  profilePic: Joi.alternatives().try(Joi.string().uri(), Joi.string().pattern(objectIdRegex)).optional().allow(null, ''),
  dob: Joi.date().iso().optional().allow(null),
  gender: Joi.string().valid('Male', 'Female', 'Other', 'Prefer not to say').optional().allow(null, ''),
});

const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: Joi.string()
    .min(8)
    .max(128)
    .pattern(/[A-Z]/)
    .pattern(/[a-z]/)
    .pattern(/[0-9]/)
    .pattern(/[!@#$%^&*()_+\-=[\]{}|;:,.<>?]/)
    .required(),
  confirmPassword: Joi.any().valid(Joi.ref('newPassword')).required().messages({ 'any.only': 'confirmPassword must match newPassword' }),
});

const assignRoleSchema = Joi.object({
  userId: Joi.string().pattern(objectIdRegex).required(),
  roleId: Joi.string().pattern(objectIdRegex).required(),
});

const createUserSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(8).optional().allow(null, ''),
  firstName: personNameFieldJoi('First name'),
  lastName: personNameFieldJoi('Last name'),
  phone: Joi.string().optional().allow(null, ''),
  roleId: Joi.string().pattern(objectIdRegex).required(),
  address: Joi.string().optional().allow(null, ''),
  city: Joi.string().optional().allow(null, ''),
  state: Joi.string().optional().allow(null, ''),
  zipCode: Joi.string().optional().allow(null, ''),
  status: Joi.string().valid('Active', 'Inactive', 'Suspended').optional(),
  profilePic: Joi.alternatives().try(Joi.string().uri(), Joi.string().pattern(objectIdRegex)).optional().allow(null, ''),
  additionalInfo: Joi.object().optional(),
});

const createUsersSchema = Joi.object({
  users: Joi.array().items(createUserSchema).min(1).required(),
});

module.exports = {
  idParamSchema,
  updateProfileSchema,
  changePasswordSchema,
  assignRoleSchema,
  createUserSchema,
  createUsersSchema,
};
