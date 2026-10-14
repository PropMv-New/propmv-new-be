/**
 * ------------------------------------------------------------------
 * File: keyResolver.js
 * Module: Backend Middleware
 *
 * Purpose:
 * Backend utility/module providing helper functions for keyResolver.
 *
 * Used By:
 * apiRateLimit.middleware
 * ------------------------------------------------------------------
 */

const jwt = require('jsonwebtoken');
const config = require('../../config/default');
const { verifyRefreshToken } = require('../../common/helpers/jwtHelper');
const { getRequestIpAddress } = require('../../shared/utils/requestIp.util');

const JWT_SECRET = process.env.JWT_SECRET || config.jwt?.secret || 'default_jwt_secret';
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || JWT_SECRET;

/**
 * normalize Email
 *
 * Performs logic operations for normalizeEmail.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function normalizeEmail(value) {
  if (!value) return '';
  return String(value).trim().toLowerCase();
}

/**
 * try Decode Access Token
 *
 * Performs logic operations for tryDecodeAccessToken.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function tryDecodeAccessToken(req) {
  if (req.userId) {
    return String(req.userId);
  }
  const authHeader = req.headers?.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return '';
  }
  try {
    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded?.sub ? String(decoded.sub) : '';
  } catch (_err) {
    return '';
  }
}

/**
 * try Decode Refresh Token User Id
 *
 * Performs logic operations for tryDecodeRefreshTokenUserId.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function tryDecodeRefreshTokenUserId(req) {
  const bodyToken = req.body?.refreshToken;
  const queryToken = req.query?.refreshToken;
  const token = bodyToken || queryToken;
  if (!token) return '';
  try {
    const decoded = verifyRefreshToken(token);
    return decoded?.sub ? String(decoded.sub) : '';
  } catch (_err) {
    try {
      const decoded = jwt.verify(token, REFRESH_TOKEN_SECRET);
      return decoded?.sub ? String(decoded.sub) : '';
    } catch (_inner) {
      return '';
    }
  }
}

/**
 * get Email From Request
 *
 * Performs logic operations for getEmailFromRequest.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function getEmailFromRequest(req) {
  const bodyEmail = normalizeEmail(req.body?.email);
  if (bodyEmail) return bodyEmail;
  const queryEmail = normalizeEmail(req.query?.email);
  if (queryEmail) return queryEmail;
  return '';
}

/**
 * resolve Rate Limit Key
 *
 * Performs logic operations for resolveRateLimitKey.
 *
 * @param keyType - Request/input argument
 * @param req - Request/input argument
 * @param ruleName - Request/input argument
 * @returns Operations result
 */
function resolveRateLimitKey(keyType, req, ruleName) {
  const ip = getRequestIpAddress(req) || 'unknown';
  const userId = tryDecodeAccessToken(req);
  const email = getEmailFromRequest(req);
  const refreshUserId = tryDecodeRefreshTokenUserId(req);
  const effectiveUserId = userId || refreshUserId;

  switch (keyType) {
    case 'ip':
      return `ip:${ruleName}:${ip}`;
    case 'user':
      return `user:${ruleName}:${effectiveUserId || email || ip}`;
    case 'userIp':
      return `userIp:${ruleName}:${email || effectiveUserId || 'anon'}:${ip}`;
    case 'email':
      return `email:${ruleName}:${email || ip}`;
    default:
      return `ip:${ruleName}:${ip}`;
  }
}

module.exports = {
  resolveRateLimitKey,
  getRequestIpAddress,
  tryDecodeAccessToken,
  getEmailFromRequest,
};
