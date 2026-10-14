/**
 * ------------------------------------------------------------------
 * File: damageReport.controller.js
 * Module: Maintenance Module
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * damageReport.routes
 * ------------------------------------------------------------------
 */

const responseHelper = require('../../../../common/helpers/responseHelper');
const damageReportService = require('../service/damageReport.service');
const logger = require('../../../../common/logger');

async function createDamageReport(req, res) {
  try {
    const data = req.body;
    const files = req.files || [];
    const userId = req.user?._id || req.user?.id;

    const report = await damageReportService.createDamageReport(data, files, { userId });
    return responseHelper.success(res, { report }, 'Damage report created', 201);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message || 'Failed to create damage report', status);
  }
}

async function getDamageReport(req, res) {
  try {
    logger.info('🔍 [DamageReportController] getDamageReport called with params:', req.params);
    logger.info('🔍 [DamageReportController] Request URL:', req.originalUrl);
    logger.info('🔍 [DamageReportController] Request method:', req.method);
    
    const report = await damageReportService.getDamageReportById(req.params.id);
    return responseHelper.success(res, { report }, 'Damage report fetched', 200);
  } catch (err) {
    logger.error(' [DamageReportController] Error in getDamageReport:', err.message);
    const status = err.status || 500;
    return responseHelper.error(res, err.message || 'Failed to fetch damage report', status);
  }
}

async function listDamageReports(req, res) {
  try {
    const result = await damageReportService.listDamageReports(req.query);
    return responseHelper.success(res, result, 'Damage reports fetched', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message || 'Failed to list damage reports', status);
  }
}

async function updateDamageReport(req, res) {
  try {
    const data = req.body;
    const files = req.files || [];
    const userId = req.user?._id || req.user?.id;

    const report = await damageReportService.updateDamageReport(req.params.id, data, files, { userId });
    return responseHelper.success(res, { report }, 'Damage report updated', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message || 'Failed to update damage report', status);
  }
}

async function deleteDamageReport(req, res) {
  try {
    await damageReportService.deleteDamageReport(req.params.id);
    return responseHelper.success(res, null, 'Damage report deleted', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message || 'Failed to delete damage report', status);
  }
}

module.exports = {
  createDamageReport,
  getDamageReport,
  listDamageReports,
  updateDamageReport,
  deleteDamageReport
};


