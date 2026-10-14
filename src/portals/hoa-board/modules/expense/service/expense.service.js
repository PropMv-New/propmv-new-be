/**
 * ------------------------------------------------------------------
 * File: expense.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * expense.controller
 * ------------------------------------------------------------------
 */
const mongoose = require('mongoose');
const Expense = require('../model/expense.model');
const Property = require('../../property/model/property.model');
const DocumentManager = require('../../../../../shared/modules/documents/service/documentManager');
const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
const User = require('../../../../../shared/modules/users/models/user.model');
const logger = require('../../../../../common/logger');
const { resolveUnitForPropertyId } = require('../../../../../common/helpers/propertyUnitReference');
const { getPagination } = require('../../../../../common/helpers/paginationHelper');
const { applyHOADataFilter, buildHoaBoardPropertyMatch } = require('../../../../../middleware/hoaDataIsolation');
const { resolveHoaPropertyIds, getCachedHoaPropertyIds } = require('../../../../../common/helpers/hoaPropertyScope');
const { logActivity } = require('../../dashboard/service/activity.service');
const { EXPENSE_STATUS } = require('../../../../../common/constants/expense');
const ledgerService = require('../../owners/services/ledger.service');
const { timedQuery } = require('../../../../../common/helpers/queryProfiler');
const { ClockService, DateUtil } = require('../../../../../common/date');
const {
  getDateKeyInTimeZone,
  parseDateOnlyToNoonUtc,
  parseAppYmd,
  lastDayOfAppMonth,
  getEndOfDayInAppTimezone,
} = require('../../../../../common/helpers/hoaBillingDates');
const {
  notifyExpenseCreatedInAppInBackground,
  notifyExpenseUpdatedInAppInBackground,
  notifyExpensePaidInAppInBackground,
  notifyExpenseDeletedInAppInBackground,
} = require('../../../../../common/helpers/hoaInAppNotify.helper');
const { allocateUniqueExpenseId } = require('../helpers/expenseId.helper');
const { assertHoaDocumentUploadSize } = require('../../../../../shared/modules/documents/helpers/hoaDocumentUploadLimits');
const {
  extractVendorPayeeFromPayload,
  sanitizePayeesForPersist,
  linkVendorPayeeAfterExpenseSave,
} = require('../helpers/expenseVendorPayee.helper');

const docManager = new DocumentManager();

