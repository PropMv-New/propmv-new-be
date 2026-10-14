const path = require('path');
const fs = require('fs');

/**
 * ------------------------------------------------------------------
 * File: property.controller.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * property.routes
 * ------------------------------------------------------------------
 */
const propertyService = require('../service/property.service');
const logger = require('../../../../../common/logger');
const { createUpload } = require('../../../../../common/helpers/uploadHelper');
const { UPLOAD_PROPERTY_SUBDIR } = require('../../../../../common/constants/uploads');
const { filterResponseForHOA } = require('../../../../../config/hoaRouteConfig');
const { notifyPropertyCreatedInAppInBackground, notifyPropertyUpdatedInAppInBackground, notifyPropertyDeletedInAppInBackground } = require('../../../../../common/helpers/hoaEntityNotify.helper');

const { uploadArray } = createUpload('images', null, { maxCount: 10, maxSizeBytes: 10 * 1024 * 1024, defaultSubdir: UPLOAD_PROPERTY_SUBDIR });
const { uploadArray: uploadFile, tempDir: importTempDir } = createUpload('file', null, { maxCount: 1, maxSizeBytes: 10 * 1024 * 1024 });
const noteUpload = createUpload('attachments', null, {
  maxCount: 10,
  maxSizeBytes: 20 * 1024 * 1024,
  defaultSubdir: UPLOAD_PROPERTY_SUBDIR || 'property-notes',
  allowedExtensions: ['.jpg', '.jpeg', '.png', '.pdf', '.doc', '.docx', '.txt', '.xlsx', '.xls']
});

const safeUnlink = (filePath, allowedDir) => {
  try {
    const resolved = path.resolve(filePath);
    if (allowedDir && !resolved.startsWith(path.resolve(allowedDir) + path.sep)) return;
    fs.unlinkSync(resolved);
  } catch (ignore) {}
};

const cleanupFiles = (files, allowedDir) => {

        // Cleanup files if validation fails
  if (files) { for (const f of files) safeUnlink(f.path, allowedDir); }
};

const getPropertyById = async (req, res) => {
  try {
    const propertyId = req.params && req.params.id;
    if (!propertyId) {
      return res.status(400).json({ message: 'Property ID is required' });
    }
    const property = await propertyService.getPropertyByIdService(propertyId, {
      include: req.query?.include,
      hoaContext: req.hoaContext,
    });
    if (!property) {
      return res.status(404).json({ message: 'Property not found' });
    }
    res.json(property);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ message: err.message });
  }
};

// Simple in-memory cache for portfolio overview (1 minute TTL)
const portfolioCache = new Map();
const CACHE_TTL = 60 * 1000; // 1 minute

const getProperties = async (req, res) => {
  const startTime = Date.now();
  try {
    const q = Object.assign({}, req.query || {});
    if (typeof q.pagesize !== 'undefined' && typeof q.pageSize === 'undefined') q.pageSize = q.pagesize;
    if (typeof q.page !== 'undefined') q.page = Number(q.page);
    if (typeof q.pageSize !== 'undefined') q.pageSize = Number(q.pageSize);

    // Pass HOA context to service
    const userContext = req.hoaContext || null;
    const result = await propertyService.getPropertiesService(q, userContext);
    
    // Filter response for HOA Board Members
    if (result.data) {
      result.data = filterResponseForHOA(result.data, userContext);
    }
    
    // Portfolio overview is served by GET /portfolio-overview (not bundled on list).
    
    const responseTime = Date.now() - startTime;
    result.responseTime = responseTime;
    return res.json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ message: err.message });
  }
};

const getPortfolioOverview = async (req, res) => {
  const startTime = Date.now();
  try {
    const landlordId = req.query?.landlordId;
    if (!landlordId) {
      return res.status(400).json({ message: 'landlordId is required' });
    }

    const cacheKey = `portfolio_${landlordId}`;
    const cached = portfolioCache.get(cacheKey);

    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      logger.info('[CACHE] Portfolio overview cache HIT');
      return res.json({
        data: cached.data,
        responseTime: Date.now() - startTime,
        cached: true,
      });
    }

    logger.info('[CACHE] Portfolio overview cache MISS');
    const portfolioOverview = await propertyService.getPortfolioOverviewService(landlordId);
    portfolioCache.set(cacheKey, { data: portfolioOverview, timestamp: Date.now() });
    return res.json({
      data: portfolioOverview,
      responseTime: Date.now() - startTime,
      cached: false,
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ message: err.message });
  }
};

