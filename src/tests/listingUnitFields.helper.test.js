/**
 * Unit tests for listing unit field enrichment helper.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { enrichListingUnitFieldsFromProperty } = require('../portals/landlord/modules/listing/helpers/listingUnitFields.helper');

describe('enrichListingUnitFieldsFromProperty', () => {
  test('maps bedRooms and bathRoom from matched unitDetails by unitId', () => {
    const listing = {
      _id: 'listing1',
      unitId: 'unit-1',
      unitName: 'Unit 1',
      propertyId: {
        name: 'Test Property',
        unitDetails: [
          { _id: 'unit-1', unitName: 'Unit 1', bedRooms: 4, bathRoom: 4.5, squareFeet: 2500 },
        ],
      },
    };

    const enriched = enrichListingUnitFieldsFromProperty(listing);
    assert.equal(enriched.bedrooms, 4);
    assert.equal(enriched.bathrooms, 4.5);
    assert.equal(enriched.area, 2500);
  });

  test('falls back to unitName match when unitId missing', () => {
    const listing = {
      unitName: 'Unit A',
      propertyId: {
        unitDetails: [
          { _id: 'x1', unitName: 'Unit A', bedRooms: 2, bathRoom: 1 },
        ],
      },
    };

    const enriched = enrichListingUnitFieldsFromProperty(listing);
    assert.equal(enriched.bedrooms, 2);
    assert.equal(enriched.bathrooms, 1);
  });
});