function toObjectId(value) {
  const str = String(
    value && typeof value === 'object' && value._id ? value._id : value ?? ''
  ).trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function toObjectIdArray(values) {
  if (!Array.isArray(values)) return [];
  return values.map(toObjectId).filter(Boolean);
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
 * expense Summary Group Stage
 *
 * Performs logic operations for expenseSummaryGroupStage.
 *
 * @param asOfDate - Request/input argument
 * @returns Operations result
 */
function expenseSummaryGroupStage(asOfDate) {
  return {
    $group: {
      _id: null,
      totalThisMonth: { $sum: { $ifNull: ['$total', 0] } },
      totalExpense: { $sum: { $ifNull: ['$total', 0] } },
      paid: {
        $sum: {
          $cond: [
            { $eq: ['$status', EXPENSE_STATUS.PAID] },
            { $ifNull: ['$total', 0] },
            0,
          ],
        },
      },
      partial: {
        $sum: {
          $cond: [
            { $eq: ['$status', EXPENSE_STATUS.PARTIALLY_PAID] },
            { $ifNull: ['$total', 0] },
            0,
          ],
        },
      },
      unpaid: {
        $sum: {
          $cond: [
            {
              $and: [
                { $eq: ['$status', EXPENSE_STATUS.PENDING] },
                {
                  $not: {
                    $and: [
                      { $ne: ['$dueDate', null] },
                      { $lt: ['$dueDate', asOfDate] },
                    ],
                  },
                },
              ],
            },
            { $ifNull: ['$total', 0] },
            0,
          ],
        },
      },
      overdue: {
        $sum: {
          $cond: [
            {
              $and: [
                { $ne: ['$status', EXPENSE_STATUS.PAID] },
                { $ne: ['$status', EXPENSE_STATUS.PARTIALLY_PAID] },
                { $ne: ['$dueDate', null] },
                { $lt: ['$dueDate', asOfDate] },
              ],
            },
            { $ifNull: ['$total', 0] },
            0,
          ],
        },
      },
    },
  };
}

/**
 * parse List Date Boundary
 *
 * Performs logic operations for parseListDateBoundary.
 *
 * @param value - Request/input argument
 * @param endOfDay - Request/input argument
 * @returns Operations result
 */
function parseListDateBoundary(value, endOfDay = false) {
  if (!value) return null;
  // Inclusive calendar bounds: YYYY-MM-DD and Joi UTC-midnight Dates map to the same day
  // so year_to_date / custom ranges include the selected end date (today).
  return endOfDay
    ? DateUtil.endOfDayEST(value)
    : DateUtil.startOfDayEST(value);
}

function ymdStart(year, month1) {
  return `${year}-${String(month1).padStart(2, '0')}-01`;
}

function periodEndFromStartYmd(startYmd, monthCount) {
  const start = parseAppYmd(startYmd);
  if (!start) return null;
  let endMonth = start.m + monthCount - 1;
  let endYear = start.y;
  while (endMonth > 12) {
    endMonth -= 12;
    endYear += 1;
  }
  const lastDay = lastDayOfAppMonth(endYear, endMonth);
  return getEndOfDayInAppTimezone(`${endYear}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`);
}

function buildExpenseSummaryPeriodRanges(timePeriod, now = ClockService.now()) {
  const todayKey = getDateKeyInTimeZone(now);
  const p = parseAppYmd(todayKey);
  const monthFallback = () => {
    const currentPeriodStart = DateUtil.startOfMonthEST(now);
    const currentPeriodEnd = DateUtil.endOfMonthEST(now);
    const lastMonthAnchor = DateUtil.addDays(currentPeriodStart, -1);
    return {
      currentPeriodStart,
      currentPeriodEnd,
      lastPeriodStart: DateUtil.startOfMonthEST(lastMonthAnchor),
      lastPeriodEnd: DateUtil.endOfMonthEST(lastMonthAnchor),
    };
  };
  if (!p) return monthFallback();

  const currentYear = p.y;
  const currentMonth0 = p.m - 1;

  if (timePeriod === 'quarter') {
    const currentQuarter = Math.floor(currentMonth0 / 3);
    const currentStartYmd = ymdStart(currentYear, currentQuarter * 3 + 1);
    const lastQuarter = currentQuarter === 0 ? 3 : currentQuarter - 1;
    const lastQuarterYear = currentQuarter === 0 ? currentYear - 1 : currentYear;
    const lastStartYmd = ymdStart(lastQuarterYear, lastQuarter * 3 + 1);
    return {
      currentPeriodStart: parseDateOnlyToNoonUtc(currentStartYmd),
      currentPeriodEnd: periodEndFromStartYmd(currentStartYmd, 3),
      lastPeriodStart: parseDateOnlyToNoonUtc(lastStartYmd),
      lastPeriodEnd: periodEndFromStartYmd(lastStartYmd, 3),
    };
  }

  if (timePeriod === 'half-year') {
    const currentHalf = currentMonth0 < 6 ? 0 : 1;
    const currentStartYmd = ymdStart(currentYear, currentHalf * 6 + 1);
    const lastHalf = currentHalf === 0 ? 1 : 0;
    const lastHalfYear = currentHalf === 0 ? currentYear - 1 : currentYear;
    const lastStartYmd = ymdStart(lastHalfYear, lastHalf * 6 + 1);
    return {
      currentPeriodStart: parseDateOnlyToNoonUtc(currentStartYmd),
      currentPeriodEnd: periodEndFromStartYmd(currentStartYmd, 6),
      lastPeriodStart: parseDateOnlyToNoonUtc(lastStartYmd),
      lastPeriodEnd: periodEndFromStartYmd(lastStartYmd, 6),
    };
  }

  if (timePeriod === 'year') {
    const currentStartYmd = ymdStart(currentYear, 1);
    const lastStartYmd = ymdStart(currentYear - 1, 1);
    return {
      currentPeriodStart: parseDateOnlyToNoonUtc(currentStartYmd),
      currentPeriodEnd: getEndOfDayInAppTimezone(`${currentYear}-12-31`),
      lastPeriodStart: parseDateOnlyToNoonUtc(lastStartYmd),
      lastPeriodEnd: getEndOfDayInAppTimezone(`${currentYear - 1}-12-31`),
    };
  }

  return monthFallback();
}

async function buildExpensePeriodSummary(landlordPropIds, userContext, periodRanges) {
  const {
    currentPeriodStart,
    currentPeriodEnd,
    lastPeriodStart,
    lastPeriodEnd,
  } = periodRanges;
  const now = ClockService.now();

  let baseMatch;
  if (userContext?.isHOABoardMember) {
    baseMatch = applyHOADataFilter({ isDeleted: { $ne: true } }, userContext);
  } else {
    const propertyScopeOr = [];
    if (landlordPropIds && landlordPropIds.length > 0) {
      propertyScopeOr.push({ property: { $in: landlordPropIds } });
    }
    propertyScopeOr.push({
      $or: [{ property: null }, { property: { $exists: false } }, { property: '' }],
    });
    baseMatch = applyHOADataFilter({
      isDeleted: { $ne: true },
      ...(propertyScopeOr.length === 1 ? propertyScopeOr[0] : { $or: propertyScopeOr }),
    }, userContext);
  }

  const emptySummary = {
    totalThisMonth: 0,
    monthlyChange: 0,
    paid: 0,
    unpaid: 0,
    overdue: 0,
    partial: 0,
    totalExpense: 0,
    collectionStats: { overallChangePercentage: 0 },
  };

  if (baseMatch.property && baseMatch.property.$in) {
    baseMatch.property = { $in: toObjectIdArray(baseMatch.property.$in) };
  }

  const [facetResult] = await Expense.aggregate([
    { $match: baseMatch },
    { $project: { total: 1, status: 1, dueDate: 1, expenseDate: 1 } },
    {
      $facet: {
        currentPeriod: [
          { $match: { expenseDate: { $gte: currentPeriodStart, $lte: currentPeriodEnd } } },
          expenseSummaryGroupStage(now),
        ],
        lastPeriod: [
          { $match: { expenseDate: { $gte: lastPeriodStart, $lte: lastPeriodEnd } } },
          expenseSummaryGroupStage(lastPeriodEnd),
        ],
      },
    },
  ]);

  const current = facetResult?.currentPeriod?.[0] || {};
  const last = facetResult?.lastPeriod?.[0] || {};

  const totalThisMonth = current.totalThisMonth || 0;
  const totalLastMonth = last.totalThisMonth || 0;
  const monthlyChange = totalLastMonth > 0
    ? Math.round(((totalThisMonth - totalLastMonth) / totalLastMonth) * 100)
    : 0;

  return {
    totalThisMonth,
    monthlyChange,
    paid: current.paid || 0,
    unpaid: current.unpaid || 0,
    overdue: current.overdue || 0,
    partial: current.partial || 0,
    totalExpense: current.totalExpense || 0,
    collectionStats: { overallChangePercentage: monthlyChange },
  };
}

async function createExpense(data, options = {}) {
  const userId = options.userId;
  const userContext = options.userContext || null;
  const files = options.files || [];

  if (userId) data.createdBy = new mongoose.Types.ObjectId(userId);
  if (userContext?.isHOABoardMember && userId) {
    data.hoaBoardMemberId = new mongoose.Types.ObjectId(userId);
    if (userContext.hoaId) data.hoaId = new mongoose.Types.ObjectId(userContext.hoaId);
  } else if (userContext?.hoaId) {
    data.hoaId = new mongoose.Types.ObjectId(userContext.hoaId);
  }

  if (!data.property || data.property === '') {
    delete data.property;
    delete data.unit;
    delete data.unitId;
  }

  // Create-time paid intent: explicit markAsPaid flag (or legacy status=paid).
  // Do not trust arbitrary status values from the client.
  const markAsPaidOnCreate =
    data.markAsPaid === true
    || data.markAsPaid === 'true'
    || String(data.status || '').toLowerCase() === EXPENSE_STATUS.PAID;
  const requestedPaymentDate = data.paymentDate ? new Date(data.paymentDate) : null;
  delete data.markAsPaid;
  if (data.status) {
    delete data.status;
  }

  // Validate property exists
  if (data.property) {
    const property = await Property.findById(data.property).lean();
    if (!property) {
      throw new Error('Property not found');
    }
  }

  if (data.property && (data.unitId || (data.unit && String(data.unit).trim() !== ''))) {
    const resolved = await resolveUnitForPropertyId(data.property, {
      unitId: data.unitId,
      unitName: data.unit,
    });
    data.unitId = resolved.unitId;
  }

  if (data.property && (data.unitId || (data.unit && String(data.unit).trim() !== ''))) {
    const resolved = await resolveUnitForPropertyId(data.property, {
      unitId: data.unitId,
      unitName: data.unit,
    });
    data.unitId = resolved.unitId;
    data.unit = resolved.unitName;
  }

  // Capture vendor payee identity before Mongoose strips unknown payee fields
  const vendorPayee = extractVendorPayeeFromPayload(data.payees);
  if (vendorPayee?.payeeId) {
    data.vendorUserId = new mongoose.Types.ObjectId(vendorPayee.payeeId);
  }
  if (Array.isArray(data.payees)) {
    data.payees = sanitizePayeesForPersist(data.payees);
  }

  const expense = new Expense(data);
  expense.expenseId = await allocateUniqueExpenseId();

  if (markAsPaidOnCreate) {
    expense.status = EXPENSE_STATUS.PAID;
    expense.paymentDate = requestedPaymentDate && !Number.isNaN(requestedPaymentDate.getTime())
      ? requestedPaymentDate
      : ClockService.now();
  } else {
    // New expenses start as PENDING unless explicitly marked paid at create time.
    expense.status = EXPENSE_STATUS.PENDING;
    expense.paymentDate = undefined;
  }

  await expense.validate();
  const saved = await expense.save();

  if (
    markAsPaidOnCreate
    && ledgerService.expenseDocIsCreditRelease(saved)
    && saved.property
  ) {
    await ledgerService.ensureCreditReleaseExpenseSettledOnPaid(
      saved.property,
      ledgerService.resolveCreditReleaseExpenseBookedAmount(saved),
      userId
    );
  }

  // Log activity
  await logActivity({
    userId,
    action: 'CREATE',
    module: 'Expense',
    entityId: saved._id,
    entityName: saved.vendorPaidTo || 'Expense',
    description: markAsPaidOnCreate
      ? `Created expense as paid for ${saved.vendorPaidTo || 'vendor'} - $${saved.total || 0}`
      : `Created expense for ${saved.vendorPaidTo || 'vendor'} - $${saved.total || 0}`,
    meta: { total: saved.total, status: saved.status, markAsPaidOnCreate: Boolean(markAsPaidOnCreate) }
  });

  notifyExpenseCreatedInAppInBackground(saved, userId);

  // Vendor payee: associate HOA, create vendor-portal invoice, notify vendor
  if (vendorPayee?.payeeId) {
    await linkVendorPayeeAfterExpenseSave(saved, vendorPayee, {
      actorId: userId,
      hoaId: saved.hoaId || userContext?.hoaId,
    });
  }

  // If files are provided, attach them to corresponding expense items
  if (files.length > 0 && saved.expenseItems.length > 0) {
    assertHoaDocumentUploadSize(files);
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      // Upload files and create metadata
      const createdMetas = await docManager.uploadAndCreateMetadata(files, {
        documentType: 'expense-receipts',
        ownerId: userId,
        session
      });

      // Attach files to expense items (first file to first item, etc.)
      for (let i = 0; i < Math.min(createdMetas.length, saved.expenseItems.length); i++) {
        const fileDocument = {
          metadataId: createdMetas[i]._id,
          originalName: createdMetas[i].originalName || createdMetas[i].key,
          uploadedAt: ClockService.now()
        };

        saved.expenseItems[i].fileDocument = fileDocument;
      }

      await saved.save({ session });
      await session.commitTransaction();
      session.endSession();
    } catch (err) {
      try { await session.abortTransaction(); } catch (e) { /* ignore */ }
      session.endSession();
      throw err;
    }
  }

  const created = await Expense.findById(saved._id)
    .populate('property', 'name address unitDetails')
    .populate('expenseItems.fileDocument.metadataId')
    .lean();
  return toExpenseResponse(created);
}

async function listExpenses(query = {}, userContext = null) {
  return timedQuery('expense.listExpenses', () => listExpensesImpl(query, userContext));
}

async function listExpensesImpl(query = {}, userContext = null) {
  const { property, landlordId, vendorPaidTo, category, status, startDate, endDate, dueStartDate, dueEndDate, paymentStartDate, paymentEndDate, pageNumber, pageSize, unit, unitId, taxableEntity, bankAccount, payee, minAmount, maxAmount, timePeriod, search, sortBy, sortOrder } = query;
  let filter = { isDeleted: { $ne: true } };
  let hoaScopedPropertyIds = null;

  // Apply HOA data isolation first
  filter = applyHOADataFilter(filter, userContext);

  const hoaPropMatch = buildHoaBoardPropertyMatch(userContext);

  // Property and landlord validation and filtering
  if (property) {
    const safePropertyId = toObjectId(property);
    if (!safePropertyId) {
      return { data: [], total: 0, page: pageNumber || 1, pageSize: pageSize || 10, landlordSummary: { totalThisMonth: 0, monthlyChange: 0, paid: 0, unpaid: 0, overdue: 0, partial: 0, totalExpense: 0, collectionStats: {} }, hoaBoardSummary: { totalThisMonth: 0, monthlyChange: 0, paid: 0, unpaid: 0, overdue: 0, partial: 0, totalExpense: 0, collectionStats: {} } };
    }
    if (hoaPropMatch) {
      const safeHoaPropMatch = { ...hoaPropMatch };
      if (safeHoaPropMatch._id && safeHoaPropMatch._id.$in) {
        safeHoaPropMatch._id = { $in: toObjectIdArray(safeHoaPropMatch._id.$in) };
      }
      const prop = await Property.findOne({ _id: safePropertyId, ...safeHoaPropMatch }).select('_id').lean();
      if (!prop) {
        return { data: [], total: 0, page: pageNumber || 1, pageSize: pageSize || 10, landlordSummary: { totalThisMonth: 0, monthlyChange: 0, paid: 0, unpaid: 0, overdue: 0, partial: 0, totalExpense: 0, collectionStats: {} }, hoaBoardSummary: { totalThisMonth: 0, monthlyChange: 0, paid: 0, unpaid: 0, overdue: 0, partial: 0, totalExpense: 0, collectionStats: {} } };
      }
    } else if (landlordId) {
      const safeLandlordId = toObjectId(landlordId);
      if (!safeLandlordId) {
        return { data: [], total: 0, page: pageNumber || 1, pageSize: pageSize || 10, landlordSummary: { totalThisMonth: 0, monthlyChange: 0, paid: 0, unpaid: 0, overdue: 0, partial: 0, totalExpense: 0, collectionStats: {} }, hoaBoardSummary: { totalThisMonth: 0, monthlyChange: 0, paid: 0, unpaid: 0, overdue: 0, partial: 0, totalExpense: 0, collectionStats: {} } };
      }
      const prop = await Property.findOne({ _id: safePropertyId, landlord_id: safeLandlordId }).select('_id').lean();
      if (!prop) {
        return { data: [], total: 0, page: pageNumber || 1, pageSize: pageSize || 10, landlordSummary: { totalThisMonth: 0, monthlyChange: 0, paid: 0, unpaid: 0, overdue: 0, partial: 0, totalExpense: 0, collectionStats: {} }, hoaBoardSummary: { totalThisMonth: 0, monthlyChange: 0, paid: 0, unpaid: 0, overdue: 0, partial: 0, totalExpense: 0, collectionStats: {} } };
      }
    }
    filter.property = safePropertyId;
    hoaScopedPropertyIds = [safePropertyId];
  } else if (hoaPropMatch) {
    // HOA board list: applyHOADataFilter (hoaId / createdBy / hoaBoardMemberId) is the source of truth.
    // Do not require property - HOA-level expenses have no property field.
    let propIds = getCachedHoaPropertyIds(userContext);
    if (propIds == null) {
      propIds = await resolveHoaPropertyIds(userContext);
    }
    hoaScopedPropertyIds = Array.isArray(propIds) ? propIds : [];
  } else if (landlordId) {
    const safeLandlordId = toObjectId(landlordId);
    if (!safeLandlordId) {
      return { data: [], total: 0, page: pageNumber || 1, pageSize: pageSize || 10, landlordSummary: { totalThisMonth: 0, monthlyChange: 0, paid: 0, unpaid: 0, overdue: 0, partial: 0, totalExpense: 0, collectionStats: {} }, hoaBoardSummary: { totalThisMonth: 0, monthlyChange: 0, paid: 0, unpaid: 0, overdue: 0, partial: 0, totalExpense: 0, collectionStats: {} } };
    }
    const props = await Property.find({ landlord_id: safeLandlordId }).select('_id').lean();
    const propIds = (props || []).map(p => p._id);
    if (!propIds || propIds.length === 0) {
      return { data: [], total: 0, page: pageNumber || 1, pageSize: pageSize || 10, landlordSummary: { totalThisMonth: 0, monthlyChange: 0, paid: 0, unpaid: 0, overdue: 0, partial: 0, totalExpense: 0, collectionStats: {} }, hoaBoardSummary: { totalThisMonth: 0, monthlyChange: 0, paid: 0, unpaid: 0, overdue: 0, partial: 0, totalExpense: 0, collectionStats: {} } };
    }
    filter.property = { $in: propIds };
  }

  // Text-based filters
  if (vendorPaidTo) filter.vendorPaidTo = new RegExp(vendorPaidTo, 'i');
  if (unitId) filter.unitId = unitId;
  if (unit) {
    const unitRegex = new RegExp(unit, 'i');
    const scopePropIds = filter.property?.$in
      ? filter.property.$in
      : (filter.property ? [filter.property] : (hoaScopedPropertyIds || []));
    let unitIdMatches = [];
    if (scopePropIds.length > 0) {
      const propsForUnits = await Property.find({ _id: { $in: toObjectIdArray(scopePropIds) } })
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
      filter.unit = unitRegex;
    }
  }
  if (taxableEntity) filter.taxableEntity = new RegExp(taxableEntity, 'i');
  if (bankAccount) filter.bankAccount = new RegExp(bankAccount, 'i');
  if (payee) filter['payees.name'] = new RegExp(payee, 'i');

  // Category filter (search in expense items)
  if (category) {
    filter['expenseItems.category'] = new RegExp(category, 'i');
  }

  // Exact match filters
  if (status) filter.status = status;

  // Amount range filters (based on total)
  if (minAmount !== undefined || maxAmount !== undefined) {
    filter.total = {};
    if (minAmount !== undefined) filter.total.$gte = minAmount;
    if (maxAmount !== undefined) filter.total.$lte = maxAmount;
  }

  // Date range filters (YMD params are inclusive through end-of-day UTC)
  if (startDate || endDate) {
    filter.expenseDate = {};
    if (startDate) filter.expenseDate.$gte = parseListDateBoundary(startDate, false);
    if (endDate) filter.expenseDate.$lte = parseListDateBoundary(endDate, true);
  }

  if (dueStartDate || dueEndDate) {
    filter.dueDate = {};
    if (dueStartDate) filter.dueDate.$gte = parseListDateBoundary(dueStartDate, false);
    if (dueEndDate) filter.dueDate.$lte = parseListDateBoundary(dueEndDate, true);
  }

  if (paymentStartDate || paymentEndDate) {
    filter.paymentDate = {};
    if (paymentStartDate) filter.paymentDate.$gte = parseListDateBoundary(paymentStartDate, false);
    if (paymentEndDate) filter.paymentDate.$lte = parseListDateBoundary(paymentEndDate, true);
  }

  // Search filter - search by category, vendor, property name, unit
  if (search) {
    const safeSearch = escapeRegex(search);
    const matchingProperties = await Property.find({
      name: { $regex: safeSearch, $options: 'i' }
    }).select('_id').lean();
    const matchingPropertyIds = matchingProperties.map(p => p._id);

    const searchOr = [
      { 'expenseItems.category': { $regex: safeSearch, $options: 'i' } },
      { vendorPaidTo: { $regex: safeSearch, $options: 'i' } },
      { unit: { $regex: safeSearch, $options: 'i' } },
      { property: { $in: matchingPropertyIds } }
    ];
    if (hoaPropMatch) {
      searchOr.push(
        { property: null },
        { property: { $exists: false } },
        { property: '' }
      );
    } else {
      searchOr.push({ property: null }, { property: { $exists: false } });
    }
    if (!filter.$and) filter.$and = [];
    filter.$and.push({ $or: searchOr });
    const searchRegex = new RegExp(safeSearch, 'i');
    const scopePropIdsForUnits = filter.property?.$in
      ? filter.property.$in
      : (filter.property ? [filter.property] : (hoaScopedPropertyIds || []));
    if (scopePropIdsForUnits.length > 0) {
      const propsForUnits = await Property.find({ _id: { $in: toObjectIdArray(scopePropIdsForUnits) } })
        .select('unitDetails')
        .lean();
      const unitIdMatches = (propsForUnits || []).flatMap((p) =>
        (p.unitDetails || [])
          .filter((u) => u?.unitName && searchRegex.test(String(u.unitName)))
          .map((u) => u._id)
      );
      if (unitIdMatches.length > 0) {
        searchOr.push({ unitId: { $in: unitIdMatches } });
      }
    }
  }

  const { offset, limit, page } = getPagination({ page: pageNumber, pageSize });

  let expenseScopePropertyIds = null;
  if (filter.property !== undefined && filter.property !== null) {
    expenseScopePropertyIds = filter.property.$in ? filter.property.$in : [filter.property];
  } else if (hoaScopedPropertyIds) {
    expenseScopePropertyIds = hoaScopedPropertyIds;
  }

  const allowedExpenseSortFields = new Set([
    'createdAt',
    'updatedAt',
    'expenseDate',
    'dueDate',
    'paymentDate',
    'total',
    'status',
    'vendorPaidTo',
  ]);
  const expenseSortField = allowedExpenseSortFields.has(String(sortBy || ''))
    ? String(sortBy)
    : 'createdAt';
  const expenseSortDirection = String(sortOrder || 'desc').toLowerCase() === 'asc' ? 1 : -1;
  const expenseSortSpec = { [expenseSortField]: expenseSortDirection };
  if (expenseSortField !== 'createdAt') expenseSortSpec.createdAt = expenseSortDirection;
  if (expenseSortField !== '_id') expenseSortSpec._id = expenseSortDirection;

  const [data, total] = await Promise.all([
    Expense.find(filter)
      .select('-comments')
      .populate('property', 'name address unitDetails.unitName unitDetails._id')
      .sort(expenseSortSpec)
      .skip(offset)
      .limit(limit || 0)
      .lean(),
    Expense.countDocuments(filter)
  ]);

  // Landlord / HOA property scope for summary (matches list filter)
  let landlordSummary = { totalThisMonth: 0, monthlyChange: 0, paid: 0, unpaid: 0, overdue: 0, partial: 0, totalExpense: 0, collectionStats: {} };
  if (hoaPropMatch || (expenseScopePropertyIds && expenseScopePropertyIds.length > 0) || userContext?.isHOABoardMember) {
    try {
      const landlordPropIds = expenseScopePropertyIds || [];

      if (landlordPropIds.length > 0 || hoaPropMatch) {
        const now = ClockService.now();
        const {
          currentPeriodStart,
          currentPeriodEnd,
          lastPeriodStart,
          lastPeriodEnd,
        } = buildExpenseSummaryPeriodRanges(timePeriod, now);

        landlordSummary = await buildExpensePeriodSummary(landlordPropIds, userContext, {
          currentPeriodStart,
          currentPeriodEnd,
          lastPeriodStart,
          lastPeriodEnd,
        });
      }
    } catch (error) {
      logger.error('Error calculating landlord summary:', error);
    }
  }

  return { data: data.map((e) => toExpenseResponse(e)), total, page, pageSize: limit, landlordSummary, hoaBoardSummary: landlordSummary };
}

async function assertExpenseInHoaContext(expense, hoaContext) {
  if (!hoaContext?.hoaId) return;
  const activeHoaId = String(hoaContext.hoaId);
  if (expense.hoaId && String(expense.hoaId) !== activeHoaId) {
    throw new NotFoundError('Expense not found');
  }
  if (!expense.hoaId) {
    const propertyHoaId = expense.property?.hoaId;
    if (propertyHoaId && String(propertyHoaId) !== activeHoaId) {
      throw new NotFoundError('Expense not found');
    }
    if (!propertyHoaId && expense.property) {
      const propertyId = expense.property._id || expense.property;
      const property = await Property.findById(propertyId).select('hoaId').lean();
      if (property?.hoaId && String(property.hoaId) !== activeHoaId) {
        throw new NotFoundError('Expense not found');
      }
    }
  }
}

async function populateExpenseNotes(expense) {
  if (expense.notes == null) {
    expense.notes = [];
  }
  if (!Array.isArray(expense.notes) || expense.notes.length === 0) {
    return expense;
  }

  expense.notes = await Promise.all(
    expense.notes.map(async (note) => {
      const plain = note && typeof note.toObject === 'function' ? note.toObject() : { ...note };
      if (plain.createdBy) {
        const safeCreatedBy = toObjectId(plain.createdBy);
        const user = safeCreatedBy
          ? await User.findOne({ _id: safeCreatedBy, isDeleted: { $ne: true } }).select('name email').lean()
          : null;
        return { ...plain, createdBy: user };
      }
      return plain;
    })
  );
  return expense;
}

async function getExpenseById(id, options = {}) {
  const expense = await Expense.findOne({ _id: id, isDeleted: { $ne: true } })
    .populate('property', 'name address unitDetails hoaId')
    .populate('expenseItems.fileDocument.metadataId', 'key originalName contentType size')
    .lean();
  if (!expense) throw new NotFoundError('Expense not found');

  await assertExpenseInHoaContext(expense, options.hoaContext);
  await populateExpenseNotes(expense);

  return toExpenseResponse(expense);
}

async function addNote(expenseId, text, options = {}) {
  const safeExpenseId = toObjectId(expenseId);
  if (!safeExpenseId) throw new NotFoundError('Expense not found');

  const t = text != null ? String(text).trim() : '';
  if (!t) {
    const err = new Error('Note text is required');
    err.status = 400;
    throw err;
  }

  const existing = await Expense.findOne({ _id: safeExpenseId, isDeleted: { $ne: true } })
    .populate('property', 'hoaId')
    .select('_id hoaId property notes')
    .lean();
  if (!existing) throw new NotFoundError('Expense not found');
  await assertExpenseInHoaContext(existing, options.hoaContext);

  const noteDoc = {
    text: t,
    createdAt: ClockService.now(),
  };
  const userId = options.userId;
  if (userId && mongoose.Types.ObjectId.isValid(String(userId))) {
    noteDoc.createdBy = new mongoose.Types.ObjectId(String(userId));
  }

  const updated = await Expense.findOneAndUpdate(
    { _id: safeExpenseId, isDeleted: { $ne: true } },
    { $push: { notes: noteDoc } },
    { new: true, runValidators: true }
  );
  if (!updated) {
    throw new NotFoundError('Expense not found');
  }
  if (!Array.isArray(updated.notes) || updated.notes.length === 0) {
    const err = new Error('Failed to persist expense note');
    err.status = 500;
    throw err;
  }

  return getExpenseById(expenseId, { hoaContext: options.hoaContext });
}

async function updateExpense(id, updates, options = {}) {
  const files = options.files || [];

  // SECURITY: Never allow frontend to change status through regular update
  // Status can ONLY be changed through dedicated endpoints like markAsPaid()
  if (updates.status) {
    logger.warn('⚠️ Frontend attempted to update expense status - ignoring for security. Use dedicated endpoints (markAsPaid, etc) to change status.');
    delete updates.status;
  }

  // Validate property exists if being updated
  if (updates.property) {
    const property = await Property.findById(updates.property).lean();
    if (!property) {
      throw new Error('Property not found');
    }
  }

  const vendorPayeeFromUpdate = extractVendorPayeeFromPayload(updates.payees);
  if (vendorPayeeFromUpdate?.payeeId) {
    updates.vendorUserId = new mongoose.Types.ObjectId(vendorPayeeFromUpdate.payeeId);
  }
  if (Array.isArray(updates.payees)) {
    updates.payees = sanitizePayeesForPersist(updates.payees);
  }

  if (
    updates.property ||
    updates.unitId ||
    (updates.unit != null && String(updates.unit).trim() !== '')
  ) {
    const existingExpense = await Expense.findById(id).select('property unit unitId').lean();
    if (!existingExpense) throw new NotFoundError('Expense not found');

    const propertyId = updates.property || existingExpense.property;
    const requestedUnitId = updates.unitId || existingExpense.unitId;
    const requestedUnitName =
      updates.unit != null && String(updates.unit).trim() !== ''
        ? updates.unit
        : existingExpense.unit;

    if (propertyId && (requestedUnitId || (requestedUnitName && String(requestedUnitName).trim() !== ''))) {
      const resolved = await resolveUnitForPropertyId(propertyId, {
        unitId: requestedUnitId,
        unitName: requestedUnitName,
      });
      updates.unitId = resolved.unitId;
    }
  }

  if (
    updates.property ||
    updates.unitId ||
    (updates.unit != null && String(updates.unit).trim() !== '')
  ) {
    const existingExpense = await Expense.findById(id).select('property unit unitId').lean();
    if (!existingExpense) throw new NotFoundError('Expense not found');

    const propertyId = updates.property || existingExpense.property;
    const requestedUnitId = updates.unitId || existingExpense.unitId;
    const requestedUnitName =
      updates.unit != null && String(updates.unit).trim() !== ''
        ? updates.unit
        : existingExpense.unit;

    if (propertyId && (requestedUnitId || (requestedUnitName && String(requestedUnitName).trim() !== ''))) {
      const resolved = await resolveUnitForPropertyId(propertyId, {
        unitId: requestedUnitId,
        unitName: requestedUnitName,
      });
      updates.unitId = resolved.unitId;
      updates.unit = resolved.unitName;
    }
  }

  const updated = await Expense.findByIdAndUpdate(id, { $set: updates }, { new: true });
  if (!updated) throw new NotFoundError('Expense not found');

  // Recalculate total after update
  if (updated.expenseItems && updated.expenseItems.length > 0) {
    updated.total = updated.expenseItems.reduce((sum, item) => sum + (item.amount || 0), 0);
  }

  // If files are provided, attach them to corresponding expense items
  if (files.length > 0 && updated.expenseItems.length > 0) {
    assertHoaDocumentUploadSize(files);
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      // Upload files and create metadata
      const createdMetas = await docManager.uploadAndCreateMetadata(files, {
        documentType: 'expense-receipts',
        ownerId: options.uploadedBy,
        session
      });

      // Attach files to expense items (first file to first item, etc.)
      for (let i = 0; i < Math.min(createdMetas.length, updated.expenseItems.length); i++) {
        const fileDocument = {
          metadataId: createdMetas[i]._id,
          originalName: createdMetas[i].originalName || createdMetas[i].key,
          uploadedAt: ClockService.now()
        };

        updated.expenseItems[i].fileDocument = fileDocument;
      }

      await updated.save({ session });
      await session.commitTransaction();
      session.endSession();
    } catch (err) {
      try { await session.abortTransaction(); } catch (e) { /* ignore */ }
      session.endSession();
      throw err;
    }
  } else {
    await updated.save();
  }

  // Log activity
  try {
    await logActivity({
      userId: options.uploadedBy || updated.createdBy,
      action: 'UPDATE',
      module: 'Expense',
      entityId: updated._id,
      entityName: updated.vendorPaidTo || 'Expense',
      description: `Updated expense for ${updated.vendorPaidTo || 'vendor'} - $${updated.total || 0}`,
      meta: { total: updated.total, status: updated.status }
    });
  } catch (logErr) {
    logger.error('Failed to log expense update activity:', logErr);
  }

  notifyExpenseUpdatedInAppInBackground(
    updated,
    options.uploadedBy || options.userId || updated.createdBy
  );

  // Link vendor portal invoice when a Vendor payee is set, or backfill if missing
  const shouldLinkVendor =
    Boolean(vendorPayeeFromUpdate?.payeeId)
    || (updated.vendorUserId && !updated.vendorInvoiceId);
  if (shouldLinkVendor) {
    const vendorPayee = vendorPayeeFromUpdate || {
      payeeId: String(updated.vendorUserId._id || updated.vendorUserId),
    };
    await linkVendorPayeeAfterExpenseSave(updated, vendorPayee, {
      actorId: options.uploadedBy || options.userId || updated.createdBy,
      hoaId: updated.hoaId,
    });
  }

  const refreshed = await Expense.findById(updated._id)
    .populate('property', 'name address unitDetails')
    .populate('expenseItems.fileDocument.metadataId')
    .lean();
  return toExpenseResponse(refreshed);
}

