/**
 * ------------------------------------------------------------------
 * File: signup.validator.js
 * Module: Src Shared Modules Auth Validators
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const Joi = require('joi');

const signupSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
  confirmPassword: Joi.string().required(),
  firstName: Joi.string().min(1).required(),
  lastName: Joi.string().min(1).required(),
  phone: Joi.string()
    .pattern(/^(\+1)?[2-9]\d{9}$|^\+?[1-9]\d{1,14}$/, { name: 'phone' })
    .max(15)
    .custom((value, helpers) => {
      const digits = value.replace(/\D/g, '');
      const normalized = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
      if (normalized.length > 10) {
        return helpers.error('any.invalid');
      }
      return value;
    })
    .messages({ 'any.invalid': 'Phone number must not exceed 10 digits' })
    .optional().allow('', null),
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
  }).optional(),
});

module.exports = { signupSchema };
