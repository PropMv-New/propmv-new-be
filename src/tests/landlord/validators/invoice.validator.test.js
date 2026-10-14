const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  createInvoiceSchema,
  updateInvoiceSchema,
  idParamSchema,
  listQuerySchema,
  addCommentSchema,
  exportQuerySchema,
} = require('../../../portals/landlord/modules/invoice/validators/invoice.validator');
const { INVOICE_TYPES } = require('../../../common/constants/invoice');
const { CREATED_BY, OBJECT_ID, PROPERTY_ID, TENANT_ID } = require('../helpers/fixtures');

const baseInvoiceItem = {
  invoiceItem: 'Rent',
  quantity: 1,
  rate: 1000,
  amount: 1000,
};

const validOneTimeInvoice = {
  type: INVOICE_TYPES.RENT,
  isPartialPaymentAllowed: false,
  propertyId: PROPERTY_ID,
  unit: 'A',
  term: 'June 2026',
  tenants: [TENANT_ID],
  isAllTenantSelected: true,
  invoiceItemDetails: [baseInvoiceItem],
  subAmount: 1000,
  alreadyPaid: 0,
  balanceDue: 1000,
  isRecurringInvoice: false,
  dueDate: '2026-06-01',
};

describe('invoice validators', () => {
  describe('createInvoiceSchema', () => {
    test('accepts valid one-time invoice', () => {
      const { error, value } = createInvoiceSchema.validate(validOneTimeInvoice);
      assert.equal(error, undefined);
      assert.equal(value.subAmount, 1000);
    });

    test('rejects isLineItemOnRentalInvoice when not recurring', () => {
      const { error } = createInvoiceSchema.validate({
        ...validOneTimeInvoice,
        isLineItemOnRentalInvoice: true,
      });
      assert.ok(error);
    });

    test('rejects recurring invoice without frequency when not line item', () => {
      const { error } = createInvoiceSchema.validate({
        ...validOneTimeInvoice,
        isRecurringInvoice: true,
        startDate: '2026-06-01',
        endDate: '2027-05-31',
        isLineItemOnRentalInvoice: false,
      });
      assert.ok(error);
    });

    test('accepts recurring line-item-on-rental without frequency', () => {
      const { error } = createInvoiceSchema.validate({
        ...validOneTimeInvoice,
        isRecurringInvoice: true,
        isLineItemOnRentalInvoice: true,
        startDate: '2026-06-01',
        endDate: '2027-05-31',
      });
      assert.equal(error, undefined);
    });
  });

  describe('updateInvoiceSchema', () => {
    test('accepts partial payment update', () => {
      const { error } = updateInvoiceSchema.validate({
        paymentAmount: 500,
        balanceDue: 500,
      });
      assert.equal(error, undefined);
    });
  });

  describe('idParamSchema', () => {
    test('requires valid object id', () => {
      const { error } = idParamSchema.validate({ id: OBJECT_ID });
      assert.equal(error, undefined);
    });
  });

  describe('listQuerySchema', () => {
    test('accepts landlord list filters', () => {
      const { error, value } = listQuerySchema.validate({
        createdBy: CREATED_BY,
        pageNumber: 1,
        pageSize: 25,
        status: 'Overdue',
        propertyId: PROPERTY_ID,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      });
      assert.equal(error, undefined);
      assert.equal(value.createdBy, CREATED_BY);
    });
  });

  describe('addCommentSchema', () => {
    test('requires comment text', () => {
      const { error } = addCommentSchema.validate({ text: 'Payment received' });
      assert.equal(error, undefined);
      const missing = addCommentSchema.validate({});
      assert.ok(missing.error);
    });
  });

  describe('exportQuerySchema', () => {
    test('accepts export format', () => {
      const { error } = exportQuerySchema.validate({
        createdBy: CREATED_BY,
        format: 'xlsx',
      });
      assert.equal(error, undefined);
    });
  });
});