const createProperty = async (req, res) => {
  // Check if this is a multipart request with images
  if (req.files && req.files.length > 0) {
    // Handle multipart request with images
    try {
      const landlordId = req.query && req.query.landlordId;
      if (!landlordId) {
        cleanupFiles(req.files, importTempDir);
        return res.status(400).json({ message: 'landlordId is required as query param' });
      }

      // The middleware has already processed req.body.data and replaced req.body with parsed JSON
      const propertyData = req.body;
      if (!propertyData) {
        cleanupFiles(req.files, importTempDir);
        return res.status(400).json({ message: 'property data is required' });
      }

      const files = req.files || [];

      if (files.length > 10) {
        cleanupFiles(files, importTempDir);
        return res.status(400).json({ message: 'Too many files. Maximum 10 images are allowed in one request.' });
      }

      // Create property first
      const actorUserId = req.user?.id || req.user?._id || null;
      const createdProperty = await propertyService.createPropertyService(propertyData, landlordId, {
        userId: actorUserId,
        hoaContext: req.hoaContext || null,
      });
      
      // Upload images if provided
      let uploadedImages = [];
      if (files && files.length > 0) {
        try {
          uploadedImages = await propertyService.uploadPropertyImagesService(createdProperty._id, files, { uploadedBy: req.user && req.user.id });
        } catch (uploadErr) {
          // If image upload fails, optionally delete the created property or just return error with property data
          const status = uploadErr.status || 500;
          return res.status(status).json({ message: 'Property created but image upload failed: ' + uploadErr.message });
        }
      }

      // Return combined result with property and uploaded images
      const result = Object.assign({}, createdProperty);
      if (uploadedImages && uploadedImages.length > 0) {
        result.images = uploadedImages;
      }

      setImmediate(() => {
        notifyPropertyCreatedInAppInBackground(createdProperty, actorUserId);
      });

      return res.status(201).json(result);
    } catch (e) {
      cleanupFiles(req.files, importTempDir);
      const status = e.status || 500;
      res.status(status).json({ message: e.message });
    }
  } else {
    // Handle request without images - could be multipart with data field or regular JSON
    try {
      const landlordId = req.query && req.query.landlordId;
      // The middleware has already processed the request body
      const propertyData = req.body;
      if (!propertyData) return res.status(400).json({ message: 'property data is required' });
      const actorUserId = req.user?.id || req.user?._id || null;
      const saved = await propertyService.createPropertyService(propertyData, landlordId, {
        userId: actorUserId,
        hoaContext: req.hoaContext || null,
      });
      setImmediate(() => {
        notifyPropertyCreatedInAppInBackground(saved, actorUserId);
      });
      res.status(201).json(saved);
    } catch (err) {
      const status = err.status || 500;
      res.status(status).json({ message: err.message });
    }
  }
};

const updateProperty = async (req, res) => {
  // Check if this is a multipart request with images
  if (req.files && req.files.length > 0) {
    // Handle multipart request with images
    try {
      const landlordId = req.query && req.query.landlordId;
      const propertyId = req.query && req.query.propertyId;
      
      if (!landlordId) {
        cleanupFiles(req.files, importTempDir);
        return res.status(400).json({ message: 'landlordId is required as query param' });
      }

      if (!propertyId) {
        cleanupFiles(req.files, importTempDir);
        return res.status(400).json({ message: 'propertyId is required as query param' });
      }

      // The middleware has already processed req.body.data and replaced req.body with parsed JSON
      const propertyData = req.body;
      if (!propertyData) {
        cleanupFiles(req.files, importTempDir);
        return res.status(400).json({ message: 'property data is required' });
      }

      const files = req.files || [];

      if (files.length > 10) {
        cleanupFiles(files, importTempDir);
        return res.status(400).json({ message: 'Too many files. Maximum 10 images are allowed in one request.' });
      }

      // Update property first
      const actorUserId = req.user?.id || req.user?._id || null;
      const updatedProperty = await propertyService.updatePropertyService(propertyId, propertyData, landlordId, {
        userId: actorUserId,
        hoaContext: req.hoaContext,
      });
      
      // Upload images if provided
      let uploadedImages = [];
      if (files && files.length > 0) {
        try {
          uploadedImages = await propertyService.uploadPropertyImagesService(updatedProperty._id, files, { uploadedBy: req.user && req.user.id });
        } catch (uploadErr) {
          // If image upload fails, return error with property data
          const status = uploadErr.status || 500;
          return res.status(status).json({ message: 'Property updated but image upload failed: ' + uploadErr.message });
        }
      }

      // Return combined result with property and uploaded images
      const result = Object.assign({}, updatedProperty);
      if (uploadedImages && uploadedImages.length > 0) {
        result.images = uploadedImages;
      }

      setImmediate(() => {
        notifyPropertyUpdatedInAppInBackground(updatedProperty, actorUserId);
      });

      return res.json(result);
    } catch (e) {
      cleanupFiles(req.files, importTempDir);
      const status = e.status || 500;
      res.status(status).json({ message: e.message });
    }
  } else {
    // Handle request without images - could be multipart with data field or regular JSON
    try {
      const landlordId = req.query && req.query.landlordId;
      const propertyId = req.query && req.query.propertyId;

      if (!landlordId) {
        return res.status(400).json({ message: 'landlordId is required as query param' });
      }

      if (!propertyId) {
        return res.status(400).json({ message: 'propertyId is required as query param' });
      }

      // The middleware has already processed the request body
      const propertyData = req.body;
      if (!propertyData) {
        return res.status(400).json({ message: 'property data is required' });
      }

      const actorUserId = req.user?.id || req.user?._id || null;
      const updated = await propertyService.updatePropertyService(propertyId, propertyData, landlordId, {
        userId: actorUserId,
        hoaContext: req.hoaContext,
      });
      setImmediate(() => {
        notifyPropertyUpdatedInAppInBackground(updated, actorUserId);
      });
      res.json(updated);
    } catch (err) {
      const status = err.status || 500;
      res.status(status).json({ message: err.message });
    }
  }
};

