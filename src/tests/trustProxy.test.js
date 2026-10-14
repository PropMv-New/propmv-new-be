const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveTrustProxySetting,
  applyTrustProxy,
  isLocalLikeEnv,
  isDeployedLikeEnv,
} = require('../config/trustProxy');

test('local profiles default trust proxy to false', () => {
  assert.equal(isLocalLikeEnv({ APP_PROFILE: 'local' }), true);
  assert.equal(isLocalLikeEnv({ APP_PROFILE: 'development' }), true);
  assert.deepEqual(resolveTrustProxySetting({ APP_PROFILE: 'local' }), {
    setting: false,
    source: 'default:local',
    deployed: false,
  });
});

test('deployed profiles default trust proxy to 1 hop', () => {
  assert.equal(isDeployedLikeEnv({ APP_PROFILE: 'staging' }), true);
  assert.equal(isDeployedLikeEnv({ APP_PROFILE: 'production', NODE_ENV: 'production' }), true);
  assert.equal(isDeployedLikeEnv({ NODE_ENV: 'production' }), true);
  assert.deepEqual(resolveTrustProxySetting({ APP_PROFILE: 'staging' }), {
    setting: 1,
    source: 'default:deployed',
    deployed: true,
  });
  assert.deepEqual(resolveTrustProxySetting({ NODE_ENV: 'production' }), {
    setting: 1,
    source: 'default:deployed',
    deployed: true,
  });
});

test('TRUST_PROXY env overrides defaults', () => {
  assert.equal(resolveTrustProxySetting({ APP_PROFILE: 'local', TRUST_PROXY: 'true' }).setting, true);
  assert.equal(resolveTrustProxySetting({ APP_PROFILE: 'production', TRUST_PROXY: 'false' }).setting, false);
  assert.equal(resolveTrustProxySetting({ APP_PROFILE: 'production', TRUST_PROXY: '2' }).setting, 2);
});

test('applyTrustProxy sets app and warns when disabled in deployed env', () => {
  const store = {};
  const app = {
    set(key, value) {
      store[key] = value;
    },
  };
  const warnings = [];
  applyTrustProxy(app, { APP_PROFILE: 'production', TRUST_PROXY: 'false' }, {
    log: {
      info() {},
      warn(...args) {
        warnings.push(args.join(' '));
      },
    },
  });
  assert.equal(store['trust proxy'], false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /trust proxy is disabled/i);
});

test('applyTrustProxy enables hop count 1 for staging by default', () => {
  const store = {};
  const app = {
    set(key, value) {
      store[key] = value;
    },
  };
  applyTrustProxy(app, { APP_PROFILE: 'staging' }, {
    log: { info() {}, warn() {} },
  });
  assert.equal(store['trust proxy'], 1);
});
