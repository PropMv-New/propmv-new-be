/**
 * ------------------------------------------------------------------
 * File: expense.service.js
 * Module: Expense Module
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * expense.controller, expenseExport.service, expense.notes.persistence.check
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Expense = require('../model/expense.model');
const Property = require('../../../../portals/landlord/modules/property/model/property.model');
const { resolveUnitForPropertyId } = require('../../../../common/helpers/propertyUnitReference');
const DocumentManager = require('../../documents/service/documentManager');
const DocumentMetadata = require('../../documents/model/documentMetadata.model');
const User = require('../../users/models/user.model');
const logger = require('../../../../common/logger');
const { getPagination } = require('../../../../common/helpers/paginationHelper');
const { EXPENSE_STATUS } = require('../../../../common/constants/expense');
const {
  buildPropertyOwnerFilter,
  findPropertyIdsByCreatedBy,
  requireCreatedBy,
  resolveCreatedBy,
} = require('../../../../shared/utils/creatorScope.util');
const { withExpenseTransaction, applySession } = require('./expenseDb.util');
const { ClockService, DateUtil } = require('../../../../common/date');
const { allocateUniqueExpenseId } = require('../../../../portals/hoa-board/modules/expense/helpers/expenseId.helper');

const docManager = new DocumentManager();

/**
 * NotFoundError
 *
 * Represents the Not Found Error controller/model class.
 */
class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

/**
 * escape Reg Exp
 *
 * Performs logic operations for escapeRegExp.
 *
 * @param s - Request/input argument
 * @returns Operations result
 */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

/** Drop fileDocument on plain item objects unless metadataId is set (API / $set payloads; findByIdAndUpdate skips document pre-save). */
function sanitizePlainExpenseItemsFileDocuments(items) {
  if (!Array.isArray(items)) {
    return;
  }
  items.forEach((it) => {
    if (!it || typeof it !== 'object') {
      return;
    }
    const fd = it.fileDocument;
    if (!fd) {
      return;
    }
    const m = fd.metadataId;
    if (m == null) {
      delete it.fileDocument;
      return;
    }
    if (typeof m === 'object' && m._id) {
      return;
    }
    if (mongoose.Types.ObjectId.isValid(String(m))) {
      return;
    }
    delete it.fileDocument;
  });
}

/**
 * Merge client expense item with existing row: preserve fileDocument on partial updates
 * unless the client sent removeReceipt (clear stored receipt) or a full fileDocument
 * with metadataId.
 * @param {object} it - incoming plain item
 * @param {number} idx
 * @param {object[]} existingItems - from DB (lean or toObject)
 */
function mergeExpenseItemWithExisting(it, idx, existingItems) {
  const byId = it._id
    ? existingItems.find(
        (e) => e._id && String(e._id) === String(it._id)
      )
    : null;
  const byIndex = !byId && existingItems[idx] ? existingItems[idx] : null;
  const prev = byId || byIndex;

  if (it.removeReceipt === true) {
    const { removeReceipt, fileDocument, ...rest } = { ...it };
    return { ...rest };
  }

  const hasIncoming = it.fileDocument && it.fileDocument.metadataId;
  if (prev && prev.fileDocument && !hasIncoming) {
    const merged = { ...it, fileDocument: prev.fileDocument };
    delete merged.removeReceipt;
    return merged;
  }

  const out = { ...it };
  if (out.removeReceipt !== undefined) {
    delete out.removeReceipt;
  }
  if (out.fileDocument && !out.fileDocument.metadataId) {
    delete out.fileDocument;
  }
  return out;
}

/**
 * resolve Unit Name From Expense Doc
 *
 * Performs logic operations for resolveUnitNameFromExpenseDoc.
 *
 * @param expenseLike - Request/input argument
 * @returns Operations result
 */
function resolveUnitNameFromExpenseDoc(expenseLike) {
  const prop = expenseLike?.property;
  const unitDetails = Array.isArray(prop?.unitDetails) ? prop.unitDetails : [];
  if (expenseLike?.unitId) {
    const unit = unitDetails.find((u) => u && u._id && String(u._id) === String(expenseLike.unitId));
    if (unit?.unitName) return String(unit.unitName);
  }
  // Legacy fallback for historical rows that still carry `unit`
  return expenseLike?.unit ? String(expenseLike.unit) : '';
}

