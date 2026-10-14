/**
 * ------------------------------------------------------------------
 * File: dashboard.controller.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * dashboard.routes
 * ------------------------------------------------------------------
 */

const dashboardService = require('../service/dashboard.service');
const { resolveCreatedBy } = require('../../../../../shared/utils/creatorScope.util');

const getSummary = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query || {};
    const createdBy = resolveCreatedBy(req.query || {}, req.user && (req.user._id || req.user.id));
    const result = await dashboardService.getDashboardSummary({ createdBy, startDate, endDate });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  getSummary
};
