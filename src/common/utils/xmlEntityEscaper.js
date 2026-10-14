/**
 * ------------------------------------------------------------------
 * File: xmlEntityEscaper.js
 * Module: Src Common Utils
 *
 * Purpose:
 * Backend utility/module providing helper functions for xmlEntityEscaper.
 *
 * Used By:
 * zillowXmlBuilder
 * ------------------------------------------------------------------
 */

/**
 * Escapes XML reserved characters per W3C entity reference rules.
 * Use for attribute values and element text that are NOT wrapped in CDATA.
 */
function escapeXmlText(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Wraps free-text fields in CDATA to avoid escaping issues with HTML/markdown descriptions.
 */
function wrapCdata(value) {
  if (value == null || value === '') return '';
  const text = String(value).replace(/]]>/g, ']]]]><![CDATA[>');
  return `<![CDATA[${text}]]>`;
}

/**
 * Zillow silently strips underscores from IDs/names - warn callers via this helper.
 */
function containsUnderscore(value) {
  return typeof value === 'string' && value.includes('_');
}

module.exports = {
  escapeXmlText,
  wrapCdata,
  containsUnderscore,
};