async function deleteExpense(id, options = {}) {
  const e = await Expense.findById(id);
  if (!e) throw new NotFoundError('Expense not found');

  const actorUserId = options.userId || e.createdBy;
  const expenseSnapshot = e.toObject ? e.toObject() : { ...e };

  await Expense.findByIdAndDelete(id);

  await logActivity({
    userId: actorUserId,
    action: 'DELETE',
    module: 'Expense',
    entityId: e._id,
    entityName: e.vendorPaidTo || 'Expense',
    description: `Deleted expense for ${e.vendorPaidTo || 'vendor'} - $${e.total || 0}`,
    meta: { total: e.total, status: e.status }
  });

  notifyExpenseDeletedInAppInBackground(expenseSnapshot, actorUserId);

  return true;
}

// Upload document for specific expense item
async function uploadExpenseItemDocument(expenseId, itemId, files = [], options = {}) {
  if (!files || files.length === 0) return await getExpenseById(expenseId);

  assertHoaDocumentUploadSize(files);

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const createdMetas = await docManager.uploadAndCreateMetadata(files, {
      documentType: 'expense-receipts',
      ownerId: options.uploadedBy,
      session
    });

    const fileDocument = {
      metadataId: createdMetas[0]._id,
      originalName: createdMetas[0].originalName || createdMetas[0].key,
      uploadedAt: ClockService.now()
    };

    const safeExpenseId = toObjectId(expenseId);
    const safeItemId = toObjectId(itemId);
    if (!safeExpenseId || !safeItemId) throw Object.assign(new Error('Invalid expense or item ID'), { status: 400 });

    const updated = await Expense.findOneAndUpdate(
      { _id: safeExpenseId, 'expenseItems._id': safeItemId },
      { $set: { 'expenseItems.$.fileDocument': fileDocument } },
      { new: true, session }
    )
      .populate('property', 'name address unitDetails')
      .populate('expenseItems.fileDocument.metadataId', 'key originalName contentType size')
      .lean();

    await session.commitTransaction();
    session.endSession();
    return toExpenseResponse(updated);
  } catch (err) {
    try { await session.abortTransaction(); } catch (e) { /* ignore */ }
    session.endSession();
    throw err;
  }
}

