/**
 * ------------------------------------------------------------------
 * File: dashboard.controller.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * dashboard.routes
 * ------------------------------------------------------------------
 */

const dashboardService = require('../service/dashboard.service');

const getSummary = async (req, res, next) => {
  try {
    const { landlordId, startDate, endDate, preset } = req.query || {};
    const result = await dashboardService.getDashboardSummary({
      landlordId,
      startDate,
      endDate,
      preset,
      hoaContext: req.hoaContext || null,
      req,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
};

const getRecentActivity = async (req, res, next) => {
  try {
    const { landlordId, limit = 10, userRole, communityId, hoaId } = req.query || {};
    const queryCommunityId = communityId || hoaId || req.headers['x-hoa-id'];
    const hoaContext = req.hoaContext || null;

    if (hoaContext?.isHOABoardMember && queryCommunityId && hoaContext.hoaId && String(queryCommunityId).trim() !== String(hoaContext.hoaId).trim()) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to the requested HOA community',
        statuscode: 403,
      });
    }

    const effectiveCommunityId = hoaContext?.hoaId || queryCommunityId || null;
    
    // Use landlordId from query or fallback to authenticated user
    const effectiveLandlordId = landlordId || req.userId;
    
    const result = await dashboardService.getRecentActivity({ 
      landlordId: effectiveLandlordId, 
      limit: parseInt(limit),
      userRole,
      hoaContext,
      communityId: effectiveCommunityId,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  getSummary,
  getRecentActivity
};
