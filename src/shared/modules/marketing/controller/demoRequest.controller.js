const logger = require('../../../../common/logger');
const { success, error } = require('../../../../common/helpers/responseHelper');
const { createDemoRequest, listDemoRequests } = require('../service/demoRequest.service');
const { notifyDemoRequestInBackground } = require('../service/demoRequestNotify.service');
const { buildHoaOnboardingReport } = require('../service/hoaOnboardingReport.service');
const { sendHoaOnboardingReportEmail } = require('../service/hoaOnboardingReportNotify.service');

async function submitDemoRequest(req, res) {
  try {
    const body = req.body || {};

    // Honeypot: the form renders `company` hidden and empty, so anything in it
    // came from a bot filling every field. Answer 201 anyway - telling a
    // scraper it was blocked just invites a retry with the field removed.
    if (body.company) {
      logger.warn('[Marketing] demo request rejected by honeypot');
      return success(res, {}, "Thanks! We'll be in touch shortly.", 201);
    }

    const doc = await createDemoRequest(body);

    // Email is not awaited: the lead is already saved, and a slow mail provider
    // must never turn a captured lead into a failed submission for the visitor.
    notifyDemoRequestInBackground(doc);

    return success(res, { id: String(doc._id) }, "Thanks! We'll be in touch shortly.", 201);
  } catch (err) {
    logger.error('[Marketing] submitDemoRequest failed:', err.message);
    return error(res, 'Could not submit your request. Please try again.', 500);
  }
}

async function getDemoRequests(req, res) {
  try {
    const result = await listDemoRequests(req.query || {});
    return success(res, result, 'Demo requests fetched');
  } catch (err) {
    logger.error('[Marketing] getDemoRequests failed:', err.message);
    return error(res, 'Failed to fetch demo requests', 500);
  }
}

async function getHoaOnboardingReport(req, res) {
  try {
    const report = await buildHoaOnboardingReport();
    return success(res, report, 'HOA onboarding report generated');
  } catch (err) {
    logger.error('[Marketing] getHoaOnboardingReport failed:', err.message);
    return error(res, 'Failed to generate HOA onboarding report', 500);
  }
}

async function sendHoaOnboardingReportNow(req, res) {
  try {
    const result = await sendHoaOnboardingReportEmail();
    return success(res, result, 'HOA onboarding report email triggered');
  } catch (err) {
    logger.error('[Marketing] sendHoaOnboardingReportNow failed:', err.message);
    return error(res, 'Failed to send HOA onboarding report email', 500);
  }
}

module.exports = {
  submitDemoRequest,
  getDemoRequests,
  getHoaOnboardingReport,
  sendHoaOnboardingReportNow,
};
