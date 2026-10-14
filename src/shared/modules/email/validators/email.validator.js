/**
 * ------------------------------------------------------------------
 * File: email.validator.js
 * Module: Email Module
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * email.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');

const callbackSchema = Joi.object({
  code: Joi.string().required(),
  state: Joi.string().required(),
  scope: Joi.string().optional()
});

const listEmailsSchema = Joi.object({
  maxResults: Joi.number().integer().min(1).max(100).optional(),
  pageToken: Joi.string().optional()
});

const sendEmailSchema = Joi.object({
  to: Joi.string().required().custom((value, helpers) => {
    const emails = value.split(',').map(e => e.trim());
    for (const email of emails) {
      const { error } = Joi.string().email().validate(email);
      if (error) return helpers.error('string.email');
    }
    return value;
  }),
  subject: Joi.string().required().max(500),
  body: Joi.string().required(),
  cc: Joi.string().optional().allow(null, '').custom((value, helpers) => {
    if (!value) return value;
    const emails = value.split(',').map(e => e.trim());
    for (const email of emails) {
      const { error } = Joi.string().email().validate(email);
      if (error) return helpers.error('string.email');
    }
    return value;
  }),
  bcc: Joi.string().optional().allow(null, '').custom((value, helpers) => {
    if (!value) return value;
    const emails = value.split(',').map(e => e.trim());
    for (const email of emails) {
      const { error } = Joi.string().email().validate(email);
      if (error) return helpers.error('string.email');
    }
    return value;
  }),
  // Pre-uploaded attachment metadata from /email/upload-attachments (or multipart file uploads)
  attachments: Joi.alternatives()
    .try(
      Joi.array().items(Joi.object({
        documentMetadataId: Joi.alternatives().try(Joi.string(), Joi.object()).required(),
        filename: Joi.string().optional().allow('', null),
        originalName: Joi.string().optional().allow('', null),
        size: Joi.number().optional(),
        mimetype: Joi.string().optional().allow('', null),
        uploadedAt: Joi.alternatives().try(Joi.string(), Joi.date()).optional(),
      }).unknown(true)),
      Joi.string().allow('', null) // multipart may stringify JSON
    )
    .optional()
    .allow(null),
});

const configureSmtpSchema = Joi.object({
  smtpHost: Joi.string().optional(),
  smtpPort: Joi.number().integer().min(1).max(65535).optional(),
  smtpUser: Joi.string().email().required(),
  smtpPassword: Joi.string().required(),
  fromName: Joi.string().optional(),
  imapHost: Joi.string().optional(),
  imapPort: Joi.number().integer().min(1).max(65535).optional()
});

module.exports = {
  callbackSchema,
  listEmailsSchema,
  sendEmailSchema,
  configureSmtpSchema
};
