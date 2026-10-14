const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('dns').promises;

process.env.EMAIL_VALIDATION_LOG = 'false';
process.env.EMAIL_SUPPRESSION_ENABLED = 'false';

const {
  normalizeEmail,
  isSyntaxValid,
  extractDomain,
  lookupMx,
  assertEmailCanReceive,
  clearMxCache,
  INVALID_RECIPIENT_MESSAGE,
  NO_MX_MESSAGE,
} = require('./emailRecipientValidation.service');

test('normalizeEmail trims and lowercases', () => {
  assert.equal(normalizeEmail('  Foo.Bar@Example.COM '), 'foo.bar@example.com');
});

test('isSyntaxValid rejects malformed addresses', () => {
  assert.equal(isSyntaxValid('not-an-email'), false);
  assert.equal(isSyntaxValid('a@b'), false);
  assert.equal(isSyntaxValid('a@b.c'), false);
  assert.equal(isSyntaxValid('good@example.com'), true);
  assert.equal(isSyntaxValid('  GOOD@Example.com '), true);
});

test('extractDomain returns domain portion', () => {
  assert.equal(extractDomain('user@mail.example.com'), 'mail.example.com');
});

test('assertEmailCanReceive rejects bad syntax without MX lookup', async () => {
  clearMxCache();
  await assert.rejects(
    () =>
      assertEmailCanReceive('bad-email', {
        skipMx: true,
        skipSuppression: true,
        skipSmtpRcpt: true,
        skipMailbox: true,
      }),
    (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.code, 'EMAIL_INVALID_SYNTAX');
      assert.match(err.message, /invalid or cannot receive/i);
      return true;
    }
  );
});

test('lookupMx returns false for domains with no mail servers', async () => {
  clearMxCache();
  // RFC reserved invalid TLD - should not resolve MX
  const result = await lookupMx('this-domain-definitely-does-not-exist-propmv-test.invalid');
  assert.equal(result.ok, false);
});

test('assertEmailCanReceive rejects domains without MX', async () => {
  clearMxCache();
  process.env.EMAIL_VALIDATE_MX = 'true';
  process.env.EMAIL_VALIDATION_LOG = 'false';
  process.env.EMAIL_SUPPRESSION_ENABLED = 'false';

  await assert.rejects(
    () =>
      assertEmailCanReceive('owner@this-domain-definitely-does-not-exist-propmv-test.invalid', {
        skipSuppression: true,
        skipSmtpRcpt: true,
        skipMailbox: true,
      }),
    (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.code, 'EMAIL_NO_MX');
      assert.equal(err.message, NO_MX_MESSAGE);
      return true;
    }
  );
});

test('assertEmailCanReceive accepts gmail.com format with MX (RCPT/mailbox probes skipped)', async () => {
  clearMxCache();
  process.env.EMAIL_VALIDATE_MX = 'true';
  process.env.EMAIL_VALIDATION_LOG = 'false';
  process.env.EMAIL_SUPPRESSION_ENABLED = 'false';

  const originalResolveMx = dns.resolveMx;
  dns.resolveMx = async (domain) => {
    if (domain === 'gmail.com') {
      return [{ exchange: 'gmail-smtp-in.l.google.com', priority: 5 }];
    }
    return originalResolveMx.call(dns, domain);
  };

  let result;
  try {
    result = await assertEmailCanReceive('someone.random.test@gmail.com', {
      skipSuppression: true,
      skipSmtpRcpt: true,
      skipMailbox: true,
    });
  } finally {
    dns.resolveMx = originalResolveMx;
  }

  assert.equal(result.email, 'someone.random.test@gmail.com');
  assert.equal(result.domain, 'gmail.com');
  assert.ok(Array.isArray(result.mxRecords));
  assert.ok(result.mxRecords.length > 0);
});

test('INVALID_RECIPIENT_MESSAGE is user-safe', () => {
  assert.match(INVALID_RECIPIENT_MESSAGE, /verify the address/i);
  assert.doesNotMatch(INVALID_RECIPIENT_MESSAGE, /550|smtp|hostinger/i);
});

