const logger = require('../logger');
/**
 * ------------------------------------------------------------------
 * File: addressHelper.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for addressHelper.
 *
 * Used By:
 * owner.service, unit.service, property.service, auth.service
 * ------------------------------------------------------------------
 */

/**
 * Address parsing and formatting utilities
 * Handles conversion between structured property addresses and flat mailing address fields
 */

/**
 * Parse a property address object into structured mailing address components
 * @param {Object} propertyAddress - Property address object with street, line2, city, state, zip
 * @returns {Object} Structured mailing address with line1, line2, city, state, zipCode
 */
function parsePropertyAddress(propertyAddress) {
  if (!propertyAddress) return null;

  return {
    line1: propertyAddress.street || null,
    line2: propertyAddress.line2 || null,
    city: propertyAddress.city || null,
    state: propertyAddress.state || null,
    zipCode: propertyAddress.zip || null,
  };
}

/**
 * Parse a comma-separated address string into structured components
 * Format: "Street, Line2, City, State, Zip"
 * @param {string} addressString - Comma-separated address string
 * @returns {Object} Structured address with line1, line2, city, state, zipCode
 */
function parseAddressString(addressString) {
  if (!addressString || typeof addressString !== 'string') return null;

  const parts = addressString.split(',').map(p => p.trim()).filter(Boolean);
  
  if (parts.length === 0) return null;

  // Handle different address formats
  // Format 1: "Street, City, State, Zip" (4 parts)
  // Format 2: "Street, Line2, City, State, Zip" (5 parts)
  // Format 3: "Street, City, State" (3 parts)
  
  let line1 = null;
  let line2 = null;
  let city = null;
  let state = null;
  let zipCode = null;

  if (parts.length >= 5) {
    // Full address with line2
    line1 = parts[0];
    line2 = parts[1];
    city = parts[2];
    state = parts[3];
    zipCode = parts[4];
  } else if (parts.length === 4) {
    // Address without line2
    line1 = parts[0];
    city = parts[1];
    state = parts[2];
    zipCode = parts[3];
  } else if (parts.length === 3) {
    // Minimal address
    line1 = parts[0];
    city = parts[1];
    state = parts[2];
  } else if (parts.length === 2) {
    line1 = parts[0];
    city = parts[1];
  } else {
    line1 = parts[0];
  }

  return {
    line1,
    line2,
    city,
    state,
    zipCode,
  };
}

/**
 * Format structured mailing address into a single string
 * @param {Object} mailingAddress - Structured mailing address object
 * @returns {string} Formatted address string
 */
function formatMailingAddressToString(mailingAddress) {
  if (!mailingAddress) return null;

  const parts = [
    mailingAddress.line1,
    mailingAddress.line2,
    mailingAddress.city,
    mailingAddress.state,
    mailingAddress.zipCode
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * Extract flat address fields from structured mailing address
 * @param {Object} mailingAddress - Structured mailing address object
 * @returns {Object} Flat address fields { address, city, state, zip }
 */
function extractFlatAddressFields(mailingAddress) {
  if (!mailingAddress) {
    return {
      address: null,
      city: null,
      state: null,
      zip: null,
    };
  }

  // Combine line1 and line2 for address field
  const addressParts = [mailingAddress.line1, mailingAddress.line2].filter(Boolean);
  
  return {
    address: addressParts.length > 0 ? addressParts.join(', ') : null,
    city: mailingAddress.city || null,
    state: mailingAddress.state || null,
    zip: mailingAddress.zipCode || null,
  };
}

/**
 * Copy property/unit address into owner mailing + flat fields when the owner uses the same address.
 * Skips owners who opted into a separate mailing address (isDifferentMailingAddress === true).
 *
 * @param {Array} ownerIds
 * @param {Object} propertyAddress - { street, line2?, city, state, zip } (Property.address shape)
 * @param {Object|null} [session] - MongoDB session when participating in a transaction
 */
async function updateOwnersMailingAddress(ownerIds, propertyAddress, session = null) {
  if (!ownerIds || ownerIds.length === 0) return;
  if (!propertyAddress) return;

  const User = require('../../shared/modules/users/models/user.model');

  const mailingAddress = parsePropertyAddress(propertyAddress);
  if (!mailingAddress) return;

  const flatAddressFields = extractFlatAddressFields(mailingAddress);

  for (const ownerId of ownerIds) {
    try {
      const findOpts = session ? { session } : {};
      const owner = await User.findById(ownerId, null, findOpts);

      if (!owner) continue;

      if (owner.isDifferentMailingAddress === true) {
        continue;
      }

      owner.mailingAddress = mailingAddress;
      owner.isDifferentMailingAddress = false;
      owner.address = flatAddressFields.address;
      owner.city = flatAddressFields.city;
      owner.state = flatAddressFields.state;
      owner.zipCode = flatAddressFields.zip;

      const saveOpts = session ? { session } : {};
      await owner.save(saveOpts);
    } catch (error) {
      logger.error(`Failed to update mailing address for owner ${ownerId}:`, error.message);
    }
  }
}

module.exports = {
  parsePropertyAddress,
  parseAddressString,
  formatMailingAddressToString,
  extractFlatAddressFields,
  updateOwnersMailingAddress,
};
