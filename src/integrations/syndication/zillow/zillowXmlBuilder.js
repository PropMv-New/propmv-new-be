/**
 * ------------------------------------------------------------------
 * File: zillowXmlBuilder.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for zillowXmlBuilder.
 *
 * Used By:
 * zillow.routes, zillowFeedFileService, zillowRealtimeApiClient, ZillowSyndicationProvider
 * ------------------------------------------------------------------
 */

const { escapeXmlText, wrapCdata, containsUnderscore } = require('../../../common/utils/xmlEntityEscaper');
const { ZillowValidationError } = require('./zillow.errors');
const { ClockService, DateUtil } = require('../../../common/date');
const {
  ZILLOW_LISTING_TYPE,
  ZILLOW_PROPERTY_TYPE,
  INTERNAL_PROPERTY_TYPE_MAP,
  ZILLOW_AMENITY_TAG_MAP,
  ZILLOW_LISTING_TAG_TYPE,
  ZILLOW_PARKING_TYPE,
  PAYMENT_FREQUENCY_TO_ZILLOW,
} = require('./zillow.constants');
const { mapListingFeesToZillow, buildFeesXml } = require('./zillowFeeMapper');

/**
 * Strips dashes/underscores from IDs - Zillow silently strips underscores.
 */
function toFeedListingId(listing) {
  const raw = listing.syndication?.zillow?.feedListingId
    || listing._id?.toString()
    || listing.id;
  return String(raw).replace(/[-_]/g, '');
}

/**
 * to Iso Utc
 *
 * Performs logic operations for toIsoUtc.
 *
 * @param date - Request/input argument
 * @returns Operations result
 */
function toIsoUtc(date) {
  const iso = DateUtil.toISO(date ? DateUtil.toUTC(date) : ClockService.now());
  if (!iso) return DateUtil.toISO(ClockService.now()).replace(/\.\d{3}Z$/, '.000Z');
  return iso.replace(/\.\d{3}Z$/, '.000Z');
}

/**
 * to Date Only
 *
 * Performs logic operations for toDateOnly.
 *
 * @param date - Request/input argument
 * @returns Operations result
 */
function toDateOnly(date) {
  if (!date) return '';
  return DateUtil.toISO(date)?.slice(0, 10) || '';
}

/**
 * resolve Property Type
 *
 * Performs logic operations for resolvePropertyType.
 *
 * @param listing - Request/input argument
 * @returns Operations result
 */
function resolvePropertyType(listing) {
  const raw = (listing.propertyType || listing.zillowPropertyType || 'house').toLowerCase();
  const mapped = INTERNAL_PROPERTY_TYPE_MAP[raw] || ZILLOW_PROPERTY_TYPE.HOUSE;
  return String(mapped).toUpperCase();
}

/**
 * resolve Street
 *
 * Performs logic operations for resolveStreet.
 *
 * @param listing - Request/input argument
 * @returns Operations result
 */
function resolveStreet(listing) {
  if (listing.street) return listing.street;
  if (listing.address) {
    return String(listing.address).split(',')[0].trim();
  }
  if (listing.propertyId && typeof listing.propertyId === 'object' && listing.propertyId.address) {
    return listing.propertyId.address.street || '';
  }
  return '';
}

/**
 * resolve City State Zip
 *
 * Performs logic operations for resolveCityStateZip.
 *
 * @param listing - Request/input argument
 * @returns Operations result
 */
function resolveCityStateZip(listing) {
  const city = listing.city
    || (listing.propertyId?.address?.city)
    || '';
  const state = listing.state
    || (listing.propertyId?.address?.state)
    || '';
  const zip = listing.zip
    || (listing.propertyId?.address?.zip)
    || '';
  return { city, state, zip };
}

/**
 * resolve Bath Counts
 *
 * Performs logic operations for resolveBathCounts.
 *
 * @param listing - Request/input argument
 * @returns Operations result
 */
function resolveBathCounts(listing) {
  if (listing.numFullBaths != null || listing.numHalfBaths != null) {
    return {
      numFullBaths: listing.numFullBaths ?? 0,
      numHalfBaths: listing.numHalfBaths ?? 0,
    };
  }

  const baths = Number(listing.bathrooms ?? listing.numFullBaths ?? 0);
  const full = Math.floor(baths);
  const half = baths % 1 >= 0.5 ? 1 : 0;
  return { numFullBaths: full, numHalfBaths: half };
}

