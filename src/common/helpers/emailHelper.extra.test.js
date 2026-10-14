const test = require('node:test');
const assert = require('node:assert/strict');
const { composeEmailPreview, stripHtmlForPlainText } = require('./emailHelper');

test('stripHtmlForPlainText removes head/style/script content before tag stripping', () => {
    const html = '<html><head><title>Test</title><style>body{color:red;}</style></head><body><p>Hello</p></body></html>';
    const result = stripHtmlForPlainText(html);
    assert.equal(result.includes('body{color:red;}'), false);
    assert.equal(result.includes('Test'), false);
    assert.equal(result.includes('Hello'), true);
});

test('composeEmailPreview preview text does not include CSS content for invoice-created', async () => {
    const preview = await composeEmailPreview('invoice-created', 'test@example.com', {
        recipientName: 'Jane Owner',
        invoiceNumber: 'INV123',
        propertyName: 'Sunset HOA',
        unitNumber: 'Unit 12',
        amountDue: '$300.00',
        dueDate: 'Jun 17, 2026',
        viewInvoiceUrl: 'https://app.propmv.com/invoices/123',
        communityName: 'Green Valley HOA',
        organizationDisplayName: 'Green Valley HOA',
    }, {
      subject: 'New invoice #INV123 - Green Valley HOA',
      preheaderText: 'Invoice #INV123 - $300.00 due Jun 17, 2026.',
    });

    assert.match(preview.text, /^Invoice #INV123 - \$300\.00 due Jun 17, 2026\./);
    assert.equal(preview.text.includes('body.pmv-body'), false);
    assert.equal(preview.text.includes('margin: 0 !important'), false);
});