const deleteProperty = async (req, res) => {
  try {
    const propertyId = req.params && req.params.id;
    const actorUserId = req.user?.id || req.user?._id || null;
    await propertyService.deletePropertyService(propertyId, { userId: actorUserId });
    setImmediate(() => {
      notifyPropertyDeletedInAppInBackground({
        hoaId: req.hoaContext?.hoaId,
        propertyId,
        propertyName: 'Property',
      }, actorUserId);
    });
    res.json({ message: 'Property deleted successfully' });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ message: err.message });
  }
}

const archiveProperty = async (req, res) => {
  try {
    const propertyId = req.params && req.params.id;

    // Use a lightweight findById instead of the full getPropertyByIdService
    const currentProperty = await require('../../property/model/property.model').findById(propertyId).lean();
    if (!currentProperty) {
      return res.status(404).json({ message: 'Property not found' });
    }

    // Toggle archive status
    let result;
    const actorUserId = req.user?.id || req.user?._id || null;
    if (currentProperty.isArchieved) {
      result = await propertyService.unarchivePropertyService(propertyId, { userId: actorUserId });
    } else {
      result = await propertyService.archivePropertyService(propertyId, { userId: actorUserId });
    }

    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ message: err.message });
  }
}

const addNoteToProperty = async (req, res) => {
  noteUpload.uploadArray(req, res, async function (err) {
    if (err) {
      return res.status(400).json({ message: err.message || 'Upload failed' });
    }
    try {
      const propertyId = req.params && req.params.id;
      const { description, title, isPinned, isImportant, reminder } = req.body;
      const files = req.files || [];
      if (!description) return res.status(400).json({ message: 'description is required' });
      if (files.length > 10) return res.status(400).json({ message: 'Maximum 10 attachments allowed.' });
      
      // Parse boolean values from FormData strings
      const parsedData = {
        description,
        title,
        isPinned: isPinned === 'true' || isPinned === true,
        isImportant: isImportant === 'true' || isImportant === true,
        reminder
      };
      
  const updated = await propertyService.addNoteToPropertyService(propertyId, parsedData, files, req.userId);
  // Only return the notes array to the client (avoid sending whole property object)
  const notesOnly = Array.isArray(updated && updated.notes) ? updated.notes : (updated && updated.notes ? updated.notes : []);
  return res.status(201).json({ notes: notesOnly });
    } catch (e) {
      cleanupFiles(req.files, importTempDir);
      const status = e.status || 500;
      res.status(status).json({ message: e.message });
    }
  });
};

const updateNoteInProperty = async (req, res) => {
  const runUpdate = async () => {
    try {
      const propertyId = req.params.id;
      const noteId = req.params.noteId;
      const { description, title, isPinned, isImportant, reminder, removeAttachmentIds } = req.body;
      const files = req.files || [];
      if (files.length > 10) return res.status(400).json({ message: 'Maximum 10 attachments allowed.' });

      const parsedData = {
        description,
        title,
        reminder,
        removeAttachmentIds,
      };
      if (isPinned !== undefined) {
        parsedData.isPinned = isPinned === 'true' || isPinned === true;
      }
      if (isImportant !== undefined) {
        parsedData.isImportant = isImportant === 'true' || isImportant === true;
      }

      const updated = await propertyService.updateNoteInPropertyService(
        propertyId,
        noteId,
        parsedData,
        req.userId,
        files,
      );
      const notesOnly = Array.isArray(updated?.notes) ? updated.notes : [];
      return res.status(200).json({ notes: notesOnly });
    } catch (e) {
      cleanupFiles(req.files, importTempDir);
      const status = e.status || 500;
      res.status(status).json({ message: e.message });
    }
  };

  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) {
    noteUpload.uploadArray(req, res, async function (err) {
      if (err) {
        return res.status(400).json({ message: err.message || 'Upload failed' });
      }
      await runUpdate();
    });
    return;
  }

  await runUpdate();
};

