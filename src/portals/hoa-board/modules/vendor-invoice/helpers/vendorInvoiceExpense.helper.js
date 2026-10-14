/**
 * Create (or return existing) HoaExpense when a Vendor Invoice first becomes Paid.
 * Idempotent via unique `vendorInvoiceId` on HoaExpense.
 * Also attaches a downloadable PDF of the vendor invoice onto the expense.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const Expense = require('../../expense/model/expense.model');
const VendorInvoice = require('../model/vendorInvoice.model');
const User = require('../../../../../shared/modules/users/models/user.model');
const MaintenanceRequest = require('../../../../../shared/modules/maintenance/model/maintenanceRequest.model');
const DocumentManager = require('../../../../../shared/modules/documents/service/documentManager');
const { allocateUniqueExpenseId } = require('../../expense/helpers/expenseId.helper');
const { EXPENSE_STATUS } = require('../../../../../common/constants/expense');
const { ClockService } = require('../../../../../common/date');
const logger = require('../../../../../common/logger');
const { notifyExpenseCreatedInAppInBackground } = require('../../../../../common/helpers/hoaInAppNotify.helper');
const {
  buildVendorInvoicePdfBuffer,
  vendorInvoiceAttachmentFileName,
} = require('./vendorInvoicePdf.helper');

const MODULE = 'vendor-invoice-expense';
const EXPENSE_CATEGORY = 'Vendor Invoice';
const docManager = new DocumentManager();

function toOid(id) {
  if (!id) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  if (mongoose.Types.ObjectId.isValid(String(id))) {
    return new mongoose.Types.ObjectId(String(id));
  }
  return null;
}

function displayNameFromUser(user) {
  if (!user) return 'Vendor';
  const name = `${user.firstName || ''} ${user.lastName || ''}`.trim();
  return name || String(user.email || '').trim() || 'Vendor';
}

async function resolvePropertyContext(invoice) {
  const empty = {
    propertyId: null,
    propertyName: '',
    unitId: null,
    unitName: '',
    bankAccount: '',
    hoaId: toOid(invoice?.hoaId),
  };
  if (!invoice?.maintenanceRequestId) return empty;

  try {
    const Property = require('../../property/model/property.model');
    const ticket = await MaintenanceRequest.findOne({
      _id: invoice.maintenanceRequestId,
      isDeleted: { $ne: true },
    })
      .select('property_id unitId units hoaId')
      .lean();
    if (!ticket?.property_id) {
      return { ...empty, hoaId: toOid(invoice?.hoaId || ticket?.hoaId) };
    }

    const prop = await Property.findOne({
      _id: ticket.property_id,
      isDeleted: { $ne: true },
    })
      .select('name hoaId depositBankAccountId depositBankAccountName unitDetails')
      .lean();
    if (!prop) {
      return { ...empty, hoaId: toOid(invoice?.hoaId || ticket?.hoaId) };
    }

    const unitName =
      ticket.units ||
      (ticket.unitId &&
        prop.unitDetails?.find((u) => String(u._id) === String(ticket.unitId))?.unitName) ||
      '';

    const bankFromProperty =
      (prop.depositBankAccountName && String(prop.depositBankAccountName).trim()) ||
      (prop.depositBankAccountId && String(prop.depositBankAccountId)) ||
      '';

    return {
      propertyId: prop._id,
      propertyName: String(prop.name || '').trim(),
      unitId: ticket.unitId || null,
      unitName: String(unitName || '').trim(),
      bankAccount: bankFromProperty,
      hoaId: toOid(invoice?.hoaId || ticket?.hoaId || prop.hoaId),
    };
  } catch (err) {
    logger.warn('resolvePropertyContext failed', { module: MODULE, error: err?.message || err });
    return empty;
  }
}

async function resolveTaxableEntity(hoaId, propertyName) {
  if (propertyName) return String(propertyName).slice(0, 200);
  if (!hoaId) return 'HOA Community';
  try {
    const HOA = require('../../hoa/model/hoa.model');
    const hoa = await HOA.findOne({ _id: hoaId, isDeleted: { $ne: true } })
      .select('name')
      .lean();
    return String(hoa?.name || 'HOA Community').slice(0, 200);
  } catch {
    return 'HOA Community';
  }
}

function buildExpenseItems(invoice, paymentDate) {
  const lines = Array.isArray(invoice.lineItems) ? invoice.lineItems : [];
  if (lines.length === 0) {
    return [
      {
        date: paymentDate,
        category: EXPENSE_CATEGORY,
        description: String(invoice.title || invoice.invoiceNumber || 'Vendor invoice').slice(0, 500),
        amount: Math.max(0, Number(invoice.subAmount || invoice.amountPaid || 0)),
      },
    ];
  }
  return lines.map((item) => ({
    date: paymentDate,
    category: EXPENSE_CATEGORY,
    description: String(item.description || invoice.title || 'Line item').slice(0, 500),
    amount: Math.max(0, Number(item.amount || 0)),
  }));
}

function expenseHasInvoiceAttachment(expense) {
  const items = Array.isArray(expense?.expenseItems) ? expense.expenseItems : [];
  return items.some((item) => Boolean(item?.fileDocument?.metadataId));
}

/**
 * Upload a vendor-invoice PDF and attach it to the first expense line item.
 * Best-effort: failures are logged and do not undo Paid / expense creation.
 */