/**
 * to Expense Response
 *
 * Performs logic operations for toExpenseResponse.
 *
 * @param expenseLike - Request/input argument
 * @returns Operations result
 */
function toExpenseResponse(expenseLike) {
  const plain = expenseLike && typeof expenseLike.toObject === 'function'
    ? expenseLike.toObject()
    : { ...(expenseLike || {}) };
  plain.unit = resolveUnitNameFromExpenseDoc(plain);
  if (plain.property && plain.property.unitDetails) {
    delete plain.property.unitDetails;
  }
  return plain;
}

/**
 * parse Expense Item Indices
 *
 * Performs logic operations for parseExpenseItemIndices.
 *
 * @param raw - Request/input argument
 * @returns Operations result
 */
function parseExpenseItemIndices(raw) {
  if (raw == null || raw === '') return [];
  try {
    if (typeof raw === 'string') {
      return JSON.parse(raw)
        .map((n) => Number(n))
        .filter((n) => !Number.isNaN(n) && n >= 0);
    }
    if (Array.isArray(raw)) {
      return raw.map((n) => Number(n)).filter((n) => !Number.isNaN(n) && n >= 0);
    }
  } catch (e) {
    logger.error('Error parsing itemIndices:', e);
  }
  return [];
}

async function hydrateExpenseLean(id) {
  const safeId = toObjectId(id);
  if (!safeId) return null;
  return Expense.findOne({ _id: safeId, isDeleted: { $ne: true } })
    .populate('property', 'name address unitDetails')
    .populate('expenseItems.fileDocument.metadataId')
    .lean();
}

/**
 * attach File Metas To Expense Items
 *
 * Performs logic operations for attachFileMetasToExpenseItems.
 *
 * @param expense - Request/input argument
 * @param createdMetas - Request/input argument
 * @param itemIndices - Request/input argument
 * @returns Operations result
 */
function attachFileMetasToExpenseItems(expense, createdMetas, itemIndices) {
  for (let i = 0; i < createdMetas.length && i < itemIndices.length; i += 1) {
    const itemIndex = itemIndices[i];
    const metadata = createdMetas[i];
    if (itemIndex >= 0 && itemIndex < expense.expenseItems.length) {
      expense.expenseItems[itemIndex].fileDocument = {
        metadataId: metadata._id,
        originalName: metadata.originalName || metadata.key || '',
        uploadedAt: ClockService.now(),
      };
    }
  }
}

async function buildNewExpenseDocument(data, userId) {
  const payload = { ...data };
  if (userId) payload.createdBy = userId;

  const markAsPaidOnCreate =
    payload.markAsPaid === true
    || payload.markAsPaid === 'true'
    || String(payload.status || '').toLowerCase() === EXPENSE_STATUS.PAID;
  const requestedPaymentDate = payload.paymentDate ? new Date(payload.paymentDate) : null;
  delete payload.markAsPaid;

  if (payload.status) {
    logger.warn(
      '⚠️ Frontend attempted to set expense status - ignoring for security. Status will be set by backend.'
    );
    delete payload.status;
  }

  if (payload.property) {
    const safePropId = toObjectId(payload.property);
    if (!safePropId) throw new Error('Invalid property ID');
    const property = await Property.findOne({ _id: safePropId, isDeleted: { $ne: true } }).lean();
    if (!property) {
      throw new Error('Property not found');
    }
    payload.property = safePropId;
  }

  if (payload.property && (payload.unitId || (payload.unit && String(payload.unit).trim() !== ''))) {
    const resolved = await resolveUnitForPropertyId(payload.property, {
      unitId: payload.unitId,
      unitName: payload.unit,
    });
    payload.unitId = resolved.unitId;
  }

  if (payload.expenseItems) {
    sanitizePlainExpenseItemsFileDocuments(payload.expenseItems);
  }

  const expense = new Expense(payload);
  expense.expenseId = await allocateUniqueExpenseId();
  if (markAsPaidOnCreate) {
    expense.status = EXPENSE_STATUS.PAID;
    expense.paymentDate = requestedPaymentDate && !Number.isNaN(requestedPaymentDate.getTime())
      ? requestedPaymentDate
      : ClockService.now();
  } else {
    expense.status = EXPENSE_STATUS.PENDING;
    expense.paymentDate = undefined;
  }
  if (!expense.notes) {
    expense.notes = [];
  }
  if (!expense.expenseItems || expense.expenseItems.length === 0) {
    throw new Error('At least one expense item is required');
  }
  return expense;
}

