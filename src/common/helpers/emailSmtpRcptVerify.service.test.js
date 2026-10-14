const test = require('node:test');
const assert = require('node:assert/strict');

process.env.EMAIL_VALIDATION_LOG = 'false';
process.env.EMAIL_SUPPRESSION_ENABLED = 'false';
process.env.EMAIL_VALIDATE_MX = 'false';
process.env.EMAIL_BLOCK_TYPO_DOMAINS = 'false';
process.env.EMAIL_BLOCK_DISPOSABLE_DOMAINS = 'false';
process.env.EMAIL_MAILBOX_VERIFY_ENABLED = 'false';
process.env.EMAIL_SMTP_RCPT_VERIFY_ENABLED = 'true';
process.env.EMAIL_SMTP_RCPT_VERIFY_ON_ERROR = 'allow';

const {
  classifyRcptCode,
  clearSmtpRcptVerifyCache,
  setSmtpRcptProbeOverride,
  verifyMailboxViaSmtpRcpt,
  isEnabled,
  logProductionEmailSafetyWarning,
  resolveTlsRejectUnauthorized,
} = require('./emailSmtpRcptVerify.service');

const {
  assertEmailCanReceive,
  INVALID_RECIPIENT_MESSAGE,
} = require('./emailRecipientValidation.service');

test.afterEach(() => {
  clearSmtpRcptVerifyCache();
  setSmtpRcptProbeOverride(null);
});

test('classifyRcptCode treats 550 as reject and 250 as accept', () => {
  assert.equal(classifyRcptCode(250), 'accept');
  assert.equal(classifyRcptCode(550), 'reject');
  assert.equal(classifyRcptCode(451), 'temp');
  assert.equal(classifyRcptCode(252), 'unknown');
});

test('isEnabled respects EMAIL_SMTP_RCPT_VERIFY_ENABLED', () => {
  process.env.EMAIL_SMTP_RCPT_VERIFY_ENABLED = 'true';
  assert.equal(isEnabled(), true);
  process.env.EMAIL_SMTP_RCPT_VERIFY_ENABLED = 'false';
  assert.equal(isEnabled(), false);
  process.env.EMAIL_SMTP_RCPT_VERIFY_ENABLED = 'true';
});

test('resolveTlsRejectUnauthorized defaults to verifying STARTTLS certificates', () => {
  const prev = process.env.SMTP_TLS_REJECT_UNAUTHORIZED;
  try {
    delete process.env.SMTP_TLS_REJECT_UNAUTHORIZED;
    assert.equal(resolveTlsRejectUnauthorized({ log: false }), true);
    process.env.SMTP_TLS_REJECT_UNAUTHORIZED = 'false';
    assert.equal(resolveTlsRejectUnauthorized({ log: false }), false);
  } finally {
    if (prev == null) {
      delete process.env.SMTP_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.SMTP_TLS_REJECT_UNAUTHORIZED = prev;
    }
  }
});

test('verifyMailboxViaSmtpRcpt rejects when probe returns reject', async () => {
  setSmtpRcptProbeOverride(async () => ({
    ok: false,
    status: 'reject',
    code: 550,
    response: '550 5.1.1 User unknown',
  }));
  const result = await verifyMailboxViaSmtpRcpt('nobody@gmail.com', ['gmail-smtp-in.l.google.com']);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'reject');
  assert.equal(result.code, 550);
});

test('assertEmailCanReceive blocks Hostinger-style nonexistent Gmail via RCPT probe', async () => {
  process.env.EMAIL_SMTP_RCPT_VERIFY_ENABLED = 'true';
  setSmtpRcptProbeOverride(async () => ({
    ok: false,
    status: 'reject',
    code: 550,
    response: '550 5.1.1 The email account that you tried to reach does not exist.',
  }));

  await assert.rejects(
    () =>
      assertEmailCanReceive('pawardurva406@gmail.com', {
        context: 'test:rcpt',
        skipMx: true,
        skipMailbox: true,
      }),
    (err) => {
      assert.equal(err.isEmailValidationError, true);
      assert.equal(err.code, 'EMAIL_SMTP_RCPT_REJECT');
      assert.equal(err.message, INVALID_RECIPIENT_MESSAGE);
      return true;
    }
  );
});

test('assertEmailCanReceive allows address when RCPT probe accepts', async () => {
  process.env.EMAIL_SMTP_RCPT_VERIFY_ENABLED = 'true';
  setSmtpRcptProbeOverride(async () => ({
    ok: true,
    status: 'accept',
    code: 250,
    response: '250 2.1.5 OK',
  }));

  const result = await assertEmailCanReceive('real.user@gmail.com', {
    context: 'test:rcpt-ok',
    skipMx: true,
    skipMailbox: true,
  });
  assert.equal(result.email, 'real.user@gmail.com');
});

test('logProductionEmailSafetyWarning does not throw', () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  process.env.EMAIL_SMTP_RCPT_VERIFY_ENABLED = 'false';
  process.env.EMAIL_MAILBOX_VERIFY_ENABLED = 'false';
  process.env.EMAIL_BOUNCE_WEBHOOK_SECRET = '';
  assert.doesNotThrow(() => logProductionEmailSafetyWarning());
  process.env.NODE_ENV = prev;
  process.env.EMAIL_SMTP_RCPT_VERIFY_ENABLED = 'true';
});
