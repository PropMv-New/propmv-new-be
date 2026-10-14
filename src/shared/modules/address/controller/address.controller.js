/**
 * ------------------------------------------------------------------
 * File: address.controller.js
 * Module: Src Shared Modules Address Controller
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * address.routes
 * ------------------------------------------------------------------
 */

const quotaService = require('../services/quota.service');
const mapboxProvider = require('../services/mapbox.provider');

const COUNTRY_RE = /^[a-zA-Z]{2}$/;
const MIN_QUERY_LENGTH = 2;

/**
 * normalize Country
 *
 * Performs logic operations for normalizeCountry.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function normalizeCountry(value) {
  return COUNTRY_RE.test(String(value || '')) ? String(value).toLowerCase() : 'us';
}

/**
 * GET /api/v1/address/provider
 * Tells the client which provider to use right now (google primary, mapbox
 * fallback once Google's monthly quota is spent). Always degrades to "google"
 * on any error so the existing client flow is never broken.
 */
async function getProvider(req, res) {
  try {
    // A client that cannot run Google at all may request Mapbox directly.
    const clientWantsMapbox = String(req.query.provider || '').toLowerCase() === 'mapbox';
    const provider = clientWantsMapbox ? 'mapbox' : await quotaService.resolveActiveProvider();
    const usage = await quotaService.getUsage('google');
    return res.json({
      provider,
      googleUsed: usage.totalCount || 0,
      googleLimit: quotaService.getGoogleMonthlyLimit(),
      googleEffectiveLimit: quotaService.getGoogleEffectiveLimit(),
      mapboxConfigured: quotaService.isMapboxConfigured(),
    });
  } catch (err) {
    return res.json({ provider: 'google' });
  }
}

/**
 * GET /api/v1/address/autocomplete?q=&country=&provider=
 * Serves Mapbox suggestions when Google's quota is exhausted, or when the
 * client explicitly asks for Mapbox via provider=mapbox.
 *
 * The explicit form exists for the mobile app: Google Places runs client-side
 * and needs a browser key, and a referrer-restricted key cannot authorise the
 * app's own origin. Those clients cannot use Google at any quota level, so
 * without this they got an empty list and no address suggestions at all.
 *
 * Otherwise it still returns an empty list with provider:"google" so web
 * clients know to keep using the Google JS SDK directly.
 */
async function autocomplete(req, res) {
  try {
    const q = String(req.query.q || '').trim();
    const country = normalizeCountry(req.query.country);
    const mode = req.query.mode === 'city' ? 'city' : 'address';

    // Same opt-in getProvider already honours. It was only wired into that
    // endpoint, so the app could ask which provider to use and be told
    // "mapbox", then call this one and still be handed google + an empty list
    // while Google had quota left - i.e. no suggestions, which is the bug the
    // provider flag was added to fix.
    const clientWantsMapbox = String(req.query.provider || '').toLowerCase() === 'mapbox';
    const provider = clientWantsMapbox
      ? 'mapbox'
      : await quotaService.resolveActiveProvider();

    if (q.length < MIN_QUERY_LENGTH) {
      return res.json({ provider, suggestions: [] });
    }

    if (provider !== 'mapbox') {
      return res.json({ provider: 'google', suggestions: [] });
    }

    const suggestions = await mapboxProvider.autocomplete(q, { country, limit: 6, mode });
    // Count one request per search; resolved data is embedded so there is no
    // separate resolve call to count.
    await quotaService.incrementUsage('mapbox', 'autocomplete').catch(() => {});

    return res.json({ provider: 'mapbox', suggestions });
  } catch (err) {
    // Never 500 the UI; return an empty result so the user can type manually.
    return res.status(200).json({
      provider: 'mapbox',
      suggestions: [],
      error: 'address_lookup_failed',
    });
  }
}

/**
 * POST /api/v1/address/usage  body: { provider: 'google', type: 'autocomplete'|'resolve' }
 * The client reports each Google request so we can track its monthly quota.
 * Only Google reports are accepted; Mapbox is counted server-side.
 */
async function reportUsage(req, res) {
  try {
    const provider = req.body && req.body.provider;
    const type = req.body && req.body.type === 'resolve' ? 'resolve' : 'autocomplete';

    if (provider !== 'google') {
      return res.json({ ok: true, ignored: true });
    }

    await quotaService.incrementUsage('google', type).catch(() => {});
    return res.json({ ok: true });
  } catch (err) {
    return res.json({ ok: false });
  }
}

/**
 * GET /api/v1/address/usage  (authenticated)
 * Returns current-month usage counters for monitoring.
 */
async function getUsageSummary(req, res) {
  try {
    const [google, mapbox] = await Promise.all([
      quotaService.getUsage('google'),
      quotaService.getUsage('mapbox'),
    ]);

    return res.json({
      period: quotaService.getCurrentPeriod(),
      googleLimit: quotaService.getGoogleMonthlyLimit(),
      googleEffectiveLimit: quotaService.getGoogleEffectiveLimit(),
      googleSafetyBuffer: quotaService.getSafetyBuffer(),
      mapboxConfigured: quotaService.isMapboxConfigured(),
      activeProvider: await quotaService.resolveActiveProvider(),
      google,
      mapbox,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

module.exports = { getProvider, autocomplete, reportUsage, getUsageSummary };