async function createExpenseInSession(data, options, session) {
  const userId = options.userId;
  const files = (options.files || []).filter((f) => f && (f.size || 0) > 0 && f.path);
  const itemIndices = parseExpenseItemIndices(options.itemIndices);

  const expense = await buildNewExpenseDocument(data, userId);

  if (files.length > 0 && itemIndices.length > 0) {
    const createdMetas = await docManager.uploadAndCreateMetadata(files, {
      documentType: 'expense',
      userId,
      session,
    });
    attachFileMetasToExpenseItems(expense, createdMetas, itemIndices);
  } else if (files.length > 0 && itemIndices.length === 0) {
    logger.warn('Files provided but no itemIndices - skipping file upload');
  }

  await expense.validate();
  return expense.save({ session });
}

async function createExpense(data, options = {}) {
  const saved = await withExpenseTransaction(
    (session) => createExpenseInSession(data, options, session),
    options
  );
  const created = await hydrateExpenseLean(saved._id);
  return toExpenseResponse(created);
}

async function listExpenses(query = {}) {
  const { property, vendorPaidTo, category, status, startDate, endDate, dueStartDate, dueEndDate, paymentStartDate, paymentEndDate, pageNumber, pageSize, unit, unitId, taxableEntity, bankAccount, payee, minAmount, maxAmount, search } = query;
  const createdBy = resolveCreatedBy(query);
  const filter = { isDeleted: { $ne: true } };
  
  let scopedPropertyIds = [];
  if (createdBy) {
    const ownerId = requireCreatedBy({ createdBy });
    scopedPropertyIds = await findPropertyIdsByCreatedBy(Property, ownerId);
    if (!scopedPropertyIds.length) {
      return { data: [], total: 0, page: pageNumber || 1, pageSize: pageSize || 10, landlordSummary: { totalThisMonth: 0, monthlyChange: 0, paid: 0, unpaid: 0, overdue: 0, pending: 0, totalExpense: 0, collectionStats: {} } };
    }
  }

  // Property and owner validation and filtering
  if (property) {
    if (scopedPropertyIds.length > 0 && !scopedPropertyIds.some((id) => String(id) === String(property))) {
        return { data: [], total: 0, page: pageNumber || 1, pageSize: pageSize || 10, landlordSummary: { totalThisMonth: 0, monthlyChange: 0, paid: 0, unpaid: 0, overdue: 0, pending: 0, totalExpense: 0, collectionStats: {} } };
    }
    filter.property = property;
  } else if (scopedPropertyIds.length > 0) {
    filter.property = { $in: scopedPropertyIds };
  }
  
  // Text-based filters
  if (vendorPaidTo) filter.vendorPaidTo = new RegExp(vendorPaidTo, 'i');
  if (unitId) filter.unitId = unitId;
  if (unit) {
    const unitRegex = new RegExp(unit, 'i');
    const scopePropIds = filter.property?.$in
      ? filter.property.$in
      : (filter.property ? [filter.property] : []);
    let unitIdMatches = [];
    if (scopePropIds.length > 0) {
      const propsForUnits = await Property.find({ _id: { $in: scopePropIds }, isDeleted: { $ne: true } })
        .select('unitDetails')
        .lean();
      unitIdMatches = (propsForUnits || []).flatMap((p) =>
        (p.unitDetails || [])
          .filter((u) => u?.unitName && unitRegex.test(String(u.unitName)))
          .map((u) => u._id)
      );
    }
    if (unitIdMatches.length > 0) {
      if (!filter.$and) filter.$and = [];
      filter.$and.push({ $or: [{ unitId: { $in: unitIdMatches } }, { unit: unitRegex }] });
    } else {
      filter.unit = unitRegex; // legacy rows fallback
    }
  }
  if (taxableEntity) filter.taxableEntity = new RegExp(taxableEntity, 'i');
  if (bankAccount) filter.bankAccount = new RegExp(bankAccount, 'i');
  if (payee) filter['payees.name'] = new RegExp(payee, 'i');
  
  // Category filter: support comma list or full label (dropdown), not a raw regex from UI
  if (category) {
    const cats = String(category)
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    if (cats.length === 1) {
      filter['expenseItems.category'] = cats[0];
    } else if (cats.length > 1) {
      filter['expenseItems.category'] = { $in: cats };
    }
  }
  
  if (status) {
    const st = String(status)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (st.length === 1) {
      filter.status = st[0];
    } else if (st.length > 1) {
      filter.status = { $in: st };
    }
  }
  
  // Amount range filters (based on total)
  if (minAmount !== undefined || maxAmount !== undefined) {
    filter.total = {};
    if (minAmount !== undefined) filter.total.$gte = minAmount;
    if (maxAmount !== undefined) filter.total.$lte = maxAmount;
  }
  
  // Date range filters
  if (startDate || endDate) {
    filter.expenseDate = {};
    if (startDate) filter.expenseDate.$gte = DateUtil.toUTC(startDate);
    if (endDate) filter.expenseDate.$lte = DateUtil.toUTC(endDate);
  }
  
  if (dueStartDate || dueEndDate) {
    filter.dueDate = {};
    if (dueStartDate) filter.dueDate.$gte = DateUtil.toUTC(dueStartDate);
    if (dueEndDate) filter.dueDate.$lte = DateUtil.toUTC(dueEndDate);
  }
  
  if (paymentStartDate || paymentEndDate) {
    filter.paymentDate = {};
    if (paymentStartDate) filter.paymentDate.$gte = DateUtil.toUTC(paymentStartDate);
    if (paymentEndDate) filter.paymentDate.$lte = DateUtil.toUTC(paymentEndDate);
  }

  if (search && String(search).trim()) {
    const q = new RegExp(escapeRegExp(String(search).trim()), 'i');
    const orConds = [
      { vendorPaidTo: q },
      { 'expenseItems.category': q },
      { 'expenseItems.description': q },
      { unit: q },
    ];
    const propQ = { name: q };
    if (createdBy) {
      Object.assign(propQ, buildPropertyOwnerFilter(createdBy));
    }
    propQ.isDeleted = { $ne: true };
    const nameMatches = await Property.find(propQ).select('_id').lean();
    const nameIds = (nameMatches || []).map((p) => p._id);
    if (nameIds.length > 0) {
      orConds.push({ property: { $in: nameIds } });
    }
    const scopePropIdsForUnits = filter.property?.$in
      ? filter.property.$in
      : (filter.property ? [filter.property] : []);
    if (scopePropIdsForUnits.length > 0) {
      const propsForUnits = await Property.find({ _id: { $in: scopePropIdsForUnits }, isDeleted: { $ne: true } })
        .select('unitDetails')
        .lean();
      const unitIdMatches = (propsForUnits || []).flatMap((p) =>
        (p.unitDetails || [])
          .filter((u) => u?.unitName && q.test(String(u.unitName)))
          .map((u) => u._id)
      );
      if (unitIdMatches.length > 0) {
        orConds.push({ unitId: { $in: unitIdMatches } });
      }
    }
    if (!filter.$and) {
      filter.$and = [];
    }
    filter.$and.push({ $or: orConds });
  }

  const { offset, limit, page } = getPagination({ page: pageNumber, pageSize });

  // Determine sorting: default to ascending by dueDate
  let sort = { dueDate: 1 };
  if (query.sortBy) {
    const dir = String(query.sortOrder || 'asc').toLowerCase() === 'desc' ? -1 : 1;
    const sortFieldMap = {
      dueDate: 'dueDate',
      expenseDate: 'expenseDate',
      createdAt: 'createdAt',
      amount: 'total'
    };
    const field = sortFieldMap[query.sortBy] || query.sortBy;
    sort = { [field]: dir };
  }

  const [data, total] = await Promise.all([
    Expense.find(filter)
      .populate('property', 'name address unitDetails')
      .populate('expenseItems.fileDocument.metadataId')
      .sort(sort)
      .skip(offset)
      .limit(limit || 0),
    Expense.countDocuments(filter)
  ]);

  // Calculate owner summary for the same filtered result set as the list query.
  let landlordSummary = {
    totalThisMonth: 0,
    monthlyChange: 0,
    paid: 0,
    unpaid: 0,
    overdue: 0,
    pending: 0,
    totalExpense: 0,
    collectionRate: 0,
    collectionStats: {},
  };
  if (createdBy) {
    try {
      const summaryExpenses = await Expense.find(filter)
        .select('total status dueDate')
        .lean();
      const now = ClockService.now();
      let paid = 0;
      let unpaid = 0;
      let overdue = 0;
      let pending = 0;
      let totalExpense = 0;

      summaryExpenses.forEach((exp) => {
        const amount = exp.total || 0;
        totalExpense += amount;
        const isOverdue =
          exp.dueDate &&
          DateUtil.toUTC(exp.dueDate) < now &&
          exp.status !== EXPENSE_STATUS.PAID &&
          exp.status !== EXPENSE_STATUS.PARTIALLY_PAID;

        if (isOverdue) {
          overdue += amount;
        } else if (exp.status === EXPENSE_STATUS.PAID) {
          paid += amount;
        } else if (exp.status === EXPENSE_STATUS.PARTIALLY_PAID) {
          unpaid += amount;
        } else if (exp.status === EXPENSE_STATUS.PENDING) {
          pending += amount;
        }
      });

      const collectionRate = totalExpense > 0 ? Math.round((paid / totalExpense) * 100) : 0;
      landlordSummary = {
        totalThisMonth: totalExpense,
        monthlyChange: 0,
        paid,
        unpaid,
        overdue,
        pending,
        totalExpense,
        collectionRate,
        collectionStats: { overallChangePercentage: 0 },
      };
    } catch (error) {
      logger.error('Error calculating landlord summary:', error);
    }
  }

  return { data: data.map((e) => toExpenseResponse(e)), total, page, pageSize: limit, landlordSummary };
}