/**
 * resolve Pricing Frequency
 *
 * Performs logic operations for resolvePricingFrequency.
 *
 * @param listing - Request/input argument
 * @returns Operations result
 */
function resolvePricingFrequency(listing) {
  const raw = String(listing.paymentFrequency || listing.pricingFrequency || 'Monthly').toLowerCase();
  return PAYMENT_FREQUENCY_TO_ZILLOW[raw] || 'MONTH';
}

/**
 * resolve Lease Term
 *
 * Performs logic operations for resolveLeaseTerm.
 *
 * @param listing - Request/input argument
 * @returns Operations result
 */
function resolveLeaseTerm(listing) {
  if (listing.leaseTerm) return listing.leaseTerm;
  const leaseType = String(listing.leaseType || '').toLowerCase();
  if (leaseType.includes('month')) return 'Month-to-Month';
  if (leaseType.includes('short')) return 'Short Term';
  return '12 Months';
}

/**
 * resolve Parking Type
 *
 * Performs logic operations for resolveParkingType.
 *
 * @param listing - Request/input argument
 * @returns Operations result
 */
function resolveParkingType(listing) {
  if (listing.parkingType) return listing.parkingType;
  const amenities = (listing.amenities || []).map((a) => String(a).toLowerCase());
  if (amenities.some((a) => a.includes('garage'))) return ZILLOW_PARKING_TYPE.GARAGE_ATTACHED;
  if (amenities.some((a) => a.includes('carport') || a.includes('covered parking'))) {
    return ZILLOW_PARKING_TYPE.COVERED_LOT;
  }
  if (amenities.some((a) => a.includes('assigned parking') || a.includes('parking'))) {
    return ZILLOW_PARKING_TYPE.SURFACE_LOT;
  }
  return ZILLOW_PARKING_TYPE.GARAGE_ATTACHED;
}

/**
 * map Pet Policies To Zillow
 *
 * Performs logic operations for mapPetPoliciesToZillow.
 *
 * @param petPolicies - Request/input argument
 * @returns Operations result
 */
function mapPetPoliciesToZillow(petPolicies = []) {
  const pets = [];
  const policies = petPolicies.map((p) => String(p).toLowerCase());

  const catsAllowed = policies.some((p) => p.includes('cat'));
  pets.push({ petType: 'cats', allowed: catsAllowed });

  const dogPolicies = policies.filter((p) => p.includes('dog'));
  if (dogPolicies.length) {
    let petSize = 'medium';
    if (dogPolicies.some((p) => p.includes('small'))) petSize = 'small';
    else if (dogPolicies.some((p) => p.includes('large'))) petSize = 'large';
    pets.push({ petType: 'dogs', petSize, allowed: true });
  } else if (policies.some((p) => p.includes('no pet') || p.includes('no pets'))) {
    pets.push({ petType: 'dogs', allowed: false });
  }

  return pets;
}

/**
 * build Pets Xml
 *
 * Performs logic operations for buildPetsXml.
 *
 * @param petPolicies - Request/input argument
 * @param listingPets - Request/input argument
 * @returns Operations result
 */
function buildPetsXml(petPolicies = [], listingPets = null) {
  const pets = listingPets?.length
    ? listingPets
    : mapPetPoliciesToZillow(petPolicies);

  if (!pets.length) return '';

  const petXml = pets.map((pet) => {
    const lines = [`      <pet>`, `        <petType>${escapeXmlText(pet.petType)}</petType>`];
    if (pet.petSize) {
      lines.push(`        <petSize>${escapeXmlText(pet.petSize)}</petSize>`);
    }
    lines.push(`        <allowed>${pet.allowed === false ? 'false' : 'true'}</allowed>`, '      </pet>');
    return lines.join('\n');
  }).join('\n');

  return `    <pets>\n${petXml}\n    </pets>`;
}

/**
 * amenity To Tag
 *
 * Performs logic operations for amenityToTag.
 *
 * @param amenity - Request/input argument
 * @returns Operations result
 */
