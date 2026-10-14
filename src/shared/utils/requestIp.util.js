/**
 * ------------------------------------------------------------------
 * File: requestIp.util.js
 * Module: Src Shared Utils
 *
 * Purpose:
 * Backend utility/module providing helper functions for requestIp.util.
 *
 * Used By:
 * keyResolver, auditLog.service
 * ------------------------------------------------------------------
 */

/**
 * Client IP extraction with reverse-proxy support.
 *
 * Priority when trust proxy is enabled (first public IP wins):
 * 1. CDN / edge headers (Cloudflare, Akamai, Azure, etc.) - set by infrastructure
 * 2. Express req.ip (hop-aware via `trust proxy`)
 * 3. X-Real-IP / Forwarded
 * 4. Hop-aware X-Forwarded-For (not spoofable left-most when hop count is set)
 * 5. Socket remote address
 *
 * When trust proxy is disabled, forwarded headers are ignored to prevent spoofing.
 */
function pickFirstIp(raw) {
  if (!raw) return '';
  if (Array.isArray(raw)) return String(raw[0] || '').trim();
  return String(raw).split(',')[0].trim();
}

/**
 * normalize Ip
 *
 * Performs logic operations for normalizeIp.
 *
 * @param ip - Request/input argument
 * @returns Operations result
 */
function normalizeIp(ip) {
  if (!ip) return '';
  let value = String(ip).trim();
  if (!value) return '';

  // Strip surrounding brackets used for IPv6 literals: [::1]
  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1);
  }

  // Handle IPv6-mapped IPv4: ::ffff:127.0.0.1
  if (value.toLowerCase().startsWith('::ffff:')) {
    value = value.slice(7);
  }

  if (value === '::1') return '127.0.0.1';
  return value;
}

function isValidIp(ip) {
  const value = normalizeIp(ip);
  if (!value) return false;

  // IPv4
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    return value.split('.').every((octet) => {
      const n = Number(octet);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
  }

  // Loose IPv6 (includes compressed forms)
  if (value.includes(':')) {
    return /^[0-9a-fA-F:]+$/.test(value) && value.split(':').length >= 3;
  }

  return false;
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function isPrivateOrLoopbackIp(ip) {
  const value = normalizeIp(ip);
  if (!value) return true;
  if (value === 'localhost' || value === '127.0.0.1' || value === '0.0.0.0') return true;

  // IPv6 loopback / unique local / link-local
  const lower = value.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
  if (lower.startsWith('fe80:')) return true; // link-local

  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    const n = ipv4ToInt(value);
    // 10.0.0.0/8
    if (n >= ipv4ToInt('10.0.0.0') && n <= ipv4ToInt('10.255.255.255')) return true;
    // 172.16.0.0/12
    if (n >= ipv4ToInt('172.16.0.0') && n <= ipv4ToInt('172.31.255.255')) return true;
    // 192.168.0.0/16
    if (n >= ipv4ToInt('192.168.0.0') && n <= ipv4ToInt('192.168.255.255')) return true;
    // 127.0.0.0/8
    if (n >= ipv4ToInt('127.0.0.0') && n <= ipv4ToInt('127.255.255.255')) return true;
    // 169.254.0.0/16 link-local
    if (n >= ipv4ToInt('169.254.0.0') && n <= ipv4ToInt('169.254.255.255')) return true;
  }

  return false;
}

function isPublicIp(ip) {
  const value = normalizeIp(ip);
  return isValidIp(value) && !isPrivateOrLoopbackIp(value);
}

function getTrustProxySetting(req) {
  if (!req || typeof req !== 'object') return false;
  if (req.app && typeof req.app.get === 'function') {
    return req.app.get('trust proxy');
  }
  return false;
}

function isTrustProxyEnabled(req) {
  const setting = getTrustProxySetting(req);
  if (setting === true) return true;
  if (typeof setting === 'number' && setting > 0) return true;
  if (typeof setting === 'string' && setting.trim() && setting !== 'false' && setting !== '0') {
    return true;
  }
  if (Array.isArray(setting) && setting.length > 0) return true;
  return false;
}

function getTrustedHopCount(req) {
  const setting = getTrustProxySetting(req);
  if (typeof setting === 'number' && setting > 0) return setting;
  // Boolean true / subnet list: treat as a single trusted hop for XFF parsing
  if (setting === true || Array.isArray(setting) || (typeof setting === 'string' && setting)) {
    return 1;
  }
  return 0;
}

function parseForwardedHeader(raw) {
  if (!raw) return '';
  const first = String(Array.isArray(raw) ? raw[0] : raw).split(',')[0];
  const match = first.match(/for=(?:"?\[?)([^;"\]]+)/i);
  return match ? match[1].trim() : '';
}