async function attachVendorInvoicePdfToExpense(expense, invoice, actorId = null) {
  if (!expense?._id || !invoice) return expense;
  if (expenseHasInvoiceAttachment(expense)) return expense;

  const pdfBuffer = buildVendorInvoicePdfBuffer(invoice);
  const originalName = vendorInvoiceAttachmentFileName(invoice);
  const tmpPath = path.join(
    os.tmpdir(),
    `vendor-invoice-${String(expense._id)}-${Date.now()}.pdf`
  );

  try {
    await fs.promises.writeFile(tmpPath, pdfBuffer);
    const createdMetas = await docManager.uploadAndCreateMetadata(
      [{
        path: tmpPath,
        originalname: originalName,
        mimetype: 'application/pdf',
        size: pdfBuffer.length,
      }],
      {
        documentType: 'expense-receipts',
        userId: actorId || null,
      }
    );
    const meta = createdMetas?.[0];
    if (!meta?._id) {
      logger.warn('attachVendorInvoicePdfToExpense: upload returned no metadata', {
        module: MODULE,
        expenseId: String(expense._id),
      });
      return expense;
    }

    const fileDocument = {
      metadataId: meta._id,
      originalName: meta.originalName || originalName,
      uploadedAt: ClockService.now(),
    };

    const updated = await Expense.findOneAndUpdate(
      {
        _id: expense._id,
        isDeleted: { $ne: true },
        'expenseItems.0': { $exists: true },
        $or: [
          { 'expenseItems.0.fileDocument': { $exists: false } },
          { 'expenseItems.0.fileDocument.metadataId': { $exists: false } },
          { 'expenseItems.0.fileDocument.metadataId': null },
        ],
      },
      { $set: { 'expenseItems.0.fileDocument': fileDocument } },
      { new: true }
    ).lean();

    if (updated) {
      logger.info('Attached vendor invoice PDF to expense', {
        module: MODULE,
        expenseId: String(expense._id),
        vendorInvoiceId: String(invoice._id || invoice.id || ''),
        metadataId: String(meta._id),
      });
      return updated;
    }
    return expense;
  } catch (err) {
    logger.error('attachVendorInvoicePdfToExpense failed', {
      module: MODULE,
      expenseId: String(expense._id),
      vendorInvoiceId: String(invoice._id || invoice.id || ''),
      error: err?.message || err,
    });
    return expense;
  } finally {
    try {
      if (fs.existsSync(tmpPath)) await fs.promises.unlink(tmpPath);
    } catch {
      // ignore temp cleanup errors
    }
  }
}

async function ensureInvoiceAttachedToExpense(expense, invoice, actorId = null) {
  if (!expense) return expense;
  if (expenseHasInvoiceAttachment(expense)) return expense;
  return attachVendorInvoicePdfToExpense(expense, invoice, actorId);
}

/**
 * @param {object} invoice - VendorInvoice doc (lean or mongoose)
 * @param {object} options
 * @param {string|null} options.actorId
 * @param {object|null} options.hoaContext
 * @param {object} [options.paymentMeta] - optional { paymentMethod, paymentDate, bankAccount }
 * @returns {Promise<{ created: boolean, expense: object|null, skipped?: boolean }>}
 */
