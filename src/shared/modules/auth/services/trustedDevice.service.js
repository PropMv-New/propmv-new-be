const TrustedDevice = require('../models/trustedDevice.model');
const { ClockService, DateUtil } = require('../../../../common/date');
const {
  hashDeviceFingerprint,
  normalizeIp,
  parseUserAgentMeta,
  getTrustedDeviceDays,
} = require('../helpers/deviceFingerprint.helper');

/**
 * Evaluate whether MFA can be skipped for this device + IP.
 * @returns {{ trusted: boolean, reason: string, device: object|null, fingerprintHash: string|null }}
 */
async function evaluateDeviceTrust(userId, rawFingerprint, ip) {
  const fingerprintHash = hashDeviceFingerprint(rawFingerprint);
  if (!fingerprintHash) {
    return {
      trusted: false,
      reason: 'required_missing_fingerprint',
      device: null,
      fingerprintHash: null,
    };
  }

  const device = await TrustedDevice.findOne({
    userId,
    fingerprintHash,
    isRevoked: false,
  }).lean();

  if (!device) {
    return {
      trusted: false,
      reason: 'required_untrusted_device',
      device: null,
      fingerprintHash,
    };
  }

  const now = ClockService.nowEpoch();
  if (!device.trustedUntil || (DateUtil.toEpoch(device.trustedUntil) ?? 0) <= now) {
    return {
      trusted: false,
      reason: 'required_expired',
      device,
      fingerprintHash,
    };
  }

  // Device trust is fingerprint-scoped for the configured window.
  // Do not require an exact IP match - residential / mobile / CGNAT IPs change often
  // and would make "Trust this device" appear broken on the next login.
  return {
    trusted: true,
    reason: 'skipped_trusted_device',
    device,
    fingerprintHash,
    ipChanged: Boolean(
      normalizeIp(device.lastIp) &&
        normalizeIp(ip) &&
        normalizeIp(device.lastIp) !== normalizeIp(ip)
    ),
  };
}

async function touchTrustedDevice(deviceId, { ip, userAgent } = {}) {
  if (!deviceId) return null;
  const { browser, os } = parseUserAgentMeta(userAgent);
  return TrustedDevice.findByIdAndUpdate(
    deviceId,
    {
      $set: {
        lastLoginAt: ClockService.now(),
        lastIp: normalizeIp(ip),
        lastUserAgent: userAgent ? String(userAgent).slice(0, 512) : null,
        browser,
        os,
      },
    },
    { new: true }
  ).lean();
}

async function upsertTrustedDevice({
  userId,
  rawFingerprint,
  ip,
  userAgent,
  deviceName,
  trustDays,
} = {}) {
  const fingerprintHash = hashDeviceFingerprint(rawFingerprint);
  if (!fingerprintHash) {
    throw new Error('Device fingerprint is required to trust this device');
  }

  const days = trustDays || getTrustedDeviceDays();
  const trustedUntil = DateUtil.fromEpoch(ClockService.nowEpoch() + days * 24 * 60 * 60 * 1000);
  const { browser, os } = parseUserAgentMeta(userAgent);
  const now = ClockService.now();
  const resolvedName =
    (deviceName && String(deviceName).trim()) ||
    `${browser} on ${os}`;

  const existing = await TrustedDevice.findOne({ userId, fingerprintHash });
  if (existing) {
    existing.isRevoked = false;
    existing.revokedAt = null;
    existing.trustedUntil = trustedUntil;
    existing.lastLoginAt = now;
    existing.lastIp = normalizeIp(ip);
    existing.lastUserAgent = userAgent ? String(userAgent).slice(0, 512) : null;
    existing.browser = browser;
    existing.os = os;
    if (deviceName && String(deviceName).trim()) {
      existing.deviceName = String(deviceName).trim().slice(0, 120);
    } else if (!existing.deviceName) {
      existing.deviceName = resolvedName.slice(0, 120);
    }
    if (!existing.firstTrustedAt) existing.firstTrustedAt = now;
    await existing.save();
    return existing.toObject();
  }

  const created = await TrustedDevice.create({
    userId,
    fingerprintHash,
    deviceName: resolvedName.slice(0, 120),
    browser,
    os,
    lastIp: normalizeIp(ip),
    lastUserAgent: userAgent ? String(userAgent).slice(0, 512) : null,
    firstTrustedAt: now,
    lastLoginAt: now,
    trustedUntil,
    isRevoked: false,
  });
  return created.toObject();
}

async function revokeAllTrustedDevicesForUser(userId) {
  if (!userId) return { modifiedCount: 0 };
  const result = await TrustedDevice.updateMany(
    { userId, isRevoked: false },
    { $set: { isRevoked: true, revokedAt: ClockService.now() } }
  );
  return { modifiedCount: result.modifiedCount || 0 };
}

function toPublicDevice(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    deviceName: doc.deviceName || 'Trusted device',
    browser: doc.browser || null,
    os: doc.os || null,
    lastIp: doc.lastIp || null,
    lastLoginAt: doc.lastLoginAt || null,
    firstTrustedAt: doc.firstTrustedAt || null,
    trustedUntil: doc.trustedUntil || null,
    isCurrent: false,
  };
}

async function listTrustedDevices(userId) {
  const devices = await TrustedDevice.find({
    userId,
    isRevoked: false,
    trustedUntil: { $gt: ClockService.now() },
  })
    .sort({ lastLoginAt: -1 })
    .lean();
  return devices.map(toPublicDevice);
}

async function renameTrustedDevice(userId, deviceId, deviceName) {
  const name = String(deviceName || '').trim().slice(0, 120);
  if (!name) {
    throw Object.assign(new Error('Device name is required'), { status: 400 });
  }
  const device = await TrustedDevice.findOne({
    _id: deviceId,
    userId,
    isRevoked: false,
  });
  if (!device) {
    throw Object.assign(new Error('Trusted device not found'), { status: 404 });
  }
  device.deviceName = name;
  await device.save();
  return toPublicDevice(device.toObject());
}

async function revokeTrustedDevice(userId, deviceId) {
  const device = await TrustedDevice.findOne({
    _id: deviceId,
    userId,
    isRevoked: false,
  });
  if (!device) {
    throw Object.assign(new Error('Trusted device not found'), { status: 404 });
  }
  device.isRevoked = true;
  device.revokedAt = ClockService.now();
  await device.save();
  return { id: String(device._id), revoked: true };
}

module.exports = {
  evaluateDeviceTrust,
  touchTrustedDevice,
  upsertTrustedDevice,
  revokeAllTrustedDevicesForUser,
  listTrustedDevices,
  renameTrustedDevice,
  revokeTrustedDevice,
  toPublicDevice,
};
