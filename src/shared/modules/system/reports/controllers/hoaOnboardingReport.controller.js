'use strict';

const logger = require('../../../../../common/logger');
const { success, error } = require('../../../../../common/helpers/responseHelper');
const reportingService = require('../service/hoaOnboardingReport.service');
const notifyService = require('../service/hoaOnboardingReportNotify.service');

/**
 * Fetch summary KPI metrics for HOA onboarding (today, this week, this month).
 */
async function getSummary(req, res) {
  try {
    const summary = await reportingService.getHoaOnboardingSummary();
    return success(res, summary, 'HOA onboarding report summary fetched');
  } catch (err) {
    logger.error('[HoaOnboardingReportController] getSummary failed', {
      error: err.message,
    });
    return error(res, 'Failed to fetch HOA onboarding summary', 500);
  }
}

/**
 * Fetch paginated, searchable, filterable list of onboarded HOAs.
 */
async function getHoas(req, res) {
  try {
    const result = await reportingService.listHoaOnboarding(req.query || {});
    return success(res, result, 'HOA onboarding list fetched');
  } catch (err) {
    logger.error('[HoaOnboardingReportController] getHoas failed', {
      error: err.message,
    });
    return error(res, 'Failed to fetch HOA onboarding records', 500);
  }
}

/**
 * Manually trigger daily HOA onboarding report email.
 * Explicit administrative action that immediately sends exactly one report email.
 * Uses server-side configured recipients only.
 */
async function sendEmailNow(req, res) {
  try {
    const force = req.body?.force === true;
    const result = await notifyService.sendHoaOnboardingReportEmail({
      triggerSource: 'manual',
      force,
    });

    if (!result || result.sent !== true) {
      const message =
        result?.skipped && result?.reason === 'disabled_by_config'
          ? 'HOA onboarding report email delivery was skipped (email sending is disabled by configuration).'
          : 'HOA onboarding report email delivery was not completed.';
      return error(res, message, 503, result);
    }

    return success(res, result, 'HOA onboarding report email sent successfully.');
  } catch (err) {
    if (err.statusCode === 409 || err.code === 'CONCURRENT_MANUAL_SEND') {
      return error(res, err.message, 409);
    }
    logger.error('[HoaOnboardingReportController] sendEmailNow failed', {
      error: err.message,
    });
    return error(res, 'Failed to send HOA onboarding report email', 500);
  }
}

module.exports = {
  getSummary,
  getHoas,
  sendEmailNow,
};
