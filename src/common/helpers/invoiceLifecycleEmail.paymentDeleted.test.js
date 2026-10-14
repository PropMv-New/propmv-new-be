const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildInvoiceEmailSubject } = require('./invoiceNotificationEmailHelper');
const { composeEmailPreview, buildPlainTextBody } = require('./emailHelper');

describe('HOA payment deleted owner emails', () => {
  it('uses community name in the subject instead of PropMv', () => {
    const subject = buildInvoiceEmailSubject('Payment removed - Invoice INV597909', {
      communityName: 'Sunset Valley HOA',
      organizationDisplayName: 'Sunset Valley HOA',
    });
    assert.equal(subject, 'Payment removed - Invoice INV597909 - Sunset Valley HOA');
    assert.equal(subject.includes('PropMv'), false);
  });

  it('payment-deleted plain text includes the removed amount and remaining balance', () => {
    const text = buildPlainTextBody('payment-deleted', {
      recipientName: 'Jane Owner',
      invoiceNumber: 'INV597909',
      paymentAmount: '$150.00',
      paymentMethod: 'Check',
      paidOn: 'August 10, 2026',
      deletedByName: 'Board Treasurer',
      deletedAt: 'August 17, 2026 at 3:00 PM',
      remainingBalance: '$250.00',
      propertyName: 'Sunset Ridge',
      unitNumber: '4B',
      viewInvoiceUrl: 'https://app.propmv.com/invoices/abc',
      communityName: 'Sunset Valley HOA',
      organizationDisplayName: 'Sunset Valley HOA',
    }, '');

    assert.match(text, /Payment removed - Invoice INV597909 - Sunset Valley HOA/);
    assert.match(text, /We've removed a payment previously posted to invoice #INV597909\./);
    assert.match(text, /Amount removed: \$150\.00/);
    assert.match(text, /Remaining balance: \$250\.00/);
    assert.equal(text.includes('PropMv'), false);
  });

  it('payment-deleted preview renders the removal details and omits PropMv from the subject', async () => {
    const preview = await composeEmailPreview('payment-deleted', 'owner@example.com', {
      recipientName: 'Jane Owner',
      invoiceNumber: 'INV597909',
      paymentAmount: '$150.00',
      paymentMethod: 'Check',
      paidOn: 'August 10, 2026',
      deletedByName: 'Board Treasurer',
      deletedAt: 'August 17, 2026 at 3:00 PM',
      remainingBalance: '$250.00',
      propertyName: 'Sunset Ridge',
      unitNumber: '4B',
      viewInvoiceUrl: 'https://app.propmv.com/invoices/abc',
      communityName: 'Sunset Valley HOA',
      organizationDisplayName: 'Sunset Valley HOA',
    }, {
      subject: 'Payment removed - Invoice INV597909 - Sunset Valley HOA',
      preheaderText: 'Payment of $150.00 was removed from invoice INV597909.',
    });

    assert.equal(preview.subject, 'Payment removed - Invoice INV597909 - Sunset Valley HOA');
    assert.match(preview.html, /Payment removed from your invoice/);
    assert.match(preview.html, /\$150\.00/);
    assert.match(preview.html, /Remaining balance/);
    assert.match(preview.text, /We've removed a payment previously posted to invoice #INV597909\./);
  });
});
