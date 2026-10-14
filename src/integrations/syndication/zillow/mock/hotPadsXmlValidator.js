/**
 * ------------------------------------------------------------------
 * File: hotPadsXmlValidator.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for hotPadsXmlValidator.
 *
 * Used By:
 * markForUpdate.mock
 * ------------------------------------------------------------------
 */

/**
 * Validates HotPads v2.1 feed XML structure used by Zillow syndication.
 */
function validateHotPadsFeedXml(xml) {
  const errors = [];
  if (!xml || typeof xml !== 'string') {
    return { valid: false, errors: ['XML payload is empty'] };
  }

  if (!/^<\?xml version="1\.0" encoding="UTF-8" \?>/.test(xml)) {
    errors.push('Missing UTF-8 XML declaration');
  }
  if (!/<hotPadsItems version="2\.1">/.test(xml)) {
    errors.push('Missing hotPadsItems root with version 2.1');
  }

  const hasListing = /<listing[\s>]/.test(xml);
  const normalizedRoot = xml.replace(/\s/g, '');
  const isEmptyFeed = normalizedRoot === '<?xmlversion="1.0"encoding="UTF-8"?><hotPadsItemsversion="2.1"></hotPadsItems>'
    || /<hotPadsItems version="2\.1">\s*<\/hotPadsItems>/.test(xml);

  if (hasListing) {
    const requiredPatterns = [
      /<listing id="[^"]+" type="[^"]+" companyId="[^"]+" propertyType="[^"]+"/,
      /<name>[^<]+<\/name>/,
      /<street hide="(true|false)">/,
      /<city>[^<]+<\/city>/,
      /<state>[^<]+<\/state>/,
      /<zip>[^<]+<\/zip>/,
      /<lastUpdated>[^<]+<\/lastUpdated>/,
      /<contactEmail>[^<]+<\/contactEmail>/,
      /<contactPhone>[^<]+<\/contactPhone>/,
      /<price>[^<]+<\/price>/,
      /<pricingFrequency>[^<]+<\/pricingFrequency>/,
      /<numBedrooms>[^<]+<\/numBedrooms>/,
      /<numFullBaths>[^<]+<\/numFullBaths>/,
      /<providerType>[^<]+<\/providerType>/,
    ];

    requiredPatterns.forEach((pattern) => {
      if (!pattern.test(xml)) {
        errors.push(`Missing required listing element matching ${pattern}`);
      }
    });

    if (/<Listing[\s>]/.test(xml)) {
      errors.push('Uses deprecated <Listing> tag - expected lowercase <listing>');
    }
  } else if (!isEmptyFeed) {
    errors.push('Feed must contain <listing> elements or be an empty hotPadsItems document');
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  validateHotPadsFeedXml,
};