async function ensureExpenseForPaidVendorInvoice(invoice, options = {}) {
  const invoiceId = toOid(invoice?._id || invoice?.id);
  if (!invoiceId) {
    return { created: false, expense: null, skipped: true };
  }

  // Already linked on the invoice
  if (invoice.expenseId) {
    const existingByLink = await Expense.findOne({
      _id: invoice.expenseId,
      isDeleted: { $ne: true },
    }).lean();
    if (existingByLink) {
      const withAttachment = await ensureInvoiceAttachedToExpense(
        existingByLink,
        invoice,
        options.actorId
      );
      return { created: false, expense: withAttachment };
    }
  }

  // Idempotent lookup by vendorInvoiceId
  const existing = await Expense.findOne({
    vendorInvoiceId: invoiceId,
    isDeleted: { $ne: true },
  }).lean();
  if (existing) {
    if (!invoice.expenseId) {
      await VendorInvoice.updateOne(
        { _id: invoiceId },
        { $set: { expenseId: existing._id } }
      ).catch(() => {});
    }
    const withAttachment = await ensureInvoiceAttachedToExpense(
      existing,
      invoice,
      options.actorId
    );
    return { created: false, expense: withAttachment };
  }

  const actorOid = toOid(options.actorId);
  const paymentMeta = options.paymentMeta || {};
  const propertyCtx = await resolvePropertyContext(invoice);

  const vendorUser = await User.findOne({
    _id: invoice.vendorId,
    isDeleted: { $ne: true },
  })
    .select('firstName lastName email phone')
    .lean();
  const vendorName = displayNameFromUser(vendorUser);

  const paymentDate = paymentMeta.paymentDate
    ? new Date(paymentMeta.paymentDate)
    : (invoice.paidAt ? new Date(invoice.paidAt) : ClockService.now());

  const bankAccount =
    String(paymentMeta.bankAccount || '').trim() ||
    String(paymentMeta.paymentMethod || '').trim() ||
    propertyCtx.bankAccount ||
    'Vendor invoice payment';

  const taxableEntity = await resolveTaxableEntity(propertyCtx.hoaId, propertyCtx.propertyName);
  const hoaIdOid = propertyCtx.hoaId || toOid(options.hoaContext?.hoaId) || toOid(invoice.hoaId);

  const invoiceRef = String(invoice.invoiceNumber || invoiceId);
  const noteParts = [
    `Auto-created from Vendor Invoice ${invoiceRef}`,
    invoice.title ? `Title: ${invoice.title}` : null,
    paymentMeta.paymentMethod ? `Payment method: ${paymentMeta.paymentMethod}` : null,
  ].filter(Boolean);

  const expensePayload = {
    taxableEntity,
    bankAccount: String(bankAccount).slice(0, 200),
    ...(propertyCtx.propertyId ? { property: propertyCtx.propertyId } : {}),
    ...(propertyCtx.unitId ? { unitId: propertyCtx.unitId } : {}),
    ...(propertyCtx.unitName ? { unit: String(propertyCtx.unitName).slice(0, 100) } : {}),
    payees: [
      {
        name: vendorName.slice(0, 200),
        contact: 'Vendor invoice payee',
        email: vendorUser?.email || undefined,
        phone: vendorUser?.phone || undefined,
      },
    ],
    expenseItems: buildExpenseItems(invoice, paymentDate),
    vendorPaidTo: vendorName.slice(0, 200),
    expenseDate: paymentDate,
    dueDate: invoice.dueDate ? new Date(invoice.dueDate) : paymentDate,
    paymentDate,
    status: EXPENSE_STATUS.PAID,
    notes: noteParts.map((text) => ({
      text: String(text).slice(0, 1000),
      createdBy: actorOid || undefined,
      createdAt: ClockService.now(),
    })),
    ...(hoaIdOid ? { hoaId: hoaIdOid } : {}),
    createdBy: actorOid || toOid(invoice.createdBy) || undefined,
    updatedBy: actorOid || undefined,
    hoaBoardMemberId: actorOid || toOid(invoice.assignedTo) || undefined,
    vendorInvoiceId: invoiceId,
    vendorUserId: toOid(invoice.vendorId) || undefined,
  };

  try {
    const expense = new Expense(expensePayload);
    expense.expenseId = await allocateUniqueExpenseId();
    // Ensure paid status survives pre-save (paid is exempt from dueDate auto-flip)
    expense.status = EXPENSE_STATUS.PAID;
    expense.paymentDate = paymentDate;
    await expense.validate();
    const saved = await expense.save();

    await VendorInvoice.updateOne(
      { _id: invoiceId },
      { $set: { expenseId: saved._id } }
    );

    const plainExpense = saved.toObject ? saved.toObject() : saved;
    const withAttachment = await ensureInvoiceAttachedToExpense(
      plainExpense,
      invoice,
      options.actorId
    );

    notifyExpenseCreatedInAppInBackground(withAttachment || saved, options.actorId || null);

    logger.info('Expense created for paid vendor invoice', {
      module: MODULE,
      vendorInvoiceId: String(invoiceId),
      expenseId: String(saved._id),
      expenseHumanId: saved.expenseId,
    });

    return { created: true, expense: withAttachment || plainExpense };
  } catch (err) {
    // Race: another request created the expense first
    if (err?.code === 11000 || /duplicate key/i.test(String(err?.message || ''))) {
      const raced = await Expense.findOne({
        vendorInvoiceId: invoiceId,
        isDeleted: { $ne: true },
      }).lean();
      if (raced) {
        await VendorInvoice.updateOne(
          { _id: invoiceId },
          { $set: { expenseId: raced._id } }
        ).catch(() => {});
        const withAttachment = await ensureInvoiceAttachedToExpense(
          raced,
          invoice,
          options.actorId
        );
        return { created: false, expense: withAttachment };
      }
    }
    logger.error('ensureExpenseForPaidVendorInvoice failed', {
      module: MODULE,
      vendorInvoiceId: String(invoiceId),
      error: err?.message || err,
    });
    throw err;
  }
}

module.exports = {
  ensureExpenseForPaidVendorInvoice,
  attachVendorInvoicePdfToExpense,
  expenseHasInvoiceAttachment,
  resolvePropertyContext,
  EXPENSE_CATEGORY,
};
