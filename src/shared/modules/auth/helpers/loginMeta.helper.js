const logger = require('../../../../common/logger');
const { getClientIpInfo } = require('../../../utils/requestIp.util');
const { resolveIpGeolocation } = require('../../../utils/ipGeolocation.util');
const { parseUserAgentMeta, normalizeIp } = require('./deviceFingerprint.helper');
const { isDeployedLikeEnv } = require('../../../../config/trustProxy');

let warnedDeployedPrivateIp = false;

function warnIfDeployedPrivateIp(ipInfo) {
  if (!ipInfo?.isLocal || !isDeployedLikeEnv()) return;
  if (warnedDeployedPrivateIp) return;
  warnedDeployedPrivateIp = true;
  logger.warn(
    '[Auth] Client IP resolved as private/loopback in a deployed environment ' +
      `(ip=${ipInfo.ip || 'none'}, trustProxy=${ipInfo.trustProxy}, hops=${ipInfo.trustHops}). ` +
      'Check TRUST_PROXY and that Nginx/ALB/Cloudflare forwards CF-Connecting-IP, X-Forwarded-For, or X-Real-IP. ' +
      'This warning is logged once per process.'
  );
}

/**
 * Build login metadata from an Express request:
 * public IP (when available), UA meta, and approximate geolocation.
 */
async function buildLoginMetaFromRequest(req) {
  const ipInfo = getClientIpInfo(req);
  warnIfDeployedPrivateIp(ipInfo);

  const ip = normalizeIp(ipInfo.ip);
  const userAgent = req?.headers?.['user-agent'] || null;
  const uaMeta = parseUserAgentMeta(userAgent);

  let geo = {
    city: null,
    state: null,
    country: null,
    timezone: null,
    isLocalDevelopment: !!ipInfo.isLocal,
    locationAvailable: false,
  };

  if (ipInfo.isLocal) {
    geo.isLocalDevelopment = true;
  } else {
    try {
      geo = await resolveIpGeolocation(ip);
    } catch (_err) {
      geo = {
        city: null,
        state: null,
        country: null,
        timezone: null,
        isLocalDevelopment: false,
        locationAvailable: false,
      };
    }
  }

  return {
    ip: ip || null,
    userAgent,
    browser: uaMeta.browser || null,
    os: uaMeta.os || null,
    deviceType: uaMeta.deviceType || null,
    city: geo.city || null,
    state: geo.state || null,
    country: geo.country || null,
    timezone: geo.timezone || null,
    isLocalDevelopment: !!geo.isLocalDevelopment || !!ipInfo.isLocal,
  };
}

module.exports = {
  buildLoginMetaFromRequest,
};
