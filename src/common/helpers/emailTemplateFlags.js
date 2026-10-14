'use strict';

/**
 * Per-template email enable/disable via environment variables.
 *
 * Master switch:
 *   EMAIL_SENDING_ENABLED=true|false|on|off|1|0|yes|no  (default: true)
 *
 * Per template (unset = enabled):
 *   EMAIL_TEMPLATE_<SLUG>_ENABLED
 *   where SLUG is the template name uppercased with hyphens → underscores
 *   e.g. invoice-due-today → EMAIL_TEMPLATE_INVOICE_DUE_TODAY_ENABLED
 *
 * Accepted values (case-insensitive): true/false, on/off, 1/0, yes/no.
 *
 * Unknown / blank template names use EMAIL_TEMPLATE_DEFAULT_ENABLED (default true).
 * User-composed Email-tab sends (no template) only respect EMAIL_SENDING_ENABLED.
 */

/** All known HTML system templates (hoa owner, board, landlord, shared auth, marketing). */
const KNOWN_EMAIL_TEMPLATES = Object.freeze([
  // Auth / shared
  'welcome',
  'mfa-otp',
  'email-verification',
  'forgot-password',
  // HOA owner - recurring
  'invoice-due-today',
  'invoice-overdue',
  'invoice-schedule-summary',
  'late-fee-notification',
  // HOA owner - one-time
  'invite',
  'unit-assignment',
  'owner-removal-notice',
  'invoice-created',
  'payment-reminder',
  'payment-recorded',
  'payment-deleted',
  'invoice-updated',
  'invoice-balance-waived',
  'maintenance-ticket-created',
  'maintenance-ticket-assigned',
  'maintenance-ticket-updated',
  'maintenance-ticket-resolved',
  'hoa-document-uploaded',
  // HOA board - one-time
  'hoa-board-invite',
  'payment-received',
  'maintenance-request-created-landlord',
  'hoa-board-access-removed',
  // Ownership / ledger extras (not always listed in role docs)
  'ownership-change-scheduled',
  'ownership-change-effective',
  'unit-credit-expense-notice',
  'payment-failed',
  'late-fee-invoice-notification',
  // Maintenance extras
  'maintenance-ticket-notification',
  'maintenance-request-created-tenant',
  'action-update',
  'note-reminder',
  // Landlord / leasing / marketing
  'invoice-template',
  'screening-application',
  'application-accepted',
  'coming-soon-launch',
  'coming-soon-subscription',
  'demo-request-acknowledgement',
  'demo-request-team-notification',
]);

function envBool(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeTemplateName(templateName) {
  return String(templateName || '')
    .trim()
    .toLowerCase()
    .replace(/\.html$/i, '');
}

/**
 * @param {string} templateName e.g. "invoice-due-today"
 * @returns {string|null} e.g. "EMAIL_TEMPLATE_INVOICE_DUE_TODAY_ENABLED"
 */
function templateEnvKey(templateName) {
  const slug = normalizeTemplateName(templateName).replace(/-/g, '_');
  if (!slug) return null;
  return `EMAIL_TEMPLATE_${slug.toUpperCase()}_ENABLED`;
}

/**
 * Whether system email sending is globally allowed.
 */
function isEmailSendingEnabled(env = process.env) {
  return envBool('EMAIL_SENDING_ENABLED', true, env);
}

/**
 * Whether a specific template may be sent.
 * @param {string} [templateName]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isEmailTemplateEnabled(templateName, env = process.env) {
  if (!isEmailSendingEnabled(env)) return false;

  const normalized = normalizeTemplateName(templateName);
  if (!normalized) {
    return envBool('EMAIL_TEMPLATE_DEFAULT_ENABLED', true, env);
  }

  const key = templateEnvKey(normalized);
  return envBool(key, true, env);
}

/**
 * Snapshot of known templates and their current enable state (for ops / diagnostics).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ sendingEnabled: boolean, templates: Array<{ template: string, envKey: string, enabled: boolean }> }}
 */
function getEmailTemplateFlagsStatus(env = process.env) {
  const sendingEnabled = isEmailSendingEnabled(env);
  return {
    sendingEnabled,
    templates: KNOWN_EMAIL_TEMPLATES.map((template) => {
      const envKey = templateEnvKey(template);
      return {
        template,
        envKey,
        enabled: sendingEnabled && envBool(envKey, true, env),
      };
    }),
  };
}

module.exports = {
  KNOWN_EMAIL_TEMPLATES,
  envBool,
  templateEnvKey,
  normalizeTemplateName,
  isEmailSendingEnabled,
  isEmailTemplateEnabled,
  getEmailTemplateFlagsStatus,
};