function amenityToTag(amenity) {
  const key = String(amenity).toLowerCase();
  return ZILLOW_AMENITY_TAG_MAP[key] || String(amenity).replace(/\s+/g, '');
}

/**
 * classify Amenity Tag
 *
 * Performs logic operations for classifyAmenityTag.
 *
 * @param amenity - Request/input argument
 * @returns Operations result
 */
function classifyAmenityTag(amenity) {
  const lower = String(amenity).toLowerCase();
  if (lower.includes('laundry') && lower.includes('unit')) {
    return { type: ZILLOW_LISTING_TAG_TYPE.LAUNDRY, tag: 'IN_UNIT' };
  }
  if (lower.includes('laundry') && (lower.includes('hookup') || lower.includes('hook-up'))) {
    return { type: ZILLOW_LISTING_TAG_TYPE.LAUNDRY, tag: 'HOOKUPS' };
  }
  if (lower.includes('laundry')) {
    return { type: ZILLOW_LISTING_TAG_TYPE.LAUNDRY, tag: 'IN_UNIT' };
  }

  const modelAmenities = ['dishwasher', 'washer', 'dryer', 'ceiling fan', 'refrigerator', 'disposal'];
  if (modelAmenities.some((m) => lower.includes(m))) {
    if (lower.includes('washer') || lower.includes('dryer')) {
      return { type: ZILLOW_LISTING_TAG_TYPE.MODEL_AMENITY, tag: 'WasherDryer' };
    }
    if (lower.includes('ceiling fan')) {
      return { type: ZILLOW_LISTING_TAG_TYPE.MODEL_AMENITY, tag: 'CeilingFan' };
    }
    return { type: ZILLOW_LISTING_TAG_TYPE.MODEL_AMENITY, tag: amenityToTag(amenity) };
  }

  return { type: ZILLOW_LISTING_TAG_TYPE.PROPERTY_AMENITY, tag: amenityToTag(amenity) };
}

/**
 * build Listing Tags Xml
 *
 * Performs logic operations for buildListingTagsXml.
 *
 * @param amenities - Request/input argument
 * @param listingTags - Request/input argument
 * @returns Operations result
 */
function buildListingTagsXml(amenities = [], listingTags = []) {
  const tags = [];

  if (listingTags.length) {
    listingTags.forEach((entry) => {
      tags.push(
        `    <listingTag type="${escapeXmlText(entry.type)}"><tag>${escapeXmlText(entry.tag)}</tag></listingTag>`
      );
    });
  } else {
    (amenities || []).forEach((amenity) => {
      const classified = classifyAmenityTag(amenity);
      tags.push(
        `    <listingTag type="${escapeXmlText(classified.type)}"><tag>${escapeXmlText(classified.tag)}</tag></listingTag>`
      );
    });
  }

  return tags.join('\n');
}

/**
 * build Photos Xml
 *
 * Performs logic operations for buildPhotosXml.
 *
 * @param listing - Request/input argument
 * @returns Operations result
 */
function buildPhotosXml(listing) {
  const images = listing.images || listing.listingPhotos || [];
  if (!images.length) return '';

  return images.map((img, index) => {
    let url = '';
    if (typeof img === 'string') url = img;
    else if (img.source) url = img.source;
    else if (img.url) url = img.url;
    else if (img.documentMetaDataId && typeof img.documentMetaDataId === 'object') {
      url = img.documentMetaDataId.s3Location || img.documentMetaDataId.key || '';
    }
    if (!url) return '';

    const label = img.label || (index === 0 || img.isCover ? 'Front Exterior' : `Photo ${index + 1}`);
    const caption = img.caption || label;

    return [
      `    <listingPhoto source="${escapeXmlText(url)}">`,
      `      <label>${escapeXmlText(label)}</label>`,
      `      <caption>${escapeXmlText(caption)}</caption>`,
      '    </listingPhoto>',
    ].join('\n');
  }).filter(Boolean).join('\n');
}

/**
 * validate Model Names Unique
 *
 * Performs logic operations for validateModelNamesUnique.
 *
 * @param models - Request/input argument
 * @returns Operations result
 */
