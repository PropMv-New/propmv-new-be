'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  templateEnvKey,
  isEmailSendingEnabled,
  isEmailTemplateEnabled,
  getEmailTemplateFlagsStatus,
  KNOWN_EMAIL_TEMPLATES,
} = require('./emailTemplateFlags');

test('templateEnvKey maps slug to EMAIL_TEMPLATE_*_ENABLED', () => {
  assert.equal(templateEnvKey('invoice-due-today'), 'EMAIL_TEMPLATE_INVOICE_DUE_TODAY_ENABLED');
  assert.equal(templateEnvKey('hoa-board-invite'), 'EMAIL_TEMPLATE_HOA_BOARD_INVITE_ENABLED');
  assert.equal(templateEnvKey('mfa-otp'), 'EMAIL_TEMPLATE_MFA_OTP_ENABLED');
  assert.equal(templateEnvKey(''), null);
});

test('isEmailTemplateEnabled defaults to true when unset', () => {
  const env = {};
  assert.equal(isEmailSendingEnabled(env), true);
  assert.equal(isEmailTemplateEnabled('invoice-due-today', env), true);
  assert.equal(isEmailTemplateEnabled('welcome', env), true);
});

test('isEmailTemplateEnabled accepts false/off/0/no', () => {
  assert.equal(
    isEmailTemplateEnabled('invoice-due-today', {
      EMAIL_TEMPLATE_INVOICE_DUE_TODAY_ENABLED: 'false',
    }),
    false
  );
  assert.equal(
    isEmailTemplateEnabled('payment-recorded', {
      EMAIL_TEMPLATE_PAYMENT_RECORDED_ENABLED: 'off',
    }),
    false
  );
  assert.equal(
    isEmailTemplateEnabled('invite', { EMAIL_TEMPLATE_INVITE_ENABLED: '0' }),
    false
  );
  assert.equal(
    isEmailTemplateEnabled('forgot-password', {
      EMAIL_TEMPLATE_FORGOT_PASSWORD_ENABLED: 'no',
    }),
    false
  );
});

test('isEmailTemplateEnabled accepts true/on/1/yes', () => {
  assert.equal(
    isEmailTemplateEnabled('invoice-overdue', {
      EMAIL_TEMPLATE_INVOICE_OVERDUE_ENABLED: 'true',
    }),
    true
  );
  assert.equal(
    isEmailTemplateEnabled('invoice-overdue', {
      EMAIL_TEMPLATE_INVOICE_OVERDUE_ENABLED: 'on',
    }),
    true
  );
  assert.equal(
    isEmailTemplateEnabled('invoice-overdue', {
      EMAIL_TEMPLATE_INVOICE_OVERDUE_ENABLED: '1',
    }),
    true
  );
  assert.equal(
    isEmailTemplateEnabled('invoice-overdue', {
      EMAIL_TEMPLATE_INVOICE_OVERDUE_ENABLED: 'yes',
    }),
    true
  );
});

test('EMAIL_SENDING_ENABLED=false disables all templates', () => {
  const env = {
    EMAIL_SENDING_ENABLED: 'false',
    EMAIL_TEMPLATE_WELCOME_ENABLED: 'true',
  };
  assert.equal(isEmailSendingEnabled(env), false);
  assert.equal(isEmailTemplateEnabled('welcome', env), false);
});

test('KNOWN_EMAIL_TEMPLATES includes HOA owner + board templates from docs', () => {
  const required = [
    'invoice-due-today',
    'invoice-overdue',
    'invoice-schedule-summary',
    'late-fee-notification',
    'invite',
    'unit-assignment',
    'owner-removal-notice',
    'invoice-created',
    'payment-reminder',
    'payment-recorded',
    'payment-deleted',
    'invoice-updated',
    'invoice-balance-waived',
    'hoa-board-invite',
    'payment-received',
    'maintenance-request-created-landlord',
    'maintenance-ticket-created',
    'maintenance-ticket-assigned',
    'hoa-document-uploaded',
    'hoa-board-access-removed',
    'ownership-change-scheduled',
    'ownership-change-effective',
  ];
  for (const name of required) {
    assert.ok(KNOWN_EMAIL_TEMPLATES.includes(name), `missing ${name}`);
  }
});

test('getEmailTemplateFlagsStatus reports env keys and enabled state', () => {
  const status = getEmailTemplateFlagsStatus({
    EMAIL_TEMPLATE_INVOICE_DUE_TODAY_ENABLED: 'off',
  });
  assert.equal(status.sendingEnabled, true);
  const due = status.templates.find((t) => t.template === 'invoice-due-today');
  assert.ok(due);
  assert.equal(due.envKey, 'EMAIL_TEMPLATE_INVOICE_DUE_TODAY_ENABLED');
  assert.equal(due.enabled, false);
});
