'use strict';

const logger = require('../../../../../common/logger');
const emailHelper = require('../../../../../common/helpers/emailHelper');
const { formatEmailDate } = require('../../../../../common/helpers/hoaBillingDates');
const { ClockService, DateUtil } = require('../../../../../common/date');
const reportingService = require('./hoaOnboardingReport.service');
const HoaOnboardingReportSnapshot = require('../model/hoaOnboardingReportSnapshot.model');

function reportRecipients() {
  return ['admin@propmv.com'];
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatHoaRowsForEmail(hoas = [], maxRows = 25) {
  return (hoas || []).slice(0, maxRows).map((hoa) => {
    const rawFullName =
      typeof hoa.createdBy === 'object' && hoa.createdBy?.fullName != null
        ? String(hoa.createdBy.fullName).trim()
        : '';
    const creatorEmail =
      typeof hoa.createdBy === 'object' && hoa.createdBy?.email
        ? String(hoa.createdBy.email).trim()
        : String(hoa.createdByEmail || '').trim();

    let displayName = rawFullName;
    if (!displayName) {
      const rawName =
        typeof hoa.createdBy === 'object' && hoa.createdBy?.name
          ? String(hoa.createdBy.name).trim()
          : String(hoa.createdByName || '').trim();
      if (
        rawName &&
        rawName.toLowerCase() !== creatorEmail.toLowerCase() &&
        rawName.toLowerCase() !== 'unknown' &&
        rawName.toLowerCase() !== 'unknown user'
      ) {
        displayName = rawName;
      }
    }

    const hasCreatorName = Boolean(displayName && displayName.length > 0);
    const hasCreatedByEmail = Boolean(creatorEmail && creatorEmail.length > 0);
    const creatorName = hasCreatorName ? displayName : (creatorEmail || 'Unknown');

    return {
      name: esc(hoa.name),
      createdAt: esc(hoa.createdAt ? formatEmailDate(hoa.createdAt) : ''),
      createdByName: esc(creatorName),
      hasCreatorName,
      createdByEmail: esc(creatorEmail),
      hasCreatedByEmail,
      hasCreatorInfo: hasCreatorName || hasCreatedByEmail,
      ownerCount: Number(hoa.ownerCount) || 0,
      propertyCount: Number(hoa.propertyCount) || 0,
      unitCount: Number(hoa.unitCount) || Number(hoa.propertyCount) || 0,
      status: esc(hoa.status || 'active'),
    };
  });
}

function resolveDashboardUrl() {
  const base =
    process.env.FRONTEND_URL ||
    process.env.APP_URL ||
    process.env.CLIENT_URL ||
    '';
  if (!base) return '';
  return `${base.replace(/\/+$/, '')}/admin/hoa-onboarding`;
}

function buildTemplateData(report) {
  const dailyHoas = formatHoaRowsForEmail(report.periods?.daily?.hoas, 25);
  const weeklyHoas = formatHoaRowsForEmail(report.periods?.weekly?.hoas, 15);
  const monthlyHoas = formatHoaRowsForEmail(report.periods?.monthly?.hoas, 15);
  const dashboardUrl = resolveDashboardUrl();

  return {
    reportDate: esc(report.reportDate),
    timeZone: esc(report.timeZone),
    dailyCount: report.summary?.daily || 0,
    weeklyCount: report.summary?.weekly || 0,
    monthlyCount: report.summary?.monthly || 0,
    dailyHoas,
    weeklyHoas,
    monthlyHoas,
    hasDailyHoas: dailyHoas.length > 0,
    hasWeeklyHoas: weeklyHoas.length > 0,
    hasMonthlyHoas: monthlyHoas.length > 0,
    dashboardUrl: esc(dashboardUrl),
    hasDashboardUrl: Boolean(dashboardUrl),
  };
}

// Guard against concurrent duplicate manual send requests (e.g. rapid double-clicks)
let isManualSendInProgress = false;

/**
 * Send the HOA onboarding report email.
 * - Automated scheduler (triggerSource='cron'): Enforces once-per-report-date idempotency.
 * - Manual trigger (triggerSource='manual'): Bypasses scheduler skip, sends exactly one email,
 *   preserves existing scheduled snapshot, and protects against concurrent duplicate clicks.
 */
async function sendHoaOnboardingReportEmail({
  referenceDate = ClockService.now(),
  triggerSource = 'cron',
  force = false,
} = {}) {
  const isManual = triggerSource === 'manual';
  const isCron = !isManual;

  if (isManual) {
    if (isManualSendInProgress) {
      const err = new Error('A manual report email send is already in progress. Please wait.');
      err.code = 'CONCURRENT_MANUAL_SEND';
      err.statusCode = 409;
      throw err;
    }
    isManualSendInProgress = true;
  }

  try {
    const recipients = reportRecipients();
    if (!recipients.length) {
      logger.warn('[HOA Onboarding Report] No recipients configured');
      return { sent: false, reason: 'no_recipients' };
    }

    const timeZone = reportingService.reportTimezone();
    const reportDate = DateUtil.getDateKeyInTimeZone(referenceDate, timeZone);

    // 1. Check existing snapshot (scheduler idempotency check)
    const existingSnapshot = await HoaOnboardingReportSnapshot.findOne({
      reportDate,
      period: 'daily',
    });

    if (isCron && existingSnapshot?.emailSent === true && !force) {
      logger.info('[HOA Onboarding Report] Daily report already sent for date; skipping duplicate send', {
        reportDate,
        emailSentAt: existingSnapshot.emailSentAt,
        triggerSource,
      });
      return {
        sent: false,
        alreadySent: true,
        reportDate,
        summary: existingSnapshot.summary,
        recipients: existingSnapshot.recipients,
      };
    }

    // 2. Fetch summary metrics to obtain window boundaries
    const summaryMetrics = await reportingService.getHoaOnboardingSummary(referenceDate);

    // 3. Atomically acquire/create pending snapshot
    const snapshot = await HoaOnboardingReportSnapshot.findOneAndUpdate(
      { reportDate, period: 'daily' },
      {
        $setOnInsert: {
          periodStart: summaryMetrics.periodStarts.daily,
          periodEnd: summaryMetrics.periodEnd,
          triggerSource,
          recipients,
          summary: {
            dailyCount: summaryMetrics.today,
            weeklyCount: summaryMetrics.thisWeek,
            monthlyCount: summaryMetrics.thisMonth,
          },
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Check again after atomic findOneAndUpdate in case of race condition (scheduler only)
    if (isCron && snapshot.emailSent === true && !force) {
      logger.info('[HOA Onboarding Report] Concurrent send completed by another process; skipping', {
        reportDate,
      });
      return {
        sent: false,
        alreadySent: true,
        reportDate,
        summary: snapshot.summary,
        recipients: snapshot.recipients,
      };
    }

    // 4. Generate report data
    const report = await reportingService.buildHoaOnboardingReport(referenceDate);
    const data = buildTemplateData(report);
    const subject =
      process.env.EMAIL_SUBJECT_HOA_ONBOARDING_REPORT ||
      `PropMv HOA Onboarding Report - ${report.reportDate}`;

    // 5. Send email via existing PropMv email helper
    const sendResult = await emailHelper.sendEmail(
      'hoa-onboarding-report',
      recipients.join(','),
      data,
      {
        subject,
        preheaderText: `Daily: ${data.dailyCount} · Weekly: ${data.weeklyCount} · Monthly: ${data.monthlyCount}`,
      }
    );

    if (sendResult === false) {
      logger.warn('[HOA Onboarding Report] Email delivery skipped by email configuration', {
        reportDate,
        recipients,
        triggerSource,
        reason: 'disabled_by_config',
      });
      return {
        sent: false,
        skipped: true,
        alreadySent: false,
        reason: 'disabled_by_config',
        reportDate,
        recipients,
        summary: report.summary,
        report,
      };
    }

    // 6. Persist snapshot updates without corrupting existing automated daily snapshot
    if (isManual) {
      await HoaOnboardingReportSnapshot.updateOne(
        { _id: snapshot._id },
        {
          $set: {
            lastManualSentAt: ClockService.now(),
            errorMessage: null,
          },
          $inc: {
            manualSendCount: 1,
          },
        }
      );
    } else {
      await HoaOnboardingReportSnapshot.updateOne(
        { _id: snapshot._id },
        {
          $set: {
            emailSent: true,
            emailSentAt: ClockService.now(),
            summary: {
              dailyCount: report.summary.daily,
              weeklyCount: report.summary.weekly,
              monthlyCount: report.summary.monthly,
            },
            recipients,
            errorMessage: null,
            triggerSource: 'cron',
          },
        }
      );
    }

    logger.info('[HOA Onboarding Report] Email sent successfully', {
      reportDate,
      recipients: recipients.length,
      daily: data.dailyCount,
      weekly: data.weeklyCount,
      monthly: data.monthlyCount,
      triggerSource,
    });

    return {
      sent: true,
      alreadySent: false,
      reportDate,
      recipients,
      summary: report.summary,
      report,
    };
  } catch (err) {
    if (err.statusCode !== 409 && err.code !== 'CONCURRENT_MANUAL_SEND') {
      try {
        const timeZone = reportingService.reportTimezone();
        const reportDate = DateUtil.getDateKeyInTimeZone(referenceDate, timeZone);
        await HoaOnboardingReportSnapshot.updateOne(
          { reportDate, period: 'daily' },
          { $set: { errorMessage: err.message } }
        );
      } catch (recordErr) {
        // preserve original error
      }

      logger.error('[HOA Onboarding Report] Failed to deliver report email', {
        error: err.message,
        triggerSource,
      });
    }

    throw err;
  } finally {
    if (isManual) {
      isManualSendInProgress = false;
    }
  }
}

module.exports = {
  sendHoaOnboardingReportEmail,
  buildTemplateData,
  reportRecipients,
  formatHoaRowsForEmail,
  resolveDashboardUrl,
};