function validateModelNamesUnique(models = []) {
  const names = new Set();
  for (const model of models) {
    const name = model.name || model.modelName;
    if (!name) continue;
    const normalized = String(name).trim().toLowerCase();
    if (names.has(normalized)) {
      throw new ZillowValidationError('Floorplan/model names must be unique within a listing', {
        field: 'models',
        duplicate: name,
      });
    }
    names.add(normalized);
  }
}

/**
 * build Company Xml
 *
 * Performs logic operations for buildCompanyXml.
 *
 * @param config - Request/input argument
 * @returns Operations result
 */
function buildCompanyXml(config = {}) {
  const companyId = config.companyId || '';
  if (!companyId) return '';

  const lines = [`  <Company id="${escapeXmlText(companyId)}">`];
  if (config.companyName) lines.push(`    <name>${escapeXmlText(config.companyName)}</name>`);
  if (config.companyWebsite) lines.push(`    <website>${escapeXmlText(config.companyWebsite)}</website>`);
  if (config.companyCity) lines.push(`    <city>${escapeXmlText(config.companyCity)}</city>`);
  if (config.companyState) lines.push(`    <state>${escapeXmlText(config.companyState)}</state>`);
  lines.push('  </Company>');
  return lines.join('\n');
}

/**
 * Builds a single <listing> XML element for HotPads v2.1.
 */
function buildListingXml(listing, config = {}) {
  const companyId = config.companyId || listing.companyId || '';
  const feedId = toFeedListingId(listing);
  const listingType = listing.type || listing.zillowListingType || ZILLOW_LISTING_TYPE.RENTAL;
  const propertyType = resolvePropertyType(listing);
  const { city, state, zip } = resolveCityStateZip(listing);
  const street = resolveStreet(listing);
  const hideStreet = listing.hideStreet === true ? 'true' : 'false';
  const fees = mapListingFeesToZillow(listing, config);
  const { numFullBaths, numHalfBaths } = resolveBathCounts(listing);

  if (containsUnderscore(feedId)) {
    // Zillow strips underscores silently - validation warns upstream
  }

  const models = listing.models || listing.floorplans || [];
  if (models.length) validateModelNamesUnique(models);

  const contactEmail = listing.contactEmail || config.contactEmail || '';
  const contactPhone = listing.contactPhone || config.contactPhone || '';
  const contactName = listing.contactName || config.contactName || 'Leasing Office';
  const contactMethodPreference = listing.contactMethodPreference || config.contactMethodPreference || 'Email';

  const optionalLines = [];
  if (listing.description) {
    optionalLines.push(`    <description>${wrapCdata(listing.description)}</description>`);
  }

  optionalLines.push(`    <leaseTerm>${escapeXmlText(resolveLeaseTerm(listing))}</leaseTerm>`);
  optionalLines.push(`    <isFurnished>${listing.isFurnished ? 'true' : 'false'}</isFurnished>`);
  optionalLines.push(`    <smokingAllowed>${listing.smokingAllowed ? 'true' : 'false'}</smokingAllowed>`);

  const parkingType = resolveParkingType(listing);
  optionalLines.push(`    <parking>\n      <parkingType>${escapeXmlText(parkingType)}</parkingType>\n    </parking>`);

  const costDesc = listing.costAndFeeDescription
    || config.costAndFeeDescription
    || 'Fees are subject to change. See lease for full details.';
  optionalLines.push(`    <costAndFeeDescription>${wrapCdata(costDesc)}</costAndFeeDescription>`);

  if (listing.virtualTourVideoUrl || listing.virtualTourUrl) {
    const tours = [listing.virtualTourVideoUrl, listing.virtualTourUrl].filter(Boolean);
    tours.forEach((url) => optionalLines.push(`    <virtualTourUrl>${escapeXmlText(url)}</virtualTourUrl>`));
  }

  const listingName = listing.listingHeadline || listing.name || street || 'Rental Listing';
  const squareFeet = listing.area ?? listing.squareFeet ?? 0;
  const dateAvailable = toDateOnly(listing.availableDate || listing.dateAvailable);

  return `<listing id="${escapeXmlText(feedId)}" type="${escapeXmlText(listingType)}" companyId="${escapeXmlText(companyId)}" propertyType="${escapeXmlText(propertyType)}">
    <name>${escapeXmlText(listingName)}</name>
    <street hide="${hideStreet}">${escapeXmlText(street)}</street>
    <city>${escapeXmlText(city)}</city>
    <state>${escapeXmlText(state)}</state>
    <zip>${escapeXmlText(zip)}</zip>
    <lastUpdated>${toIsoUtc(listing.updatedAt || listing.lastUpdated)}</lastUpdated>
    <contactName>${escapeXmlText(contactName)}</contactName>
    <contactEmail>${escapeXmlText(contactEmail)}</contactEmail>
    <contactPhone>${escapeXmlText(String(contactPhone).replace(/\D/g, ''))}</contactPhone>
    <contactMethodPreference>${escapeXmlText(contactMethodPreference)}</contactMethodPreference>
${optionalLines.join('\n')}
${buildPetsXml(listing.petPolicies, listing.pets)}
${buildFeesXml(fees, escapeXmlText)}
${buildListingTagsXml(listing.amenities, listing.listingTags)}
${buildPhotosXml(listing)}
    <price>${escapeXmlText(listing.rentalAmount || listing.price)}</price>
    <pricingFrequency>${escapeXmlText(resolvePricingFrequency(listing))}</pricingFrequency>
    <numBedrooms>${escapeXmlText(listing.bedrooms ?? listing.numBedrooms ?? 0)}</numBedrooms>
    <numFullBaths>${escapeXmlText(numFullBaths)}</numFullBaths>
    <numHalfBaths>${escapeXmlText(numHalfBaths)}</numHalfBaths>
    <squareFeet>${escapeXmlText(squareFeet)}</squareFeet>
    <dateAvailable>${escapeXmlText(dateAvailable)}</dateAvailable>
    <providerType>${escapeXmlText(listing.providerType || config.providerType || 'propertyManager')}</providerType>
</listing>`;
}