async function getExpenseById(id) {
  const safeId = toObjectId(id);
  if (!safeId) throw new NotFoundError('Expense not found');
  const expense = await Expense.findOne({ _id: safeId, isDeleted: { $ne: true } })
    .populate('property', 'name address unitDetails')
    .populate('expenseItems.fileDocument.metadataId');
  if (!expense) throw new NotFoundError('Expense not found');

  // Always expose `notes` in API JSON (empty array when none)
  if (expense.notes == null) {
    expense.set('notes', []);
  }

  // Manually populate notes.createdBy for nested array
  if (expense.notes && expense.notes.length > 0) {
    expense.notes = await Promise.all(
      expense.notes.map(async (note) => {
        const plain = note && typeof note.toObject === 'function' ? note.toObject() : { ...note };
        if (plain.createdBy) {
          const safeCreatedBy = toObjectId(plain.createdBy);
          const user = safeCreatedBy ? await User.findOne({ _id: safeCreatedBy, isDeleted: { $ne: true } }).select('name email') : null;
          return { ...plain, createdBy: user };
        }
        return plain;
      })
    );
  }
  
  return toExpenseResponse(expense);
}

async function updateExpenseInSession(id, updates, options, session) {
  const patch = { ...updates };
  const rawFiles = options.files || [];
  const files = rawFiles.filter((f) => f && (f.size || 0) > 0 && f.path);
  const uploadedBy = options.uploadedBy || options.userId;
  const itemIndices = parseExpenseItemIndices(options.itemIndices);

  if (patch.status) {
    logger.warn(
      '⚠️ Frontend attempted to update expense status - ignoring for security. Use dedicated endpoints (markAsPaid, etc) to change status.'
    );
    delete patch.status;
  }

  if (patch.property) {
    const safePatchPropId = toObjectId(patch.property);
    if (!safePatchPropId) throw new Error('Invalid property ID');
    const property = await Property.findOne({ _id: safePatchPropId, isDeleted: { $ne: true } }).lean();
    if (!property) {
      throw new Error('Property not found');
    }
    patch.property = safePatchPropId;
  }

  if (patch.expenseItems) {
    sanitizePlainExpenseItemsFileDocuments(patch.expenseItems);
  }

  if (
    patch.property ||
    patch.unitId ||
    (patch.unit != null && String(patch.unit).trim() !== '')
  ) {
    const safeUpdateId = toObjectId(id);
    if (!safeUpdateId) throw new NotFoundError('Expense not found');
    const existingExpense = await applySession(
      Expense.findOne({ _id: safeUpdateId, isDeleted: { $ne: true } }).select('property unit unitId'),
      session
    ).lean();
    if (!existingExpense) {
      throw new NotFoundError('Expense not found');
    }
    const propertyId = patch.property || existingExpense.property;
    const requestedUnitId = patch.unitId || existingExpense.unitId;
    const requestedUnitName =
      patch.unit != null && String(patch.unit).trim() !== ''
        ? patch.unit
        : existingExpense.unit;

    if (propertyId && (requestedUnitId || (requestedUnitName && String(requestedUnitName).trim() !== ''))) {
      const resolved = await resolveUnitForPropertyId(propertyId, {
        unitId: requestedUnitId,
        unitName: requestedUnitName,
      });
      patch.unitId = resolved.unitId;
    }
  }

  const safeExpenseId = toObjectId(id);
  if (!safeExpenseId) throw new NotFoundError('Expense not found');
  const expense = await applySession(Expense.findOne({ _id: safeExpenseId, isDeleted: { $ne: true } }), session);
  if (!expense) {
    throw new NotFoundError('Expense not found');
  }

  if (files.length > 0 && itemIndices.length === 0) {
    logger.warn('Files received without itemIndices; skipping document upload to avoid bad linkage');
  }

  const { expenseItems: incItems, ...restUpdates } = patch;
  Object.assign(expense, restUpdates);

  if (incItems && Array.isArray(incItems)) {
    const existingItems = (expense.expenseItems || []).map((e) => (e.toObject ? e.toObject() : e));
    expense.expenseItems = incItems.map((it, idx) => mergeExpenseItemWithExisting(it, idx, existingItems));
    sanitizePlainExpenseItemsFileDocuments(expense.expenseItems);
  }

  if (files.length > 0 && itemIndices.length > 0) {
    const createdMetas = await docManager.uploadAndCreateMetadata(files, {
      documentType: 'expense',
      userId: uploadedBy,
      session,
    });
    attachFileMetasToExpenseItems(expense, createdMetas, itemIndices);
  }

  await expense.save({ session });
  return expense;
}

