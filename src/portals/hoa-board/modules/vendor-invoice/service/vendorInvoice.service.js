const mongoose = require('mongoose');
const VendorInvoice = require('../model/vendorInvoice.model');
const { VENDOR_INVOICE_STATUS } = require('../model/vendorInvoice.model');
const { getPagination } = require('../../../../../common/helpers/paginationHelper');
const { isVendorRole } = require('../../../../../common/helpers/hoaVendorRole');
const { resolveUserRoleName } = require('../../../../../common/helpers/companyRoleHelper');
const User = require('../../../../../shared/modules/users/models/user.model');
const { ClockService, DateUtil } = require('../../../../../common/date');
const MaintenanceRequest = require('../../../../../shared/modules/maintenance/model/maintenanceRequest.model');
const HOAMembership = require('../../hoa/model/hoaMembership.model');
const logger = require('../../../../../common/logger');
const {
  collectTicketPartyIds,
  userTypeFromRoleName,
  suggestVendorInvoiceAssigneeId,
} = require('../helpers/suggestVendorInvoiceAssignee');
const { ensureExpenseForPaidVendorInvoice } = require('../helpers/vendorInvoiceExpense.helper');
const {
  notifyVendorInvoiceCommentInAppInBackground,
} = require('../../../../../common/helpers/hoaInAppNotify.helper');
const {
  notifyVendorInvoiceCommentEmailInBackground,
} = require('../helpers/vendorInvoiceCommentEmail.helper');
const {
  notifyVendorInvoicePaymentEmailInBackground,
} = require('../helpers/vendorInvoicePaymentEmail.helper');
const { getTodayStartAndTomorrowStart } = require('../../../../../common/helpers/hoaBillingDates');

const MODULE = 'vendor-invoice-service';

/** Aligns with HOA income payment-method list filter aliases. */
const VENDOR_PAYMENT_METHOD_FILTER_ALIASES = {
  ACH: ['ACH', 'ACH Bank Transfer', 'Bank Transfer', 'bank_transfer', 'echeck', 'eCheck', 'e-check', 'E-Check'],
  Card: ['Card', 'Credit Card', 'credit_card', 'Debit Card', 'debit_card', 'card', 'Credit / Debit Card', 'Credit/Debit Card'],
  Cash: ['Cash', 'cash'],
  Check: ['Check', 'check', 'Cheque', 'Cheque Payment'],
  'Money Order': ['Money Order', 'Money Order Payment', 'money_order', 'moneyorder'],
};

function expandVendorPaymentMethodFilterValues(parts = []) {
  const expanded = new Set();
  for (const part of parts) {
    const key = String(part || '').trim();
    if (!key) continue;
    const aliases = VENDOR_PAYMENT_METHOD_FILTER_ALIASES[key] || [key];
    for (const alias of aliases) {
      const normalized = String(alias || '').trim();
      if (normalized) expanded.add(normalized);
    }
  }
  return [...expanded];
}

/**
 * Filter vendor invoices by payment method recorded on activityTimeline payment entries.
 * (paymentTransactions are derived at read time and are not stored on the document.)
 */
