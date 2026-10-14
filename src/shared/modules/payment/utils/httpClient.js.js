/**
 * ------------------------------------------------------------------
 * File: httpClient.js.js
 * Module: Payment Module
 *
 * Purpose:
 * Backend utility/module providing helper functions for httpClient.js.
 *
 * Used By:
 * straddle.service
 * ------------------------------------------------------------------
 */

const axios = require('axios');
const https = require('https');

const createHttpClient = ({ baseURL, headers, timeout = 15000, auth }) => {
  const client = axios.create({
    baseURL,
    timeout,
    headers,
    ...(auth ? { auth } : {}),

    //Very Very Imp, need to remove this in production and add the STRADDLE API URL to your trusted certs
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  });

  client.interceptors.response.use(
    (response) => response,
    (error) => {
      throw {
        message: error?.response?.data?.message || error.message,
        status: error?.response?.status,
        data: error?.response?.data
      };
    }
  );

  return client;
};

module.exports = { createHttpClient };