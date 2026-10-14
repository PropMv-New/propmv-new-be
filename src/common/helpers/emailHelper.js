/**
 * ------------------------------------------------------------------
 * File: emailHelper.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for emailHelper.
 *
 * Used By:
 * test-lease-onboarding-emails, invoiceNotificationEmailHelper, maintenanceEmailHelper, maintenanceNotificationEmailQueue
 * ------------------------------------------------------------------
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const dns = require('dns');
const juice = require('juice').default;
const { ClockService, DateUtil } = require('../date');
const { COMPANY_INFO } = require('../constants/company');
const { EMAIL_STATUS } = require('../constants/emailStatus');
const { EMAIL_ORIGIN } = require('../constants/emailOrigin');
const { persistEmailLog, normalizeAddressList } = require('./emailLog.helper');
const smtpDeliveryService = require('./smtpDelivery.service');
const logger = require('../logger');
const { classifySmtpError } = smtpDeliveryService;
const {
  assertEmailCanReceive,
  INVALID_RECIPIENT_MESSAGE,
} = require('./emailRecipientValidation.service');
const { formatMfaActionLabel } = require('./emailDisplayHelper');
const { applyCommunityEnvelope } = require('./communityEmailContext.service');
const {
  isEmailSendingEnabled,
  isEmailTemplateEnabled,
  getEmailTemplateFlagsStatus,
} = require('./emailTemplateFlags');

/** Kept for backward-compatible exports; system emails no longer auto-CC support. */
const SYSTEM_EMAIL_CC = (
  process.env.SYSTEM_EMAIL_CC ||
  process.env.SUPPORT_EMAIL ||
  COMPANY_INFO.SUPPORT_EMAIL ||
  'support@propmv.com'
).trim();

// Prefer IPv4 and avoid flaky dual-stack / temporary DNS resolution failures on Windows
try {
  if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
  }
} catch {
  // ignore
}

/**
 * Send mail via SmtpDeliveryService (primary retries → secondary failover).
 * Signature kept for callers that previously passed retries/baseDelayMs (ignored; use env).
 */
async function sendMailWithRetry(mailOptions) {
  return smtpDeliveryService.sendMail(mailOptions);
}

function firstRecipientAddress(to) {
  if (!to) return '';
  if (Array.isArray(to)) {
    const first = to[0];
    if (!first) return '';
    return typeof first === 'string' ? first : first.address || '';
  }
  if (typeof to === 'object' && to.address) return to.address;
  const raw = String(to).trim();
  const match = raw.match(/<([^>]+)>/);
  return match ? match[1].trim() : raw.split(',')[0].trim();
}

/**
 * Pre-SMTP gate: syntax check only for system emails.
 * MX, suppression, and RCPT probes are skipped for all system-sent emails
 * because recipients are already trusted (registered users, invited tenants, etc.).
 * Full validation is only applied when skipRecipientValidation is explicitly false
 * AND the caller opts in via options.runFullValidation = true.
 */
async function assertRecipientBeforeSend(to, options = {}) {
  if (options.skipRecipientValidation) return null;
  const address = firstRecipientAddress(to);
  if (!address) {
    const err = new Error('Email recipient is required');
    err.status = 400;
    err.isEmailValidationError = true;
    throw err;
  }
  // Only run full validation (MX, suppression, RCPT probe) when explicitly requested.
  // System emails (OTP, invites, invoices, etc.) skip this to prevent false rejections.
  if (!options.runFullValidation) return null;
  return assertEmailCanReceive(address, {
    context: options.validationContext || options.template || options.type || 'sendEmail',
    metadata: options.validationMetadata || null,
  });
}

function buildCommunityEmailContext(options = {}, data = {}) {
  return {
    hoaId: options.hoaId || data.hoaId || null,
    communityName:
      options.communityName ||
      data.communityName ||
      data.hoaName ||
      null,
    senderUserId:
      options.senderUserId ||
      options.userId ||
      data.senderUserId ||
      null,
    replyTo: options.replyTo || null,
    fromName: options.fromName || null,
  };
}

async function finalizeMailOptions(mailOptions, communityContext) {
  return applyCommunityEnvelope(mailOptions, communityContext);
}

function clientSafeSendError(error) {
  if (error?.isEmailValidationError) {
    return error;
  }
  if (classifySmtpError(error) === 'permanent') {
    const err = new Error(INVALID_RECIPIENT_MESSAGE);
    err.status = 400;
    err.isEmailValidationError = true;
    err.code = 'EMAIL_PERMANENT_BOUNCE';
    err.field = 'email';
    return err;
  }
  return new Error(
    "We're having trouble sending your email right now. Please try again shortly."
  );
}

// Templates directory
const TEMPLATES_DIR = path.join(__dirname, '../', 'email-templates');
const EMAIL_THEME_MARKER = '<!-- PMV_EMAIL_THEME -->';
const BRAND_HEADER_MARKER = '<!-- PMV_EMAIL_BRAND_HEADER -->';
const BRAND_FOOTER_MARKER = '<!-- PMV_EMAIL_BRAND_FOOTER -->';
let cachedEmailThemeStyles = null;
let cachedBrandHeader = null;
let cachedBrandFooter = null;
let cachedLogoDataUri = null;

const EMAIL_LOGO_CID = 'propmv-logo@propmv';
const LOGO_ASSET_PATH = path.join(__dirname, '../email-templates/assets/logo-email.png');
const LOGO_ASSET_FALLBACK_PATH = path.join(__dirname, '../email-templates/assets/logo.png');

/**
 * resolve Logo Asset Path
 *
 * Performs logic operations for resolveLogoAssetPath.
 *
 * @returns Operations result
 */
function resolveLogoAssetPath() {
  if (fsSync.existsSync(LOGO_ASSET_PATH)) return LOGO_ASSET_PATH;
  if (fsSync.existsSync(LOGO_ASSET_FALLBACK_PATH)) return LOGO_ASSET_FALLBACK_PATH;
  return null;
}

/**
 * should Use External Logo Url
 *
 * Performs logic operations for shouldUseExternalLogoUrl.
 *
 * @returns Operations result
 */
