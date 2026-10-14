/**
 * ------------------------------------------------------------------
 * File: email.validator.js
 * Module: Src Shared Email Validators
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * email.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');

const sendEmail = {
  body: Joi.object({
    receiverId: Joi.string().required(),
    subject: Joi.string().required().max(500),
    content: Joi.string().required().max(10000)
  })
};

const markAsRead = {
  body: Joi.object({
    emailIds: Joi.array().items(Joi.string()).required()
  })
};

module.exports = {
  sendEmail,
  markAsRead
};
