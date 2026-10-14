const crypto = require('crypto');
const config = require('../../../../config/default');
const logger = require('../../../../common/logger');

function getFingerprintSecret() {
  const secret =
    process.env.DEVICE_FINGERPRINT_SECRET ||
    config.session?.deviceFingerprintSecret ||
    process.env.JWT_SECRET;

  if (!secret) {
    throw new Error('DEVICE_FINGERPRINT_SECRET or JWT_SECRET must be configured');
  }

  if (!process.env.DEVICE_FINGERPRINT_SECRET && process.env.NODE_ENV === 'production') {
    logger.warn(
      '[Auth] DEVICE_FINGERPRINT_SECRET is not set; falling back to JWT_SECRET in production is discouraged'
    );
  }

  return secret;
}

function normalizeIp(ip) {
  if (ip == null || ip === '') return null;
  let first = String(ip).split(',')[0].trim();
  if (!first) return null;
  if (first.startsWith('[') && first.endsWith(']')) {
    first = first.slice(1, -1);
  }
  // Strip IPv6-mapped IPv4 prefix
  if (first.toLowerCase().startsWith('::ffff:')) return first.slice(7);
  if (first === '::1') return '127.0.0.1';
  return first;
}

function hashDeviceFingerprint(rawFingerprint) {
  const value = String(rawFingerprint || '').trim();
  if (!value) return null;
  return crypto.createHmac('sha256', getFingerprintSecret()).update(value).digest('hex');
}

function truncateFingerprintHash(hash) {
  if (!hash) return null;
  return String(hash).slice(0, 12);
}

function parseUserAgentMeta(userAgent) {
  const s = String(userAgent || '');
  let browser = 'Unknown';
  let os = 'Unknown';
  let deviceType = 'desktop';

  if (/Edg\//i.test(s)) browser = 'Edge';
  else if (/Chrome\//i.test(s) && !/Edg\//i.test(s)) browser = 'Chrome';
  else if (/Safari\//i.test(s) && !/Chrome/i.test(s)) browser = 'Safari';
  else if (/Firefox\//i.test(s)) browser = 'Firefox';

  if (/Windows/i.test(s)) os = 'Windows';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/iPhone|iPad|iOS/i.test(s)) os = 'iOS';
  else if (/Mac OS X|Macintosh/i.test(s)) os = 'macOS';
  else if (/Linux/i.test(s)) os = 'Linux';

  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(s)) deviceType = 'tablet';
  else if (/Mobi|iPhone|Android.*Mobile|webOS|BlackBerry|IEMobile/i.test(s)) deviceType = 'mobile';

  return { browser, os, deviceType };
}

function getTrustedDeviceDays() {
  const days = Number(
    process.env.MFA_TRUSTED_DEVICE_DAYS ||
      config.session?.trustedDeviceDays ||
      30
  );
  return Number.isFinite(days) && days > 0 ? days : 30;
}

module.exports = {
  normalizeIp,
  hashDeviceFingerprint,
  truncateFingerprintHash,
  parseUserAgentMeta,
  getTrustedDeviceDays,
};
