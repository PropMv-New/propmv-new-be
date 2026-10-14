const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const invoiceLifecycleEmail = require('../../../../../common/helpers/invoiceLifecycleEmail.service');
const { composeEmailPreview, buildPlainTextBody } = require('../../../../../common/helpers/emailHelper');
const {
  notifyNextYearInvoiceCreatedEmails,
  notifyScheduleInvoiceCreatedEmails,
  filterNextYearInvoices,
  isNextYearInvoice,
} = require('../services/invoiceScheduleNotify.service');

describe('invoice schedule notify emails', () => {
  it('notifyNextYearInvoiceCreatedEmails includes only next-year invoices in the batch', () => {
    const invoices = [
      { _id: '507f1f77bcf86cd799439011', dueDate: new Date('2027-07-05T12:00:00.000Z') },
      { _id: '507f1f77bcf86cd799439012', dueDate: new Date('2026-01-05T12:00:00.000Z') },
      { dueDate: new Date('2027-08-05T12:00:00.000Z') },
    ];

    const count = notifyNextYearInvoiceCreatedEmails(invoices);
    assert.equal(count, 1);
  });

  it('notifyScheduleInvoiceCreatedEmails includes all schedule invoices in the batch', () => {
    const invoices = [
      { _id: '507f1f77bcf86cd799439011', dueDate: new Date('2026-07-05T12:00:00.000Z') },
      { _id: '507f1f77bcf86cd799439012', dueDate: new Date('2020-01-05T12:00:00.000Z') },
      { dueDate: new Date('2026-08-05T12:00:00.000Z') },
    ];

    const count = notifyScheduleInvoiceCreatedEmails(invoices);
    assert.equal(count, 2);
  });

  it('filterNextYearInvoices keeps only invoices due in a future calendar year', () => {
    const invoices = [
      { _id: 'a', dueDate: new Date('2027-01-05T12:00:00.000Z') },
      { _id: 'b', dueDate: new Date('2026-12-05T12:00:00.000Z') },
    ];
    const filtered = filterNextYearInvoices(invoices);
    assert.equal(filtered.length, 1);
    assert.equal(String(filtered[0]._id), 'a');
    assert.equal(isNextYearInvoice(filtered[0]), true);
  });

  it('groups schedule invoices by owner email and calendar year', () => {
    const owner = { email: 'owner@example.com', firstName: 'Jai', lastName: 'Dev' };
    const invoices = [
      {
        _id: '507f1f77bcf86cd799439011',
        dueDate: new Date('2026-01-05T12:00:00.000Z'),
        tenants: [owner],
      },
      {
        _id: '507f1f77bcf86cd799439012',
        dueDate: new Date('2026-02-05T12:00:00.000Z'),
        tenants: [owner],
      },
      {
        _id: '507f1f77bcf86cd799439013',
        dueDate: new Date('2027-01-05T12:00:00.000Z'),
        tenants: [owner],
      },
    ];

    const groups = invoiceLifecycleEmail.groupScheduleInvoicesByRecipientAndYear(invoices);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].invoiceYear, '2026');
    assert.equal(groups[0].invoices.length, 2);
    assert.equal(groups[1].invoiceYear, '2027');
    assert.equal(groups[1].invoices.length, 1);
  });

  it('buildScheduleInvoiceSummaryRow marks future invoices as Scheduled', () => {
    const row = invoiceLifecycleEmail.buildScheduleInvoiceSummaryRow({
      _id: '507f1f77bcf86cd799439011',
      invoiceId: 'INV1001',
      propertyName: 'Sunset HOA',
      unit: 'Unit 12',
      term: 'July 2027',
      dueDate: new Date('2027-07-05T12:00:00.000Z'),
      createdAt: new Date('2026-07-05T12:00:00.000Z'),
      balanceDue: 250,
      subAmount: 250,
    });

    assert.equal(row.invoiceNumber, 'INV1001');
    assert.equal(row.applicability, 'Scheduled');
    assert.equal(row.amountDue, '$250.00');
    assert.match(row.locationUrl, /google\.com\/maps/);
  });

  it('buildScheduleInvoiceSummaryRow includes owner name for board emails', () => {
    const row = invoiceLifecycleEmail.buildScheduleInvoiceSummaryRow({
      _id: '507f1f77bcf86cd799439011',
      invoiceId: 'INV1001',
      propertyName: 'Sunset HOA',
      unit: 'Unit 12',
      term: 'July 2027',
      dueDate: new Date('2027-07-05T12:00:00.000Z'),
      createdAt: new Date('2026-07-05T12:00:00.000Z'),
      balanceDue: 250,
      subAmount: 250,
      tenants: [{ firstName: 'Jai', lastName: 'Dev', email: 'owner@example.com' }],
    }, new Map(), { showOwnerColumn: true });

    assert.equal(row.ownerName, 'Jai Dev');
  });

  it('invoice-schedule-summary html renders next-year board copy without template leaks', async () => {
    const data = {
      recipientName: 'Board Admin',
      invoiceYear: '2027',
      invoiceCount: '8',
      hasMultipleInvoices: true,
      totalAmountDue: '$800.00',
      isNextYear: true,
      audience: 'board',
      showOwnerColumn: true,
      emailHeadline: 'Next-Year HOA Invoices Created',
      introText:
        'Next-year invoices have been automatically generated for the applicable HOA owners for <strong>2027</strong>. Please review the upcoming invoices below.',
      invoiceRows: [
        {
          invoiceNumber: 'INV807134',
          term: 'January 2027',
          dueDate: 'Jan 01, 2027',
          amountDue: '$100.00',
          propertyName: 'qwe',
          unitNumber: 'unit-12',
          location: '15 Emerson Avenue, Warwick,',
          ownerName: 'Annu Bharti',
          applicability: 'Scheduled',
        },
      ],
      viewInvoicesUrl: 'https://app.propmv.com/income',
      organizationDisplayName: 'Ashiyana',
      communityName: 'Ashiyana',
    };

    const preview = await composeEmailPreview('invoice-schedule-summary', 'board@example.com', data, {
      subject: 'Next-Year HOA Invoices Created - Ashiyana',
      preheaderText: '8 next-year invoices created for 2027 - review required.',
    });

    assert.equal(preview.html.includes('{{#unless'), false);
    assert.equal(preview.html.includes('{{#if'), false);
    assert.equal(preview.html.includes('{{/if}}'), false);
    assert.equal(preview.html.includes('{{/unless}}'), false);
    assert.ok(preview.html.includes('Next-Year HOA Invoices Created'));
    assert.ok(preview.html.includes('Annu Bharti'));
    assert.ok(preview.html.includes('January 2027'));
    assert.ok(preview.html.includes('<strong>2027</strong>'));
    assert.equal(preview.html.includes('{Next-year invoices'), false);
  });

  it('invoice-schedule-summary plain text supports next-year owner copy', async () => {
    const data = {
      recipientName: 'Jai Dev',
      invoiceYear: '2027',
      invoiceCount: '2',
      hasMultipleInvoices: true,
      totalAmountDue: '$500.00',
      isNextYear: true,
      audience: 'owner',
      invoiceRows: [
        {
          invoiceNumber: 'INV101503',
          term: 'January 2027',
          dueDate: 'Jan 05, 2027',
          amountDue: '$250.00',
          propertyName: 'Sunset HOA',
          unitNumber: 'Unit 12',
          location: '123 Main St, Richmond, VA',
          applicability: 'Scheduled',
        },
        {
          invoiceNumber: 'INV101504',
          term: 'February 2027',
          dueDate: 'Feb 05, 2027',
          amountDue: '$250.00',
          propertyName: 'Sunset HOA',
          unitNumber: 'Unit 12',
          location: '123 Main St, Richmond, VA',
          applicability: 'Scheduled',
        },
      ],
      viewInvoicesUrl: 'https://app.propmv.com/income',
      organizationDisplayName: 'Ashiyana',
    };

    const text = buildPlainTextBody('invoice-schedule-summary', data, '');
    assert.match(text, /Your Next-Year HOA Invoices Have Been Created/);
    assert.match(text, /upcoming billing year \(2027\)/);
  });

  it('invoice-schedule-summary plain text body includes consolidated invoice details', async () => {
    const data = {
      recipientName: 'Jai Dev',
      invoiceYear: '2026',
      invoiceCount: '2',
      hasMultipleInvoices: true,
      totalAmountDue: '$500.00',
      invoiceRows: [
        {
          invoiceNumber: 'INV101503',
          term: 'January 2026',
          invoiceDate: 'Jul 05, 2026',
          dueDate: 'Jan 05, 2026',
          amountDue: '$250.00',
          propertyName: 'Sunset HOA',
          unitNumber: 'Unit 12',
          location: '123 Main St, Richmond, VA',
          applicability: 'Applicable',
          viewInvoiceUrl: 'https://app.propmv.com/invoices/abc',
        },
        {
          invoiceNumber: 'INV101504',
          term: 'February 2026',
          invoiceDate: 'Jul 05, 2026',
          dueDate: 'Feb 05, 2026',
          amountDue: '$250.00',
          propertyName: 'Sunset HOA',
          unitNumber: 'Unit 12',
          location: '123 Main St, Richmond, VA',
          applicability: 'Scheduled',
          viewInvoiceUrl: 'https://app.propmv.com/invoices/def',
        },
      ],
      viewInvoicesUrl: 'https://app.propmv.com/invoices',
      communityName: 'Ashiyana',
      organizationDisplayName: 'Ashiyana',
    };

    const text = buildPlainTextBody('invoice-schedule-summary', data, '');
    assert.match(text, /Invoices created for 2026 - Ashiyana/);
    assert.match(text, /Billing year: 2026/);
    assert.match(text, /Invoice count: 2/);
    assert.match(text, /Total amount due: \$500\.00/);
    assert.match(text, /Invoice #INV101503/);
    assert.match(text, /Status: Applicable/);
    assert.match(text, /Status: Scheduled/);
    assert.match(text, /https:\/\/app\.propmv\.com\/invoices/);

    const preview = await composeEmailPreview('invoice-schedule-summary', 'owner@example.com', {
      ...data,
      communityName: 'Green Valley HOA',
      organizationDisplayName: 'Green Valley HOA',
    }, {
      subject: 'Invoices created for 2026 - Green Valley HOA',
      preheaderText: '2 invoices created for 2026 - $500.00 total due.',
    });

    assert.match(preview.text, /2 invoices created for 2026 - \$500\.00 total due\./);
    assert.match(preview.text, /Hi Jai Dev,/);
    assert.ok(preview.html.includes('Invoices for 2026'));
    assert.equal(preview.html.includes('Invoices for 2026 for 2026'), false);
    assert.equal(preview.html.includes('created automatically in advance'), false);
    assert.equal(preview.html.includes('{{/if}}'), false);
    assert.ok(preview.html.includes('INVOICE DETAILS'));
    assert.ok(preview.html.length >= 400);
  });

  it('invoice-created plain text body includes invoice details for Gmail fallback', async () => {
    const data = {
      recipientName: 'Jai Dev',
      invoiceNumber: 'INV101503',
      propertyName: 'Sunset HOA',
      unitNumber: 'Unit 12',
      amountDue: '$250.00',
      dueDate: 'Jul 05, 2026',
      viewInvoiceUrl: 'https://app.propmv.com/invoices/abc',
      communityName: 'Ashiyana',
      organizationDisplayName: 'Ashiyana',
    };

    const text = buildPlainTextBody('invoice-created', data, '');
    assert.match(text, /New invoice - Ashiyana/);
    assert.match(text, /Hi Jai Dev,/);
    assert.match(text, /Invoice #: INV101503/);
    assert.match(text, /Amount due: \$250\.00/);
    assert.match(text, /Due date: Jul 05, 2026/);
    assert.match(text, /https:\/\/app\.propmv\.com\/invoices\/abc/);

    const preview = await composeEmailPreview('invoice-created', 'owner@example.com', {
      ...data,
      communityName: 'Green Valley HOA',
      organizationDisplayName: 'Green Valley HOA',
    }, {
      subject: 'New invoice #INV101503 - Green Valley HOA',
      preheaderText: 'Invoice #INV101503 - $250.00 due Jul 05, 2026.',
    });

    assert.match(preview.text, /^Invoice #INV101503 - \$250\.00 due Jul 05, 2026\./);
    assert.match(preview.text, /Hi Jai Dev,/);
    assert.ok(preview.html.includes('A new invoice is ready for your review.'));
    assert.ok(preview.html.length >= 400);
  });

  it('resolveInvoiceAmountForEmail prefers balanceDue for owner-facing created emails', () => {
    const { resolveInvoiceAmountForEmail, buildInvoiceEmailData } = invoiceLifecycleEmail;
    const invoice = {
      _id: '507f1f77bcf86cd799439011',
      balanceDue: 180,
      subAmount: 250,
      principalSubAmount: 250,
      dueDate: new Date('2027-01-05T12:00:00.000Z'),
    };

    assert.equal(resolveInvoiceAmountForEmail(invoice, { useSubAmount: false }), 180);
    const data = buildInvoiceEmailData(invoice, { firstName: 'Jai', lastName: 'Dev' }, { useSubAmount: false });
    assert.equal(data.amountDue, '$180.00');
  });
});
