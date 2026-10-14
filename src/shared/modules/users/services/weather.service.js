/**
 * ------------------------------------------------------------------
 * File: weather.service.js
 * Module: Users Module
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * weather.controller
 * ------------------------------------------------------------------
 */

const axios = require('axios');
const { formatDateInAppTimezone } = require('../../../../common/helpers/hoaBillingDates');

/**
 * Fetches weather data for the last 7 days for a given US address.
 * @param {string} address - US address string or ZIP code
 * @returns {Promise<Object>} Weather data and location info
 * @throws {Error} On invalid address or API failure
 */
const ADDRESS_MAX_LEN = 500;
const ADDRESS_RE = /^[\w\s.,#'&()/-]{1,500}$/;

function assertSafeCoordinate(value, name, min, max) {
  const n = parseFloat(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`Weather service: invalid ${name} value returned by geocoder`);
  }
  return n;
}

async function getWeatherForAddress(address) {
  if (!address) {
    throw new Error('Missing address query parameter');
  }

  const trimmed = String(address).trim();
  if (trimmed.length > ADDRESS_MAX_LEN || !ADDRESS_RE.test(trimmed)) {
    throw new Error('Invalid address format');
  }

  try {
    // 1. Geocode address using Nominatim (OpenStreetMap)
    const geoUrl = `https://nominatim.openstreetmap.org/search?format=json&countrycodes=us&q=${encodeURIComponent(trimmed)}`;
    const geoRes = await axios.get(geoUrl, {
      headers: {
        'User-Agent': 'node-weather-service'
      }
    });

    if (!geoRes.data || geoRes.data.length === 0) {
      throw new Error('Address not found');
    }

    const location = geoRes.data[0];
    const lat = assertSafeCoordinate(location.lat, 'latitude', -90, 90);
    const lon = assertSafeCoordinate(location.lon, 'longitude', -180, 180);
    const formattedLocation = location.display_name;

    // 2. Get weather data for the past 7 days from Open-Meteo
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&past_days=7&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`;
    const weatherRes = await axios.get(weatherUrl);

    if (!weatherRes.data || !weatherRes.data.daily) {
      throw new Error('Weather data not available');
    }

    // 3. Format the response with detailed day-wise weather
    const formatDate = (dateStr) => formatDateInAppTimezone(dateStr, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const formatTemp = (celsius) => ({
      celsius: celsius,
      fahrenheit: ((celsius * 9/5) + 32).toFixed(1)
    });

    const daily = weatherRes.data.daily.time.map((date, i) => {
      const maxTemp = weatherRes.data.daily.temperature_2m_max[i];
      const minTemp = weatherRes.data.daily.temperature_2m_min[i];
      const rain = weatherRes.data.daily.precipitation_sum[i];
      
      return {
        date: formatDate(date),
        iso_date: date,
        temperature: {
          maximum: formatTemp(maxTemp),
          minimum: formatTemp(minTemp),
          range: `${minTemp}°C to ${maxTemp}°C (${((minTemp * 9/5) + 32).toFixed(1)}°F to ${((maxTemp * 9/5) + 32).toFixed(1)}°F)`
        },
        precipitation: {
          amount: rain,
          description: rain === 0 ? 'No precipitation' :
                      rain < 1 ? 'Light precipitation' :
                      rain < 5 ? 'Moderate precipitation' :
                      'Heavy precipitation'
        },
        summary: `${formatDate(date)}: Temperature ranged from ${minTemp}°C (${((minTemp * 9/5) + 32).toFixed(1)}°F) to ${maxTemp}°C (${((maxTemp * 9/5) + 32).toFixed(1)}°F) with ${rain}mm of precipitation`
      };
    }).reverse(); // Most recent day first

    return {
      address,
      location: formattedLocation,
      coordinates: {
        latitude: parseFloat(lat),
        longitude: parseFloat(lon)
      },
      daily_weather: daily,
      summary: {
        period: `Last 7 days (${formatDate(daily[daily.length-1].iso_date)} to ${formatDate(daily[0].iso_date)})`,
        location_full: formattedLocation,
        total_precipitation: daily.reduce((sum, day) => sum + day.precipitation.amount, 0).toFixed(1) + 'mm',
        avg_max_temp: formatTemp(daily.reduce((sum, day) => sum + day.temperature.maximum.celsius, 0) / daily.length),
        avg_min_temp: formatTemp(daily.reduce((sum, day) => sum + day.temperature.minimum.celsius, 0) / daily.length)
      }
    };
  } catch (error) {
    if (error.response) {
      throw new Error(`API Error: ${error.response.data?.error || error.message}`);
    }
    throw error;
  }
}

module.exports = {
  getWeatherForAddress
};
