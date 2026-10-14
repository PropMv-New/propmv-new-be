const Joi = require('joi');
const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const { personNameFieldJoi } = require('../../../../../shared/utils/personNameValidation.util');

const idParamSchema = Joi.object({
  id: Joi.string().pattern(objectIdRegex).required(),
});

const createVendorSchema = Joi.object({
  email: Joi.string().email().required(),
  firstName: personNameFieldJoi('First name'),
  lastName: personNameFieldJoi('Last name'),
  phone: Joi.string().trim().max(30).allow('').optional(),
  password: Joi.string().min(8).max(128).optional(),
  sendInvite: Joi.boolean().optional(),
  hoaId: Joi.string().pattern(objectIdRegex).optional(),
  communityName: Joi.string().trim().max(200).optional(),
});

const updateVendorSchema = Joi.object({
  firstName: personNameFieldJoi('First name', { required: false }),
  lastName: personNameFieldJoi('Last name', { required: false }),
  phone: Joi.string().trim().max(30).allow('').optional(),
  status: Joi.string().valid('Active', 'Inactive', 'Pending').optional(),
}).min(1);

const listQuerySchema = Joi.object({
  searchText: Joi.string().trim().max(200).optional().allow(''),
  pageNumber: Joi.number().integer().min(1).default(1),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(500).default(20),
});

module.exports = {
  idParamSchema,
  createVendorSchema,
  updateVendorSchema,
  listQuerySchema,
};
