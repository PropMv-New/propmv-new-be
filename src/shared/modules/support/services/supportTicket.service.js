const logger = require('../../../../common/logger');
/**
 * Support ticket orchestration:
 *   1. Send the ticket to the Google Apps Script Web App (team's sheet view)
 *   2. Email a notification to the support team
 *   3. Email an acknowledgment to the user
 *
 * Resilient by design: the Apps Script call is best-effort - if it fails we
 * log the error and continue, it never blocks the emails or fails the
 * request. The ticket is considered "received" once the team notification
 * email succeeds (that email is the system of record); the user
 * acknowledgment is best-effort on top.
 */
const { sendEmail, getEmailLogoAttachment } = require('../../../../common/helpers/emailHelper');
const { isAppsScriptConfigured, sendTicketToAppsScript } = require('./appsScript.service');

const SUPPORT_TEAM_EMAIL = process.env.SUPPORT_TEAM_EMAIL || 'support@propmv.com';

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Branded PropMv logo header, using the same shared CID logo asset as the
 * rest of the transactional emails. Returns the <img> HTML plus the
 * attachment to include on the message (empty if the asset is missing).
 */
function buildLogoHeader() {
  const attachment = getEmailLogoAttachment();
  if (!attachment) {
    return { html: '', attachments: [] };
  }
  const html = `
      <div style="margin: 0 0 20px 0;">
        <img src="cid:${attachment.cid}" alt="" width="100" style="display:block;width:100px;max-width:100px;height:auto;border:0;" />
      </div>`;
  return { html, attachments: [attachment] };
}

function buildAcknowledgmentHtml(ticket, logoHtml) {
  return `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 560px; margin: 0 auto; color: #1f2937;">
      ${logoHtml}
      <h2 style="color: #111827;">We've received your support request</h2>
      <p>Hi ${escapeHtml(ticket.name)},</p>
      <p>Thanks for reaching out to PropMv support. Our team has received your message and will get back to you as soon as possible.</p>
      <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin: 16px 0;">
        <p style="margin: 0 0 8px; font-size: 13px; color: #6b7280;">Your message:</p>
        <p style="margin: 0; white-space: pre-wrap;">${escapeHtml(ticket.message)}</p>
      </div>
      <p>If you need to add anything, just reply to this email.</p>
      <p style="margin-top: 24px;">- The PropMv Support Team</p>
    </div>
  `;
}

function buildTeamNotificationHtml(ticket, logoHtml) {
  return `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 560px; margin: 0 auto; color: #1f2937;">
      ${logoHtml}
      <h2 style="color: #111827;">New support request</h2>
      <table style="border-collapse: collapse; width: 100%;" cellpadding="8">
        <tr><td style="border: 1px solid #e5e7eb; font-weight: bold; width: 120px;">Topic</td><td style="border: 1px solid #e5e7eb;">${escapeHtml(ticket.topic || '-')}</td></tr>
        <tr><td style="border: 1px solid #e5e7eb; font-weight: bold;">Name</td><td style="border: 1px solid #e5e7eb;">${escapeHtml(ticket.name)}</td></tr>
        <tr><td style="border: 1px solid #e5e7eb; font-weight: bold;">Email</td><td style="border: 1px solid #e5e7eb;">${escapeHtml(ticket.email)}</td></tr>
        <tr><td style="border: 1px solid #e5e7eb; font-weight: bold;">Phone</td><td style="border: 1px solid #e5e7eb;">${escapeHtml(ticket.phone || '-')}</td></tr>
        <tr><td style="border: 1px solid #e5e7eb; font-weight: bold;">Role</td><td style="border: 1px solid #e5e7eb;">${escapeHtml(ticket.role || '-')}</td></tr>
        <tr><td style="border: 1px solid #e5e7eb; font-weight: bold;">Submitted</td><td style="border: 1px solid #e5e7eb;">${escapeHtml(ticket.timestamp)}</td></tr>
      </table>
      <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin: 16px 0;">
        <p style="margin: 0 0 8px; font-size: 13px; color: #6b7280;">Message:</p>
        <p style="margin: 0; white-space: pre-wrap;">${escapeHtml(ticket.message)}</p>
      </div>
      <p style="font-size: 13px; color: #6b7280;">Reply directly to this email to answer the user.</p>
    </div>
  `;
}

function sendTeamNotification(ticket) {
  const logo = buildLogoHeader();
  return sendEmail({
    to: SUPPORT_TEAM_EMAIL,
    subject: `[Support]${ticket.topic ? ` ${ticket.topic} -` : ''} New request from ${ticket.name} (${ticket.role || 'user'})`,
    html: buildTeamNotificationHtml(ticket, logo.html),
    attachments: logo.attachments,
  });
}

function sendUserAcknowledgment(ticket) {
  const logo = buildLogoHeader();
  return sendEmail({
    to: ticket.email,
    subject: 'We received your support request - PropMv',
    html: buildAcknowledgmentHtml(ticket, logo.html),
    attachments: logo.attachments,
  });
}

async function submitSupportTicket(ticket) {
  // 1. Google Sheet via Apps Script - strictly best-effort. A failure is
  //    logged and never blocks the emails or fails the support request.
  let sheetRecorded = false;
  if (isAppsScriptConfigured()) {
    try {
      await sendTicketToAppsScript(ticket);
      sheetRecorded = true;
    } catch (err) {
      logger.error('[Support] Apps Script request failed:', err.message);
    }
  } else {
    logger.warn('[Support] GOOGLE_APPS_SCRIPT_URL not configured - skipping sheet append');
  }

  // 2. Team notification is the system of record - it must succeed before we
  //    tell the user their request was received.
  try {
    await sendTeamNotification(ticket);
  } catch (err) {
    logger.error('[Support] Team notification email failed:', err.message);
    if (!sheetRecorded) {
      throw new Error('Could not record your request. Please try again or email support directly.');
    }
  }

  // 3. User acknowledgment - best-effort; the in-app confirmation still shows.
  sendUserAcknowledgment(ticket).catch((err) =>
    logger.error('[Support] Acknowledgment email failed:', err.message)
  );

  return { sheet: sheetRecorded };
}

module.exports = { submitSupportTicket, SUPPORT_TEAM_EMAIL };
