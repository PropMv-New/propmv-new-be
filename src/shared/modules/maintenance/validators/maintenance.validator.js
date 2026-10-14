/**
 * ------------------------------------------------------------------
 * File: maintenance.validator.js
 * Module: Maintenance Module
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * maintenance.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');
const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const { MAINTENANCE_REQUEST_STATUS } = require('../../../../common/constants/property');

const allowedCategories = ['Plumbing', 'Electrical', 'HVAC', 'Appliance', 'Structural', 'Pest Control', 'Landscaping', 'Other'];
const allowedPriorities = ['Low', 'Medium', 'High', 'Urgent'];

/**
 * File upload restrictions for maintenance requests:
 * - Only image files are allowed: JPG, JPEG, PNG
 * - Max 5 files per request
 * - Max 50MB per file (configurable via UPLOAD_MAINTENANCE_ATTACHMENTS_MAX_SIZE_MB)
 */
const allowedFileTypes = ['JPG', 'JPEG', 'PNG'];

// MAINTENANCE_REQUEST_STATUS values (Rejected is legacy-only; not writable on create/update)
const maintenanceStatusValues = Object.values(MAINTENANCE_REQUEST_STATUS);
const writableMaintenanceStatusValues = maintenanceStatusValues.filter(
  (s) => s !== MAINTENANCE_REQUEST_STATUS.REJECTED
);

const idParamSchema = Joi.object({ id: Joi.string().pattern(objectIdRegex).required() });

const createRequestSchema = Joi.object({
  property_id: Joi.string().pattern(objectIdRegex).optional(),
  unitId: Joi.string().pattern(objectIdRegex).optional(),
  units: Joi.string().trim().optional().allow(''),
  title: Joi.string().max(150).required(),
  description: Joi.string().required(),
  category: Joi.string().valid(...allowedCategories).optional(),
  primaryRequestType: Joi.string().optional(),
  subRequestType: Joi.string().optional(),
  otherSubRequestDetail: Joi.string().trim().max(200).optional().allow('', null),
  priority: Joi.string().valid(...allowedPriorities).required(),
  isUrgent: Joi.boolean().required(),
  requestedBy: Joi.alternatives().try(
    Joi.string().pattern(objectIdRegex),
    Joi.array().items(Joi.string().pattern(objectIdRegex))
  ).optional(),
  notifyTenant: Joi.boolean().required(),
  hoaId: Joi.string().pattern(objectIdRegex).optional(),
  createdBy: Joi.string().pattern(objectIdRegex).optional(),
  assignedTo: Joi.string().pattern(objectIdRegex).allow(null).optional(),
  status: Joi.string().valid(...writableMaintenanceStatusValues).optional(),
});

const updateRequestSchema = Joi.object({
  property_id: Joi.alternatives().try(
    Joi.string().pattern(objectIdRegex),
    Joi.valid(null, '')
  ).optional(),
  unitId: Joi.alternatives().try(
    Joi.string().pattern(objectIdRegex),
    Joi.valid(null, '')
  ).optional(),
  units: Joi.string().trim().optional().allow(''),
  title: Joi.string().max(150).optional(),
  description: Joi.string().optional(),
  category: Joi.string().valid(...allowedCategories).optional(),
  priority: Joi.string().valid(...allowedPriorities).optional(),
  isUrgent: Joi.boolean().optional(),
  requestedBy: Joi.alternatives().try(
    Joi.string().pattern(objectIdRegex),
    Joi.array().items(Joi.string().pattern(objectIdRegex)).min(1)
  ).optional(),
  notifyTenant: Joi.boolean().optional(),
  assignedTo: Joi.string().pattern(objectIdRegex).allow(null).optional(),
  completedDate: Joi.date().iso().allow(null).optional(),
  estimatedCost: Joi.number().min(0).optional(),
  actualCost: Joi.number().min(0).optional(),
  requestToDelete: Joi.array().items(Joi.string().pattern(objectIdRegex)).optional(),
  primaryRequestType: Joi.string().optional(),
  subRequestType: Joi.string().optional(),
  otherSubRequestDetail: Joi.string().trim().max(200).optional().allow('', null),
  status: Joi.string().valid(...writableMaintenanceStatusValues).optional()
}).min(1);

const listQuerySchema = Joi.object({
  property_id: Joi.string().pattern(objectIdRegex).optional(),
  category: Joi.string().valid(...allowedCategories).optional(),
  priority: Joi.string().valid(...allowedPriorities).optional(),
  status: Joi.string().valid(...maintenanceStatusValues).optional(),
  isUrgent: Joi.boolean().optional(),
  createdBy: Joi.string().pattern(objectIdRegex).optional(),
  requestedBy: Joi.string().pattern(objectIdRegex).optional(),
  hoaBoardMemberId: Joi.string().pattern(objectIdRegex).optional(),
  hoaOwnerId: Joi.string().pattern(objectIdRegex).optional(),
  vendorId: Joi.string().pattern(objectIdRegex).optional(),
  searchText: Joi.string().trim().max(200).optional(),
  pageNumber: Joi.number().integer().min(1).default(1),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  startDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sortBy: Joi.string().valid('createdAt', 'updatedAt', 'request_date', 'status', 'priority').optional(),
  sortOrder: Joi.string().valid('asc', 'desc').optional(),
  primaryRequestType: Joi.string().trim().max(200).optional(),
  subRequestType: Joi.string().trim().max(200).optional(),
});

const addCommentSchema = Joi.object({
  text: Joi.string().trim().min(1).max(1000).required(),
  // Ids of this ticket's documents uploaded with the comment.
  attachments: Joi.array().items(Joi.string().hex().length(24)).max(10).optional()
});

const addNoteSchema = Joi.object({
  content: Joi.string().trim().min(1).max(5000).required()
});

const updateNoteSchema = Joi.object({
  content: Joi.string().trim().min(1).max(5000).required()
});

const noteIdParamSchema = Joi.object({
  id: Joi.string().pattern(objectIdRegex).required(),
  noteId: Joi.string().pattern(objectIdRegex).required(),
});

const exportQuerySchema = Joi.object({
  createdBy: Joi.string().pattern(objectIdRegex).optional(),
  hoaBoardMemberId: Joi.string().pattern(objectIdRegex).optional(),
  hoaOwnerId: Joi.string().pattern(objectIdRegex).optional(),
  vendorId: Joi.string().pattern(objectIdRegex).optional(),
  requestedBy: Joi.string().pattern(objectIdRegex).optional(),
  property_id: Joi.string().pattern(objectIdRegex).optional(),
  category: Joi.string().valid(...allowedCategories).optional(),
  priority: Joi.string().valid(...allowedPriorities).optional(),
  status: Joi.string().valid(...maintenanceStatusValues).optional(),
  isUrgent: Joi.boolean().optional(),
  startDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  searchText: Joi.string().trim().max(200).optional(),
  primaryRequestType: Joi.string().trim().max(200).optional(),
  subRequestType: Joi.string().trim().max(200).optional(),
  format: Joi.string().valid('csv', 'xlsx', 'excel', 'json').optional(),
  pageNumber: Joi.number().integer().min(1).optional(),
  // pageSize 0 = export all matching rows (same as list pagination helper)
  pageSize: Joi.number().integer().min(0).max(500).optional()
});

module.exports = {
  idParamSchema,
  createRequestSchema,
  updateRequestSchema,
  listQuerySchema,
  addCommentSchema,
  addNoteSchema,
  updateNoteSchema,
  noteIdParamSchema,
  exportQuerySchema
};


