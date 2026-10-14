/**
 * When a board expense is recorded with a Vendor payee (including vendors not yet
 * associated with the community), link the expense to the vendor user, associate
 * the HOA, create a VendorInvoice for portal visibility, and notify the vendor.
 */

const mongoose = require('mongoose');
const User = require('../../../../../shared/modules/users/models/user.model');
const VendorInvoice = require('../../vendor-invoice/model/vendorInvoice.model');
const { VENDOR_INVOICE_STATUS } = require('../../vendor-invoice/model/vendorInvoice.model');
const { ClockService } = require('../../../../../common/date');
const logger = require('../../../../../common/logger');
const {
  notifyVendorInvoiceCreatedInAppInBackground,
} = require('../../../../../common/helpers/hoaInAppNotify.helper');

const MODULE = 'expense-vendor-payee';

function toOid(id) {
  if (!id) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  if (mongoose.Types.ObjectId.isValid(String(id))) {
    return new mongoose.Types.ObjectId(String(id));
  }
  return null;
}

function isVendorPayeeType(payeeType) {
  const t = String(payeeType || '').trim().toLowerCase();
  return t === 'vendor';
}

/**
 * Extract vendor payee identity from request payees before Mongoose strips unknown fields.
 * @returns {{ payeeId: string, name: string, email: string } | null}
 */
function extractVendorPayeeFromPayload(payees = []) {
  if (!Array.isArray(payees)) return null;
  for (const payee of payees) {
    if (!payee || !isVendorPayeeType(payee.payeeType)) continue;
    const payeeId = String(payee.payeeId || '').trim();
    if (!payeeId || !mongoose.Types.ObjectId.isValid(payeeId)) continue;
    return {
      payeeId,
      name: String(payee.name || '').trim(),
      email: String(payee.email || '').trim(),
    };
  }
  return null;
}

/** Strip payeeId/payeeType so they are not silently dropped without schema support. */
function sanitizePayeesForPersist(payees = []) {
  if (!Array.isArray(payees)) return payees;
  return payees.map((p) => {
    if (!p || typeof p !== 'object') return p;
    return {
      name: p.name,
      contact: p.contact,
      phone: p.phone,
      email: p.email,
      website: p.website,
    };
  });
}

async function associateVendorWithHoa(vendorUserId, hoaId) {
  const vendorOid = toOid(vendorUserId);
  const hoaOid = toOid(hoaId);
  if (!vendorOid || !hoaOid) return;
  await User.updateOne(
    { _id: vendorOid, isDeleted: { $ne: true } },
    { $addToSet: { associatedHoaIds: hoaOid } }
  ).catch((err) => {
    logger.warn('associateVendorWithHoa failed', {
      module: MODULE,
      vendorUserId: String(vendorOid),
      hoaId: String(hoaOid),
      error: err?.message || err,
    });
  });
}

async function nextVendorInvoiceNumber(vendorId) {
  const count = await VendorInvoice.countDocuments({
    vendorId,
    isDeleted: { $ne: true },
  });
  const seq = String(count + 1).padStart(4, '0');
  const year = new Date().getFullYear();
  return `VI-${year}-${seq}`;
}

function buildLineItemsFromExpense(expense) {
  const items = Array.isArray(expense.expenseItems) ? expense.expenseItems : [];
  if (items.length === 0) {
    const amount = Math.max(0, Number(expense.total || 0));
    return [{
      description: String(expense.vendorPaidTo || 'Expense').slice(0, 500),
      quantity: 1,
      rate: amount,
      amount,
    }];
  }
  return items.map((item) => {
    const amount = Math.max(0, Number(item.amount || 0));
    return {
      description: String(item.description || item.category || 'Line item').slice(0, 500),
      quantity: 1,
      rate: amount,
      amount,
    };
  });
}

/**
 * Ensure a VendorInvoice exists for a board expense paid/recorded to a vendor payee.
 * Idempotent via expense.vendorInvoiceId and VendorInvoice.expenseId.
 */
