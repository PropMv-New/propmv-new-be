/**
 * ------------------------------------------------------------------
 * File: message.validator.js
 * Module: Src Shared Messaging Validators
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * message.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');

const objectId = Joi.string().regex(/^[0-9a-fA-F]{24}$/);

const messageValidator = {
  sendMessage: Joi.object({
    receiverId: objectId.required(),
    content: Joi.string().allow('').optional(),
    attachments: Joi.array().items(Joi.object()).optional()
  }),
  sendGroupMessage: Joi.object({
    groupId: objectId.required(),
    content: Joi.string().allow('').optional(),
    attachments: Joi.array().items(Joi.object()).optional()
  }),
  createGroup: Joi.object({
    name: Joi.string().trim().min(1).max(100).required(),
    memberIds: Joi.array().items(objectId).min(1).required(),
  }),
  addGroupMembers: Joi.object({
    memberIds: Joi.array().items(objectId).min(1).required(),
  }),
  uploadAttachment: Joi.object({
    receiverId: objectId.required(),
    content: Joi.string().allow('').optional()
  }),
  markAsRead: Joi.object({
    messageIds: Joi.array().items(objectId).min(1).required()
  })
};

module.exports = messageValidator;
