/**
 * ------------------------------------------------------------------
 * File: tenantScreeningSettings.controller.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * tenantScreeningSettings.routes
 * ------------------------------------------------------------------
 */

const tenantScreeningSettingsService = require('../service/tenantScreeningSettings.service');
const responseHelper = require('../../../../../common/helpers/responseHelper');

/**
 * Create new screening settings
 * POST /api/v1/landlord/tenant-screening-settings
 */
const createScreeningSettings = async (req, res) => {
  try {
    const body = req.body || {};
    const createdBy = req.user && (req.user._id || req.user.id);

    if (!createdBy) {
      return responseHelper.error(res, 'User authentication required', 401);
    }

    const result = await tenantScreeningSettingsService.createScreeningSettings(body, createdBy);

    return responseHelper.success(
      res,
      result,
      'Screening settings created successfully',
      201
    );
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

/**
 * Get screening settings by ID (public access for URLs, with expiration check)
 * GET /api/v1/landlord/tenant-screening-settings/:id
 */
const getScreeningSettingsById = async (req, res) => {
  try {
    const settingsId = req.params && req.params.id;

    const result = await tenantScreeningSettingsService.getScreeningSettingsById(settingsId);

    return responseHelper.success(
      res,
      result,
      'Screening settings retrieved successfully',
      200
    );
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

/**
 * Get screening settings by creator (authenticated)
 * GET /api/v1/landlord/tenant-screening-settings
 */
const getScreeningSettingsByCreator = async (req, res) => {
  try {
    const createdBy = req.user && (req.user._id || req.user.id);
    const filters = req.query || {};

    if (!createdBy) {
      return responseHelper.error(res, 'User authentication required', 401);
    }

    const result = await tenantScreeningSettingsService.getScreeningSettingsByCreator(
      createdBy,
      filters
    );

    return responseHelper.success(
      res,
      result,
      'Screening settings retrieved successfully',
      200
    );
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

/**
 * Update screening settings (authenticated)
 * PUT /api/v1/landlord/tenant-screening-settings/:id
 */
const updateScreeningSettings = async (req, res) => {
  try {
    const settingsId = req.params && req.params.id;
    const body = req.body || {};
    const createdBy = req.user && (req.user._id || req.user.id);

    if (!createdBy) {
      return responseHelper.error(res, 'User authentication required', 401);
    }

    const result = await tenantScreeningSettingsService.updateScreeningSettings(
      settingsId,
      body,
      createdBy
    );

    return responseHelper.success(
      res,
      result,
      'Screening settings updated successfully',
      200
    );
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

/**
 * Delete screening settings (authenticated)
 * DELETE /api/v1/landlord/tenant-screening-settings/:id
 */
const deleteScreeningSettings = async (req, res) => {
  try {
    const settingsId = req.params && req.params.id;
    const createdBy = req.user && (req.user._id || req.user.id);

    if (!createdBy) {
      return responseHelper.error(res, 'User authentication required', 401);
    }

    const result = await tenantScreeningSettingsService.deleteScreeningSettings(
      settingsId,
      createdBy
    );

    return responseHelper.success(
      res,
      result,
      'Screening settings deleted successfully',
      200
    );
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

module.exports = {
  createScreeningSettings,
  getScreeningSettingsById,
  getScreeningSettingsByCreator,
  updateScreeningSettings,
  deleteScreeningSettings,
};
