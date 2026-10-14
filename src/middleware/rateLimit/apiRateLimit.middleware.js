/**
 * ------------------------------------------------------------------
 * File: apiRateLimit.middleware.js
 * Module: Backend Middleware
 *
 * Purpose:
 * Express middleware providing request timing, rate limiting, logging, or authentication filters.
 *
 * Used By:
 * rateLimit
 * ------------------------------------------------------------------
 */

const rateLimitConfig = require('../../config/rateLimit.config');
const rateLimitService = require('../../services/rateLimit.service');
const logger = require('../../common/logger');
const responseHelper = require('../../common/helpers/responseHelper');
const { resolveRateLimitKey, getRequestIpAddress } = require('./keyResolver');
const { resolveRateLimitRules } = require('./ruleMatcher');

/**
 * Express middleware - applies tiered API rate limits per API_Rate_Limiting_Recommendations.docx.
 * Returns HTTP 429 with Retry-After header when limits are exceeded.
 */
async function apiRateLimitMiddleware(req, res, next) {
  if (!rateLimitConfig.enabled) {
    return next();
  }

  const rules = resolveRateLimitRules(req);
  if (!rules.length) {
    return next();
  }

  try {
    for (const rule of rules) {
      const key = resolveRateLimitKey(rule.keyType, req, rule.name);
      const result = await rateLimitService.consume(key, rule.limit, rule.windowMs);

      res.setHeader('X-RateLimit-Limit', String(rule.limit));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, result.remaining)));

      if (!result.allowed) {
        const retryAfter = result.retryAfterSeconds || 1;
        res.setHeader('Retry-After', String(retryAfter));

        logger.warn('Rate limit exceeded', {
          module: 'rateLimit',
          action: rule.name,
          method: req.method,
          path: req.originalUrl || req.url,
          ipAddress: getRequestIpAddress(req),
          userId: req.userId || undefined,
          retryAfter,
          current: result.current,
          limit: rule.limit,
        });

        return responseHelper.error(
          res,
          'Too many requests. Please try again later.',
          429,
          {
            retryAfterSeconds: retryAfter,
            limit: rule.limit,
            windowMs: rule.windowMs,
            rule: rule.name,
          }
        );
      }
    }

    return next();
  } catch (err) {
    logger.error('Rate limit middleware error', { error: err.message });
    return next();
  }
}

module.exports = {
  apiRateLimitMiddleware,
};
