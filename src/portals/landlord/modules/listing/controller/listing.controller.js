/**
 * ------------------------------------------------------------------
 * File: listing.controller.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * listing.routes
 * ------------------------------------------------------------------
 */

/**
 * Listing controller - Step 4 of the landlord API pipeline (reference implementation).
 *
 * CONTROLLER RESPONSIBILITIES
 * - Log HANDLER_START / HANDLER_END / HANDLER_ERROR for each exported handler
 * - Pass `requestId` + `action` to the service layer for end-to-end correlation
 * - Map HTTP status codes; never log request bodies
 *
 * FULL TRACE (example: POST /api/v1/landlord/listing/listings)
 *   REQUEST_START      → middleware
 *   AUTH_*             → auth.js
 *   AUTHORIZE_*        → authorize.js
 *   HANDLER_START      → this file (createListing)
 *   SERVICE_START      → listing.service.js
 *   SERVICE_VALIDATE   → payload / file count checks
 *   SERVICE_DB_QUERY   → property lookup
 *   SERVICE_DB_WRITE   → listing saved
 *   SERVICE_SYNDICATION→ Zillow sync queued (if active/published)
 *   SERVICE_END        → listing.service.js
 *   HANDLER_END        → this file
 *   REQUEST_END        → middleware (statusCode + durationMs)
 *
 * TO REPLICATE IN OTHER MODULES
 * Copy `serviceOptions`, `handleError`, and the try/catch/log pattern below.
 *
 * @see portals/landlord/utils/landlordController.util.js
 * @see modules/listing/service/listing.service.js
 */
const listingService = require('../service/listing.service');
const { logLandlordStep } = require('../../../utils/landlordController.util');

/**
 * get Actor Id
 *
 * Performs logic operations for getActorId.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function getActorId(req) {
  return req.userId || (req.user && (req.user._id || req.user.id)) || null;
}

/**
 * Builds service-layer options with correlation fields required for pipeline tracing.
 * Always pass the result as the last argument to listingService methods.
 */
function serviceOptions(req, action, extra = {}) {
  return {
    requestId: req.landlordRequestId,
    action,
    ...extra,
  };
}

/**
 * status Action Options
 *
 * Performs logic operations for statusActionOptions.
 *
 * @param req - Request/input argument
 * @param action - Request/input argument
 * @returns Operations result
 */
function statusActionOptions(req, action) {
  const body = req.body || {};
  return serviceOptions(req, action, {
    comment: body.comment,
    actorId: getActorId(req),
    syndicationPlatforms: body.syndicationPlatforms,
    removeFromPlatforms: body.removeFromPlatforms,
  });
}

/** Logs HANDLER_ERROR and returns the appropriate HTTP error response. */
function handleError(req, res, err, next, action) {
  logLandlordStep(req, 'HANDLER_ERROR', {
    action,
    error: err?.message,
    status: err?.status || 500,
  }, `Controller "${action}" failed: ${err?.message || 'unknown error'}`);
  if (err && err.status) {
    return res.status(err.status).json({ message: err.message });
  }
  if (typeof next === 'function') {
    return next(err);
  }
  return res.status(500).json({ message: err && err.message ? err.message : 'Internal server error' });
}

const createListing = async (req, res, next) => {
  const action = 'createListing';
  logLandlordStep(req, 'HANDLER_START', { action, propertyId: req.body?.propertyId });
  try {
    const created = await listingService.createListing(req.body, serviceOptions(req, action, {
      files: req.files,
      uploadedBy: getActorId(req),
    }));
    logLandlordStep(req, 'HANDLER_END', { action, listingId: created?._id, success: true });
    return res.status(201).json(created);
  } catch (err) {
    return handleError(req, res, err, next, action);
  }
};

const updateListing = async (req, res, next) => {
  const action = 'updateListing';
  logLandlordStep(req, 'HANDLER_START', { action, listingId: req.params.id });
  try {
    const updated = await listingService.updateListing(req.params.id, req.body, serviceOptions(req, action, {
      files: req.files,
      uploadedBy: getActorId(req),
    }));
    logLandlordStep(req, 'HANDLER_END', { action, listingId: req.params.id, success: true });
    return res.status(200).json(updated);
  } catch (err) {
    return handleError(req, res, err, next, action);
  }
};

const getListingById = async (req, res, next) => {
  const action = 'getListingById';
  logLandlordStep(req, 'HANDLER_START', { action, listingId: req.params.id });
  try {
    const listing = await listingService.getListingById(req.params.id, serviceOptions(req, action));
    logLandlordStep(req, 'HANDLER_END', { action, listingId: req.params.id, success: true });
    return res.status(200).json(listing);
  } catch (err) {
    return handleError(req, res, err, next, action);
  }
};

