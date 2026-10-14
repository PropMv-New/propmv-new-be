'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

const HELPER_PATH = require.resolve('./vendorInvoiceCreatedEmail.helper');

const VENDOR_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const BOARD_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const OWNER_ASSIGNEE_ID = 'dddddddddddddddddddddddd';

function endsWithPath(request, ...segments) {
  const normalized = String(request).replace(/\\/g, '/');
  return segments.some((segment) => normalized.endsWith(segment));
}

function loadHelperWithStubs({
  recipientIds = [BOARD_ID],
  users = [
    { _id: BOARD_ID, firstName: 'Bo', lastName: 'Board', email: 'board@example.com' },
    { _id: OWNER_ASSIGNEE_ID, firstName: 'Ow', lastName: 'Owner', email: 'owner@example.com' },
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
    const helper = require('./vendorInvoiceCreatedEmail.helper');
    return { helper, calls };
  } finally {
    Module._load = originalLoad;
  }
}

describe('vendorInvoiceCreatedEmail.helper', () => {
  afterEach(() => {
    delete require.cache[HELPER_PATH];
  });

  it('emails board and assigned owner when vendor creates an invoice', async () => {
    const { helper, calls } = loadHelperWithStubs({
      // Resolver returned board only; assignee must still be forced in
      recipientIds: [BOARD_ID],
    });

    const result = await helper.sendVendorInvoiceCreatedEmails({
      invoice: {
        _id: 'eeeeeeeeeeeeeeeeeeeeeeee',
        invoiceNumber: 'VIN-100',
        title: 'Plumbing work',
        subAmount: 250,
        hoaId: 'ffffffffffffffffffffffff',
        assignedTo: OWNER_ASSIGNEE_ID,
        vendorId: VENDOR_ID,
      },
      actorUserId: VENDOR_ID,
    });

    assert.equal(result.attempted, 2);
    assert.equal(result.sent, 2);
    const emails = calls.send.map((c) => c.toEmail).sort();
    assert.deepEqual(emails, ['board@example.com', 'owner@example.com']);
    const ownerMail = calls.send.find((c) => c.toEmail === 'owner@example.com');
    assert.match(ownerMail.data.eventMessage, /assigned to you/i);
    assert.match(ownerMail.options.subject, /Vendor invoice assigned/i);
  });

  it('excludes the creating vendor from created emails', async () => {
    const { helper, calls } = loadHelperWithStubs({
      recipientIds: [BOARD_ID, VENDOR_ID],
      users: [
        { _id: BOARD_ID, firstName: 'Bo', lastName: 'Board', email: 'board@example.com' },
        { _id: VENDOR_ID, firstName: 'Pat', lastName: 'Vendor', email: 'pat@example.com' },
      ],
    });

    await helper.sendVendorInvoiceCreatedEmails({
      invoice: {
        _id: 'eeeeeeeeeeeeeeeeeeeeeeee',
        invoiceNumber: 'VIN-101',
        title: 'Gate repair',
        subAmount: 80,
        assignedTo: BOARD_ID,
        vendorId: VENDOR_ID,
      },
      actorUserId: VENDOR_ID,
    });

    assert.ok(!calls.send.some((c) => c.toEmail === 'pat@example.com'));
    assert.ok(calls.send.some((c) => c.toEmail === 'board@example.com'));
  });

  it('returns zeros when invoice is missing', async () => {
    const { helper } = loadHelperWithStubs();
    const result = await helper.sendVendorInvoiceCreatedEmails({});
    assert.deepEqual(result, { attempted: 0, sent: 0, failed: 0 });
  });
});
