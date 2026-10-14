/**
 * ------------------------------------------------------------------
 * File: syndication.controller.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * listing.routes
 * ------------------------------------------------------------------
 */

const syndicationService = require('../service/syndication.service');
const listingService = require('../service/listing.service');
const { SYNDICATION_PROVIDERS } = require('../../../../../integrations/syndication/syndication.constants');

/**
 * handle Error
 *
 * Performs logic operations for handleError.
 *
 * @param res - Request/input argument
 * @param err - Request/input argument
 * @param next - Request/input argument
 * @returns Operations result
 */
function handleError(res, err, next) {
  if (err && err.status) {
    return res.status(err.status).json({ message: err.message });
  }
  if (typeof next === 'function') {
    return next(err);
  }
  return res.status(500).json({ message: err && err.message ? err.message : 'Internal server error' });
}

const getSyndicationStatus = async (req, res, next) => {
  try {
    const listing = await listingService.getListingById(req.params.id);
    const syndicationStatus = syndicationService.getSyndicationStatusFromListing(listing);
    return res.status(200).json({ syndicationStatus });
  } catch (err) {
    return handleError(res, err, next);
  }
};

const getLiveSyndicationStatus = async (req, res, next) => {
  try {
    const status = await syndicationService.getLiveSyndicationStatus(
      req.params.id,
      [SYNDICATION_PROVIDERS.ZILLOW]
    );
    return res.status(200).json(status);
  } catch (err) {
    return handleError(res, err, next);
  }
};

const syncToZillow = async (req, res, next) => {
  try {
    const result = await syndicationService.syncListing(
      req.params.id,
      [SYNDICATION_PROVIDERS.ZILLOW]
    );
    return res.status(result.success ? 200 : 422).json(result);
  } catch (err) {
    return handleError(res, err, next);
  }
};

const removeFromZillow = async (req, res, next) => {
  try {
    const result = await syndicationService.unpublishListing(
      req.params.id,
      [SYNDICATION_PROVIDERS.ZILLOW]
    );
    return res.status(result.success ? 200 : 422).json(result);
  } catch (err) {
    return handleError(res, err, next);
  }
};

module.exports = {
  getSyndicationStatus,
  getLiveSyndicationStatus,
  syncToZillow,
  removeFromZillow,
};
