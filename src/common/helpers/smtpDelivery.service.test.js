const test = require('node:test');
const assert = require('node:assert/strict');

process.env.EMAIL_SUPPRESSION_ENABLED = 'false';
process.env.EMAIL_VALIDATION_LOG = 'false';

const {
  classifySmtpError,
  loadProvidersFromEnv,
  applyProviderFrom,
  SmtpDeliveryService,
} = require('./smtpDelivery.service');

test('classifySmtpError marks network timeouts as transient', () => {
  assert.equal(classifySmtpError({ code: 'ETIMEDOUT', message: 'Timeout' }), 'transient');
  assert.equal(classifySmtpError({ code: 'EAI_AGAIN', message: 'getaddrinfo' }), 'transient');
  assert.equal(classifySmtpError({ responseCode: 421, message: 'Try again later' }), 'transient');
  assert.equal(classifySmtpError({ responseCode: 450, message: 'Mailbox busy' }), 'transient');
});

test('classifySmtpError marks invalid recipient 5xx as permanent', () => {
  assert.equal(
    classifySmtpError({ responseCode: 550, message: 'User unknown' }),
    'permanent'
  );
  assert.equal(
    classifySmtpError({ responseCode: 553, message: 'Invalid recipient address' }),
    'permanent'
  );
});

test('classifySmtpError marks auth failures as provider (failover, no same-provider retry)', () => {
  assert.equal(
    classifySmtpError({ responseCode: 535, message: 'Authentication failed' }),
    'provider'
  );
  assert.equal(
    classifySmtpError({ code: 'EAUTH', message: 'Invalid login' }),
    'provider'
  );
});

