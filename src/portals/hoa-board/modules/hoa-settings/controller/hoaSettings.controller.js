/**
 * ------------------------------------------------------------------
 * File: hoaSettings.controller.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * hoaSettings.routes
 * ------------------------------------------------------------------
 */

const hoaSettingsService = require('../service/hoaSettings.service');
const responseHelper = require('../../../../../common/helpers/responseHelper');

const getSettings = async (req, res) => {
  try {
    const userId = req.userId || req.user?._id;
    const hoaIdParam = req.params.hoaId || null;
    const hoaContext = req.hoaContext || null;
    const data = await hoaSettingsService.getSettings(userId, hoaIdParam, hoaContext);
    return responseHelper.success(res, data, 'HOA settings fetched', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, 400);
  }
};

const upsertSettings = async (req, res) => {
  try {
    const userId = req.userId || req.user?._id;
    const hoaIdParam = req.params.hoaId || null;
    const hoaContext = req.hoaContext || null;
    const data = await hoaSettingsService.upsertSettings(userId, hoaIdParam, hoaContext, req.body);
    return responseHelper.success(res, data, 'HOA settings saved', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, 400);
  }
};

const getPaymentPolicy = async (req, res) => {
  try {
    const userId = req.userId || req.user?._id;
    const hoaIdParam = req.params.hoaId || null;
    const hoaContext = req.hoaContext || null;
    const data = await hoaSettingsService.getPaymentPolicy(userId, hoaIdParam, hoaContext);
    return responseHelper.success(res, data, 'HOA payment policy fetched', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, 400);
  }
};

module.exports = { getSettings, getPaymentPolicy, upsertSettings };
