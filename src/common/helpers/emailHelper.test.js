const test = require('node:test');
const assert = require('node:assert/strict');
const { renderTemplate, finalizeRenderedEmailHtml, extractPreheaderText } = require('./emailHelper');
const { buildManagerEmailContent, roleKeyFromName } = require('./maintenanceEmailContent');

test('renderTemplate resolves {{#if}} / {{else}} blocks', () => {
  const html = renderTemplate(
    '<span class="{{#if notifyTenant}}yes{{else}}no{{/if}}">{{#if notifyTenant}}On{{else}}Off{{/if}}</span>',
    { notifyTenant: true }
  );
  assert.equal(html, '<span class="yes">On</span>');
});

test('renderTemplate hides false {{#if}} branches', () => {
  const html = renderTemplate(
    '{{#if notifyTenant}}Tenants notified{{else}}Tenants not notified{{/if}}',
    { notifyTenant: false }
  );
  assert.equal(html, 'Tenants not notified');
});

test('renderTemplate supports {{#each}} with object items', () => {
  const html = renderTemplate('{{#each steps}}<li>{{text}}</li>{{/each}}', {
    steps: [{ text: 'One' }, { text: 'Two' }],
  });
  assert.equal(html, '<li>One</li><li>Two</li>');
});

test('renderTemplate resolves {{#unless}} blocks', () => {
  const html = renderTemplate(
    'Headline{{#unless hideYear}} for 2027{{/unless}}',
    { hideYear: true }
  );
  assert.equal(html, 'Headline');
});

test('renderTemplate resolves nested {{#if ../parentKey}} inside {{#each}}', () => {
  const html = renderTemplate(
    '{{#each invoiceRows}}<td>{{invoiceNumber}}</td>{{#if ../showOwnerColumn}}<td>{{ownerName}}</td>{{/if}}{{/each}}',
    {
      showOwnerColumn: true,
      invoiceRows: [
        { invoiceNumber: 'INV1', ownerName: 'Jane Owner' },
        { invoiceNumber: 'INV2', ownerName: 'John Owner' },
      ],
    }
  );
  assert.equal(html, '<td>INV1</td><td>Jane Owner</td><td>INV2</td><td>John Owner</td>');
});

test('renderTemplate resolves unescaped {{{key}}} placeholders', () => {
  const html = renderTemplate('<p>{{{introText}}}</p>', {
    introText: 'Invoices for <strong>2027</strong> are ready.',
  });
  assert.equal(html, '<p>Invoices for <strong>2027</strong> are ready.</p>');
});

test('invoice-schedule-summary template does not leak handlebars tags for owner assignment emails', async () => {
  const { composeEmailPreview } = require('./emailHelper');
  const preview = await composeEmailPreview(
    'invoice-schedule-summary',
    'owner@example.com',
    {
      recipientName: 'Annu Bharti',
      invoiceYear: '2027',
      invoiceCount: '4',
      hasMultipleInvoices: true,
      totalAmountDue: '$400.00',
      isNextYear: false,
      showOwnerColumn: false,
      emailHeadline: 'Invoices for 2027',
      introText:
        'Invoices have been created for <strong>2027</strong> for the following units/properties. Please review the details below.',
      invoiceRows: [
        {
          invoiceNumber: 'INV369499',
          term: 'January 2027',
          dueDate: 'Jan 01, 2027',
          amountDue: '$100.00',
          propertyName: 'qwe',
          unitNumber: '2121',
          location: '15 Emerson Avenue, Rochester, New Hampshire 03867',
          locationUrl: 'https://www.google.com/maps/search/?api=1&query=15%20Emerson%20Avenue',
          applicability: 'Scheduled',
        },
      ],
      viewInvoicesUrl: 'https://app.propmv.com/income',
      organizationDisplayName: 'Ashiyana',
      communityName: 'Ashiyana',
    },
    {
      subject: 'Invoices created for 2027 - Ashiyana',
      preheaderText: '4 invoices created for 2027 - $400.00 total due.',
    }
  );

  assert.equal(preview.html.includes('{{/if}}'), false);
  assert.equal(preview.html.includes('{{#if'), false);
  assert.equal(preview.html.includes('created automatically in advance'), false);
  assert.match(preview.html, /<title>Invoices for 2027 - Ashiyana<\/title>/);
  assert.match(preview.html, /class="pmv-card-table"[^>]*style="[^"]*max-width:\s*600px/i);
  assert.equal(preview.html.includes('pmv-wide'), false);
  assert.ok(preview.html.includes('INVOICE DETAILS'));
  assert.ok(preview.html.includes('View invoices'));
});

