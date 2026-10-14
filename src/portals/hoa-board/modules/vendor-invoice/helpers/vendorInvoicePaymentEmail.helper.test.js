'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

const HELPER_PATH = require.resolve('./vendorInvoicePaymentEmail.helper');

const VENDOR_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const BOARD_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const ACTOR_BOARD_ID = 'cccccccccccccccccccccccc';

function endsWithPath(request, ...segments) {
  const normalized = String(request).replace(/\\/g, '/');
  return segments.some((segment) => normalized.endsWith(segment));
}

function loadHelperWithStubs({
  recipientIds = [BOARD_ID],
  users = [
    { _id: VENDOR_ID, firstName: 'Pat', lastName: 'Vendor', email: 'pat@example.com' },
    { _id: BOARD_ID, firstName: 'Bo', lastName: 'Board', email: 'board@example.com' },
  ],
  sendResult = { sent: true },
} = {}) {
  delete require.cache[HELPER_PATH];

  const calls = { send: [], recipients: [] };
  const originalLoad = Module._load;

  Module._load = function patched(request, parent, isMain) {
    if (endsWithPath(request, 'hoaRecipientResolver.js', 'hoaRecipientResolver')) {
      return {
        resolveVendorInvoiceNotificationRecipients: async (invoice, actorUserId) => {
          calls.recipients.push({ invoiceId: String(invoice?._id), actorUserId });
          // Simulate actor exclusion already applied by resolver
          return recipientIds.filter((id) => String(id) !== String(actorUserId || ''));
        },
        toIdString: (value) => {
          if (!value) return '';
          if (typeof value === 'object' && value._id) return String(value._id);
          return String(value);
        },
      };
    }
    if (endsWithPath(request, 'user.model.js', 'users/models/user.model')) {
      return {
        find: (query) => ({
          select: () => ({
            lean: async () => {
              const ids = (query._id?.$in || []).map((id) => String(id));
              return users.filter((u) => ids.includes(String(u._id)));
            },
          }),
        }),
      };
    }
    if (endsWithPath(request, 'transactionalEmail.service.js', 'transactionalEmail.service')) {
      return {
        sendTransactionalEmail: async (payload) => {
          calls.send.push(payload);
          return sendResult;
        },
        buildEventKey: (...parts) => parts.join(':'),
      };
    }
    if (endsWithPath(request, 'communityEmailContext.service.js', 'communityEmailContext.service')) {
      return {
        resolveCommunityName: async () => 'Sunrise HOA',
        buildCommunityEmailSubject: (base, community) => (community ? `${community}: ${base}` : base),
      };
    }
    if (endsWithPath(request, 'hoaBillingDates.js', 'hoaBillingDates')) {
      return {
        formatDateInAppTimezone: () => '2026-10-11',
      };
    }
    if (endsWithPath(request, 'invoiceNotificationEmailHelper.js', 'invoiceNotificationEmailHelper')) {
      return {
        formatMoney: (value) => `$${Number(value).toFixed(2)}`,
      };
    }
    if (endsWithPath(request, `${path.posix.join('common', 'date')}`, 'common/date.js', 'common/date/index.js', 'common/date')) {
      return {
        ClockService: { now: () => new Date('2026-10-11T12:00:00.000Z') },
        DateUtil: { toDateOnlyISO: () => '2026-10-11' },
      };
    }
    if (endsWithPath(request, 'common/logger.js', 'common/logger')) {
      return { error: () => {}, warn: () => {}, info: () => {} };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const helper = require('./vendorInvoicePaymentEmail.helper');
    return { helper, calls };
  } finally {
    Module._load = originalLoad;
  }
}

describe('vendorInvoicePaymentEmail.helper', () => {
  afterEach(() => {
    delete require.cache[HELPER_PATH];
  });

  it('always emails the vendor when board records a full payment', async () => {
    const { helper, calls } = loadHelperWithStubs({
      // Resolver already excluded actor board; vendor not in list (simulates exclusion)
      recipientIds: [BOARD_ID],
    });
    const result = await helper.sendVendorInvoicePaymentEmails({
      invoice: {
        _id: '6ac9f1c682c46ea973a77d9e',
        hoaId: 'dddddddddddddddddddddddd',
        vendorId: VENDOR_ID,
        title: 'Plumbing repair',
        invoiceNumber: 'VI-100',
        balanceDue: 0,
      },
      paymentAmount: 100,
      paymentMethod: 'Check',
      balanceAfter: 0,
      actorUserId: ACTOR_BOARD_ID,
    });

    assert.equal(result.vendorNotified, true);
    assert.ok(result.sent >= 1);
    const vendorMail = calls.send.find((p) => p.toEmail === 'pat@example.com');
    assert.ok(vendorMail, 'vendor should receive email');
    assert.match(vendorMail.options.subject, /Payment completed/i);
    assert.match(vendorMail.data.eventMessage, /Payment of \$100\.00 was completed/i);
    assert.match(vendorMail.data.eventMessage, /\/vendor\/payment-history\//);
    assert.equal(vendorMail.metadata.audience, 'vendor');
    assert.equal(vendorMail.metadata.isPaymentCompleted, true);
  });

  it('still emails the vendor when the vendor is the payment actor', async () => {
    const { helper, calls } = loadHelperWithStubs({
      // Resolver excluded vendor-as-actor from board/assignee list
      recipientIds: [BOARD_ID],
    });
    const result = await helper.sendVendorInvoicePaymentEmails({
      invoice: {
        _id: '6ac9f1c682c46ea973a77d9e',
        hoaId: 'dddddddddddddddddddddddd',
        vendorId: VENDOR_ID,
        title: 'Plumbing repair',
        invoiceNumber: 'VI-100',
        balanceDue: 0,
      },
      paymentAmount: 100,
      balanceAfter: 0,
      actorUserId: VENDOR_ID,
    });

    assert.equal(result.vendorNotified, true);
    const vendorMail = calls.send.find((p) => p.toEmail === 'pat@example.com');
    assert.ok(vendorMail, 'vendor payee must still be emailed when they record payment');
    assert.match(vendorMail.options.subject, /Payment completed/i);
  });

  it('emails vendor with partial-payment copy when balance remains', async () => {
    const { helper, calls } = loadHelperWithStubs({
      recipientIds: [BOARD_ID],
    });
    const result = await helper.sendVendorInvoicePaymentEmails({
      invoice: {
        _id: '6ac9f1c682c46ea973a77d9e',
        hoaId: 'dddddddddddddddddddddddd',
        vendorId: VENDOR_ID,
        title: 'Plumbing repair',
        invoiceNumber: 'VI-100',
        balanceDue: 60,
      },
      paymentAmount: 40,
      balanceAfter: 60,
      actorUserId: ACTOR_BOARD_ID,
    });

    assert.equal(result.vendorNotified, true);
    const vendorMail = calls.send.find((p) => p.toEmail === 'pat@example.com');
    assert.match(vendorMail.data.eventMessage, /partial payment of \$40\.00/i);
    assert.match(vendorMail.options.subject, /Partial payment recorded/i);
    assert.equal(vendorMail.metadata.isPaymentCompleted, false);
  });

  it('skips email when payment amount is zero or missing', async () => {
    const { helper, calls } = loadHelperWithStubs();
    const zero = await helper.sendVendorInvoicePaymentEmails({
      invoice: { _id: '6ac9f1c682c46ea973a77d9e', vendorId: VENDOR_ID, title: 'X' },
      paymentAmount: 0,
    });
    const missing = await helper.sendVendorInvoicePaymentEmails({
      invoice: { _id: '6ac9f1c682c46ea973a77d9e', vendorId: VENDOR_ID, title: 'X' },
      paymentAmount: null,
    });
    assert.equal(zero.attempted, 0);
    assert.equal(missing.attempted, 0);
    assert.equal(calls.send.length, 0);
  });

  it('force-includes vendor payee id even when resolver omitted them', async () => {
    const { helper } = loadHelperWithStubs({ recipientIds: [BOARD_ID] });
    const ids = await helper.resolvePaymentEmailRecipientIds(
      { vendorId: VENDOR_ID, assignedTo: BOARD_ID },
      ACTOR_BOARD_ID
    );
    assert.ok(ids.includes(VENDOR_ID));
    assert.ok(ids.includes(BOARD_ID));
  });
});
