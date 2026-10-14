const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildInvoiceUpdatedEmailCopy,
} = require('./invoiceLifecycleEmail.service');
const { buildInvoiceEmailSubject } = require('./invoiceNotificationEmailHelper');
const { composeEmailPreview, buildPlainTextBody } = require('./emailHelper');

describe('HOA invoice updated owner emails', () => {
  it('builds due-date change copy matching the owner notification example', () => {
    const copy = buildInvoiceUpdatedEmailCopy({
      invoiceNumber: 'INV597909',
      changeDescriptions: [
        'Due date updated from August 17, 2026 to August 25, 2026.',
      ],
    });

    assert.equal(copy.introText, 'An update has been made to your invoice #INV597909.');
    assert.equal(
      copy.changeSummary,
      'Due date updated from August 17, 2026 to August 25, 2026.'
    );
    assert.deepEqual(copy.additionalChanges, []);
  });

  it('uses community name in the subject instead of PropMv', () => {
    const subject = buildInvoiceEmailSubject('Invoice #INV597909 Updated', {
      communityName: 'Sunset Valley HOA',
      organizationDisplayName: 'Sunset Valley HOA',
    });
    assert.equal(subject, 'Invoice #INV597909 Updated - Sunset Valley HOA');
    assert.equal(subject.includes('PropMv'), false);
  });

  it('uses an activity-specific intro for credit applications', () => {
    const copy = buildInvoiceUpdatedEmailCopy({
      invoiceNumber: 'INV597909',
      activityIntro: 'A credit of $150.00 has been applied to your invoice #INV597909.',
    });
    assert.equal(
      copy.introText,
      'A credit of $150.00 has been applied to your invoice #INV597909.'
    );
    assert.equal(copy.changeSummary, '');
  });

  it('invoice-updated plain text includes the change description', () => {
    const text = buildPlainTextBody('invoice-updated', {
      recipientName: 'Jane Owner',
      invoiceNumber: 'INV597909',
      introText: 'An update has been made to your invoice #INV597909.',
      changeSummary: 'Due date updated from August 17, 2026 to August 25, 2026.',
      additionalChanges: [],
      propertyName: 'Sunset Ridge',
      unitNumber: '4B',
      amountDue: '$250.00',
      dueDate: 'August 25, 2026',
      viewInvoiceUrl: 'https://app.propmv.com/invoices/abc',
      communityName: 'Sunset Valley HOA',
      organizationDisplayName: 'Sunset Valley HOA',
    }, '');

    assert.match(text, /Invoice #INV597909 Updated - Sunset Valley HOA/);
    assert.match(text, /An update has been made to your invoice #INV597909\./);
    assert.match(text, /Change: Due date updated from August 17, 2026 to August 25, 2026\./);
    assert.equal(text.includes('PropMv'), false);
  });

  it('invoice-updated preview renders the change and omits PropMv from the subject', async () => {
    const preview = await composeEmailPreview('invoice-updated', 'owner@example.com', {
      recipientName: 'Jane Owner',
      invoiceNumber: 'INV597909',
      introText: 'An update has been made to your invoice #INV597909.',
      changeSummary: 'Due date updated from August 17, 2026 to August 25, 2026.',
      additionalChanges: [],
      propertyName: 'Sunset Ridge',
      unitNumber: '4B',
      amountDue: '$250.00',
      dueDate: 'August 25, 2026',
      viewInvoiceUrl: 'https://app.propmv.com/invoices/abc',
      communityName: 'Sunset Valley HOA',
      organizationDisplayName: 'Sunset Valley HOA',
    }, {
      subject: 'Invoice #INV597909 Updated - Sunset Valley HOA',
      preheaderText: 'Invoice #INV597909 updated. Due date updated from August 17, 2026 to August 25, 2026.',
    });

    assert.equal(preview.subject, 'Invoice #INV597909 Updated - Sunset Valley HOA');
    assert.match(preview.html, /An update has been made to your invoice #INV597909\./);
    assert.match(preview.html, /Due date updated from August 17, 2026 to August 25, 2026\./);
    assert.match(preview.text, /Change: Due date updated from August 17, 2026 to August 25, 2026\./);
  });
});
