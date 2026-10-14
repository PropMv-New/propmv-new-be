/**
 * Unit tests for Zillow XML builder using dummy listing data.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildHotPadsFeedXml,
  buildEmptyFeedXml,
  buildListingXml,
  toFeedListingId,
  normalizeListingForZillow,
} = require('../integrations/syndication/zillow/zillowXmlBuilder');
const { ZillowValidationError } = require('../integrations/syndication/zillow/zillow.errors');
const { validateHotPadsFeedXml } = require('../integrations/syndication/zillow/mock/hotPadsXmlValidator');

const dummyListing = {
  _id: '507f1f77bcf86cd799439011',
  propertyType: 'house',
  listingHeadline: 'Charming Home on Main St',
  address: '123 Main St',
  city: 'Austin',
  state: 'TX',
  zip: '78701',
  rentalAmount: 2500,
  securityDeposit: 2500,
  bedrooms: 2,
  bathrooms: 1,
  area: 1200,
  description: 'Spacious home with yard & patio',
  petPolicies: ['Cats Allowed', 'Small Dogs Allowed'],
  amenities: ['Air Conditioning', 'Dishwasher', 'Lawn'],
  availableDate: new Date('2026-08-01'),
  contactEmail: 'landlord@example.com',
  contactPhone: '5125550100',
  updatedAt: new Date('2025-06-01T12:00:00.000Z'),
  images: [
    {
      isCover: true,
      documentMetaDataId: { s3Location: 'https://cdn.example.com/photo1.jpg' },
    },
  ],
};

const dummyConfig = {
  companyId: 'TESTCOMPANY123',
  companyName: 'Test Rentals LLC',
  companyWebsite: 'https://www.testrentalsllc.com',
  companyCity: 'Austin',
  companyState: 'TX',
  contactEmail: 'fallback@example.com',
  contactPhone: '8005550100',
  contactName: 'Leasing Office',
};

describe('zillowXmlBuilder', () => {
  test('toFeedListingId strips dashes from ObjectId', () => {
    assert.equal(toFeedListingId({ _id: '507f1f77bcf86cd799439011' }), '507f1f77bcf86cd799439011');
  });

  test('buildHotPadsFeedXml produces HotPads v2.1 format', () => {
    const normalized = normalizeListingForZillow(dummyListing, dummyConfig);
    const xml = buildHotPadsFeedXml([normalized], dummyConfig);

    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8" \?>/);
    assert.match(xml, /<hotPadsItems version="2\.1">/);
    assert.match(xml, /<Company id="TESTCOMPANY123">/);
    assert.match(xml, /<listing id="507f1f77bcf86cd799439011"/);
    assert.match(xml, /companyId="TESTCOMPANY123"/);
    assert.match(xml, /propertyType="HOUSE"/);
    assert.match(xml, /<name>Charming Home on Main St<\/name>/);
    assert.match(xml, /<city>Austin<\/city>/);
    assert.match(xml, /<price>2500<\/price>/);
    assert.match(xml, /<pricingFrequency>MONTH<\/pricingFrequency>/);
    assert.match(xml, /<numBedrooms>2<\/numBedrooms>/);
    assert.match(xml, /<numFullBaths>1<\/numFullBaths>/);
    assert.match(xml, /<providerType>propertyManager<\/providerType>/);
    assert.match(xml, /<listingPhoto source="https:\/\/cdn\.example\.com\/photo1\.jpg">/);
    assert.match(xml, /<feeType>securityDeposit<\/feeType>/);
    assert.match(xml, /<feeType>applicationFee<\/feeType>/);
    assert.match(xml, /<!\[CDATA\[Spacious home with yard & patio\]\]>/);

    const validation = validateHotPadsFeedXml(xml);
    assert.equal(validation.valid, true, validation.errors.join('; '));
  });

  test('uses multiplier security deposit when deposit equals rent', () => {
    const xml = buildListingXml(dummyListing, dummyConfig);
    assert.match(xml, /valueType="multiplier"/);
    assert.match(xml, /operandType="rent"/);
  });

  test('escapes ampersand in attributes and uses CDATA for description', () => {
    const xml = buildListingXml(dummyListing, dummyConfig);
    assert.doesNotMatch(xml, /<description>[^<]*&[^<]*<\/description>/);
    assert.match(xml, /CDATA/);
  });

  test('buildEmptyFeedXml returns empty hotPadsItems for removals', () => {
    const xml = buildEmptyFeedXml();
    assert.equal(
      xml,
      '<?xml version="1.0" encoding="UTF-8" ?>\n<hotPadsItems version="2.1"></hotPadsItems>'
    );
    assert.equal(validateHotPadsFeedXml(xml).valid, true);
  });
});