/**
 * Builds full hotPadsItems document for one or more listings.
 */
function buildHotPadsFeedXml(listings = [], config = {}) {
  const includeCompany = config.includeCompany !== false;
  const companyXml = includeCompany ? buildCompanyXml(config) : '';
  const listingXml = listings.map((listing) => buildListingXml(listing, config)).join('\n\n');
  const body = [companyXml, listingXml].filter(Boolean).join('\n\n');
  return `<?xml version="1.0" encoding="UTF-8" ?>\n<hotPadsItems version="2.1">\n${body}\n</hotPadsItems>`;
}

/**
 * build Empty Feed Xml
 *
 * Performs logic operations for buildEmptyFeedXml.
 *
 * @returns Operations result
 */
function buildEmptyFeedXml() {
  return '<?xml version="1.0" encoding="UTF-8" ?>\n<hotPadsItems version="2.1"></hotPadsItems>';
}

/**
 * Normalizes a PropMv listing document for Zillow XML generation.
 */
function normalizeListingForZillow(listing, config = {}) {
  const property = listing.propertyId && typeof listing.propertyId === 'object'
    ? listing.propertyId
    : null;

  return {
    ...listing,
    contactEmail: listing.contactEmail || property?.ownerEmail || config.contactEmail,
    contactPhone: listing.contactPhone || property?.ownerPhone || config.contactPhone,
    contactName: listing.contactName || property?.ownerName || config.contactName,
    propertyType: listing.propertyType || property?.propertyType,
    address: listing.address || property?.address?.street,
    city: listing.city || property?.address?.city,
    state: listing.state || property?.address?.state,
    zip: listing.zip || property?.address?.zip,
  };
}

/**
 * extract Listing Ids From Feed Xml
 *
 * Performs logic operations for extractListingIdsFromFeedXml.
 *
 * @param xml - Request/input argument
 * @returns Operations result
 */
function extractListingIdsFromFeedXml(xml = '') {
  const ids = [];
  const regex = /<listing id="([^"]+)"/g;
  let match = regex.exec(xml);
  while (match) {
    ids.push(match[1]);
    match = regex.exec(xml);
  }
  return ids;
}

module.exports = {
  toFeedListingId,
  buildListingXml,
  buildHotPadsFeedXml,
  buildEmptyFeedXml,
  buildCompanyXml,
  normalizeListingForZillow,
  extractListingIdsFromFeedXml,
  toIsoUtc,
};
