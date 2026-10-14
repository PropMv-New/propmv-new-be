const axios = require('axios');
const crypto = require('crypto');
const ReferLead = require('../model/referLead.model');

const STEADILY_BASE_URL = 'https://api.staging.steadily.com';

function getSteadilyApiKey() {
  const key = process.env.STEADILY_API_KEY;
  if (!key || !key.trim()) {
    const err = new Error('Steadily API key (STEADILY_API_KEY) is not configured');
    err.status = 500;
    throw err;
  }
  return key.trim();
}

// Remove null/undefined keys so Steadily doesn't reject optional fields
function stripNulls(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => [k, typeof v === 'object' && !Array.isArray(v) ? stripNulls(v) : v])
  );
}

async function createReferLeadService(userId, landlordId, body) {
  const apiKey = getSteadilyApiKey();

  // external_record_id - use provided value or generate one
  const external_record_id =
    body.external_record_id || `propmv-${crypto.randomBytes(6).toString('hex')}`;

  // primary_insured - required: first_name, last_name, email; optional: phone_number
  const primary_insured = stripNulls({
    first_name:   body.primary_insured.first_name,
    last_name:    body.primary_insured.last_name,
    email:        body.primary_insured.email,
    phone_number: body.primary_insured.phone_number || undefined,
  });

  const payload = { external_record_id, primary_insured };

  // Optional: include property address if provided
  if (body.properties && body.properties.length > 0) {
    payload.properties = body.properties.map(p => stripNulls(p));
  }

  let steadilyResponse = null;
  let steadilyError = null;
  let apiStatus = 'success';

  try {
    const { data } = await axios.post(
      `${STEADILY_BASE_URL}/v1/quote/submit`,
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
    steadilyResponse = data;
  } catch (err) {
    const status = err.response && err.response.status;
    const location = err.response && err.response.headers && err.response.headers.location;

    if (status === 307 && location && location.includes('redoc')) {
      const authErr = new Error(
        'Steadily API key is invalid or not yet provisioned. ' +
        'Contact partnerships-team@steadily.com and set STEADILY_API_KEY.'
      );
      authErr.status = 401;
      throw authErr;
    }

    if (status === 403) {
      const authErr = new Error(
        'Steadily API key not authorized (403). Verify STEADILY_API_KEY is the correct staging key.'
      );
      authErr.status = 403;
      throw authErr;
    }

    if (status === 422) {
      const message =
        (err.response.data && (err.response.data.detail || JSON.stringify(err.response.data))) ||
        err.message;
      const validationErr = new Error('Steadily validation error: ' + message);
      validationErr.status = 422;
      validationErr.steadilyErrors = err.response.data;
      throw validationErr;
    }

    steadilyError =
      (err.response && err.response.data &&
        (err.response.data.detail || JSON.stringify(err.response.data))) ||
      err.message;
    apiStatus = 'failed';
  }

  return ReferLead.create({
    user_id:            userId,
    landlord_id:        landlordId,
    request:            payload,
    response:           steadilyResponse,
    external_record_id: steadilyResponse?.external_record_id || external_record_id,
    start_url:          steadilyResponse?.start_url || null,
    status:             apiStatus,
    steadily_error:     steadilyError,
  });
}

module.exports = { createReferLeadService };