test('invoice-schedule-summary template shows next-year banner only for cron next-year emails', async () => {
  const { composeEmailPreview } = require('./emailHelper');
  const preview = await composeEmailPreview(
    'invoice-schedule-summary',
    'owner@example.com',
    {
      recipientName: 'Jai Dev',
      invoiceYear: '2027',
      invoiceCount: '2',
      hasMultipleInvoices: true,
      totalAmountDue: '$500.00',
      isNextYear: true,
      showOwnerColumn: false,
      introText:
        'Your invoices for the upcoming billing year (<strong>2027</strong>) have been created automatically in advance. Please review the details below and payment schedule.',
      invoiceRows: [
        {
          invoiceNumber: 'INV101503',
          term: 'January 2027',
          dueDate: 'Jan 05, 2027',
          amountDue: '$250.00',
          propertyName: 'Sunset HOA',
          unitNumber: 'Unit 12',
          location: '123 Main St',
          applicability: 'Scheduled',
        },
      ],
      viewInvoicesUrl: 'https://app.propmv.com/income',
      organizationDisplayName: 'Ashiyana',
    },
    {
      subject: 'Your Next-Year HOA Invoices Have Been Created - Ashiyana',
    }
  );

  assert.equal(preview.html.includes('{{/if}}'), false);
  assert.ok(preview.html.includes('created automatically in advance'));
  assert.ok(preview.html.includes('Review invoices'));
});

test('renderTemplate hides nested {{#if ../parentKey}} when parent flag is false', () => {
  const html = renderTemplate(
    '{{#each invoiceRows}}<td>{{invoiceNumber}}</td>{{#if ../showOwnerColumn}}<td>{{ownerName}}</td>{{/if}}{{/each}}',
    {
      showOwnerColumn: false,
      invoiceRows: [{ invoiceNumber: 'INV1', ownerName: 'Jane Owner' }],
    }
  );
  assert.equal(html, '<td>INV1</td>');
});

test('buildManagerEmailContent uses HOA owner wording', () => {
  const content = buildManagerEmailContent({
    submitterRoleKey: 'hoa_owner',
    submitterRoleLabel: 'HOA Owner',
    requestedByName: 'Jane Owner',
    isSelfSubmitted: false,
    recipientName: 'Board Admin',
    propertyName: 'Sunset HOA',
    unitName: 'Unit 12',
    requestTitle: 'Leaky faucet',
    isHoaFlow: true,
    notifyTenant: false,
  });

  assert.match(content.emailSubject, /HOA owner maintenance request/i);
  assert.equal(content.showTenantRow, false);
  assert.equal(content.showNotificationRow, false);
  assert.match(content.introParagraph, /Jane Owner/);
  assert.match(content.introParagraph, /HOA Owner/);
});

test('roleKeyFromName maps HOA roles', () => {
  assert.equal(roleKeyFromName('HOA Owner'), 'hoa_owner');
  assert.equal(roleKeyFromName('HOA Board Member'), 'hoa_board');
});

test('finalizeRenderedEmailHtml injects inline hidden preheader before visible shell content', () => {
  const input = `<!doctype html><html><head><title>Invoice overdue - PropMv</title><style>/* comment */ :root { color: red; } body { background-color: #f8fafc; }</style></head><body class="pmv-body"><span class="pmv-preheader">Your invoice #INV1 is overdue.</span><table class="pmv-shell"><tr><td>Hello</td></tr></table></body></html>`;
  const html = finalizeRenderedEmailHtml(input);
  const shellIndex = html.indexOf('class="pmv-shell"');
  const preheaderDiv = html.indexOf('Your invoice #INV1 is overdue.');
  assert.ok(shellIndex > 0);
  assert.ok(preheaderDiv > 0);
  assert.ok(preheaderDiv < shellIndex);
  assert.equal(html.includes('<span class="pmv-preheader">'), false);
  assert.equal(html.includes('/* comment */'), false);
  assert.equal(html.includes(':root'), false);
  assert.equal(html.includes('<style'), false);
  assert.match(html, /max-height:\s*0/);
  assert.equal(html.includes('&zwnj;'), false);
  assert.equal(html.includes('&shy;'), false);
});