function shouldUseExternalLogoUrl() {
  const url = process.env.EMAIL_LOGO_URL;
  if (!url || !String(url).trim()) return false;
  try {
    const parsed = new URL(String(url).trim());
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return false;
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^100\./.test(host)) return false;
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

async function getLogoDataUri() {
  if (cachedLogoDataUri) return cachedLogoDataUri;
  const assetPath = resolveLogoAssetPath();
  if (!assetPath) {
    logger.warn('[Email] Logo asset missing; inline logo disabled.');
    cachedLogoDataUri = '';
    return cachedLogoDataUri;
  }
  try {
    const buffer = await fs.readFile(assetPath);
    cachedLogoDataUri = `data:image/png;base64,${buffer.toString('base64')}`;
  } catch (err) {
    logger.warn('[Email] Failed to read logo asset:', err.message);
    cachedLogoDataUri = '';
  }
  return cachedLogoDataUri;
}

/**
 * get Email Logo Attachment
 *
 * Performs logic operations for getEmailLogoAttachment.
 *
 * @returns Operations result
 */
function getEmailLogoAttachment() {
  const assetPath = resolveLogoAssetPath();
  if (!assetPath) return null;
  return {
    filename: 'propmv-logo.png',
    path: assetPath,
    cid: EMAIL_LOGO_CID,
  };
}

/**
 * Resolve logo src for email HTML.
 * - Sends: inline CID attachment (works without public hosting)
 * - Previews: base64 data URI
 * - Override: EMAIL_LOGO_URL when set to a reachable public URL
 */
async function resolveLogoSrc(mode = 'send') {
  if (shouldUseExternalLogoUrl()) {
    return String(process.env.EMAIL_LOGO_URL).trim();
  }
  if (mode === 'preview') {
    return (await getLogoDataUri()) || '';
  }
  return resolveLogoAssetPath() ? `cid:${EMAIL_LOGO_CID}` : '';
}

/** @deprecated Use resolveLogoSrc() - kept for backwards compatibility */
function getEmailLogoUrl() {
  if (shouldUseExternalLogoUrl()) return String(process.env.EMAIL_LOGO_URL).trim();
  return resolveLogoAssetPath() ? `cid:${EMAIL_LOGO_CID}` : '';
}

async function getEmailThemeStyles() {
  if (cachedEmailThemeStyles) return cachedEmailThemeStyles;
  const themePath = path.join(TEMPLATES_DIR, '_pmv-theme-styles.html');
  try {
    cachedEmailThemeStyles = await fs.readFile(themePath, 'utf8');
  } catch (err) {
    logger.warn('[Email] Theme styles file missing; emails will use template-local styles only.');
    cachedEmailThemeStyles = '';
  }
  return cachedEmailThemeStyles;
}

async function getBrandHeaderPartial() {
  if (cachedBrandHeader) return cachedBrandHeader;
  const headerPath = path.join(TEMPLATES_DIR, '_pmv-brand-header.html');
  try {
    cachedBrandHeader = await fs.readFile(headerPath, 'utf8');
  } catch (err) {
    logger.warn('[Email] Brand header partial missing.');
    cachedBrandHeader = '';
  }
  return cachedBrandHeader;
}

async function getBrandFooterPartial() {
  if (cachedBrandFooter) return cachedBrandFooter;
  const footerPath = path.join(TEMPLATES_DIR, '_pmv-brand-footer.html');
  try {
    cachedBrandFooter = await fs.readFile(footerPath, 'utf8');
  } catch (err) {
    logger.warn('[Email] Brand footer partial missing.');
    cachedBrandFooter = '';
  }
  return cachedBrandFooter;
}

/**
 * inject Marker
 *
 * Performs logic operations for injectMarker.
 *
 * @param html - Request/input argument
 * @param marker - Request/input argument
 * @param content - Request/input argument
 * @returns Operations result
 */
function injectMarker(html, marker, content) {
  if (!html || !marker || !html.includes(marker)) return html;
  return html.replace(marker, content || '');
}

/**
 * inject Email Theme
 *
 * Performs logic operations for injectEmailTheme.
 *
 * @param html - Request/input argument
 * @returns Operations result
 */
function injectEmailTheme(html) {
  return injectMarker(html, EMAIL_THEME_MARKER, cachedEmailThemeStyles || '');
}

/**
 * inject Brand Partials
 *
 * Performs logic operations for injectBrandPartials.
 *
 * @param html - Request/input argument
 * @returns Operations result
 */
function injectBrandPartials(html) {
  let rendered = injectMarker(html, BRAND_HEADER_MARKER, cachedBrandHeader || '');
  rendered = injectMarker(rendered, BRAND_FOOTER_MARKER, cachedBrandFooter || '');
  return rendered;
}

const PREHEADER_SPAN_RE = /<span\s+class="pmv-preheader"[^>]*>([\s\S]*?)<\/span>/i;
const PREHEADER_INLINE_DIV_RE = /<div[^>]*class="pmv-preheader-inline"[^>]*>[\s\S]*?<\/div>/i;

/**
 * decode Basic Html Entities
 *
 * Performs logic operations for decodeBasicHtmlEntities.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function decodeBasicHtmlEntities(value = '') {
  return String(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&rsquo;/gi, '\u2019')
    .replace(/&lsquo;/gi, '\u2018')
    .replace(/&rdquo;/gi, '\u201D')
    .replace(/&ldquo;/gi, '\u201C')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * strip Tags
 *
 * Performs logic operations for stripTags.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function stripTags(value = '') {
  return String(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * strip Html For Plain Text
 *
 * Performs logic operations for stripHtmlForPlainText.
 *
 * @param html - Request/input argument
 * @returns Operations result
 */
function stripHtmlForPlainText(html) {
  return String(html)
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<span\s+class="pmv-preheader"[^>]*>[\s\S]*?<\/span>/gi, ' ')
    .replace(/<div[^>]*class="pmv-preheader-inline"[^>]*>[\s\S]*?<\/div>/gi, ' ')
    .replace(/<div[^>]*aria-hidden="true"[^>]*style="[^\"]*display\s*:\s*none[^\"]*"[^>]*>[\s\S]*?<\/div>/gi, ' ')
    .replace(/<div[^>]*style="[^\"]*display\s*:\s*none[^\"]*"[^>]*>[\s\S]*?<\/div>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ');
}

/**
 * extract Html Body
 *
 * Performs logic operations for extractHtmlBody.
 *
 * @param html - Request/input argument
 * @returns Operations result
 */
function extractHtmlBody(html) {
  const bodyMatch = String(html).match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return bodyMatch ? bodyMatch[1] : String(html);
}

/**
 * extract Preheader Text
 *
 * Performs logic operations for extractPreheaderText.
 *
 * @param html - Request/input argument
 * @param explicitPreheader - Request/input argument
 * @returns Operations result
 */
function extractPreheaderText(html, explicitPreheader = '') {
  const explicit = decodeBasicHtmlEntities(stripTags(explicitPreheader));
  if (explicit) return explicit;

  const spanMatch = String(html).match(PREHEADER_SPAN_RE);
  if (spanMatch) return decodeBasicHtmlEntities(stripTags(spanMatch[1]));

  const inlineMatch = String(html).match(
    /<div[^>]*class="pmv-preheader-inline"[^>]*>([\s\S]*?)<\/div>/i
  );
  if (inlineMatch) return decodeBasicHtmlEntities(stripTags(inlineMatch[1]));

  return '';
}

/**
 * strip Email Unsafe Css Rules
 *
 * Performs logic operations for stripEmailUnsafeCssRules.
 *
 * @param css - Request/input argument
 * @returns Operations result
 */
function stripEmailUnsafeCssRules(css) {
  return String(css)
    .replace(/:root\s*\{[^}]*\}/gi, '')
    .replace(/supported-color-schemes\s*:[^;]+;?/gi, '')
    .replace(/color-scheme\s*:[^;]+;?/gi, '');
}

/**
 * strip Css Comments From Style Blocks
 *
 * Performs logic operations for stripCssCommentsFromStyleBlocks.
 *
 * @param html - Request/input argument
 * @returns Operations result
 */
