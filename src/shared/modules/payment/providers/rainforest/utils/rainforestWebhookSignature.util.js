'use strict';

const crypto = require('crypto');

/**
 * Verify Rainforest webhook signatures.
 * Supports common header formats documented for Rainforest signing keys.
 */
function extractSignatureHeader(req) {
  return (
    req.headers['rainforest-signature']
    || req.headers['x-rainforest-signature']
    || req.headers['webhook-signature']
    || ''
  );
}

function parseSignatureHeader(headerValue) {
  const raw = String(headerValue || '').trim();
  if (!raw) return { timestamp: '', signatures: [] };

  if (raw.includes('v1=')) {
    const parts = raw.split(',').map((p) => p.trim());
    let timestamp = '';
    const signatures = [];
    parts.forEach((part) => {
      const [key, value] = part.split('=');
      if (key === 't') timestamp = value || '';
      if (key === 'v1' && value) signatures.push(value);
    });
    return { timestamp, signatures };
  }

  return { timestamp: '', signatures: [raw.replace(/^sha256=/i, '')] };
}

function computeExpectedSignatures({ secret, rawBody, timestamp }) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8');
  const direct = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const signatures = [`sha256=${direct}`, direct];

  if (timestamp) {
    const stamped = crypto.createHmac('sha256', secret).update(`${timestamp}.${body.toString('utf8')}`).digest('hex');
    signatures.push(stamped);
    signatures.push(`sha256=${stamped}`);
  }

  return signatures;
}

function timingSafeEqualHex(a, b) {
  try {
    const left = Buffer.from(String(a || ''), 'utf8');
    const right = Buffer.from(String(b || ''), 'utf8');
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
  } catch (_err) {
    return false;
  }
}

function verifyRainforestWebhookSignature({ req, secret, rawBody, maxSkewSeconds = 300 }) {
  if (!secret) {
    return { valid: false, reason: 'missing_secret' };
  }

  const header = extractSignatureHeader(req);
  const { timestamp, signatures } = parseSignatureHeader(header);
  if (!signatures.length) {
    return { valid: false, reason: 'missing_signature' };
  }

  if (timestamp) {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return { valid: false, reason: 'invalid_timestamp' };
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > maxSkewSeconds) {
      return { valid: false, reason: 'timestamp_skew' };
    }
  }

  const body = rawBody ?? req.rawBody ?? (req.body ? JSON.stringify(req.body) : '');
  const expected = computeExpectedSignatures({ secret, rawBody: body, timestamp });

  const matched = signatures.some((sig) =>
    expected.some((candidate) => timingSafeEqualHex(candidate, sig) || timingSafeEqualHex(candidate.replace(/^sha256=/i, ''), sig))
  );

  return matched ? { valid: true } : { valid: false, reason: 'signature_mismatch' };
}

module.exports = {
  verifyRainforestWebhookSignature,
  extractSignatureHeader,
};
