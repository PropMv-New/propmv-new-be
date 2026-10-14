const logger = require('../../../../common/logger');
const { success, error } = require('../../../../common/helpers/responseHelper');
const {
  recordSiteVisit,
  getSiteVisitStats,
  listSiteVisits,
} = require('../service/siteVisit.service');

async function createSiteVisit(req, res) {
  try {
    const visit = await recordSiteVisit(req, req.body || {});
    return success(res, { id: visit._id }, 'Visit recorded', 201);
  } catch (err) {
    logger.error('[Marketing] createSiteVisit failed:', err.message);
    return error(res, err.message || 'Failed to record visit', 500);
  }
}

async function getVisitStats(req, res) {
  try {
    const stats = await getSiteVisitStats(req.query || {});
    return success(res, stats, 'Visitor stats fetched');
  } catch (err) {
    logger.error('[Marketing] getVisitStats failed:', err.message);
    return error(res, err.message || 'Failed to fetch visitor stats', 500);
  }
}

async function getVisitList(req, res) {
  try {
    const result = await listSiteVisits(req.query || {});
    return success(res, result, 'Visitor list fetched');
  } catch (err) {
    logger.error('[Marketing] getVisitList failed:', err.message);
    return error(res, err.message || 'Failed to fetch visitor list', 500);
  }
}

module.exports = {
  createSiteVisit,
  getVisitStats,
  getVisitList,
};