function stripCssCommentsFromStyleBlocks(html) {
  return String(html).replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (full, attrs, css) => {
    const cleaned = stripEmailUnsafeCssRules(css.replace(/\/\*[\s\S]*?\*\//g, ''));
    return `<style${attrs}>${cleaned}</style>`;
  });
}

/**
 * Gmail and many clients ignore class-based rules in <style> blocks.
 * Inline critical theme CSS so cards, accents, OTP boxes, and CTAs render correctly.
 */
function inlineEmailStyles(html) {
  if (!html || !/<style[^>]*>[\s\S]*?<\/style>/i.test(html)) return html;

  try {
    return juice(String(html), {
      removeStyleTags: true,
      applyWidthAttributes: true,
      applyHeightAttributes: true,
    });
  } catch (err) {
    logger.warn('[Email] CSS inlining failed; sending with head styles only:', err.message);
    return html;
  }
}

/**
 * strip Style Tags From Html
 *
 * Performs logic operations for stripStyleTagsFromHtml.
 *
 * @param html - Request/input argument
 * @returns Operations result
 */
function stripStyleTagsFromHtml(html) {
  return String(html).replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
}

/**
 * strip Color Scheme Meta Tags
 *
 * Performs logic operations for stripColorSchemeMetaTags.
 *
 * @param html - Request/input argument
 * @returns Operations result
 */
function stripColorSchemeMetaTags(html) {
  return String(html)
    .replace(/<meta[^>]+name=["']color-scheme["'][^>]*>/gi, '')
    .replace(/<meta[^>]+name=["']supported-color-schemes["'][^>]*>/gi, '');
}

/**
 * build Hidden Preheader Markup
 *
 * Performs logic operations for buildHiddenPreheaderMarkup.
 *
 * @param preheaderText - Request/input argument
 * @returns Operations result
 */
function buildHiddenPreheaderMarkup(preheaderText) {
  const text = decodeBasicHtmlEntities(stripTags(preheaderText));
  if (!text) return '';

  // Avoid display:none on the first body node - Gmail can hide the entire message body.
  // Do not append zero-width HTML entities (&zwnj;, &shy;, etc.) - Gmail shows them in inbox previews.
  return (
    `<div class="pmv-preheader-inline" style="max-height:0;overflow:hidden;mso-hide:all;opacity:0;color:#ffffff;font-size:1px;line-height:1px;">${text}</div>`
  );
}

/**
 * Gmail/Outlook inbox previews read the first visible text in the HTML.
 * Ensure a hidden inline preheader is the first body child and strip CSS comments
 * that can leak into snippets when clients ignore <style>-based hiding.
 */
function finalizeRenderedEmailHtml(html, { preheaderText = '' } = {}) {
  if (!html) return html;

  let result = stripCssCommentsFromStyleBlocks(html);
  const preheader = extractPreheaderText(result, preheaderText);
  result = result.replace(PREHEADER_SPAN_RE, '');
  result = result.replace(PREHEADER_INLINE_DIV_RE, '');
  result = result.replace(
    /<div[^>]*aria-hidden="true"[^>]*style="[^"]*display\s*:\s*none[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
    ''
  );

  result = inlineEmailStyles(result);
  result = stripStyleTagsFromHtml(result);
  result = stripColorSchemeMetaTags(result);

  const hiddenPreheader = buildHiddenPreheaderMarkup(preheader);
  if (hiddenPreheader) {
    const shellTableMatch = result.match(/(<table[^>]*class="[^"]*pmv-shell[^"]*"[^>]*>)/i);
    if (shellTableMatch && shellTableMatch.index != null) {
      result =
        result.slice(0, shellTableMatch.index) +
        hiddenPreheader +
        result.slice(shellTableMatch.index);
    } else if (/<body[^>]*>/i.test(result)) {
      result = result.replace(/(<body[^>]*>)/i, `$1\n${hiddenPreheader}\n`);
    } else {
      result = `${hiddenPreheader}\n${result}`;
    }
  }

  return result;
}

function currentYearInAppTimezone() {
  const key = DateUtil.toEST(ClockService.now());
  return key ? key.slice(0, 4) : String(ClockService.now().getUTCFullYear());
}

function prepareInvoiceScheduleSummaryTemplateData(data = {}) {
  const isNextYear = Boolean(data.isNextYear);
  const showOwnerColumn = Boolean(data.showOwnerColumn);
  const invoiceYear = String(data.invoiceYear || '').trim();
  const invoiceCount = Number.parseInt(String(data.invoiceCount ?? ''), 10);
  const resolvedCount = Number.isFinite(invoiceCount) && invoiceCount > 0
    ? invoiceCount
    : (Array.isArray(data.invoiceRows) ? data.invoiceRows.length : 0);
  const hasMultipleInvoices = resolvedCount > 1 || Boolean(data.hasMultipleInvoices);
  const totalAmountDue = data.totalAmountDue || '$0.00';
  const pluralSuffix = hasMultipleInvoices ? 's' : '';

  let documentTitle = String(data.emailHeadline || '').trim();
  if (!documentTitle) {
    if (isNextYear) {
      documentTitle = showOwnerColumn
        ? 'Next-Year HOA Invoices Created'
        : (hasMultipleInvoices
          ? 'Your Next-Year HOA Invoices Have Been Created'
          : 'Your Next-Year HOA Invoice Has Been Created');
    } else {
      documentTitle = invoiceYear ? `Invoices for ${invoiceYear}` : 'Invoices created';
    }
  }

  let emailPreheader = String(data.preheaderText || data.emailPreheader || '').trim();
  if (!emailPreheader) {
    if (isNextYear) {
      emailPreheader = showOwnerColumn
        ? `${resolvedCount} next-year invoice${pluralSuffix} created for ${invoiceYear} - review required.`
        : `Your next-year HOA invoice${pluralSuffix} for ${invoiceYear} - ${totalAmountDue} total due.`;
    } else {
      emailPreheader = `${resolvedCount} invoice${pluralSuffix} created for ${invoiceYear} - ${totalAmountDue} total due.`;
    }
  }

  return {
    ...data,
    isNextYear,
    showOwnerColumn,
    hasMultipleInvoices,
    documentTitle,
    emailPreheader,
    showNextYearBanner: isNextYear,
    nextYearBannerText: isNextYear
      ? `Next-year invoice${pluralSuffix} created automatically in advance`
      : '',
    ctaLabel: isNextYear ? 'Review invoices' : 'View invoices',
  };
}

const INVOICE_RELATED_EMAIL_TEMPLATES = new Set([
  'invoice-created',
  'invoice-schedule-summary',
  'invoice-due-today',
  'invoice-overdue',
  'invoice-balance-waived',
  'invoice-template',
  'invoice',
  'invoice-updated',
  'payment-recorded',
  'payment-deleted',
  'payment-received',
  'payment-failed',
  'payment-reminder',
  'late-fee-notification',
  'late-fee-invoice-notification',
]);

function isInvoiceRelatedEmailTemplate(templateName) {
  return INVOICE_RELATED_EMAIL_TEMPLATES.has(String(templateName || '').trim());
}

function resolveOrganizationDisplayName(data = {}) {
  return (
    String(
      data.organizationDisplayName ||
      data.communityName ||
      data.hoaName ||
      data.senderCompany ||
      ''
    ).trim() || process.env.FROM_NAME || 'PropMv'
  );
}

async function prepareTemplateData(templateName, data, { logoMode = 'send' } = {}) {
  const logoUrl = data?.logoUrl || (await resolveLogoSrc(logoMode));

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      logoUrl,
      logoAltText: '',
      brandHeaderText: 'PropMv',
      currentYear: currentYearInAppTimezone(),
    };
  }

  const organizationDisplayName = resolveOrganizationDisplayName(data);
  const platformAppName = data.appName || process.env.APP_NAME || 'PropMv';
  const communityName = String(data.communityName || data.hoaName || '').trim();
  const logoAltText =
    data.logoAltText != null ? String(data.logoAltText) : communityName || '';
  const brandHeaderText = data.brandHeaderText || communityName || 'PropMv';
  const merged = {
    ...data,
    logoUrl,
    logoAltText,
    brandHeaderText,
    currentYear: data.currentYear || currentYearInAppTimezone(),
    organizationDisplayName,
    appDisplayName: data.appDisplayName || data.appName || process.env.APP_NAME || 'PropMv',
  };

  if (isInvoiceRelatedEmailTemplate(templateName)) {
    merged.appDisplayName = organizationDisplayName;
  } else if (!merged.appDisplayName) {
    merged.appDisplayName = platformAppName;
  }

  if (templateName === 'invite') {
    return prepareInviteTemplateData(templateName, merged);
  }

  if (templateName === 'invoice-schedule-summary') {
    return prepareInvoiceScheduleSummaryTemplateData(merged);
  }

  return merged;
}

// ---------------------------
// Utility: Load HTML Template
// ---------------------------
async function loadHtmlTemplate(type) {
  if (type && String(type).startsWith('_')) {
    return null;
  }
  const filePath = path.join(TEMPLATES_DIR, `${type}.html`);
  try {
    await Promise.all([getEmailThemeStyles(), getBrandHeaderPartial(), getBrandFooterPartial()]);
    let content = await fs.readFile(filePath, 'utf8');
    content = injectEmailTheme(content);
    content = injectBrandPartials(content);
    return content;
  } catch (err) {
    logger.error(`[Email] Missing template for type "${type}" at: ${filePath}`);
    return null;
  }
}

/**
 * get Template Value
 *
 * Performs logic operations for getTemplateValue.
 *
 * @param data - Request/input argument
 * @param key - Request/input argument
 * @returns Operations result
 */
function getTemplateValue(data, key) {
  return key.split('.').reduce((acc, part) => (acc != null ? acc[part] : undefined), data);
}

/**
 * is Template Truthy
 *
 * Performs logic operations for isTemplateTruthy.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function isTemplateTruthy(value) {
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  return Boolean(value);
}

function resolveTemplatePath(contextData, parentData, key) {
  const trimmed = String(key || '').trim();
  if (trimmed.startsWith('../')) {
    return getTemplateValue(parentData, trimmed.slice(3));
  }
  return getTemplateValue(contextData, trimmed);
}

function renderConditionalBlocks(templateStr, contextData, parentData = contextData) {
  let rendered = templateStr;
  let prev;
  do {
    prev = rendered;
    rendered = rendered.replace(
      /\{\{#unless\s+([\w./]+)\}\}([\s\S]*?)\{\{\/unless\}\}/g,
      (_, key, body) => {
        const parts = body.split(/\{\{else\}\}/);
        const whenFalse = parts[0] || '';
        const whenTrue = parts[1] || '';
        return isTemplateTruthy(resolveTemplatePath(contextData, parentData, key)) ? whenTrue : whenFalse;
      }
    );
    rendered = rendered.replace(
      /\{\{#if\s+([\w./]+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
      (_, key, body) => {
        const parts = body.split(/\{\{else\}\}/);
        const whenTrue = parts[0] || '';
        const whenFalse = parts[1] || '';
        return isTemplateTruthy(resolveTemplatePath(contextData, parentData, key)) ? whenTrue : whenFalse;
      }
    );
  } while (rendered !== prev);
  return rendered;
}

function renderEachLoops(templateStr, data) {
  return templateStr.replace(
    /\{\{#each\s+(\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (match, arrayName, loopContent) => {
      const array = data[arrayName];
      if (!Array.isArray(array)) return '';

      return array
        .map((item) => {
          if (item != null && typeof item === 'object') {
            let row = renderConditionalBlocks(loopContent, item, data);
            row = row.replace(/\{\{(\w+)\}\}/g, (_, key) =>
              item[key] != null ? String(item[key]) : ''
            );
            return row;
          }
          let row = renderConditionalBlocks(loopContent, { this: item }, data);
          return row.replace(/\{\{this\}\}/g, () => String(item));
        })
        .join('');
    }
  );
}

// ---------------------------
// Utility: Replace placeholders {{key}} and handle {{#each}} / {{#if}} / {{#unless}} blocks
// ---------------------------
function renderTemplate(templateStr, data = {}) {
  let rendered = renderEachLoops(templateStr, data);
  rendered = renderConditionalBlocks(rendered, data, data);

  // Unescaped HTML placeholders {{{key}}}
  rendered = rendered.replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_, key) => {
    const value = getTemplateValue(data, key);
    return value != null ? String(value) : '';
  });

  // Handle regular {{key}} placeholders
  rendered = rendered.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = getTemplateValue(data, key);
    return value != null ? String(value) : '';
  });

  return rendered;
}

// ---------------------------
// Utility: Get subject/title from env
// Example: EMAIL_SUBJECT_FORGOTPASSWORD or fallback
// ---------------------------
function getSubjectForType(type) {
  const envKey = `EMAIL_SUBJECT_${type.toUpperCase()}`;
  return (
    process.env[envKey] ||
    process.env.DEFAULT_EMAIL_SUBJECT ||
    `${type.charAt(0).toUpperCase() + type.slice(1)} Notification`
  );
}

/**
 * escape Html Text
 *
 * Performs logic operations for escapeHtmlText.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function escapeHtmlText(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** HTML snippet for invite.html (role: landlord → tenant). */
function inviteDescriptionForTenant(landlordDisplayName, appName) {
  const landlord = escapeHtmlText(landlordDisplayName || 'Your landlord');
  const app = escapeHtmlText(appName || process.env.APP_NAME || 'PropMv');
  return `<p style="margin:0 0 12px"><strong>${landlord}</strong> has invited you to join <strong>${app}</strong>.</p><p style="margin:0;color:#334155;line-height:1.55">${app} helps you view your lease, pay rent and invoices, and submit maintenance requests in one place.</p>`;
}

/**
 * HTML body for invite.html (HOA board → HOA owner), similar to PayHOA-style onboarding:
 * welcome, what the product is for, and community context when available.
 */
function inviteDescriptionForHoaOwner(inviterDisplayName, communityName, appName) {
  const app = escapeHtmlText(appName || process.env.APP_NAME || 'PropMv');
  const inviter = escapeHtmlText(inviterDisplayName || 'Your association');
  const community = communityName ? escapeHtmlText(communityName) : null;

  const lead = community
    ? `<p style="margin:0 0 12px"><strong>${inviter}</strong> has invited you to join <strong>${app}</strong> for <strong>${community}</strong>.</p>`
    : `<p style="margin:0 0 12px"><strong>${inviter}</strong> has invited you to join <strong>${app}</strong> for your homeowners association.</p>`;

  const explain = `<p style="margin:0;color:#0f172a">${app} helps HOAs keep the owner roster organized, collect assessments and fees, share documents, and communicate with homeowners. You can use your account to review statements, pay invoices, submit maintenance requests, and stay in touch with your board.</p>`;

  return lead + explain;
}

/** Subject line for HOA owner portal invitations (board-invited homeowners). */
function inviteEmailSubjectForHoaOwner({ inviterDisplayName, communityName, appName } = {}) {
  const app = appName || process.env.APP_NAME || 'PropMv';
  const inviter = inviterDisplayName || 'Your HOA';
  if (communityName) {
    return `${communityName} invited you to join ${app} - set up your owner account`;
  }
  return `${inviter} invited you to join ${app}`;
}

const VENDOR_PORTAL_CAPABILITIES_SENTENCE =
  'Once your account is active, you can view maintenance tickets assigned to you, update work status, share notes and photos with the property team, and submit invoices to track payment status';

/** HTML body for invite.html (board, property manager, or landlord → vendor). */
function inviteDescriptionForVendor(inviterDisplayName, communityName, appName) {
  const app = escapeHtmlText(appName || process.env.APP_NAME || 'PropMv');
  const inviter = escapeHtmlText(inviterDisplayName || 'Your association');
  const community = communityName ? escapeHtmlText(communityName) : null;

  const lead = community
    ? `<p style="margin:0 0 12px"><strong>${inviter}</strong> has invited you to the <strong>${app}</strong> vendor portal for <strong>${community}</strong>.</p>`
    : `<p style="margin:0 0 12px"><strong>${inviter}</strong> has invited you to the <strong>${app}</strong> vendor portal.</p>`;

  const explain = `<p style="margin:0;color:#0f172a">${VENDOR_PORTAL_CAPABILITIES_SENTENCE}—all in one place.</p>`;

  return lead + explain;
}

/** Subject line for vendor portal invitations. */
function inviteEmailSubjectForVendor({ inviterDisplayName, communityName, appName } = {}) {
  const app = appName || process.env.APP_NAME || 'PropMv';
  const inviter = inviterDisplayName || 'Your HOA';
  if (communityName) {
    return `${communityName} invited you to the ${app} vendor portal - manage assigned work`;
  }
  return `${inviter} invited you to the ${app} vendor portal`;
}

/**
 * prepare Invite Template Data
 *
 * Performs logic operations for prepareInviteTemplateData.
 *
 * @param templateName - Request/input argument
 * @param data - Request/input argument
 * @returns Operations result
 */
function prepareInviteTemplateData(templateName, data) {
  if (templateName !== 'invite' || !data || typeof data !== 'object' || Array.isArray(data)) {
    return data;
  }

  const merged = { ...data };
  const appNameRaw = merged.appName || process.env.APP_NAME || 'PropMv';

  merged.appDisplayName = merged.appDisplayName || escapeHtmlText(appNameRaw);

  if (merged.inviteAudience === 'hoa_owner') {
    merged.productTagline =
      merged.productTagline || 'HOA fees, documents, and owner updates in one place';
    if (!merged.inviteDescription) {
      merged.inviteDescription = inviteDescriptionForHoaOwner(
        merged.landlordName,
        merged.communityName || null,
        appNameRaw
      );
    }
    merged.inviteTitle = merged.inviteTitle || escapeHtmlText('Set up your account');
    merged.inviteCtaText = merged.inviteCtaText || escapeHtmlText('Set up my account');
    merged.invitePreCtaNote =
      merged.invitePreCtaNote ||
      escapeHtmlText(
        'Below is your personal link to activate your account and choose a password. This link is unique to you-please do not forward it.'
      );
    merged.invitePlainLinkBlock =
      merged.invitePlainLinkBlock;
    merged.inviteSignoff =
      merged.inviteSignoff ||
      `Regards,<br/><strong>The ${merged.appDisplayName} team</strong>`;
  } else if (merged.inviteAudience === 'vendor') {
    merged.productTagline =
      merged.productTagline || 'Assigned maintenance work and invoices in one place';
    if (!merged.inviteDescription) {
      merged.inviteDescription = inviteDescriptionForVendor(
        merged.landlordName,
        merged.communityName || null,
        appNameRaw
      );
    }
    merged.inviteTitle = merged.inviteTitle || escapeHtmlText('Activate your vendor portal');
    merged.inviteCtaText = merged.inviteCtaText || escapeHtmlText('Set up my account');
    merged.invitePreCtaNote =
      merged.invitePreCtaNote ||
      escapeHtmlText(
        'Use the button below to activate your vendor account and choose a password. This link is unique to you—please do not forward it.'
      );
    merged.invitePlainLinkBlock = merged.invitePlainLinkBlock || '';
    merged.inviteSignoff =
      merged.inviteSignoff ||
      `Regards,<br/><strong>The ${merged.appDisplayName} team</strong>`;
  } else {
    merged.productTagline = merged.productTagline || 'Property management simplified';
    if (!merged.inviteDescription) {
      merged.inviteDescription = inviteDescriptionForTenant(merged.landlordName, appNameRaw);
    }
    merged.inviteTitle =
      merged.inviteTitle || escapeHtmlText(`You're invited to ${appNameRaw}`);
    merged.inviteCtaText = merged.inviteCtaText || escapeHtmlText('Accept invitation');
    merged.invitePreCtaNote =
      merged.invitePreCtaNote ||
      escapeHtmlText('Use the button below to accept your invitation and get started.');
    merged.invitePlainLinkBlock = merged.invitePlainLinkBlock || '';
    merged.inviteSignoff = merged.inviteSignoff || '';
  }

  return merged;
}

/**
 * Plain-text body for transactional emails (better inbox placement than HTML strip alone).
 * @param {string} templateName
 * @param {object} data - Original template data (unescaped)
 * @param {string} htmlFallback - Stripped HTML fallback
 */
function buildPlainTextBody(templateName, data = {}, htmlFallback = '') {
  const d = data || {};
  if (templateName === 'invite') {
    const app = d.appName || process.env.APP_NAME || 'PropMv';
    const url = String(d.inviteUrl || d.acknowledgeLink || '').trim();
    const tenantName = d.tenantName || 'there';
    const landlord = d.landlordName || 'Your landlord';

    if (d.inviteAudience === 'vendor') {
      const lines = [
        `Vendor portal invitation - ${app}`,
        '',
        `Hi ${tenantName},`,
        '',
      ];
      if (d.communityName) {
        lines.push(
          `${landlord} has invited you to the ${app} vendor portal for ${d.communityName}.`
        );
      } else {
        lines.push(`${landlord} has invited you to the ${app} vendor portal.`);
      }
      lines.push(
        '',
        `${VENDOR_PORTAL_CAPABILITIES_SENTENCE}.`,
        '',
        'Activate your account (copy into your browser if needed):',
        url || '(link unavailable)',
        '',
        'If you were not expecting this invitation, you can ignore this email.'
      );
      return lines.join('\n');
    }

    if (d.inviteAudience === 'hoa_owner') {
      const lines = [
        `Owner portal invitation - ${app}`,
        '',
        `Hi ${tenantName},`,
        '',
      ];
      if (d.communityName) {
        lines.push(
          `${landlord} has invited you to join ${app} for ${d.communityName}.`
        );
      } else {
        lines.push(
          `${landlord} has invited you to join ${app} for your homeowners association.`
        );
      }
      lines.push(
        '',
        'Set up your account (copy into your browser if needed):',
        url || '(link unavailable)',
        '',
        'If you were not expecting this invitation, you can ignore this email.'
      );
      return lines.join('\n');
    }

    const lines = [
      `Lease invitation - ${app}`,
      '',
      `Hi ${tenantName},`,
      '',
      `${landlord} has invited you to join ${app} for your lease.`,
    ];
    if (d.propertyName) lines.push('', `Property: ${d.propertyName}`);
    if (d.propertyAddress && d.propertyAddress !== 'N/A') {
      lines.push(`Address: ${d.propertyAddress}`);
    }
    if (d.leaseStartDate && d.leaseStartDate !== 'N/A') {
      lines.push(`Lease start: ${d.leaseStartDate}`);
    }
    lines.push('', 'Accept your invitation (copy into your browser if needed):', url || '(link unavailable)', '');
    lines.push('If you were not expecting this invitation, you can ignore this email.');
    return lines.join('\n');
  }
  if (templateName === 'screening-application') {
    const app = d.appDisplayName || d.appName || process.env.APP_NAME || 'PropMv';
    const url = String(d.applicationUrl || '').trim();
    const tenantName = d.tenantName || 'there';
    const landlord = d.landlordName || 'Your landlord';
    const property = d.propertyName || 'the property';
    return [
      `Complete your tenant screening - ${app}`,
      '',
      `Hi ${tenantName},`,
      '',
      `${landlord} invited you to complete tenant screening for ${property}.`,
      '',
      'Start screening:',
      url || '(link unavailable)',
      '',
      'If you were not expecting this email, you can ignore it.',
    ].join('\n');
  }
  if (templateName === 'coming-soon-launch') {
    const signupUrl = String(d.signupUrl || d.siteUrl || '').trim();
    return [
      'PropMv is live - your early access is here!',
      '',
      'Hi there,',
      '',
      'The wait is over - PropMv is officially live!',
      '',
      'Thank you for being on our launch list. You signed up early, and now you can be among the first to experience a smarter way to manage properties and HOA communities.',
      '',
      'PropMv brings together leases, invoices, maintenance, messaging, and AI-driven tools in one platform built to save time and reduce management costs.',
      '',
      signupUrl ? `Create your account: ${signupUrl}` : '',
      '',
      "We're thrilled to have you with us on day one. If you have questions, contact support@propmv.com.",
      '',
      'Welcome aboard,',
      'The PropMv Team',
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (templateName === 'coming-soon-subscription') {
    return [
      "You're on the PropMv launch list!",
      '',
      'Hi there,',
      '',
      'Thanks for joining the PropMv launch list!',
      '',
      "We're excited to have you with us.",
      '',
      "You've successfully signed up to be among the first to know when PropMv goes live. We're working hard to build a platform that makes property and HOA management simpler, smarter, and more efficient.",
      '',
      "As a subscriber, you'll be among the first to receive:",
      '  - Early access to the platform',
      '  - Launch announcements and updates',
      '  - New feature previews',
      '  - Exclusive offers available to early supporters',
      '',
      "We won't flood your inbox-only important updates as we get closer to launch.",
      '',
      "Thank you for being part of our journey. We can't wait to show you what we've been building.",
      '',
      'See you soon,',
      'The PropMv Team',
    ].join('\n');
  }
  if (templateName === 'demo-request-acknowledgement') {
    const userName = d.userName || 'there';
    const lines = [
      'Your PropMv demo request',
      '',
      `Thanks, ${userName},`,
      '',
      'We have your demo request and someone from the PropMv team will be in touch shortly to arrange a time.',
    ];
    if (d.hasPreferredSlot && d.preferredSlot) {
      lines.push('', `You asked for: ${d.preferredSlot}`);
    }
    lines.push('', 'If anything changes, just reply to this email.', '', 'See you soon,', 'The PropMv Team');
    return lines.join('\n');
  }
  if (templateName === 'demo-request-team-notification') {
    const lines = [
      'New demo request',
      '',
      `Source: ${d.source || 'website'}`,
      '',
      `Name: ${d.requesterName || 'N/A'}`,
      `Email: ${d.requesterEmail || 'N/A'}`,
    ];
    if (d.hasPhone && d.requesterPhone) lines.push(`Phone: ${d.requesterPhone}`);
    if (d.hasRole && d.role) lines.push(`Role: ${d.role}`);
    if (d.hasPropertyCount && d.propertyCount) lines.push(`Properties: ${d.propertyCount}`);
    if (d.hasPreferredDate && d.preferredDate) lines.push(`Preferred date: ${d.preferredDate}`);
    if (d.hasPreferredTime && d.preferredTime) lines.push(`Preferred time: ${d.preferredTime}`);
    if (d.hasMessage && d.message) {
      lines.push('', 'Message:', d.message);
    }
    lines.push('', 'Reply directly to reach the prospect.');
    return lines.join('\n');
  }
  if (templateName === 'hoa-onboarding-report') {
    const lines = [
      'PropMv HOA Onboarding Report',
      '',
      `Report date: ${d.reportDate || ''} (${d.timeZone || ''})`,
      '',
      `Daily: ${d.dailyCount ?? 0} new HOAs`,
      `Weekly: ${d.weeklyCount ?? 0} new HOAs`,
      `Monthly: ${d.monthlyCount ?? 0} new HOAs`,
    ];
    if (d.hasDailyHoas && Array.isArray(d.dailyHoas)) {
      lines.push('', "Today's new HOAs:");
      for (const hoa of d.dailyHoas) {
        lines.push(
          `- ${hoa.name || 'Untitled'} | ${hoa.createdAt || ''} | ${hoa.createdByName || ''} | owners=${hoa.ownerCount ?? 0} properties=${hoa.propertyCount ?? 0} units=${hoa.unitCount ?? 0}`
        );
      }
    }
    return lines.join('\n');
  }
  if (templateName === 'invoice-created') {
    const org =
      d.organizationDisplayName ||
      d.communityName ||
      d.appDisplayName ||
      d.appName ||
      process.env.FROM_NAME ||
      'PropMv';
    const viewUrl = String(d.viewInvoiceUrl || d.paymentUrl || '').trim();
    const recipientName = d.recipientName || 'there';
    return [
      `New invoice - ${org}`,
      '',
      `Hi ${recipientName},`,
      '',
      'A new invoice is ready for your review.',
      '',
      `Invoice #: ${d.invoiceNumber || 'N/A'}`,
      `Property: ${d.propertyName || 'N/A'}`,
      `Unit: ${d.unitNumber || 'N/A'}`,
      `Amount due: ${d.amountDue || '$0.00'}`,
      `Due date: ${d.dueDate || 'N/A'}`,
      '',
      'View invoice (copy into your browser if needed):',
      viewUrl || '(link unavailable)',
      '',
      'This is an automated message - please do not reply.',
    ].join('\n');
  }
  if (templateName === 'invoice-schedule-summary') {
    const org =
      d.organizationDisplayName ||
      d.communityName ||
      d.appDisplayName ||
      d.appName ||
      process.env.FROM_NAME ||
      'PropMv';
    const viewUrl = String(d.viewInvoicesUrl || d.viewInvoiceUrl || d.paymentUrl || '').trim();
    const recipientName = d.recipientName || 'there';
    const invoiceYear = d.invoiceYear || 'N/A';
    const rows = Array.isArray(d.invoiceRows) ? d.invoiceRows : [];
    const isNextYear = Boolean(d.isNextYear);
    const isBoard = d.audience === 'board' || d.showOwnerColumn === true;
    const headline = isNextYear
      ? (isBoard
        ? `Next-Year HOA Invoices Created - ${org}`
        : `${rows.length > 1 ? 'Your Next-Year HOA Invoices Have Been Created' : 'Your Next-Year HOA Invoice Has Been Created'} - ${org}`)
      : `Invoices created for ${invoiceYear} - ${org}`;
    const lines = [
      headline,
      '',
      `Hi ${recipientName},`,
      '',
      isNextYear
        ? (isBoard
          ? `Next-year invoices have been automatically generated for the applicable HOA owners for ${invoiceYear}. Please review the upcoming invoices below.`
          : `Your invoice${rows.length > 1 ? 's' : ''} for the upcoming billing year (${invoiceYear}) ${rows.length > 1 ? 'have' : 'has'} been created automatically in advance. Please review the details below and payment schedule.`)
        : `Invoices have been created for ${invoiceYear} for the following units/properties. Please review the details below.`,
      '',
      `Billing year: ${invoiceYear}`,
      `Invoice count: ${d.invoiceCount || rows.length}`,
      `Total amount due: ${d.totalAmountDue || '$0.00'}`,
      '',
      'Invoice details:',
    ];

    rows.forEach((row, index) => {
      lines.push(
        '',
        `${index + 1}. Invoice #${row.invoiceNumber || 'N/A'}`,
      );
      if (isBoard && row.ownerName) {
        lines.push(`   Owner: ${row.ownerName}`);
      }
      lines.push(
        `   Period: ${row.term || 'N/A'}`,
        `   Invoice date: ${row.invoiceDate || 'N/A'}`,
        `   Due date: ${row.dueDate || 'N/A'}`,
        `   Amount due: ${row.amountDue || '$0.00'}`,
        `   Property: ${row.propertyName || 'N/A'}`,
        `   Unit: ${row.unitNumber || 'N/A'}`,
        `   Location: ${row.location || 'N/A'}`,
        `   Status: ${row.applicability || 'N/A'}`,
      );
      if (row.viewInvoiceUrl) {
        lines.push(`   View: ${row.viewInvoiceUrl}`);
      }
    });

    lines.push(
      '',
      isNextYear ? 'Review all invoices (copy into your browser if needed):' : 'View all invoices (copy into your browser if needed):',
      viewUrl || '(link unavailable)',
      '',
      'This is an automated message - please do not reply.',
    );
    return lines.join('\n');
  }
  if (templateName === 'invoice-updated') {
    const org =
      d.organizationDisplayName ||
      d.communityName ||
      d.appDisplayName ||
      d.appName ||
      process.env.FROM_NAME ||
      'PropMv';
    const viewUrl = String(d.viewInvoiceUrl || d.paymentUrl || '').trim();
    const recipientName = d.recipientName || 'there';
    const invoiceNumber = d.invoiceNumber || 'N/A';
    const extraChanges = Array.isArray(d.additionalChanges) ? d.additionalChanges.filter(Boolean) : [];
    const lines = [
      `Invoice #${invoiceNumber} Updated - ${org}`,
      '',
      `Hi ${recipientName},`,
      '',
      d.introText || `An update has been made to your invoice #${invoiceNumber}.`,
    ];
    if (d.changeSummary) {
      lines.push('', `Change: ${d.changeSummary}`);
    }
    extraChanges.forEach((change) => {
      lines.push(`Change: ${change}`);
    });
    lines.push(
      '',
      `Invoice #: ${invoiceNumber}`,
      `Property: ${d.propertyName || 'N/A'}`,
      `Unit: ${d.unitNumber || 'N/A'}`,
      `Amount due: ${d.amountDue || '$0.00'}`,
      `Due date: ${d.dueDate || 'N/A'}`,
      '',
      'View invoice (copy into your browser if needed):',
      viewUrl || '(link unavailable)',
      '',
      'This is an automated message - please do not reply.',
    );
    return lines.join('\n');
  }
  if (templateName === 'payment-deleted') {
    const org =
      d.organizationDisplayName ||
      d.communityName ||
      d.appDisplayName ||
      d.appName ||
      process.env.FROM_NAME ||
      'PropMv';
    const viewUrl = String(d.viewInvoiceUrl || d.paymentUrl || '').trim();
    const recipientName = d.recipientName || 'there';
    const invoiceNumber = d.invoiceNumber || 'N/A';
    return [
      `Payment removed - Invoice ${invoiceNumber} - ${org}`,
      '',
      `Hi ${recipientName},`,
      '',
      `We've removed a payment previously posted to invoice #${invoiceNumber}. Your remaining balance has been updated.`,
      '',
      `Amount removed: ${d.paymentAmount || '$0.00'}`,
      `Payment method: ${d.paymentMethod || 'Payment'}`,
      `Original payment date: ${d.paidOn || 'N/A'}`,
      `Removed by: ${d.deletedByName || 'Your HOA'}`,
      `Removed on: ${d.deletedAt || 'N/A'}`,
      `Remaining balance: ${d.remainingBalance || '$0.00'}`,
      `Property: ${d.propertyName || 'N/A'} · ${d.unitNumber || 'N/A'}`,
      '',
      'View invoice (copy into your browser if needed):',
      viewUrl || '(link unavailable)',
      '',
      'This is an automated message - please do not reply.',
    ].join('\n');
  }
  return htmlFallback;
}

const MIN_RENDERED_HTML_LENGTH = 400;

function resolveEmailOrigin(explicitOrigin, { defaultOrigin = EMAIL_ORIGIN.SYSTEM } = {}) {
  const raw = String(explicitOrigin || '').trim().toLowerCase();
  if (raw === EMAIL_ORIGIN.USER) return EMAIL_ORIGIN.USER;
  if (raw === EMAIL_ORIGIN.SYSTEM) return EMAIL_ORIGIN.SYSTEM;
  return defaultOrigin;
}

/**
 * Normalize CC addresses for outbound mail.
 * System emails previously auto-CC'd support@propmv.com; that behavior is disabled.
 */
function applySystemSupportCc(existingCc, _origin) {
  return normalizeAddressList(existingCc);
}

function mergeNodemailerAttachments(logoAttachment, fileAttachments = []) {
  const out = [];
  if (logoAttachment) out.push(logoAttachment);
  if (Array.isArray(fileAttachments) && fileAttachments.length) {
    out.push(...fileAttachments);
  }
  return out;
}

async function logSendResult({
  emailId,
  userId,
  origin,
  to,
  cc,
  bcc,
  subject,
  body,
  templateName,
  messageId,
  status,
  errorMessage,
  attachmentsMeta,
}) {
  await persistEmailLog({
    emailId,
    userId,
    origin,
    to,
    cc,
    bcc,
    subject,
    body,
    status,
    errorMessage,
    templateName,
    messageId,
    attachments: attachmentsMeta,
  });
}

// ---------------------------
// Generic Email Sender
// ---------------------------
async function sendEmail(type, toEmail, data = {}, options = {}) {
  // Backward compatibility:
  // Some existing flows call sendEmail({ to, subject, html, text, from }).
  // Support that form to avoid breaking legacy integrations.
  if (type && typeof type === 'object' && !Array.isArray(type)) {
    const payload = type;
    const fromName = process.env.FROM_NAME || 'Support';
    const fromAddress = process.env.FROM_EMAIL || 'noreply@propmv.com';
    const to = payload.to || payload.toEmail;
    const subject = payload.subject || process.env.DEFAULT_EMAIL_SUBJECT || 'Notification';
    const html = payload.html || '';
    const text = payload.text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const from = payload.from || { name: fromName, address: fromAddress };
    const origin = resolveEmailOrigin(payload.origin || payload.source, {
      // Legacy object form is used by Email-tab (must pass origin:'user') and system callers.
      defaultOrigin: EMAIL_ORIGIN.SYSTEM,
    });
    const cc = applySystemSupportCc(payload.cc, origin);
    const bcc = normalizeAddressList(payload.bcc);
    const attachments = payload.attachments || [];
    const emailId = payload.emailId || payload.logEmailId || null;
    const userId = payload.userId || null;
    const templateName = payload.templateName || payload.template || '';
    const skipPersist = Boolean(payload.skipPersist);

    if (!to) {
      throw new Error('Email recipient is required');
    }

    // Template flag gate: blank template (Email-tab) still respects master EMAIL_SENDING_ENABLED.
    if (templateName) {
      if (!isEmailTemplateEnabled(templateName)) {
        logger.info(
          `[Email] Skipped (disabled by config): template=${templateName} to=${to}`
        );
        return false;
      }
    } else if (!isEmailSendingEnabled()) {
      logger.info(`[Email] Skipped (EMAIL_SENDING_ENABLED=false): legacy to=${to}`);
      return false;
    }

    await assertRecipientBeforeSend(to, {
      skipRecipientValidation: Boolean(payload.skipRecipientValidation),
      validationContext: payload.validationContext || templateName || 'legacy',
      template: templateName,
    });

    const mailOptions = {
      from,
      to,
      subject,
      html,
      text,
    };

    if (cc) mailOptions.cc = cc;
    if (bcc) mailOptions.bcc = bcc;
    if (attachments && attachments.length > 0) mailOptions.attachments = attachments;
    if (payload.replyTo) mailOptions.replyTo = payload.replyTo;

    const communityContext = buildCommunityEmailContext(payload, payload);
    const finalMailOptions = await finalizeMailOptions(mailOptions, communityContext);

    try {
      const info = await sendMailWithRetry(finalMailOptions);
      logger.info(`[Email] (legacy/${origin}) sent successfully to ${to}. Message ID: ${info.messageId}`);
      if (!skipPersist) {
        await logSendResult({
          emailId,
          userId,
          origin,
          to,
          cc,
          bcc,
          subject,
          body: html,
          templateName,
          messageId: info.messageId || '',
          status: EMAIL_STATUS.SENT,
        });
      }
      return true;
    } catch (error) {
      const detail = error.code || error.message || 'Email delivery failed';
      logger.error(`[Email] Failed to send legacy email to ${to}:`, detail);
      if (!skipPersist) {
        await logSendResult({
          emailId,
          userId,
          origin,
          to,
          cc,
          bcc,
          subject,
          body: html,
          templateName,
          status: EMAIL_STATUS.FAILED,
          errorMessage: String(detail),
        });
      }
      throw clientSafeSendError(error);
    }
  }

  const fromName = process.env.FROM_NAME || 'Support';
  const fromAddress = process.env.FROM_EMAIL || 'noreply@propmv.com';
  const subject = options.subject || getSubjectForType(type);
  const origin = resolveEmailOrigin(options.origin || options.source, {
    defaultOrigin: EMAIL_ORIGIN.SYSTEM,
  });
  const emailId = options.emailId || options.logEmailId || null;
  const userId = options.userId || null;
  const skipPersist = Boolean(options.skipPersist);

  // Determine template name. If caller provides options.template use it.
  const templateName = options.template || type;
  const usedTemplateName = templateName;

  if (!isEmailTemplateEnabled(usedTemplateName)) {
    logger.info(
      `[Email] Skipped (disabled by config): template=${usedTemplateName} to=${toEmail}`
    );
    return false;
  }

  // Load HTML Template. Template MUST exist for the requested type - do not fallback.
  const htmlTemplate = await loadHtmlTemplate(templateName);
  if (!htmlTemplate) {
    throw new Error(`Email template not found for type: ${templateName}`);
  }

  const renderData = await prepareTemplateData(usedTemplateName, data, { logoMode: 'send' });

  // Render HTML and plain-text fallback
  const renderedHtml = renderTemplate(htmlTemplate, renderData);
  const html = finalizeRenderedEmailHtml(renderedHtml, {
    preheaderText: options.preheaderText || data.preheaderText || '',
  });
  if (!html || html.length < MIN_RENDERED_HTML_LENGTH) {
    throw new Error(
      `Email template "${usedTemplateName}" rendered empty or too short (${html ? html.length : 0} chars)`
    );
  }
  const preheaderPlain = extractPreheaderText(html);
  const textHtml = stripHtmlForPlainText(html);
  const htmlStripped = decodeBasicHtmlEntities(
    textHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  );
  const bodyText = buildPlainTextBody(usedTemplateName, data, htmlStripped) || htmlStripped;
  const text = preheaderPlain
    ? `${preheaderPlain}\n\n${bodyText}`.trim()
    : bodyText;

  await assertRecipientBeforeSend(toEmail, {
    skipRecipientValidation: Boolean(options.skipRecipientValidation),
    validationContext: options.validationContext || type || usedTemplateName,
    template: usedTemplateName,
    type,
  });

  const cc = applySystemSupportCc(options.cc, origin);
  const bcc = normalizeAddressList(options.bcc);

  const mailOptions = {
    from: { name: fromName, address: fromAddress },
    to: toEmail,
    subject,
    html,
    text,
  };
  if (cc) mailOptions.cc = cc;
  if (bcc) mailOptions.bcc = bcc;
  if (options.replyTo) {
    mailOptions.replyTo =
      typeof options.replyTo === 'string' ? options.replyTo : options.replyTo;
  }

  const communityContext = buildCommunityEmailContext(options, data);
  const finalMailOptions = await finalizeMailOptions(mailOptions, communityContext);

  let logoAttachment = null;
  if (renderData.logoUrl && String(renderData.logoUrl).startsWith('cid:')) {
    logoAttachment = getEmailLogoAttachment();
  }
  const fileAttachments = Array.isArray(options.attachments) ? options.attachments : [];
  const attachments = mergeNodemailerAttachments(logoAttachment, fileAttachments);
  if (attachments.length > 0) {
    finalMailOptions.attachments = attachments;
  }

  try {
    const info = await sendMailWithRetry(finalMailOptions);
    logger.info(
      `[Email] (${type}/${origin}) sent successfully to ${toEmail}. Template: ${usedTemplateName}. Subject: "${subject}". Message ID: ${info.messageId}`
    );
    if (!skipPersist) {
      await logSendResult({
        emailId,
        userId,
        origin,
        to: toEmail,
        cc,
        bcc,
        subject,
        body: html,
        templateName: usedTemplateName,
        messageId: info.messageId || '',
        status: EMAIL_STATUS.SENT,
      });
    }
    return true;
  } catch (error) {
    const detail = error.code || error.message || 'Email delivery failed';
    logger.error(`[Email] Failed to send "${type}" email to ${toEmail}:`, detail);
    if (!skipPersist) {
      await logSendResult({
        emailId,
        userId,
        origin,
        to: toEmail,
        cc,
        bcc,
        subject,
        body: html,
        templateName: usedTemplateName,
        status: EMAIL_STATUS.FAILED,
        errorMessage: String(detail),
      });
    }
    throw clientSafeSendError(error);
  }
}

// ---------------------------
// Backwards-compatible helper wrappers
// Some parts of the codebase call specific helpers like `sendOtpEmail`.
// Provide small wrappers that call the generic `sendEmail` with the
// expected template name and mapped data.
// ---------------------------
async function sendForgotPasswordEmail(toEmail, otp, recipientName = 'User', options = {}) {
  const data = { userName: recipientName, otp, expiryMinutes: 10 };
  // Recipient is a registered user - skip pre-send validation to avoid false rejections
  return sendEmail('forgot-password', toEmail, data, { skipRecipientValidation: true, ...options });
}

async function sendMfaOtpEmail(toEmail, otp, recipientName = 'User', action = 'login', options = {}) {
  const actionLabel = formatMfaActionLabel(action);
  const data = { userName: recipientName, otp, action, actionLabel, expiryMinutes: 10 };
  const template = action === 'signup' ? 'email-verification' : 'mfa-otp';
  const subject =
    options.subject ||
    (action === 'signup'
      ? 'Verify your email - PropMv'
      : process.env.EMAIL_SUBJECT_MFAOTP || 'Your PropMv verification code');
  // Recipient is a registered user - skip pre-send validation to avoid false rejections
  return sendEmail(template, toEmail, data, { skipRecipientValidation: true, ...options, template, subject });
}

async function sendEmailVerificationEmail(toEmail, otp, recipientName = 'User', options = {}) {
  const data = {
    userName: recipientName,
    otp,
    verifyUrl: options.verifyUrl || '',
    expiryMinutes: options.expiryMinutes || 10,
  };
  return sendEmail('email-verification', toEmail, data, {
    ...options,
    template: 'email-verification',
    subject: options.subject || 'Verify your email - PropMv',
  });
}

async function sendWelcomeEmail(toEmail, data = {}, options = {}) {
  const signInBase =
    process.env.FRONTEND_BASE_URL ||
    process.env.PORTAL_INVITE_VERIFY_BASE_URL ||
    process.env.APP_URL ||
    'https://app.propmv.com';
  const merged = {
    userName: data.userName || 'there',
    roleName: data.roleName || '',
    signInUrl: data.signInUrl || `${String(signInBase).replace(/\/$/, '')}/login`,
    ...data,
  };
  return sendEmail('welcome', toEmail, merged, {
    ...options,
    template: 'welcome',
    subject: options.subject || 'Welcome to PropMv',
  });
}

/**
 * notify Welcome Email In Background
 *
 * Performs logic operations for notifyWelcomeEmailInBackground.
 *
 * @param toEmail - Request/input argument
 * @param data - Request/input argument
 * @param options - Request/input argument
 * @returns Operations result
 */
function notifyWelcomeEmailInBackground(toEmail, data = {}, options = {}) {
  setImmediate(() => {
    sendWelcomeEmail(toEmail, data, options).catch((err) => {
      logger.error('[Email] Welcome email failed:', err.message);
    });
  });
}

// ---------------------------
// Non-sending preview helper (for tests / dev)
// Returns the composed subject/html/text without delivering the email
// ---------------------------
async function composeEmailPreview(type, toEmail, data = {}, options = {}) {
  const fromName = process.env.FROM_NAME || 'Support';
  const fromAddress = process.env.FROM_EMAIL || 'noreply@propmv.com';
  const subject = options.subject || getSubjectForType(type);

  // Determine template name same as sendEmail
  const templateName = options.template || type;
  const htmlTemplate = await loadHtmlTemplate(templateName);
  if (!htmlTemplate) {
    throw new Error(`Email template not found for preview type: ${templateName}`);
  }
  const renderDataInvite = await prepareTemplateData(templateName, data, { logoMode: 'preview' });
  const renderedHtml = renderTemplate(htmlTemplate, renderDataInvite);
  const html = finalizeRenderedEmailHtml(renderedHtml, {
    preheaderText: options.preheaderText || data.preheaderText || '',
  });
  const preheaderPlain = extractPreheaderText(html);
  const textHtml = stripHtmlForPlainText(html);
  const htmlStripped = decodeBasicHtmlEntities(
    textHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  );
  const bodyText = buildPlainTextBody(templateName, data, htmlStripped) || htmlStripped;
  const text = preheaderPlain
    ? `${preheaderPlain}\n\n${bodyText}`.trim()
    : bodyText;

  const previewMail = await finalizeMailOptions(
    {
      from: { name: fromName, address: fromAddress },
      to: toEmail,
      subject,
      html,
      text,
    },
    buildCommunityEmailContext(options, data)
  );

  return previewMail;
}

// ---------------------------
// Verify Configuration (for startup checks)
// ---------------------------
async function verifyEmailConfig() {
  return smtpDeliveryService.verifyConfig({ includeSecondary: false });
}

module.exports = {
  sendEmail,
  sendForgotPasswordEmail,
  sendMfaOtpEmail,
  sendEmailVerificationEmail,
  sendWelcomeEmail,
  notifyWelcomeEmailInBackground,
  composeEmailPreview,
  verifyEmailConfig,
  assertRecipientBeforeSend,
  INVALID_RECIPIENT_MESSAGE,
  inviteDescriptionForTenant,
  inviteDescriptionForHoaOwner,
  inviteDescriptionForVendor,
  inviteEmailSubjectForHoaOwner,
  inviteEmailSubjectForVendor,
  renderTemplate,
  finalizeRenderedEmailHtml,
  inlineEmailStyles,
  extractPreheaderText,
  stripHtmlForPlainText,
  stripStyleTagsFromHtml,
  buildPlainTextBody,
  prepareInviteTemplateData,
  prepareTemplateData,
  getEmailLogoUrl,
  resolveLogoSrc,
  getLogoDataUri,
  getEmailLogoAttachment,
  applySystemSupportCc,
  resolveEmailOrigin,
  SYSTEM_EMAIL_CC,
  MIN_RENDERED_HTML_LENGTH,
  isEmailSendingEnabled,
  isEmailTemplateEnabled,
  getEmailTemplateFlagsStatus,
};
