const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatMfaActionLabel,
  formatMaintenanceStatusLabel,
  formatMaintenancePriorityLabel,
  buildPaymentReminderPreheader,
  buildInvoiceUpdatedPreheader,
  buildNoteReminderPreheader,
  buildScreeningApplicationPreheader,
  sanitizePaymentReminderCustomMessage,
} = require('./emailDisplayHelper');

test('formatMfaActionLabel returns user-friendly action text', () => {
  assert.equal(formatMfaActionLabel('login'), 'sign-in');
  assert.equal(formatMfaActionLabel('signup'), 'your account setup');
  assert.equal(formatMfaActionLabel('forgot-password'), 'your password reset');
});

test('formatMaintenanceStatusLabel returns readable status labels', () => {
  assert.equal(formatMaintenanceStatusLabel('InProgress'), 'In progress');
  assert.equal(formatMaintenanceStatusLabel('submitted'), 'Submitted');
});

test('formatMaintenancePriorityLabel returns readable priority labels', () => {
  assert.equal(formatMaintenancePriorityLabel('high'), 'High');
  assert.equal(formatMaintenancePriorityLabel('EMERGENCY'), 'Emergency');
});

test('buildPaymentReminderPreheader summarizes invoice reminder', () => {
  assert.equal(
    buildPaymentReminderPreheader({
      invoiceNumber: 'INV-1',
      outstandingBalance: '$100.00',
      dueDate: 'Jul 01, 2027',
    }),
    'Invoice #INV-1 - $100.00 due Jul 01, 2027.'
  );
});

test('buildInvoiceUpdatedPreheader summarizes invoice update', () => {
  assert.equal(
    buildInvoiceUpdatedPreheader({
      invoiceNumber: 'INV-2',
      amountDue: '$50.00',
      dueDate: 'Aug 01, 2027',
    }),
    'Invoice #INV-2 was updated - $50.00 due Aug 01, 2027.'
  );
});

test('buildInvoiceUpdatedPreheader prefers the actual change summary', () => {
  assert.equal(
    buildInvoiceUpdatedPreheader({
      invoiceNumber: 'INV597909',
      changeSummary: 'Due date updated from August 17, 2026 to August 25, 2026.',
    }),
    'Invoice #INV597909 updated. Due date updated from August 17, 2026 to August 25, 2026.'
  );
});

test('buildNoteReminderPreheader summarizes note reminder', () => {
  assert.equal(
    buildNoteReminderPreheader({
      noteTitle: 'Follow up',
      reminderAt: 'Jul 01, 2027, 08:00 AM',
    }),
    'Reminder for "Follow up" on Jul 01, 2027, 08:00 AM.'
  );
});

test('buildScreeningApplicationPreheader summarizes screening invite', () => {
  assert.equal(
    buildScreeningApplicationPreheader({
      landlordName: 'Jane Doe',
      propertyName: 'Oak Apartments',
    }),
    'Jane Doe invited you to complete tenant screening for Oak Apartments.'
  );
});

test('sanitizePaymentReminderCustomMessage removes duplicate greeting and invoice dump', () => {
  const body = [
    'Hi Alisha,',
    '',
    'This is a friendly reminder that the following invoice has an outstanding balance.',
    '',
    'Invoice #: INV-1001',
    'Property: Sunset Ridge',
    'Unit: 4B',
    'Description: HOA Dues',
    'Invoice Amount: $475.00',
    'Outstanding Balance: $475.00',
    'Due Date: July 1, 2025',
    'Status: Unpaid',
    '',
    'You can pay directly using the Pay Invoice button in this email.',
    '',
    'If you have already completed your payment, please ignore this message.',
    '',
    'If you have any questions about the payment process, please feel free to contact us.',
  ].join('\n');

  assert.equal(
    sanitizePaymentReminderCustomMessage(body),
    [
      'This is a friendly reminder that the following invoice has an outstanding balance.',
      '',
      'If you have any questions about the payment process, please feel free to contact us.',
    ].join('\n')
  );
});

test('sanitizePaymentReminderCustomMessage strips a leading greeting prefix', () => {
  assert.equal(
    sanitizePaymentReminderCustomMessage('Hi Alisha Gupta, please call us if you need a payment plan.'),
    'please call us if you need a payment plan.'
  );
});

test('sanitizePaymentReminderCustomMessage keeps a custom note without template fields', () => {
  assert.equal(
    sanitizePaymentReminderCustomMessage('We can waive the late fee if payment arrives this week.'),
    'We can waive the late fee if payment arrives this week.'
  );
});

test('sanitizePaymentReminderCustomMessage returns empty for blank or non-string input', () => {
  assert.equal(sanitizePaymentReminderCustomMessage(''), '');
  assert.equal(sanitizePaymentReminderCustomMessage('   \n  '), '');
  assert.equal(sanitizePaymentReminderCustomMessage(null), '');
});
