/**
 * ------------------------------------------------------------------
 * File: mapbox.provider.js
 * Module: Src Shared Modules Address Services
 *
 * Purpose:
 * Backend utility/module providing helper functions for mapbox.provider.
 *
 * Used By:
 * address.controller
 * ------------------------------------------------------------------
 */

const axios = require('axios');

const FORWARD_GEOCODE_URL = 'https://api.mapbox.com/search/geocode/v6/forward';
const REQUEST_TIMEOUT_MS = 8000;

const pick = (obj, key) => (obj && obj[key] ? obj[key] : {});

/**
 * Normalise a Mapbox Geocoding v6 feature into the same shape the frontend
 * already consumes for resolved Google addresses (ResolvedGoogleAddress).
 */
function mapFeatureToResolved(feature) {
  const props = (feature && feature.properties) || {};
  const ctx = props.context || {};

  const addressCtx = pick(ctx, 'address');
  const streetCtx = pick(ctx, 'street');
  const placeCtx = pick(ctx, 'place');
  const regionCtx = pick(ctx, 'region');
  const postcodeCtx = pick(ctx, 'postcode');
  const countryCtx = pick(ctx, 'country');

  const streetFromCtx = [addressCtx.address_number, addressCtx.street_name || streetCtx.name]
    .filter(Boolean)
    .join(' ')
    .trim();

  const street = streetFromCtx || props.name || '';
  const city = placeCtx.name || '';
  // Mapbox returns the full region name (e.g. "California"), matching the
  // full-state-name options the address forms expect.
  const state = regionCtx.name || '';
  const postalCode = String(postcodeCtx.name || '').slice(0, 10);
  const country = String(countryCtx.country_code || countryCtx.name || '').toUpperCase();

  const coords = props.coordinates || {};
  const latitude = typeof coords.latitude === 'number' ? coords.latitude : undefined;
  const longitude = typeof coords.longitude === 'number' ? coords.longitude : undefined;

  const formattedAddress =
    props.full_address || [props.name, props.place_formatted].filter(Boolean).join(', ');

  return {
    formattedAddress,
    street,
    city,
    state,
    postalCode,
    country,
    latitude,
    longitude,
    placeId: props.mapbox_id || '',
  };
}

/**
 * Fetch address suggestions from Mapbox. Each suggestion already embeds the
 * fully resolved address, so the frontend does not need a second "resolve" call
 * (this also keeps request counts to one per search).
 *
 * @param {string} query
 * @param {{ country?: string, limit?: number }} [options]
 * @returns {Promise<Array<{id:string, primaryText:string, secondaryText:string, fullText:string, resolved:object}>>}
 */
async function autocomplete(query, { country = 'us', limit = 6, mode = 'address' } = {}) {
  const token = process.env.MAPBOX_ACCESS_TOKEN;
  if (!token) {
    throw new Error('MAPBOX_ACCESS_TOKEN is not configured');
  }

  const types = mode === 'city' ? 'place' : 'address';

  const { data } = await axios.get(FORWARD_GEOCODE_URL, {
    params: {
      q: query,
      access_token: token,
      country,
      types,
      autocomplete: true,
      limit,
    },
    timeout: REQUEST_TIMEOUT_MS,
  });

  const features = Array.isArray(data && data.features) ? data.features : [];

  return features.map((feature) => {
    const props = (feature && feature.properties) || {};
    const resolved = mapFeatureToResolved(feature);

    if (mode === 'city') {
      const cityName = resolved.city || props.name || '';
      const secondaryText =
        props.place_formatted ||
        [resolved.state, resolved.postalCode].filter(Boolean).join(', ');
      const fullText = props.full_address || [cityName, resolved.state].filter(Boolean).join(', ');

      return {
        id: props.mapbox_id || '',
        primaryText: cityName,
        secondaryText,
        fullText,
        resolved: { ...resolved, street: '', city: cityName },
      };
    }

    const primaryText = props.name || resolved.street || resolved.formattedAddress || '';
    const secondaryText =
      props.place_formatted ||
      [resolved.city, resolved.state, resolved.postalCode].filter(Boolean).join(', ');
    const fullText = props.full_address || resolved.formattedAddress || '';

    return {
      id: props.mapbox_id || '',
      primaryText,
      secondaryText,
      fullText,
      resolved,
    };
  });
}

module.exports = { autocomplete, mapFeatureToResolved };
