/**
 * ------------------------------------------------------------------
 * File: listingUnitFields.helper.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for listingUnitFields.helper.
 *
 * Used By:
 * zillowFeedFileService, listing.service, syndication.service
 * ------------------------------------------------------------------
 */

/**
 * Enriches listing bed/bath/area from property unitDetails.
 * Bedrooms/bathrooms are not persisted on Listing - they live on the property unit.
 */

const LISTING_PROPERTY_UNIT_SELECT = [
  'name',
  'address.street',
  'address.city',
  'address.state',
  'address.zip',
  'address.country',
  'propertyType',
  'ownerEmail',
  'ownerPhone',
  'unitDetails._id',
  'unitDetails.unitName',
  'unitDetails.bedRooms',
  'unitDetails.bathRoom',
  'unitDetails.squareFeet',
].join(' ');

/**
 * enrich Listing Unit Fields From Property
 *
 * Performs logic operations for enrichListingUnitFieldsFromProperty.
 *
 * @param listing - Request/input argument
 * @returns Operations result
 */
function enrichListingUnitFieldsFromProperty(listing) {
  if (!listing) return listing;

  const property = listing.propertyId;
  const details =
    property && typeof property === 'object' && Array.isArray(property.unitDetails)
      ? property.unitDetails
      : [];

  let subdocument =
    listing.unitId && details.length
      ? details.find((unit) => unit && unit._id && String(unit._id) === String(listing.unitId))
      : null;

  if (!subdocument && listing.unitName && details.length) {
    subdocument = details.find(
      (unit) =>
        unit &&
        unit.unitName &&
        String(unit.unitName).trim().toLowerCase() === String(listing.unitName).trim().toLowerCase()
    );
  }

  if (!subdocument && details.length === 1) {
    subdocument = details[0];
  }

  const output = { ...listing };
  if (subdocument) {
    if (subdocument.unitName != null) output.unitName = subdocument.unitName;
    if (subdocument.bedRooms != null && subdocument.bedRooms !== '') {
      output.bedrooms = subdocument.bedRooms;
    }
    if (subdocument.bathRoom != null && subdocument.bathRoom !== '') {
      output.bathrooms = subdocument.bathRoom;
    }
    if (subdocument.squareFeet != null && subdocument.squareFeet !== '') {
      output.area = subdocument.squareFeet;
    }
  }

  if (
    output.propertyId &&
    typeof output.propertyId === 'object' &&
    output.propertyId.unitDetails !== undefined
  ) {
    const { unitDetails, ...rest } = output.propertyId;
    output.propertyId = rest;
  }

  return output;
}

module.exports = {
  LISTING_PROPERTY_UNIT_SELECT,
  enrichListingUnitFieldsFromProperty,
};