test('loadProvidersFromEnv reads PRIMARY and SECONDARY with legacy fallback', () => {
  const keys = [
    'SMTP_PRIMARY_HOST',
    'SMTP_PRIMARY_PORT',
    'SMTP_PRIMARY_USER',
    'SMTP_PRIMARY_PASSWORD',
    'SMTP_PRIMARY_PASS',
    'SMTP_PRIMARY_FROM',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_USER',
    'SMTP_PASS',
    'SMTP_SECONDARY_HOST',
    'SMTP_SECONDARY_PORT',
    'SMTP_SECONDARY_USER',
    'SMTP_SECONDARY_PASSWORD',
    'SMTP_SECONDARY_PASS',
    'SMTP_SECONDARY_FROM',
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];

    process.env.SMTP_HOST = 'smtp.primary.test';
    process.env.SMTP_PORT = '465';
    process.env.SMTP_USER = 'primary@test.com';
    process.env.SMTP_PASS = 'primary-secret';
    process.env.SMTP_SECONDARY_HOST = 'smtp.secondary.test';
    process.env.SMTP_SECONDARY_PORT = '587';
    process.env.SMTP_SECONDARY_USER = 'secondary@test.com';
    process.env.SMTP_SECONDARY_PASSWORD = 'secondary-secret';

    const providers = loadProvidersFromEnv();
    assert.equal(providers.length, 2);
    assert.equal(providers[0].name, 'Primary');
    assert.equal(providers[0].host, 'smtp.primary.test');
    assert.equal(providers[1].name, 'Secondary');
    assert.equal(providers[1].host, 'smtp.secondary.test');
    assert.equal(providers[1].from, 'secondary@test.com');
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('applyProviderFrom overrides address while keeping display name', () => {
  const result = applyProviderFrom(
    { from: { name: 'PropMv', address: 'noreply@propmv.com' }, to: 'a@b.com' },
    { from: 'backup@example.com' }
  );
  assert.deepEqual(result.from, { name: 'PropMv', address: 'backup@example.com' });
});

test('sendMail succeeds on primary without touching secondary', async () => {
  const service = new SmtpDeliveryService();
  const calls = [];
  service.getProviders = () => [
    { name: 'Primary', host: 'p', port: '465', user: 'u', pass: 'x', from: '' },
    { name: 'Secondary', host: 's', port: '587', user: 'u2', pass: 'y', from: 'u2' },
  ];
  service.getTransporter = (provider) => ({
    sendMail: async () => {
      calls.push(provider.name);
      return { messageId: 'primary-ok', response: '250 OK' };
    },
  });

  const info = await service.sendMail({ to: 'a@b.com', subject: 't', text: 'body' });
  assert.equal(info.messageId, 'primary-ok');
  assert.deepEqual(calls, ['Primary']);
});

test('sendMail fails over to secondary after primary provider failure', async () => {
  const service = new SmtpDeliveryService();
  const calls = [];
  service.getMaxRetries = () => 3;
  service.getRetryDelayMs = () => 1;
  service.getProviders = () => [
    { name: 'Primary', host: 'p', port: '465', user: 'u', pass: 'x', from: '' },
    { name: 'Secondary', host: 's', port: '587', user: 'u2', pass: 'y', from: 'u2' },
  ];
  service.getTransporter = (provider) => ({
    sendMail: async () => {
      calls.push(provider.name);
      if (provider.name === 'Primary') {
        const err = new Error('Invalid login');
        err.responseCode = 535;
        throw err;
      }
      return { messageId: 'secondary-ok', response: '250 OK' };
    },
  });
  service.recreateTransporter = (provider) => service.getTransporter(provider);

  const info = await service.sendMail({ to: 'a@b.com', subject: 't', text: 'body' });
  assert.equal(info.messageId, 'secondary-ok');
  // Auth/provider failure should not burn all 3 retries on primary
  assert.deepEqual(calls, ['Primary', 'Secondary']);
});

test('sendMail retries transient failures then fails over', async () => {
  const service = new SmtpDeliveryService();
  const calls = [];
  service.getMaxRetries = () => 3;
  service.getRetryDelayMs = () => 1;
  service.getProviders = () => [
    { name: 'Primary', host: 'p', port: '465', user: 'u', pass: 'x', from: '' },
    { name: 'Secondary', host: 's', port: '587', user: 'u2', pass: 'y', from: 'u2' },
  ];
  service.getTransporter = (provider) => ({
    sendMail: async () => {
      calls.push(provider.name);
      if (provider.name === 'Primary') {
        const err = new Error('connect ETIMEDOUT');
        err.code = 'ETIMEDOUT';
        throw err;
      }
      return { messageId: 'secondary-ok', response: '250 OK' };
    },
  });
  service.recreateTransporter = (provider) => service.getTransporter(provider);

  const info = await service.sendMail({ to: 'a@b.com', subject: 't', text: 'body' });
  assert.equal(info.messageId, 'secondary-ok');
  assert.deepEqual(calls, ['Primary', 'Primary', 'Primary', 'Secondary']);
});

test('sendMail does not failover on permanent recipient errors', async () => {
  const service = new SmtpDeliveryService();
  const calls = [];
  service.getMaxRetries = () => 3;
  service.getProviders = () => [
    { name: 'Primary', host: 'p', port: '465', user: 'u', pass: 'x', from: '' },
    { name: 'Secondary', host: 's', port: '587', user: 'u2', pass: 'y', from: 'u2' },
  ];
  service.getTransporter = (provider) => ({
    sendMail: async () => {
      calls.push(provider.name);
      const err = new Error('User unknown');
      err.responseCode = 550;
      throw err;
    },
  });

  await assert.rejects(
    () => service.sendMail({ to: 'bad@b.com', subject: 't', text: 'body' }),
    /User unknown/
  );
  assert.deepEqual(calls, ['Primary']);
});

test('classifySmtpError marks 550 5.1.1 style responses as permanent', () => {
  assert.equal(
    classifySmtpError({
      responseCode: 550,
      message:
        '550-5.1.1 The email account that you tried to reach does not exist.',
    }),
    'permanent'
  );
});

test('sendMail throws when all providers fail', async () => {
  const service = new SmtpDeliveryService();
  service.getMaxRetries = () => 1;
  service.getRetryDelayMs = () => 1;
  service.getProviders = () => [
    { name: 'Primary', host: 'p', port: '465', user: 'u', pass: 'x', from: '' },
    { name: 'Secondary', host: 's', port: '587', user: 'u2', pass: 'y', from: 'u2' },
  ];
  service.getTransporter = () => ({
    sendMail: async () => {
      const err = new Error('ECONNREFUSED');
      err.code = 'ECONNREFUSED';
      throw err;
    },
  });
  service.recreateTransporter = (provider) => service.getTransporter(provider);

  await assert.rejects(
    () => service.sendMail({ to: 'a@b.com', subject: 't', text: 'body' }),
    /ECONNREFUSED/
  );
});
