/**
 * ------------------------------------------------------------------
 * File: propertySearch.controller.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * property.routes
 * ------------------------------------------------------------------
 */

const propertySearchService = require('../service/propertySearch.service');
const { listPropertiesPickerService } = require('../service/propertyPicker.service');
const responseHelper = require('../../../../../common/helpers/responseHelper');

const searchProperties = async (req, res) => {
  try {
    const { text = '', landlordId } = req.query;
    const hasHoaScope = Boolean(req.hoaContext?.hoaId || req.hoaContext?.isHOABoardMember);

    if (!landlordId && !hasHoaScope) {
      return responseHelper.error(res, 'landlordId is required', 400);
    }

    const properties = await propertySearchService.searchPropertiesService(
      text,
      landlordId || undefined,
      req.hoaContext || null,
    );
    return responseHelper.success(res, properties, 'Success', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

const listPropertiesPicker = async (req, res) => {
  try {
    const { text = '', landlordId, limit = 50 } = req.query;
    const hasHoaScope = Boolean(req.hoaContext?.hoaId || req.hoaContext?.isHOABoardMember);

    if (!landlordId && !hasHoaScope) {
      return responseHelper.error(res, 'landlordId is required', 400);
    }

    const rows = await listPropertiesPickerService({
      text,
      landlordId: landlordId || undefined,
      limit: parseInt(limit, 10) || 50,
      userContext: req.hoaContext || null,
    });
    return responseHelper.success(res, { data: rows }, 'Property picker fetched successfully', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

module.exports = { searchProperties, listPropertiesPicker };
