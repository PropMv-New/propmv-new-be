/**
 * ------------------------------------------------------------------
 * File: property.routes.js
 * Module: Landlord Portal
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * landlord
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
// Routes for property resources. Handlers delegate to controller; authentication and
// authorization middleware are applied at the route level for clarity.
const propertyController = require('../controller/property.controller');
const { validateBody, validateParams, validateQuery } = require('../../../../../middleware/requestValidator');
const { createPropertySchema, updatePropertySchema, idParamSchema, getPropertiesQuerySchema, listByLandlordQuerySchema, importQuerySchema, updatePropertyQuerySchema, checkPropertyNameQuerySchema } = require('../validators/property.validator');
const Joi = require('joi');
const authMiddleware = require('../../../../../middleware/auth');
const authorize = require('../../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../../middleware/lockCheck');
const { createUpload } = require('../../../../../common/helpers/uploadHelper');
const { UPLOAD_PROPERTY_SUBDIR } = require('../../../../../common/constants/uploads');
const { multerImageFilter } = require('../../../../../common/helpers/fileValidationHelper');

const { uploadArray } = createUpload('images', null, { 
  maxCount: 10, 
  maxSizeBytes: 10 * 1024 * 1024, 
  defaultSubdir: UPLOAD_PROPERTY_SUBDIR,
  fileFilter: multerImageFilter
});

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
router.post('/properties', authMiddleware, authorize, lockCheckMiddleware, uploadArray, validatePropertyRequest, propertyController.createProperty);

// /api/v1/property/properties (update)
router.put('/properties', authMiddleware, authorize, lockCheckMiddleware, uploadArray, validateQuery(updatePropertyQuerySchema), validatePropertyUpdateRequest, propertyController.updateProperty);

// /api/v1/property/search
router.get('/search', authMiddleware, authorize, lockCheckMiddleware, propertyController.searchProperties);

// /api/v1/property/properties
router.get('/properties', authMiddleware, authorize, lockCheckMiddleware, validateQuery(getPropertiesQuerySchema), propertyController.getProperties);

// /api/v1/property/export - New multi-format export endpoint
router.get('/export', authMiddleware, authorize, lockCheckMiddleware, validateQuery(getPropertiesQuerySchema), propertyController.exportProperties);

// /api/v1/property/template - Download import template
router.get('/template', authMiddleware, authorize, lockCheckMiddleware, propertyController.downloadPropertyTemplate);

// /api/v1/property/properties/export - Legacy CSV export endpoint
router.get('/properties/export', authMiddleware, authorize, lockCheckMiddleware, validateQuery(getPropertiesQuerySchema), propertyController.exportPropertiesCsv);

// /api/v1/property/properties/import
router.post('/properties/import', authMiddleware, authorize, lockCheckMiddleware, validateQuery(importQuerySchema), propertyController.importPropertiesCsv);

// /api/v1/property/properties/:id/images
router.post('/properties/:id/images', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), propertyController.uploadImages);

// /api/v1/property/properties/check-name
router.get('/properties/check-name', authMiddleware, authorize, lockCheckMiddleware, validateQuery(checkPropertyNameQuerySchema), propertyController.checkPropertyName);

// /api/v1/property/:id
router.get('/properties/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), propertyController.getPropertyById);

// /api/v1/property/:id/archive
router.patch('/properties/:id/archive', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), propertyController.archiveProperty);

// /api/v1/property/:id/notes
router.post('/properties/:id/notes', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), propertyController.addNoteToProperty);

// /api/v1/property/:id/profile-image - Set profile image
router.put('/properties/:id/profile-image', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), propertyController.setProfileImage);

// /api/v1/property/:id/images - Delete images
router.delete('/properties/:id/images', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), propertyController.deleteImages);

// /api/v1/property/:id
router.delete('/properties/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), propertyController.deleteProperty);

module.exports = router;