async function updateExpense(id, updates, options = {}) {
  await withExpenseTransaction((session) => updateExpenseInSession(id, updates, options, session), options);
  const updatedExpense = await hydrateExpenseLean(id);
  return toExpenseResponse(updatedExpense);
}

async function deleteExpenseInSession(id, session) {
  const safeId = toObjectId(id);
  if (!safeId) throw new NotFoundError('Expense not found');
  const opts = { new: true };
  if (session) opts.session = session;

  const e = await Expense.findOneAndUpdate(
    { _id: safeId, isDeleted: { $ne: true } },
    { $set: { isDeleted: true } },
    opts
  );
  if (!e) throw new NotFoundError('Expense not found');
  return true;
}

async function deleteExpense(id, options = {}) {
  return withExpenseTransaction((session) => deleteExpenseInSession(id, session), options);
}

async function uploadExpenseItemDocumentInSession(expenseId, itemId, files, options, session) {
  const safeExpenseId = toObjectId(expenseId);
  if (!safeExpenseId) throw new NotFoundError('Expense not found');
  const safeItemId = toObjectId(itemId);
  if (!safeItemId) throw new NotFoundError('Expense item not found');
  const createdMetas = await docManager.uploadAndCreateMetadata(files, {
    documentType: 'expense',
    userId: options.uploadedBy,
    session,
  });

  const fileDocument = {
    metadataId: createdMetas[0]._id,
    originalName: createdMetas[0].originalName || createdMetas[0].key,
    uploadedAt: ClockService.now(),
  };

  const updated = await Expense.findOneAndUpdate(
    { _id: safeExpenseId, 'expenseItems._id': safeItemId, isDeleted: { $ne: true } },
    { $set: { 'expenseItems.$.fileDocument': fileDocument } },
    { new: true, session }
  )
    .populate('property', 'name address')
    .populate('expenseItems.fileDocument.metadataId');

  if (!updated) {
    throw new NotFoundError('Expense or expense item not found');
  }
  return updated;
}

