const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeIp,
  isPrivateOrLoopbackIp,
  isPublicIp,
  getClientIpInfo,
  getRequestIpAddress,
  pickHopAwareForwardedIp,
} = require('../shared/utils/requestIp.util');

function mockReq({ headers = {}, ip = '', socketIp = '', trustProxy = false } = {}) {
  return {
    headers,
    ip,
    socket: { remoteAddress: socketIp },
    connection: { remoteAddress: socketIp },
    app: {
      get(key) {
        if (key === 'trust proxy') return trustProxy;
        return undefined;
      },
    },
  };
}

test('normalizeIp strips IPv6-mapped IPv4 and maps ::1', () => {
  assert.equal(normalizeIp('::ffff:203.0.113.10'), '203.0.113.10');
  assert.equal(normalizeIp('::1'), '127.0.0.1');
  assert.equal(normalizeIp('[::1]'), '127.0.0.1');
});

test('isPrivateOrLoopbackIp detects RFC1918 and loopback', () => {
  assert.equal(isPrivateOrLoopbackIp('127.0.0.1'), true);
  assert.equal(isPrivateOrLoopbackIp('10.1.2.3'), true);
  assert.equal(isPrivateOrLoopbackIp('192.168.1.20'), true);
  assert.equal(isPrivateOrLoopbackIp('172.16.0.1'), true);
  assert.equal(isPrivateOrLoopbackIp('172.31.255.255'), true);
  assert.equal(isPrivateOrLoopbackIp('172.32.0.1'), false);
  assert.equal(isPrivateOrLoopbackIp('8.8.8.8'), false);
  assert.equal(isPublicIp('49.36.1.2'), true);
});

test('without trust proxy, forwarded headers are ignored', () => {
  const req = mockReq({
    trustProxy: false,
    headers: {
      'cf-connecting-ip': '49.36.1.2',
      'x-forwarded-for': '49.36.1.2, 10.0.0.1',
    },
    ip: '127.0.0.1',
    socketIp: '127.0.0.1',
  });
  const info = getClientIpInfo(req);
  assert.equal(info.ip, '127.0.0.1');
  assert.equal(info.isLocal, true);
  assert.equal(info.trustProxy, false);
});

test('with trust proxy, CF-Connecting-IP wins over X-Forwarded-For', () => {
  const req = mockReq({
    trustProxy: 1,
    headers: {
      'cf-connecting-ip': '49.36.1.2',
      'x-forwarded-for': '203.0.113.50, 10.0.0.1',
      'x-real-ip': '198.51.100.7',
    },
    ip: '10.0.0.1',
    socketIp: '10.0.0.1',
  });
  assert.equal(getRequestIpAddress(req), '49.36.1.2');
  const info = getClientIpInfo(req);
  assert.equal(info.isPublic, true);
  assert.equal(info.isLocal, false);
});

test('hop-aware XFF prefers rightmost client IP (anti-spoof)', () => {
  // Client spoofed left-most; trusted proxy appended the real client IP
  assert.equal(pickHopAwareForwardedIp('8.8.8.8, 49.36.1.2', 1), '49.36.1.2');
  assert.equal(pickHopAwareForwardedIp('1.1.1.1, 8.8.8.8, 49.36.1.2', 1), '49.36.1.2');
  assert.equal(pickHopAwareForwardedIp('1.1.1.1, 49.36.1.2, 10.0.0.5', 2), '49.36.1.2');
});

test('with trust proxy, spoofed left-most XFF does not win over Express req.ip', () => {
  const req = mockReq({
    trustProxy: 1,
    headers: {
      // spoofed, real (proxy-appended)
      'x-forwarded-for': '8.8.8.8, 49.36.1.2',
    },
    // Express/proxy-addr with trust 1 resolves to real client
    ip: '49.36.1.2',
    socketIp: '10.0.0.5',
  });
  assert.equal(getRequestIpAddress(req), '49.36.1.2');
});

test('with trust proxy, hop-aware XFF used when req.ip is private', () => {
  const req = mockReq({
    trustProxy: 1,
    headers: {
      'x-forwarded-for': '8.8.8.8, 52.10.20.30',
    },
    ip: '10.0.0.5',
    socketIp: '10.0.0.5',
  });
  // Priority: req.ip (private) skipped for public preference → hop-aware XFF = 52.10.20.30
  assert.equal(getRequestIpAddress(req), '52.10.20.30');
});

test('prefers Azure client IP header when present', () => {
  const req = mockReq({
    trustProxy: 1,
    headers: {
      'x-azure-clientip': '52.10.20.30',
      'x-forwarded-for': '8.8.8.8, 10.0.0.8',
    },
    ip: '10.0.0.8',
    socketIp: '10.0.0.8',
  });
  assert.equal(getRequestIpAddress(req), '52.10.20.30');
});
