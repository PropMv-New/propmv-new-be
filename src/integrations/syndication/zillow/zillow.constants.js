/**
 * ------------------------------------------------------------------
 * File: zillow.constants.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for zillow.constants.
 *
 * Used By:
 * zillowFeeMapper, zillowXmlBuilder
 * ------------------------------------------------------------------
 */

/**
 * Zillow HotPads XML v2.1 enumerations from the Rental Listing Bulk Feed Guide.
 */

const ZILLOW_LISTING_TYPE = Object.freeze({
  RENTAL: 'RENTAL',
  ROOM: 'ROOM',
});

const ZILLOW_PROPERTY_TYPE = Object.freeze({
  CONDO: 'CONDO',
  HOUSE: 'HOUSE',
  TOWNHOUSE: 'TOWNHOUSE',
  DIVIDED: 'DIVIDED',
  MEDIUM: 'MEDIUM',
  LARGE: 'LARGE',
  COMMUNITY: 'COMMUNITY',
});

const ZILLOW_FEE_CALCULATION_TYPE = Object.freeze({
  FLAT_FEE: 'flatFee',
  RANGE: 'range',
  RANGE_PER_ITEM: 'rangePerItem',
  MULTIPLIER: 'multiplier',
  PERCENTAGE: 'percentage',
  STEPPED: 'stepped',
  VARIABLE_USAGE_BASED: 'variableUsageBased',
});

const ZILLOW_FEE_TYPE = Object.freeze({
  APPLICATION_FEE: 'applicationFee',
  ADMIN_FEE: 'adminFee',
  SECURITY_DEPOSIT: 'securityDeposit',
  PET_FEE: 'petFee',
  PET_DEPOSIT: 'petDeposit',
  PET_RENT: 'petRent',
  PARKING_FEE: 'parkingFee',
  UTILITY_FEE: 'utilityFee',
  CUSTOM_FEE: 'customFee',
});

const ZILLOW_FEE_TIMING_TYPE = Object.freeze({
  MOVE_IN: 'moveIn',
  MONTHLY: 'monthly',
  ANNUAL: 'annual',
  ONE_TIME: 'oneTime',
});

const ZILLOW_FEE_REQUIREMENT_TYPE = Object.freeze({
  MANDATORY: 'mandatory',
  OPTIONAL: 'optional',
  INCLUDED: 'included',
  SITUATIONAL: 'situational',
});

const ZILLOW_FEE_REFUNDABLE_TYPE = Object.freeze({
  REFUNDABLE: 'refundable',
  NON_REFUNDABLE: 'nonRefundable',
});

const ZILLOW_LISTING_TAG_TYPE = Object.freeze({
  PROPERTY_AMENITY: 'PROPERTY_AMENITY',
  MODEL_AMENITY: 'MODEL_AMENITY',
  LAUNDRY: 'LAUNDRY',
  YEAR_BUILT: 'YEAR_BUILT',
  PARKING: 'PARKING',
});

const ZILLOW_PARKING_TYPE = Object.freeze({
  GARAGE_ATTACHED: 'garageAttached',
  SURFACE_LOT: 'surfaceLot',
  COVERED_LOT: 'coveredLot',
  GARAGE: 'garage',
  CARPORT: 'carport',
  STREET: 'street',
  OFF_STREET: 'offStreet',
  NONE: 'none',
});

const PAYMENT_FREQUENCY_TO_ZILLOW = Object.freeze({
  monthly: 'MONTH',
  'bi-monthly': 'MONTH',
  weekly: 'WEEK',
  'bi-weekly': 'WEEK',
  quarterly: 'MONTH',
  'bi-annual': 'MONTH',
  annually: 'MONTH',
  custom: 'MONTH',
});

/** Internal property type → Zillow propertyType */
const INTERNAL_PROPERTY_TYPE_MAP = {
  condo: ZILLOW_PROPERTY_TYPE.CONDO,
  house: ZILLOW_PROPERTY_TYPE.HOUSE,
  townhouse: ZILLOW_PROPERTY_TYPE.TOWNHOUSE,
  apartment: ZILLOW_PROPERTY_TYPE.CONDO,
  duplex: ZILLOW_PROPERTY_TYPE.DIVIDED,
  'multi-family': ZILLOW_PROPERTY_TYPE.MEDIUM,
  multifamily: ZILLOW_PROPERTY_TYPE.MEDIUM,
};

const ZILLOW_AMENITY_TAG_MAP = {
  'air conditioning': 'AirConditioning',
  dishwasher: 'Dishwasher',
  'laundry facilities': 'Laundry',
  'in-unit laundry': 'IN_UNIT',
  balcony: 'Deck',
  deck: 'Deck',
  lawn: 'Lawn',
  pool: 'Pool',
  gym: 'FitnessCenter',
  'assigned parking': 'Parking',
  'ceiling fan': 'CeilingFan',
};

module.exports = {
  ZILLOW_LISTING_TYPE,
  ZILLOW_PROPERTY_TYPE,
  ZILLOW_FEE_CALCULATION_TYPE,
  ZILLOW_FEE_TYPE,
  ZILLOW_FEE_TIMING_TYPE,
  ZILLOW_FEE_REQUIREMENT_TYPE,
  ZILLOW_FEE_REFUNDABLE_TYPE,
  ZILLOW_LISTING_TAG_TYPE,
  ZILLOW_PARKING_TYPE,
  PAYMENT_FREQUENCY_TO_ZILLOW,
  INTERNAL_PROPERTY_TYPE_MAP,
  ZILLOW_AMENITY_TAG_MAP,
};
