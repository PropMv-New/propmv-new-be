'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Property = require('../../../../../../portals/hoa-board/modules/property/model/property.model');
const Invoice = require('../../../../../../portals/hoa-board/modules/invoice/model/invoice.model');
const {
  normalizeInvoiceTenantUserId,
  collectInvoiceTenantUserIds,
  invoiceHasOwnerAsTenant,
  buildOwnerAutopayInvoiceMongoFilter,
  isOwnerChargeableForAutopayInvoice,
} = require('./payloadAutopayInvoiceScope.util');
const { isInvoiceEligibleForAutopaySync } = require('./payloadInvoiceSync.util');
const { calculatePayloadProcessingFee } = require('./payloadPayinFee.util');

const OWNER_A = '6aaa68fb874dd413269e5088';
const OWNER_B = '6aaa3d9cc282fe37e2549b5b';
const HOA_ID = '6aaa3daec282fe37e2549bcf';
const PROPERTY_ID = '6aaa6903874dd413269e50b1';
const INV563768_ID = '6aaa6955874dd413269e518c';
const PROPERTY_OID = new mongoose.Types.ObjectId(PROPERTY_ID);

describe('payloadAutopayInvoiceScope.util', () => {
  let originalPropertyFind;
  let originalInvoiceDistinct;

  beforeEach(() => {
    originalPropertyFind = Property.find;
    originalInvoiceDistinct = Invoice.distinct;
  });

  afterEach(() => {
    Property.find = originalPropertyFind;
    Invoice.distinct = originalInvoiceDistinct;
  });

  describe('normalizeInvoiceTenantUserId', () => {
    it('normalizes HOA schema ObjectId tenants without using ObjectId._id quirk as primary path', () => {
      const oid = new mongoose.Types.ObjectId(OWNER_A);
      assert.equal(normalizeInvoiceTenantUserId(oid), OWNER_A);
      assert.equal(normalizeInvoiceTenantUserId(OWNER_A), OWNER_A);
    });

    it('normalizes populated user docs and optional userId shape', () => {
      assert.equal(
        normalizeInvoiceTenantUserId({ _id: OWNER_A, firstName: 'Diwakar', lastName: 'Pra' }),
        OWNER_A,
      );
      assert.equal(
        normalizeInvoiceTenantUserId({ userId: OWNER_A }),
        OWNER_A,
      );
      assert.equal(normalizeInvoiceTenantUserId(null), '');
      assert.equal(normalizeInvoiceTenantUserId({}), '');
    });
  });

  describe('buildOwnerAutopayInvoiceMongoFilter', () => {
    it('requires property universe + hoaId + tenants: ownerOid (never property-only)', async () => {
      Property.find = function mockFind() {
        return {
          select() { return this; },
          lean() { return Promise.resolve([{ _id: PROPERTY_OID }]); },
        };
      };
      Invoice.distinct = async () => [];

      const filter = await buildOwnerAutopayInvoiceMongoFilter({
        userId: OWNER_A,
        hoaId: HOA_ID,
        extra: { balanceDue: { $gt: 0 } },
      });

      assert.ok(filter);
      assert.equal(String(filter.hoaId), HOA_ID);
      assert.equal(String(filter.propertyId), PROPERTY_ID);
      assert.equal(String(filter.tenants), OWNER_A);
      assert.deepEqual(filter.balanceDue, { $gt: 0 });
      assert.deepEqual(filter.isDeleted, { $ne: true });
      assert.equal(Object.prototype.hasOwnProperty.call(filter, 'tenants'), true);
    });

    it('returns null when owner has no property universe', async () => {
      Property.find = function mockFind() {
        return {
          select() { return this; },
          lean() { return Promise.resolve([]); },
        };
      };
      Invoice.distinct = async () => [];

      const filter = await buildOwnerAutopayInvoiceMongoFilter({
        userId: OWNER_A,
        hoaId: HOA_ID,
      });
      assert.equal(filter, null);
    });

    it('forces tenants gate even if extra tries to remove it', async () => {
      Property.find = function mockFind() {
        return {
          select() { return this; },
          lean() { return Promise.resolve([{ _id: PROPERTY_OID }]); },
        };
      };
      Invoice.distinct = async () => [];

      const filter = await buildOwnerAutopayInvoiceMongoFilter({
        userId: OWNER_A,
        hoaId: HOA_ID,
        extra: { tenants: undefined, propertyId: { $in: [] } },
      });
      assert.equal(String(filter.tenants), OWNER_A);
      assert.equal(String(filter.propertyId), PROPERTY_ID);
    });
  });

  describe('INV563768 nextAutopay selection + isolation', () => {
    const inv563768 = {
      _id: new mongoose.Types.ObjectId(INV563768_ID),
      invoiceId: 'INV563768',
      hoaId: new mongoose.Types.ObjectId(HOA_ID),
      propertyId: new mongoose.Types.ObjectId(PROPERTY_ID),
      balanceDue: 100,
      dueDate: new Date('2027-08-02T12:00:00.000Z'),
      status: 'Pending',
      isDeleted: false,
      tenants: [new mongoose.Types.ObjectId(OWNER_A)],
    };

    beforeEach(() => {
      Property.find = function mockFind(query) {
        const associated = query?.associatedOwnerIds;
        const matchOwner = associated && String(associated) === OWNER_A;
        return {
          select() { return this; },
          lean() {
            return Promise.resolve(matchOwner ? [{ _id: PROPERTY_OID }] : []);
          },
        };
      };
      Invoice.distinct = async (_field, filter) => {
        if (filter?.tenants && String(filter.tenants) === OWNER_A) {
          return [PROPERTY_OID];
        }
        return [];
      };
    });

    it('1) Owner A selects INV563768 as eligible next Autopay candidate', async () => {
      assert.equal(invoiceHasOwnerAsTenant(inv563768, OWNER_A), true);
      assert.equal(isInvoiceEligibleForAutopaySync(inv563768), true);

      const chargeable = await isOwnerChargeableForAutopayInvoice({
        userId: OWNER_A,
        hoaId: HOA_ID,
        invoice: inv563768,
      });
      assert.equal(chargeable, true);

      const filter = await buildOwnerAutopayInvoiceMongoFilter({
        userId: OWNER_A,
        hoaId: HOA_ID,
        extra: { balanceDue: { $gt: 0 }, dueDate: { $exists: true, $ne: null } },
      });
      assert.ok(filter);
      assert.equal(String(filter.tenants), OWNER_A);
      assert.equal(String(filter.hoaId), HOA_ID);
    });

    it('2) Owner B on same HOA but absent from tenants[] cannot select INV563768', async () => {
      assert.equal(invoiceHasOwnerAsTenant(inv563768, OWNER_B), false);

      const chargeable = await isOwnerChargeableForAutopayInvoice({
        userId: OWNER_B,
        hoaId: HOA_ID,
        invoice: inv563768,
      });
      assert.equal(chargeable, false);

      const withSharedScope = {
        ...inv563768,
      };
      assert.equal(invoiceHasOwnerAsTenant(withSharedScope, OWNER_B), false);
    });

    it('3) Co-owner present in tenants[] remains chargeable (shared-payer behavior)', async () => {
      const shared = {
        ...inv563768,
        tenants: [
          new mongoose.Types.ObjectId(OWNER_A),
          new mongoose.Types.ObjectId(OWNER_B),
        ],
      };
      assert.equal(invoiceHasOwnerAsTenant(shared, OWNER_A), true);
      assert.equal(invoiceHasOwnerAsTenant(shared, OWNER_B), true);

      Property.find = function mockFind(query) {
        const associated = String(query?.associatedOwnerIds || '');
        const ok = associated === OWNER_A || associated === OWNER_B;
        return {
          select() { return this; },
          lean() {
            return Promise.resolve(ok ? [{ _id: PROPERTY_OID }] : []);
          },
        };
      };
      Invoice.distinct = async () => [];

      assert.equal(
        await isOwnerChargeableForAutopayInvoice({ userId: OWNER_A, hoaId: HOA_ID, invoice: shared }),
        true,
      );
      assert.equal(
        await isOwnerChargeableForAutopayInvoice({ userId: OWNER_B, hoaId: HOA_ID, invoice: shared }),
        true,
      );
    });

    it('4) Property scope alone cannot make an invoice Autopay-eligible', async () => {
      Property.find = function mockFind(query) {
        const associated = String(query?.associatedOwnerIds || '');
        const ok = associated === OWNER_A || associated === OWNER_B;
        return {
          select() { return this; },
          lean() {
            return Promise.resolve(ok ? [{ _id: PROPERTY_OID }] : []);
          },
        };
      };
      Invoice.distinct = async () => [];

      const filterB = await buildOwnerAutopayInvoiceMongoFilter({
        userId: OWNER_B,
        hoaId: HOA_ID,
      });
      assert.ok(filterB);
      assert.equal(String(filterB.tenants), OWNER_B);
      assert.equal(invoiceHasOwnerAsTenant(inv563768, OWNER_B), false);
      assert.equal(
        await isOwnerChargeableForAutopayInvoice({
          userId: OWNER_B,
          hoaId: HOA_ID,
          invoice: inv563768,
        }),
        false,
      );
    });

    it('5) balance/eligibility changes still exclude paid/zero invoices from Autopay', () => {
      assert.equal(
        isInvoiceEligibleForAutopaySync({ ...inv563768, balanceDue: 0, status: 'Paid' }),
        false,
      );
      assert.equal(
        isInvoiceEligibleForAutopaySync({ ...inv563768, balanceDue: 40, status: 'Partially Paid' }),
        true,
      );
      assert.equal(
        isInvoiceEligibleForAutopaySync({ ...inv563768, status: 'Waived', balanceDue: 100 }),
        false,
      );
      assert.equal(
        isInvoiceEligibleForAutopaySync({ ...inv563768, status: 'Cancelled', balanceDue: 100 }),
        false,
      );
    });

    it('6) Card and ACH next-charge fee path remains method-type driven from balanceDue', () => {
      const billingSettings = {
        transactionFees: {
          card: { percent: 2.9, fixed: 0.3, paidBy: 'payer' },
          bankTransfer: { percent: 0, fixed: 0, paidBy: 'payer' },
        },
      };
      const card = calculatePayloadProcessingFee({
        invoicePaymentAmount: 100,
        methodType: 'CARD',
        billingSettings,
        applyFee: true,
      });
      const ach = calculatePayloadProcessingFee({
        invoicePaymentAmount: 100,
        methodType: 'ACH',
        billingSettings,
        applyFee: true,
      });
      assert.equal(card.invoicePaymentAmount, 100);
      assert.equal(ach.invoicePaymentAmount, 100);
      assert.ok(card.chargeAmount >= 100);
      assert.equal(ach.chargeAmount, 100);
      assert.equal(typeof card.processingFeeAmount, 'number');
      assert.equal(typeof ach.processingFeeAmount, 'number');
    });
  });

  describe('collectInvoiceTenantUserIds', () => {
    it('collects mixed ObjectId and populated shapes', () => {
      const ids = collectInvoiceTenantUserIds([
        new mongoose.Types.ObjectId(OWNER_A),
        { _id: OWNER_B, firstName: 'Other' },
      ]);
      assert.equal(ids.has(OWNER_A), true);
      assert.equal(ids.has(OWNER_B), true);
      assert.equal(ids.size, 2);
    });
  });
});
