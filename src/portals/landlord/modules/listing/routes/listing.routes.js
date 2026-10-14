/**
 * ------------------------------------------------------------------
 * File: listing.routes.js
 * Module: Landlord Portal
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * landlord, routes
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const listingController = require('../controller/listing.controller');
const syndicationController = require('../controller/syndication.controller');
const { createUpload } = require('../../../../../common/helpers/uploadHelper');
const { validateMultipart } = require('../../../../../middleware/multipartValidator');
const { validate } = require('../../../../../middleware/requestValidator');
const { multerImageFilter } = require('../../../../../common/helpers/fileValidationHelper');
const authMiddleware = require('../../../../../middleware/auth');
const authorize = require('../../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../../middleware/lockCheck');
const { UPLOAD_LISTING_SUBDIR } = require('../../../../../common/constants/uploads');
const {
  createListingSchema,
  updateListingSchema,
  idParamSchema,
  listListingsQuerySchema,
  listingStatusActionSchema,
} = require('../validators/listing.validator');

// Create upload middleware for images
const { uploadArray } = createUpload('images', null, { 
  maxCount: 10, 
  maxSizeBytes: 10 * 1024 * 1024,
  defaultSubdir: UPLOAD_LISTING_SUBDIR,
  fileFilter: multerImageFilter,
});

/**
 * @swagger
 * /api/v1/listing/listings:
 *   post:
 *     summary: Create a new listing
 *     tags: [Listings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               data:
 *                 type: string
 *                 description: JSON string containing listing data
 *               images:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *                 description: At least 3 images required
 *     responses:
 *       201:
 *         description: Listing created successfully
 *       400:
 *         description: Validation error
 */
router.post('/listings', 
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  uploadArray,
  validateMultipart(createListingSchema, { 
    fileFilter: multerImageFilter, 
    contentProfile: 'IMAGE',
    minFiles: 3, 
    maxFiles: 10, 
    parseJsonData: true 
  }),
  listingController.createListing
);

/**
 * @swagger
 * /api/v1/listing/listings:
 *   get:
 *     summary: Get all listings with pagination
 *     tags: [Listings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *         description: Page number
 *       - in: query
 *         name: pageSize
 *         schema:
 *           type: integer
 *           minimum: 0
 *         description: Number of items per page
 *       - in: query
 *         name: createdBy
 *         schema:
 *           type: string
 *         description: Filter by creator ID
 *       - in: query
 *         name: propertyId
 *         schema:
 *           type: string
 *         description: Filter by property ID
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [Active, Published]
 *         description: Filter by status
 *       - in: query
 *         name: unitName
 *         schema:
 *           type: string
 *         description: Filter by unit name
 *       - in: query
 *         name: leaseType
 *         schema:
 *           type: string
 *           enum: [Fixed Term, Month-to-Month, Short Term]
 *         description: Filter by lease type
 *       - in: query
 *         name: isAcceptingApplications
 *         schema:
 *           type: boolean
 *         description: Filter by application acceptance status
 *       - in: query
 *         name: availableFrom
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter by available date from
 *       - in: query
 *         name: availableTo
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter by available date to
 *       - in: query
 *         name: minRent
 *         schema:
 *           type: number
 *         description: Minimum rental amount
 *       - in: query
 *         name: maxRent
 *         schema:
 *           type: number
 *         description: Maximum rental amount
 *     responses:
 *       200:
 *         description: List of listings
 */
router.get('/listings', 
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validate({ query: listListingsQuerySchema }),
  listingController.getListings
);

/**
 * @swagger
 * /api/v1/listing/listings/{id}:
 *   get:
 *     summary: Get listing by ID
 *     tags: [Listings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Listing ID
 *     responses:
 *       200:
 *         description: Listing details
 *       404:
 *         description: Listing not found
 */
router.get('/listings/:id', 
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validate({ params: idParamSchema }),
  listingController.getListingById
);

/**
 * @swagger
 * /api/v1/listing/listings/{id}:
 *   put:
 *     summary: Update listing
 *     tags: [Listings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Listing ID
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               data:
 *                 type: string
 *                 description: JSON string containing listing data
 *               images:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *                 description: Additional images (optional)
 *     responses:
 *       200:
 *         description: Listing updated successfully
 *       404:
 *         description: Listing not found
 */
router.put('/listings/:id', 
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validate({ params: idParamSchema }),
  uploadArray,
  validateMultipart(updateListingSchema, { 
    fileFilter: multerImageFilter, 
    contentProfile: 'IMAGE',
    minFiles: 0,
    maxFiles: 10, 
    parseJsonData: true 
  }),
  listingController.updateListing
);

/**
 * @swagger
 * /api/v1/listing/listings/{id}:
 *   delete:
 *     summary: Delete listing
 *     tags: [Listings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Listing ID
 *     responses:
 *       200:
 *         description: Listing deleted successfully
 *       404:
 *         description: Listing not found
 */
router.put('/listings/:id/publish', 
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validate({ params: idParamSchema, body: listingStatusActionSchema }),
  listingController.publishListing
);

router.put('/listings/:id/activate', 
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validate({ params: idParamSchema }),
  listingController.activateListing
);

router.put('/listings/:id/inactive', 
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validate({ params: idParamSchema }),
  listingController.setInactiveListing
);

router.put('/listings/:id/draft', 
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validate({ params: idParamSchema, body: listingStatusActionSchema }),
  listingController.saveDraftListing
);

router.put('/listings/:id/publish-draft', 
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validate({ params: idParamSchema, body: listingStatusActionSchema }),
  listingController.publishFromDraftListing
);

router.put('/listings/:id/publish-from-inactive', 
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validate({ params: idParamSchema, body: listingStatusActionSchema }),
  listingController.publishFromInactiveListing
);

router.get('/listings/:id/syndication',
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validate({ params: idParamSchema }),
  syndicationController.getSyndicationStatus
);

router.get('/listings/:id/syndication/live',
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validate({ params: idParamSchema }),
  syndicationController.getLiveSyndicationStatus
);

router.post('/listings/:id/syndication/zillow/sync',
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validate({ params: idParamSchema }),
  syndicationController.syncToZillow
);

router.post('/listings/:id/syndication/zillow/remove',
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validate({ params: idParamSchema }),
  syndicationController.removeFromZillow
);

router.delete('/listings/:id', 
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validate({ params: idParamSchema }),
  listingController.deleteListing
);

/**
 * @swagger
 * /api/v1/listing/listings/{id}/images:
 *   post:
 *     summary: Upload additional images to listing
 *     tags: [Listings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Listing ID
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               images:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *                 description: Image files to upload
 *     responses:
 *       201:
 *         description: Images uploaded successfully
 *       400:
 *         description: Upload failed
 */
router.post('/listings/:id/images', 
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validate({ params: idParamSchema }),
  uploadArray,
  validateMultipart(null, {
    fileFilter: multerImageFilter,
    contentProfile: 'IMAGE',
    minFiles: 1,
    maxFiles: 10
  }),
  listingController.uploadImages
);

module.exports = router;