async function uploadExpenseItemDocument(expenseId, itemId, files = [], options = {}) {
  if (!files || files.length === 0) {
    return getExpenseById(expenseId);
  }

  const updated = await withExpenseTransaction(
    (session) => uploadExpenseItemDocumentInSession(expenseId, itemId, files, options, session),
    options
  );
  return toExpenseResponse(updated);
}

async function addNoteInSession(expenseId, text, userId, session) {
  const safeExpenseId = toObjectId(expenseId);
  if (!safeExpenseId) throw new NotFoundError('Expense not found');
  const t = text != null ? String(text).trim() : '';
  if (!t) {
    const err = new Error('Note text is required');
    err.status = 400;
    throw err;
  }

  const noteDoc = {
    text: t,
    createdAt: ClockService.now(),
  };
  if (userId && mongoose.Types.ObjectId.isValid(String(userId))) {
    noteDoc.createdBy = new mongoose.Types.ObjectId(String(userId));
  }

  const updateOpts = { new: true, runValidators: true };
  if (session) updateOpts.session = session;

  const updated = await Expense.findOneAndUpdate(
    { _id: safeExpenseId, isDeleted: { $ne: true } },
    { $push: { notes: noteDoc } },
    updateOpts
  );
  if (!updated) {
    throw new NotFoundError('Expense not found');
  }
  if (!Array.isArray(updated.notes) || updated.notes.length === 0) {
    const err = new Error(
      'Failed to persist expense note; check LandlordExpense model and expenses collection'
    );
    err.status = 500;
    throw err;
  }
}