test('composeEmailPreview for invoice-due-today avoids CSS and title leaks in snippet text', async () => {
  const { composeEmailPreview } = require('./emailHelper');
  const preview = await composeEmailPreview(
    'invoice-due-today',
    'owner@example.com',
    {
      recipientName: 'Jane Owner',
      invoiceNumber: 'INV924713',
      propertyName: 'Sunset HOA',
      unitNumber: 'Unit 12',
      amountDue: '$250.00',
      dueDate: 'Jun 10, 2026',
      headline: 'Your invoice is due today',
      noticeText: 'Please submit payment today to keep your account current.',
      ctaText: 'Pay now',
      ctaUrl: 'https://app.propmv.com/invoices/123/pay',
      invoiceUrl: 'https://app.propmv.com/invoices/123',
      paymentUrl: 'https://app.propmv.com/invoices/123/pay',
    },
    {
      subject: 'Invoice due today - #INV924713',
      preheaderText: 'Invoice #INV924713 is due today.',
    }
  );

  assert.equal(preview.html.includes(':root'), false);
  assert.equal(preview.html.includes('supported-color-schemes'), false);
  assert.equal(preview.html.includes('<span class="pmv-preheader">'), false);
  assert.equal(preview.html.includes('<style'), false);
  assert.match(preview.text, /^Invoice #INV924713 is due today\./);
  assert.match(preview.html, /class="pmv-card-table"[^>]*style="[^"]*background-color:\s*#ffffff/i);
  assert.match(preview.html, /class="pmv-top-accent"[^>]*style="[^"]*background:\s*linear-gradient/i);
});

test('composeEmailPreview for mfa-otp inlines OTP and card styling for Gmail', async () => {
  const { composeEmailPreview } = require('./emailHelper');
  const preview = await composeEmailPreview('mfa-otp', 'user@example.com', {
    userName: 'Jai',
    otp: '495168',
    action: 'login',
    expiryMinutes: '10',
  });

  assert.match(preview.html, /class="pmv-card-table"[^>]*style="[^"]*border-radius:\s*16px/i);
  assert.match(preview.html, /class="pmv-otp"[^>]*style="[^"]*border:\s*2px dashed/i);
  assert.match(preview.html, /class="pmv-otp-code"[^>]*style="[^"]*font-size:\s*30px/i);
});

test('extractPreheaderText reads span preheader before finalize', () => {
  const html = '<span class="pmv-preheader">Use this verification code to complete your login.</span>';
  assert.equal(
    extractPreheaderText(html),
    'Use this verification code to complete your login.'
  );
});

test('brand header partial renders logo without duplicate PropMv text', async () => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const headerPath = path.join(__dirname, '../email-templates/_pmv-brand-header.html');
  const headerTpl = await fs.readFile(headerPath, 'utf8');
  const html = renderTemplate(headerTpl, {
    logoUrl: 'cid:propmv-logo@propmv',
    logoAltText: '',
    communityName: 'Green Valley HOA',
  });

  assert.match(html, /<img[^>]+src="cid:propmv-logo@propmv"[^>]*alt=""[^>]*>/);
  assert.equal(html.includes('>PropMv<'), false);
  assert.match(html, /width="100"/);
  assert.match(html, /max-width:100px/);
  assert.equal(html.includes('{{/if}}'), false);

  const fallbackHtml = renderTemplate(headerTpl, {
    logoUrl: '',
    brandHeaderText: 'Sunset Garden',
  });
  assert.match(fallbackHtml, />Sunset Garden</);
  assert.equal(fallbackHtml.includes('{{/if}}'), false);
});

test('vendor invite copy describes vendor portal actions (not lease/tenant copy)', () => {
  const {
    inviteEmailSubjectForVendor,
    inviteDescriptionForVendor,
    prepareInviteTemplateData,
    buildPlainTextBody,
  } = require('./emailHelper');

  const subject = inviteEmailSubjectForVendor({
    inviterDisplayName: 'Alex Board',
    communityName: 'Oakwood HOA',
    appName: 'PropMv',
  });
  assert.match(subject, /vendor portal/i);
  assert.equal(subject.includes('as a vendor'), false);

  const description = inviteDescriptionForVendor('Alex Board', 'Oakwood HOA', 'PropMv');
  assert.match(description, /maintenance tickets/i);
  assert.match(description, /invoices/i);
  assert.match(description, /property team/i);
  assert.equal(description.toLowerCase().includes('with the hoa'), false);
  assert.equal(description.toLowerCase().includes('lease'), false);

  const prepared = prepareInviteTemplateData('invite', {
    inviteAudience: 'vendor',
    landlordName: 'Alex Board',
    communityName: 'Oakwood HOA',
    appName: 'PropMv',
    tenantName: 'Sam',
    inviteUrl: 'https://example.com/invite',
  });
  assert.match(prepared.inviteTitle, /vendor portal/i);
  assert.match(prepared.inviteDescription, /update work status/i);

  const plain = buildPlainTextBody('invite', {
    inviteAudience: 'vendor',
    landlordName: 'Alex Board',
    communityName: 'Oakwood HOA',
    appName: 'PropMv',
    tenantName: 'Sam',
    inviteUrl: 'https://example.com/invite',
  });
  assert.match(plain, /Vendor portal invitation/i);
  assert.match(plain, /maintenance tickets/i);
  assert.match(plain, /property team/i);
  assert.equal(plain.toLowerCase().includes('with the hoa'), false);
  assert.equal(plain.includes('for your lease'), false);
});
