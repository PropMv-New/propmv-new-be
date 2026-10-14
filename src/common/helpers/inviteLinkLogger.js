'use strict';

const logger = require('../logger');
const { envBool, isEmailSendingEnabled, isEmailTemplateEnabled } = require('./emailTemplateFlags');

/**
 * Whether to print invitation / verification URLs to server logs for manual testing
 * (e.g. when SMTP or template sending is disabled).
 */
function shouldLogInviteUrl(templateName, env = process.env) {
  if (envBool('LOG_INVITE_URLS', false, env)) return true;
  if (!isEmailSendingEnabled(env)) return true;
  if (templateName && !isEmailTemplateEnabled(templateName, env)) return true;
  const nodeEnv = String(env.NODE_ENV || '').toLowerCase();
  if (nodeEnv && nodeEnv !== 'production') return true;
  return false;
}

/**
 * Log a copy-paste invite / verification URL for local or email-disabled environments.
 *
 * @param {object} params
 * @param {string} params.kind - Short label, e.g. "HOA Owner Verification"
 * @param {string} params.email - Recipient email
 * @param {string} params.url - Full URL
 * @param {string} [params.template] - Email template slug (invite, hoa-board-invite, …)
 * @param {Record<string, string|number|null|undefined>} [params.meta] - Extra lines (hoa, expires, userId, …)
 */
function logInviteUrl({ kind, email, url, template, meta = {} }) {
  if (!url || !shouldLogInviteUrl(template)) return;

  const emailDisabled =
    !isEmailSendingEnabled() || (template ? !isEmailTemplateEnabled(template) : false);

  logger.warn('================================================');
  logger.warn(`[Invite] ${kind} - copy this link to complete verification`);
  logger.warn(`[Invite] email   : ${email || '(unknown)'}`);
  logger.warn(`[Invite] url     : ${url}`);
  if (template) logger.warn(`[Invite] template: ${template}`);
  if (emailDisabled) {
    logger.warn('[Invite] note    : email sending is disabled by config; use the URL above manually');
  }
  Object.entries(meta).forEach(([key, value]) => {
    if (value != null && String(value).trim() !== '') {
      logger.warn(`[Invite] ${key.padEnd(8)}: ${value}`);
    }
  });
  logger.warn('================================================');
}

module.exports = {
  shouldLogInviteUrl,
  logInviteUrl,
};