test('assertEmailCanReceive rejects typo domains with suggestion', async () => {
  process.env.EMAIL_VALIDATION_LOG = 'false';
  process.env.EMAIL_SUPPRESSION_ENABLED = 'false';
  await assert.rejects(
    () =>
      assertEmailCanReceive('owner@gmial.com', {
        skipMx: true,
        skipSuppression: true,
        skipMailbox: true,
        skipSmtpRcpt: true,
      }),
    (err) => {
      assert.equal(err.code, 'EMAIL_TYPO_DOMAIN');
      assert.equal(err.suggestion, 'owner@gmail.com');
      assert.match(err.message, /Did you mean owner@gmail\.com/);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// MX error policy: EMAIL_MX_ON_LOOKUP_ERROR
// ---------------------------------------------------------------------------

test('lookupMx rejects when DNS returns transient error and ON_LOOKUP_ERROR=reject', async () => {
  clearMxCache();
  const prev = process.env.EMAIL_MX_ON_LOOKUP_ERROR;
  process.env.EMAIL_MX_ON_LOOKUP_ERROR = 'reject';
  const originalResolveMx = dns.resolveMx;
  dns.resolveMx = async () => {
    const err = new Error('getaddrinfo SERVFAIL');
    err.code = 'ESERVFAIL';
    throw err;
  };
  try {
    const result = await lookupMx('transient-error-domain.example');
    assert.equal(result.ok, false);
    assert.ok(result.lookupError, 'lookupError should be set');
  } finally {
    dns.resolveMx = originalResolveMx;
    if (prev == null) delete process.env.EMAIL_MX_ON_LOOKUP_ERROR;
    else process.env.EMAIL_MX_ON_LOOKUP_ERROR = prev;
    clearMxCache();
  }
});

test('lookupMx allows when DNS returns transient error and ON_LOOKUP_ERROR=allow', async () => {
  clearMxCache();
  const prev = process.env.EMAIL_MX_ON_LOOKUP_ERROR;
  process.env.EMAIL_MX_ON_LOOKUP_ERROR = 'allow';
  const originalResolveMx = dns.resolveMx;
  dns.resolveMx = async () => {
    const err = new Error('connection timed out');
    err.code = 'ESERVFAIL';
    throw err;
  };
  try {
    const result = await lookupMx('transient-error-domain.example');
    assert.equal(result.ok, true);
    assert.ok(result.lookupError, 'lookupError should be set');
  } finally {
    dns.resolveMx = originalResolveMx;
    if (prev == null) delete process.env.EMAIL_MX_ON_LOOKUP_ERROR;
    else process.env.EMAIL_MX_ON_LOOKUP_ERROR = prev;
    clearMxCache();
  }
});

test('assertEmailCanReceive rejects when MX lookup errors and ON_LOOKUP_ERROR=reject', async () => {
  clearMxCache();
  process.env.EMAIL_VALIDATE_MX = 'true';
  process.env.EMAIL_MX_ON_LOOKUP_ERROR = 'reject';
  const originalResolveMx = dns.resolveMx;
  dns.resolveMx = async () => {
    const err = new Error('SERVFAIL');
    err.code = 'ESERVFAIL';
    throw err;
  };
  try {
    await assert.rejects(
      () =>
        assertEmailCanReceive('owner@transient-error-domain.example', {
          skipSuppression: true,
          skipSmtpRcpt: true,
          skipMailbox: true,
        }),
      (err) => {
        assert.equal(err.code, 'EMAIL_NO_MX');
        return true;
      }
    );
  } finally {
    dns.resolveMx = originalResolveMx;
    delete process.env.EMAIL_MX_ON_LOOKUP_ERROR;
    clearMxCache();
  }
});

test('assertEmailCanReceive passes when MX lookup errors and ON_LOOKUP_ERROR=allow', async () => {
  clearMxCache();
  process.env.EMAIL_VALIDATE_MX = 'true';
  process.env.EMAIL_MX_ON_LOOKUP_ERROR = 'allow';
  const originalResolveMx = dns.resolveMx;
  dns.resolveMx = async () => {
    const err = new Error('ETIMEOUT');
    err.code = 'ESERVFAIL';
    throw err;
  };
  try {
    const result = await assertEmailCanReceive('owner@transient-error-domain.example', {
      skipSuppression: true,
      skipSmtpRcpt: true,
      skipMailbox: true,
    });
    assert.equal(result.email, 'owner@transient-error-domain.example');
  } finally {
    dns.resolveMx = originalResolveMx;
    delete process.env.EMAIL_MX_ON_LOOKUP_ERROR;
    clearMxCache();
  }
});