module.exports = {
  createExpense,
  listExpenses,
  getExpenseById,
  updateExpense,
  deleteExpense,
  uploadExpenseItemDocument,
  addNote,
  markAsPaid
};

async function markAsPaid(id, options = {}) {
  const { comment, userId } = options;
  const safeId = toObjectId(id);
  if (!safeId) throw new NotFoundError('Expense not found');

  const expense = await Expense.findOne({ _id: safeId, isDeleted: { $ne: true } });
  if (!expense) throw new NotFoundError('Expense not found');

  expense.status = EXPENSE_STATUS.PAID;
  expense.paymentDate = ClockService.now();

  if (comment && String(comment).trim()) {
    if (!Array.isArray(expense.comments)) expense.comments = [];
    expense.comments.push({
      text: String(comment).trim(),
      createdBy: userId ? new mongoose.Types.ObjectId(String(userId)) : undefined,
      createdAt: ClockService.now(),
    });
  }

  const saved = await expense.save();

  if (ledgerService.expenseDocIsCreditRelease(saved) && saved.property) {
    await ledgerService.ensureCreditReleaseExpenseSettledOnPaid(
      saved.property,
      ledgerService.resolveCreditReleaseExpenseBookedAmount(saved),
      userId
    );
  }

  await logActivity({
    userId,
    action: 'STATUS_CHANGE',
    module: 'Expense',
    entityId: saved._id,
    entityName: saved.vendorPaidTo || 'Expense',
    description: `Marked expense as paid - $${saved.total || 0}`,
    meta: { status: EXPENSE_STATUS.PAID, total: saved.total },
  });

  notifyExpensePaidInAppInBackground(saved, userId);

  const refreshed = await Expense.findById(saved._id)
    .populate('property', 'name address unitDetails')
    .populate('expenseItems.fileDocument.metadataId')
    .lean();
  return toExpenseResponse(refreshed);
}
