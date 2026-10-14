const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const HOA_ID = '507f1f77bcf86cd799439099';
const PROPERTY_ID = '507f1f77bcf86cd799439088';
const helperPath = require.resolve('./invoiceNotificationEmailHelper');
const HOA = require('../../portals/hoa-board/modules/hoa/model/hoa.model');
const Property = require('../../portals/hoa-board/modules/property/model/property.model');

function loadHelper() {
  delete require.cache[helperPath];
  return require('./invoiceNotificationEmailHelper');
}

function makeLeanQuery(result) {
  return {
    select: () => ({
      lean: async () => result,
    }),
  };
}

describe('invoiceNotificationEmailHelper branding', () => {
  let originalHoaFindById;
  let originalPropertyFindById;

  beforeEach(() => {
    originalHoaFindById = HOA.findById;
    originalPropertyFindById = Property.findById;
    delete require.cache[helperPath];
  });

  afterEach(() => {
    HOA.findById = originalHoaFindById;
    Property.findById = originalPropertyFindById;
    delete require.cache[helperPath];
  });

  it('buildInvoiceEmailSubject uses community name instead of PropMv', () => {
    const { buildInvoiceEmailSubject } = loadHelper();
    const subject = buildInvoiceEmailSubject('New invoice #INV597909', {
      communityName: 'Sunset Valley HOA',
      organizationDisplayName: 'Sunset Valley HOA',
    });
    assert.equal(subject, 'New invoice #INV597909 - Sunset Valley HOA');
    assert.equal(subject.includes('PropMv'), false);
  });

  it('resolvePaymentNotificationPayload returns null when invoice has prior payments but no new payment', () => {
    const { resolvePaymentNotificationPayload } = loadHelper();
    const payload = resolvePaymentNotificationPayload({
      invoice: {
        _id: '507f1f77bcf86cd799439077',
        balanceDue: 100,
        paymentTransactions: [
          {
            amount: 50,
            method: 'Check',
            paidAt: new Date('2026-09-15T12:00:00.000Z'),
            recordedAt: new Date('2026-09-15T12:00:00.000Z'),
          },
        ],
      },
      paymentDelta: null,
      paymentPrep: null,
    });

    assert.equal(payload, null);
  });

  it('resolvePaymentNotificationPayload returns payload only for a payment recorded in this mutation', () => {
    const { resolvePaymentNotificationPayload } = loadHelper();
    const invoice = {
      _id: '507f1f77bcf86cd799439077',
      balanceDue: 50,
      paymentTransactions: [
        {
          amount: 50,
          method: 'Check',
          paidAt: new Date('2026-09-15T12:00:00.000Z'),
        },
      ],
    };

    const payload = resolvePaymentNotificationPayload({
      invoice,
      paymentDelta: {
        amount: 25,
        method: 'Cash',
        balanceAfter: 25,
        paidAt: new Date('2026-10-01T12:00:00.000Z'),
        recordedAt: new Date('2026-10-01T12:00:00.000Z'),
      },
    });

    assert.equal(payload?.paymentAmount, 25);
    assert.equal(payload?.paymentMethod, 'Cash');
  });

  it('resolveInvoiceEmailBranding backfills hoaId from property when invoice lacks it', async () => {
    HOA.findById = mock.fn(() => makeLeanQuery({ name: 'Sunset Valley HOA' }));
    Property.findById = mock.fn(() => makeLeanQuery({ hoaId: HOA_ID }));

    const { resolveInvoiceEmailBranding } = loadHelper();
    const branding = await resolveInvoiceEmailBranding({
      propertyId: PROPERTY_ID,
    });

    assert.equal(branding.hoaId, HOA_ID);
    assert.equal(branding.communityName, 'Sunset Valley HOA');
    assert.equal(branding.organizationDisplayName, 'Sunset Valley HOA');
    assert.equal(Property.findById.mock.calls.length, 1);
    assert.equal(HOA.findById.mock.calls.length, 1);
  });
});
