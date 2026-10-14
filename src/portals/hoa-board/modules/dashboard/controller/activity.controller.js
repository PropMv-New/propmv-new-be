/**
 * ------------------------------------------------------------------
 * File: activity.controller.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * activity.routes
 * ------------------------------------------------------------------
 */

const activityService = require('../service/activity.service');

const getRecentActivities = async (req, res) => {
  try {
    const userId = req.userId || req.user?._id || req.user?.id;
    const limit = parseInt(req.query.limit, 10) || 50;
    const page = parseInt(req.query.page, 10) || 1;
    const module = req.query.module;
    const performedBy = req.query.performedBy;
    const days = req.query.days !== undefined ? parseInt(req.query.days, 10) : 2;
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;

    const queryCommunityId = req.query.communityId || req.query.hoaId || req.headers['x-hoa-id'];
    const hoaContext = req.hoaContext || null;

    if (hoaContext?.isHOABoardMember && queryCommunityId && hoaContext.hoaId && String(queryCommunityId).trim() !== String(hoaContext.hoaId).trim()) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to the requested HOA community',
        statuscode: 403,
      });
    }

    const effectiveCommunityId = hoaContext?.hoaId || queryCommunityId || null;

    const activityUserId = hoaContext?.isHOABoardMember
      ? (req.query.userId || null)
      : (req.query.userId || userId);

    const result = await activityService.getRecentActivities({
      userId: activityUserId,
      limit,
      page,
      module,
      performedBy,
      userContext: hoaContext,
      communityId: effectiveCommunityId,
      days,
      startDate,
      endDate,
    });
    
    res.json({
      success: true,
      message: 'Recent activities retrieved successfully',
      statuscode: 200,
      data: result.data,
      pagination: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: Math.ceil(result.total / result.limit)
      },
      days: result.days
    });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ 
      success: false,
      message: err.message,
      statuscode: status
    });
  }
};

const logClientActivity = async (req, res) => {
  try {
    const userId = req.userId || req.user?._id || req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated',
        statuscode: 401,
      });
    }

    const { action, module, entityId, entityName, description, meta } = req.body || {};

    await activityService.logClientActivity({
      userId,
      action,
      module,
      entityId,
      entityName,
      description,
      meta,
      hoaContext: req.hoaContext || null,
    });

    res.json({
      success: true,
      message: 'Activity logged successfully',
      statuscode: 200,
      data: null,
    });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({
      success: false,
      message: err.message,
      statuscode: status,
    });
  }
};

module.exports = {
  getRecentActivities,
  logClientActivity,
};