async function ensureVendorInvoiceForExpense(expense, options = {}) {
  const expenseId = toOid(expense?._id || expense?.id);
  const vendorUserId = toOid(options.vendorUserId || expense?.vendorUserId);
  if (!expenseId || !vendorUserId) {
    return { created: false, invoice: null, skipped: true };
  }

  if (expense.vendorInvoiceId) {
    const existing = await VendorInvoice.findOne({
      _id: expense.vendorInvoiceId,
      isDeleted: { $ne: true },
    }).lean();
    if (existing) {
      return { created: false, invoice: existing };
    }
  }

  const linked = await VendorInvoice.findOne({
    expenseId,
    isDeleted: { $ne: true },
  }).lean();
  if (linked) {
    if (!expense.vendorInvoiceId) {
      await require('../model/expense.model').updateOne(
        { _id: expenseId },
        { $set: { vendorInvoiceId: linked._id, vendorUserId } }
      ).catch(() => {});
    }
    return { created: false, invoice: linked };
  }

  const actorOid = toOid(options.actorId);
  const hoaOid = toOid(options.hoaId || expense.hoaId);
  const assignedTo = actorOid || toOid(expense.hoaBoardMemberId) || toOid(expense.createdBy);
  if (!assignedTo) {
    logger.warn('ensureVendorInvoiceForExpense: no assignee', {
      module: MODULE,
      expenseId: String(expenseId),
    });
    return { created: false, invoice: null, skipped: true };
  }

  await associateVendorWithHoa(vendorUserId, hoaOid);

  const lineItems = buildLineItemsFromExpense(expense);
  const subAmount = lineItems.reduce((sum, li) => sum + Number(li.amount || 0), 0);
  const isPaid = String(expense.status || '').toLowerCase() === 'paid';
  const amountPaid = isPaid ? subAmount : 0;
  const balanceDue = Math.max(0, subAmount - amountPaid);
  const status = isPaid ? VENDOR_INVOICE_STATUS.PAID : VENDOR_INVOICE_STATUS.PENDING;
  const now = ClockService.now();
  const invoiceNumber = await nextVendorInvoiceNumber(vendorUserId);
  const title = String(
    expense.vendorPaidTo
    || lineItems[0]?.description
    || `Expense ${expense.expenseId || expenseId}`
  ).slice(0, 200);

  const doc = await VendorInvoice.create({
    invoiceNumber,
    vendorId: vendorUserId,
    assignedTo,
    hoaId: hoaOid || undefined,
    title,
    description: '',
    lineItems,
    subAmount,
    amountPaid,
    balanceDue,
    status,
    dueDate: expense.dueDate ? new Date(expense.dueDate) : undefined,
    paidAt: isPaid ? (expense.paymentDate ? new Date(expense.paymentDate) : now) : undefined,
    notes: '',
    expenseId,
    createdBy: actorOid || assignedTo,
    activityTimeline: [
      {
        kind: 'created',
        at: now,
        isSystemGenerated: true,
        createdBy: 'System',
      },
      ...(isPaid
        ? [{
            kind: 'payment',
            at: now,
            amount: amountPaid,
            method: expense.bankAccount || 'Manual',
            balanceAfter: 0,
            recordedBy: 'System',
            paidBy: 'System',
            paidOn: now.toISOString().slice(0, 10),
          }]
        : []),
    ],
  });

  const Expense = require('../model/expense.model');
  await Expense.updateOne(
    { _id: expenseId },
    { $set: { vendorInvoiceId: doc._id, vendorUserId } }
  );

  const invoiceObj = doc.toObject ? doc.toObject() : doc;

  // Attach invoice PDF onto the expense so HOA Download works both directions.
  try {
    const {
      attachVendorInvoicePdfToExpense,
    } = require('../../vendor-invoice/helpers/vendorInvoiceExpense.helper');
    const ExpenseModel = require('../model/expense.model');
    const expenseDoc = await ExpenseModel.findOne({
      _id: expenseId,
      isDeleted: { $ne: true },
    }).lean();
    if (expenseDoc) {
      await attachVendorInvoicePdfToExpense(expenseDoc, invoiceObj, options.actorId || null);
    }
  } catch (attachErr) {
    logger.warn('Failed to attach vendor invoice PDF after expense→invoice create', {
      module: MODULE,
      expenseId: String(expenseId),
      error: attachErr?.message || attachErr,
    });
  }

  notifyVendorInvoiceCreatedInAppInBackground(invoiceObj, options.actorId || null, hoaOid);
  try {
    const {
      notifyVendorInvoiceCreatedEmailInBackground,
    } = require('../../vendor-invoice/helpers/vendorInvoiceCreatedEmail.helper');
    notifyVendorInvoiceCreatedEmailInBackground(invoiceObj, options.actorId || null);
  } catch {
    // Email helper is best-effort; in-app already queued above.
  }

  logger.info('Vendor invoice created from expense payee', {
    module: MODULE,
    expenseId: String(expenseId),
    vendorInvoiceId: String(doc._id),
    vendorUserId: String(vendorUserId),
  });

  return { created: true, invoice: invoiceObj };
}

/**
 * Apply vendor payee linkage after expense create/update.
 */
async function linkVendorPayeeAfterExpenseSave(expense, vendorPayee, options = {}) {
  if (!expense || !vendorPayee?.payeeId) return null;

  const vendorOid = toOid(vendorPayee.payeeId);
  if (!vendorOid) return null;

  const Expense = require('../model/expense.model');
  const expenseId = toOid(expense._id);
  if (expenseId && !expense.vendorUserId) {
    await Expense.updateOne(
      { _id: expenseId },
      { $set: { vendorUserId: vendorOid } }
    ).catch(() => {});
    expense.vendorUserId = vendorOid;
  }

  const hoaId = options.hoaId || expense.hoaId;
  await associateVendorWithHoa(vendorOid, hoaId);

  try {
    return await ensureVendorInvoiceForExpense(expense, {
      vendorUserId: vendorOid,
      actorId: options.actorId,
      hoaId,
    });
  } catch (err) {
    logger.error('linkVendorPayeeAfterExpenseSave failed', {
      module: MODULE,
      expenseId: String(expenseId || ''),
      error: err?.message || err,
    });
    return null;
  }
}

module.exports = {
  extractVendorPayeeFromPayload,
  sanitizePayeesForPersist,
  associateVendorWithHoa,
  ensureVendorInvoiceForExpense,
  linkVendorPayeeAfterExpenseSave,
  isVendorPayeeType,
};