function applyVendorPaymentMethodListFilter(filter, paymentMethod) {
  if (paymentMethod == null || paymentMethod === '') return;
  const raw = String(paymentMethod).trim();
  if (!raw) return;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const methods = expandVendorPaymentMethodFilterValues(parts);
  if (methods.length === 0) return;

  const escaped = methods.map((method) => String(method).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const methodMatch = {
    $elemMatch: {
      kind: { $in: ['payment', 'payment_overpayment'] },
      isDeleted: { $ne: true },
      method: {
        $regex: `^(${escaped.join('|')})$`,
        $options: 'i',
      },
    },
  };
  filter.$and = (filter.$and || []).concat([{ activityTimeline: methodMatch }]);
}

function toOid(id) {
  if (!id) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  if (mongoose.Types.ObjectId.isValid(String(id))) {
    return new mongoose.Types.ObjectId(String(id));
  }
  return null;
}

function extractPaymentMeta(payload = {}) {
  const meta = {};
  if (payload.paymentMethod != null && String(payload.paymentMethod).trim()) {
    meta.paymentMethod = String(payload.paymentMethod).trim();
  }
  if (payload.paymentDate) {
    meta.paymentDate = payload.paymentDate;
  }
  if (payload.bankAccount != null && String(payload.bankAccount).trim()) {
    meta.bankAccount = String(payload.bankAccount).trim();
  }
  return meta;
}

/**
 * After invoice is Paid, create linked expense (non-blocking for response if it fails after save).
 * Failures are logged; invoice Paid state is preserved.
 */
async function maybeCreateExpenseForPaidInvoice(invoiceDoc, { actorId, hoaContext, paymentMeta, previousStatus }) {
  const status = invoiceDoc?.status;
  if (status !== VENDOR_INVOICE_STATUS.PAID) return null;
  void previousStatus;

  try {
    // Idempotent: creates expense if missing and attaches invoice PDF when absent.
    const result = await ensureExpenseForPaidVendorInvoice(invoiceDoc, {
      actorId,
      hoaContext,
      paymentMeta,
    });
    return result;
  } catch (err) {
    logger.error('Vendor invoice paid → expense create failed', {
      module: MODULE,
      vendorInvoiceId: String(invoiceDoc?._id || ''),
      error: err?.message || err,
    });
    return null;
  }
}

function normalizeLineItems(items = []) {
  return items.map((item) => {
    const quantity = Number(item.quantity ?? 1);
    const rate = Number(item.rate ?? 0);
    const amount = item.amount != null ? Number(item.amount) : quantity * rate;
    return {
      description: String(item.description || '').trim(),
      quantity,
      rate,
      amount,
    };
  });
}

function computeTotals(lineItems, amountPaid = 0) {
  const subAmount = lineItems.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const paid = Math.max(0, Number(amountPaid || 0));
  const balanceDue = Math.max(0, subAmount - paid);
  return { subAmount, amountPaid: paid, balanceDue };
}

function deriveStatus(subAmount, amountPaid, explicitStatus) {
  if (explicitStatus === VENDOR_INVOICE_STATUS.CANCELLED) {
    return VENDOR_INVOICE_STATUS.CANCELLED;
  }
  if (explicitStatus === VENDOR_INVOICE_STATUS.PROCESSING) {
    return VENDOR_INVOICE_STATUS.PROCESSING;
  }
  if (explicitStatus === VENDOR_INVOICE_STATUS.PAID) {
    return VENDOR_INVOICE_STATUS.PAID;
  }
  if (amountPaid >= subAmount && subAmount > 0) {
    return VENDOR_INVOICE_STATUS.PAID;
  }
  return VENDOR_INVOICE_STATUS.PENDING;
}

function resolvePersonDisplayName(user) {
  if (!user) return null;
  if (typeof user === 'string') return null;
  return `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email || null;
}

async function nextInvoiceNumber(vendorId) {
  const count = await VendorInvoice.countDocuments({ vendorId, isDeleted: { $ne: true } });
  const seq = String(count + 1).padStart(4, '0');
  const year = new Date().getFullYear();
  return `VI-${year}-${seq}`;
}

async function assertAssigneeExists(assignedTo) {
  const user = await User.findOne({ _id: assignedTo, isDeleted: { $ne: true } })
    .select('_id firstName lastName email')
    .lean();
  if (!user) {
    const err = new Error('Assigned user not found');
    err.status = 400;
    throw err;
  }
  return user;
}

async function resolveVendorDepositBank(vendorId) {
  const vendorOid = toOid(vendorId && vendorId._id ? vendorId._id : vendorId);
  if (!vendorOid) {
    return { depositBankAccountId: '', depositBankAccountName: '' };
  }
  try {
    const PaymentBankAccount = require('../../../../../shared/modules/payment/model/paymentBankAccount.model');
    const bank = await PaymentBankAccount.findOne({
      createdBy: vendorOid,
    })
      .sort({ straddleReady: -1, verificationStatus: -1, updatedAt: -1 })
      .select('_id holderName last4 accountType verificationStatus straddleReady')
      .lean();
    if (!bank) {
      return { depositBankAccountId: '', depositBankAccountName: '' };
    }
    const last4 = bank.last4 ? String(bank.last4).replace(/\D/g, '').slice(-4) : '';
    const holder = String(bank.holderName || 'Bank account').trim();
    const label = last4 ? `${holder} ••••${last4}` : holder;
    return {
      depositBankAccountId: String(bank._id),
      depositBankAccountName: label,
    };
  } catch (err) {
    logger.warn('resolveVendorDepositBank failed', { module: MODULE, error: err?.message || err });
    return { depositBankAccountId: '', depositBankAccountName: '' };
  }
}

function sortActivityTimelineNewestFirst(timeline = []) {
  if (!Array.isArray(timeline) || timeline.length < 2) return timeline || [];
  return [...timeline].sort((a, b) => {
    const aAt = a?.at ? new Date(a.at).getTime() : 0;
    const bAt = b?.at ? new Date(b.at).getTime() : 0;
    return (bAt || 0) - (aAt || 0);
  });
}

function sanitizeVendorPaymentNote(note, method) {
  const raw = String(note || '').trim();
  if (!raw) return '';
  if (/payload vendor payin\s+txn_/i.test(raw) || /\btxn_[A-Za-z0-9]+\b/.test(raw)) {
    const methodLabel = String(method || 'online').trim() || 'online';
    return `Electronic ${methodLabel} payment`;
  }
  return raw;
}

function paymentTransactionsFromTimeline(timeline = []) {
  if (!Array.isArray(timeline)) return [];
  return timeline
    .filter((entry) => entry && (entry.kind === 'payment' || entry.kind === 'payment_overpayment'))
    .map((entry, index) => {
      const atIso = entry.at
        ? (entry.at instanceof Date ? entry.at.toISOString() : String(entry.at))
        : new Date().toISOString();
      return {
        _id: `vendor-timeline-payment-${index}-${atIso}`,
        amount: Number(entry.amount || 0),
        method: entry.method || 'Manual',
        status: 'completed',
        note: sanitizeVendorPaymentNote(entry.note, entry.method),
        checkNumber: entry.checkNumber,
        moneyOrderNumber: entry.moneyOrderNumber,
        balanceAfter: Number(entry.balanceAfter ?? 0),
        // Prefer event instant (`at`) so partial payments on the same calendar day
        // keep distinct times. `paidOn` is date-only and must not drive datetime UI.
        paidAt: atIso,
        recordedAt: atIso,
        paidBy: entry.paidBy || null,
        recordedBy: entry.recordedBy || null,
        isManual: true,
        isDeleted: Boolean(entry.isDeleted),
      };
    });
}

async function enrichTimelineActorNames(timeline = []) {
  if (!Array.isArray(timeline) || timeline.length === 0) return timeline || [];
  const idKeys = ['paidBy', 'recordedBy', 'changedBy', 'createdBy', 'editedBy', 'waivedBy'];
  const ids = new Set();
  for (const entry of timeline) {
    for (const key of idKeys) {
      const value = entry?.[key];
      if (typeof value === 'string' && /^[0-9a-fA-F]{24}$/.test(value.trim())) {
        ids.add(value.trim());
      }
    }
  }
  if (ids.size === 0) {
    return timeline.map((entry) => ({
      ...entry,
      note: sanitizeVendorPaymentNote(entry?.note, entry?.method),
    }));
  }
  const users = await User.find({ _id: { $in: [...ids] }, isDeleted: { $ne: true } })
    .select('firstName lastName name email')
    .lean();
  const nameById = new Map(
    users.map((user) => [String(user._id), resolvePersonDisplayName(user) || 'User']),
  );
  return timeline.map((entry) => {
    const next = { ...entry, note: sanitizeVendorPaymentNote(entry?.note, entry?.method) };
    for (const key of idKeys) {
      const value = next[key];
      if (typeof value === 'string' && nameById.has(value.trim())) {
        next[key] = nameById.get(value.trim());
      }
    }
    return next;
  });
}

async function resolveVendorInvoiceProcessingAmount(vendorInvoiceId) {
  try {
    const { sumInFlightElectronic } = require(
      '../../../../../shared/modules/payment/providers/payload/service/payloadVendorPayin.service',
    );
    return await sumInFlightElectronic(vendorInvoiceId);
  } catch {
    return 0;
  }
}

async function resolveInvoicePropertyDetails(doc) {
  // Community name is contextual metadata — never substitute for the assignee's name.
  let communityName = null;
  if (doc.hoaId) {
    try {
      const HOA = require('../../hoa/model/hoa.model');
      const hoaDoc = await HOA.findOne({ _id: doc.hoaId, isDeleted: { $ne: true } }).select('name').lean();
      communityName = hoaDoc?.name || null;
    } catch (_) { /* non-blocking */ }
  }

  const assigneeDisplayLabel = resolvePersonDisplayName(doc.assignedTo);
  const vendorId = doc.vendorId?._id || doc.vendorId;
  const depositBank = await resolveVendorDepositBank(vendorId);
  const activityTimeline = await enrichTimelineActorNames(
    sortActivityTimelineNewestFirst(doc.activityTimeline || []),
  );
  const paymentTransactions = paymentTransactionsFromTimeline(activityTimeline);
  const processingAmount = await resolveVendorInvoiceProcessingAmount(doc._id);

  const baseEnrichment = {
    communityName: communityName || null,
    assigneeDisplayLabel: assigneeDisplayLabel || null,
    ...depositBank,
    activityTimeline,
    paymentTransactions,
    processingAmount,
  };

  if (!doc.maintenanceRequestId) {
    return {
      ...doc,
      ...baseEnrichment,
    };
  }
  try {
    const HOAProperty = require('../../property/model/property.model');
    const ticket = await MaintenanceRequest.findOne({ _id: doc.maintenanceRequestId, isDeleted: { $ne: true } })
      .select('property_id unitId units')
      .lean();
    if (!ticket?.property_id) {
      return {
        ...doc,
        ...baseEnrichment,
      };
    }
    const prop = await HOAProperty.findOne({ _id: ticket.property_id, isDeleted: { $ne: true } })
      .select('name address unitDetails')
      .lean();
    if (!prop) {
      return {
        ...doc,
        ...baseEnrichment,
      };
    }
    const resolvedUnitId = ticket.unitId
      ? String(ticket.unitId)
      : (prop.unitDetails?.[0]?._id ? String(prop.unitDetails[0]._id) : '');
    const unitName = ticket.units ||
      (ticket.unitId && prop.unitDetails?.find((u) => String(u._id) === String(ticket.unitId))?.unitName) ||
      prop.unitDetails?.[0]?.unitName ||
      '';
    return {
      ...doc,
      propertyId: String(prop._id),
      propertyName: prop.name || '',
      unitName,
      unitId: resolvedUnitId || undefined,
      propertyAddress: prop.address || null,
      ...baseEnrichment,
    };
  } catch (e) {
    logger.warn('resolveInvoicePropertyDetails failed', { module: MODULE, error: e.message });
    return {
      ...doc,
      ...baseEnrichment,
    };
  }
}

async function createVendorInvoice(payload, actorId, hoaContext = null) {
  const vendorId = toOid(actorId);
  const assignedTo = toOid(payload.assignedTo);
  if (!vendorId || !assignedTo) {
    const err = new Error('Invalid vendor or assignee');
    err.status = 400;
    throw err;
  }
  logger.info('Creating vendor invoice', { module: MODULE, action: 'createVendorInvoice', userId: String(actorId) });

  // When Vendor merchant mode is on, block create until payment account + bank exist.
  const {
    assertVendorReadyToCreateInvoice,
  } = require('../../../../../shared/modules/payment/providers/payload/service/payloadVendorEligibility.service');
  await assertVendorReadyToCreateInvoice(vendorId);

  await assertAssigneeExists(assignedTo);

  const maintenanceRequestId = toOid(payload.maintenanceRequestId);
  let ticketHoaId = null;
  if (maintenanceRequestId) {
    const ticket = await MaintenanceRequest.findOne({
      _id: maintenanceRequestId,
      isDeleted: { $ne: true },
    })
      .select('status assignedTo hoaId')
      .lean();
    if (!ticket) {
      const err = new Error('Maintenance ticket not found');
      err.status = 404;
      throw err;
    }
    if (String(ticket.status || '').toLowerCase() !== 'resolved'
      && String(ticket.status || '').toLowerCase() !== 'completed') {
      const err = new Error('Invoices can only be created for Completed or Resolved maintenance tickets');
      err.status = 400;
      throw err;
    }
    if (String(ticket.assignedTo || '') !== String(vendorId)) {
      const err = new Error('You can only invoice maintenance tickets assigned to you');
      err.status = 403;
      throw err;
    }
    const existingPaid = await VendorInvoice.findOne({
      maintenanceRequestId,
      vendorId,
      status: VENDOR_INVOICE_STATUS.PAID,
      isDeleted: { $ne: true },
    })
      .select('_id')
      .lean();
    if (existingPaid) {
      const err = new Error('This maintenance ticket already has a paid vendor invoice');
      err.status = 409;
      throw err;
    }
    ticketHoaId = ticket.hoaId || null;
  }

  const lineItems = normalizeLineItems(payload.lineItems);
  const { subAmount, amountPaid, balanceDue } = computeTotals(lineItems, payload.amountPaid || 0);
  const status = deriveStatus(subAmount, amountPaid, VENDOR_INVOICE_STATUS.PENDING);
  const invoiceNumber = await nextInvoiceNumber(vendorId);

  const doc = await VendorInvoice.create({
    invoiceNumber,
    vendorId,
    assignedTo,
    // Ticket community wins so cross-community creates are not scoped to the vendor's active HOA.
    hoaId: toOid(ticketHoaId || payload.hoaId || hoaContext?.hoaId) || undefined,
    maintenanceRequestId: maintenanceRequestId || undefined,
    title: String(payload.title || '').trim(),
    description: String(payload.description || '').trim(),
    lineItems,
    subAmount,
    amountPaid,
    balanceDue,
    status,
    dueDate: payload.dueDate ? new Date(payload.dueDate) : undefined,
    paidAt: status === VENDOR_INVOICE_STATUS.PAID ? ClockService.now() : undefined,
    notes: String(payload.notes || '').trim(),
    createdBy: vendorId,
    activityTimeline: [{ kind: 'created', at: ClockService.now() }],
  });

  // Ensure vendor stays associated with the invoice community (portal + notifications)
  const resolvedHoaId = doc.hoaId || toOid(ticketHoaId || payload.hoaId || hoaContext?.hoaId);
  if (resolvedHoaId && vendorId) {
    await User.updateOne(
      { _id: vendorId, isDeleted: { $ne: true } },
      { $addToSet: { associatedHoaIds: resolvedHoaId } }
    ).catch(() => {});
  }

  if (status === VENDOR_INVOICE_STATUS.PAID) {
    await maybeCreateExpenseForPaidInvoice(doc.toObject ? doc.toObject() : doc, {
      actorId,
      hoaContext,
      paymentMeta: extractPaymentMeta(payload),
      previousStatus: null,
    });
  }

  logger.info('Vendor invoice created', { module: MODULE, action: 'createVendorInvoice', userId: String(actorId) });
  return getVendorInvoiceById(doc._id, actorId, hoaContext);
}

async function listVendorInvoices(query = {}, actorId, hoaContext = null, actorRoleName = null) {
  const filter = { isDeleted: { $ne: true } };
  const actorOid = toOid(actorId);
  const roleName = actorRoleName || '';

  if (isVendorRole(roleName) || hoaContext?.isVendor) {
    filter.vendorId = actorOid;
  } else if (query.vendorId) {
    filter.vendorId = toOid(query.vendorId);
  } else if (hoaContext?.isHOABoardMember && hoaContext?.hoaId) {
    filter.hoaId = toOid(hoaContext.hoaId);
  } else {
    // Assignees can see invoices assigned to them
    filter.$or = [{ vendorId: actorOid }, { assignedTo: actorOid }];
  }

  if (query.status) filter.status = query.status;
  if (query.assignedTo) filter.assignedTo = toOid(query.assignedTo);

  if (query.searchText) {
    const text = String(query.searchText).trim();
    if (text) {
      filter.$and = (filter.$and || []).concat([{
        $or: [
          { title: { $regex: text, $options: 'i' } },
          { invoiceNumber: { $regex: text, $options: 'i' } },
          { description: { $regex: text, $options: 'i' } },
        ],
      }]);
    }
  }

  // Due-date range (matches vendor Payment History / Income date filter semantics)
  if (query.startDate || query.endDate) {
    filter.dueDate = {};
    if (query.startDate) {
      filter.dueDate.$gte = DateUtil.startOfDayEST(query.startDate) || new Date(`${query.startDate}T00:00:00.000Z`);
    }
    if (query.endDate) {
      filter.dueDate.$lte = DateUtil.endOfDayEST(query.endDate) || new Date(`${query.endDate}T23:59:59.999Z`);
    }
  }

  applyVendorPaymentMethodListFilter(filter, query.paymentMethod);

  const { offset, limit, page, pageSize } = getPagination({
    page: query.pageNumber || query.page,
    pageSize: query.pageSize,
  });

  const [rawData, total] = await Promise.all([
    VendorInvoice.find(filter)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .populate('vendorId', 'firstName lastName email')
      .populate('assignedTo', 'firstName lastName email')
      .lean(),
    VendorInvoice.countDocuments(filter),
  ]);

  const data = await Promise.all(rawData.map(resolveInvoicePropertyDetails));
  return { data, total, page, pageSize };
}

function assertVendorInvoiceAccess(doc, actorId, hoaContext = null) {
  if (!doc) {
    const err = new Error('Vendor invoice not found');
    err.status = 404;
    throw err;
  }

  const actor = String(actorId);
  const vendorId = String(doc.vendorId?._id || doc.vendorId);
  const assigneeId = String(doc.assignedTo?._id || doc.assignedTo);
  const isBoard = Boolean(hoaContext?.isHOABoardMember);
  if (actor !== vendorId && actor !== assigneeId && !isBoard) {
    const err = new Error('Access denied');
    err.status = 403;
    throw err;
  }

  if (isBoard && hoaContext?.hoaId && doc.hoaId && String(doc.hoaId) !== String(hoaContext.hoaId)) {
    const err = new Error('Vendor invoice not found');
    err.status = 404;
    throw err;
  }
}

async function getVendorInvoiceById(id, actorId, hoaContext = null) {
  const doc = await VendorInvoice.findOne({ _id: id, isDeleted: { $ne: true } })
    .populate('vendorId', 'firstName lastName email')
    .populate('assignedTo', 'firstName lastName email')
    .populate('comments.createdBy', 'firstName lastName email')
    .populate('comments.updatedBy', 'firstName lastName email')
    .lean();

  assertVendorInvoiceAccess(doc, actorId, hoaContext);

  return resolveInvoicePropertyDetails(doc);
}

function buildEntityNoteFromPayload(noteData, userId) {
  const text = String(noteData?.description || noteData?.text || '').trim();
  if (!text) {
    const err = new Error('Note description is required');
    err.status = 400;
    throw err;
  }
  if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) {
    const err = new Error('Authenticated user is required to add a note');
    err.status = 401;
    throw err;
  }
  const now = ClockService.now();
  return {
    text,
    title: noteData?.title ? String(noteData.title).trim() : '',
    isPinned: Boolean(noteData?.isPinned),
    isImportant: Boolean(noteData?.isImportant),
    reminder: noteData?.reminder ? (DateUtil.toUTC(noteData.reminder) || undefined) : undefined,
    isSystem: false,
    createdBy: new mongoose.Types.ObjectId(String(userId)),
    updatedBy: new mongoose.Types.ObjectId(String(userId)),
    createdAt: now,
    updatedAt: now,
    attachments: [],
  };
}

function notifyVendorInvoiceCommentAdded(invoice, actorUserId) {
  notifyVendorInvoiceCommentInAppInBackground(invoice, actorUserId, invoice?.hoaId);
  notifyVendorInvoiceCommentEmailInBackground(invoice, actorUserId);
}

async function addVendorInvoiceNote(id, noteData, userId, hoaContext = null) {
  const existing = await VendorInvoice.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!existing) {
    const err = new Error('Vendor invoice not found');
    err.status = 404;
    throw err;
  }
  assertVendorInvoiceAccess(existing, userId, hoaContext);

  const note = buildEntityNoteFromPayload(noteData, userId);
  if (!Array.isArray(existing.comments)) existing.comments = [];
  existing.comments.push(note);
  await existing.save();

  const updated = await getVendorInvoiceById(id, userId, hoaContext);
  notifyVendorInvoiceCommentAdded(updated, userId);
  return updated;
}

async function updateVendorInvoiceNote(id, noteId, noteData, userId, hoaContext = null) {
  const existing = await VendorInvoice.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!existing) {
    const err = new Error('Vendor invoice not found');
    err.status = 404;
    throw err;
  }
  assertVendorInvoiceAccess(existing, userId, hoaContext);

  const note = existing.comments?.id(noteId);
  if (!note || note.isSystem) {
    const err = new Error('Note not found');
    err.status = 404;
    throw err;
  }

  if (noteData.description !== undefined || noteData.text !== undefined) {
    const text = String(noteData.description ?? noteData.text ?? '').trim();
    if (!text) {
      const err = new Error('Note description is required');
      err.status = 400;
      throw err;
    }
    note.text = text;
  }
  if (noteData.title !== undefined) note.title = String(noteData.title || '').trim();
  if (typeof noteData.isPinned === 'boolean') note.isPinned = noteData.isPinned;
  if (typeof noteData.isImportant === 'boolean') note.isImportant = noteData.isImportant;
  if (noteData.reminder !== undefined) {
    note.reminder = noteData.reminder ? (DateUtil.toUTC(noteData.reminder) || null) : null;
    note.reminderNotifiedAt = null;
  }
  if (userId && mongoose.Types.ObjectId.isValid(String(userId))) {
    note.updatedBy = new mongoose.Types.ObjectId(String(userId));
  }
  note.updatedAt = ClockService.now();

  await existing.save();
  return getVendorInvoiceById(id, userId, hoaContext);
}

async function deleteVendorInvoiceNote(id, noteId, userId, hoaContext = null) {
  const existing = await VendorInvoice.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!existing) {
    const err = new Error('Vendor invoice not found');
    err.status = 404;
    throw err;
  }
  assertVendorInvoiceAccess(existing, userId, hoaContext);

  const note = existing.comments?.id(noteId);
  if (!note || note.isSystem) {
    const err = new Error('Note not found');
    err.status = 404;
    throw err;
  }

  note.deleteOne();
  await existing.save();
  return getVendorInvoiceById(id, userId, hoaContext);
}

async function updateVendorInvoice(id, payload, actorId, hoaContext = null) {
  const existing = await VendorInvoice.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!existing) {
    const err = new Error('Vendor invoice not found');
    err.status = 404;
    throw err;
  }

  const actor = String(actorId);
  const vendorId = String(existing.vendorId);
  if (actor !== vendorId && !hoaContext?.isHOABoardMember) {
    const err = new Error('Only the creating vendor can update this invoice');
    err.status = 403;
    throw err;
  }

  if (payload.assignedTo) {
    const assignedTo = toOid(payload.assignedTo);
    await assertAssigneeExists(assignedTo);
    existing.assignedTo = assignedTo;
  }
  if (payload.title != null) existing.title = String(payload.title).trim();
  if (payload.description != null) existing.description = String(payload.description).trim();
  if (payload.notes != null) existing.notes = String(payload.notes).trim();
  if (payload.dueDate !== undefined) {
    existing.dueDate = payload.dueDate ? new Date(payload.dueDate) : undefined;
  }
  if (payload.maintenanceRequestId !== undefined) {
    existing.maintenanceRequestId = toOid(payload.maintenanceRequestId) || undefined;
  }

  let lineItems = existing.lineItems;
  if (payload.lineItems) {
    lineItems = normalizeLineItems(payload.lineItems);
    existing.lineItems = lineItems;
  }

  const previousStatus = existing.status;
  const previousAmountPaid = Number(existing.amountPaid || 0);

  const provisionalPaid = payload.amountPaid != null
    ? Number(payload.amountPaid)
    : previousAmountPaid;
  let totals = computeTotals(lineItems, provisionalPaid);
  const amountPaid = payload.status === VENDOR_INVOICE_STATUS.PAID && payload.amountPaid == null
    ? totals.subAmount
    : provisionalPaid;

  // Shared collectable invariant with Owner/Board electronic pay:
  // amountPaid + inFlightElectronic + newPayment <= subAmount
  if (Number(amountPaid) > previousAmountPaid + 0.001) {
    const paymentDelta = Math.max(0, Number(amountPaid) - previousAmountPaid);
    try {
      // Lazy require avoids circular load with payloadVendorPayin → this service.
      // eslint-disable-next-line global-require
      const {
        assertCollectableAllowsPayment,
      } = require('../../../../../shared/modules/payment/providers/payload/service/payloadVendorPayin.service');
      await assertCollectableAllowsPayment({
        invoice: {
          _id: existing._id,
          subAmount: totals.subAmount,
          amountPaid: previousAmountPaid,
        },
        invoicePaymentAmount: paymentDelta,
      });
    } catch (collectableErr) {
      if (collectableErr?.code === 'VENDOR_INVOICE_OVERPAY') {
        const err = new Error(collectableErr.message || 'Payment exceeds collectable balance');
        err.status = collectableErr.statusCode || 409;
        err.code = 'VENDOR_INVOICE_OVERPAY';
        err.details = collectableErr.details;
        throw err;
      }
      throw collectableErr;
    }
  }

  totals = computeTotals(lineItems, amountPaid);
  existing.subAmount = totals.subAmount;
  existing.amountPaid = totals.amountPaid;
  existing.balanceDue = totals.balanceDue;
  existing.status = deriveStatus(totals.subAmount, totals.amountPaid, payload.status || existing.status);

  if (existing.status === VENDOR_INVOICE_STATUS.PAID && !existing.paidAt) {
    existing.paidAt = ClockService.now();
  }

  // Build activity timeline entries for this update
  const now = ClockService.now();
  const actorUser = actorId
    ? await User.findById(actorId).select('firstName lastName email').lean().catch(() => null)
    : null;
  const actorName = resolvePersonDisplayName(actorUser);

  if (!Array.isArray(existing.activityTimeline)) {
    existing.activityTimeline = [];
  }

  // Payment recorded via amountPaid delta (partial or full)
  let paymentNotify = null;
  if (payload.amountPaid != null && Number(payload.amountPaid) > previousAmountPaid) {
    const paymentAmount = Math.max(0, Number(payload.amountPaid) - previousAmountPaid);
    const paidOn = payload.paymentDate || now.toISOString().slice(0, 10);
    existing.activityTimeline.push({
      kind: 'payment',
      at: now,
      amount: paymentAmount,
      method: payload.paymentMethod || 'Manual',
      balanceAfter: Math.max(0, totals.balanceDue),
      recordedBy: actorName,
      paidBy: actorName,
      paidOn,
    });
    if (paymentAmount > 0) {
      paymentNotify = {
        paymentAmount,
        paymentMethod: payload.paymentMethod || 'Manual',
        balanceAfter: Math.max(0, totals.balanceDue),
        paidOn,
      };
    }
  } else if (
    payload.status === VENDOR_INVOICE_STATUS.PAID &&
    previousStatus !== VENDOR_INVOICE_STATUS.PAID &&
    payload.amountPaid == null
  ) {
    // Marked as paid via status flag only (e.g. "Mark as Paid" button)
    const paidOn = now.toISOString().slice(0, 10);
    existing.activityTimeline.push({
      kind: 'payment',
      at: now,
      amount: totals.subAmount,
      method: payload.paymentMethod || 'Manual',
      balanceAfter: 0,
      recordedBy: actorName,
      paidBy: actorName,
      paidOn,
    });
    if (totals.subAmount > 0) {
      paymentNotify = {
        paymentAmount: totals.subAmount,
        paymentMethod: payload.paymentMethod || 'Manual',
        balanceAfter: 0,
        paidOn,
      };
    }
  }

  // Status change to non-payment statuses (Processing, Cancelled)
  if (
    payload.status &&
    payload.status !== previousStatus &&
    payload.status !== VENDOR_INVOICE_STATUS.PAID
  ) {
    existing.activityTimeline.push({
      kind: 'edit',
      at: now,
      changes: [`Status changed from ${previousStatus} to ${existing.status}`],
      editedBy: actorName,
    });
  }

  // Content edits (line items / title / due date) — only when not a payment operation
  const editChanges = [];
  if (payload.lineItems) editChanges.push('Line items updated');
  if (payload.title != null) editChanges.push('Title updated');
  if (payload.dueDate !== undefined) editChanges.push('Due date updated');
  if (
    editChanges.length > 0 &&
    payload.amountPaid == null &&
    payload.status !== VENDOR_INVOICE_STATUS.PAID
  ) {
    existing.activityTimeline.push({
      kind: 'edit',
      at: now,
      changes: editChanges,
      editedBy: actorName,
    });
  }

  existing.markModified('activityTimeline');
  // Keep newest-first ordering consistent with board invoice timelines
  existing.activityTimeline = sortActivityTimelineNewestFirst(existing.activityTimeline);
  existing.markModified('activityTimeline');
  await existing.save();

  // Create expense (if needed) and ensure invoice PDF is attached whenever Paid.
  if (existing.status === VENDOR_INVOICE_STATUS.PAID) {
    await maybeCreateExpenseForPaidInvoice(existing.toObject ? existing.toObject() : existing, {
      actorId,
      hoaContext,
      paymentMeta: extractPaymentMeta(payload),
      previousStatus,
    });
  }

  if (paymentNotify) {
    notifyVendorInvoicePaymentEmailInBackground({
      invoice: existing.toObject ? existing.toObject() : existing,
      paymentAmount: paymentNotify.paymentAmount,
      paymentMethod: paymentNotify.paymentMethod,
      balanceAfter: paymentNotify.balanceAfter,
      actorUserId: actorId,
      paidOn: paymentNotify.paidOn,
    });
  }

  return getVendorInvoiceById(existing._id, actorId, hoaContext);
}

async function deleteVendorInvoice(id, actorId, hoaContext = null) {
  const existing = await VendorInvoice.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!existing) {
    const err = new Error('Vendor invoice not found');
    err.status = 404;
    throw err;
  }

  const actor = String(actorId);
  if (actor !== String(existing.vendorId) && !hoaContext?.isHOABoardMember) {
    const err = new Error('Access denied');
    err.status = 403;
    throw err;
  }

  existing.isDeleted = true;
  await existing.save();
  logger.info('Vendor invoice deleted', { module: MODULE, action: 'deleteVendorInvoice', userId: String(actorId) });
  return existing;
}

/**
 * Build vendor finance KPI totals from status-grouped aggregate rows.
 * Paid dollars use Σ amountPaid (includes partials); outstanding uses Σ balanceDue.
 */
function summarizeVendorInvoiceFinanceRows(rows = []) {
  const byStatus = Object.fromEntries(
    (rows || []).map((r) => [
      r._id,
      {
        count: Number(r.count || 0),
        amountPaid: Number(r.amountPaid || 0),
        balanceDue: Number(r.balanceDue || 0),
        partiallyPaidCount: Number(r.partiallyPaidCount || 0),
      },
    ])
  );
  const pick = (status) => byStatus[status] || {
    count: 0,
    amountPaid: 0,
    balanceDue: 0,
    partiallyPaidCount: 0,
  };

  const paidRow = pick(VENDOR_INVOICE_STATUS.PAID);
  const pendingRow = pick(VENDOR_INVOICE_STATUS.PENDING);
  const processingRow = pick(VENDOR_INVOICE_STATUS.PROCESSING);
  const cancelledRow = pick(VENDOR_INVOICE_STATUS.CANCELLED);

  // Collected cash across fully paid + partially paid invoices.
  const paidAmount =
    paidRow.amountPaid + pendingRow.amountPaid + processingRow.amountPaid;
  const pendingAmount = pendingRow.balanceDue;
  const processingAmount = processingRow.balanceDue;
  // Cash already received on invoices that still have a remaining balance.
  const partiallyPaidAmount = pendingRow.amountPaid + processingRow.amountPaid;
  const partiallyPaidCount =
    pendingRow.partiallyPaidCount + processingRow.partiallyPaidCount;

  return {
    total:
      paidRow.count + pendingRow.count + processingRow.count + cancelledRow.count,
    paid: paidRow.count,
    pending: pendingRow.count,
    processing: processingRow.count,
    cancelled: cancelledRow.count,
    partiallyPaid: partiallyPaidCount,
    amounts: {
      total: paidAmount + pendingAmount + processingAmount,
      paid: paidAmount,
      pending: pendingAmount,
      processing: processingAmount,
      partiallyPaid: partiallyPaidAmount,
      overdue: 0,
      dueToday: 0,
      comingDue: 0,
    },
  };
}

/**
 * Split outstanding vendor invoice balances by due calendar (HOA business TZ).
 * Pending + Processing with remaining balance; Paid/Cancelled excluded.
 */
async function aggregateVendorInvoiceDueBuckets(match = {}) {
  const { todayStart, tomorrowStart } = getTodayStartAndTomorrowStart();
  if (!todayStart || !tomorrowStart) {
    return { overdue: 0, dueToday: 0, comingDue: 0 };
  }

  const rows = await VendorInvoice.aggregate([
    {
      $match: {
        ...match,
        status: {
          $in: [VENDOR_INVOICE_STATUS.PENDING, VENDOR_INVOICE_STATUS.PROCESSING],
        },
        balanceDue: { $gt: 0 },
      },
    },
    {
      $group: {
        _id: null,
        overdue: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $ne: ['$dueDate', null] },
                  { $lt: ['$dueDate', todayStart] },
                ],
              },
              { $ifNull: ['$balanceDue', 0] },
              0,
            ],
          },
        },
        dueToday: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $ne: ['$dueDate', null] },
                  { $gte: ['$dueDate', todayStart] },
                  { $lt: ['$dueDate', tomorrowStart] },
                ],
              },
              { $ifNull: ['$balanceDue', 0] },
              0,
            ],
          },
        },
        comingDue: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $eq: ['$dueDate', null] },
                  { $gte: ['$dueDate', tomorrowStart] },
                ],
              },
              { $ifNull: ['$balanceDue', 0] },
              0,
            ],
          },
        },
      },
    },
  ]);

  const row = rows[0] || {};
  return {
    overdue: Number(row.overdue || 0),
    dueToday: Number(row.dueToday || 0),
    comingDue: Number(row.comingDue || 0),
  };
}

function applyVendorDueBucketsToSummary(summary, dueBuckets = {}) {
  const amounts = summary?.amounts || {};
  amounts.overdue = Number(dueBuckets.overdue || 0);
  amounts.dueToday = Number(dueBuckets.dueToday || 0);
  amounts.comingDue = Number(dueBuckets.comingDue || 0);
  return summary;
}

const VENDOR_INVOICE_FINANCE_GROUP = {
  _id: '$status',
  count: { $sum: 1 },
  amountPaid: { $sum: { $ifNull: ['$amountPaid', 0] } },
  balanceDue: { $sum: { $ifNull: ['$balanceDue', 0] } },
  partiallyPaidCount: {
    $sum: {
      $cond: [
        {
          $and: [
            { $gt: [{ $ifNull: ['$amountPaid', 0] }, 0] },
            { $gt: [{ $ifNull: ['$balanceDue', 0] }, 0] },
          ],
        },
        1,
        0,
      ],
    },
  },
};

async function getVendorInvoiceStats(actorId, hoaContext = null) {
  const vendorOid = toOid(actorId);
  const match = {
    isDeleted: { $ne: true },
    vendorId: vendorOid,
  };
  // Vendor portal lists all invoices for this vendor (no HOA scope). Keep stats aligned
  // so Payment History KPIs are not zeroed by an active community filter.
  // Board/assignee received-stats retain HOA scoping separately.
  if (hoaContext?.hoaId && !hoaContext?.isVendor) {
    match.hoaId = toOid(hoaContext.hoaId);
  }

  const [rows, dueBuckets] = await Promise.all([
    VendorInvoice.aggregate([
      { $match: match },
      { $group: VENDOR_INVOICE_FINANCE_GROUP },
    ]),
    aggregateVendorInvoiceDueBuckets(match),
  ]);

  return applyVendorDueBucketsToSummary(
    summarizeVendorInvoiceFinanceRows(rows),
    dueBuckets
  );
}

/**
 * Normalize maintenance status keys from aggregation (_id may vary in casing/spacing).
 */
function normalizeVendorMaintenanceStatusKey(status) {
  return String(status || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

/**
 * Summarize vendor-assigned maintenance ticket counts by status.
 * Open = any ticket that is not Resolved/Completed (includes Open + InProgress).
 * Completed = Resolved + Completed.
 */
function summarizeVendorMaintenanceStatusRows(ticketRows = []) {
  const byStatus = {};
  for (const row of ticketRows || []) {
    const key = normalizeVendorMaintenanceStatusKey(row?._id);
    if (!key) continue;
    byStatus[key] = (byStatus[key] || 0) + Number(row.count || 0);
  }
  const completed =
    (byStatus.resolved || 0)
    + (byStatus.completed || 0)
    + (byStatus.closed || 0);
  const inProgress = byStatus.inprogress || 0;
  const openOnly = byStatus.open || 0;
  const totalTickets = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
  // Any non-resolved ticket counts as Open for vendor dashboard stats.
  const open = Math.max(0, totalTickets - completed);
  return {
    total: totalTickets,
    completed,
    remaining: open,
    open,
    inProgress: inProgress || Math.max(0, open - openOnly),
  };
}

function buildVendorMaintenanceTicketMatch(actorId, hoaContext = null, range = null) {
  const vendorOid = toOid(actorId);
  const ticketMatch = {
    isDeleted: { $ne: true },
    assignedTo: vendorOid,
  };
  // Do NOT scope by active HOA — vendors see all tickets assigned to them
  // (matches maintenance list). Cross-community assigned work must appear in stats.
  void hoaContext;

  if (range?.startDate && range?.endDate) {
    const { DateUtil } = require('../../../../../common/date');
    const startBound = DateUtil.startOfDayEST(range.startDate) || DateUtil.toUTC(range.startDate);
    const endBound = DateUtil.endOfDayEST(range.endDate) || DateUtil.toUTC(range.endDate);
    if (startBound && endBound) {
      // Match maintenance listing date filter (request_date), not createdAt.
      ticketMatch.request_date = { $gte: startBound, $lte: endBound };
    }
  }

  return ticketMatch;
}

async function aggregateVendorMaintenanceStats(actorId, hoaContext = null, range = null) {
  const ticketMatch = buildVendorMaintenanceTicketMatch(actorId, hoaContext, range);
  const ticketRows = await MaintenanceRequest.aggregate([
    { $match: ticketMatch },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  return summarizeVendorMaintenanceStatusRows(ticketRows);
}

async function getVendorDashboardStats(actorId, hoaContext = null, range = null) {
  // Maintenance stats are lifetime for the vendor's assigned tickets (no HOA / date
  // scoping). Open/InProgress work must remain visible even when the dashboard
  // period filter would exclude the ticket's request_date.
  const [maintenance, finance] = await Promise.all([
    aggregateVendorMaintenanceStats(actorId, hoaContext, null),
    getVendorInvoiceStats(actorId, hoaContext),
  ]);

  const allTimeMaintenanceStats = {
    opened: maintenance.open || 0,
    closed: maintenance.completed || 0,
  };

  return {
    maintenance,
    allTimeMaintenanceStats,
    /** @deprecated Use allTimeMaintenanceStats */
    priorPeriodMaintenanceStats: allTimeMaintenanceStats,
    finance,
  };
}

async function listReceivedInvoices(query = {}, actorId, hoaContext = null) {
  const actorOid = toOid(actorId);
  const filter = { isDeleted: { $ne: true }, assignedTo: actorOid };

  if (hoaContext?.hoaId) filter.hoaId = toOid(hoaContext.hoaId);
  if (query.status) filter.status = query.status;

  if (query.searchText) {
    const text = String(query.searchText).trim();
    if (text) {
      const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchRegex = { $regex: escape(text), $options: 'i' };
      filter.$and = (filter.$and || []).concat([{
        $or: [
          { title: searchRegex },
          { invoiceNumber: searchRegex },
          { propertyName: searchRegex },
          { unitName: searchRegex },
        ],
      }]);
    }
  }

  // Due-date range (matches UI date filter on Vendor Invoices inbox)
  if (query.startDate || query.endDate) {
    const { DateUtil } = require('../../../../../common/date');
    filter.dueDate = {};
    if (query.startDate) {
      filter.dueDate.$gte = DateUtil.startOfDayEST(query.startDate) || new Date(`${query.startDate}T00:00:00.000Z`);
    }
    if (query.endDate) {
      filter.dueDate.$lte = DateUtil.endOfDayEST(query.endDate) || new Date(`${query.endDate}T23:59:59.999Z`);
    }
  }

  applyVendorPaymentMethodListFilter(filter, query.paymentMethod);

  const { offset, limit, page, pageSize } = getPagination({
    page: query.pageNumber || query.page,
    pageSize: query.pageSize,
  });

  const [rawData, total] = await Promise.all([
    VendorInvoice.find(filter)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .populate('vendorId', 'firstName lastName email')
      .populate('assignedTo', 'firstName lastName email')
      .lean(),
    VendorInvoice.countDocuments(filter),
  ]);

  const data = await Promise.all(rawData.map(resolveInvoicePropertyDetails));
  return { data, total, page, pageSize };
}

async function getReceivedInvoiceStats(actorId, hoaContext = null) {
  const actorOid = toOid(actorId);
  const match = { isDeleted: { $ne: true }, assignedTo: actorOid };
  if (hoaContext?.hoaId) match.hoaId = toOid(hoaContext.hoaId);

  const [rows, dueBuckets] = await Promise.all([
    VendorInvoice.aggregate([
      { $match: match },
      { $group: VENDOR_INVOICE_FINANCE_GROUP },
    ]),
    aggregateVendorInvoiceDueBuckets(match),
  ]);

  return applyVendorDueBucketsToSummary(
    summarizeVendorInvoiceFinanceRows(rows),
    dueBuckets
  );
}

function personAssignableLabel(user) {
  return `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || user?.email || '';
}

async function listAssignableUsers(hoaContext = null, searchText = '', fallbackHoaId = null, actorId = null, maintenanceRequestId = null) {
  let hoaId = hoaContext?.hoaId || fallbackHoaId;

  // Resolve property / ticket HOA first so cross-community invoices use the ticket community.
  let propertyOwnerIds = [];
  let ticket = null;
  if (maintenanceRequestId) {
    const HOAProperty = require('../../property/model/property.model');
    ticket = await MaintenanceRequest.findOne({ _id: toOid(maintenanceRequestId), isDeleted: { $ne: true } })
      .select('property_id createdBy requestedBy createdByRole hoaId')
      .lean();
    if (ticket?.hoaId) {
      hoaId = ticket.hoaId;
    }
    if (ticket?.property_id) {
      const prop = await HOAProperty.findOne({ _id: ticket.property_id, isDeleted: { $ne: true } })
        .select('associatedOwnerIds hoaId')
        .lean();
      if (!hoaId && prop?.hoaId) hoaId = prop.hoaId;
      if (prop?.associatedOwnerIds?.length) {
        propertyOwnerIds = prop.associatedOwnerIds.map(String).filter(Boolean);
      }
    }
  }

  // Last resort: vendor has no hoaContext.hoaId and sent no hoaId param - resolve from their own associatedHoaIds
  if (!hoaId && actorId) {
    const vendor = await User.findById(actorId).select('associatedHoaIds').lean();
    const ids = Array.isArray(vendor?.associatedHoaIds) ? vendor.associatedHoaIds.filter(Boolean) : [];
    if (ids.length) hoaId = ids[0];
  }

  if (!hoaId) return { users: [], suggestedAssigneeId: null };

  const hasProperty = propertyOwnerIds.length > 0;

  // Always fetch board members
  const members = await HOAMembership.find({ hoaId, status: 'active' }).select('userId').lean();
  const boardMemberIds = members.map((m) => m.userId).filter(Boolean);

  const searchFilter = searchText ? {
    $or: [
      { firstName: { $regex: searchText, $options: 'i' } },
      { lastName: { $regex: searchText, $options: 'i' } },
      { email: { $regex: searchText, $options: 'i' } },
    ],
  } : {};

  const boardUsers = boardMemberIds.length
    ? await User.find({ _id: { $in: boardMemberIds }, isDeleted: { $ne: true }, ...searchFilter })
      .select('firstName lastName email phone')
      .limit(50)
      .lean()
    : [];

  const result = boardUsers.map((u) => {
    const name = personAssignableLabel(u);
    return {
      id: u._id,
      _id: u._id,
      firstName: u.firstName || '',
      lastName: u.lastName || '',
      name,
      displayLabel: name,
      email: u.email,
      phone: u.phone || '',
      userType: 'board_member',
    };
  });

  const seenIds = new Set(result.map((u) => String(u._id)));

  if (hasProperty) {
    const ownerIdsToFetch = propertyOwnerIds.filter((id) => !seenIds.has(id));

    if (ownerIdsToFetch.length) {
      const ownerUsers = await User.find({
        _id: { $in: ownerIdsToFetch },
        isDeleted: { $ne: true },
        ...searchFilter,
      })
        .select('firstName lastName email phone companyRoleId companyId')
        .limit(50)
        .lean();

      for (const u of ownerUsers) {
        const name = personAssignableLabel(u);
        result.push({
          id: u._id,
          _id: u._id,
          firstName: u.firstName || '',
          lastName: u.lastName || '',
          name,
          displayLabel: name,
          email: u.email,
          phone: u.phone || '',
          userType: 'owner',
        });
        seenIds.add(String(u._id));
      }
    }
  }

  const partyIds = collectTicketPartyIds(ticket).filter((id) => !seenIds.has(id));
  if (partyIds.length) {
    const partyUsers = await User.find({
      _id: { $in: partyIds },
      isDeleted: { $ne: true },
      ...searchFilter,
    })
      .select('firstName lastName email phone companyRoleId companyId')
      .limit(20)
      .lean();

    for (const u of partyUsers) {
      const roleName = await resolveUserRoleName(u);
      if (isVendorRole(roleName)) continue;
      const uType = userTypeFromRoleName(roleName);
      const name = personAssignableLabel(u);
      result.push({
        id: u._id,
        _id: u._id,
        firstName: u.firstName || '',
        lastName: u.lastName || '',
        name,
        displayLabel: name,
        email: u.email,
        phone: u.phone || '',
        userType: uType,
      });
      seenIds.add(String(u._id));
    }
  }

  return {
    users: result,
    suggestedAssigneeId: suggestVendorInvoiceAssigneeId(result, ticket),
  };
}

module.exports = {
  createVendorInvoice,
  listVendorInvoices,
  getVendorInvoiceById,
  updateVendorInvoice,
  deleteVendorInvoice,
  addVendorInvoiceNote,
  updateVendorInvoiceNote,
  deleteVendorInvoiceNote,
  getVendorInvoiceStats,
  getVendorDashboardStats,
  summarizeVendorInvoiceFinanceRows,
  summarizeVendorMaintenanceStatusRows,
  buildVendorMaintenanceTicketMatch,
  normalizeVendorMaintenanceStatusKey,
  listAssignableUsers,
  listReceivedInvoices,
  getReceivedInvoiceStats,
  resolveInvoicePropertyDetails,
  resolvePersonDisplayName,
  VENDOR_INVOICE_STATUS,
};