async function addNote(expenseId, text, userId, options = {}) {
  await withExpenseTransaction((session) => addNoteInSession(expenseId, text, userId, session), options);
  return getExpenseById(expenseId);
}

async function markAsPaidInSession(expenseId, options, session) {
  const safeExpenseId = toObjectId(expenseId);
  if (!safeExpenseId) throw new NotFoundError('Expense not found');
  const { comment, userId } = options || {};
  const expense = await applySession(Expense.findOne({ _id: safeExpenseId, isDeleted: { $ne: true } }), session);
  if (!expense) throw new NotFoundError('Expense not found');

  expense.status = EXPENSE_STATUS.PAID;
  expense.paymentDate = ClockService.now();
  if (comment && String(comment).trim()) {
    if (!Array.isArray(expense.comments)) {
      expense.comments = [];
    }
    expense.comments.push({
      text: String(comment).trim(),
      createdBy: userId || undefined,
      createdAt: ClockService.now(),
    });
  }
  return expense.save({ session });
}

async function markAsPaid(expenseId, options = {}) {
  const saved = await withExpenseTransaction(
    (session) => markAsPaidInSession(expenseId, options, session),
    options
  );
  return saved;
}

/**
 * merge Expense Scope From Actor
 *
 * Performs logic operations for mergeExpenseScopeFromActor.
 *
 * @param payload - Request/input argument
 * @param actorId - Request/input argument
 * @returns Operations result
 */
function mergeExpenseScopeFromActor(payload = {}, actorId) {
  return Object.assign({}, payload, {
    createdBy: resolveCreatedBy(payload, actorId),
  });
}

/**
 * normalize List Query
 *
 * Performs logic operations for normalizeListQuery.
 *
 * @param query - Request/input argument
 * @param actorId - Request/input argument
 * @returns Operations result
 */
function normalizeListQuery(query = {}, actorId) {
  const rawPageNumber = typeof query.pageNumber !== 'undefined' ? query.pageNumber : query.page;
  const parsedPageNumber = rawPageNumber ? parseInt(rawPageNumber, 10) : undefined;
  const parsedPageSize = query.pageSize ? parseInt(query.pageSize, 10) : undefined;
  return mergeExpenseScopeFromActor(
    Object.assign({}, query, {
      pageNumber: parsedPageNumber,
      pageSize: parsedPageSize,
    }),
    actorId
  );
}

module.exports = {
  createExpense,
  listExpenses,
  getExpenseById,
  updateExpense,
  deleteExpense,
  uploadExpenseItemDocument,
  addNote,
  markAsPaid,
  mergeExpenseScopeFromActor,
  normalizeListQuery,
  parseExpenseItemIndices,
  withExpenseTransaction,
};
