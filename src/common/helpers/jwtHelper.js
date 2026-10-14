/**
 * ------------------------------------------------------------------
 * File: jwtHelper.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for jwtHelper.
 *
 * Used By:
 * auth.service, keyResolver, portalInvitation.service
 * ------------------------------------------------------------------
 */

const jwt = require('jsonwebtoken');
require('dotenv').config(); // Ensure .env variables are loaded

// Configurable JWT settings from env
const JWT_SECRET = process.env.JWT_SECRET || 'default_jwt_secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '15m';

const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || JWT_SECRET;
const REFRESH_TOKEN_EXPIRES_IN = process.env.REFRESH_TOKEN_EXPIRES_IN || '30d';

/**
 * Generate Access Token
 * @param {Object} payload - Data to include in the token
 * @param {Array} privileges - Optional array of user privileges to include in token
 * @returns {string} JWT Access Token
 */
function generateAccessToken(payload, privileges = []) {
  const tokenPayload = { ...payload };
  if (Array.isArray(privileges) && privileges.length > 0) {
    tokenPayload.privileges = privileges;
  }
  return jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Generate Refresh Token
 * @param {Object} payload - Data to include in the token
 * @returns {string} JWT Refresh Token
 */
function generateRefreshToken(payload) {
  return jwt.sign(payload, REFRESH_TOKEN_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRES_IN });
}

/**
 * Verify Access Token
 * @param {string} token
 * @returns {Object} Decoded payload
 */
function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

/**
 * Verify Refresh Token
 * @param {string} token
 * @returns {Object} Decoded payload
 */
function verifyRefreshToken(token) {
  return jwt.verify(token, REFRESH_TOKEN_SECRET);
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
};