/**
 * Pick client IP from X-Forwarded-For using trusted hop count.
 * Proxies append to the right; clients can spoof left-most values.
 * With N trusted proxies, the client is at index `length - N` (right-biased),
 * matching Express/proxy-addr behavior.
 */
function pickHopAwareForwardedIp(raw, trustHops = 1) {
  if (!raw) return '';
  const parts = String(Array.isArray(raw) ? raw.join(',') : raw)
    .split(',')
    .map((part) => normalizeIp(part.trim()))
    .filter((ip) => ip && isValidIp(ip));

  if (!parts.length) return '';

  const hops = Number.isFinite(trustHops) && trustHops > 0 ? trustHops : 1;
  const index = Math.max(0, parts.length - hops);
  return parts[index] || parts[parts.length - 1] || '';
}

/**
 * Collect candidate IPs in preference order (already normalized).
 * Order matters: first public IP in this list is chosen.
 */
function collectCandidateIps(req, { trustProxy, trustHops } = {}) {
  const headers = (req && req.headers) || {};
  const candidates = [];

  const push = (raw) => {
    const ip = normalizeIp(pickFirstIp(raw));
    if (ip && isValidIp(ip) && !candidates.includes(ip)) {
      candidates.push(ip);
    }
  };

  if (trustProxy) {
    // Edge / CDN headers (infrastructure-set; preferred over client-influenced XFF)
    push(headers['cf-connecting-ip']); // Cloudflare
    push(headers['true-client-ip']); // Akamai / some CDNs
    push(headers['x-azure-clientip']); // Azure Front Door
    push(headers['x-client-ip']); // App Service / some Azure setups
    push(headers['fly-client-ip']); // Fly.io
    push(headers['x-appengine-user-ip']); // Google App Engine

    // Express hop-aware resolution (uses trust proxy setting)
    push(req.ip);

    push(headers['x-real-ip']);
    push(parseForwardedHeader(headers.forwarded));

    // Hop-aware XFF last among forwarded headers (left-most is spoofable)
    const xffClient = pickHopAwareForwardedIp(headers['x-forwarded-for'], trustHops);
    if (xffClient && !candidates.includes(xffClient)) {
      candidates.push(xffClient);
    }
  }

  push(req.socket && req.socket.remoteAddress);
  push(req.connection && req.connection.remoteAddress);
  if (!trustProxy) {
    push(req.ip);
  }

  return candidates;
}

/**
 * Resolve the best client IP for security/audit use.
 * Prefers the first public IP in priority order (anti-spoof).
 */
function getClientIpInfo(req) {
  const trustProxy = isTrustProxyEnabled(req);
  const trustHops = getTrustedHopCount(req);
  const candidates = collectCandidateIps(req, { trustProxy, trustHops });

  const publicIp = candidates.find((ip) => isPublicIp(ip)) || '';
  const fallbackIp = candidates[0] || '';
  const ip = publicIp || fallbackIp || '';
  const isLocal = !ip || isPrivateOrLoopbackIp(ip);

  return {
    ip: ip || null,
    isLocal,
    isPublic: !!publicIp,
    trustProxy,
    trustHops,
    candidates,
  };
}

/**
 * get Request Ip Address
 *
 * Performs logic operations for getRequestIpAddress.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function getRequestIpAddress(req) {
  const info = getClientIpInfo(req);
  return info.ip || '';
}

module.exports = {
  pickFirstIp,
  normalizeIp,
  isValidIp,
  isPrivateOrLoopbackIp,
  isPublicIp,
  isTrustProxyEnabled,
  getTrustedHopCount,
  pickHopAwareForwardedIp,
  getClientIpInfo,
  getRequestIpAddress,
};