const deleteNoteFromProperty = async (req, res) => {
  try {
    const propertyId = req.params.id;
    const noteId = req.params.noteId;
    
    const updated = await propertyService.deleteNoteFromPropertyService(propertyId, noteId, req.userId);
    const notesOnly = Array.isArray(updated?.notes) ? updated.notes : [];
    return res.status(200).json({ notes: notesOnly });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ message: e.message });
  }
};

const uploadImages = async (req, res) => {
  uploadArray(req, res, async function (err) {
    if (err) {
      return res.status(400).json({ message: err.message || 'Upload failed' });
    }

    try {
      const propertyId = req.params && req.params.id || req.query.propertyId;
      if (!propertyId) return res.status(400).json({ message: 'propertyId is required as path param or query' });

      const files = req.files || [];
      if (!files || files.length === 0) return res.status(400).json({ message: 'No files uploaded. Use form field "images" to upload one or more image files.' });
      if (files.length > 10) return res.status(400).json({ message: 'Too many files. Maximum 10 images are allowed in one request.' });

      const savedImages = await propertyService.uploadPropertyImagesService(propertyId, files, { uploadedBy: req.user && req.user.id });
      return res.status(201).json({ savedImages });
    } catch (e) {
      cleanupFiles(req.files, importTempDir);
      const status = e.status || 500;
      res.status(status).json({ message: e.message });
    }
  });
};

const exportPropertiesCsv = async (req, res) => {
  try {
    const q = Object.assign({}, req.query || {});
    if (typeof q.pagesize !== 'undefined' && typeof q.pageSize === 'undefined') q.pageSize = q.pagesize;
    if (typeof q.page !== 'undefined') q.page = Number(q.page);
    if (typeof q.pageSize !== 'undefined') q.pageSize = Number(q.pageSize);

    if (typeof q.page !== 'undefined' && (!Number.isInteger(q.page) || q.page <= 0)) {
      return res.status(400).json({ message: 'page must be a positive integer and not 0' });
    }
    if (typeof q.pageSize !== 'undefined' && (!Number.isInteger(q.pageSize) || q.pageSize <= 0)) {
      return res.status(400).json({ message: 'pageSize must be a positive integer and not 0' });
    }

    const result = await propertyService.exportPropertiesCsvService(q, req.hoaContext || null);
    const rawFilename = result && result.filename ? result.filename : `properties_export.csv`;
    const csv = result && result.csv ? result.csv : '';

    const safeFilename = path.basename(rawFilename).replace(/[^\w\-_.]/g, '_');
    res.setHeader('Content-Type', 'text/csv;charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    return res.send(csv);
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ message: err.message });
  }
};

const importPropertiesCsv = async (req, res) => {
  const landlordId = req.query && req.query.landlordId;
  if (!landlordId) return res.status(400).json({ message: 'landlordId is required as query param' });

  uploadFile(req, res, async function (err) {
    if (err) return res.status(400).json({ message: err.message || 'Upload failed' });

    try {
      const files = req.files || [];
      if (!files || files.length === 0) return res.status(400).json({ message: 'No file uploaded. Use form field "file" to upload CSV.' });

        const f = files[0];
        let fileForService = f;
        if (f && f.path && !f.buffer) {
          try {
            const resolvedPath = path.resolve(f.path);
            if (importTempDir && !resolvedPath.startsWith(path.resolve(importTempDir) + path.sep)) {
              throw Object.assign(new Error('Invalid file path'), { status: 400 });
            }
            const buf = fs.readFileSync(resolvedPath);
            fileForService = Object.assign({}, f, { buffer: buf });
          } catch (readErr) {
            safeUnlink(f.path, importTempDir);
            throw Object.assign(new Error('Failed to read uploaded temp file: ' + (readErr && readErr.message ? readErr.message : String(readErr))), { status: 400 });
          }
        }

        const result = await propertyService.importPropertiesFromCsv(fileForService, landlordId);

        safeUnlink(f.path, importTempDir);

        return res.status(200).json(result);
    } catch (e) {
      cleanupFiles(req.files, importTempDir);
      const status = e.status || 500;
      return res.status(status).json({ message: e.message });
    }
  });
};

module.exports = {
  getPropertyById,
  getProperties,
  getPortfolioOverview,
  createProperty,
  updateProperty,
  deleteProperty,
  archiveProperty,
  addNoteToProperty,
  updateNoteInProperty,
  deleteNoteFromProperty,
  uploadImages,
  exportPropertiesCsv,
  importPropertiesCsv
};
