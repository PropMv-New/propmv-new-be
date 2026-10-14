/**
 * Approximate IP geolocation (city / region / country / timezone only).
 * Uses a public HTTPS lookup with in-memory cache. Never stores street/GPS.
 */

const axios = require('axios');
const logger = require('../../common/logger');
const { isPrivateOrLoopbackIp, isPublicIp, normalizeIp } = require('./requestIp.util');

// Pinned axios instance - baseURL is fixed so user-supplied IP can never redirect
// the request to an internal host (SSRF defense).
const geoAxios = axios.create({
  baseURL: 'https://ipwho.is',
  timeout: 2000,
});

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 2000;

/** @type {Map<string, { expiresAt: number, value: object|null }>} */
const cache = new Map();

function pruneCache() {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (!entry || entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    cache.delete(oldest);
  }
}

function emptyGeo({ isLocalDevelopment = false } = {}) {
  return {
    city: null,
    state: null,
    country: null,
    timezone: null,
    isLocalDevelopment: !!isLocalDevelopment,
    locationAvailable: false,
  };
}

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9a-fA-F:]{2,39}$/;

function assertSafeIpForUrl(ip) {
  if (!IPV4_RE.test(ip) && !IPV6_RE.test(ip)) {
    throw new Error(`ipGeolocation: refusing to build URL for non-IP value: ${ip}`);
  }
  // Defense-in-depth: re-verify the IP is public even after format check
  if (isPrivateOrLoopbackIp(ip) || !isPublicIp(ip)) {
    throw new Error(`ipGeolocation: refusing to build URL for non-public IP: ${ip}`);
  }
}

async function lookupViaIpWhoIs(ip) {
  if (!ip || isPrivateOrLoopbackIp(ip) || !isPublicIp(ip)) return null;
  assertSafeIpForUrl(ip);
  // Pass the IP as a path segment on the pinned baseURL instance.
  // encodeURIComponent ensures no path traversal; baseURL pins the host.
  const response = await geoAxios.get(`/${encodeURIComponent(ip)}`, {
    validateStatus: (status) => status >= 200 && status < 500,
  });
  const data = response.data || {};
  if (data.success === false) return null;

  const city = data.city ? String(data.city).trim() : '';
  const state = data.region ? String(data.region).trim() : '';
  const country = data.country ? String(data.country).trim() : '';
  const timezone =
    (data.timezone && (data.timezone.id || data.timezone)) ||
    null;

  if (!city && !state && !country) return null;

  return {
    city: city || null,
    state: state || null,
    country: country || null,
    timezone: timezone ? String(timezone).trim() : null,
    isLocalDevelopment: false,
    locationAvailable: true,
  };
}

/**
 * Resolve approximate location for a public IP.
 * Local/private IPs return isLocalDevelopment without a network call.
 */
async function resolveIpGeolocation(ip) {
  const normalized = normalizeIp(ip);
  if (!normalized || isPrivateOrLoopbackIp(normalized)) {
    return emptyGeo({ isLocalDevelopment: true });
  }
  if (!isPublicIp(normalized)) {
    return emptyGeo({ isLocalDevelopment: true });
  }

  const cached = cache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value || emptyGeo();
  }

  let resolved = emptyGeo();
  try {
    const geo = await lookupViaIpWhoIs(normalized);
    if (geo) resolved = geo;
  } catch (err) {
    // Non-fatal: login must not fail because geo lookup failed
    if (process.env.NODE_ENV !== 'production') {
      logger.warn('[GeoIP] Lookup failed:', err.message || err);
    }
  }

  cache.set(normalized, { expiresAt: Date.now() + CACHE_TTL_MS, value: resolved });
  pruneCache();
  return resolved;
}

/** Test helper */
function clearIpGeolocationCache() {
  cache.clear();
}

module.exports = {
  resolveIpGeolocation,
  clearIpGeolocationCache,
  emptyGeo,
};