const getListings = async (req, res, next) => {
  const action = 'getListings';
  logLandlordStep(req, 'HANDLER_START', { action, page: req.query?.pageNumber });
  try {
    const listings = await listingService.listListings(req.query || {}, serviceOptions(req, action));
    logLandlordStep(req, 'HANDLER_END', {
      action,
      success: true,
      total: listings?.total,
      page: listings?.page,
    });
    return res.status(200).json(listings);
  } catch (err) {
    return handleError(req, res, err, next, action);
  }
};

const deleteListing = async (req, res, next) => {
  const action = 'deleteListing';
  logLandlordStep(req, 'HANDLER_START', { action, listingId: req.params.id });
  try {
    await listingService.deleteListing(req.params.id, serviceOptions(req, action));
    logLandlordStep(req, 'HANDLER_END', { action, listingId: req.params.id, success: true });
    return res.status(200).json({ message: 'Listing deleted successfully' });
  } catch (err) {
    return handleError(req, res, err, next, action);
  }
};

const uploadImages = async (req, res, next) => {
  const action = 'uploadListingImages';
  logLandlordStep(req, 'HANDLER_START', { action, listingId: req.params.id });
  try {
    const savedImages = await listingService.uploadListingImages(req.params.id, req.files, serviceOptions(req, action, {
      uploadedBy: getActorId(req),
    }));
    logLandlordStep(req, 'HANDLER_END', { action, listingId: req.params.id, success: true });
    return res.status(201).json({ savedImages });
  } catch (err) {
    return handleError(req, res, err, next, action);
  }
};

const publishListing = async (req, res, next) => {
  const action = 'publishListing';
  logLandlordStep(req, 'HANDLER_START', { action, listingId: req.params.id });
  try {
    const updated = await listingService.publishListing(req.params.id, statusActionOptions(req, action));
    logLandlordStep(req, 'HANDLER_END', { action, listingId: req.params.id, success: true });
    return res.status(200).json(updated);
  } catch (err) {
    return handleError(req, res, err, next, action);
  }
};

const activateListing = async (req, res, next) => {
  const action = 'activateListing';
  logLandlordStep(req, 'HANDLER_START', { action, listingId: req.params.id });
  try {
    const updated = await listingService.activateListing(req.params.id, serviceOptions(req, action, {
      comment: req.body && req.body.comment,
      actorId: getActorId(req),
    }));
    logLandlordStep(req, 'HANDLER_END', { action, listingId: req.params.id, success: true });
    return res.status(200).json(updated);
  } catch (err) {
    return handleError(req, res, err, next, action);
  }
};

const setInactiveListing = async (req, res, next) => {
  const action = 'setInactiveListing';
  logLandlordStep(req, 'HANDLER_START', { action, listingId: req.params.id });
  try {
    const updated = await listingService.setInactiveListing(req.params.id, serviceOptions(req, action, {
      comment: req.body && req.body.comment,
      actorId: getActorId(req),
    }));
    logLandlordStep(req, 'HANDLER_END', { action, listingId: req.params.id, success: true });
    return res.status(200).json(updated);
  } catch (err) {
    return handleError(req, res, err, next, action);
  }
};

const saveDraftListing = async (req, res, next) => {
  const action = 'saveDraftListing';
  logLandlordStep(req, 'HANDLER_START', { action, listingId: req.params.id });
  try {
    const updated = await listingService.saveDraftListing(req.params.id, statusActionOptions(req, action));
    logLandlordStep(req, 'HANDLER_END', { action, listingId: req.params.id, success: true });
    return res.status(200).json(updated);
  } catch (err) {
    return handleError(req, res, err, next, action);
  }
};

const publishFromDraftListing = async (req, res, next) => {
  const action = 'publishFromDraftListing';
  logLandlordStep(req, 'HANDLER_START', { action, listingId: req.params.id });
  try {
    const updated = await listingService.publishFromDraftListing(req.params.id, statusActionOptions(req, action));
    logLandlordStep(req, 'HANDLER_END', { action, listingId: req.params.id, success: true });
    return res.status(200).json(updated);
  } catch (err) {
    return handleError(req, res, err, next, action);
  }
};

const publishFromInactiveListing = async (req, res, next) => {
  const action = 'publishFromInactiveListing';
  logLandlordStep(req, 'HANDLER_START', { action, listingId: req.params.id });
  try {
    const updated = await listingService.publishFromInactiveListing(req.params.id, statusActionOptions(req, action));
    logLandlordStep(req, 'HANDLER_END', { action, listingId: req.params.id, success: true });
    return res.status(200).json(updated);
  } catch (err) {
    return handleError(req, res, err, next, action);
  }
};

module.exports = {
  createListing,
  updateListing,
  getListingById,
  getListings,
  deleteListing,
  uploadImages,
  publishListing,
  activateListing,
  saveDraftListing,
  setInactiveListing,
  publishFromDraftListing,
  publishFromInactiveListing,
};
