/**
 * ------------------------------------------------------------------
 * File: quoteEstimate.service.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * quoteEstimate.controller
 * ------------------------------------------------------------------
 */
const axios = require('axios');
const crypto = require('crypto');
const QuoteEstimate = require('../model/quoteEstimate.model');

// Staging URL per Steadily support team
const STEADILY_BASE_URL = 'https://api.staging.steadily.com';

// Quote endpoints use X-Steadily-ApiKey (NOT SecretKey)
// SecretKey is only for /v1/report/* endpoints
function getSteadilyApiKey() {
  const key = process.env.STEADILY_SECRET_KEY;
  if (!key || !key.trim()) {
    const err = new Error('Steadily API key (STEADILY_API_KEY) is not configured');
    err.status = 500;
    throw err;
  }
  return key.trim();
}

function generatePropertyId() {
  return crypto.randomBytes(6).toString('hex');
}

// Remove keys with null/undefined values so Steadily doesn't reject them
function stripNulls(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => [k, typeof v === 'object' && !Array.isArray(v) ? stripNulls(v) : v])
  );
}

/**
 * parse Estimates
 *
 * Performs logic operations for parseEstimates.
 *
 * @param steadilyResponse - Request/input argument
 * @returns Operations result
 */
function parseEstimates(steadilyResponse) {
  if (!steadilyResponse || !Array.isArray(steadilyResponse.estimates)) return [];
  return steadilyResponse.estimates.map(est => ({
    property_id: est.property_id,
    start_url: est.start_url || null,
    error: est.error || null,
    estimate: est.estimate || null,
    savings: est.savings || null,
    minimum_earned_premium_days: est.minimum_earned_premium_days || null,
  }));
}

// POST /v1/quote/estimate - uses X-Steadily-ApiKey, all fields optional
async function callSteadilyQuote(payload) {
  const apiKey = getSteadilyApiKey();
  try {
    const { data } = await axios.post(
      `${STEADILY_BASE_URL}/v1/quote/estimate`,
      payload,
      {
        headers: {
          'X-Steadily-ApiKey': apiKey,
          'Content-Type': 'application/json',
        },
        maxRedirects: 0,
        timeout: 30000,
      }
    );
    return { data, error: null };
  } catch (err) {
    const status = err.response && err.response.status;
    const location = err.response && err.response.headers && err.response.headers.location;

    // 307 → /redoc means invalid/unrecognized API key
    if (status === 307 && location && location.includes('redoc')) {
      const authErr = new Error(
        'Steadily API key is invalid or not yet provisioned. ' +
        'Request an API key from partnerships-team@steadily.com and set STEADILY_API_KEY in your environment.'
      );
      authErr.status = 401;
      throw authErr;
    }

    if (status === 403) {
      const authErr = new Error(
        'Steadily API key is not authorized (403). ' +
        'Ensure STEADILY_API_KEY is set to the correct staging key provided by Steadily support.'
      );
      authErr.status = 403;
      throw authErr;
    }

    const message =
      (err.response && err.response.data &&
        (err.response.data.detail || JSON.stringify(err.response.data))) ||
      err.message;

    if (status === 422) {
      const validationErr = new Error('Steadily validation error: ' + message);
      validationErr.status = 422;
      validationErr.steadilyErrors = err.response.data;
      throw validationErr;
    }

    return { data: null, error: message };
  }
}

async function createQuoteEstimateService(userId, landlordId, body) {
  // Build clean payload - strip nulls so Steadily doesn't reject optional fields
  const properties = body.properties.map(p => {
    const prop = {
      property_id: p.property_id || generatePropertyId(),
    };
    if (p.current_premium != null) prop.current_premium = p.current_premium;

    // Address - only include fields that have values
    const addr = stripNulls(p.address);
    if (addr && Object.keys(addr).length > 0) prop.address = addr;

    // Property details - only include if provided
    const details = p.property_details ? stripNulls(p.property_details) : null;
    if (details && Object.keys(details).length > 0) prop.property_details = details;

    return prop;
  });

  const payload = { properties };
  if (body.primary_insured) {
    const insured = stripNulls(body.primary_insured);
    if (insured && Object.keys(insured).length > 0) payload.primary_insured = insured;
  }

  const { data: steadilyResponse, error: steadilyError } = await callSteadilyQuote(payload);

  const estimates = parseEstimates(steadilyResponse);
  let apiStatus = steadilyError ? 'failed' : 'success';
  if (!steadilyError && estimates.some(e => e.error)) apiStatus = 'partial';

  return QuoteEstimate.create({
    user_id: userId,
    landlord_id: landlordId,
    estimate_type: 'quote',
    request: payload,
    response: steadilyResponse,
    estimates,
    status: apiStatus,
    steadily_error: steadilyError,
  });
}

async function getQuoteEstimatesService(landlordId, query = {}) {
  const { page = 1, pageSize = 10 } = query;
  const limit = Math.max(1, parseInt(pageSize));
  const skip = (Math.max(1, parseInt(page)) - 1) * limit;
  const filter = { landlord_id: landlordId };
  const [total, data] = await Promise.all([
    QuoteEstimate.countDocuments(filter),
    QuoteEstimate.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  return { total, page: parseInt(page), pageSize: limit, data };
}

async function getQuoteEstimateByIdService(landlordId, id) {
  const record = await QuoteEstimate.findOne({ _id: id, landlord_id: landlordId }).lean();
  if (!record) {
    const err = new Error('Quote estimate not found');
    err.status = 404;
    throw err;
  }
  return record;
}

module.exports = {
  createQuoteEstimateService,
  getQuoteEstimatesService,
  getQuoteEstimateByIdService,
};
