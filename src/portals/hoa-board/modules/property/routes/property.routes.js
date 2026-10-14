/**
 * ------------------------------------------------------------------
 * File: property.routes.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
// Routes for property resources. Handlers delegate to controller; authentication and
// authorization middleware are applied at the route level for clarity.
const propertyController = require('../controller/property.controller');
const propertySearchController = require('../controller/propertySearch.controller');
const { validateBody, validateParams, validateQuery } = require('../../../../../common/middleware/requestValidator');
const { createPropertySchema, updatePropertySchema, idParamSchema, getPropertiesQuerySchema, listByLandlordQuerySchema, importQuerySchema, updatePropertyQuerySchema } = require('../validators/property.validator');
const Joi = require('joi');
const authMiddleware = require('../../../../../middleware/auth');
const csrfProtection = require('../../../../../middleware/csrfProtection');
const authorize = require('../../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../../middleware/lockCheck');
const { createUpload } = require('../../../../../common/helpers/uploadHelper');
const { UPLOAD_PROPERTY_SUBDIR } = require('../../../../../common/constants/uploads');
const { activityLogger } = require('../../../../../middleware/activityLogger');

const { uploadArray } = createUpload('images', null, { maxCount: 10, maxSizeBytes: 10 * 1024 * 1024, defaultSubdir: UPLOAD_PROPERTY_SUBDIR });

// Conditional multer middleware - only apply for multipart requests
const conditionalUpload = (req, res, next) => {
  const contentType = req.get('Content-Type') || '';
  if (contentType.includes('multipart/form-data')) {
    return uploadArray(req, res, next);
  }
  next();
};

// Custom middleware: handle both multipart/form-data and regular JSON requests
const validatePropertyRequest = (req, res, next) => {
  let parsed;
  
  // Check if this is multipart with data field
  if (req.body && req.body.data) {
    const raw = req.body.data;
    // parse JSON if it is a string
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return res.status(400).json({ message: 'Invalid JSON in data field: ' + err.message });
      }
    } else {
      parsed = raw;
    }
  } else if (req.body && typeof req.body === 'object' && !req.body.data) {
    // Handle regular JSON request
    parsed = req.body;
  } else {
    return res.status(400).json({ message: 'Missing property data. Send multipart/form-data with JSON in "data" field or regular JSON.' });
  }

  // Replace req.body with parsed object
  req.body = parsed;

  // Validate using the create schema
  return validateBody(createPropertySchema)(req, res, next);
};

// Custom middleware for property updates - uses updatePropertySchema
const validatePropertyUpdateRequest = (req, res, next) => {
  let parsed;
  
  // Check if this is multipart with data field
  if (req.body && req.body.data) {
    const raw = req.body.data;
    // parse JSON if it is a string
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return res.status(400).json({ message: 'Invalid JSON in data field: ' + err.message });
      }
    } else {
      parsed = raw;
    }
  } else if (req.body && typeof req.body === 'object' && !req.body.data) {
    // Handle regular JSON request
    parsed = req.body;
  } else {
    return res.status(400).json({ message: 'Missing property data. Send multipart/form-data with JSON in "data" field or regular JSON.' });
  }

  // Replace req.body with parsed object so downstream validators/controllers work with the object
  req.body = parsed;

  // Validate using the update schema (allows partial updates)
  return validateBody(updatePropertySchema)(req, res, next);
};

// /api/v1/property/properties
router.post('/properties', 
  csrfProtection,
  authMiddleware, 
  authorize, 
  lockCheckMiddleware, 
  uploadArray, 
  validateQuery(Joi.object({
    landlordId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
    context: Joi.string().valid('hoa-board').optional(),
  })),
  validatePropertyRequest, 
  propertyController.createProperty,
  activityLogger({
    type: 'property',
    title: 'Property Created',
    description: (req, res, data) => `Property/Unit "${data.data?.name || 'New Property'}" created`,
    propertyId: (req, res, data) => data.data?._id,
    isHOAActivity: true
  })
);

// /api/v1/property/properties (update)
router.put('/properties', 
  csrfProtection,
  authMiddleware, 
  authorize, 
  lockCheckMiddleware, 
  uploadArray, 
  validateQuery(updatePropertyQuerySchema), 
  validatePropertyUpdateRequest, 
  propertyController.updateProperty,
  activityLogger({
    type: 'property',
    title: 'Property Updated',
    description: (req, res, data) => `Property/Unit "${data.data?.name || 'Property'}" updated`,
    propertyId: (req, res, data) => data.data?._id,
    isHOAActivity: true
  })
);

// /api/v1/property/search
router.get('/search', authMiddleware, authorize, lockCheckMiddleware, propertySearchController.searchProperties);

// /api/v1/property/picker
router.get(
  '/picker',
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validateQuery(Joi.object({
    // Optional for HOA board: community scope comes from x-hoa-id / hoaContext.
    landlordId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
    text: Joi.string().allow('').optional(),
    limit: Joi.number().integer().min(1).max(100).optional(),
    context: Joi.string().valid('hoa-board').optional(),
  })),
  propertySearchController.listPropertiesPicker
);

// /api/v1/property/portfolio-overview
router.get(
  '/portfolio-overview',
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validateQuery(Joi.object({
    landlordId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
    context: Joi.string().valid('hoa-board').optional(),
  })),
  propertyController.getPortfolioOverview
);

// /api/v1/property/properties
router.get('/properties', authMiddleware, authorize, lockCheckMiddleware, validateQuery(getPropertiesQuerySchema), propertyController.getProperties);

// /api/v1/property/properties/export
router.get('/properties/export', authMiddleware, authorize, lockCheckMiddleware, validateQuery(getPropertiesQuerySchema), propertyController.exportPropertiesCsv);

// /api/v1/property/properties/import
router.post('/properties/import', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateQuery(importQuerySchema), propertyController.importPropertiesCsv);

// /api/v1/property/properties/:id/images
router.post('/properties/:id/images', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), propertyController.uploadImages);

// /api/v1/property/:id
router.get('/properties/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), propertyController.getPropertyById);

// /api/v1/property/:id/archive
router.patch('/properties/:id/archive', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), propertyController.archiveProperty);

// /api/v1/property/:id/notes
router.post('/properties/:id/notes', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), propertyController.addNoteToProperty);
router.put('/properties/:id/notes/:noteId', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, propertyController.updateNoteInProperty);
router.delete('/properties/:id/notes/:noteId', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, propertyController.deleteNoteFromProperty);

// /api/v1/property/:id
router.delete('/properties/:id', 
  csrfProtection,
  authMiddleware, 
  authorize, 
  lockCheckMiddleware, 
  validateParams(idParamSchema), 
  propertyController.deleteProperty,
  activityLogger({
    type: 'property',
    title: 'Property Deleted',
    description: (req) => `Property/Unit deleted`,
    isHOAActivity: true
  })
);

module.exports = router;
