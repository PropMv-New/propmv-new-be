'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const logger = require('./logger');

function capture(method, fn) {
  const lines = [];
  const original = console[method];
  console[method] = (line) => lines.push(String(line));
  try {
    fn();
  } finally {
    console[method] = original;
  }
  return lines.join('\n');
}

describe('logger secret redaction', () => {
  it('does not print OTP or password values embedded in the message', () => {
    const output = capture('warn', () => {
      logger.warn('[Auth] otp   : 123456');
      logger.warn('[Auth] password=SuperSecret1!');
      logger.warn('Authorization: Bearer abc.def.ghi');
    });

    assert.equal(output.includes('123456'), false);
    assert.equal(output.includes('SuperSecret1!'), false);
    assert.equal(output.includes('abc.def.ghi'), false);
    assert.match(output, /otp: \[REDACTED\]/);
    assert.match(output, /password: \[REDACTED\]/);
    assert.match(output, /Authorization: \[REDACTED\]/);
  });

  it('does not print a secret passed as the next log argument', () => {
    const output = capture('warn', () => {
      logger.warn('[Auth] otp  :', '654321');
      logger.warn('[Auth] password:', 'AnotherSecret!');
    });

    assert.equal(output.includes('654321'), false);
    assert.equal(output.includes('AnotherSecret!'), false);
    assert.match(output, /\[REDACTED\]/);
  });

  it('keeps ordinary error text', () => {
    const output = capture('error', () => {
      logger.error('Forgot password error:', new Error('user not found'));
    });

    assert.match(output, /Forgot password error/);
    assert.match(output, /user not found/);
  });

  it('redacts secrets inside stringified payloads', () => {
    const output = capture('log', () => {
      logger.info(
        '[createUnit] payload',
        JSON.stringify({ name: 'Unit A', mfaOtp: '111222', smtpPassword: 'hide-me' })
      );
    });

    assert.equal(output.includes('111222'), false);
    assert.equal(output.includes('hide-me'), false);
    assert.match(output, /Unit A/);
  });
});
