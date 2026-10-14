/**
 * ------------------------------------------------------------------
 * File: invoice.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * dashboard.service, invoice.controller, lease.service, depositBankAccount.service
 * ------------------------------------------------------------------
 */
const HOASettings = require('../../hoa-settings/model/hoaSettings.model');
const Invoice = require('../model/invoice.model');
const Lease = require('../../leasing/model/lease.model');
const mongoose = require('mongoose');
const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
const s3Client = require('../../../../../integrations/s3');
const config = require('../../../../../config/default');
const fs = require('fs').promises;
const { getPagination } = require('../../../../../common/helpers/paginationHelper');
const { INVOICE_STATUS, GROUP_BY, INVOICE_TYPES, normalizeHoaInvoiceType, expandHoaFeeTypeFilter } = require('../../../../../common/constants/invoice');
const { FREQUENCY_TYPES } = require('../../../../../common/constants/lease');
const ledgerService = require('../../owners/services/ledger.service');
const { ensureLateFeeInvoicesForUnit } = require('../../owners/services/unitLateFee.service');
const Property = require('../../property/model/property.model');
const logger = require('../../../../../common/logger');
const { resolveInvoiceIdForCreate } = require('../helpers/invoiceId.helper');
const {
  resolveInvoiceUnitLabelFromProperty,
  resolveInvoiceUnitNumber,
  collectUnitFilterAliases,
  buildUnitMongoFilter,
} = require('../helpers/invoiceUnitFilter.helper');
const { composeHoaBoardSummaryFromAggRow, mapAggregateToSummaryStats } = require('../helpers/invoiceSummaryBuckets.helper');
const {
  reconcileInvoiceCreditOnAmountChange,
  formatMoney: formatCreditMoney,
} = require('../helpers/invoiceCreditReconcile.helper');
const { assertPaymentDateOnOrAfterInvoiceGeneration } = require('../../../../../common/helpers/invoicePaymentDate.helper');
const {
  reversePaymentTransactionCreditEffects,
  reverseRecordedPaymentGroup,
  previewRecordedPaymentReversal,
  releaseInvoiceCreditsBeforeDelete,
  recalculateInvoiceTotalsFromTransactions,
  recalculateInvoiceStatus,
  isDownstreamCreditApplication,
  isPriorAllocationTransaction,
  findSourcePaymentAllocationsBlockingDelete,
  buildInvoiceDeleteRestrictionError,
} = require('../helpers/invoicePaymentReversal.helper');
const { applyCreateTimeAlreadyPaid } = require('../helpers/invoiceCreateAlreadyPaid.helper');
const {
  getActiveWaivedLineItemIndices,
  applyInvoiceWaiveReversal,
  applyNonPaymentWaiveBalanceGuard,
  syncInvoiceBalanceWithActiveWaive,
} = require('../helpers/invoiceWaive.helper');
const {
  classifyPaymentTransaction,
  isElectronicPaymentTransaction,
} = require('../helpers/invoicePaymentTransactions.helper');
const { filterInvoiceTenantsToCurrentOwners } = require('../helpers/invoiceOpenPayers.helper');
const { hydrateInvoicePayers } = require('../helpers/invoicePayerHydration.helper');
const { resolveHoaActiveDepositBank } = require('../../hoa/helpers/hoaOnboardingStatus.helper');
const {
  hasActiveProcessingPayment,
  sumProcessingAmount,
} = require('../helpers/invoiceProcessingPayment.helper');
const {
  markInvoiceSkipAutoCredit,
  clearInvoiceSkipAutoCredit,
} = require('../helpers/invoiceAutoCredit.helper');
const LedgerEntry = require('../../owners/models/ledgerEntry.model');
const {
  isLateFeeLineItem,
  consolidateLateFeeLineItems,
  lineItemPerUnitRate,
} = require('../helpers/lateFeeLineItems.helper');
const policyTermService = require('./invoicePolicyTerm.service');
const { assertHoaDocumentUploadSize } = require('../../../../../shared/modules/documents/helpers/hoaDocumentUploadLimits');
const invoiceGenerationJobService = require('./invoiceGenerationJob.service');
const { POLICY_TERM_ASYNC_THRESHOLD } = require('../constants/policyTerm');
// const Event = require('../../events/model/event.model');
const User = require('../../../../../shared/modules/users/models/user.model');
const emailHelper = require('../../../../../common/helpers/emailHelper');
const {
  buildPaymentReminderPreheader,
  sanitizePaymentReminderCustomMessage,
} = require('../../../../../common/helpers/emailDisplayHelper');
const { resolvePaymentNotificationPayload, resolveInvoiceEmailBranding, buildInvoiceEmailSubject } = require('../../../../../common/helpers/invoiceNotificationEmailHelper');
const {
  notifyInvoiceCreatedInBackground,
  notifyPaymentRecordedInBackground,
  notifyPaymentDeletedInBackground,
  notifyInvoiceBalanceWaivedInBackground,
  notifyInvoiceUpdatedInBackground,
} = require('../../../../../common/helpers/invoiceLifecycleEmail.service');
const { notify, EVENTS } = require('../../../../../common/notifications');
const { notifyInvoiceCreatedInAppInBackground, notifyInvoiceUpdatedInAppInBackground, notifyInvoiceDeletedInAppInBackground, notifyInvoiceWaivedInAppInBackground, notifyPaymentReceivedInAppInBackground, notifyPaymentDeletedInAppInBackground } = require('../../../../../common/helpers/hoaInAppNotify.helper');
const { isHOAOwnerRole } = require('../../../../../common/helpers/hoaOwnerRole');
const { ownerHasPropertyAccess } = require('../../../../../middleware/hoaOwnerPropertyAccess');
const { removeAttachmentsFromNote } = require('../../../../../common/helpers/noteAttachmentUpdates');
const { logEntityNoteActivity } = require('../../../../../common/services/entityNoteActivity.service');
const documentsService = require('../../../../../shared/modules/documents/service/documents.service');
const { logActivity } = require('../../dashboard/service/activity.service');
const { applyHOADataFilter, buildHoaBoardPropertyMatch } = require('../../../../../middleware/hoaDataIsolation');
const { resolveHoaPropertyIds, resolveHoaOwnerInvoicePropertyIds } = require('../../../../../common/helpers/hoaPropertyScope');
const { ClockService, DateUtil } = require('../../../../../common/date');
const {
  APP_TIMEZONE,
  getDateKeyInTimeZone,
  dateOnlyKeyFromStoredInstant,
  billingCalendarDateKey,
  parseDateOnlyToNoonUtc,
  normalizeDateToStartOfDay,
  getTodayAnchorInTimeZone,
  getTodayStartAndTomorrowStart,
  parsePaymentTimestamp,
  dueDateStringExprMongo,
  compareCalendarDateToToday,
  isPastDueOutstandingInvoice,
  formatDateInAppTimezone,
  formatEmailDate,
  formatMonthYearInAppTimezone,
  resolveDateRangePreset,
  isThisMonthDateRangeKeys,
  getEndOfDayInAppTimezone,
  lastDayOfAppMonth,
  parseAppYmd,
  getTodayYmdInAppTimezone,
  shiftAppYmdDays,
} = require('../../../../../common/helpers/hoaBillingDates');

/**
 * Sanitize a value to a mongoose ObjectId instance.
 * Returns null for anything that is not a valid 24-char hex ObjectId,
 * preventing NoSQL injection via operator objects (e.g. { $gt: "" }).
 */
function toObjectId(value) {
  const str = String(
    value && typeof value === 'object' && value._id ? value._id : value ?? ''
  ).trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

/**
 * HOA invoice lists are already scoped to allowed properties via propertyId / $in from buildHoaBoardPropertyMatch.
 * applyHOADataFilter() would AND an extra $or (createdBy / hoaId / landlord_id on the Invoice doc); many invoices
 * only have propertyId and are incorrectly excluded. Skip the duplicate filter when property scope is present.
 */
function applyInvoiceListHoaFilter(filter, userContext) {
  if (userContext && userContext.isHOABoardMember && filter && filter.propertyId != null) {
    return filter;
  }
  return applyHOADataFilter(filter, userContext);
}

const PAYMENT_METHOD_FILTER_ALIASES = {
  ACH: ['ACH', 'ACH Bank Transfer', 'Bank Transfer', 'bank_transfer', 'echeck', 'eCheck', 'e-check', 'E-Check'],
  Card: ['Card', 'Credit Card', 'credit_card', 'Debit Card', 'debit_card', 'card'],
  Cash: ['Cash', 'cash'],
  Check: ['Check', 'check', 'Cheque', 'Cheque Payment'],
  'Money Order': ['Money Order', 'Money Order Payment'],
};

/**
 * expand Payment Method Filter Values
 *
 * Performs logic operations for expandPaymentMethodFilterValues.
 *
 * @param parts - Request/input argument
 * @returns Operations result
 */
function expandPaymentMethodFilterValues(parts = []) {
  const expanded = new Set();
  for (const part of parts) {
    const key = String(part || '').trim();
    if (!key) continue;
    const aliases = PAYMENT_METHOD_FILTER_ALIASES[key] || [key];
    for (const alias of aliases) {
      const normalized = String(alias || '').trim();
      if (normalized) expanded.add(normalized);
    }
  }
  return [...expanded];
}

/**
 * List/export/statistics `paymentMethod` query: one value or comma-separated (e.g. "ACH,Money Order").
 * Matches invoices that have at least one payment transaction with the selected method.
 */
function applyPaymentMethodListFilter(filter, paymentMethod) {
  if (paymentMethod == null || paymentMethod === '') return;
  const raw = String(paymentMethod).trim();
  if (!raw) return;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const methods = expandPaymentMethodFilterValues(parts);
  if (methods.length === 0) return;

  const escaped = methods.map((method) => String(method).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  filter.paymentTransactions = {
    $elemMatch: {
      method: {
        $regex: `^(${escaped.join('|')})$`,
        $options: 'i',
      },
    },
  };
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

const dateOnlyRegex = /^\d{4}-\d{2}-\d{2}$/;

/**
 * append Due Date Range To Overdue Branches
 *
 * Performs logic operations for appendDueDateRangeToOverdueBranches.
 *
 * @param filter - Request/input argument
 * @param start - Request/input argument
 * @param end - Request/input argument
 * @returns Operations result
 */
function appendDueDateRangeToOverdueBranches(filter, start, end) {
  const appendDueDate = (cond) => {
    const dueDate = { ...(cond.dueDate || {}) };
    if (start) dueDate.$gte = start;
    if (end) dueDate.$lte = end;
    return { ...cond, dueDate };
  };

  if (filter.$or) {
    filter.$or = filter.$or.map(appendDueDate);
    return;
  }

  if (Array.isArray(filter.$and)) {
    filter.$and = filter.$and.map((clause) => {
      if (Array.isArray(clause?.$or)) {
        return { $or: clause.$or.map(appendDueDate) };
      }
      return clause;
    });
  }
}

/**
 * Map GET invoice list `status` query to Mongo filter fields.
 * Canonical HOA filters: Collected | Coming Due | Due | Overdue | Partially Paid | Processing | Waived (+ legacy Paid | Pending).
 *
 * Due / Overdue / Coming Due compare **calendar dates** in APP_TIMEZONE (America/New_York) so stored dueDate instants (UTC) never
 * mis-bucket same-day rows (the prior `dueDate < todayNoon` heuristic could mark "due today" invoices as overdue).
 *
 * **Overdue / Due** list filters include the same remaining-balance invoices the KPI
 * cards count (partial + processing rows split by due calendar).
 *
 * **Coming Due** (dashboard drill-down): calendar due **after today** (future only), `balanceDue > 0`, status not Paid; optional
 * start/end further constrains the calendar due key (dashboard date range).
 *
 * **Waived / Partially Paid / Processing** are amount-aware (not status-only):
 * - Waived → any `waivedAmount > 0` (partial line-item waives on mixed-status invoices)
 * - Processing → any `processingAmount > 0` (or stored Processing status)
 * - Partially Paid → remaining balance with settled cash (`alreadyPaid > 0`) only —
 *   electronic / in-flight Processing invoices are exclusive to the Processing filter
 * so drill-down lists match the KPI dollar totals without double-counting Processing rows.
 */
function applyHoaInvoiceListStatusFilter(filter, status, { startDate, endDate } = {}) {
  const todayStr = getDateKeyInTimeZone(ClockService.now());
  const dueKeyExpr = dueDateStringExprMongo();

  if (status === INVOICE_STATUS.OVERDUE) {
    filter.$or = [
      { status: INVOICE_STATUS.OVERDUE },
      {
        status: INVOICE_STATUS.PENDING,
        $expr: { $lt: [dueKeyExpr, todayStr] },
      },
      {
        status: INVOICE_STATUS.PARTIALLY_PAID,
        $expr: {
          $and: [
            { $lt: [dueKeyExpr, todayStr] },
            { $gt: [{ $ifNull: ['$balanceDue', 0] }, 0] },
          ],
        },
      },
      {
        $expr: {
          $and: [
            { $lt: [dueKeyExpr, todayStr] },
            { $gt: [{ $ifNull: ['$balanceDue', 0] }, 0] },
            {
              $or: [
                { $eq: ['$status', INVOICE_STATUS.PROCESSING] },
                { $gt: [{ $ifNull: ['$processingAmount', 0] }, 0] },
              ],
            },
          ],
        },
      },
    ];
    return;
  }

  if (status === 'Coming Due') {
    /** Future due dates only (HOA TZ). Today's dues belong on the Due Today filter. */
    const clauses = [
      { $gt: [dueKeyExpr, todayStr] },
      { $gt: [{ $ifNull: ['$balanceDue', 0] }, 0] },
      { $ne: ['$status', INVOICE_STATUS.PAID] },
      { $ne: ['$status', INVOICE_STATUS.WAIVED] },
    ];
    if (startDate && endDate && dateOnlyRegex.test(String(startDate)) && dateOnlyRegex.test(String(endDate))) {
      const s = String(startDate);
      const e = String(endDate);
      clauses.push({ $gte: [dueKeyExpr, s] });
      clauses.push({ $lte: [dueKeyExpr, e] });
    }
    filter.$expr = { $and: clauses };
    return;
  }

  if (status === 'Due') {
    /** Due Today: calendar due date equals today (HOA TZ), with remaining balance. */
    const clauses = [
      { $eq: [dueKeyExpr, todayStr] },
      { $gt: [{ $ifNull: ['$balanceDue', 0] }, 0] },
      { $ne: ['$status', INVOICE_STATUS.PAID] },
      { $ne: ['$status', INVOICE_STATUS.WAIVED] },
    ];
    if (startDate && endDate && dateOnlyRegex.test(String(startDate)) && dateOnlyRegex.test(String(endDate))) {
      const s = String(startDate);
      const e = String(endDate);
      clauses.push({ $gte: [dueKeyExpr, s] });
      clauses.push({ $lte: [dueKeyExpr, e] });
    }
    filter.$expr = { $and: clauses };
    return;
  }

  if (status === INVOICE_STATUS.PENDING) {
    filter.status = INVOICE_STATUS.PENDING;
    filter.$expr = { $gte: [dueKeyExpr, todayStr] };
    return;
  }

  if (status === 'Collected') {
    /**
     * Listing Collected: stored status Paid or Partially Paid only.
     * Never include Waived (including waive-only rows still stored as Paid with
     * alreadyPaid=0, which list as effective status Waived).
     */
    const clauses = [
      {
        $or: [
          {
            $and: [
              { $eq: ['$status', INVOICE_STATUS.PAID] },
              // Cash paid, or settled Paid with no waive (legacy alreadyPaid=0).
              // Exclude waive-only: waivedAmount > 0 && alreadyPaid <= 0.
              {
                $or: [
                  { $gt: [{ $ifNull: ['$alreadyPaid', 0] }, 0] },
                  { $lte: [{ $ifNull: ['$waivedAmount', 0] }, 0] },
                ],
              },
            ],
          },
          {
            $and: [
              { $eq: ['$status', INVOICE_STATUS.PARTIALLY_PAID] },
              { $gt: [{ $ifNull: ['$alreadyPaid', 0] }, 0] },
            ],
          },
        ],
      },
    ];
    if (startDate && endDate && dateOnlyRegex.test(String(startDate)) && dateOnlyRegex.test(String(endDate))) {
      const s = String(startDate);
      const e = String(endDate);
      clauses.push({ $gte: [dueKeyExpr, s] });
      clauses.push({ $lte: [dueKeyExpr, e] });
    }
    filter.$expr = { $and: clauses };
    return;
  }

  if (status === INVOICE_STATUS.PAID) {
    filter.status = INVOICE_STATUS.PAID;
    // Filter by dueDate (not paidOn) so owner dashboard period presets match Total Paid KPIs.
    // paidOn-only excluded invoices paid in-range whose due date was in-range but paidOn was missing/outside.
    if (startDate || endDate) {
      filter.dueDate = {};
      if (startDate) filter.dueDate.$gte = parseDueDateQueryBound(startDate);
      if (endDate) filter.dueDate.$lte = parseDueDateQueryBound(endDate, true);
    }
    return;
  }

  if (status === INVOICE_STATUS.PROCESSING) {
    // Amount-aware: any in-flight processing cash, regardless of stored status
    // (e.g. Partially Paid / Overdue rows that still have processingAmount > 0).
    filter.$or = [
      { status: INVOICE_STATUS.PROCESSING },
      { $expr: { $gt: [{ $ifNull: ['$processingAmount', 0] }, 0] } },
    ];
    return;
  }

  if (status === INVOICE_STATUS.WAIVED) {
    // Amount-aware: match Waived Amount KPI — any invoice with waived dollars
    // (partial line-item waives), not only fully-settled Waived status.
    filter.$or = [
      { status: INVOICE_STATUS.WAIVED },
      { $expr: { $gt: [{ $ifNull: ['$waivedAmount', 0] }, 0] } },
    ];
    return;
  }

  if (status === INVOICE_STATUS.PARTIALLY_PAID) {
    // Amount-aware: match Partially Paid KPI — remaining balance with settled cash
    // only. In-flight electronic payments (processingAmount / Processing status)
    // belong exclusively on the Processing filter.
    filter.$or = [
      { status: INVOICE_STATUS.PARTIALLY_PAID },
      {
        $expr: {
          $and: [
            { $gt: [{ $ifNull: ['$balanceDue', 0] }, 0] },
            { $gt: [{ $ifNull: ['$alreadyPaid', 0] }, 0] },
          ],
        },
      },
    ];
    return;
  }

  if (status) {
    filter.status = status;
  }
}

// Virtual list statuses: due window is applied inside applyHoaInvoiceListStatusFilter ($expr + calendar keys), not raw BSON dueDate bounds.
const LIST_STATUSES_WITH_BUILTIN_DUEDATE = new Set([
  INVOICE_STATUS.PAID,
  INVOICE_STATUS.PENDING,
  'Collected',
  // 'Coming Due',
  // 'Due',
]);

const EMPTY_HOA_INVOICE_SUMMARY = Object.freeze({
  collectedAmount: 0,
  outstandingAmount: 0,
  comingDueAmount: 0,
  dueTodayAmount: 0,
  overdueAmount: 0,
  /** Outstanding overdue balance due before the selected period start (prior billing periods). */
  pastOverdueAmount: 0,
  pastOverdueCount: 0,
  partiallyPaidAmount: 0,
  processingAmount: 0,
  totalInvoiceAmount: 0,
  waivedAmount: 0,
  collectionRate: 0
});

const EMPTY_INVOICE_STATUS_COUNTS = Object.freeze({
  collected: 0,
  comingDue: 0,
  due: 0,
  overdue: 0,
  partiallyPaid: 0,
  processing: 0,
  totalInvoices: 0,
});

const normalizeInvoiceDateFields = (target, fields = []) => {
  if (!target || typeof target !== 'object') return;
  fields.forEach((field) => {
    const raw = target[field];
    if (raw == null || raw === '') return;
    if (typeof raw === 'string' && dateOnlyRegex.test(raw)) {
      const parsed = parseDateOnlyToNoonUtc(raw);
      if (parsed) target[field] = parsed;
      return;
    }
    // Joi date.iso() turns YYYY-MM-DD into UTC midnight - re-anchor to noon UTC for that calendar day.
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
      const key = dateOnlyKeyFromStoredInstant(raw);
      if (key) {
        const parsed = parseDateOnlyToNoonUtc(key);
        if (parsed) target[field] = parsed;
      }
    }
  });
};

/** HOA create-invoice UI: term `12`/`24`/… = number of monthly invoices in the policy (not a lease id). */
const parseHoaPolicyTermMonths = (term) => {
  if (term == null || term === '' || term === 'one-time') return null;
  const s = String(term).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n < 1 || n > 600) return null;
  return n;
};

const roundCurrency = (value) => Number((value || 0).toFixed(2));

const isSystemInvoiceComment = (comment) => {
  if (!comment) return true;
  if (comment.isSystem === true) return true;
  const text = typeof comment === 'string' ? comment : comment.text;
  return typeof text === 'string' && /payment reminder sent/i.test(text);
};

const countUserInvoiceNotes = (comments) =>
  (comments || []).filter((c) => c && c.text && !isSystemInvoiceComment(c)).length;

const formatAddressForDisplay = (address) => {
  if (!address) return '';
  if (typeof address === 'string') return address.trim();
  if (typeof address !== 'object') return '';

  const street = address.street || address.line1 || address.addressLine1;
  const line2 = address.line2 || address.addressLine2;
  const city = address.city;
  const state = address.state;
  const zip = address.zip || address.zipCode || address.postalCode;
  const country = address.country;
  const cityStateZip = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');

  return [street, line2, cityStateZip, country].filter(Boolean).join(', ').trim();
};

const formatOwnerAddress = (owner) =>
  formatAddressForDisplay(owner?.mailingAddress) || formatAddressForDisplay(owner?.address);

const resolveInvoiceUnitName = (invoice) => {
  const resolved = resolveInvoiceUnitNumber(invoice);
  if (resolved && resolved !== 'N/A') return resolved;
  const property = invoice?.propertyId;
  return String(invoice?.unit || (property && typeof property === 'object' ? property.name : '') || '').trim();
};

/**
 * Expand a list `unit` query so it matches both unit names (system invoices)
 * and unitDetails ObjectIds (legacy/manual invoices).
 */
async function resolveUnitListFilter(unit, propertyIdFilter) {
  const unitStr = String(unit || '').trim();
  if (!unitStr) return null;

  let propertyIds = null;
  if (propertyIdFilter != null) {
    propertyIds = propertyIdFilter.$in ? propertyIdFilter.$in : [propertyIdFilter];
  }
  if (!propertyIds || propertyIds.length === 0) {
    return buildUnitMongoFilter([unitStr]);
  }

  const unitOid = toObjectId(unitStr);
  const matchOr = [
    { 'unitDetails.unitName': { $regex: `^${escapeRegexSearchTerm(unitStr)}$`, $options: 'i' } },
  ];
  if (unitOid) matchOr.push({ 'unitDetails._id': unitOid });

  const props = await Property.find({
    _id: { $in: propertyIds },
    $or: matchOr,
  }).select('unitDetails').lean();

  const aliases = collectUnitFilterAliases(unitStr, props);
  return buildUnitMongoFilter(aliases.length ? aliases : [unitStr]);
}

const resolveInvoicePropertyName = (invoice) =>
  String(invoice?.propertyName || invoice?.propertyId?.name || '').trim();

const resolveInvoiceContactAddress = (invoice) => {
  const propertyAddress = formatAddressForDisplay(invoice?.propertyId?.address);
  if (propertyAddress) return propertyAddress;

  const ownerAddresses = (invoice?.tenants || [])
    .map(formatOwnerAddress)
    .filter(Boolean);
  return ownerAddresses[0] || 'Not Available';
};

const mapInvoiceTenantForResponse = (tenant) => {
  const formattedAddress = formatOwnerAddress(tenant) || 'N/A';
  const id = tenant && typeof tenant === 'object'
    ? (tenant._id || tenant.id)
    : tenant;
  return {
    _id: id,
    firstName: tenant?.firstName,
    lastName: tenant?.lastName,
    name: `${tenant?.firstName || ''} ${tenant?.lastName || ''}`.trim() || tenant?.name || '',
    email: tenant?.email || 'N/A',
    phone: tenant?.phone || 'N/A',
    address: formattedAddress
  };
};

const mapOpenInvoiceTenantsForResponse = (invoice) =>
  filterInvoiceTenantsToCurrentOwners(invoice).map(mapInvoiceTenantForResponse);

const buildInvoiceCreationNote = ({ notesText, userId, attachmentIds = [] }) => {
  const text = String(notesText || '').trim();
  const ids = Array.isArray(attachmentIds) ? attachmentIds.filter(Boolean) : [];
  if (!text && ids.length === 0) return null;
  if (!userId) return null;
  const now = ClockService.now();
  return {
    text: text || 'Invoice created.',
    title: 'Invoice created',
    isPinned: false,
    isImportant: false,
    isSystem: false,
    createdBy: userId,
    updatedBy: userId,
    createdAt: now,
    updatedAt: now,
    attachments: ids,
  };
};

const createDocumentMetadataFromUploads = async (uploadedDocs, session = null) => {
  if (!Array.isArray(uploadedDocs) || uploadedDocs.length === 0) return [];
  const cfg = config;
  const bucketName = (cfg.s3 && cfg.s3.bucketName) || process.env.S3_BUCKET || 'mock-bucket';
  const region = (cfg.s3 && cfg.s3.region) || process.env.AWS_REGION || 'mock-region';
  const created = [];
  const createOpts = session ? { session } : {};

  for (const d of uploadedDocs) {
    const metaDocs = await DocumentMetadata.create([{
      key: d.key,
      s3Location: d.url,
      bucketName,
      region,
      size: d.size || 0,
      contentType: d.mimetype || 'application/octet-stream',
      originalName: d.originalName || d.filename,
    }], createOpts);
    created.push(metaDocs[0]);
  }
  return created;
};

const buildInvoiceDocumentsPayload = (createdMetadata, userId) =>
  createdMetadata.map((md) => ({
    metadataId: md._id,
    originalName: md.originalName,
    uploadedAt: ClockService.now(),
    uploadedBy: userId,
  }));

async function enrichInvoiceCommentsForResponse(comments) {
  if (!Array.isArray(comments)) return [];

  // Collect all attachment metadata IDs that need to be fetched
  const metaIdsToFetch = [];
  for (const comment of comments) {
    const plain = comment && typeof comment.toObject === 'function' ? comment.toObject() : { ...comment };
    for (const att of plain.attachments || []) {
      if (att && typeof att === 'object' && (att.originalName || att.key)) continue; // already populated
      const metaId = att?._id || att;
      if (metaId) metaIdsToFetch.push(String(metaId));
    }
  }

  // Batch-fetch all missing metadata in one query
  const metaById = new Map();
  if (metaIdsToFetch.length > 0) {
    const uniqueIds = [...new Set(metaIdsToFetch)];
    const metas = await DocumentMetadata.find({ _id: { $in: uniqueIds } }).lean();
    for (const m of metas) metaById.set(String(m._id), m);
  }

  // Batch-fetch presigned URLs in parallel
  const urlCache = new Map();
  const urlFetchPromises = [];
  for (const [id, meta] of metaById) {
    urlFetchPromises.push(
      documentsService.getPresignedUrl(id, 3600)
        .then((url) => urlCache.set(id, url))
        .catch(() => { })
    );
  }
  if (urlFetchPromises.length > 0) await Promise.all(urlFetchPromises);

  const enriched = [];
  for (const comment of comments) {
    const plain = comment && typeof comment.toObject === 'function'
      ? comment.toObject()
      : { ...comment };
    const rawAttachments = plain.attachments;
    if (Array.isArray(rawAttachments) && rawAttachments.length > 0) {
      const resolved = [];
      for (const att of rawAttachments) {
        let meta = null;
        if (att && typeof att === 'object' && (att.originalName || att.key)) {
          meta = att;
        } else {
          const metaId = att?._id || att;
          if (metaId) meta = metaById.get(String(metaId)) || null;
        }
        if (!meta) continue;
        const metaId = String(meta._id || meta.id);
        resolved.push({
          _id: metaId,
          originalName: meta.originalName || 'Attachment',
          contentType: meta.contentType,
          size: meta.size,
          url: urlCache.get(metaId),
        });
      }
      plain.attachments = resolved;
    }
    enriched.push(plain);
  }

  return enriched;
}

async function backfillInvoiceCreationNote(invoiceId) {
  // Use a lean projection to quickly check if backfill is needed before doing any write
  const raw = await Invoice.findById(invoiceId).select('comments documents createdBy').lean();
  if (!raw) return false;

  const hasUserNote = (raw.comments || []).some((c) => c?.text && !isSystemInvoiceComment(c));
  if (hasUserNote) return false;

  const docs = raw.documents || [];
  if (!docs.length) return false;

  const attachmentIds = docs
    .map((d) => d.metadataId)
    .filter(Boolean);

  const creationNote = buildInvoiceCreationNote({
    notesText: '',
    userId: raw.createdBy,
    attachmentIds,
  });
  if (!creationNote) return false;

  await Invoice.updateOne({ _id: invoiceId }, { $push: { comments: creationNote } });
  return true;
}

const isDerivedOverdue = (invoice) => {
  if (!invoice || invoice.status !== INVOICE_STATUS.PENDING) return false;
  const dueDateKey = billingCalendarDateKey(invoice.dueDate);
  const todayKey = getDateKeyInTimeZone(ClockService.now());
  return Boolean(dueDateKey && todayKey && dueDateKey < todayKey);
};

const getEffectiveInvoiceStatus = (invoice) => {
  if (!invoice) return INVOICE_STATUS.PENDING;
  const st = String(invoice.status || INVOICE_STATUS.PENDING);
  const processingAmount = roundCurrency(invoice.processingAmount || 0);
  const balanceDue = roundCurrency(invoice.balanceDue || 0);
  const waivedAmount = roundCurrency(invoice.waivedAmount || 0);
  const alreadyPaid = roundCurrency(invoice.alreadyPaid || 0);

  if (processingAmount > 0 || st === String(INVOICE_STATUS.PROCESSING)) {
    return INVOICE_STATUS.PROCESSING;
  }

  // Settled invoices: prefer Paid whenever any payment cleared the remainder,
  // even if one or more line items were waived (and even if status was stale Waived).
  if (balanceDue <= 0) {
    if (waivedAmount > 0 && alreadyPaid <= 0) {
      return INVOICE_STATUS.WAIVED;
    }
    if (alreadyPaid > 0 || st === String(INVOICE_STATUS.PAID)) {
      return INVOICE_STATUS.PAID;
    }
    if (waivedAmount > 0 || st === String(INVOICE_STATUS.WAIVED)) {
      return INVOICE_STATUS.WAIVED;
    }
    return INVOICE_STATUS.PAID;
  }

  if (st === String(INVOICE_STATUS.WAIVED)) return INVOICE_STATUS.WAIVED;
  if (st === String(INVOICE_STATUS.PAID)) return INVOICE_STATUS.PAID;
  // Derive Partially Paid from scalars when status was left Pending/Overdue
  // (e.g. legacy create with Already Paid before paymentTransactions were written).
  if (alreadyPaid > 0) {
    return INVOICE_STATUS.PARTIALLY_PAID;
  }
  /** Same as ledger/getBalanceSummary: `Overdue` only after the due **calendar day** has passed */
  if (st === String(INVOICE_STATUS.OVERDUE) && compareCalendarDateToToday(invoice.dueDate, ClockService.now()) >= 0) {
    return INVOICE_STATUS.PENDING;
  }
  return isDerivedOverdue(invoice) ? INVOICE_STATUS.OVERDUE : invoice.status;
};

const getEffectiveInvoiceBucket = (invoice) => {
  const effectiveStatus = getEffectiveInvoiceStatus(invoice);
  if (effectiveStatus === INVOICE_STATUS.PAID || effectiveStatus === INVOICE_STATUS.WAIVED) return 'paid';
  if (effectiveStatus === INVOICE_STATUS.OVERDUE) return 'overdue';
  if (effectiveStatus === INVOICE_STATUS.PARTIALLY_PAID) {
    const dueDateKey = billingCalendarDateKey(invoice.dueDate);
    const todayKey = getDateKeyInTimeZone(ClockService.now());
    if (dueDateKey && todayKey && dueDateKey < todayKey) return 'overdue';
    return 'upcoming';
  }
  return 'upcoming';
};

/** Lean projection for KPI / status-chip scans (avoids loading full invoice documents). */
const INVOICE_SUMMARY_PROJECTION = 'status dueDate subAmount alreadyPaid processingAmount balanceDue waivedAmount';
const INVOICE_STATUS_COUNT_PROJECTION = 'status dueDate';

/** List endpoint: only fields used by list mappers / status derivation (excludes payment history arrays). */
const INVOICE_LIST_PROJECTION = [
  '_id',
  'invoiceId',
  'propertyId',
  'propertyName',
  'unit',
  'term',
  'status',
  'dueDate',
  'paidOn',
  'subAmount',
  'alreadyPaid',
  'processingAmount',
  'balanceDue',
  'waivedAmount',
  'type',
  'generatedFrom',
  'sourceInvoiceId',
  'lateFeeRuleKey',
  'lateFeeSequence',
  'invoiceItemDetails',
  'paymentMethod',
  'createdAt',
  'depositBankAccountId',
  'depositBankAccountName',
  'balanceDepositBankAccountId',
  'balanceDepositBankAccountName',
  'depositBankLocked',
  'comments.text',
  'comments.isSystem',
  'tenants',
  'hoaId',
].join(' ');

/**
 * compute Landlord Summary From Invoices
 *
 * Performs logic operations for computeLandlordSummaryFromInvoices.
 *
 * @param allInvoices - Request/input argument
 * @returns Operations result
 */
function computeLandlordSummaryFromInvoices(allInvoices) {
  let totalInvoiceAmount = 0;
  let waivedAmountTotal = 0;
  let collectedAmount = 0;
  let outstandingAmount = 0;
  let comingDueAmount = 0;
  let dueTodayAmount = 0;
  let overdueAmount = 0;
  let partiallyPaidAmount = 0;
  let processingAmount = 0;
  const todayKey = getDateKeyInTimeZone(ClockService.now());

  for (const inv of allInvoices) {
    const subAmount = inv.subAmount || 0;
    const alreadyPaid = inv.alreadyPaid || 0;
    const balanceDue = inv.balanceDue || 0;
    const dueDateKey = billingCalendarDateKey(inv.dueDate);

    totalInvoiceAmount += subAmount;
    waivedAmountTotal += roundCurrency(inv.waivedAmount || 0);

    const effectiveStatus = getEffectiveInvoiceStatus(inv);

    if (effectiveStatus === INVOICE_STATUS.PAID) {
      // Cash collected only — waived dollars are tracked on waivedAmount, not Collected.
      collectedAmount += alreadyPaid;
    } else if (effectiveStatus === INVOICE_STATUS.PROCESSING) {
      processingAmount += inv.processingAmount || 0;
      outstandingAmount += balanceDue;
      // Processing (electronic) dollars stay on the Processing KPI only —
      // do not also count them toward Partially Paid.
      if (isPastDueOutstandingInvoice(inv)) {
        overdueAmount += balanceDue;
      } else if (dueDateKey && todayKey) {
        if (dueDateKey === todayKey) {
          dueTodayAmount += balanceDue;
        } else if (dueDateKey > todayKey) {
          comingDueAmount += balanceDue;
        }
      }
    } else if (effectiveStatus === INVOICE_STATUS.PARTIALLY_PAID) {
      collectedAmount += alreadyPaid;
      partiallyPaidAmount += alreadyPaid;
      outstandingAmount += balanceDue;
      if (dueDateKey && todayKey) {
        if (dueDateKey < todayKey) {
          overdueAmount += balanceDue;
        } else if (dueDateKey === todayKey) {
          dueTodayAmount += balanceDue;
        } else {
          comingDueAmount += balanceDue;
        }
      }
    } else if (effectiveStatus === INVOICE_STATUS.OVERDUE) {
      overdueAmount += balanceDue;
      outstandingAmount += balanceDue;
    } else if (effectiveStatus === INVOICE_STATUS.PENDING) {
      outstandingAmount += balanceDue;
      if (dueDateKey && todayKey) {
        if (dueDateKey > todayKey) {
          comingDueAmount += balanceDue;
        } else if (dueDateKey === todayKey) {
          dueTodayAmount += balanceDue;
        }
      }
    }
  }

  const collectionRate = totalInvoiceAmount > 0 ? Math.round((collectedAmount / totalInvoiceAmount) * 100) : 0;

  return {
    collectedAmount,
    outstandingAmount,
    comingDueAmount,
    dueTodayAmount,
    overdueAmount,
    partiallyPaidAmount,
    processingAmount,
    totalInvoiceAmount,
    waivedAmount: waivedAmountTotal,
    collectionRate
  };
}

/**
 * compute Status Counts From Invoices
 *
 * Performs logic operations for computeStatusCountsFromInvoices.
 *
 * @param allInvoices - Request/input argument
 * @returns Operations result
 */
function computeStatusCountsFromInvoices(allInvoices) {
  const statusCounts = { ...EMPTY_INVOICE_STATUS_COUNTS };
  const todayKeySc = getDateKeyInTimeZone(ClockService.now());

  for (const inv of allInvoices) {
    const effectiveStatus = getEffectiveInvoiceStatus(inv);
    const dueDateKey = billingCalendarDateKey(inv.dueDate);
    if (effectiveStatus === INVOICE_STATUS.PAID) statusCounts.collected++;
    else if (effectiveStatus === INVOICE_STATUS.PARTIALLY_PAID) statusCounts.partiallyPaid++;
    else if (effectiveStatus === INVOICE_STATUS.PROCESSING) statusCounts.processing++;
    else if (effectiveStatus === INVOICE_STATUS.OVERDUE) statusCounts.overdue++;
    else if (effectiveStatus === INVOICE_STATUS.PENDING && dueDateKey && todayKeySc) {
      if (dueDateKey > todayKeySc) statusCounts.comingDue++;
      else if (dueDateKey === todayKeySc) statusCounts.due++;
    }
  }

  return statusCounts;
}

/**
 * build Status Counts Filter
 *
 * Performs logic operations for buildStatusCountsFilter.
 *
 * @param invoiceScopePropertyIds - Request/input argument
 * @param options - Request/input argument
 * @param invoiceType - Request/input argument
 * @param parsedMinAmount - Request/input argument
 * @param parsedMaxAmount - Request/input argument
 * @param startDate - Request/input argument
 * @param endDate - Request/input argument
 * @param userContext - Request/input argument
 * @returns Operations result
 */
function buildStatusCountsFilter(invoiceScopePropertyIds, { unit, unitFilter, invoiceType, parsedMinAmount, parsedMaxAmount, startDate, endDate, includePastDueOutstanding }, userContext) {
  const statusFilter = {
    propertyId: { $in: invoiceScopePropertyIds },
    isDeleted: { $ne: true },
    generatedFrom: { $ne: 'late_fee' },
  };
  // Owner KPIs already pass property IDs from applyOwnerPayerInvoiceScope.
  // Do not AND tenants here — that undercounts vs board for the same units.
  if (unitFilter) statusFilter.unit = unitFilter;
  else if (unit) statusFilter.unit = unit;
  if (invoiceType) statusFilter.type = expandHoaFeeTypeFilter(invoiceType);
  if (parsedMinAmount !== undefined || parsedMaxAmount !== undefined) {
    statusFilter.subAmount = {};
    if (parsedMinAmount !== undefined) statusFilter.subAmount.$gte = parsedMinAmount;
    if (parsedMaxAmount !== undefined) statusFilter.subAmount.$lte = parsedMaxAmount;
  }
  if (includePastDueOutstanding && startDate && endDate) {
    appendOwnerThisMonthPriorOutstandingDueDateOr(statusFilter, startDate, endDate);
  } else if (startDate || endDate) {
    statusFilter.dueDate = {};
    if (startDate) statusFilter.dueDate.$gte = parseDueDateQueryBound(startDate);
    if (endDate) statusFilter.dueDate.$lte = parseDueDateQueryBound(endDate, true);
  }
  return applyInvoiceListHoaFilter(statusFilter, userContext);
}

/**
 * build Invoice Statistics From Summary Row
 *
 * Performs logic operations for buildInvoiceStatisticsFromSummaryRow.
 *
 * @param summaryRow - Request/input argument
 * @returns Operations result
 */
function buildInvoiceStatisticsFromSummaryRow(summaryRow) {
  const composed = composeHoaBoardSummaryFromAggRow(summaryRow);
  if (!composed) {
    return {
      totalInvoiceAmount: 0,
      totalOpenInvoice: 0,
      overdue: 0,
      partiallyPaid: 0,
      fullyPaid: 0,
      processingBalance: 0,
    };
  }

  return {
    totalInvoiceAmount: composed.totalInvoiceAmount,
    totalOpenInvoice: summaryRow.pendingOutstanding || 0,
    overdue: composed.overdueAmount,
    partiallyPaid: composed.partiallyPaidAmount,
    fullyPaid: summaryRow.collectedAmount || 0,
    processingBalance: composed.processingAmount,
  };
}

async function aggregateInvoiceSummaryRows(matchFilter) {
  const todayStr = getDateKeyInTimeZone(ClockService.now());
  if (!todayStr) {
    return { summaryRow: null, countsRow: null };
  }

  const dueDateKeyExpr = dueDateStringExprMongo();
  const pipeline = [
    { $match: matchFilter },
    {
      $addFields: {
        dueDateKey: dueDateKeyExpr,
        subAmountN: { $ifNull: ['$subAmount', 0] },
        alreadyPaidN: { $ifNull: ['$alreadyPaid', 0] },
        processingAmountN: { $ifNull: ['$processingAmount', 0] },
        balanceDueN: { $ifNull: ['$balanceDue', 0] },
        waivedAmountN: { $ifNull: ['$waivedAmount', 0] },
      },
    },
    {
      $addFields: {
        effectiveStatus: {
          $switch: {
            branches: [
              {
                case: {
                  $and: [
                    { $eq: ['$status', INVOICE_STATUS.OVERDUE] },
                    { $gte: ['$dueDateKey', todayStr] },
                  ],
                },
                then: INVOICE_STATUS.PENDING,
              },
              {
                case: {
                  $and: [
                    { $eq: ['$status', INVOICE_STATUS.PENDING] },
                    { $lt: ['$dueDateKey', todayStr] },
                  ],
                },
                then: INVOICE_STATUS.OVERDUE,
              },
            ],
            default: '$status',
          },
        },
      },
    },
    {
      $facet: {
        summary: [{
          $group: {
            _id: null,
            totalInvoiceAmount: { $sum: '$subAmountN' },
            waivedAmount: { $sum: '$waivedAmountN' },
            // Cash paid on Paid invoices only (not subAmount, which can include waived dollars).
            collectedAmount: {
              $sum: { $cond: [{ $eq: ['$effectiveStatus', INVOICE_STATUS.PAID] }, '$alreadyPaidN', 0] },
            },
            processingAmount: {
              $sum: {
                $cond: [{ $gt: ['$processingAmountN', 0] }, '$processingAmountN', 0],
              },
            },
            partiallyPaidCollected: {
              $sum: { $cond: [{ $eq: ['$effectiveStatus', INVOICE_STATUS.PARTIALLY_PAID] }, '$alreadyPaidN', 0] },
            },
            processingPartialCollected: {
              $sum: {
                $cond: [{
                  $and: [
                    {
                      $or: [
                        { $gt: ['$processingAmountN', 0] },
                        { $eq: ['$status', INVOICE_STATUS.PROCESSING] },
                      ],
                    },
                    { $gt: ['$balanceDueN', 0] },
                    { $ne: ['$status', INVOICE_STATUS.PAID] },
                    { $ne: ['$status', INVOICE_STATUS.WAIVED] },
                  ],
                }, '$processingAmountN', 0],
              },
            },
            partiallyPaidOverdue: {
              $sum: {
                $cond: [{
                  $and: [
                    { $eq: ['$effectiveStatus', INVOICE_STATUS.PARTIALLY_PAID] },
                    { $lt: ['$dueDateKey', todayStr] },
                  ],
                }, '$balanceDueN', 0],
              },
            },
            partiallyPaidDueToday: {
              $sum: {
                $cond: [{
                  $and: [
                    { $eq: ['$effectiveStatus', INVOICE_STATUS.PARTIALLY_PAID] },
                    { $eq: ['$dueDateKey', todayStr] },
                  ],
                }, '$balanceDueN', 0],
              },
            },
            partiallyPaidComingDue: {
              $sum: {
                $cond: [{
                  $and: [
                    { $eq: ['$effectiveStatus', INVOICE_STATUS.PARTIALLY_PAID] },
                    { $gt: ['$dueDateKey', todayStr] },
                  ],
                }, '$balanceDueN', 0],
              },
            },
            processingPastDueOverdue: {
              $sum: {
                $cond: [{
                  $and: [
                    {
                      $or: [
                        { $gt: ['$processingAmountN', 0] },
                        { $eq: ['$status', INVOICE_STATUS.PROCESSING] },
                      ],
                    },
                    { $lt: ['$dueDateKey', todayStr] },
                    { $gt: ['$balanceDueN', 0] },
                    { $ne: ['$status', INVOICE_STATUS.PAID] },
                    { $ne: ['$status', INVOICE_STATUS.WAIVED] },
                  ],
                }, '$balanceDueN', 0],
              },
            },
            processingDueToday: {
              $sum: {
                $cond: [{
                  $and: [
                    {
                      $or: [
                        { $gt: ['$processingAmountN', 0] },
                        { $eq: ['$status', INVOICE_STATUS.PROCESSING] },
                      ],
                    },
                    { $eq: ['$dueDateKey', todayStr] },
                    { $gt: ['$balanceDueN', 0] },
                    { $ne: ['$status', INVOICE_STATUS.PAID] },
                    { $ne: ['$status', INVOICE_STATUS.WAIVED] },
                  ],
                }, '$balanceDueN', 0],
              },
            },
            processingComingDue: {
              $sum: {
                $cond: [{
                  $and: [
                    {
                      $or: [
                        { $gt: ['$processingAmountN', 0] },
                        { $eq: ['$status', INVOICE_STATUS.PROCESSING] },
                      ],
                    },
                    { $gt: ['$dueDateKey', todayStr] },
                    { $gt: ['$balanceDueN', 0] },
                    { $ne: ['$status', INVOICE_STATUS.PAID] },
                    { $ne: ['$status', INVOICE_STATUS.WAIVED] },
                  ],
                }, '$balanceDueN', 0],
              },
            },
            overdueAmount: {
              $sum: { $cond: [{ $eq: ['$effectiveStatus', INVOICE_STATUS.OVERDUE] }, '$balanceDueN', 0] },
            },
            pendingFutureAmount: {
              $sum: {
                $cond: [{
                  $and: [
                    { $eq: ['$effectiveStatus', INVOICE_STATUS.PENDING] },
                    { $gt: ['$dueDateKey', todayStr] },
                  ],
                }, '$balanceDueN', 0],
              },
            },
            pendingTodayAmount: {
              $sum: {
                $cond: [{
                  $and: [
                    { $eq: ['$effectiveStatus', INVOICE_STATUS.PENDING] },
                    { $eq: ['$dueDateKey', todayStr] },
                  ],
                }, '$balanceDueN', 0],
              },
            },
            pendingOutstanding: {
              $sum: { $cond: [{ $eq: ['$effectiveStatus', INVOICE_STATUS.PENDING] }, '$balanceDueN', 0] },
            },
          },
        }],
        statusCounts: [{
          $group: {
            _id: null,
            totalInvoices: { $sum: 1 },
            collected: { $sum: { $cond: [{ $eq: ['$effectiveStatus', INVOICE_STATUS.PAID] }, 1, 0] } },
            partiallyPaid: { $sum: { $cond: [{ $eq: ['$effectiveStatus', INVOICE_STATUS.PARTIALLY_PAID] }, 1, 0] } },
            processing: { $sum: { $cond: [{ $eq: ['$effectiveStatus', INVOICE_STATUS.PROCESSING] }, 1, 0] } },
            overdue: {
              $sum: {
                $cond: [{
                  $or: [
                    { $eq: ['$effectiveStatus', INVOICE_STATUS.OVERDUE] },
                    {
                      $and: [
                        {
                          $or: [
                            { $gt: ['$processingAmountN', 0] },
                            { $eq: ['$status', INVOICE_STATUS.PROCESSING] },
                          ],
                        },
                        { $lt: ['$dueDateKey', todayStr] },
                        { $gt: ['$balanceDueN', 0] },
                      ],
                    },
                  ],
                }, 1, 0],
              },
            },
            comingDue: {
              $sum: {
                $cond: [{
                  $and: [
                    { $eq: ['$effectiveStatus', INVOICE_STATUS.PENDING] },
                    { $gt: ['$dueDateKey', todayStr] },
                  ],
                }, 1, 0],
              },
            },
            due: {
              $sum: {
                $cond: [{
                  $and: [
                    { $eq: ['$effectiveStatus', INVOICE_STATUS.PENDING] },
                    { $eq: ['$dueDateKey', todayStr] },
                  ],
                }, 1, 0],
              },
            },
          },
        }],
      },
    },
  ];

  const [result] = await Invoice.aggregate(pipeline);
  return {
    summaryRow: result?.summary?.[0] || null,
    countsRow: result?.statusCounts?.[0] || null,
  };
}

async function aggregateInvoiceStatistics(matchFilter) {
  const { summaryRow } = await aggregateInvoiceSummaryRows(matchFilter);
  return buildInvoiceStatisticsFromSummaryRow(summaryRow);
}

async function aggregateInvoiceSummaryAndCounts(matchFilter) {
  const { summaryRow, countsRow } = await aggregateInvoiceSummaryRows(matchFilter);

  const landlordSummary = composeHoaBoardSummaryFromAggRow(summaryRow);
  if (!landlordSummary) {
    return {
      landlordSummary: { ...EMPTY_HOA_INVOICE_SUMMARY },
      statusCounts: { ...EMPTY_INVOICE_STATUS_COUNTS },
    };
  }

  return {
    landlordSummary: {
      ...landlordSummary,
      pastOverdueAmount: 0,
      pastOverdueCount: 0,
    },
    statusCounts: {
      totalInvoices: countsRow?.totalInvoices || 0,
      collected: countsRow?.collected || 0,
      comingDue: countsRow?.comingDue || 0,
      due: countsRow?.due || 0,
      overdue: countsRow?.overdue || 0,
      partiallyPaid: countsRow?.partiallyPaid || 0,
      processing: countsRow?.processing || 0,
    },
  };
}

const normalizeDepositBankLabel = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, 200);
};

const getPropertyDepositBank = (propertyPopulated) => {
  if (!propertyPopulated || typeof propertyPopulated !== 'object') {
    return { id: null, name: '' };
  }
  const id = propertyPopulated.depositBankAccountId
    ? String(propertyPopulated.depositBankAccountId)
    : null;
  return {
    id,
    name: normalizeDepositBankLabel(propertyPopulated.depositBankAccountName),
  };
};

/**
 * Resolves deposit bank fields for invoice display.
 * Paid/partial invoices preserve historical bank snapshots; unpaid invoices use the unit's current bank.
 */
const resolveInvoiceDepositBankDisplay = (inv, propertyPopulated, hoaFallbackBank = null) => {
  const unitBankRaw = getPropertyDepositBank(propertyPopulated);
  const unitBank = {
    id: unitBankRaw.id || hoaFallbackBank?.id || null,
    name: unitBankRaw.name || hoaFallbackBank?.name || '',
  };
  const status = getEffectiveInvoiceStatus(inv);

  const snapshotName = normalizeDepositBankLabel(inv.depositBankAccountName);
  const snapshotId = inv.depositBankAccountId ? String(inv.depositBankAccountId) : null;
  const paidBankName = inv.depositBankLocked ? snapshotName : (snapshotName || unitBank.name);
  const paidBankId = inv.depositBankLocked ? snapshotId : (snapshotId || unitBank.id);

  if (status === INVOICE_STATUS.PAID) {
    return {
      depositBankAccountId: paidBankId || unitBank.id,
      depositBankAccountName: paidBankName || unitBank.name,
      balanceDepositBankAccountId: null,
      balanceDepositBankAccountName: '',
    };
  }

  if (status === INVOICE_STATUS.PARTIALLY_PAID) {
    const balanceName = normalizeDepositBankLabel(inv.balanceDepositBankAccountName) || unitBank.name;
    const balanceId = inv.balanceDepositBankAccountId
      ? String(inv.balanceDepositBankAccountId)
      : unitBank.id;
    return {
      depositBankAccountId: paidBankId || unitBank.id,
      depositBankAccountName: paidBankName || unitBank.name,
      balanceDepositBankAccountId: balanceId,
      balanceDepositBankAccountName: balanceName,
    };
  }

  return {
    depositBankAccountId: unitBank.id,
    depositBankAccountName: unitBank.name,
    balanceDepositBankAccountId: null,
    balanceDepositBankAccountName: '',
  };
};

const depositBankNameFromPopulatedProperty = (inv, propertyPopulated, hoaFallbackBank = null) => {
  const resolved = resolveInvoiceDepositBankDisplay(inv, propertyPopulated, hoaFallbackBank);
  if (resolved.balanceDepositBankAccountName) {
    return resolved.balanceDepositBankAccountName;
  }
  return resolved.depositBankAccountName || '';
};

const applyResolvedDepositBankToPlain = (plain, propertyPopulated, hoaFallbackBank = null) => {
  const resolved = resolveInvoiceDepositBankDisplay(plain, propertyPopulated, hoaFallbackBank);
  plain.depositBankAccountId = resolved.depositBankAccountId;
  plain.depositBankAccountName = resolved.depositBankAccountName;
  plain.balanceDepositBankAccountId = resolved.balanceDepositBankAccountId;
  plain.balanceDepositBankAccountName = resolved.balanceDepositBankAccountName;
  return plain;
};

const snapshotDepositBankFromProperty = async (propertyId) => {
  if (!propertyId) return null;
  const property = await Property.findById(propertyId)
    .select('depositBankAccountId depositBankAccountName')
    .lean();
  if (!property) return null;
  return {
    depositBankAccountId: property.depositBankAccountId,
    depositBankAccountName: normalizeDepositBankLabel(property.depositBankAccountName),
  };
};

const lockInvoiceDepositBankFromUnit = async (invoiceDoc, unitBankOverride) => {
  if (!invoiceDoc || invoiceDoc.depositBankLocked) return;
  const unitBank = unitBankOverride || await snapshotDepositBankFromProperty(invoiceDoc.propertyId);
  if (!unitBank || !unitBank.depositBankAccountId) return;
  invoiceDoc.depositBankAccountId = unitBank.depositBankAccountId;
  invoiceDoc.depositBankAccountName = unitBank.depositBankAccountName;
  invoiceDoc.depositBankLocked = true;
};

const toBankObjectId = (value) => {
  if (value == null || value === '') return undefined;
  const str = String(value);
  if (!mongoose.Types.ObjectId.isValid(str)) return undefined;
  return new mongoose.Types.ObjectId(str);
};

const appendDepositBankChangeHistory = (invoiceDoc, change, userId) => {
  if (!invoiceDoc || !change) return false;
  const prevId = change.previousBankAccountId ? String(change.previousBankAccountId) : '';
  const nextId = change.newBankAccountId ? String(change.newBankAccountId) : '';
  const prevName = normalizeDepositBankLabel(change.previousBankAccountName);
  const nextName = normalizeDepositBankLabel(change.newBankAccountName);
  if (prevId === nextId && prevName === nextName) return false;

  invoiceDoc.depositBankChangeHistory = invoiceDoc.depositBankChangeHistory || [];
  invoiceDoc.depositBankChangeHistory.push({
    previousBankAccountId: toBankObjectId(prevId),
    previousBankAccountName: prevName,
    newBankAccountId: toBankObjectId(nextId),
    newBankAccountName: nextName,
    changedBy: userId && mongoose.Types.ObjectId.isValid(String(userId))
      ? new mongoose.Types.ObjectId(String(userId))
      : undefined,
    changedAt: ClockService.now(),
  });
  return true;
};

/** Dynamic overdue label: current calendar date minus due date (app timezone). */
const calculateDaysLate = (dueDate, status) => {
  const st = String(status || '');
  if (st === INVOICE_STATUS.PAID || st === INVOICE_STATUS.WAIVED) return 'Paid';
  const todayKey = getDateKeyInTimeZone(ClockService.now());
  const dueKey = billingCalendarDateKey(dueDate);
  if (!todayKey || !dueKey) return null;
  const diffDays = DateUtil.diffDays(dueDate, ClockService.now());

  if (diffDays > 0) return `${diffDays} ${diffDays === 1 ? 'Day' : 'Days'} Late`;
  if (diffDays < 0) return `${Math.abs(diffDays)} days remaining`;
  return 'Due today';
};

const formatAuditCurrency = (value) => `$${roundCurrency(value).toFixed(2)}`;

const formatOwnerEmailChangeDate = (value) => (
  formatDateInAppTimezone(value, { month: 'long', day: 'numeric', year: 'numeric' }) || 'N/A'
);

const isInternalInvoiceChangeLine = (line) => {
  const text = String(line || '').toLowerCase();
  return text.includes('bank account')
    || text.includes('notes updated')
    || text.includes('attachment');
};

const toOwnerEmailChangeLine = (line) => String(line || '').replace(/\bchanged\b/gi, 'updated').trim();

const buildInvoiceEditChangeDescriptions = (invoice, updates, options = {}) => {
  const changes = [];
  const forOwnerEmail = Boolean(options.forOwnerEmail);
  const verb = options.ownerWording ? 'updated' : 'changed';
  const formatChangeDate = options.longDates ? formatOwnerEmailChangeDate : formatDateInAppTimezone;

  if (
    !options.skipAmountChangeLog
    && updates.subAmount !== undefined
    && roundCurrency(updates.subAmount) !== roundCurrency(invoice.subAmount)
  ) {
    changes.push(`Invoice amount ${verb} from ${formatAuditCurrency(invoice.subAmount)} to ${formatAuditCurrency(updates.subAmount)}.`);
  }

  if (updates.dueDate !== undefined) {
    const oldKey = billingCalendarDateKey(invoice.dueDate);
    const newKey = billingCalendarDateKey(updates.dueDate);
    if (oldKey !== newKey) {
      changes.push(`Due date ${verb} from ${formatChangeDate(invoice.dueDate)} to ${formatChangeDate(updates.dueDate)}.`);
    }
  }

  if (updates.startDate !== undefined) {
    const oldKey = billingCalendarDateKey(invoice.startDate);
    const newKey = billingCalendarDateKey(updates.startDate);
    if (oldKey !== newKey) {
      changes.push(`Invoice date ${verb} from ${formatChangeDate(invoice.startDate)} to ${formatChangeDate(updates.startDate)}.`);
    }
  }

  if (!forOwnerEmail) {
    const trackingBalanceBank = updates.balanceDepositBankAccountName !== undefined;
    const prevBankName = normalizeDepositBankLabel(
      trackingBalanceBank
        ? (invoice.balanceDepositBankAccountName || invoice.depositBankAccountName)
        : invoice.depositBankAccountName
    );
    const nextBankName = normalizeDepositBankLabel(
      trackingBalanceBank ? updates.balanceDepositBankAccountName : updates.depositBankAccountName
    );
    if (
      (updates.depositBankAccountName !== undefined || updates.balanceDepositBankAccountName !== undefined)
      && nextBankName
      && prevBankName !== nextBankName
    ) {
      changes.push(`Bank account changed from ${prevBankName || 'None'} to ${nextBankName}.`);
    }
  }

  if (updates.invoiceItemDetails !== undefined) {
    const oldJson = JSON.stringify(invoice.invoiceItemDetails || []);
    const newJson = JSON.stringify(updates.invoiceItemDetails || []);
    if (oldJson !== newJson) {
      changes.push(forOwnerEmail ? 'Invoice details were updated.' : 'Invoice line items updated.');
    }
  }

  if (
    !forOwnerEmail
    && updates.notes !== undefined
    && String(updates.notes || '') !== String(invoice.notes || '')
  ) {
    changes.push('Invoice notes updated.');
  }

  if (
    updates.type !== undefined
    && String(updates.type || '') !== String(invoice.type || '')
  ) {
    changes.push(`Invoice type ${verb} from ${invoice.type || 'N/A'} to ${updates.type}.`);
  }

  return changes;
};

const collectOwnerInvoiceUpdateEmailChanges = (invoice, updates, {
  hasPaymentIntent,
  bankOnlyUpdate,
  amountReconcileResult,
} = {}) => {
  if (hasPaymentIntent || bankOnlyUpdate) return [];

  const lines = buildInvoiceEditChangeDescriptions(invoice, updates, {
    skipAmountChangeLog: Boolean(amountReconcileResult),
    forOwnerEmail: true,
    ownerWording: true,
    longDates: true,
  });

  for (const extra of amountReconcileResult?.editChanges || []) {
    if (isInternalInvoiceChangeLine(extra)) continue;
    const ownerLine = toOwnerEmailChangeLine(extra);
    if (ownerLine && !lines.includes(ownerLine)) {
      lines.push(ownerLine);
    }
  }

  return lines.filter((line) => !isInternalInvoiceChangeLine(line));
};

const notifyOwnersOfAutoAppliedCredit = (appliedInvoices = [], userId, excludeInvoiceId = null) => {
  const seen = new Set();
  for (const row of appliedInvoices || []) {
    const invoiceId = row?.invoiceId || row?._id;
    if (!invoiceId) continue;
    const id = String(invoiceId);
    if (excludeInvoiceId && id === String(excludeInvoiceId)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const amount = roundCurrency(row.amount || 0);
    if (amount <= 0) continue;
    notifyInvoiceUpdatedInBackground({
      invoice: invoiceId,
      recordedByUserId: userId,
      activityIntro: `A credit of ${formatAuditCurrency(amount)} has been applied to your invoice.`,
    });
  }
};

const notifyOwnerAfterInvoiceMutation = ({
  invoice,
  userId,
  paymentDelta,
  paymentPrep,
  changeDescriptions = [],
  activityIntro = '',
} = {}) => {
  notifyInvoicePaymentEmailsInBackground({
    invoice,
    paymentDelta,
    paymentPrep,
    recordedByUserId: userId,
  });

  const hasPaymentEmail = Boolean(
    resolvePaymentNotificationPayload({ invoice, paymentDelta, paymentPrep })
  );
  if (hasPaymentEmail) return;

  const lines = Array.isArray(changeDescriptions) ? changeDescriptions.filter(Boolean) : [];
  if (!lines.length && !String(activityIntro || '').trim()) return;

  notifyInvoiceUpdatedInBackground({
    invoice,
    changeDescriptions: lines,
    activityIntro,
    recordedByUserId: userId,
  });
};

const appendInvoiceEditHistory = (invoiceDoc, updates, userId, options = {}) => {
  const changes = buildInvoiceEditChangeDescriptions(invoiceDoc, updates, options);
  if (!changes.length) return;
  invoiceDoc.editHistory = invoiceDoc.editHistory || [];
  invoiceDoc.editHistory.push({
    changes,
    editedBy: userId && mongoose.Types.ObjectId.isValid(String(userId))
      ? new mongoose.Types.ObjectId(String(userId))
      : undefined,
    editedAt: ClockService.now(),
  });
};

const recordInvoiceEditHistoryIfNeeded = (invoiceDoc, updates, userId, { hasPaymentIntent, bankOnlyUpdate, skipAmountChangeLog }) => {
  if (hasPaymentIntent || bankOnlyUpdate) return;
  appendInvoiceEditHistory(invoiceDoc, updates, userId, { skipAmountChangeLog });
};

const applyInvoiceAmountCreditReconcile = async (invoice, updates, userId, session) => {
  if (updates.subAmount === undefined || !invoice?.propertyId) return null;

  const prevSub = roundCurrency(invoice.subAmount);
  const nextSub = roundCurrency(updates.subAmount);
  if (prevSub === nextSub) return null;

  const result = await reconcileInvoiceCreditOnAmountChange({
    invoice,
    previousSubAmount: prevSub,
    newSubAmount: nextSub,
    userId,
    session,
  });
  if (!result) return null;

  invoice.alreadyPaid = result.alreadyPaid;
  invoice.balanceDue = result.balanceDue;
  invoice.subAmount = nextSub;
  if (invoice.principalSubAmount != null || updates.principalSubAmount !== undefined) {
    invoice.principalSubAmount = roundCurrency(updates.principalSubAmount ?? nextSub);
  }

  updates.alreadyPaid = result.alreadyPaid;
  updates.balanceDue = result.balanceDue;
  updates.subAmount = nextSub;
  if (updates.principalSubAmount !== undefined || invoice.principalSubAmount != null) {
    updates.principalSubAmount = roundCurrency(updates.principalSubAmount ?? nextSub);
  }

  if (result.editChanges?.length) {
    invoice.editHistory = invoice.editHistory || [];
    invoice.editHistory.push({
      changes: result.editChanges,
      editedBy: userId && mongoose.Types.ObjectId.isValid(String(userId))
        ? new mongoose.Types.ObjectId(String(userId))
        : undefined,
      editedAt: ClockService.now(),
    });
  }

  return result;
};

const logCreditBalanceAdjustmentActivity = async (userId, propertyId, propertyName, invoiceRef, reconcileResult) => {
  if (!reconcileResult?.creditReturned || reconcileResult.creditReturned <= 0) return;

  const invoiceLabel = invoiceRef.invoiceId || String(invoiceRef._id);
  await logActivity({
    userId,
    action: 'ADJUSTMENT',
    module: 'HOA Unit Balance',
    entityType: 'Property',
    entityId: propertyId,
    entityName: propertyName || 'Unit',
    description: [
      'Credit Balance Adjustment.',
      reconcileResult.previousSubAmount != null && reconcileResult.newSubAmount != null
        ? `Invoice amount was reduced from ${formatCreditMoney(reconcileResult.previousSubAmount)} to ${formatCreditMoney(reconcileResult.newSubAmount)}.`
        : `Invoice ${invoiceLabel} amount was reduced.`,
      `${formatCreditMoney(reconcileResult.creditReturned)} of previously applied credit has been returned to the owner's credit balance.`,
      reconcileResult.creditBalanceBefore != null && reconcileResult.creditBalanceAfter != null
        ? `Credit balance updated: ${formatCreditMoney(reconcileResult.creditBalanceBefore)} → ${formatCreditMoney(reconcileResult.creditBalanceAfter)}.`
        : null,
    ].filter(Boolean).join(' '),
    metadata: {
      invoiceId: String(invoiceRef._id),
      invoiceNumber: invoiceRef.invoiceId,
      creditReturned: reconcileResult.creditReturned,
      creditBalanceBefore: reconcileResult.creditBalanceBefore,
      creditBalanceAfter: reconcileResult.creditBalanceAfter,
      appliedCreditBefore: reconcileResult.appliedCreditBefore,
      appliedCreditAfter: reconcileResult.appliedCreditAfter,
      propertyId: String(propertyId),
    },
  });
};

const logDepositBankChangeForUnitInvoices = async (propertyId, change, userId, session) => {
  if (!propertyId || !change) return 0;
  let query = Invoice.find({ propertyId, isDeleted: { $ne: true } });
  if (session) query = query.session(session);
  const invoices = await query;
  let logged = 0;

  for (const inv of invoices) {
    const status = getEffectiveInvoiceStatus(inv);
    if (status === INVOICE_STATUS.PAID) continue;

    const didLog = appendDepositBankChangeHistory(inv, change, userId);
    if (!didLog) continue;

    if (status === INVOICE_STATUS.PARTIALLY_PAID) {
      inv.balanceDepositBankAccountId = toBankObjectId(change.newBankAccountId);
      inv.balanceDepositBankAccountName = normalizeDepositBankLabel(change.newBankAccountName);
    } else {
      inv.depositBankAccountId = toBankObjectId(change.newBankAccountId);
      inv.depositBankAccountName = normalizeDepositBankLabel(change.newBankAccountName);
      inv.depositBankLocked = false;
      inv.balanceDepositBankAccountId = undefined;
      inv.balanceDepositBankAccountName = '';
    }

    if (session) {
      // eslint-disable-next-line no-await-in-loop
      await inv.save({ session });
    } else {
      // eslint-disable-next-line no-await-in-loop
      await inv.save();
    }
    logged += 1;
  }

  return logged;
};

const applyDepositBankUpdatesToInvoice = (invoice, updates, userId) => {
  const hasDepositBankUpdate = updates.depositBankAccountId !== undefined
    || updates.depositBankAccountName !== undefined
    || updates.balanceDepositBankAccountId !== undefined
    || updates.balanceDepositBankAccountName !== undefined;

  if (!hasDepositBankUpdate) return;

  const effectiveStatus = getEffectiveInvoiceStatus(invoice);
  const nextBankId = toBankObjectId(
    updates.balanceDepositBankAccountId ?? updates.depositBankAccountId
  );
  const nextBankName = normalizeDepositBankLabel(
    updates.balanceDepositBankAccountName ?? updates.depositBankAccountName
  );

  if (effectiveStatus === INVOICE_STATUS.PARTIALLY_PAID) {
    appendDepositBankChangeHistory(invoice, {
      previousBankAccountId: invoice.balanceDepositBankAccountId,
      previousBankAccountName: invoice.balanceDepositBankAccountName,
      newBankAccountId: updates.balanceDepositBankAccountId ?? updates.depositBankAccountId,
      newBankAccountName: updates.balanceDepositBankAccountName ?? updates.depositBankAccountName,
    }, userId);
    if (nextBankId) invoice.balanceDepositBankAccountId = nextBankId;
    if (updates.balanceDepositBankAccountName !== undefined || updates.depositBankAccountName !== undefined) {
      invoice.balanceDepositBankAccountName = nextBankName;
    }
  } else if (effectiveStatus !== INVOICE_STATUS.PAID) {
    appendDepositBankChangeHistory(invoice, {
      previousBankAccountId: invoice.depositBankAccountId,
      previousBankAccountName: invoice.depositBankAccountName,
      newBankAccountId: updates.depositBankAccountId,
      newBankAccountName: updates.depositBankAccountName,
    }, userId);
    if (nextBankId) {
      invoice.depositBankAccountId = nextBankId;
      invoice.depositBankAccountName = nextBankName;
      invoice.depositBankLocked = false;
      invoice.balanceDepositBankAccountId = undefined;
      invoice.balanceDepositBankAccountName = '';
    }
  }

  delete updates.depositBankAccountId;
  delete updates.depositBankAccountName;
  delete updates.balanceDepositBankAccountId;
  delete updates.balanceDepositBankAccountName;
};

const DEPOSIT_BANK_ONLY_UPDATE_KEYS = new Set([
  'depositBankAccountId',
  'depositBankAccountName',
  'balanceDepositBankAccountId',
  'balanceDepositBankAccountName',
]);

const INVOICE_UPDATE_META_KEYS = new Set(['updatedBy', 'updatedAt']);

/**
 * True when the PUT body only changes deposit bank fields (no amounts, due date, line items, etc.).
 * Used to avoid status recalculation and auto-credit application on bank reassignment.
 */
function isDepositBankOnlyUpdatePayload(updates) {
  if (!updates || typeof updates !== 'object') return false;
  const keys = Object.keys(updates).filter((key) => {
    if (INVOICE_UPDATE_META_KEYS.has(key)) return false;
    const value = updates[key];
    return value !== undefined && value !== null && value !== '';
  });
  if (keys.length === 0) return false;
  const hasBankField = keys.some((key) => DEPOSIT_BANK_ONLY_UPDATE_KEYS.has(key));
  if (!hasBankField) return false;
  return keys.every((key) => DEPOSIT_BANK_ONLY_UPDATE_KEYS.has(key));
}

/**
 * Upload invoice document files to S3 and clean up temp files
 * @param {Array} files - Array of multer file objects
 * @returns {Array} - Array of uploaded document metadata
 */
const uploadFilesToS3 = async (files) => {
  if (!files || files.length === 0) return [];

  assertHoaDocumentUploadSize(files);

  const uploadedDocs = [];

  for (const file of files) {
    try {
      const filename = file.originalname || file.filename || `invoice-${ClockService.nowEpoch()}`;
      const contentType = file.mimetype || 'application/octet-stream';
      const s3Key = s3Client.getKey
        ? s3Client.getKey('invoice', filename)
        : `invoice-documents/${ClockService.nowEpoch()}-${filename}`;

      const s3Result = await s3Client.upload({
        localFilePath: file.path,
        key: s3Key,
        contentType,
      });

      const fileUrl = s3Result.Location
        || `https://${s3Client.bucket || process.env.S3_BUCKET}.s3.${s3Client.region || process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${s3Result.Key}`;

      uploadedDocs.push({
        filename: file.filename,
        originalName: file.originalname,
        key: s3Result.Key,
        url: fileUrl,
        size: file.size,
        mimetype: contentType,
      });
    } catch (uploadErr) {
      try {
        if (file.path) await fs.unlink(file.path);
      } catch (cleanupErr) {
        // Ignore cleanup errors
      }
      const err = new Error(`Failed to upload file ${file.originalname}: ${uploadErr.message}`);
      err.status = uploadErr.status || 502;
      err.code = uploadErr.code;
      throw err;
    }
  }

  return uploadedDocs;
};

/**
 * Create in-app notification events for invoice payers and HOA board members.
 * @param {Object} invoice - Saved invoice document
 */
const createInvoiceEvents = async (invoice) => {
  try {
    notifyInvoiceCreatedInAppInBackground(invoice, invoice.createdBy);
  } catch (eventErr) {
    logger.error('Failed to create invoice notification events:', eventErr);
  }
};

/**
 * Notify invoice owners when a new invoice is created (deduplicated transactional email).
 * @param {Object} invoice - saved invoice document
 */
const sendInvoiceEmails = async (invoice) => {
  if (!invoice) return;
  notifyInvoiceCreatedInBackground(invoice);
};

/**
 * notify Invoice Payment Emails In Background
 *
 * Performs logic operations for notifyInvoicePaymentEmailsInBackground.
 *
 * @param options - Request/input argument
 * @param paymentDelta - Request/input argument
 * @param paymentPrep - Request/input argument
 * @returns Operations result
 */
function notifyInvoicePaymentEmailsInBackground({ invoice, paymentDelta, paymentPrep, recordedByUserId } = {}) {
  const payload = resolvePaymentNotificationPayload({ invoice, paymentDelta, paymentPrep });
  if (!payload) return;
  notifyPaymentRecordedInBackground({
    ...payload,
    recordedByUserId,
  });

  // In-app: queue off the request path (payers + HOA board, including the acting owner).
  notifyPaymentReceivedInAppInBackground(
    invoice,
    recordedByUserId,
    payload.paymentAmount ?? paymentDelta?.amount ?? 0
  );
}

const parseBooleanQuery = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return undefined;
};

const parseNumberQuery = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Create a new invoice with optional file attachments
 * @param {Object} data - Invoice data
 * @param {String} userId - User ID creating the invoice
 * @param {Array} files - Optional array of file attachments
 * @returns {Object} - Created invoice
 */
const createInvoice = async (data, userId, files) => {
  if (userId) data.createdBy = userId;
  const formNote = data.notes != null ? String(data.notes).trim() : '';
  if (Object.prototype.hasOwnProperty.call(data, 'notes')) {
    delete data.notes;
  }
  if (data.type) data.type = normalizeHoaInvoiceType(data.type);
  normalizeInvoiceDateFields(data, ['dueDate', 'startDate', 'endDate']);

  const applyLateFeeNow = Boolean(data.applyLateFeeNow);
  delete data.applyLateFeeNow;

  const policyMonths = parseHoaPolicyTermMonths(data.term);
  if (
    policyMonths &&
    data.isRecurringInvoice === false &&
    data.type === INVOICE_TYPES.FEES
  ) {
    if (policyMonths > POLICY_TERM_ASYNC_THRESHOLD) {
      return invoiceGenerationJobService.startPolicyTermJob(data, userId, files, policyMonths);
    }
    return policyTermService.executePolicyTermInvoiceCreate(data, userId, files, policyMonths);
  }

  // Validate property exists and get property name
  if (data.propertyId) {
    const property = await Property.findById(data.propertyId).lean();
    if (!property) {
      throw new Error('Property not found');
    }
    // Always set property name for historical reference
    data.propertyName = property.name;
    // Persist unit name (same as unit_schedule / opening_balance), not unitDetails._id
    if (data.unit) {
      data.unit = resolveInvoiceUnitLabelFromProperty(property, data.unit);
    }
    if (property.hoaId && !data.hoaId) {
      data.hoaId = property.hoaId;
    }
    if (!data.depositBankAccountId && property.depositBankAccountId) {
      data.depositBankAccountId = property.depositBankAccountId;
      data.depositBankAccountName = normalizeDepositBankLabel(property.depositBankAccountName);
    }
  }

  if (
    !policyMonths
    && data.isRecurringInvoice === false
    && data.dueDate
  ) {
    data.generatedFrom = data.generatedFrom || 'manual';
    if (compareCalendarDateToToday(data.dueDate) < 0) {
      data.skipAutoLateFees = data.skipAutoLateFees !== false;
      if (!data.status) {
        data.status = INVOICE_STATUS.OVERDUE;
      }
    }
  }

  data.invoiceId = await resolveInvoiceIdForCreate(data.invoiceId);

  const session = await mongoose.startSession();
  session.startTransaction();
  let transactionCommitted = false;
  const createdMetadata = [];

  try {
    if (files && files.length > 0) {
      const uploadedDocs = await uploadFilesToS3(files);
      if (Array.isArray(uploadedDocs) && uploadedDocs.length > 0) {
        createdMetadata.push(...await createDocumentMetadataFromUploads(uploadedDocs, session));
        data.documents = buildInvoiceDocumentsPayload(createdMetadata, userId);
      }
    }

    const attachmentIds = createdMetadata.map((md) => md._id);
    const creationNote = buildInvoiceCreationNote({
      notesText: formNote,
      userId,
      attachmentIds,
    });
    if (creationNote) {
      data.comments = [creationNote];
    }

    if (data.principalSubAmount == null && data.subAmount != null) {
      data.principalSubAmount = data.subAmount;
    }

    // Create-form Already Paid: normalize balance/status and materialize a payment
    // row so list/detail/Payments Received match notifications that use balanceDue.
    applyCreateTimeAlreadyPaid(data);

    const invoice = new Invoice(data);
    await invoice.validate();
    const saved = await invoice.save({ session });

    await session.commitTransaction();
    transactionCommitted = true;
    session.endSession();

    let result = saved;
    if (saved.propertyId) {
      const creditResult = await ledgerService.applyAllUnappliedCreditToDueInvoices(saved.propertyId);
      if (creditResult && creditResult.modified) {
        const refreshed = await Invoice.findById(saved._id);
        if (refreshed) result = refreshed;
        notifyOwnersOfAutoAppliedCredit(creditResult.appliedInvoices, userId, saved._id);
      }
    }

    if (applyLateFeeNow && result.propertyId) {
      try {
        await ensureLateFeeInvoicesForUnit(result.propertyId, {
          onlyInvoiceId: result._id,
          forceApply: true,
        });
      } catch (lateFeeErr) {
        logger.warn('[invoice] Manual late fee apply on create failed:', lateFeeErr?.message || lateFeeErr);
      }
    }

    // Log activity
    const property = await Property.findById(saved.propertyId).select('name').lean();
    const propertyName = property?.name || 'Unknown Property';
    await logActivity({
      userId,
      action: 'CREATE',
      module: 'Invoice',
      entityId: saved._id,
      entityName: 'HOA Invoice',
      description: `Created HOA invoice for ${propertyName} - $${saved.subAmount || 0}`,
      meta: { type: saved.type, amount: saved.subAmount, status: saved.status, propertyName }
    });

    if (creationNote) {
      await logEntityNoteActivity({
        userId,
        module: 'Invoice',
        entityId: saved._id,
        entityName: `Invoice ${saved.invoiceId}`,
        action: 'created',
        noteTitle: creationNote.title,
        notePreview: creationNote.text,
        meta: {
          source: 'invoice_create',
          attachmentCount: attachmentIds.length,
        },
      });
    }

    try {
      await createInvoiceEvents(result);
    } catch (eventErr) {
      logger.error('Failed to queue invoice notification events:', eventErr?.message || eventErr);
    }
    try {
      await sendInvoiceEmails(result);
    } catch (emailErr) {
      logger.error('Error sending invoice email after create:', emailErr?.message || emailErr);
    }

    try {
      const { schedulePayloadAutopayMirrorSync } = require('../../../../../shared/modules/payment/providers/payload/helpers/schedulePayloadAutopayMirrorSync');
      schedulePayloadAutopayMirrorSync(result._id, { reason: 'invoice_created' });
    } catch (_) { /* autopay optional */ }

    return result;
  } catch (err) {
    if (!transactionCommitted) {
      try { await session.abortTransaction(); } catch (e) { /* ignore */ }
    }
    session.endSession();

    // Cleanup: delete uploaded objects if metadata created or uploaded
    try {
      for (const md of createdMetadata) {
        if (md && md.key) await s3Client.delete({ key: md.key });
      }
    } catch (cleanupErr) {
      logger.error('Failed to cleanup uploaded files after invoice create failure:', cleanupErr);
    }

    throw err;
  }
};


const resolveTimePeriodDueDateRange = (timePeriod) => {
  let periodStart;
  let periodEnd;

  if (timePeriod === 'quarter') {
    const range = resolveDateRangePreset('this_quarter');
    periodStart = range.start;
    periodEnd = getEndOfDayInAppTimezone(DateUtil.toEST(range.end));
  } else if (timePeriod === 'half-year') {
    const todayKey = DateUtil.toEST(ClockService.now());
    const p = parseAppYmd(todayKey);
    const startM = p.m <= 6 ? 1 : 7;
    const endM = p.m <= 6 ? 6 : 12;
    periodStart = parseDateOnlyToNoonUtc(`${p.y}-${String(startM).padStart(2, '0')}-01`);
    periodEnd = getEndOfDayInAppTimezone(
      `${p.y}-${String(endM).padStart(2, '0')}-${String(lastDayOfAppMonth(p.y, endM)).padStart(2, '0')}`
    );
  } else if (timePeriod === 'year') {
    const y = parseAppYmd(DateUtil.toEST(ClockService.now())).y;
    periodStart = parseDateOnlyToNoonUtc(`${y}-01-01`);
    periodEnd = getEndOfDayInAppTimezone(`${y}-12-31`);
  } else {
    const range = resolveDateRangePreset('this_month');
    periodStart = range.start;
    periodEnd = getEndOfDayInAppTimezone(DateUtil.toEST(range.end));
  }

  return { periodStart, periodEnd };
};

const DATE_ONLY_QUERY_RE = /^\d{4}-\d{2}-\d{2}$/;

const parseDueDateQueryBound = (value, asEnd = false) => {
  // Prefer calendar YMD so Joi-parsed UTC midnight "YYYY-MM-DD" stays inclusive of that day
  // (critical for year_to_date / any filter ending on "today": dueDate >= Jan 1 AND <= today EOD).
  const key =
    (typeof value === 'string' && DATE_ONLY_QUERY_RE.test(String(value).trim())
      ? String(value).trim()
      : null) ||
    dateOnlyKeyFromStoredInstant(value) ||
    DateUtil.calendarDateKeyFromFilterValue(value);
  if (key && DATE_ONLY_QUERY_RE.test(key)) {
    if (asEnd) {
      const parsed = getEndOfDayInAppTimezone(key);
      if (!parsed) throw new Error(`Invalid date format. Expected format: YYYY-MM-DD (${key})`);
      return parsed;
    }
    // Inclusive start: UTC midnight of the calendar day so both noon-anchored dueDates and
    // legacy UTC-midnight dueDates on the first day of the range are included ($gte).
    const parts = parseAppYmd(key);
    if (!parts) throw new Error(`Invalid date format. Expected format: YYYY-MM-DD (${key})`);
    return new Date(Date.UTC(parts.y, parts.m - 1, parts.d, 0, 0, 0, 0));
  }
  const parsed = DateUtil.toUTC(value);
  if (!parsed) throw new Error(`Invalid date format. Expected format: YYYY-MM-DD (${String(value || '').trim()})`);
  return parsed;
};

function parseInstantQueryValue(value, fieldName) {
  const parsed = DateUtil.toUTC(value);
  if (!parsed) throw new Error(`Invalid date format for ${fieldName}`);
  return parsed;
};

async function applyOwnerPayerInvoiceScope(filter, ownerOid) {
  const requestedPropertyIds = filter.propertyId
    ? (filter.propertyId.$in ? filter.propertyId.$in : [filter.propertyId])
    : null;
  const ownerScopeIds = await resolveHoaOwnerInvoicePropertyIds(ownerOid, requestedPropertyIds);
  if (!ownerScopeIds.length) return false;
  // Assigned-unit invoices must match board amounts for the same property, even when
  // `tenants` was not stamped with this owner. Historical units stay in scope via
  // resolveHoaOwnerInvoicePropertyIds (payer + assigned union).
  filter.propertyId = ownerScopeIds.length === 1 ? ownerScopeIds[0] : { $in: ownerScopeIds };
  delete filter.tenants;
  return true;
}

/**
 * HOA owner default listing: current-month due dates OR prior-period rows that are
 * already due and still carry a balance (excludes future invoices).
 */
function shouldIncludeThisMonthPriorOutstanding({ includePastDueOutstandingFlag, status, startDate, endDate }) {
  return (
    includePastDueOutstandingFlag === true &&
    !status &&
    Boolean(startDate) &&
    Boolean(endDate) &&
    isThisMonthDateRangeKeys(startDate, endDate)
  );
}

function appendOwnerThisMonthPriorOutstandingDueDateOr(filter, startDate, endDate) {
  const monthStart = parseDueDateQueryBound(startDate);
  const monthEnd = parseDueDateQueryBound(endDate, true);
  const todayKey = getTodayYmdInAppTimezone();
  const todayEnd = todayKey ? parseDueDateQueryBound(todayKey, true) : monthEnd;
  const dateOr = [
    { dueDate: { $gte: monthStart, $lte: monthEnd } },
    {
      dueDate: { $lt: monthStart, $lte: todayEnd },
      balanceDue: { $gt: 0 },
      status: { $nin: ['Paid', 'Waived'] },
    },
  ];

  if (filter.$and) {
    filter.$and.push({ $or: dateOr });
    return;
  }
  if (filter.$or) {
    const existingOr = filter.$or;
    delete filter.$or;
    filter.$and = [{ $or: existingOr }, { $or: dateOr }];
    return;
  }
  filter.$or = dateOr;
}

/**
 * Get invoices with filters, pagination, and grouping options
 * @param {Object} query - Query parameters including filters, pagination, and groupBy
 * @returns {Object} - { data: [], meta: { total, page, pageSize }, landlordSummary: { collectedAmount, outstandingAmount, overdueAmount, collectionRate } }
 */
const getInvoices = async (query, userContext = null) => {
  const { propertyId, landlordId, unit, tenantId, ownerId, paymentMethod, invoiceId, invoiceType, status, startDate, endDate, sentOn, paidOn, groupBy, pageNumber, pageSize, leaseId, minAmount, maxAmount, isPartialPaymentAllowed, createdBy, timePeriod, search, sortBy, sortOrder, includePastDueOutstanding } = query;
  const payerUserId = tenantId || ownerId;
  const parsedMinAmount = parseNumberQuery(minAmount);
  const parsedMaxAmount = parseNumberQuery(maxAmount);
  const partialPaymentAllowed = parseBooleanQuery(isPartialPaymentAllowed);
  const includePastDueOutstandingFlag = parseBooleanQuery(includePastDueOutstanding);

  // Validate date range when both bounds are provided
  if (startDate && endDate) {
    let start;
    let end;
    try {
      start = parseDueDateQueryBound(startDate);
      end = parseDueDateQueryBound(endDate, true);
    } catch (err) {
      throw new Error(err.message || 'Invalid date format. Expected format: YYYY-MM-DD');
    }

    // Validate startDate <= endDate
    if (start > end) {
      throw new Error('startDate must be less than or equal to endDate');
    }
  }

  // Build filter object based on provided query parameters
  const filter = { isDeleted: { $ne: true }, generatedFrom: { $ne: 'late_fee' } };
  const hoaPropMatch = buildHoaBoardPropertyMatch(userContext);

  // Property and landlord validation and filtering (HOA board: shared properties for the HOA, not only landlordId)
  if (propertyId) {
    if (hoaPropMatch) {
      const prop = await Property.findOne({ _id: propertyId, ...hoaPropMatch }).select('_id').lean();
      if (!prop) {
        const respPage = pageNumber ? parseInt(pageNumber, 10) : 1;
        const respPageSize = pageSize ? parseInt(pageSize, 10) : 0;
        return { data: [], meta: { total: 0, page: respPage, pageSize: respPageSize }, landlordSummary: { ...EMPTY_HOA_INVOICE_SUMMARY }, hoaBoardSummary: { ...EMPTY_HOA_INVOICE_SUMMARY }, statusCounts: { ...EMPTY_INVOICE_STATUS_COUNTS } };
      }
    } else if (landlordId) {
      const safeLandlordId = toObjectId(landlordId);
      if (!safeLandlordId) {
        const respPage = pageNumber ? parseInt(pageNumber, 10) : 1;
        const respPageSize = pageSize ? parseInt(pageSize, 10) : 0;
        return { data: [], meta: { total: 0, page: respPage, pageSize: respPageSize }, landlordSummary: { ...EMPTY_HOA_INVOICE_SUMMARY }, hoaBoardSummary: { ...EMPTY_HOA_INVOICE_SUMMARY }, statusCounts: { ...EMPTY_INVOICE_STATUS_COUNTS } };
      }
      const prop = await Property.findOne({ _id: propertyId, landlord_id: safeLandlordId }).select('_id').lean();
      if (!prop) {
        const respPage = pageNumber ? parseInt(pageNumber, 10) : 1;
        const respPageSize = pageSize ? parseInt(pageSize, 10) : 0;
        return { data: [], meta: { total: 0, page: respPage, pageSize: respPageSize }, landlordSummary: { ...EMPTY_HOA_INVOICE_SUMMARY }, hoaBoardSummary: { ...EMPTY_HOA_INVOICE_SUMMARY }, statusCounts: { ...EMPTY_INVOICE_STATUS_COUNTS } };
      }
    }

    // Late-fee generation is handled by scheduled jobs and ledger writes - not on list reads.
    // Aggregate $match does not cast strings → ObjectId (unlike find); KPIs would stay $0.
    filter.propertyId = toObjectId(propertyId) || propertyId;
  } else if (hoaPropMatch) {
    const propIds = await resolveHoaPropertyIds(userContext);
    if (!propIds || propIds.length === 0) {
      const respPage = pageNumber ? parseInt(pageNumber, 10) : 1;
      const respPageSize = pageSize ? parseInt(pageSize, 10) : 0;
      return { data: [], meta: { total: 0, page: respPage, pageSize: respPageSize }, landlordSummary: { ...EMPTY_HOA_INVOICE_SUMMARY }, hoaBoardSummary: { ...EMPTY_HOA_INVOICE_SUMMARY }, statusCounts: { ...EMPTY_INVOICE_STATUS_COUNTS } };
    }
    filter.propertyId = { $in: propIds };
  } else if (landlordId) {
    const safeLandlordId = toObjectId(landlordId);
    if (!safeLandlordId) {
      const respPage = pageNumber ? parseInt(pageNumber, 10) : 1;
      const respPageSize = pageSize ? parseInt(pageSize, 10) : 0;
      return { data: [], meta: { total: 0, page: respPage, pageSize: respPageSize }, landlordSummary: { ...EMPTY_HOA_INVOICE_SUMMARY }, hoaBoardSummary: { ...EMPTY_HOA_INVOICE_SUMMARY }, statusCounts: { ...EMPTY_INVOICE_STATUS_COUNTS } };
    }
    const props = await Property.find({ landlord_id: safeLandlordId }).select('_id').lean();
    const propIds = (props || []).map(p => p._id);
    if (!propIds || propIds.length === 0) {
      const respPage = pageNumber ? parseInt(pageNumber, 10) : 1;
      const respPageSize = pageSize ? parseInt(pageSize, 10) : 0;
      return { data: [], meta: { total: 0, page: respPage, pageSize: respPageSize }, landlordSummary: { ...EMPTY_HOA_INVOICE_SUMMARY }, hoaBoardSummary: { ...EMPTY_HOA_INVOICE_SUMMARY }, statusCounts: { ...EMPTY_INVOICE_STATUS_COUNTS } };
    }
    filter.propertyId = { $in: propIds };
  }

  // HOA Owner login, or board member filtering by the same owner: assigned units
  // plus historical units that still have invoices (same amounts on both portals).
  const hoaOwnerId = query.hoaOwnerId;
  const scopedOwnerId = toObjectId(hoaOwnerId || (hoaPropMatch ? payerUserId : null));
  if (scopedOwnerId) {
    const applied = await applyOwnerPayerInvoiceScope(filter, scopedOwnerId);
    if (!applied) {
      const respPage = pageNumber ? parseInt(pageNumber, 10) : 1;
      const respPageSize = pageSize ? parseInt(pageSize, 10) : 0;
      return { data: [], meta: { total: 0, page: respPage, pageSize: respPageSize }, landlordSummary: { ...EMPTY_HOA_INVOICE_SUMMARY }, hoaBoardSummary: { ...EMPTY_HOA_INVOICE_SUMMARY }, statusCounts: { ...EMPTY_INVOICE_STATUS_COUNTS } };
    }
  } else if (hoaOwnerId) {
    const respPage = pageNumber ? parseInt(pageNumber, 10) : 1;
    const respPageSize = pageSize ? parseInt(pageSize, 10) : 0;
    return { data: [], meta: { total: 0, page: respPage, pageSize: respPageSize }, landlordSummary: { ...EMPTY_HOA_INVOICE_SUMMARY }, hoaBoardSummary: { ...EMPTY_HOA_INVOICE_SUMMARY }, statusCounts: { ...EMPTY_INVOICE_STATUS_COUNTS } };
  }

  const ownerIncludePriorOutstanding = shouldIncludeThisMonthPriorOutstanding({
    includePastDueOutstandingFlag,
    status,
    startDate,
    endDate,
  });

  // Additional filters
  // Match unit name (system invoices) and unitDetails ObjectId (legacy/manual invoices)
  let unitFilter = null;
  if (unit) {
    unitFilter = await resolveUnitListFilter(unit, filter.propertyId);
    if (unitFilter) filter.unit = unitFilter;
  }
  if (payerUserId && !scopedOwnerId) {
    const safePayerUserId = toObjectId(payerUserId);
    if (safePayerUserId) filter.tenants = safePayerUserId;
  }
  applyPaymentMethodListFilter(filter, paymentMethod);
  if (invoiceId) filter._id = invoiceId;
  if (invoiceType) filter.type = expandHoaFeeTypeFilter(invoiceType);

  if (status) {
    applyHoaInvoiceListStatusFilter(filter, status, { startDate, endDate });
  }
  if (leaseId) filter.lease_id = leaseId;
  if (typeof partialPaymentAllowed === 'boolean') filter.isPartialPaymentAllowed = partialPaymentAllowed;
  if (createdBy) filter.createdBy = createdBy;

  // Amount range filter
  if (parsedMinAmount !== undefined || parsedMaxAmount !== undefined) {
    filter.subAmount = {};
    if (parsedMinAmount !== undefined) filter.subAmount.$gte = parsedMinAmount;
    if (parsedMaxAmount !== undefined) filter.subAmount.$lte = parsedMaxAmount;
  }

  // Due date range: honor startDate and/or endDate on dueDate (matches UI date picker).
  // endDate alone = "through endDate" (Past Overdue deep-link); startDate alone = "on or after".
  if (startDate || endDate) {
    const start = startDate ? parseDueDateQueryBound(startDate) : null;
    const end = endDate ? parseDueDateQueryBound(endDate, true) : null;
    if (ownerIncludePriorOutstanding) {
      appendOwnerThisMonthPriorOutstandingDueDateOr(filter, startDate, endDate);
    } else if (!status) {
      filter.dueDate = { ...(filter.dueDate || {}) };
      if (start) filter.dueDate.$gte = start;
      if (end) filter.dueDate.$lte = end;
    } else if (!LIST_STATUSES_WITH_BUILTIN_DUEDATE.has(status)) {
      if (status === INVOICE_STATUS.OVERDUE && (filter.$or || filter.$and)) {
        appendDueDateRangeToOverdueBranches(filter, start, end);
      } else {
        filter.dueDate = { ...(filter.dueDate || {}) };
        if (start) filter.dueDate.$gte = start;
        if (end) filter.dueDate.$lte = end;
      }
    }
  } else if (status && !LIST_STATUSES_WITH_BUILTIN_DUEDATE.has(status) && timePeriod) {
    const { periodStart, periodEnd } = resolveTimePeriodDueDateRange(timePeriod);
    filter.dueDate = { ...(filter.dueDate || {}), $gte: periodStart, $lte: periodEnd };
  }

  // Filter by invoice sent date (createdAt)
  if (sentOn) {
    filter.createdAt = parseInstantQueryValue(sentOn, 'sentOn');
  }

  // Filter by payment date
  if (paidOn) {
    filter.paidOn = parsePaymentTimestamp(paidOn);
  }

  // Search filter - search by property name, unit, tenant name, owner name
  if (search) {
    const escapedSearch = escapeRegexSearchTerm(search);
    if (!escapedSearch) {
      // skip empty search after trim
    } else {
      // Find matching properties by name
      const matchingProperties = await Property.find({
        name: { $regex: escapedSearch, $options: 'i' }
      }).select('_id').limit(100).lean();
      const matchingPropertyIds = matchingProperties.map(p => p._id);

      // Find matching owners (users) by name
      const matchingOwners = await User.find({
        $or: [
          { firstName: { $regex: escapedSearch, $options: 'i' } },
          { lastName: { $regex: escapedSearch, $options: 'i' } }
        ]
      }).select('_id').limit(100).lean();
      const matchingOwnerIds = matchingOwners.map(u => u._id);

      const searchOr = [
        { invoiceId: { $regex: escapedSearch, $options: 'i' } },
        { propertyName: { $regex: escapedSearch, $options: 'i' } },
        { unit: { $regex: escapedSearch, $options: 'i' } },
        { tenantName: { $regex: escapedSearch, $options: 'i' } },
        { type: { $regex: escapedSearch, $options: 'i' } },
        { propertyId: { $in: matchingPropertyIds } },
        { tenants: { $in: matchingOwnerIds } }
      ];

      if (filter.$or) {
        const statusOr = filter.$or;
        delete filter.$or;
        filter.$and = [{ $or: statusOr }, { $or: searchOr }];
      } else {
        filter.$or = searchOr;
      }
    }
  }

  // HOA: avoid double-filtering invoices already scoped to HOA properties (see applyInvoiceListHoaFilter)
  const filterAfterHoa = applyInvoiceListHoaFilter(filter, userContext);

  // Calculate pagination offset and limit
  const { offset, limit, page } = getPagination({ page: pageNumber, pageSize });

  // Default: oldest due first (FIFO / "old invoice top, new invoice bottom")
  const allowedSortFields = new Set([
    'dueDate',
    'createdAt',
    'updatedAt',
    'subAmount',
    'balanceDue',
    'alreadyPaid',
    'status',
    'propertyName',
    'unit',
    'invoiceId',
    'paidOn',
  ]);
  const sortField = allowedSortFields.has(String(sortBy || '')) ? String(sortBy) : 'dueDate';
  const sortDirection = String(sortOrder || 'asc').toLowerCase() === 'desc' ? -1 : 1;
  const sortSpec = { [sortField]: sortDirection };
  // Stable tie-breaker so pagination stays consistent across equal primary keys.
  if (sortField !== 'createdAt') sortSpec.createdAt = sortDirection;
  if (sortField !== '_id') sortSpec._id = sortDirection;

  // Fetch invoices and total count in parallel
  let invoices, total;
  try {
    [invoices, total] = await Promise.all([
      Invoice.find(filterAfterHoa)
        .select(INVOICE_LIST_PROJECTION)
        .populate('propertyId', 'name address unitDetails depositBankAccountId depositBankAccountName associatedOwnerIds hoaId ownershipRecords')
        .populate('tenants', 'firstName lastName email phone address mailingAddress')
        .sort(sortSpec)
        .skip(offset)
        .limit(limit || 0)
        .lean(),
      Invoice.countDocuments(filterAfterHoa)
    ]);
  } catch (error) {
    throw new Error(`Database error while fetching invoices: ${error.message}`);
  }

  try {
    const payloadCfg = require('../../../../../config/payload.config');
    if (payloadCfg.payload?.enabled && invoices.length > 0) {
      const { repairInvoiceProcessingFromPayloadPayins } = require('../../../../../shared/modules/payment/providers/payload/service/payloadPayin.service');
      const repairTargets = invoices.filter((inv) => Number(inv.processingAmount || 0) <= 0);
      const repairs = await Promise.all(
        repairTargets.map((inv) => repairInvoiceProcessingFromPayloadPayins(inv._id))
      );
      repairs.forEach((result) => {
        if (!result?.refreshed || !result.invoice) return;
        const idx = invoices.findIndex((inv) => String(inv._id) === String(result.invoice._id));
        if (idx >= 0) {
          const existing = invoices[idx];
          const next = { ...existing, ...result.invoice };
          if (existing.propertyId && typeof existing.propertyId === 'object' && existing.propertyId._id) {
            const incoming = result.invoice.propertyId;
            if (!incoming || typeof incoming !== 'object' || !incoming.associatedOwnerIds) {
              next.propertyId = existing.propertyId;
            }
          }
          invoices[idx] = next;
        }
      });
    }
  } catch (repairErr) {
    logger.warn('[invoice] Payload payin repair on list skipped:', repairErr?.message || repairErr);
  }

  let hoaListFallbackBank = null;
  const hoaIdForBank = String(userContext?.hoaId || '').trim()
    || invoices
      .map((inv) => inv?.hoaId || (inv?.propertyId && typeof inv.propertyId === 'object' ? inv.propertyId.hoaId : null))
      .map((id) => String(id || '').trim())
      .find(Boolean)
    || '';
  const [resolvedHoaBank] = await Promise.all([
    hoaIdForBank ? resolveHoaActiveDepositBank(hoaIdForBank) : Promise.resolve(null),
    hydrateInvoicePayers(invoices),
  ]);
  hoaListFallbackBank = resolvedHoaBank;

  // Landlord / HOA property scope for summary + status chips (match main list property filter)
  let invoiceScopePropertyIds = null;
  if (filterAfterHoa.propertyId) {
    invoiceScopePropertyIds = filterAfterHoa.propertyId.$in
      ? filterAfterHoa.propertyId.$in
      : [filterAfterHoa.propertyId];
  }

  // HOA / landlord KPI strip + status chips: lean parallel scans (projected fields only)
  let landlordSummary = { ...EMPTY_HOA_INVOICE_SUMMARY };
  let statusCounts = { ...EMPTY_INVOICE_STATUS_COUNTS };
  if (invoiceScopePropertyIds && invoiceScopePropertyIds.length > 0) {
    try {
      const statusFilterHoa = buildStatusCountsFilter(
        invoiceScopePropertyIds,
        {
          unit,
          unitFilter,
          invoiceType,
          parsedMinAmount,
          parsedMaxAmount,
          startDate,
          endDate,
          hoaOwnerId: scopedOwnerId || hoaOwnerId,
          includePastDueOutstanding: ownerIncludePriorOutstanding,
        },
        userContext
      );
      const filtersMatch = JSON.stringify(filterAfterHoa) === JSON.stringify(statusFilterHoa);

      if (filtersMatch) {
        const aggregated = await aggregateInvoiceSummaryAndCounts(filterAfterHoa);
        landlordSummary = aggregated.landlordSummary;
        statusCounts = aggregated.statusCounts;
      } else {
        const [summaryAgg, statusAgg] = await Promise.all([
          aggregateInvoiceSummaryAndCounts(filterAfterHoa),
          aggregateInvoiceSummaryAndCounts(statusFilterHoa),
        ]);
        landlordSummary = summaryAgg.landlordSummary;
        statusCounts = statusAgg.statusCounts;
      }
    } catch (error) {
      logger.error('Error calculating invoice summary/status counts:', error);
    }
  }

  // Format response based on groupBy option
  let data;

  const unitOutstandingByPropertyId = await ledgerService.getUnitOutstandingBalanceMap(
    invoices.map((inv) => {
      const ref = inv.propertyId;
      return ref && typeof ref === 'object' && ref._id ? ref._id : ref;
    }).filter(Boolean),
  );
  const unitOutstandingForInvoice = (inv) => {
    const ref = inv.propertyId;
    const propertyId = ref && typeof ref === 'object' && ref._id
      ? String(ref._id)
      : ref
        ? String(ref)
        : '';
    return propertyId
      ? roundCurrency(unitOutstandingByPropertyId.get(propertyId) ?? 0)
      : 0;
  };

  if (groupBy === GROUP_BY.PROPERTY) {
    data = invoices.map(inv => ({
      propertySharedBy: inv.propertyName || inv.propertyId?.name || '',
      depositBankAccountName: depositBankNameFromPopulatedProperty(inv, inv.propertyId, hoaListFallbackBank),
      propertyName: resolveInvoicePropertyName(inv),
      unitName: resolveInvoiceUnitName(inv),
      contactAddress: resolveInvoiceContactAddress(inv),
      dueOn: inv.dueDate,
      paidOn: inv.paidOn,
      id: inv._id,
      invoiceId: inv.invoiceId,
      term: inv.term,
      status: getEffectiveInvoiceStatus(inv),
      statusBucket: getEffectiveInvoiceBucket(inv),
      unit: resolveInvoiceUnitName(inv),
      amount: inv.subAmount,
      paid: getEffectiveInvoiceStatus(inv) === INVOICE_STATUS.PAID ? inv.subAmount : inv.alreadyPaid,
      balance: inv.balanceDue,
      subAmount: inv.subAmount,
      alreadyPaid: inv.alreadyPaid,
      processingAmount: inv.processingAmount || 0,
      waivedAmount: inv.waivedAmount || 0,
      balanceDue: inv.balanceDue,
      type: inv.type,
      generatedFrom: inv.generatedFrom,
      sourceInvoiceId: inv.sourceInvoiceId,
      lateFeeRuleKey: inv.lateFeeRuleKey,
      lateFeeSequence: inv.lateFeeSequence,
      invoiceItemDetails: inv.invoiceItemDetails || [],
      paymentMethod: inv.paymentMethod || 'N/A',
      generatedOn: inv.createdAt ? formatDateInAppTimezone(inv.createdAt) : 'N/A',
      daysLate: calculateDaysLate(inv.dueDate, getEffectiveInvoiceStatus(inv)),
      notesCount: countUserInvoiceNotes(inv.comments),
      unitOutstandingBalance: unitOutstandingForInvoice(inv),
      tenants: mapOpenInvoiceTenantsForResponse(inv),
      propertyId: inv.propertyId ? {
        _id: inv.propertyId._id,
        name: inv.propertyName || inv.propertyId.name,
        depositBankAccountName: depositBankNameFromPopulatedProperty(inv, inv.propertyId, hoaListFallbackBank)
      } : null
    }));
  } else if (groupBy === GROUP_BY.TENANT) {
    data = [];
    invoices.forEach(inv => {
      const listTenants = filterInvoiceTenantsToCurrentOwners(inv);
      listTenants.forEach(tenant => {
        const tenantName = tenant ? `${tenant.firstName || ''} ${tenant.lastName || ''}`.trim() : '';
        data.push({
          propertySharedBy: tenantName || '',
          property: inv.propertyName || inv.propertyId?.name || '',
          depositBankAccountName: depositBankNameFromPopulatedProperty(inv, inv.propertyId, hoaListFallbackBank),
          propertyName: resolveInvoicePropertyName(inv),
          unitName: resolveInvoiceUnitName(inv),
          contactAddress: resolveInvoiceContactAddress(inv),
          dueOn: inv.dueDate,
          paidOn: inv.paidOn,
          id: inv._id,
          invoiceId: inv.invoiceId,
          term: inv.term,
          status: getEffectiveInvoiceStatus(inv),
          statusBucket: getEffectiveInvoiceBucket(inv),
          unit: resolveInvoiceUnitName(inv),
          amount: inv.subAmount,
          paid: getEffectiveInvoiceStatus(inv) === INVOICE_STATUS.PAID ? inv.subAmount : inv.alreadyPaid,
          balance: inv.balanceDue,
          subAmount: inv.subAmount,
          alreadyPaid: inv.alreadyPaid,
          processingAmount: inv.processingAmount || 0,
          waivedAmount: inv.waivedAmount || 0,
          balanceDue: inv.balanceDue,
          type: inv.type,
          generatedFrom: inv.generatedFrom,
          sourceInvoiceId: inv.sourceInvoiceId,
          lateFeeRuleKey: inv.lateFeeRuleKey,
          lateFeeSequence: inv.lateFeeSequence,
          invoiceItemDetails: inv.invoiceItemDetails || [],
          paymentMethod: inv.paymentMethod || 'N/A',
          generatedOn: inv.createdAt ? formatDateInAppTimezone(inv.createdAt) : 'N/A',
          daysLate: calculateDaysLate(inv.dueDate, getEffectiveInvoiceStatus(inv)),
          notesCount: countUserInvoiceNotes(inv.comments),
          unitOutstandingBalance: unitOutstandingForInvoice(inv),
          tenants: mapOpenInvoiceTenantsForResponse(inv),
          propertyId: inv.propertyId ? {
            _id: inv.propertyId._id,
            name: inv.propertyName || inv.propertyId.name,
            depositBankAccountName: depositBankNameFromPopulatedProperty(inv, inv.propertyId, hoaListFallbackBank)
          } : null
        });
      });
    });
  } else {
    data = invoices.map(inv => ({
      propertySharedBy: `${inv.propertyName || inv.propertyId?.name || ''} - ${filterInvoiceTenantsToCurrentOwners(inv).map(t => `${t.firstName || ''} ${t.lastName || ''}`.trim() || '').join(', ')}`,
      depositBankAccountName: depositBankNameFromPopulatedProperty(inv, inv.propertyId, hoaListFallbackBank),
      propertyName: resolveInvoicePropertyName(inv),
      unitName: resolveInvoiceUnitName(inv),
      contactAddress: resolveInvoiceContactAddress(inv),
      dueOn: inv.dueDate,
      paidOn: inv.paidOn,
      id: inv._id,
      invoiceId: inv.invoiceId,
      term: inv.term,
      status: getEffectiveInvoiceStatus(inv),
      statusBucket: getEffectiveInvoiceBucket(inv),
      unit: resolveInvoiceUnitName(inv),
      amount: inv.subAmount,
      paid: getEffectiveInvoiceStatus(inv) === INVOICE_STATUS.PAID ? inv.subAmount : inv.alreadyPaid,
      balance: inv.balanceDue,
      subAmount: inv.subAmount,
      alreadyPaid: inv.alreadyPaid,
      processingAmount: inv.processingAmount || 0,
      waivedAmount: inv.waivedAmount || 0,
      balanceDue: inv.balanceDue,
      type: inv.type,
      generatedFrom: inv.generatedFrom,
      sourceInvoiceId: inv.sourceInvoiceId,
      lateFeeRuleKey: inv.lateFeeRuleKey,
      lateFeeSequence: inv.lateFeeSequence,
      invoiceItemDetails: inv.invoiceItemDetails || [],
      paymentMethod: inv.paymentMethod || 'N/A',
      generatedOn: inv.createdAt ? formatDateInAppTimezone(inv.createdAt) : 'N/A',
      daysLate: calculateDaysLate(inv.dueDate, getEffectiveInvoiceStatus(inv)),
      notesCount: countUserInvoiceNotes(inv.comments),
      unitOutstandingBalance: unitOutstandingForInvoice(inv),
      tenants: mapOpenInvoiceTenantsForResponse(inv),
      propertyId: inv.propertyId ? {
        _id: inv.propertyId._id,
        name: inv.propertyName || inv.propertyId.name,
        depositBankAccountName: depositBankNameFromPopulatedProperty(inv, inv.propertyId, hoaListFallbackBank)
      } : null
    }));
  }

  return { data, meta: { total, page, pageSize: limit }, landlordSummary, hoaBoardSummary: landlordSummary, statusCounts };
};

const userDisplayName = (u) => {
  if (!u) return null;
  const name = `${u.firstName || ''} ${u.lastName || ''}`.trim();
  if (name) return name;
  if (u.email) return u.email;
  return null;
};

/** Schedule, opening balance, and late-fee invoices - not created from the invoice UI. */
const SYSTEM_GENERATED_INVOICE_SOURCES = new Set(['unit_schedule', 'opening_balance', 'late_fee']);

const isSystemGeneratedInvoiceSource = (generatedFrom) =>
  SYSTEM_GENERATED_INVOICE_SOURCES.has(String(generatedFrom || 'manual'));

const roundInvoiceCurrency = (value) => Number((Number(value) || 0).toFixed(2));

const LATE_FEE_LINE_ITEM_RE = /late fee/i;

/**
 * reconcile Late Fee History With Line Items
 *
 * Performs logic operations for reconcileLateFeeHistoryWithLineItems.
 *
 * @param invoice - Request/input argument
 * @returns Operations result
 */
function reconcileLateFeeHistoryWithLineItems(invoice) {
  const items = Array.isArray(invoice.invoiceItemDetails) ? invoice.invoiceItemDetails : [];
  const lateFeeItems = items.filter(isLateFeeLineItem);

  if (lateFeeItems.length === 0) {
    invoice.lateFeeHistory = [];
    return;
  }

  const history = Array.isArray(invoice.lateFeeHistory) ? invoice.lateFeeHistory : [];
  if (history.length === 0) return;

  const used = new Set();
  const kept = [];

  for (const item of lateFeeItems) {
    const perUnitRate = lineItemPerUnitRate(item);
    const slots = Math.max(1, Number(item.quantity) || 1);
    let matched = 0;

    for (let idx = 0; idx < history.length && matched < slots; idx += 1) {
      if (used.has(idx)) continue;
      const row = history[idx];
      if (roundInvoiceCurrency(row.amount || 0) !== perUnitRate) continue;
      const label = String(item.invoiceItem || '').trim().toLowerCase();
      const rowLabel = String(row.lineItemLabel || '').trim().toLowerCase();
      if (label && rowLabel && rowLabel !== label && !LATE_FEE_LINE_ITEM_RE.test(rowLabel)) {
        continue;
      }
      used.add(idx);
      kept.push(history[idx]);
      matched += 1;
    }
  }

  invoice.lateFeeHistory = kept;
}

/**
 * filter Late Fee History For Display
 *
 * Performs logic operations for filterLateFeeHistoryForDisplay.
 *
 * @param invoice - Request/input argument
 * @returns Operations result
 */
function filterLateFeeHistoryForDisplay(invoice) {
  const items = Array.isArray(invoice?.invoiceItemDetails) ? invoice.invoiceItemDetails : [];
  const lateFeeItems = items.filter(isLateFeeLineItem);
  const history = Array.isArray(invoice?.lateFeeHistory) ? invoice.lateFeeHistory : [];

  if (history.length === 0) return [];
  if (lateFeeItems.length === 0) return [];

  return history;
}

/**
 * escape Regex Search Term
 *
 * Performs logic operations for escapeRegexSearchTerm.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function escapeRegexSearchTerm(value) {
  return String(value || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const buildLateFeeSummaryForInvoice = async (invoiceId, sourceInvoice) => {
  let history = filterLateFeeHistoryForDisplay(sourceInvoice);

  if (history.length === 0 && Array.isArray(sourceInvoice?.lateFeeHistory) && sourceInvoice.lateFeeHistory.length > 0) {
    history = [];
  }

  if (history.length === 0) {
    const fresh = await Invoice.findById(invoiceId).select('lateFeeHistory principalSubAmount invoiceItemDetails').lean();
    if (fresh) {
      history = filterLateFeeHistoryForDisplay(fresh);
      if (fresh.principalSubAmount != null && sourceInvoice.principalSubAmount == null) {
        sourceInvoice.principalSubAmount = fresh.principalSubAmount;
      }
    }
  }

  if (history.length === 0) return null;

  let initialLateFee = 0;
  let dailyLateFees = 0;
  const lineItems = [];

  const sortedHistory = [...history].sort(
    (a, b) =>
      (Number(a.lateFeeSequence) || 0) - (Number(b.lateFeeSequence) || 0)
      || (DateUtil.toEpoch(a.appliedAt) || 0) - (DateUtil.toEpoch(b.appliedAt) || 0)
  );

  for (const row of sortedHistory) {
    const amount = roundInvoiceCurrency(row.amount || 0);
    const sequence = Number(row.lateFeeSequence) || 0;
    const itemLabel = row.lineItemLabel
      || (sequence === 1 ? 'Initial Late Fee' : 'Daily Late Fee');

    if (sequence === 1) {
      initialLateFee = roundInvoiceCurrency(initialLateFee + amount);
    } else {
      dailyLateFees = roundInvoiceCurrency(dailyLateFees + amount);
    }

    lineItems.push({
      invoiceItem: itemLabel,
      description: row.description || itemLabel,
      quantity: 1,
      rate: amount,
      amount,
      lateFeeSequence: sequence,
      appliedAt: row.appliedAt,
    });
  }

  const consolidatedLineItems = consolidateLateFeeLineItems(lineItems);

  const totalLateFees = roundInvoiceCurrency(initialLateFee + dailyLateFees);
  if (totalLateFees <= 0) return null;

  const principalAmount = sourceInvoice.principalSubAmount != null
    ? roundInvoiceCurrency(sourceInvoice.principalSubAmount)
    : roundInvoiceCurrency(Math.max(0, (Number(sourceInvoice.subAmount) || 0) - totalLateFees));

  return {
    originalInvoiceAmount: principalAmount,
    initialLateFee,
    dailyLateFees,
    totalLateFees,
    currentAmountDue: roundInvoiceCurrency(sourceInvoice.balanceDue || 0),
    unpaidLateFeeBalance: 0,
    lineItems: consolidatedLineItems,
    entries: sortedHistory.map((row) => ({
      _id: row._id,
      amount: roundInvoiceCurrency(row.amount || 0),
      sequence: Number(row.lateFeeSequence) || 0,
      appliedAt: row.appliedAt,
      balanceDue: roundInvoiceCurrency(sourceInvoice.balanceDue || 0),
      calculationMethod: row.calculationMethod || '',
      label:
        Number(row.lateFeeSequence) === 1
          ? 'Late Fee Applied'
          : 'Daily Late Fee Applied',
    })),
  };
};

const appendLateFeeTimelineEntries = (timeline, lateFeeSummary) => {
  if (!lateFeeSummary?.entries?.length) return timeline;

  for (const entry of lateFeeSummary.entries) {
    timeline.push({
      kind: 'late_fee',
      at: DateUtil.toISO(entry.appliedAt),
      amount: entry.amount,
      sequence: entry.sequence,
      label: entry.label,
      reason: entry.sequence === 1 ? 'Initial Late Fee' : 'Daily Late Fee',
      calculationMethod: entry.calculationMethod || undefined,
    });
  }

  timeline.sort((a, b) => (DateUtil.toEpoch(b.at) || 0) - (DateUtil.toEpoch(a.at) || 0));
  return timeline;
};

function normalizeRedirectAllocationRows(rows = []) {
  return (rows || [])
    .map((row) => ({
      invoiceId: row?.invoiceId ? String(row.invoiceId) : '',
      invoiceNumber: String(row?.invoiceNumber || row?.invoiceId || '').trim(),
      amount: roundCurrency(Number(row?.amount || 0)),
    }))
    .filter((row) => row.amount > 0.009);
}

function redirectAllocationHasUsableInvoiceLabel(row) {
  const label = String(row?.invoiceNumber || '').trim();
  if (!label) return false;
  // ObjectId hex is not a human-readable invoice number (INV-…).
  if (/^[0-9a-fA-F]{24}$/.test(label)) return false;
  return true;
}

function resolveRedirectAllocationsForTransaction(tx, priorAllocationMap = new Map()) {
  const stored = normalizeRedirectAllocationRows(tx?.fifoRedirectedAllocations);
  const groupId = String(tx?.paymentGroupId || '');
  const fromPrior = groupId && priorAllocationMap.has(groupId)
    ? normalizeRedirectAllocationRows(priorAllocationMap.get(groupId))
    : [];

  // Prefer prior_allocation siblings when stored rows are missing invoice labels
  // (common after over-balance spills where only amounts were patched).
  if (stored.length > 0) {
    const storedMissingLabels = stored.every((row) => !redirectAllocationHasUsableInvoiceLabel(row));
    if (!storedMissingLabels || fromPrior.length === 0) return stored;
    return fromPrior;
  }

  if (fromPrior.length > 0) return fromPrior;

  const redirectedAmount = roundCurrency(Number(tx?.fifoRedirectedAmount || 0));
  if (redirectedAmount > 0.009) {
    return normalizeRedirectAllocationRows([{
      invoiceId: tx?.fifoRedirectedToInvoiceId,
      invoiceNumber: tx?.fifoRedirectedToInvoiceNumber || tx?.fifoRedirectedToInvoiceId,
      amount: redirectedAmount,
    }]);
  }

  return [];
}

async function buildPriorAllocationMapForInvoice(plain) {
  const unitId = plain?.propertyId?._id || plain?.propertyId;
  if (!unitId) return new Map();

  const groupIds = new Set();
  for (const tx of plain.paymentTransactions || []) {
    if (tx?.isDeleted === true) continue;
    const groupId = String(tx?.paymentGroupId || '');
    if (!groupId) continue;
    const redirectedAmount = Number(tx?.fifoRedirectedAmount || 0);
    const hasStoredAllocations = Array.isArray(tx?.fifoRedirectedAllocations) && tx.fifoRedirectedAllocations.length > 0;
    if (hasStoredAllocations) continue;
    const fifoRole = String(tx?.fifoAllocationRole || '');
    const recordedTotal = Number(tx?.recordedPaymentTotal || 0);
    const applied = roundCurrency(Number(tx?.amount || 0));
    // Include self_allocation spills where redirect metadata failed to persist
    // (payment exceeds this invoice's applied amount after older invoices take cash).
    const needsPriorLookup = redirectedAmount > 0.009
      || fifoRole === 'recorded_only'
      || (fifoRole === 'self_allocation' && recordedTotal > applied + 0.009);
    if (needsPriorLookup) {
      groupIds.add(groupId);
    }
  }
  if (groupIds.size === 0) return new Map();

  const invoices = await Invoice.find({
    propertyId: unitId,
    isDeleted: { $ne: true },
  }).select('invoiceId paymentTransactions').lean();

  const map = new Map();
  for (const inv of invoices || []) {
    for (const row of inv.paymentTransactions || []) {
      if (row?.isDeleted === true) continue;
      if (String(row?.fifoAllocationRole || '') !== 'prior_allocation') continue;
      const groupId = String(row?.paymentGroupId || '');
      if (!groupId || !groupIds.has(groupId)) continue;
      const existing = map.get(groupId) || [];
      existing.push({
        invoiceId: inv._id,
        invoiceNumber: inv.invoiceId || String(inv._id),
        amount: roundCurrency(Number(row.amount || 0)),
      });
      map.set(groupId, existing);
    }
  }

  for (const [groupId, rows] of map.entries()) {
    map.set(groupId, normalizeRedirectAllocationRows(rows));
  }
  return map;
}

const buildActivityTimelineAndReminderCount = (plain, priorAllocationMap = new Map()) => {
  const timeline = [];
  const seenRedirectGroups = new Set();

  if (plain.createdAt) {
    const systemGenerated = isSystemGeneratedInvoiceSource(plain.generatedFrom);
    timeline.push({
      kind: 'created',
      at: DateUtil.toISO(plain.createdAt),
      ...(systemGenerated
        ? { isSystemGenerated: true }
        : { createdBy: userDisplayName(plain.createdBy) }),
    });
  }

  const history = plain.reminderHistory || [];
  for (const r of history) {
    const source = r.source === 'system' || (!r.sentBy && r.source !== 'manual')
      ? 'system'
      : 'manual';
    timeline.push({
      kind: 'reminder',
      at: DateUtil.toISO(r.sentAt),
      recipients: r.recipients || [],
      subject: r.subject || '',
      sentBy: source === 'system' ? null : userDisplayName(r.sentBy),
      source,
      isSystemTriggered: source === 'system',
    });
  }

  if (history.length === 0) {
    for (const c of plain.comments || []) {
      if (typeof c.text === 'string' && c.text.includes('Payment reminder sent')) {
        timeline.push({
          kind: 'reminder',
          at: DateUtil.toISO(c.createdAt),
          legacy: true,
          detail: c.text,
          sentBy: c.isSystem ? null : userDisplayName(c.createdBy),
          source: c.isSystem ? 'system' : 'manual',
          isSystemTriggered: Boolean(c.isSystem),
        });
      }
    }
  }

  // Credit Balance siblings identify true overpayment-to-credit groups.
  // A self_allocation where recordedTotal > applied without credit is a FIFO
  // spill onto earlier invoices - never classify those as payment_overpayment.
  const creditBalanceGroups = new Set();
  for (const tx of plain.paymentTransactions || []) {
    if (tx?.isDeleted === true) continue;
    const groupId = String(tx.paymentGroupId || '');
    if (!groupId) continue;
    if (String(tx.method || '').trim() === 'Credit Balance') {
      creditBalanceGroups.add(groupId);
    }
  }

  const overpaymentGroups = new Set();
  for (const tx of plain.paymentTransactions || []) {
    const fifoRole = String(tx.fifoAllocationRole || '');
    const recordedTotal = Number(tx.recordedPaymentTotal || 0);
    const applied = roundCurrency(Number(tx.amount || 0));
    const redirectedAmount = Number(tx.fifoRedirectedAmount || 0);
    const groupId = String(tx.paymentGroupId || '');
    const priorFromMap = groupId ? priorAllocationMap.get(groupId) : null;
    const hasPriorFromMap = Array.isArray(priorFromMap) && priorFromMap.length > 0;
    const hasFifoRedirect = fifoRole === 'recorded_only'
      || redirectedAmount > 0.009
      || Boolean(tx.fifoRedirectedToInvoiceId)
      || hasPriorFromMap
      || (Array.isArray(tx.fifoRedirectedAllocations) && tx.fifoRedirectedAllocations.length > 0);
    if (
      fifoRole === 'self_allocation'
      && groupId
      && !hasFifoRedirect
      && recordedTotal > applied + 0.009
      && creditBalanceGroups.has(groupId)
    ) {
      overpaymentGroups.add(groupId);
    }
  }

  for (const tx of plain.paymentTransactions || []) {
    const paidOnIso = DateUtil.toISO(tx.paidAt);
    const recordedAtIso = DateUtil.toISO(tx.recordedAt || tx.paidAt);
    const txStatus = String(tx.status || 'completed').toLowerCase();
    if (txStatus === 'processing') {
      timeline.push({
        kind: 'payment_initiated',
        at: recordedAtIso,
        paidOn: paidOnIso,
        amount: tx.amount,
        method: tx.method || '',
        note: tx.note || '',
        paidBy: userDisplayName(tx.paidBy),
        transactionId: tx._id != null ? String(tx._id) : undefined,
        gatewayExternalId: tx.gatewayExternalId || undefined,
      });
      continue;
    }

    const fifoRole = String(tx.fifoAllocationRole || '');
    const noteText = String(tx.note || '');
    const isLegacyPriorAllocation = !fifoRole
      && noteText.includes('from payment on invoice')
      && !noteText.toLowerCase().includes('payment recorded for invoice');

    if (fifoRole === 'prior_allocation' || isLegacyPriorAllocation) {
      const fromInvoiceNumber = tx.recordedAgainstInvoiceNumber
        || (noteText.match(/from payment on invoice #([^(\s]+)/i)?.[1] ?? '');
      timeline.push({
        kind: 'payment_received_from_redirect',
        at: recordedAtIso,
        amount: Number(tx.amount || 0),
        fromInvoiceId: tx.recordedAgainstInvoiceId ? String(tx.recordedAgainstInvoiceId) : '',
        fromInvoiceNumber,
        author: userDisplayName(tx.recordedBy),
        transactionId: tx._id != null ? String(tx._id) : undefined,
        isDeleted: tx.isDeleted === true,
        deletedAt: tx.deletedAt ? DateUtil.toISO(tx.deletedAt) : undefined,
        deletedBy: userDisplayName(tx.deletedBy),
      });
      continue;
    }

    const paymentGroupId = String(tx.paymentGroupId || '');
    const isOverpaymentCreditTx = String(tx.method || '').trim() === 'Credit Balance'
      && paymentGroupId
      && overpaymentGroups.has(paymentGroupId)
      && fifoRole !== 'self_allocation';
    if (isOverpaymentCreditTx) {
      continue;
    }

    const recordedTotal = Number(tx.recordedPaymentTotal || 0);
    const redirectedAmount = Number(tx.fifoRedirectedAmount || 0);
    const appliedToThisInvoice = roundCurrency(Number(tx.amount || 0));
    const priorFromMap = paymentGroupId ? priorAllocationMap.get(paymentGroupId) : null;
    const hasPriorFromMap = Array.isArray(priorFromMap) && priorFromMap.length > 0;
    const hasStoredRedirectAllocations = Array.isArray(tx.fifoRedirectedAllocations)
      && tx.fifoRedirectedAllocations.length > 0;
    // Prefer explicit ledger redirect markers; fall back to prior_allocation siblings
    // when redirect metadata was not persisted on self_allocation (spill case).
    // recordedPaymentTotal alone can exceed amount for credit-only overpayments - those
    // stay in overpaymentGroups and must not be treated as FIFO redirects here.
    const isFifoSpillWithoutCredit = fifoRole === 'self_allocation'
      && recordedTotal > appliedToThisInvoice + 0.009
      && !(paymentGroupId && overpaymentGroups.has(paymentGroupId));
    const hasFifoRedirect = fifoRole === 'recorded_only'
      || redirectedAmount > 0.009
      || Boolean(tx.fifoRedirectedToInvoiceId)
      || hasStoredRedirectAllocations
      || (fifoRole === 'self_allocation' && hasPriorFromMap)
      || isFifoSpillWithoutCredit;
    const redirectGroupKey = paymentGroupId || (hasFifoRedirect ? String(tx._id) : '');

    if (
      (fifoRole === 'recorded_only' || (hasFifoRedirect && fifoRole === 'self_allocation'))
      && redirectGroupKey
      && !seenRedirectGroups.has(redirectGroupKey)
    ) {
      seenRedirectGroups.add(redirectGroupKey);
      const redirectedAllocations = resolveRedirectAllocationsForTransaction(tx, priorAllocationMap);
      let resolvedRedirectedAmount = redirectedAmount > 0.009
        ? redirectedAmount
        : roundCurrency(redirectedAllocations.reduce((sum, row) => sum + Number(row.amount || 0), 0));
      // When redirect metadata/prior rows are missing but recorded total exceeds the
      // amount applied here (and this is not a credit overpayment), imply the spill.
      if (resolvedRedirectedAmount <= 0.009 && isFifoSpillWithoutCredit) {
        resolvedRedirectedAmount = roundCurrency(recordedTotal - appliedToThisInvoice);
      }
      // Ensure the timeline always carries at least one allocation row so the UI can
      // show "applied to Invoice X" instead of a vague "previous unpaid invoices".
      let finalRedirectedAllocations = redirectedAllocations;
      if (
        finalRedirectedAllocations.length === 0
        && resolvedRedirectedAmount > 0.009
      ) {
        finalRedirectedAllocations = normalizeRedirectAllocationRows([{
          invoiceId: tx.fifoRedirectedToInvoiceId,
          invoiceNumber: tx.fifoRedirectedToInvoiceNumber || tx.fifoRedirectedToInvoiceId,
          amount: resolvedRedirectedAmount,
        }]);
      }
      const firstAlloc = finalRedirectedAllocations[0] || null;
      timeline.push({
        kind: 'payment_redirected',
        at: recordedAtIso,
        recordedAmount: roundCurrency(recordedTotal || (appliedToThisInvoice + resolvedRedirectedAmount)),
        redirectedToInvoiceId: tx.fifoRedirectedToInvoiceId
          ? String(tx.fifoRedirectedToInvoiceId)
          : (firstAlloc?.invoiceId ? String(firstAlloc.invoiceId) : ''),
        redirectedToInvoiceNumber: tx.fifoRedirectedToInvoiceNumber || firstAlloc?.invoiceNumber || '',
        redirectedToDueDate: tx.fifoRedirectedToDueDate ? DateUtil.toISO(tx.fifoRedirectedToDueDate) : undefined,
        redirectedAmount: roundCurrency(resolvedRedirectedAmount),
        redirectedAllocations: finalRedirectedAllocations,
        appliedToThisInvoice: fifoRole === 'recorded_only' ? 0 : appliedToThisInvoice,
        author: userDisplayName(tx.recordedBy),
        transactionId: tx._id != null ? String(tx._id) : undefined,
        isDeleted: tx.isDeleted === true,
        deletedAt: tx.deletedAt ? DateUtil.toISO(tx.deletedAt) : undefined,
        deletedBy: userDisplayName(tx.deletedBy),
      });
    }

    if (fifoRole === 'recorded_only') {
      continue;
    }

    if (hasFifoRedirect && redirectGroupKey && fifoRole === 'self_allocation') {
      continue;
    }

    const methodLower = String(tx.method || '').trim().toLowerCase();
    if (methodLower === 'credit adjustment') {
      timeline.push({
        kind: 'credit_applied',
        at: recordedAtIso,
        paidOn: paidOnIso,
        amount: Number(tx.amount || 0),
        note: tx.note || '',
        recordedBy: userDisplayName(tx.recordedBy),
        transactionId: tx._id != null ? String(tx._id) : undefined,
        isDeleted: tx.isDeleted === true,
        deletedAt: tx.deletedAt ? DateUtil.toISO(tx.deletedAt) : undefined,
        deletedBy: userDisplayName(tx.deletedBy),
        sourceInvoiceNumber: tx.sourceInvoiceNumber || tx.recordedAgainstInvoiceNumber || '',
      });
      continue;
    }

    const isOverpaymentPrimary = fifoRole === 'self_allocation'
      && paymentGroupId
      && overpaymentGroups.has(paymentGroupId);
    if (isOverpaymentPrimary) {
      const creditStored = roundCurrency(
        (plain.paymentTransactions || []).reduce((sum, row) => {
          if (row?.isDeleted === true) return sum;
          if (String(row.paymentGroupId || '') !== paymentGroupId) return sum;
          if (String(row.method || '').trim() !== 'Credit Balance') return sum;
          return sum + Number(row.amount || 0);
        }, 0)
      );
      timeline.push({
        kind: 'payment_overpayment',
        at: recordedAtIso,
        paidOn: paidOnIso,
        recordedAmount: roundCurrency(recordedTotal),
        appliedToThisInvoice,
        creditStored,
        method: tx.method || '',
        note: tx.note || '',
        checkNumber: tx.checkNumber || undefined,
        moneyOrderNumber: tx.moneyOrderNumber || undefined,
        balanceAfter: tx.balanceAfter,
        recordedBy: userDisplayName(tx.recordedBy),
        paidBy: userDisplayName(tx.paidBy),
        transactionId: tx._id != null ? String(tx._id) : undefined,
        isDeleted: tx.isDeleted === true,
        deletedAt: tx.deletedAt ? DateUtil.toISO(tx.deletedAt) : undefined,
        deletedBy: userDisplayName(tx.deletedBy),
      });
      continue;
    }

    timeline.push({
      kind: 'payment',
      at: recordedAtIso,
      paidOn: paidOnIso,
      amount: tx.amount,
      method: tx.method || '',
      note: tx.note || '',
      checkNumber: tx.checkNumber || undefined,
      moneyOrderNumber: tx.moneyOrderNumber || undefined,
      balanceAfter: tx.balanceAfter,
      recordedBy: userDisplayName(tx.recordedBy),
      paidBy: userDisplayName(tx.paidBy),
      transactionId: tx._id != null ? String(tx._id) : undefined,
      isDeleted: tx.isDeleted === true,
      deletedAt: tx.deletedAt ? DateUtil.toISO(tx.deletedAt) : undefined,
      deletedBy: userDisplayName(tx.deletedBy),
    });
  }

  for (const ch of plain.depositBankChangeHistory || []) {
    timeline.push({
      kind: 'bank_change',
      at: DateUtil.toISO(ch.changedAt),
      previousBankAccountName: normalizeDepositBankLabel(ch.previousBankAccountName),
      newBankAccountName: normalizeDepositBankLabel(ch.newBankAccountName),
      changedBy: userDisplayName(ch.changedBy),
    });
  }

  for (const edit of plain.editHistory || []) {
    timeline.push({
      kind: 'edit',
      at: DateUtil.toISO(edit.editedAt),
      changes: edit.changes || [],
      editedBy: userDisplayName(edit.editedBy),
    });
  }

  for (const doc of plain.documents || []) {
    if (!doc.uploadedAt) continue;
    const fileName = doc.originalName
      || (doc.metadataId && typeof doc.metadataId === 'object' ? doc.metadataId.originalName : '')
      || 'Attachment';
    timeline.push({
      kind: 'attachment',
      at: DateUtil.toISO(doc.uploadedAt),
      fileName,
      uploadedBy: userDisplayName(doc.uploadedBy),
    });
  }

  for (const w of plain.waiveHistory || []) {
    const lineLabel = String(w.invoiceItem || '').trim();
    timeline.push({
      kind: 'waive',
      at: DateUtil.toISO(w.waivedAt),
      amount: w.amount,
      reason: lineLabel
        ? `${w.reason || ''}`.trim()
          ? `${lineLabel}: ${w.reason}`
          : lineLabel
        : (w.reason || ''),
      waivedBy: userDisplayName(w.waivedBy),
    });
  }

  for (const reversal of plain.waiveReversalHistory || []) {
    timeline.push({
      kind: 'waive_reversal',
      at: DateUtil.toISO(reversal.reversedAt),
      amount: reversal.amount,
      reversedBy: userDisplayName(reversal.reversedBy),
      previousStatus: reversal.previousStatus || '',
      newStatus: reversal.newStatus || '',
    });
  }

  for (const own of plain.ownershipHistory || []) {
    const action = String(own.action || '').toUpperCase();
    const title =
      action === 'OWNER_ADDED'
        ? 'Owner Added'
        : action === 'OWNER_REMOVED'
          ? 'Owner Removed'
          : action === 'OWNER_CHANGED'
            ? 'Owner Changed'
            : action === 'OWNER_EVENT_REVERTED'
              ? 'Ownership Event Reverted'
              : 'Ownership Updated';
    timeline.push({
      kind: 'ownership',
      action,
      title,
      at: DateUtil.toISO(own.performedAt),
      description: own.description || '',
      performedBy: userDisplayName(own.performedBy),
      unitLabel: own.unitLabel || '',
      previousOwnerNames: Array.isArray(own.previousOwnerNames) ? own.previousOwnerNames : [],
      newOwnerNames: Array.isArray(own.newOwnerNames) ? own.newOwnerNames : [],
    });
  }

  timeline.sort((a, b) => (DateUtil.toEpoch(b.at) || 0) - (DateUtil.toEpoch(a.at) || 0));

  const remindersFromHistory = history.length;
  const remindersFromComments = (plain.comments || []).filter(
    (c) => typeof c.text === 'string' && c.text.includes('Payment reminder sent')
  ).length;
  const remindersSent = remindersFromHistory > 0 ? remindersFromHistory : remindersFromComments;
  const lastReminderAt = history.length > 0
    ? DateUtil.toISO(history[history.length - 1].sentAt)
    : null;

  return { activityTimeline: timeline, remindersSent, lastReminderAt };
};

const getInvoiceById = async (id, accessContext = null) => {
  // Run backfill check and main invoice fetch in parallel
  const [, invoice] = await Promise.all([
    backfillInvoiceCreationNote(id),
    Invoice.findById(id)
      .populate('propertyId', 'name depositBankAccountId depositBankAccountName unitDetails hoaId associatedOwnerIds ownershipRecords')
      .populate('tenants', 'firstName lastName email phone address mailingAddress')
      .populate('documents.metadataId', 'key originalName contentType size')
      .populate('documents.uploadedBy', 'firstName lastName email')
      .populate('reminderHistory.sentBy', 'firstName lastName email')
      .populate('paymentTransactions.recordedBy', 'firstName lastName email')
      .populate('paymentTransactions.paidBy', 'firstName lastName email')
      .populate('paymentTransactions.deletedBy', 'firstName lastName email')
      .populate('createdBy', 'firstName lastName email')
      .populate('comments.createdBy', 'firstName lastName email')
      .populate('comments.attachments', 'key originalName contentType size')
      .populate('depositBankChangeHistory.changedBy', 'firstName lastName email')
      .populate('editHistory.editedBy', 'firstName lastName email')
      .populate('waiveHistory.waivedBy', 'firstName lastName email')
      .populate('waiveHistory.reversedBy', 'firstName lastName email')
      .populate('waiveReversalHistory.reversedBy', 'firstName lastName email')
      .populate('ownershipHistory.performedBy', 'firstName lastName email')
      .populate('waivedBy', 'firstName lastName email')
      .lean(),
  ]);
  if (!invoice) throw new NotFoundError('Invoice not found');

  try {
    const payloadCfg = require('../../../../../config/payload.config');
    if (payloadCfg.payload?.enabled) {
      const {
        repairInvoiceProcessingFromPayloadPayins,
        repairStaleProcessingFromFailedPayloadPayins,
      } = require('../../../../../shared/modules/payment/providers/payload/service/payloadPayin.service');
      const repairFailed = await repairStaleProcessingFromFailedPayloadPayins(invoice._id);
      if (repairFailed?.repaired && repairFailed.invoice) {
        const populatedProperty = invoice.propertyId;
        Object.assign(invoice, repairFailed.invoice);
        if (populatedProperty && typeof populatedProperty === 'object' && populatedProperty._id) {
          const incoming = invoice.propertyId;
          if (!incoming || typeof incoming !== 'object' || !incoming.associatedOwnerIds) {
            invoice.propertyId = populatedProperty;
          }
        }
      }
      const repair = await repairInvoiceProcessingFromPayloadPayins(invoice._id);
      if (repair?.refreshed && repair.invoice) {
        const populatedProperty = invoice.propertyId;
        Object.assign(invoice, repair.invoice);
        if (populatedProperty && typeof populatedProperty === 'object' && populatedProperty._id) {
          const incoming = invoice.propertyId;
          if (!incoming || typeof incoming !== 'object' || !incoming.associatedOwnerIds) {
            invoice.propertyId = populatedProperty;
          }
        }
      }
    }
  } catch (repairErr) {
    logger.warn('[invoice] Payload payin repair on detail skipped:', repairErr?.message || repairErr);
  }

  const hoaIdForBank = String(invoice.hoaId || invoice.propertyId?.hoaId || accessContext?.hoaId || '').trim();
  const [, hoaFallbackBank] = await Promise.all([
    hydrateInvoicePayers([invoice]),
    hoaIdForBank ? resolveHoaActiveDepositBank(hoaIdForBank) : Promise.resolve(null),
  ]);

  if (accessContext?.hoaId) {
    const activeHoaId = String(accessContext.hoaId);
    if (invoice.hoaId && String(invoice.hoaId) !== activeHoaId) {
      const err = new Error('Invoice not found');
      err.status = 404;
      throw err;
    }
    if (!invoice.hoaId && invoice.propertyId?.hoaId && String(invoice.propertyId.hoaId) !== activeHoaId) {
      const err = new Error('Invoice not found');
      err.status = 404;
      throw err;
    }
  }

  if (accessContext?.userId && isHOAOwnerRole(accessContext.role)) {
    const assignedOwnerIds = (invoice.tenants || []).map((tenant) => String(tenant?._id || tenant));
    if (!assignedOwnerIds.includes(String(accessContext.userId))) {
      const err = new Error('Invoice not found');
      err.status = 404;
      throw err;
    }
  }

  const propertyRef = invoice.propertyId;
  const unitId =
    propertyRef && typeof propertyRef === 'object' && propertyRef._id
      ? propertyRef._id
      : propertyRef;
  // Trigger late fee generation in background (non-blocking) - do not await on read path
  if (
    unitId
    && invoice.generatedFrom !== 'late_fee'
    && Number(invoice.balanceDue) > 0
  ) {
    ensureLateFeeInvoicesForUnit(unitId).catch((lateFeeErr) => {
      logger.warn('[invoice] Late fee generation on detail read failed:', lateFeeErr?.message || lateFeeErr);
    });
  }

  const effectiveStatus = getEffectiveInvoiceStatus(invoice);
  const effectiveBucket = getEffectiveInvoiceBucket(invoice);
  const plain = { ...invoice };
  plain.tenants = mapOpenInvoiceTenantsForResponse(invoice);
  plain.status = effectiveStatus;
  plain.statusBucket = effectiveBucket;
  plain.propertyName = resolveInvoicePropertyName(invoice);
  plain.unitName = resolveInvoiceUnitName(invoice);
  plain.unit = plain.unitName || invoice.unit;
  plain.contactAddress = resolveInvoiceContactAddress({ ...invoice, tenants: plain.tenants });
  applyResolvedDepositBankToPlain(plain, invoice.propertyId, hoaFallbackBank);

  const priorAllocationMap = await buildPriorAllocationMapForInvoice(plain);
  const { activityTimeline, remindersSent, lastReminderAt } = buildActivityTimelineAndReminderCount(
    plain,
    priorAllocationMap,
  );

  // Run late fee summary, unit doc fetch, prior outstanding, and unit outstanding balance in parallel
  const dueDateCmp = compareCalendarDateToToday(invoice?.dueDate, ClockService.now());
  const needsPriorOutstanding = unitId && Number.isFinite(dueDateCmp) && dueDateCmp > 0 && Number(invoice.balanceDue || 0) > 0;

  const [lateFeeSummary, unitDoc, priorCandidates, unitOutstandingBalance, unitBalanceSummary] = await Promise.all([
    buildLateFeeSummaryForInvoice(id, plain),
    unitId ? Property.findById(unitId).select('remainingCredit billingTimezone billingTimezoneSource').lean() : Promise.resolve(null),
    needsPriorOutstanding
      ? Invoice.find({
        _id: { $ne: invoice._id },
        propertyId: unitId,
        status: { $in: [INVOICE_STATUS.PENDING, INVOICE_STATUS.OVERDUE, INVOICE_STATUS.PARTIALLY_PAID, 'Due'] },
        isDeleted: { $ne: true },
        balanceDue: { $gt: 0 },
      }).select('dueDate status balanceDue').lean()
      : Promise.resolve([]),
    unitId ? ledgerService.getUnitOutstandingBalance(unitId) : Promise.resolve(0),
    unitId ? ledgerService.getBalanceSummary(unitId, { readOnly: true }) : Promise.resolve(null),
  ]);

  plain.lateFeeSummary = lateFeeSummary;
  plain.activityTimeline = appendLateFeeTimelineEntries(activityTimeline, lateFeeSummary);
  plain.remindersSent = remindersSent;
  plain.lastReminderAt = lastReminderAt;
  plain.daysLate = calculateDaysLate(invoice.dueDate, effectiveStatus);
  plain.comments = await enrichInvoiceCommentsForResponse(plain.comments);
  plain.notesCount = countUserInvoiceNotes(plain.comments);
  plain.invoiceItemDetails = consolidateLateFeeLineItems(plain.invoiceItemDetails || []);
  plain.paymentTransactions = (plain.paymentTransactions || []).filter((tx) => tx?.isDeleted !== true);
  try {
    const { enrichInvoicePaymentTransactions } = require('./helpers/enrichInvoicePaymentTransactions.helper');
    plain.paymentTransactions = await enrichInvoicePaymentTransactions(
      invoice._id,
      plain.paymentTransactions,
    );
  } catch (enrichErr) {
    logger.warn('[invoice] Payment transaction enrichment failed:', enrichErr?.message || enrichErr);
  }

  if (unitDoc) {
    plain.unitCreditBalance = roundCurrency(
      Number(unitBalanceSummary?.remainingCredit ?? unitDoc?.remainingCredit ?? 0)
    );
    plain.skipAutoCreditApply = invoice.skipAutoCreditApply === true;
    const { resolveBillingTimezone, getBillingTimezoneLabel } = require('../../../../../common/helpers/billingTimezone.constants');
    plain.propertyBillingTimezone = resolveBillingTimezone(unitDoc?.billingTimezone);
    plain.propertyBillingTimezoneLabel = getBillingTimezoneLabel(plain.propertyBillingTimezone);
  } else {
    plain.unitCreditBalance = 0;
    plain.skipAutoCreditApply = invoice.skipAutoCreditApply === true;
  }

  if (needsPriorOutstanding) {
    const priorOutstandingBalance = roundCurrency(
      (priorCandidates || []).reduce((sum, candidate) => {
        if (!ledgerService.isChronologicalPaymentOutstandingInvoice(candidate)) return sum;
        return sum + Number(candidate.balanceDue || 0);
      }, 0)
    );
    plain.priorOutstandingBalance = priorOutstandingBalance;
    plain.hasPriorOutstandingInvoices = priorOutstandingBalance > 0;
  } else {
    plain.priorOutstandingBalance = 0;
    plain.hasPriorOutstandingInvoices = false;
  }

  plain.unitOutstandingBalance = unitOutstandingBalance;

  return plain;
};

const buildPaymentMetaFromUpdates = (updates, userId) => ({
  method: updates.paymentMethod || updates.paymentType || '',
  note: updates.paymentNotes || updates.paymentNote || '',
  paidBy: updates.paymentUserId && mongoose.Types.ObjectId.isValid(String(updates.paymentUserId))
    ? new mongoose.Types.ObjectId(String(updates.paymentUserId))
    : null,
  checkNumber: updates.checkNumber || '',
  moneyOrderNumber: updates.moneyOrderNumber || '',
  recordedBy: userId || null,
  paidAt: parsePaymentTimestamp(updates.paidOn),
  recordedAt: ClockService.now(),
});

const LEDGER_ALLOCATION_PAYMENT_MODES = new Set(['overpayment', 'chronological']);

const isLedgerAllocationPaymentPrep = (paymentPrep) => (
  paymentPrep && LEDGER_ALLOCATION_PAYMENT_MODES.has(paymentPrep.mode)
);

const attachPaymentAllocationToResult = (invoiceResult, paymentPrep) => {
  if (!isLedgerAllocationPaymentPrep(paymentPrep) || !paymentPrep.result) {
    return invoiceResult;
  }

  const plain = invoiceResult?.toObject
    ? invoiceResult.toObject()
    : { ...(invoiceResult || {}) };

  plain.paymentAllocation = {
    mode: paymentPrep.mode,
    paymentAmount: roundCurrency(paymentPrep.result.paymentAmount || 0),
    appliedToPrimary: roundCurrency(paymentPrep.result.appliedToPrimary || 0),
    appliedToOtherInvoices: paymentPrep.result.appliedToOtherInvoices || [],
    creditStored: roundCurrency(paymentPrep.result.creditStored || 0),
    primaryStatus: paymentPrep.result.primaryStatus || plain.status,
    primaryBalanceDue: roundCurrency(
      paymentPrep.result.primaryBalanceDue != null
        ? paymentPrep.result.primaryBalanceDue
        : plain.balanceDue || 0
    ),
  };

  return plain;
};

const hasPriorOutstandingInvoicesForPayment = async (invoice, session = null) => {
  if (!invoice?.propertyId) return false;

  const eligibleStatuses = [
    INVOICE_STATUS.PENDING,
    INVOICE_STATUS.OVERDUE,
    INVOICE_STATUS.PARTIALLY_PAID,
    'Due',
  ];

  let query = Invoice.find({
    _id: { $ne: invoice._id },
    propertyId: invoice.propertyId,
    status: { $in: eligibleStatuses },
    isDeleted: { $ne: true },
    balanceDue: { $gt: 0 },
  }).select('_id dueDate createdAt status balanceDue');
  if (session) query = query.session(session);

  const candidates = await query.lean();
  return (candidates || []).some((candidate) => (
    ledgerService.isOlderOpenInvoice(candidate, invoice)
  ));
};

/**
 * Resolve payment amount server-side and apply overpayment distribution when needed.
 */
const prepareInvoicePayment = async (invoice, updates, userId, session) => {
  const effectiveStatus = getEffectiveInvoiceStatus(invoice);
  if (effectiveStatus === INVOICE_STATUS.PAID || effectiveStatus === INVOICE_STATUS.WAIVED) {
    throw Object.assign(new Error('Invoice is already fully paid'), { status: 400 });
  }
  if (roundCurrency(invoice.balanceDue || 0) <= 0) {
    throw Object.assign(new Error('Invoice has no remaining balance'), { status: 400 });
  }

  let paymentAmount = 0;
  if (updates.paymentAmount != null && Number(updates.paymentAmount) > 0) {
    paymentAmount = roundCurrency(updates.paymentAmount);
  } else if (updates.alreadyPaid !== undefined && Number(updates.alreadyPaid) > Number(invoice.alreadyPaid || 0)) {
    paymentAmount = roundCurrency(Number(updates.alreadyPaid) - Number(invoice.alreadyPaid || 0));
  } else {
    return null;
  }

  delete updates.paymentAmount;

  const meta = buildPaymentMetaFromUpdates(updates, userId);
  assertPaymentDateOnOrAfterInvoiceGeneration(meta.paidAt, invoice.createdAt);
  const currentBalance = roundCurrency(invoice.balanceDue || 0);
  const { getInvoiceCollectableBalance } = require('../helpers/invoicePaymentTransactions.helper');
  const collectableBalance = roundCurrency(getInvoiceCollectableBalance(invoice));
  const hasProcessing =
    hasActiveProcessingPayment(invoice) || roundCurrency(invoice.processingAmount || 0) > 0;

  // Stage-aware rules: block Initiate/Verify; allow Process/Deposit up to collectable balance.
  // Supersedes a simple "block all processing" gate — supplemental board Record Payment is OK
  // when balance remains and the gateway pay-in is past verification.
  if (hasProcessing) {
    const { assertManualRecordPaymentAllowed } = require('../helpers/invoiceManualRecordPayment.helper');
    await assertManualRecordPaymentAllowed(invoice, paymentAmount);
  }

  // While a gateway payment is in flight, do not allow recording more than the
  // remaining eligible balance on this invoice (prevents overpayment).
  if (hasProcessing && paymentAmount > collectableBalance + 0.009) {
    throw Object.assign(
      new Error(
        `Payment amount cannot exceed the remaining eligible balance of $${collectableBalance.toFixed(2)} ` +
        'while another payment is processing.'
      ),
      { status: 400 }
    );
  }

  // Board Record Payment: overpayment is allowed when no processing payment is active.
  // Any amount exceeding the unit's total outstanding balance is stored as
  // owner credit (Property.remainingCredit) via processInvoiceOverpayment.
  // Do not prepay later-due (future) invoices during this step - leftover stays
  // as credit and may auto-apply later under normal credit rules.

  if (paymentAmount + 0.009 < currentBalance) {
    const { assertHoaAcceptsPartialPaymentForInvoice } = require('../../hoa-settings/helpers/hoaPartialPaymentPolicy.helper');
    await assertHoaAcceptsPartialPaymentForInvoice(invoice, paymentAmount, currentBalance);
  }

  const hasPriorOutstanding = await hasPriorOutstandingInvoicesForPayment(invoice, session);

  if (!hasProcessing && (hasPriorOutstanding || paymentAmount > currentBalance)) {
    const result = await ledgerService.processInvoiceOverpayment({
      unitId: invoice.propertyId,
      primaryInvoiceId: invoice._id,
      paymentAmount,
      paymentMeta: meta,
      session,
      // Board: earlier-due + selected invoice only; excess → credit (not futures).
      // Owner online Pay Now passes allocateFutureInvoices: true separately.
      allocateFutureInvoices: false,
    });

    let reloadQuery = Invoice.findById(invoice._id);
    if (session) reloadQuery = reloadQuery.session(session);
    const reloaded = await reloadQuery;
    if (reloaded) {
      invoice.set(reloaded.toObject());
    }

    // Belt-and-suspenders: after reload, ensure FIFO redirect markers exist on the
    // recording invoice. Post-save subdoc patches can drop fifoRedirected* when
    // payment >= this invoice's balance and cash spills onto earlier invoices -
    // without these fields Activity Timeline omits the cross-invoice allocation.
    const appliedOther = Array.isArray(result?.appliedToOtherInvoices)
      ? result.appliedToOtherInvoices.filter((row) => Number(row?.amount || 0) > 0.009)
      : [];
    if (appliedOther.length > 0) {
      const redirectedTotal = roundCurrency(
        appliedOther.reduce((sum, row) => sum + Number(row.amount || 0), 0)
      );
      const firstRedirect = appliedOther[0];
      const fifoRedirectedAllocations = appliedOther.map((row) => ({
        invoiceId: row.invoiceId,
        invoiceNumber: row.invoiceNumber || String(row.invoiceId || ''),
        amount: roundCurrency(Number(row.amount || 0)),
      }));
      invoice.paymentTransactions = invoice.paymentTransactions || [];
      let stamped = false;
      for (const tx of invoice.paymentTransactions) {
        if (tx?.isDeleted === true) continue;
        const role = String(tx.fifoAllocationRole || '');
        if (role !== 'self_allocation' && role !== 'recorded_only') continue;
        const recordedTotal = Number(tx.recordedPaymentTotal || 0);
        if (recordedTotal > 0 && Math.abs(recordedTotal - Number(result.paymentAmount || 0)) > 0.009) {
          continue;
        }
        tx.fifoRedirectedAmount = redirectedTotal;
        tx.fifoRedirectedToInvoiceId = firstRedirect.invoiceId;
        tx.fifoRedirectedToInvoiceNumber = firstRedirect.invoiceNumber || String(firstRedirect.invoiceId || '');
        if (firstRedirect.dueDate) tx.fifoRedirectedToDueDate = firstRedirect.dueDate;
        tx.fifoRedirectedAllocations = fifoRedirectedAllocations;
        stamped = true;
      }
      if (!stamped && Number(result.appliedToPrimary || 0) <= 0.009) {
        invoice.paymentTransactions.push({
          amount: 0,
          method: meta.method || 'Payment',
          isManual: true,
          note: `Payment of $${roundCurrency(result.paymentAmount || 0).toFixed(2)} recorded; applied to prior outstanding invoices first`,
          balanceAfter: roundCurrency(invoice.balanceDue || 0),
          paidAt: meta.paidAt || ClockService.now(),
          recordedAt: meta.recordedAt || meta.paidAt || ClockService.now(),
          recordedBy: userId || null,
          paidBy: meta.paidBy || null,
          recordedPaymentTotal: roundCurrency(result.paymentAmount || 0),
          recordedAgainstInvoiceId: invoice._id,
          recordedAgainstInvoiceNumber: invoice.invoiceId || String(invoice._id),
          fifoAllocationRole: 'recorded_only',
          fifoRedirectedAmount: redirectedTotal,
          fifoRedirectedToInvoiceId: firstRedirect.invoiceId,
          fifoRedirectedToInvoiceNumber: firstRedirect.invoiceNumber || String(firstRedirect.invoiceId || ''),
          fifoRedirectedToDueDate: firstRedirect.dueDate,
          fifoRedirectedAllocations,
        });
        stamped = true;
      }
      if (stamped && typeof invoice.markModified === 'function') {
        invoice.markModified('paymentTransactions');
      }
    }

    delete updates.alreadyPaid;
    delete updates.balanceDue;

    if (result.appliedToPrimary > 0) {
      await lockInvoiceDepositBankFromUnit(invoice);
    }
    if (invoice.status === INVOICE_STATUS.PARTIALLY_PAID) {
      const unitBank = await snapshotDepositBankFromProperty(invoice.propertyId);
      if (unitBank?.depositBankAccountId) {
        invoice.balanceDepositBankAccountId = unitBank.depositBankAccountId;
        invoice.balanceDepositBankAccountName = unitBank.depositBankAccountName;
      }
    }

    return {
      mode: hasPriorOutstanding ? 'chronological' : 'overpayment',
      result,
      paymentDelta: null,
      paymentMeta: meta,
    };
  }

  const newAlreadyPaid = roundCurrency(Number(invoice.alreadyPaid || 0) + paymentAmount);
  const newBalance = roundCurrency(Math.max(0, currentBalance - paymentAmount));
  updates.alreadyPaid = newAlreadyPaid;
  updates.balanceDue = newBalance;

  return {
    mode: 'simple',
    result: null,
    paymentMeta: meta,
    paymentDelta: {
      amount: paymentAmount,
      balanceAfter: newBalance,
      paidAt: meta.paidAt,
      recordedAt: meta.recordedAt,
      method: meta.method,
      note: meta.note,
      paidBy: meta.paidBy,
      checkNumber: meta.checkNumber,
      moneyOrderNumber: meta.moneyOrderNumber,
    },
  };
};

/**
 * Update an existing invoice
 * @param {String} id - Invoice ID
 * @param {Object} updates - Fields to update
 * @param {String} userId - User ID performing the update
 * @param {Array} files - Optional new file attachments
 * @returns {Object} - Updated invoice
 */
const applyInvoiceDocumentDeletions = (invoice, updates) => {
  const documentIdsToDelete = Array.isArray(updates.documentToDelete)
    ? [...new Set(updates.documentToDelete.map((idToDelete) => String(idToDelete)).filter(Boolean))]
    : [];
  if (Object.prototype.hasOwnProperty.call(updates, 'documentToDelete')) {
    delete updates.documentToDelete;
  }
  if (!documentIdsToDelete.length) return 0;

  const docIdsToDelete = new Set(documentIdsToDelete);
  const beforeCount = Array.isArray(invoice.documents) ? invoice.documents.length : 0;
  invoice.documents = (Array.isArray(invoice.documents) ? invoice.documents : []).filter((doc) => {
    const metadataId = doc && doc.metadataId != null ? String(doc.metadataId) : '';
    return !docIdsToDelete.has(metadataId);
  });
  return beforeCount - invoice.documents.length;
};

const applyDerivedStatusAfterInvoiceUpdate = (invoice, updates, {
  bankOnlyUpdate,
  paymentPrep,
  paymentDelta,
}) => {
  if (
    bankOnlyUpdate
    || isLedgerAllocationPaymentPrep(paymentPrep)
    || (
      updates.subAmount === undefined
      && updates.alreadyPaid === undefined
      && updates.balanceDue === undefined
    )
  ) {
    return;
  }

  recalculateInvoiceStatus(invoice);

  if (invoice.status === INVOICE_STATUS.PAID) {
    invoice.paidOn = paymentDelta?.paidAt || parsePaymentTimestamp(updates.paidOn) || invoice.paidOn;
    return;
  }
  if (paymentDelta?.paidAt && invoice.status === INVOICE_STATUS.PARTIALLY_PAID) {
    invoice.paidOn = paymentDelta.paidAt;
  }
};

const updateInvoice = async (id, updates, userId, files) => {
  const invoice = await Invoice.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!invoice) throw new NotFoundError('Invoice not found');
  const bankOnlyUpdate = isDepositBankOnlyUpdatePayload(updates);
  const removedDocumentCount = applyInvoiceDocumentDeletions(invoice, updates);
  if (removedDocumentCount > 0) {
    invoice.editHistory = invoice.editHistory || [];
    invoice.editHistory.push({
      changes: [`${removedDocumentCount} attachment${removedDocumentCount === 1 ? '' : 's'} removed.`],
      editedBy: userId && mongoose.Types.ObjectId.isValid(String(userId))
        ? new mongoose.Types.ObjectId(String(userId))
        : undefined,
      editedAt: ClockService.now(),
    });
  }
  normalizeInvoiceDateFields(updates, ['dueDate', 'startDate', 'endDate']);
  applyDepositBankUpdatesToInvoice(invoice, updates, userId);

  const subAmountChanging = updates.subAmount !== undefined
    && roundCurrency(updates.subAmount) !== roundCurrency(invoice.subAmount);
  if (subAmountChanging) {
    const nextSubAmount = roundCurrency(Number(updates.subAmount));
    const alreadyPaidFloor = roundCurrency(Number(invoice.alreadyPaid || 0));
    const processingFloor = roundCurrency(Number(invoice.processingAmount || 0));
    // Manual paid + electronic paid/processing cash must remain covered by the invoice total.
    // Increases above that floor are allowed so boards can raise a paid invoice amount.
    const committedFloor = roundCurrency(alreadyPaidFloor + processingFloor);
    if (committedFloor > 0.009 && nextSubAmount + 0.009 < committedFloor) {
      const formatted = `$${committedFloor.toFixed(2)}`;
      const message = processingFloor > 0.009
        ? `Invoice amount cannot be less than the amount already paid or processing (${formatted}).`
        : `Invoice amount cannot be less than the amount already paid (${formatted}).`;
      throw Object.assign(new Error(message), { status: 400 });
    }
    delete updates.balanceDue;
    delete updates.alreadyPaid;
  } else if (updates.balanceDue !== undefined) {
    updates.balanceDue = roundCurrency(Math.max(0, updates.balanceDue));
  }

  // Validate property exists if propertyId is being updated
  if (updates.propertyId) {
    const property = await Property.findById(updates.propertyId).lean();
    if (!property) {
      throw new Error('Property not found');
    }
    if (updates.unit) {
      updates.unit = resolveInvoiceUnitLabelFromProperty(property, updates.unit);
    }
  } else if (updates.unit) {
    const property = await Property.findById(invoice.propertyId).select('unitDetails').lean();
    if (property) {
      updates.unit = resolveInvoiceUnitLabelFromProperty(property, updates.unit);
    }
  }

  if (userId) {
    updates.updatedBy = userId;
    updates.updatedAt = ClockService.now();
  }

  // Never allow alreadyPaid to drop below cash already paid or committed (processing).
  if (updates.alreadyPaid !== undefined && !subAmountChanging) {
    const nextAlreadyPaid = roundCurrency(Number(updates.alreadyPaid));
    const committedFloor = roundCurrency(
      Number(invoice.alreadyPaid || 0) + Number(invoice.processingAmount || 0)
    );
    if (nextAlreadyPaid + 0.009 < committedFloor) {
      throw Object.assign(
        new Error(
          `The payment amount cannot be less than the amount already paid or processing ($${committedFloor.toFixed(2)}).`
        ),
        { status: 400 }
      );
    }
  }

  const hasPaymentIntent =
    (updates.paymentAmount != null && Number(updates.paymentAmount) > 0)
    || (updates.alreadyPaid !== undefined && Number(updates.alreadyPaid) > Number(invoice.alreadyPaid || 0));

  let paymentPrep = null;
  let paymentDelta = null;

  if (hasPaymentIntent && !(files && files.length > 0)) {
    paymentPrep = await prepareInvoicePayment(invoice, updates, userId, null);
    paymentDelta = paymentPrep?.paymentDelta || null;
  }

  // If there are new files, upload and create DocumentMetadata records inside a transaction
  if (files && files.length > 0) {
    const session = await mongoose.startSession();
    session.startTransaction();
    let transactionCommitted = false;
    const createdMetadata = [];

    try {
      const uploadedDocs = await uploadFilesToS3(files);
      if (Array.isArray(uploadedDocs) && uploadedDocs.length > 0) {
        const cfg = config;
        const bucketName = (cfg.s3 && cfg.s3.bucketName) || process.env.S3_BUCKET || 'mock-bucket';
        const region = (cfg.s3 && cfg.s3.region) || process.env.AWS_REGION || 'mock-region';

        for (const d of uploadedDocs) {
          const metaDocs = await DocumentMetadata.create([{
            key: d.key,
            s3Location: d.url,
            bucketName,
            region,
            size: d.size || 0,
            contentType: d.mimetype || 'application/octet-stream',
            originalName: d.originalName || d.filename
          }], { session });
          createdMetadata.push(metaDocs[0]);
        }

        // Append new documents to existing invoice.documents
        invoice.documents = invoice.documents || [];
        for (const md of createdMetadata) {
          invoice.documents.push({ metadataId: md._id, originalName: md.originalName, uploadedAt: ClockService.now(), uploadedBy: userId });
        }
        if (createdMetadata.length > 0) {
          invoice.editHistory = invoice.editHistory || [];
          invoice.editHistory.push({
            changes: [`${createdMetadata.length} attachment${createdMetadata.length === 1 ? '' : 's'} added.`],
            editedBy: userId && mongoose.Types.ObjectId.isValid(String(userId))
              ? new mongoose.Types.ObjectId(String(userId))
              : undefined,
            editedAt: ClockService.now(),
          });
        }
      }

      // Record payment transaction if alreadyPaid increased
      if (hasPaymentIntent && !paymentPrep) {
        paymentPrep = await prepareInvoicePayment(invoice, updates, userId, session);
        paymentDelta = paymentPrep?.paymentDelta || null;
      }
      if (paymentDelta) {
        invoice.paymentTransactions = invoice.paymentTransactions || [];
        invoice.paymentTransactions.push({
          amount: paymentDelta.amount,
          method: paymentDelta.method,
          isManual: true,
          note: paymentDelta.note,
          checkNumber: paymentDelta.checkNumber,
          moneyOrderNumber: paymentDelta.moneyOrderNumber,
          balanceAfter: paymentDelta.balanceAfter,
          recordedBy: userId || null,
          paidBy: paymentDelta.paidBy,
          paidAt: paymentDelta.paidAt,
          recordedAt: paymentDelta.recordedAt || ClockService.now(),
        });
      }

      let amountReconcileResult = null;
      if (!bankOnlyUpdate && !hasPaymentIntent && updates.subAmount !== undefined) {
        amountReconcileResult = await applyInvoiceAmountCreditReconcile(invoice, updates, userId, session);
      }
      applyNonPaymentWaiveBalanceGuard(invoice, updates, { hasPaymentIntent });
      const ownerEmailChanges = collectOwnerInvoiceUpdateEmailChanges(invoice, updates, {
        hasPaymentIntent,
        bankOnlyUpdate,
        amountReconcileResult,
      });

      // apply other updates (skip duplicate payment fields when overpayment already applied)
      if (!isLedgerAllocationPaymentPrep(paymentPrep)) {
        recordInvoiceEditHistoryIfNeeded(invoice, updates, userId, {
          hasPaymentIntent,
          bankOnlyUpdate,
          skipAmountChangeLog: Boolean(amountReconcileResult),
        });
        Object.assign(invoice, updates);
        if (updates.invoiceItemDetails !== undefined) {
          reconcileLateFeeHistoryWithLineItems(invoice);
        }
      } else {
        const {
          alreadyPaid,
          balanceDue,
          paymentAmount,
          paymentMethod,
          paymentType,
          paymentUserId,
          paymentNotes,
          paymentNote,
          checkNumber,
          moneyOrderNumber,
          ...otherUpdates
        } = updates;
        Object.assign(invoice, otherUpdates);
      }

      // Recalculate status based on balance (skip for deposit-bank-only updates)
      applyDerivedStatusAfterInvoiceUpdate(invoice, updates, {
        bankOnlyUpdate,
        paymentPrep,
        paymentDelta,
      });
      // Description/metadata saves can reopen a waived invoice via stale client remaining;
      // re-assert waive identity before auto-credit runs.
      if (!bankOnlyUpdate) {
        syncInvoiceBalanceWithActiveWaive(invoice, { hasPaymentIntent });
      }

      if (paymentDelta && paymentDelta.amount > 0) {
        await lockInvoiceDepositBankFromUnit(invoice);
      }
      if (!bankOnlyUpdate && invoice.status === INVOICE_STATUS.PARTIALLY_PAID) {
        const unitBank = await snapshotDepositBankFromProperty(invoice.propertyId);
        if (unitBank?.depositBankAccountId) {
          invoice.balanceDepositBankAccountId = unitBank.depositBankAccountId;
          invoice.balanceDepositBankAccountName = unitBank.depositBankAccountName;
        }
      }

      await invoice.validate();
      invoice.balanceDue = roundCurrency(Math.max(0, invoice.balanceDue || 0));
      const saved = await invoice.save({ session });
      if (paymentDelta && paymentDelta.amount > 0) {
        await ledgerService.recordPayment(saved.propertyId, paymentDelta.amount, saved._id, {
          source: 'invoice_payment',
          invoiceId: saved._id,
          invoiceNumber: saved.invoiceId,
          paymentMethod: paymentDelta.method,
          paymentNotes: paymentDelta.note,
          checkNumber: paymentDelta.checkNumber || undefined,
          moneyOrderNumber: paymentDelta.moneyOrderNumber || undefined,
          paidBy: paymentDelta.paidBy || undefined,
          recordedBy: userId || undefined,
          balanceAfter: paymentDelta.balanceAfter,
          paidAt: paymentDelta.paidAt,
        }, session);
      } else if (isLedgerAllocationPaymentPrep(paymentPrep) && paymentPrep.result?.paymentAmount > 0) {
        // Ledger payment entry already recorded inside processInvoiceOverpayment
      }

      await session.commitTransaction();
      transactionCommitted = true;
      session.endSession();

      let resultWithCredit = saved;
      if (saved.propertyId && !bankOnlyUpdate) {
        const creditResult = await ledgerService.applyAllUnappliedCreditToDueInvoices(saved.propertyId);
        const refreshed = await Invoice.findById(saved._id);
        if (refreshed) resultWithCredit = refreshed;
        if (creditResult?.modified) {
          notifyOwnersOfAutoAppliedCredit(creditResult.appliedInvoices, userId, saved._id);
        }
      }

      // Log activity for status changes
      const property = await Property.findById(saved.propertyId).select('name').lean();
      const propertyName = property?.name || 'Unknown Property';
      await logCreditBalanceAdjustmentActivity(userId, saved.propertyId, propertyName, saved, amountReconcileResult);
      if (isLedgerAllocationPaymentPrep(paymentPrep) && paymentPrep.result) {
        const { creditStored, appliedToOtherInvoices } = paymentPrep.result;
        const otherTotal = (appliedToOtherInvoices || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
        const allocationDescription = paymentPrep.mode === 'chronological'
          ? `Payment applied to oldest outstanding invoices for ${propertyName} · $${roundCurrency(paymentPrep.result.paymentAmount).toFixed(2)} received`
          : `Overpayment recorded for ${propertyName} · $${roundCurrency(paymentPrep.result.paymentAmount).toFixed(2)} received`;
        await logActivity({
          userId,
          action: 'PAYMENT_SUCCESS',
          module: 'Invoice',
          entityId: saved._id,
          hoaId: saved.hoaId || undefined,
          entityName: 'HOA Invoice',
          description: allocationDescription,
          meta: {
            type: saved.type,
            amount: saved.subAmount,
            propertyName,
            allocationMode: paymentPrep.mode,
            appliedToPrimary: paymentPrep.result.appliedToPrimary,
            appliedToOtherInvoices: otherTotal,
            creditStored,
          },
        });
      } else if (paymentDelta && paymentDelta.amount > 0) {
        const methodLabel = paymentDelta.method || 'Payment';
        const refSuffix = paymentDelta.checkNumber
          ? ` (${paymentDelta.checkNumber})`
          : paymentDelta.moneyOrderNumber
            ? ` (${paymentDelta.moneyOrderNumber})`
            : '';
        await logActivity({
          userId,
          action: 'PAYMENT_SUCCESS',
          module: 'Invoice',
          entityId: saved._id,
          hoaId: saved.hoaId || undefined,
          entityName: 'HOA Invoice',
          description: `Payment of $${roundCurrency(paymentDelta.amount).toFixed(2)} received for ${propertyName} through ${methodLabel}${refSuffix}`,
          meta: {
            type: saved.type,
            amount: paymentDelta.amount,
            propertyName,
            paymentMethod: paymentDelta.method,
            balanceAfter: paymentDelta.balanceAfter,
          },
        });
      } else if (updates.status && invoice.status !== updates.status) {
        const action = updates.status === INVOICE_STATUS.PAID ? 'PAYMENT_SUCCESS' :
          updates.status === INVOICE_STATUS.OVERDUE ? 'PAYMENT_FAILED' : 'STATUS_CHANGE';
        await logActivity({
          userId,
          action,
          module: 'Invoice',
          entityId: saved._id,
          entityName: 'HOA Invoice',
          description: `Invoice status changed to ${updates.status} for ${propertyName} - $${saved.subAmount || 0}`,
          meta: { type: saved.type, amount: saved.subAmount, oldStatus: invoice.status, newStatus: updates.status, propertyName }
        });
      } else {
        await logActivity({
          userId,
          action: 'UPDATE',
          module: 'Invoice',
          entityId: saved._id,
          entityName: 'HOA Invoice',
          description: `Updated invoice for ${propertyName} - $${saved.subAmount || 0}`,
          meta: { type: saved.type, amount: saved.subAmount, status: saved.status, propertyName }
        });
      }

      notifyOwnerAfterInvoiceMutation({
        invoice: resultWithCredit,
        userId,
        paymentDelta,
        paymentPrep,
        changeDescriptions: ownerEmailChanges,
      });

      return attachPaymentAllocationToResult(resultWithCredit, paymentPrep);
    } catch (err) {
      if (!transactionCommitted) {
        try { await session.abortTransaction(); } catch (e) { /* ignore */ }
      }
      session.endSession();

      // Cleanup uploaded files for created metadata
      try {
        for (const md of createdMetadata) {
          if (md && md.key) await s3Client.delete({ key: md.key });
        }
      } catch (cleanupErr) {
        logger.error('Failed to cleanup uploaded files after invoice update failure:', cleanupErr);
      }

      throw err;
    }
  }

  // Record payment transaction if alreadyPaid increased (non-file path)
  if (hasPaymentIntent && !paymentPrep) {
    paymentPrep = await prepareInvoicePayment(invoice, updates, userId, null);
    paymentDelta = paymentPrep?.paymentDelta || null;
  }
  if (paymentDelta) {
    invoice.paymentTransactions = invoice.paymentTransactions || [];
    invoice.paymentTransactions.push({
      amount: paymentDelta.amount,
      method: paymentDelta.method,
      isManual: true,
      note: paymentDelta.note,
      checkNumber: paymentDelta.checkNumber,
      moneyOrderNumber: paymentDelta.moneyOrderNumber,
      balanceAfter: paymentDelta.balanceAfter,
      recordedBy: userId || null,
      paidBy: paymentDelta.paidBy,
      paidAt: paymentDelta.paidAt,
      recordedAt: paymentDelta.recordedAt || ClockService.now(),
    });
  }

  let amountReconcileResult = null;
  if (!bankOnlyUpdate && !hasPaymentIntent && updates.subAmount !== undefined) {
    amountReconcileResult = await applyInvoiceAmountCreditReconcile(invoice, updates, userId, null);
  }
  applyNonPaymentWaiveBalanceGuard(invoice, updates, { hasPaymentIntent });
  const ownerEmailChanges = collectOwnerInvoiceUpdateEmailChanges(invoice, updates, {
    hasPaymentIntent,
    bankOnlyUpdate,
    amountReconcileResult,
  });

  if (!isLedgerAllocationPaymentPrep(paymentPrep)) {
    recordInvoiceEditHistoryIfNeeded(invoice, updates, userId, {
      hasPaymentIntent,
      bankOnlyUpdate,
      skipAmountChangeLog: Boolean(amountReconcileResult),
    });
    Object.assign(invoice, updates);
    if (updates.invoiceItemDetails !== undefined) {
      reconcileLateFeeHistoryWithLineItems(invoice);
    }
  } else {
    const {
      alreadyPaid,
      balanceDue,
      paymentAmount,
      paymentMethod,
      paymentType,
      paymentUserId,
      paymentNotes,
      paymentNote,
      checkNumber,
      moneyOrderNumber,
      ...otherUpdates
    } = updates;
    Object.assign(invoice, otherUpdates);
  }

  // Recalculate status based on balance (skip for deposit-bank-only updates)
  applyDerivedStatusAfterInvoiceUpdate(invoice, updates, {
    bankOnlyUpdate,
    paymentPrep,
    paymentDelta,
  });
  // Description/metadata saves can reopen a waived invoice via stale client remaining;
  // re-assert waive identity before auto-credit runs.
  if (!bankOnlyUpdate) {
    syncInvoiceBalanceWithActiveWaive(invoice, { hasPaymentIntent });
  }

  if (paymentDelta && paymentDelta.amount > 0) {
    await lockInvoiceDepositBankFromUnit(invoice);
  }
  if (!bankOnlyUpdate && invoice.status === INVOICE_STATUS.PARTIALLY_PAID) {
    const unitBank = await snapshotDepositBankFromProperty(invoice.propertyId);
    if (unitBank?.depositBankAccountId) {
      invoice.balanceDepositBankAccountId = unitBank.depositBankAccountId;
      invoice.balanceDepositBankAccountName = unitBank.depositBankAccountName;
    }
  }

  await invoice.validate();
  invoice.balanceDue = roundCurrency(Math.max(0, invoice.balanceDue || 0));
  const saved = await invoice.save();
  if (paymentDelta && paymentDelta.amount > 0) {
    await ledgerService.recordPayment(saved.propertyId, paymentDelta.amount, saved._id, {
      source: 'invoice_payment',
      invoiceId: saved._id,
      invoiceNumber: saved.invoiceId,
      paymentMethod: paymentDelta.method,
      paymentNotes: paymentDelta.note,
      checkNumber: paymentDelta.checkNumber || undefined,
      moneyOrderNumber: paymentDelta.moneyOrderNumber || undefined,
      paidBy: paymentDelta.paidBy || undefined,
      recordedBy: userId || undefined,
      balanceAfter: paymentDelta.balanceAfter,
      paidAt: paymentDelta.paidAt,
    });
  }

  let resultWithCredit = saved;
  if (saved.propertyId && !bankOnlyUpdate) {
    const creditResult = await ledgerService.applyAllUnappliedCreditToDueInvoices(saved.propertyId);
    const refreshed = await Invoice.findById(saved._id);
    if (refreshed) resultWithCredit = refreshed;
    if (creditResult?.modified) {
      notifyOwnersOfAutoAppliedCredit(creditResult.appliedInvoices, userId, saved._id);
    }
  }

  // Log activity for status changes
  const property = await Property.findById(saved.propertyId).select('name').lean();
  const propertyName = property?.name || 'Unknown Property';
  await logCreditBalanceAdjustmentActivity(userId, saved.propertyId, propertyName, saved, amountReconcileResult);
  if (isLedgerAllocationPaymentPrep(paymentPrep) && paymentPrep.result) {
    const { appliedToPrimary, creditStored, appliedToOtherInvoices } = paymentPrep.result;
    const otherTotal = (appliedToOtherInvoices || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const allocationDescription = paymentPrep.mode === 'chronological'
      ? `Payment applied to oldest outstanding invoices for ${propertyName} · $${roundCurrency(paymentPrep.result.paymentAmount).toFixed(2)} received`
      : `Overpayment recorded for ${propertyName} · $${roundCurrency(paymentPrep.result.paymentAmount).toFixed(2)} received`;
    await logActivity({
      userId,
      action: 'PAYMENT_SUCCESS',
      module: 'Invoice',
      entityId: saved._id,
      entityName: 'HOA Invoice',
      description: allocationDescription,
      meta: {
        type: saved.type,
        amount: saved.subAmount,
        propertyName,
        allocationMode: paymentPrep.mode,
        appliedToPrimary,
        appliedToOtherInvoices: otherTotal,
        creditStored,
      },
    });
  } else if (paymentDelta && paymentDelta.amount > 0) {
    const methodLabel = paymentDelta.method || 'Payment';
    const refSuffix = paymentDelta.checkNumber
      ? ` (${paymentDelta.checkNumber})`
      : paymentDelta.moneyOrderNumber
        ? ` (${paymentDelta.moneyOrderNumber})`
        : '';
    await logActivity({
      userId,
      action: 'PAYMENT_SUCCESS',
      module: 'Invoice',
      entityId: saved._id,
      entityName: 'HOA Invoice',
      description: `Payment of $${roundCurrency(paymentDelta.amount).toFixed(2)} received for ${propertyName} through ${methodLabel}${refSuffix}`,
      meta: {
        type: saved.type,
        amount: paymentDelta.amount,
        propertyName,
        paymentMethod: paymentDelta.method,
        balanceAfter: paymentDelta.balanceAfter,
      },
    });
  } else if (updates.status && invoice.status !== updates.status) {
    const action = updates.status === INVOICE_STATUS.PAID ? 'PAYMENT_SUCCESS' :
      updates.status === INVOICE_STATUS.OVERDUE ? 'PAYMENT_FAILED' : 'STATUS_CHANGE';
    await logActivity({
      userId,
      action,
      module: 'Invoice',
      entityId: saved._id,
      entityName: 'HOA Invoice',
      description: `Invoice status changed to ${updates.status} for ${propertyName} - $${saved.subAmount || 0}`,
      meta: { type: saved.type, amount: saved.subAmount, oldStatus: invoice.status, newStatus: updates.status, propertyName }
    });
  } else {
    await logActivity({
      userId,
      action: 'UPDATE',
      module: 'Invoice',
      entityId: saved._id,
      entityName: 'HOA Invoice',
      description: `Updated invoice for ${propertyName} - $${saved.subAmount || 0}`,
      meta: { type: saved.type, amount: saved.subAmount, status: saved.status, propertyName }
    });
  }

  notifyOwnerAfterInvoiceMutation({
    invoice: resultWithCredit,
    userId,
    paymentDelta,
    paymentPrep,
    changeDescriptions: ownerEmailChanges,
  });

  if (!paymentDelta) {
    notifyInvoiceUpdatedInAppInBackground(resultWithCredit, userId);
  }

  try {
    const { schedulePayloadAutopayMirrorSync } = require('../../../../../shared/modules/payment/providers/payload/helpers/schedulePayloadAutopayMirrorSync');
    schedulePayloadAutopayMirrorSync(saved._id, { reason: 'invoice_updated' });
  } catch (_) { /* autopay optional */ }

  return attachPaymentAllocationToResult(resultWithCredit, paymentPrep);
};

/**
 * Delete an invoice by ID (soft delete)
 * @param {String} id - Invoice ID
 * @param {String} userId - User ID performing the delete
 * @returns {Object} - Deleted invoice
 */
const deleteInvoice = async (id, userId) => {
  const invoice = await Invoice.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!invoice) throw new NotFoundError('Invoice not found');

  const sourcePaymentRestriction = await findSourcePaymentAllocationsBlockingDelete(invoice);
  if (sourcePaymentRestriction) {
    throw buildInvoiceDeleteRestrictionError(sourcePaymentRestriction);
  }

  if (
    invoice.status === INVOICE_STATUS.PAID
    || invoice.status === INVOICE_STATUS.PARTIALLY_PAID
    || invoice.status === INVOICE_STATUS.PROCESSING
    || Number(invoice.processingAmount || 0) > 0
  ) {
    throw Object.assign(
      new Error('Paid, partially paid, or processing invoices cannot be deleted'),
      { status: 400 }
    );
  }

  const hasGatewayPayment = (invoice.paymentTransactions || []).some(
    (tx) => !tx.isDeleted && isElectronicPaymentTransaction(tx)
  );
  if (hasGatewayPayment) {
    throw Object.assign(
      new Error('Invoices paid via payment gateway cannot be deleted'),
      { status: 400 }
    );
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    await releaseInvoiceCreditsBeforeDelete(invoice, userId, session);

    invoice.isDeleted = true;
    invoice.deletedAt = ClockService.now();
    invoice.deletedBy = userId;
    await invoice.save({ session });

    await session.commitTransaction();
    session.endSession();
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }

  if (invoice.propertyId) {
    await ledgerService.applyAllUnappliedCreditToDueInvoices(invoice.propertyId);
  }

  await logActivity({
    userId: userId || invoice.createdBy,
    action: 'DELETE',
    module: 'Invoice',
    entityId: invoice._id,
    entityName: `Invoice ${invoice.invoiceId || invoice._id}`,
    description: `Deleted invoice: ${invoice.invoiceId || invoice._id}`,
    meta: { type: invoice.type, status: invoice.status, amount: invoice.subAmount }
  });

  notifyInvoiceDeletedInAppInBackground(invoice, userId);

  try {
    const { schedulePayloadAutopayMirrorSync } = require('../../../../../shared/modules/payment/providers/payload/helpers/schedulePayloadAutopayMirrorSync');
    schedulePayloadAutopayMirrorSync(invoice._id, { reason: 'invoice_deleted' });
  } catch (_) { /* autopay optional */ }

  return invoice;
};

const deleteInvoicePayment = async (invoiceId, paymentTransactionId, userId) => {
  const invoice = await Invoice.findOne({ _id: invoiceId, isDeleted: { $ne: true } });
  if (!invoice) throw new NotFoundError('Invoice not found');

  const tx = (invoice.paymentTransactions || []).id(paymentTransactionId);
  if (!tx) {
    throw Object.assign(new Error('Payment record not found'), { status: 404 });
  }
  if (tx.isDeleted === true) {
    throw Object.assign(new Error('Payment record already removed'), { status: 404 });
  }
  if (isElectronicPaymentTransaction(tx)) {
    throw Object.assign(
      new Error('Electronic payments cannot be deleted'),
      { status: 400 }
    );
  }

  if (isPriorAllocationTransaction(tx)) {
    const sourceLabel = tx.recordedAgainstInvoiceNumber
      ? `invoice ${tx.recordedAgainstInvoiceNumber}`
      : 'the source invoice';
    throw Object.assign(
      new Error(
        `This payment was automatically allocated from a payment recorded on ${sourceLabel}. Remove the original payment there to reverse this allocation.`,
      ),
      { status: 400 },
    );
  }

  if (isDownstreamCreditApplication(tx)) {
    const sourceLabel = tx.sourceInvoiceNumber
      ? `invoice ${tx.sourceInvoiceNumber}`
      : 'the source invoice';
    throw Object.assign(
      new Error(
        `This credit was applied from an overpayment on ${sourceLabel}. Remove the original payment there to reverse this allocation.`,
      ),
      { status: 400 },
    );
  }

  const removedTxKind = classifyPaymentTransaction(tx);
  const isCreditApplicationRemoval = removedTxKind === 'credit_applied';
  const removedCreditAmount = roundCurrency(tx.amount);

  const session = await mongoose.startSession();
  session.startTransaction();
  let removedPayment = null;

  try {
    removedPayment = await reverseRecordedPaymentGroup({
      invoice,
      tx,
      userId,
      session,
    });

    if (!removedPayment) {
      const creditEffect = await reversePaymentTransactionCreditEffects({
        invoice,
        tx,
        userId,
        session,
      });

      tx.isDeleted = true;
      tx.deletedAt = ClockService.now();
      if (userId && mongoose.Types.ObjectId.isValid(String(userId))) {
        tx.deletedBy = new mongoose.Types.ObjectId(String(userId));
      }
      const totals = recalculateInvoiceTotalsFromTransactions(invoice);
      invoice.alreadyPaid = totals.alreadyPaid;
      invoice.processingAmount = totals.processingAmount;
      invoice.balanceDue = totals.balanceDue;
      recalculateInvoiceStatus(invoice);

      invoice.editHistory = invoice.editHistory || [];
      const paidAtLabel = formatDateInAppTimezone(tx.paidAt || ClockService.nowEpoch(), {
        month: 'short',
        day: '2-digit',
        year: 'numeric',
      });
      const editChanges = isCreditApplicationRemoval
        ? [
          'Credit Application Removed',
          `$${removedCreditAmount.toFixed(2)} credit application was removed manually.`,
          creditEffect?.creditBalanceBefore != null && creditEffect?.creditBalanceAfter != null
            ? `Available credit restored: $${creditEffect.creditBalanceBefore.toFixed(2)} -> $${creditEffect.creditBalanceAfter.toFixed(2)}.`
            : `Available credit restored: $${removedCreditAmount.toFixed(2)}.`,
          'Automatic reapplication is paused for this invoice until Apply Credit is used.',
        ]
        : [
          'Payment Removed',
          `A payment of $${removedCreditAmount.toFixed(2)} recorded on ${paidAtLabel} was removed.`,
          creditEffect?.creditBalanceBefore != null && creditEffect?.creditBalanceAfter != null
            ? `Owner credit balance updated: $${creditEffect.creditBalanceBefore.toFixed(2)} -> $${creditEffect.creditBalanceAfter.toFixed(2)}.`
            : null,
          'Invoice totals and credit balances were recalculated.',
        ].filter(Boolean);

      invoice.editHistory.push({
        changes: editChanges,
        editedBy: userId && mongoose.Types.ObjectId.isValid(String(userId))
          ? new mongoose.Types.ObjectId(String(userId))
          : undefined,
        editedAt: ClockService.now(),
      });

      if (isCreditApplicationRemoval) {
        markInvoiceSkipAutoCredit(invoice);
      }

      await invoice.save({ session });
      removedPayment = {
        totalRemoved: roundCurrency(tx.amount),
        removedTransactions: [{
          invoiceId: invoice._id,
          invoiceNumber: invoice.invoiceId,
          amount: roundCurrency(tx.amount),
          method: tx.method || '',
          paidAt: tx.paidAt,
        }],
        creditEffect,
      };
    } else if (isCreditApplicationRemoval) {
      // Group reversal already persisted invoice rows - still pause auto-credit for this invoice.
      markInvoiceSkipAutoCredit(invoice);
      invoice.editHistory = invoice.editHistory || [];
      invoice.editHistory.push({
        changes: [
          'Credit Application Removed',
          `$${removedCreditAmount.toFixed(2)} credit application was removed manually.`,
          'Automatic reapplication is paused for this invoice until Apply Credit is used.',
        ],
        editedBy: userId && mongoose.Types.ObjectId.isValid(String(userId))
          ? new mongoose.Types.ObjectId(String(userId))
          : undefined,
        editedAt: ClockService.now(),
      });
      await invoice.save({ session });
    }
    await session.commitTransaction();
    session.endSession();
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }

  const property = await Property.findById(invoice.propertyId).select('name').lean();
  const actor = userId && mongoose.Types.ObjectId.isValid(String(userId))
    ? await User.findById(userId).select('firstName lastName email').lean()
    : null;
  const actorName = userDisplayName(actor) || 'a board member';
  const firstRemoved = removedPayment?.removedTransactions?.[0];
  const paidAtText = firstRemoved?.paidAt
    ? formatDateInAppTimezone(firstRemoved.paidAt, { month: 'short', day: '2-digit', year: 'numeric' })
    : 'the recorded payment date';
  const isCreditStoredRemoval = removedTxKind === 'credit_stored';
  await logActivity({
    userId,
    action: 'ADJUSTMENT',
    module: 'Invoice',
    entityId: invoice._id,
    entityName: isCreditApplicationRemoval || isCreditStoredRemoval ? 'Credit Application Removed' : 'Payment Removed',
    description: isCreditStoredRemoval
      ? `$${removedCreditAmount.toFixed(2)} overpayment credit was removed by ${actorName}. Downstream auto-applied credit was unapplied and balances were recalculated.`
      : isCreditApplicationRemoval
        ? `$${removedCreditAmount.toFixed(2)} credit application was removed manually by ${actorName}. Automatic reapplication is paused for this invoice until Apply Credit is used.`
        : `A payment of $${roundCurrency(removedPayment?.totalRemoved || tx.amount).toFixed(2)} recorded on ${paidAtText} was removed by ${actorName}. Invoice totals and credit balances were recalculated.`,
    meta: {
      paymentTransactionId,
      propertyId: String(invoice.propertyId || ''),
      propertyName: property?.name || '',
      removedTransactions: removedPayment?.removedTransactions || [],
      creditEffect: removedPayment?.creditEffect || null,
    },
  });

  const { notifyInvoicePaymentRemovalEffects } = require('../helpers/invoicePaymentRemovalNotify.helper');
  notifyInvoicePaymentRemovalEffects(
    {
      invoice,
      userId,
      paymentTransactionId,
      tx,
      removedPayment,
      removedTxKind,
      removedCreditAmount,
      isCreditApplicationRemoval,
    },
    {
      notifyPaymentDeletedInBackground,
      notifyPaymentDeletedInAppInBackground,
      notifyInvoiceUpdatedInBackground,
    },
  );

  if (invoice.propertyId) {
    await ledgerService.applyAllUnappliedCreditToDueInvoices(invoice.propertyId);
  }

  return getInvoiceById(invoiceId);
};

const previewInvoicePaymentReversal = async (invoiceId, paymentTransactionId) => {
  const invoice = await Invoice.findOne({ _id: invoiceId, isDeleted: { $ne: true } });
  if (!invoice) throw new NotFoundError('Invoice not found');

  const tx = (invoice.paymentTransactions || []).id(paymentTransactionId);
  if (!tx) {
    throw Object.assign(new Error('Payment record not found'), { status: 404 });
  }
  if (tx.isDeleted === true) {
    throw Object.assign(new Error('Payment record already removed'), { status: 404 });
  }

  return previewRecordedPaymentReversal({ invoice, tx });
};

/**
 * Read-only FIFO payment allocation preview. Must match processInvoiceOverpayment.
 */
const previewInvoicePaymentAllocation = async (invoiceId, paymentAmount, accessContext = null) => {
  const amount = roundCurrency(paymentAmount);
  if (!(amount > 0)) {
    throw Object.assign(new Error('Payment amount must be positive'), { status: 400 });
  }

  const invoiceDoc = await Invoice.findOne({ _id: invoiceId, isDeleted: { $ne: true } });
  if (!invoiceDoc) throw new NotFoundError('Invoice not found');
  const { reconcileInvoiceStoredTotals } = require('../helpers/invoiceProcessingPayment.helper');
  await reconcileInvoiceStoredTotals(invoiceDoc);
  const invoice = typeof invoiceDoc.toObject === 'function' ? invoiceDoc.toObject() : invoiceDoc;

  const { getInvoiceCollectableBalance } = require('../helpers/invoicePaymentTransactions.helper');

  if (accessContext?.userId && isHOAOwnerRole(accessContext.role)) {
    const assignedOwnerIds = (invoice.tenants || []).map((tenant) => String(tenant?._id || tenant));
    if (!assignedOwnerIds.includes(String(accessContext.userId))) {
      const err = new Error('Invoice not found');
      err.status = 404;
      throw err;
    }
    // Also require unit/community ownership so an owner cannot preview another
    // owner's invoice allocation via a guessed invoice id alone.
    if (invoice.propertyId) {
      const hasUnitAccess = await ownerHasPropertyAccess(
        accessContext.userId,
        invoice.propertyId
      );
      if (!hasUnitAccess) {
        const err = new Error('Invoice not found');
        err.status = 404;
        throw err;
      }
    }
    const collectableBalance = roundCurrency(getInvoiceCollectableBalance(invoice));
    if (!(collectableBalance > 0)) {
      throw Object.assign(new Error('Invoice has no outstanding balance'), { status: 400 });
    }
    if (amount + 0.009 < collectableBalance) {
      const { assertHoaAcceptsPartialPaymentForInvoice } = require('../../hoa-settings/helpers/hoaPartialPaymentPolicy.helper');
      await assertHoaAcceptsPartialPaymentForInvoice(invoice, amount, collectableBalance);
    }
  }

  const unitId = invoice.propertyId;
  if (!unitId) {
    throw Object.assign(new Error('Invoice is not linked to a unit'), { status: 400 });
  }

  // Owner online Pay Now uses full chronological FIFO (including later open invoices).
  // Board Record Payment never prepays future invoices - excess becomes credit.
  const useFutureAllocation = accessContext?.allocateFutureInvoices != null
    ? Boolean(accessContext.allocateFutureInvoices)
    : isHOAOwnerRole(accessContext?.role);

  const preview = await ledgerService.previewInvoicePaymentAllocation({
    unitId,
    primaryInvoiceId: invoice._id,
    paymentAmount: amount,
    allocateFutureInvoices: useFutureAllocation,
  });

  return preview;
};

/**
 * Manually apply available unit credit to this invoice only, and clear the auto-credit pause.
 */
const applyCreditToInvoice = async (invoiceId, userId) => {
  const invoice = await Invoice.findOne({ _id: invoiceId, isDeleted: { $ne: true } });
  if (!invoice) throw new NotFoundError('Invoice not found');

  const { computeCollectableBalance } = require('../helpers/invoiceWaive.helper');
  const balanceDue = roundCurrency(computeCollectableBalance(invoice));
  if (balanceDue <= 0) {
    throw Object.assign(new Error('Invoice has no remaining balance to apply credit'), { status: 400 });
  }
  if (!invoice.propertyId) {
    throw Object.assign(new Error('Invoice is missing a property/unit'), { status: 400 });
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  let appliedAmount = 0;

  try {
    const propertyDoc = await Property.findById(invoice.propertyId).session(session);
    if (!propertyDoc) {
      throw Object.assign(new Error('Property/unit not found'), { status: 404 });
    }

    const pool = roundCurrency(Number(propertyDoc.remainingCredit || 0));
    if (pool <= 0) {
      throw Object.assign(new Error('No available credit balance to apply'), { status: 400 });
    }

    appliedAmount = roundCurrency(Math.min(pool, balanceDue));
    if (appliedAmount <= 0) {
      throw Object.assign(new Error('No available credit balance to apply'), { status: 400 });
    }

    const creditBalanceBefore = pool;
    const creditBalanceAfter = roundCurrency(pool - appliedAmount);
    const alreadyPaid = roundCurrency(Number(invoice.alreadyPaid || 0) + appliedAmount);
    let nextBalanceDue = roundCurrency(balanceDue - appliedAmount);
    let status = INVOICE_STATUS.PARTIALLY_PAID;
    let paidOn;
    if (nextBalanceDue <= 0) {
      nextBalanceDue = 0;
      status = INVOICE_STATUS.PAID;
      paidOn = ClockService.now();
    }

    const creditSources = await ledgerService.findActiveOverpaymentCreditSources(
      invoice.propertyId,
      session
    );
    const creditTxs = ledgerService.buildSlicedCreditAppliedTransactions({
      applyAmount: appliedAmount,
      startingBalanceDue: balanceDue,
      paidAt: paidOn || ClockService.now(),
      note: `Credit manually applied · Applied $${appliedAmount.toFixed(2)} from available credit balance`,
      source: 'manual_apply_credit',
      creditSources,
    });

    invoice.paymentTransactions = invoice.paymentTransactions || [];
    invoice.paymentTransactions.push(...creditTxs);
    invoice.alreadyPaid = alreadyPaid;
    invoice.balanceDue = nextBalanceDue;
    invoice.status = status;
    if (paidOn) invoice.paidOn = paidOn;

    const totals = recalculateInvoiceTotalsFromTransactions(invoice);
    invoice.alreadyPaid = totals.alreadyPaid;
    invoice.processingAmount = totals.processingAmount;
    invoice.balanceDue = totals.balanceDue;
    recalculateInvoiceStatus(invoice);
    clearInvoiceSkipAutoCredit(invoice);

    invoice.editHistory = invoice.editHistory || [];
    invoice.editHistory.push({
      changes: [
        'Credit Applied',
        `$${appliedAmount.toFixed(2)} available credit was applied manually.`,
        `Available credit: $${creditBalanceBefore.toFixed(2)} -> $${creditBalanceAfter.toFixed(2)}.`,
      ],
      editedBy: userId && mongoose.Types.ObjectId.isValid(String(userId))
        ? new mongoose.Types.ObjectId(String(userId))
        : undefined,
      editedAt: ClockService.now(),
    });

    propertyDoc.remainingCredit = creditBalanceAfter;
    await propertyDoc.save({ session });
    await invoice.save({ session });

    await new LedgerEntry({
      unitId: invoice.propertyId,
      type: 'adjustment',
      amount: 0,
      metadata: {
        reason: 'Manually applied available credit balance to invoice',
        source: 'manual_invoice_credit_application',
        invoiceId: invoice._id,
        invoiceNumber: invoice.invoiceId,
        appliedAmount,
        creditBalanceBefore,
        remainingCredit: creditBalanceAfter,
        createdBy: userId && mongoose.Types.ObjectId.isValid(String(userId))
          ? new mongoose.Types.ObjectId(String(userId))
          : undefined,
      },
    }).save({ session });

    await session.commitTransaction();
    session.endSession();
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }

  const property = await Property.findById(invoice.propertyId).select('name').lean();
  const actor = userId && mongoose.Types.ObjectId.isValid(String(userId))
    ? await User.findById(userId).select('firstName lastName email').lean()
    : null;
  const actorName = userDisplayName(actor) || 'a board member';
  await logActivity({
    userId,
    action: 'ADJUSTMENT',
    module: 'Invoice',
    entityId: invoice._id,
    entityName: 'Credit Applied',
    description: `$${appliedAmount.toFixed(2)} available credit was applied manually to invoice ${invoice.invoiceId || invoice._id} by ${actorName}.`,
    meta: {
      propertyId: String(invoice.propertyId || ''),
      propertyName: property?.name || '',
      appliedAmount,
    },
  });

  const invoiceNumber = invoice.invoiceId || String(invoice._id);
  notifyInvoiceUpdatedInBackground({
    invoice,
    recordedByUserId: userId,
    activityIntro: `A credit of ${formatAuditCurrency(appliedAmount)} has been applied to your invoice #${invoiceNumber}.`,
  });

  return getInvoiceById(invoiceId);
};

const EMPTY_LEGACY_INVOICE_STATISTICS = Object.freeze({
  totalInvoiceAmount: 0,
  totalOpenInvoice: 0,
  overdue: 0,
  partiallyPaid: 0,
  fullyPaid: 0,
  processingBalance: 0,
});

function buildEmptyInvoiceSummaryStatsPayload() {
  const hoaBoardSummary = { ...EMPTY_HOA_INVOICE_SUMMARY };
  const statusCounts = { ...EMPTY_INVOICE_STATUS_COUNTS };
  return {
    hoaBoardSummary,
    landlordSummary: hoaBoardSummary,
    statusCounts,
    summaryStats: mapAggregateToSummaryStats(hoaBoardSummary, statusCounts),
  };
}

/**
 * Build the Mongo match filter used by invoice statistics / summary-stats aggregates.
 * Same scope rules as getInvoices list filters.
 *
 * @param {Object} query
 * @param {Object|null} userContext
 * @param {{ includeStatus?: boolean }} [options]
 *   - includeStatus=true  → legacy /statistics (status chips affect totals)
 *   - includeStatus=false → listing KPI cards stay duration/scope scoped (ignore status)
 * @returns {Promise<object|null>} null when the caller has no accessible invoices
 */
async function buildInvoiceAggregateMatchFilter(query, userContext = null, { includeStatus = true } = {}) {
  const {
    propertyId,
    landlordId,
    unit,
    tenantId,
    ownerId,
    hoaOwnerId,
    paymentMethod,
    invoiceId,
    invoiceType,
    status: statusRaw,
    startDate,
    endDate,
    sentOn,
    paidOn,
    leaseId,
    minAmount,
    maxAmount,
    isPartialPaymentAllowed,
    createdBy,
    timePeriod,
    includePastDueOutstanding,
  } = query;
  const status = includeStatus ? statusRaw : undefined;
  const payerUserIdStats = tenantId || ownerId;
  const parsedMinAmount = parseNumberQuery(minAmount);
  const parsedMaxAmount = parseNumberQuery(maxAmount);
  const partialPaymentAllowed = parseBooleanQuery(isPartialPaymentAllowed);
  const includePastDueOutstandingFlag = parseBooleanQuery(includePastDueOutstanding);
  const includePriorOutstanding = shouldIncludeThisMonthPriorOutstanding({
    includePastDueOutstandingFlag,
    status,
    startDate,
    endDate,
  });

  if (startDate && endDate) {
    const start = parseDueDateQueryBound(startDate);
    const end = parseDueDateQueryBound(endDate, true);

    if (isNaN(start.getTime())) {
      throw new Error('Invalid startDate format. Expected format: YYYY-MM-DD');
    }
    if (isNaN(end.getTime())) {
      throw new Error('Invalid endDate format. Expected format: YYYY-MM-DD');
    }
    if (start > end) {
      throw new Error('startDate must be less than or equal to endDate');
    }
  }

  const filter = { isDeleted: { $ne: true }, generatedFrom: { $ne: 'late_fee' } };
  const hoaPropMatch = buildHoaBoardPropertyMatch(userContext);

  if (propertyId) {
    if (hoaPropMatch) {
      const prop = await Property.findOne({ _id: propertyId, ...hoaPropMatch }).select('_id').lean();
      if (!prop) return null;
    } else if (landlordId) {
      const safeLandlordId = toObjectId(landlordId);
      if (!safeLandlordId) return null;
      const prop = await Property.findOne({ _id: propertyId, landlord_id: safeLandlordId }).select('_id').lean();
      if (!prop) return null;
    }
    // Same ObjectId cast as getInvoices - aggregates use $match (no auto-cast).
    filter.propertyId = toObjectId(propertyId) || propertyId;
  } else if (hoaPropMatch) {
    const propIds = await resolveHoaPropertyIds(userContext);
    if (!propIds || propIds.length === 0) return null;
    filter.propertyId = { $in: propIds };
  } else if (landlordId) {
    const safeLandlordId = toObjectId(landlordId);
    if (!safeLandlordId) return null;
    const props = await Property.find({ landlord_id: safeLandlordId }).select('_id').lean();
    const propIds = (props || []).map((p) => p._id);
    if (!propIds || propIds.length === 0) return null;
    filter.propertyId = { $in: propIds };
  }

  // HOA Owner login, or board member filtering by the same owner.
  const scopedOwnerIdStats = toObjectId(hoaOwnerId || (hoaPropMatch ? payerUserIdStats : null));
  if (scopedOwnerIdStats) {
    const applied = await applyOwnerPayerInvoiceScope(filter, scopedOwnerIdStats);
    if (!applied) return null;
  } else if (hoaOwnerId) {
    return null;
  }

  if (unit) {
    const unitFilter = await resolveUnitListFilter(unit, filter.propertyId);
    if (unitFilter) filter.unit = unitFilter;
  }
  if (payerUserIdStats && !scopedOwnerIdStats) {
    const safePayerUserId = toObjectId(payerUserIdStats);
    if (safePayerUserId) filter.tenants = safePayerUserId;
  }
  applyPaymentMethodListFilter(filter, paymentMethod);
  if (invoiceId) filter._id = invoiceId;
  if (invoiceType) filter.type = expandHoaFeeTypeFilter(invoiceType);

  if (status) {
    applyHoaInvoiceListStatusFilter(filter, status, { startDate, endDate });
  }
  if (leaseId) filter.lease_id = leaseId;
  if (typeof partialPaymentAllowed === 'boolean') filter.isPartialPaymentAllowed = partialPaymentAllowed;
  if (createdBy) filter.createdBy = createdBy;

  if (parsedMinAmount !== undefined || parsedMaxAmount !== undefined) {
    filter.subAmount = {};
    if (parsedMinAmount !== undefined) filter.subAmount.$gte = parsedMinAmount;
    if (parsedMaxAmount !== undefined) filter.subAmount.$lte = parsedMaxAmount;
  }

  if (startDate || endDate) {
    const start = startDate ? parseDueDateQueryBound(startDate) : null;
    const end = endDate ? parseDueDateQueryBound(endDate, true) : null;
    if (includePriorOutstanding) {
      appendOwnerThisMonthPriorOutstandingDueDateOr(filter, startDate, endDate);
    } else if (!status) {
      filter.dueDate = { ...(filter.dueDate || {}) };
      if (start) filter.dueDate.$gte = start;
      if (end) filter.dueDate.$lte = end;
    } else if (!LIST_STATUSES_WITH_BUILTIN_DUEDATE.has(status)) {
      if (status === INVOICE_STATUS.OVERDUE && (filter.$or || filter.$and)) {
        appendDueDateRangeToOverdueBranches(filter, start, end);
      } else {
        filter.dueDate = { ...(filter.dueDate || {}) };
        if (start) filter.dueDate.$gte = start;
        if (end) filter.dueDate.$lte = end;
      }
    }
  } else if (status && !LIST_STATUSES_WITH_BUILTIN_DUEDATE.has(status) && timePeriod) {
    const { periodStart, periodEnd } = resolveTimePeriodDueDateRange(timePeriod);
    filter.dueDate = { ...(filter.dueDate || {}), $gte: periodStart, $lte: periodEnd };
  }

  if (sentOn) filter.createdAt = parseInstantQueryValue(sentOn, 'sentOn');
  if (paidOn) filter.paidOn = parsePaymentTimestamp(paidOn);

  return applyInvoiceListHoaFilter(filter, userContext);
}

/**
 * Get invoice statistics with same filters as getInvoices (legacy response shape).
 * @param {Object} query - Query parameters (same as getInvoices)
 * @returns {Object} - Statistics object
 */
const getInvoiceStatistics = async (query, userContext = null) => {
  const filterHoa = await buildInvoiceAggregateMatchFilter(query, userContext, { includeStatus: true });
  if (!filterHoa) {
    return { ...EMPTY_LEGACY_INVOICE_STATISTICS };
  }
  return aggregateInvoiceStatistics(filterHoa);
};

/**
 * Dedicated listing KPI summary: same aggregate math as list `hoaBoardSummary`,
 * but scoped only by duration (+ property/unit/owner/payment scope) — not by
 * status chips, search, or pagination. Used by board Income and owner invoice cards.
 *
 * @param {Object} query
 * @param {Object|null} userContext
 * @returns {Promise<{ hoaBoardSummary, landlordSummary, statusCounts, summaryStats }>}
 */
const getInvoiceSummaryStats = async (query, userContext = null) => {
  const filterHoa = await buildInvoiceAggregateMatchFilter(query, userContext, { includeStatus: false });
  if (!filterHoa) {
    return buildEmptyInvoiceSummaryStatsPayload();
  }

  const aggregated = await aggregateInvoiceSummaryAndCounts(filterHoa);
  const hoaBoardSummary = aggregated.landlordSummary;
  const statusCounts = aggregated.statusCounts;

  return {
    hoaBoardSummary,
    landlordSummary: hoaBoardSummary,
    statusCounts,
    summaryStats: mapAggregateToSummaryStats(hoaBoardSummary, statusCounts),
  };
};

/**
 * Export invoices as CSV with same filters as getInvoices
 * @param {Object} query - Query parameters (same as getInvoices)
 * @returns {Object} - { filename, csv }
 */
const exportInvoicesCsv = async (query, userContext = null) => {
  const { groupBy } = query;

  // Always export the full filtered set (never page-1 default of 10)
  const exportQuery = {
    ...query,
    pageNumber: 1,
    pageSize: 0,
  };

  // Reuse getInvoices function to get consistent data
  const result = await getInvoices(exportQuery, userContext);
  const data = result.data;

  // Generate CSV from the data
  const headers = ['Property/Shared By', 'Due On', 'Paid On', 'ID', 'Status', 'Unit', 'Amount', 'Paid', 'Balance'];
  if (groupBy === GROUP_BY.TENANT) headers.splice(1, 0, 'Property');

  const csvEscape = (val) => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const rows = [headers.join(',')];
  data.forEach(row => {
    const values = [
      csvEscape(row.propertySharedBy),
      ...(groupBy === GROUP_BY.TENANT ? [csvEscape(row.property)] : []),
      csvEscape(row.dueOn ? DateUtil.toISO(row.dueOn).split('T')[0] : ''),
      csvEscape(row.paidOn ? DateUtil.toISO(row.paidOn).split('T')[0] : ''),
      csvEscape(row.id),
      csvEscape(row.status),
      csvEscape(row.unit),
      csvEscape(row.amount),
      csvEscape(row.paid),
      csvEscape(row.balance)
    ];
    rows.push(values.join(','));
  });

  const csv = rows.join('\n');
  const timestamp = ClockService.now().toISOString().replace(/[:.]/g, '-').split('T')[0];
  const filename = `invoices_export_${timestamp}.csv`;

  return { filename, csv };
};

/**
 * Generate invoices from lease additional fees
 * @param {String} leaseId - Lease ID
 * @returns {Array} - Array of created invoices
 */

// Helper for non-recurring invoice
const handleNonRecurringInvoice = async (fee, lease, leaseId) => {
  const saved = await createInvoice({
    type: INVOICE_TYPES.OTHER,
    lease_id: leaseId,
    propertyId: lease.property_id._id,
    unit: lease.unitName,
    term: lease.term || 'N/A',
    tenants: lease.rentAndDepositDestribution.split.map(s => s.tenantId),
    invoiceItemDetails: fee.items.map(item => ({
      invoiceItem: item.name,
      description: item.description,
      quantity: item.quantity,
      rate: item.rate,
      amount: item.amount
    })),
    subAmount: fee.totalAmount,
    alreadyPaid: fee.alreadyPaid || 0,
    balanceDue: fee.balanceAmount,
    isPartialPaymentAllowed: lease.rentAndDepositDestribution.isPartialPaymentAllowed,
    dueDate: fee.dueDate
  });

  try {
    await sendInvoiceEmails(saved);
  } catch (err) {
    // Log and continue - do not fail invoice creation because of email issues
    logger.error('Error sending invoice email for non-recurring invoice:', err.message);
  }

  return saved;
};

/** YYYY-MM-DD calendar key for billing date comparisons (UTC midnight/noon safe). */
function calendarKey(value) {
  return billingCalendarDateKey(value);
}

/** Noon-UTC due date for calendar Y-M-D in app timezone (month is 1-based). */
function appCalendarDueDate(year, month1, day) {
  const clampedDay = Math.min(Math.max(1, Math.floor(Number(day) || 1)), lastDayOfAppMonth(year, month1));
  return parseDateOnlyToNoonUtc(
    `${year}-${String(month1).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`,
  );
}

function getAppWeekdayIndex(value) {
  const date = DateUtil.toUTC(value);
  if (!date) return -1;
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: APP_TIMEZONE, weekday: 'short' }).format(date);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[weekday] ?? -1;
}

function iterAppMonthDayKeys(year, month1) {
  const last = lastDayOfAppMonth(year, month1);
  const keys = [];
  for (let d = 1; d <= last; d += 1) {
    keys.push(`${year}-${String(month1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  return keys;
}

function getCurrentAppMonthYear() {
  const p = parseAppYmd(getTodayYmdInAppTimezone());
  if (!p) throw new Error('Unable to resolve today in app timezone');
  return { currentYear: p.y, currentMonth1: p.m };
}

function isCalendarKeyInRange(key, startDate, endDate) {
  const startKey = calendarKey(startDate);
  if (!startKey || !key) return false;
  if (endDate === 'No last date') return key >= startKey;
  const endKey = calendarKey(endDate);
  if (!endKey) return false;
  return key >= startKey && key <= endKey;
}

function isCurrentAppMonthInRange(month1, year, startDate, endDate) {
  const currentMonthStartKey = `${year}-${String(month1).padStart(2, '0')}-01`;
  const startKey = calendarKey(startDate);
  if (!startKey) return false;
  if (endDate === 'No last date') return currentMonthStartKey >= startKey;
  const endKey = calendarKey(endDate);
  if (!endKey) return false;
  return currentMonthStartKey >= startKey && currentMonthStartKey <= endKey;
}

// Helper for recurring invoice with lineItemOnRentalInvoice = true
const handleRecurringLineItemOnRentalInvoice = async (fee, lease, leaseId, currentMonth1, currentYear) => {
  if (isCurrentAppMonthInRange(currentMonth1, currentYear, fee.startDate, fee.endDate)) {
    const rentInvoice = await Invoice.findOne({
      lease_id: leaseId,
      type: INVOICE_TYPES.RENT,
      status: { $nin: [INVOICE_STATUS.PAID] }
    });
    if (rentInvoice) {
      fee.items.forEach(item => {
        rentInvoice.invoiceItemDetails.push({
          invoiceItem: item.name,
          description: item.description,
          quantity: item.quantity,
          rate: item.rate,
          amount: item.amount
        });
      });
      rentInvoice.subAmount += fee.totalAmount;
      rentInvoice.alreadyPaid += fee.alreadyPaid || 0;
      rentInvoice.balanceDue += fee.balanceAmount;
      await rentInvoice.save();
      return rentInvoice;
    }
  }
  return null;
};

// Helper for recurring invoice with lineItemOnRentalInvoice = false
const handleRecurringSeparateInvoices = async (fee, lease, leaseId, currentMonth1, currentYear) => {
  const invoices = [];
  const generatedDates = await generateDatesForFrequency(fee.frequency, fee, leaseId, currentMonth1, currentYear);
  for (const date of generatedDates) {
    if (isDateInRange(date, fee.startDate, fee.endDate)) {
      const invoice = await createInvoice({
        type: INVOICE_TYPES.OTHER,
        lease_id: leaseId,
        propertyId: lease.property_id._id,
        unit: lease.unitName,
        term: lease.term || 'N/A',
        tenants: lease.rentAndDepositDestribution.split.map(s => s.tenantId),
        invoiceItemDetails: fee.items.map(item => ({
          invoiceItem: item.name,
          description: item.description,
          quantity: item.quantity,
          rate: item.rate,
          amount: item.amount
        })),
        subAmount: fee.totalAmount,
        alreadyPaid: fee.alreadyPaid || 0,
        balanceDue: fee.balanceAmount,
        isPartialPaymentAllowed: lease.rentAndDepositDestribution.isPartialPaymentAllowed,
        dueDate: date
      });
      invoices.push(invoice);
      try {
        await sendInvoiceEmails(invoice);
      } catch (err) {
        logger.error('Error sending invoice email for recurring separate invoice:', err.message);
      }
    }
  }
  return invoices;
};

const generateInvoicesFromLease = async (leaseId) => {
  const lease = await Lease.findById(leaseId).populate('property_id');
  if (!lease) throw new NotFoundError('Lease not found');

  const createdInvoices = [];
  const { currentYear, currentMonth1 } = getCurrentAppMonthYear();

  for (const fee of lease.additionalFees) {
    switch (true) {
      case !fee.isRecurringInvoice:
        createdInvoices.push(await handleNonRecurringInvoice(fee, lease, leaseId));
        break;
      case fee.isRecurringInvoice && fee.lineItemOnRentalInvoice:
        const rentInvoice = await handleRecurringLineItemOnRentalInvoice(fee, lease, leaseId, currentMonth1, currentYear);
        if (rentInvoice) createdInvoices.push(rentInvoice);
        break;
      case fee.isRecurringInvoice && !fee.lineItemOnRentalInvoice:
        const invoices = await handleRecurringSeparateInvoices(fee, lease, leaseId, currentMonth1, currentYear);
        createdInvoices.push(...invoices);
        break;
      default:
        // Optionally handle unexpected cases
        break;
    }
  }

  return createdInvoices;
};

const isDateInRange = (date, startDate, endDate) => {
  const key = calendarKey(date);
  if (!key) return false;
  return isCalendarKeyInRange(key, startDate, endDate);
};

const generateDatesForFrequency = async (frequency, fee, leaseId, currentMonth1, currentYear) => {
  const dates = [];

  switch (frequency.toLowerCase()) {
    case 'monthly': {
      const day = parseInt(fee.dueOn, 10);
      if (day) {
        dates.push(appCalendarDueDate(currentYear, currentMonth1, day));
      }
      break;
    }

    case 'semi-annually': {
      if (fee.semiAnnualDates && Array.isArray(fee.semiAnnualDates)) {
        fee.semiAnnualDates.forEach(dateConfig => {
          const month1 = parseInt(dateConfig.month, 10);
          const day = parseInt(dateConfig.day, 10);
          if (!isNaN(month1) && !isNaN(day)) {
            dates.push(appCalendarDueDate(currentYear, month1, day));
          }
        });
      }
      break;
    }

    case 'bi-monthly': {
      if (fee.biMonthlyDates && Array.isArray(fee.biMonthlyDates)) {
        fee.biMonthlyDates.forEach(day => {
          const dayNum = parseInt(day, 10);
          if (!isNaN(dayNum)) {
            dates.push(appCalendarDueDate(currentYear, currentMonth1, dayNum));
          }
        });
      }
      break;
    }

    case 'weekly': {
      const weekDay = getDayOfWeek(fee.dayOfWeek);
      if (weekDay !== -1) {
        for (const ymd of iterAppMonthDayKeys(currentYear, currentMonth1)) {
          if (getAppWeekdayIndex(ymd) === weekDay) {
            dates.push(parseDateOnlyToNoonUtc(ymd));
          }
        }
      }
      break;
    }

    case 'bi-weekly': {
      const biWeeklyDay = getDayOfWeek(fee.dayOfWeek);
      if (biWeeklyDay !== -1) {
        for (const ymd of iterAppMonthDayKeys(currentYear, currentMonth1)) {
          if (getAppWeekdayIndex(ymd) !== biWeeklyDay) continue;
          const dueDate = parseDateOnlyToNoonUtc(ymd);
          const prevWeekStart = parseDateOnlyToNoonUtc(shiftAppYmdDays(ymd, -7));
          const prevWeekEnd = DateUtil.endOfDayEST(shiftAppYmdDays(ymd, -1));
          try {
            const existingInvoice = await Invoice.findOne({
              lease_id: leaseId,
              type: INVOICE_TYPES.OTHER,
              dueDate: { $gte: prevWeekStart, $lte: prevWeekEnd }
            });
            if (!existingInvoice) {
              dates.push(dueDate);
            }
          } catch (err) {
            logger.error('Error checking bi-weekly invoice existence:', err);
            dates.push(dueDate);
          }
        }
      }
      break;
    }

    case 'custom': {
      if (fee.customDates && Array.isArray(fee.customDates)) {
        fee.customDates.forEach(dateStr => {
          const customDate = DateUtil.toUTC(dateStr);
          if (customDate) {
            dates.push(customDate);
          }
        });
      }
      break;
    }
  }

  return dates;
};

const getDayOfWeek = (dayName) => {
  if (!dayName || typeof dayName !== 'string') return -1;
  const days = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  const normalizedDay = dayName.toLowerCase().trim();
  return days.hasOwnProperty(normalizedDay) ? days[normalizedDay] : -1;
};

/**
 * Generate invoices for both Rent and Deposit based on lease ID
 * @param {String} leaseId - Lease ID
 * @param {Date} depositDueDate - Due date for deposit invoice
 * @returns {Array} - Array of created invoices
 */
const generateRentAndDepositInvoices = async (leaseId, depositDueDate) => {
  // Input validation
  if (!leaseId || typeof leaseId !== 'string') {
    throw new Error('Valid lease ID is required');
  }
  if (!depositDueDate || !(depositDueDate instanceof Date)) {
    throw new Error('Valid deposit due date is required');
  }

  let lease;
  try {
    lease = await Lease.findById(leaseId).populate('property_id');
  } catch (error) {
    throw new Error(`Database error while fetching lease: ${error.message}`);
  }

  if (!lease) throw new NotFoundError('Lease not found');
  if (!lease.property_id) throw new Error('Property not found for lease');
  if (!lease.rentAndDepositDestribution?.split?.length) {
    throw new Error('No tenants found in lease');
  }

  const createdInvoices = [];
  const { currentYear, currentMonth1 } = getCurrentAppMonthYear();
  const leaseStartKey = calendarKey(lease.start_date);
  const leaseEndKey = calendarKey(lease.end_date);

  // Generate Deposit Invoice
  if (lease.depositDetails?.amount > 0) {
    try {
      const depositInvoice = await createInvoice({
        type: INVOICE_TYPES.DEPOSIT,
        lease_id: leaseId,
        propertyId: lease.property_id._id,
        unit: lease.unitName,
        term: lease.term || 'N/A',
        tenants: lease.rentAndDepositDestribution.split.map(s => s.tenantId),
        invoiceItemDetails: [{
          invoiceItem: INVOICE_TYPES.DEPOSIT,
          description: INVOICE_TYPES.DEPOSIT,
          quantity: 1,
          rate: lease.depositDetails.amount,
          amount: lease.depositDetails.amount
        }],
        subAmount: lease.depositDetails.amount,
        alreadyPaid: 0,
        balanceDue: lease.depositDetails.amount,
        isPartialPaymentAllowed: lease.rentAndDepositDestribution.isPartialPaymentAllowed,
        dueDate: depositDueDate
      });
      createdInvoices.push(depositInvoice);
      try {
        await sendInvoiceEmails(depositInvoice);
      } catch (err) {
        logger.error('Error sending invoice email for deposit invoice:', err.message);
      }
    } catch (error) {
      throw new Error(`Failed to create deposit invoice: ${error.message}`);
    }
  }

  // Generate Rent Invoices
  if (!lease.rentDetails?.frequency || !lease.rentDetails?.amount) {
    return createdInvoices;
  }

  try {
    const rentDates = await generateRentDates(
      lease.rentDetails,
      currentMonth1,
      currentYear,
      leaseStartKey,
      leaseEndKey,
      leaseId
    );

    for (const rentDate of rentDates) {
      const monthYear = formatMonthYearInAppTimezone(rentDate, { month: 'short' });

      const rentInvoice = await createInvoice({
        type: INVOICE_TYPES.FEES,
        lease_id: leaseId,
        propertyId: lease.property_id._id,
        unit: lease.unitName,
        term: lease.term || 'N/A',
        tenants: lease.rentAndDepositDestribution.split.map(s => s.tenantId),
        invoiceItemDetails: [{
          invoiceItem: INVOICE_TYPES.FEES,
          description: `${INVOICE_TYPES.FEES} ${monthYear}`,
          quantity: 1,
          rate: lease.rentDetails.amount,
          amount: lease.rentDetails.amount
        }],
        subAmount: lease.rentDetails.amount,
        alreadyPaid: 0,
        balanceDue: lease.rentDetails.amount,
        isPartialPaymentAllowed: lease.rentAndDepositDestribution.isPartialPaymentAllowed,
        dueDate: rentDate
      });
      createdInvoices.push(rentInvoice);
      try {
        await sendInvoiceEmails(rentInvoice);
      } catch (err) {
        logger.error('Error sending invoice email for rent invoice:', err.message);
      }
    }
  } catch (error) {
    throw new Error(`Failed to generate rent invoices: ${error.message}`);
  }

  return createdInvoices;
};

/**
 * Generate rent dates based on frequency
 */
const generateRentDates = async (rentDetails, currentMonth1, currentYear, leaseStartKey, leaseEndKey, leaseId) => {
  if (!rentDetails?.frequency) {
    throw new Error('Invalid rent details: frequency is required');
  }

  const frequency = rentDetails.frequency.toLowerCase();
  const rentDates = [];
  const isInLeaseRange = (dueDate) => {
    const key = calendarKey(dueDate);
    if (!key || !leaseStartKey || !leaseEndKey) return false;
    return key >= leaseStartKey && key <= leaseEndKey;
  };

  try {
    switch (frequency) {
      case FREQUENCY_TYPES.MONTHLY: {
        if (!rentDetails.dueOne) {
          throw new Error('dueOne is required for monthly frequency');
        }
        const day = parseInt(rentDetails.dueOne, 10);
        if (isNaN(day) || day < 1 || day > 31) {
          throw new Error('Invalid day for monthly frequency');
        }
        const monthlyDate = appCalendarDueDate(currentYear, currentMonth1, day);
        if (isInLeaseRange(monthlyDate)) {
          rentDates.push(monthlyDate);
        }
        break;
      }

      case FREQUENCY_TYPES.BI_MONTHLY: {
        if (!rentDetails.dueOne || !rentDetails.dueTwo) {
          throw new Error('Both dueOne and dueTwo are required for bi-monthly frequency');
        }
        const day1 = parseInt(rentDetails.dueOne, 10);
        const day2 = parseInt(rentDetails.dueTwo, 10);
        if (isNaN(day1) || day1 < 1 || day1 > 31 || isNaN(day2) || day2 < 1 || day2 > 31) {
          throw new Error('Invalid days for bi-monthly frequency');
        }

        [day1, day2].forEach(day => {
          const biMonthlyDate = appCalendarDueDate(currentYear, currentMonth1, day);
          if (isInLeaseRange(biMonthlyDate)) {
            rentDates.push(biMonthlyDate);
          }
        });
        break;
      }

      case FREQUENCY_TYPES.WEEKLY: {
        if (!rentDetails.dayOfWeek) {
          throw new Error('dayOfWeek is required for weekly frequency');
        }
        const weekDay = getDayOfWeek(rentDetails.dayOfWeek);
        if (weekDay === -1) {
          throw new Error('Invalid weekday for weekly frequency');
        }

        for (const ymd of iterAppMonthDayKeys(currentYear, currentMonth1)) {
          if (getAppWeekdayIndex(ymd) !== weekDay) continue;
          const dueDate = parseDateOnlyToNoonUtc(ymd);
          if (isInLeaseRange(dueDate)) {
            rentDates.push(dueDate);
          }
        }
        break;
      }

      case FREQUENCY_TYPES.BI_WEEKLY: {
        if (!rentDetails.dayOfWeek) {
          throw new Error('dayOfWeek is required for bi-weekly frequency');
        }
        const biWeeklyDay = getDayOfWeek(rentDetails.dayOfWeek);
        if (biWeeklyDay === -1) {
          throw new Error('Invalid weekday for bi-weekly frequency');
        }

        for (const ymd of iterAppMonthDayKeys(currentYear, currentMonth1)) {
          if (getAppWeekdayIndex(ymd) !== biWeeklyDay) continue;
          const dueDate = parseDateOnlyToNoonUtc(ymd);
          if (!isInLeaseRange(dueDate)) continue;

          const prevWeekStart = parseDateOnlyToNoonUtc(shiftAppYmdDays(ymd, -7));

          const existingInvoice = await Invoice.findOne({
            lease_id: leaseId,
            type: INVOICE_TYPES.RENT,
            dueDate: { $gte: prevWeekStart, $lt: dueDate }
          });

          if (!existingInvoice) {
            rentDates.push(dueDate);
          }
        }
        break;
      }

      default:
        throw new Error(`Unsupported frequency: ${frequency}`);
    }
  } catch (error) {
    throw new Error(`Error generating rent dates: ${error.message}`);
  }

  return rentDates;
};
/**
 * Generate invoices from lease using firstRentalInvoiceDue and deposit due date logic
 * - Rent: generate only if rentDetails.firstRentalInvoiceDue falls within current month
 * - Deposit: generate only if depositDetails.due falls within current month
 * @param {String} leaseId
 * @returns {Array} created invoices
 */
const generateInvoicesFromLeaseDueDates = async (leaseId) => {
  if (!leaseId || typeof leaseId !== 'string') throw new Error('Valid lease ID is required');

  const lease = await Lease.findById(leaseId).populate('property_id');
  if (!lease) throw new NotFoundError('Lease not found');
  if (!lease.property_id) throw new Error('Property not found for lease');
  if (!lease.rentAndDepositDestribution?.split?.length) throw new Error('No tenants found in lease');

  const created = [];
  const { currentYear, currentMonth1 } = getCurrentAppMonthYear();

  const isInCurrentMonth = (d) => {
    const key = calendarKey(d);
    if (!key) return false;
    const parts = parseAppYmd(key);
    return Boolean(parts && parts.y === currentYear && parts.m === currentMonth1);
  };

  // Deposit: only generate if deposit due date is in current month
  try {
    if (isInCurrentMonth(lease.depositDetails?.due)) {
      const depositAmount = lease.depositDetails?.amount || 0;
      const depositInvoice = await createInvoice({
        type: INVOICE_TYPES.DEPOSIT,
        lease_id: leaseId,
        propertyId: lease.property_id._id,
        unit: lease.unitName,
        term: lease.term || 'N/A',
        tenants: lease.rentAndDepositDestribution.split.map(s => s.tenantId),
        invoiceItemDetails: [{
          invoiceItem: INVOICE_TYPES.DEPOSIT,
          description: INVOICE_TYPES.DEPOSIT,
          quantity: 1,
          rate: depositAmount,
          amount: depositAmount
        }],
        subAmount: depositAmount,
        alreadyPaid: 0,
        balanceDue: depositAmount,
        isPartialPaymentAllowed: lease.rentAndDepositDestribution.isPartialPaymentAllowed,
        dueDate: DateUtil.toUTC(lease.depositDetails.due)
      });
      created.push(depositInvoice);
      try {
        await sendInvoiceEmails(depositInvoice);
      } catch (err) {
        logger.error('Error sending invoice email for deposit invoice (dueDates):', err.message);
      }
    }
  } catch (err) {
    throw new Error(`Failed to create deposit invoice: ${err.message}`);
  }

  // Rent: only generate if firstRentalInvoiceDue exists and falls within current month
  try {
    const firstDue = lease.rentDetails?.firstRentalInvoiceDue;
    if (firstDue && isInCurrentMonth(firstDue)) {
      const monthYear = formatMonthYearInAppTimezone(firstDue, { month: 'short' });

      const rentInvoice = await createInvoice({
        type: INVOICE_TYPES.FEES,
        lease_id: leaseId,
        propertyId: lease.property_id._id,
        unit: lease.unitName,
        term: lease.term || 'N/A',
        tenants: lease.rentAndDepositDestribution.split.map(s => s.tenantId),
        invoiceItemDetails: [{
          invoiceItem: INVOICE_TYPES.FEES,
          description: `${INVOICE_TYPES.FEES} ${monthYear}`,
          quantity: 1,
          rate: lease.rentDetails.amount,
          amount: lease.rentDetails.amount
        }],
        subAmount: lease.rentDetails.amount,
        alreadyPaid: 0,
        balanceDue: lease.rentDetails.amount,
        isPartialPaymentAllowed: lease.rentAndDepositDestribution.isPartialPaymentAllowed,
        dueDate: DateUtil.toUTC(firstDue)
      });
      created.push(rentInvoice);
      try {
        await sendInvoiceEmails(rentInvoice);
      } catch (err) {
        logger.error('Error sending invoice email for rent invoice (dueDates):', err.message);
      }
    }
  } catch (err) {
    throw new Error(`Failed to create rent invoice: ${err.message}`);
  }

  return created;
};

/**
 * Add user note to an invoice (stored in comments with full note metadata).
 */
const addInvoiceNote = async (id, noteData, userId, files = []) => {
  const invoice = await Invoice.findById(id);
  if (!invoice) throw new NotFoundError('Invoice not found');

  const text = String(noteData.description || noteData.text || '').trim();
  const uploadedDocs = await uploadFilesToS3(files);
  const createdMetadata = await createDocumentMetadataFromUploads(uploadedDocs);
  const attachmentIds = createdMetadata.map((md) => md._id);

  if (!text && attachmentIds.length === 0) {
    throw Object.assign(new Error('Note description or at least one attachment is required'), { status: 400 });
  }

  const now = ClockService.now();
  const note = {
    text: text || 'Attachment added.',
    title: noteData.title ? String(noteData.title).trim() : '',
    isPinned: Boolean(noteData.isPinned),
    isImportant: Boolean(noteData.isImportant),
    reminder: noteData.reminder ? (DateUtil.toUTC(noteData.reminder) || undefined) : undefined,
    reminderNotifiedAt: undefined,
    isSystem: false,
    createdBy: userId,
    updatedBy: userId,
    createdAt: now,
    updatedAt: now,
    attachments: attachmentIds,
  };

  invoice.comments = invoice.comments || [];
  invoice.comments.push(note);

  if (createdMetadata.length > 0) {
    invoice.documents = invoice.documents || [];
    invoice.documents.push(...buildInvoiceDocumentsPayload(createdMetadata, userId));
  }

  const saved = await invoice.save();

  await logEntityNoteActivity({
    userId,
    module: 'Invoice',
    entityId: saved._id,
    entityName: `Invoice ${saved.invoiceId}`,
    action: 'created',
    noteTitle: note.title,
    notePreview: note.text,
    meta: attachmentIds.length > 0 ? { attachmentCount: attachmentIds.length } : undefined,
  });

  if (note.reminder) {
    await logEntityNoteActivity({
      userId,
      module: 'Invoice',
      entityId: saved._id,
      entityName: `Invoice ${saved.invoiceId}`,
      action: 'reminder_set',
      noteTitle: note.title,
      notePreview: note.text,
      meta: { reminder: note.reminder },
    });
  }

  return getInvoiceById(saved._id);
};

const updateInvoiceNote = async (id, noteId, noteData, userId, files = []) => {
  const invoice = await Invoice.findById(id);
  if (!invoice) throw new NotFoundError('Invoice not found');

  const note = invoice.comments?.id(noteId);
  if (!note || note.isSystem) throw Object.assign(new Error('Note not found'), { status: 404 });

  const prevPinned = Boolean(note.isPinned);
  const prevImportant = Boolean(note.isImportant);
  const prevReminder = note.reminder ? DateUtil.toEpoch(note.reminder) : null;

  if (noteData.description !== undefined || noteData.text !== undefined) {
    note.text = String(noteData.description ?? noteData.text ?? '').trim();
  }
  if (noteData.title !== undefined) note.title = String(noteData.title || '').trim();
  if (typeof noteData.isPinned === 'boolean') note.isPinned = noteData.isPinned;
  if (typeof noteData.isImportant === 'boolean') note.isImportant = noteData.isImportant;
  if (noteData.reminder !== undefined) {
    note.reminder = noteData.reminder ? (DateUtil.toUTC(noteData.reminder) || null) : null;
    note.reminderNotifiedAt = null;
  }

  const removedAttachmentIds = await removeAttachmentsFromNote(note, noteData.removeAttachmentIds);
  if (removedAttachmentIds.length > 0) {
    const removedSet = new Set(removedAttachmentIds.map(String));
    invoice.documents = (invoice.documents || []).filter(
      (doc) => !removedSet.has(String(doc.metadataId)),
    );
  }

  const uploadedDocs = await uploadFilesToS3(files);
  const createdMetadata = await createDocumentMetadataFromUploads(uploadedDocs);
  if (createdMetadata.length > 0) {
    const newAttachmentIds = createdMetadata.map((md) => md._id);
    note.attachments = [...(note.attachments || []), ...newAttachmentIds];
    invoice.documents = invoice.documents || [];
    invoice.documents.push(...buildInvoiceDocumentsPayload(createdMetadata, userId));
  }

  const hasText = Boolean(String(note.text || '').trim());
  const hasAttachments = Array.isArray(note.attachments) && note.attachments.length > 0;
  if (!hasText && !hasAttachments) {
    throw Object.assign(new Error('Note description or at least one attachment is required'), { status: 400 });
  }
  if (!hasText && hasAttachments) {
    note.text = 'Attachment added.';
  }

  note.updatedBy = userId;
  note.updatedAt = ClockService.now();

  const saved = await invoice.save();

  const contentChanged =
    noteData.description !== undefined ||
    noteData.text !== undefined ||
    noteData.title !== undefined ||
    removedAttachmentIds.length > 0 ||
    createdMetadata.length > 0;

  if (typeof noteData.isPinned === 'boolean' && noteData.isPinned !== prevPinned) {
    await logEntityNoteActivity({
      userId,
      module: 'Invoice',
      entityId: saved._id,
      entityName: `Invoice ${saved.invoiceId}`,
      action: noteData.isPinned ? 'pinned' : 'unpinned',
      noteTitle: note.title,
      notePreview: note.text,
    });
  }
  if (typeof noteData.isImportant === 'boolean' && noteData.isImportant !== prevImportant) {
    await logEntityNoteActivity({
      userId,
      module: 'Invoice',
      entityId: saved._id,
      entityName: `Invoice ${saved.invoiceId}`,
      action: noteData.isImportant ? 'important' : 'unimportant',
      noteTitle: note.title,
      notePreview: note.text,
    });
  }
  if (contentChanged) {
    await logEntityNoteActivity({
      userId,
      module: 'Invoice',
      entityId: saved._id,
      entityName: `Invoice ${saved.invoiceId}`,
      action: 'updated',
      noteTitle: note.title,
      notePreview: note.text,
    });
  }

  const nextReminder = note.reminder ? DateUtil.toEpoch(note.reminder) : null;
  if (noteData.reminder !== undefined) {
    await logEntityNoteActivity({
      userId,
      module: 'Invoice',
      entityId: saved._id,
      entityName: `Invoice ${saved.invoiceId}`,
      action: nextReminder ? (prevReminder ? 'reminder_updated' : 'reminder_set') : 'reminder_cleared',
      noteTitle: note.title,
      notePreview: note.text,
      meta: { reminder: note.reminder },
    });
  }

  return getInvoiceById(saved._id);
};

const deleteInvoiceNote = async (id, noteId, userId) => {
  const invoice = await Invoice.findById(id);
  if (!invoice) throw new NotFoundError('Invoice not found');

  const note = invoice.comments?.id(noteId);
  if (!note || note.isSystem) throw Object.assign(new Error('Note not found'), { status: 404 });

  await logEntityNoteActivity({
    userId,
    module: 'Invoice',
    entityId: invoice._id,
    entityName: `Invoice ${invoice.invoiceId}`,
    action: 'deleted',
    noteTitle: note.title,
    notePreview: note.text,
  });

  note.deleteOne();
  await invoice.save();
  return getInvoiceById(invoice._id);
};

/** Legacy comment endpoint - forwards to structured note create. */
const addComment = async (id, text, userId) => addInvoiceNote(id, { description: text }, userId);

const formatReminderMoney = (value) => `$${roundCurrency(value).toFixed(2)}`;

const escapeHtmlText = (value) =>
  String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const getInvoicePortalBaseUrl = () =>
  String(
    process.env.HOA_FRONTEND_BASE_URL ||
    process.env.INVOICE_BASE_URL ||
    process.env.FRONTEND_BASE_URL ||
    process.env.APP_URL ||
    'https://app.propmv.com'
  ).replace(/\/$/, '');

const getInvoiceDescriptionLabel = (invoice) => {
  const items = invoice.invoiceItemDetails || [];
  if (items.length === 1) {
    return items[0].description || items[0].invoiceItem || invoice.term || invoice.type || 'Invoice';
  }
  if (items.length > 1) {
    return items
      .map((item) => item.description || item.invoiceItem)
      .filter(Boolean)
      .join('; ');
  }
  return invoice.term || invoice.type || 'Invoice';
};

const buildPaymentReminderPortalUrls = (invoiceObjectId) => {
  const base = getInvoicePortalBaseUrl();
  const id = encodeURIComponent(String(invoiceObjectId));
  // HOA owners receive reminders - links target the owner invoices portal, not board /income routes.
  const ownerInvoicesPath = `${base}/invoices`;
  return {
    paymentUrl: `${ownerInvoicesPath}/${id}`,
    viewInvoiceUrl: `${ownerInvoicesPath}/${id}`,
    paymentHistoryUrl: `${ownerInvoicesPath}?history=1`,
    downloadInvoiceUrl: `${ownerInvoicesPath}/${id}&download=1`,
  };
};

const buildPaymentReminderEmailData = (invoice, {
  ownerName,
  invoiceType,
  emailBody,
  senderCompany,
  senderPhone,
  senderEmail,
  organizationDisplayName,
}) => {
  const effectiveStatus = getEffectiveInvoiceStatus(invoice);
  const urls = buildPaymentReminderPortalUrls(invoice._id);
  const invoiceNumber = invoice.invoiceId || String(invoice._id);
  const sanitizedBody = sanitizePaymentReminderCustomMessage(emailBody);

  return {
    recipientName: ownerName || 'there',
    ownerName: ownerName || 'there',
    invoiceType: invoiceType || invoice.type || 'Invoice',
    invoiceNumber,
    propertyName: invoice.propertyName || 'N/A',
    unitNumber: resolveInvoiceUnitNumber(invoice),
    invoiceDescription: getInvoiceDescriptionLabel(invoice),
    invoiceAmount: formatReminderMoney(invoice.subAmount),
    outstandingBalance: formatReminderMoney(invoice.balanceDue),
    dueDate: invoice.dueDate ? formatEmailDate(invoice.dueDate) : 'N/A',
    invoiceStatus: effectiveStatus || invoice.status || 'Pending',
    customMessage: sanitizedBody ? escapeHtmlText(sanitizedBody) : '',
    hasCustomMessage: Boolean(sanitizedBody),
    senderCompany: senderCompany || organizationDisplayName,
    senderPhone: senderPhone || '',
    senderEmail: senderEmail || '',
    ...urls,
  };
};

const resolveReminderRecipientName = (email, payers, fallbackName) => {
  const normalized = String(email || '').trim().toLowerCase();
  const match = (payers || []).find((p) => String(p.email || '').trim().toLowerCase() === normalized);
  if (match) {
    const name = `${match.firstName || ''} ${match.lastName || ''}`.trim();
    if (name) return name;
  }
  return fallbackName || 'Owner';
};

const getWaivedLineItemIndices = (invoice) => getActiveWaivedLineItemIndices(invoice);

const waiveInvoiceBalance = async (id, body, userId) => {
  const trimmedReason = String(body.reason || '').trim();
  const lineItemIndex = Number(body.lineItemIndex);

  if (!trimmedReason) {
    throw Object.assign(new Error('Waive reason is required'), { status: 400 });
  }
  if (!Number.isInteger(lineItemIndex) || lineItemIndex < 0) {
    throw Object.assign(new Error('A valid invoice line item must be selected'), { status: 400 });
  }

  const invoice = await Invoice.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!invoice) throw new NotFoundError('Invoice not found');

  const effectiveStatus = getEffectiveInvoiceStatus(invoice);
  if (effectiveStatus === INVOICE_STATUS.PAID) {
    throw Object.assign(new Error('Invoice is already fully paid'), { status: 400 });
  }
  if (effectiveStatus === INVOICE_STATUS.WAIVED) {
    throw Object.assign(new Error('Invoice balance is already waived'), { status: 400 });
  }

  const balanceDue = roundCurrency(invoice.balanceDue || 0);
  if (balanceDue <= 0) {
    throw Object.assign(new Error('No outstanding balance to waive'), { status: 400 });
  }

  const items = Array.isArray(invoice.invoiceItemDetails) ? invoice.invoiceItemDetails : [];
  const lineItem = items[lineItemIndex];
  if (!lineItem) {
    throw Object.assign(new Error('Selected invoice line item was not found'), { status: 400 });
  }

  const waivedLineItemIndices = getWaivedLineItemIndices(invoice);
  if (waivedLineItemIndices.has(lineItemIndex)) {
    throw Object.assign(new Error('This line item has already been waived'), { status: 400 });
  }

  const unwaivedLateFeeIndices = items
    .map((item, idx) => ({ item, idx }))
    .filter(({ item, idx }) => isLateFeeLineItem(item) && !waivedLineItemIndices.has(idx))
    .map(({ idx }) => idx);
  const selectingLateFee = isLateFeeLineItem(lineItem);

  if (unwaivedLateFeeIndices.length > 0 && !selectingLateFee) {
    throw Object.assign(
      new Error('Waive late fee line item(s) before waiving the principal invoice amount'),
      { status: 400 }
    );
  }

  const waiveAmount = roundCurrency(lineItem.amount || 0);
  if (waiveAmount <= 0) {
    throw Object.assign(new Error('Selected line item has no amount to waive'), { status: 400 });
  }
  if (waiveAmount > balanceDue) {
    throw Object.assign(
      new Error(
        `Cannot waive ${formatAuditCurrency(waiveAmount)} for "${lineItem.invoiceItem || 'line item'}" because only ${formatAuditCurrency(balanceDue)} remains outstanding`
      ),
      { status: 400 }
    );
  }

  const newBalance = roundCurrency(balanceDue - waiveAmount);
  invoice.balanceDue = newBalance;
  invoice.waivedAmount = roundCurrency((invoice.waivedAmount || 0) + waiveAmount);
  invoice.waivedBy = userId;
  invoice.waivedAt = ClockService.now();
  invoice.waiveReason = trimmedReason;

  invoice.waiveHistory = invoice.waiveHistory || [];
  invoice.waiveHistory.push({
    amount: waiveAmount,
    reason: trimmedReason,
    lineItemIndex,
    invoiceItem: lineItem.invoiceItem || '',
    lineItemDescription: lineItem.description || '',
    waivedBy: userId,
    waivedAt: ClockService.now(),
  });

  // Same rule as Record Payment / Credits: full waive → Waived; waive after payment → Paid.
  recalculateInvoiceStatus(invoice);

  if (userId) {
    invoice.updatedBy = userId;
  }

  await invoice.save();

  const property = await Property.findById(invoice.propertyId).select('name').lean();
  const propertyName = property?.name || 'Unknown Property';

  await logActivity({
    userId,
    action: 'STATUS_CHANGE',
    module: 'Invoice',
    entityId: invoice._id,
    hoaId: invoice.hoaId || undefined,
    entityName: 'HOA Invoice',
    description: `Waived ${formatAuditCurrency(waiveAmount)} (${lineItem.invoiceItem || 'line item'}) for ${propertyName} - Invoice ${invoice.invoiceId}`,
    meta: {
      type: invoice.type,
      waivedAmount: waiveAmount,
      lineItemIndex,
      invoiceItem: lineItem.invoiceItem || '',
      reason: trimmedReason,
      propertyName,
      newStatus: invoice.status,
    },
  });

  notifyInvoiceBalanceWaivedInBackground({
    invoice,
    waivedAmount: waiveAmount,
    remainingBalance: newBalance,
    waivedAt: invoice.waivedAt,
    reason: trimmedReason,
    waivedByUserId: userId,
  });
  notifyInvoiceWaivedInAppInBackground(invoice, userId, waiveAmount);

  try {
    const { schedulePayloadAutopayMirrorSync } = require('../../../../../shared/modules/payment/providers/payload/helpers/schedulePayloadAutopayMirrorSync');
    schedulePayloadAutopayMirrorSync(invoice._id, { reason: 'invoice_waived' });
  } catch (_) { /* autopay optional */ }

  return getInvoiceById(invoice._id);
};

const reverseWaiveInvoiceBalance = async (id, userId) => {
  const invoice = await Invoice.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!invoice) throw new NotFoundError('Invoice not found');

  const result = applyInvoiceWaiveReversal(invoice, {
    userId,
    now: ClockService.now(),
  });

  invoice.markModified('waiveHistory');
  invoice.markModified('waiveReversalHistory');
  if (userId) {
    invoice.updatedBy = userId;
  }

  await invoice.save();

  const property = await Property.findById(invoice.propertyId).select('name').lean();
  const propertyName = property?.name || 'Unknown Property';

  await logActivity({
    userId,
    action: 'STATUS_CHANGE',
    module: 'Invoice',
    entityId: invoice._id,
    hoaId: invoice.hoaId || undefined,
    entityName: 'HOA Invoice',
    description: `Reversed waiver of ${formatAuditCurrency(result.reverseAmount)} for ${propertyName} - Invoice ${invoice.invoiceId}`,
    meta: {
      type: invoice.type,
      reversedAmount: result.reverseAmount,
      propertyName,
      previousStatus: result.previousStatus,
      newStatus: invoice.status,
    },
  });

  try {
    const { schedulePayloadAutopayMirrorSync } = require('../../../../../shared/modules/payment/providers/payload/helpers/schedulePayloadAutopayMirrorSync');
    schedulePayloadAutopayMirrorSync(invoice._id, { reason: 'invoice_waive_reversed' });
  } catch (_) { /* autopay optional */ }

  return getInvoiceById(invoice._id);
};

const sendPaymentReminder = async (invoiceId, body, senderId) => {
  const { to, subject, emailBody, ownerName, invoiceType, senderCompany, senderPhone, senderEmail } = body;

  const invoice = await Invoice.findById(invoiceId)
    .populate('tenants', 'firstName lastName email')
    .populate('propertyId', 'name unitDetails associatedOwnerIds')
    .exec();
  if (!invoice) throw Object.assign(new Error('Invoice not found'), { status: 404 });

  const effectiveStatus = getEffectiveInvoiceStatus(invoice);
  if (effectiveStatus === INVOICE_STATUS.PAID || effectiveStatus === INVOICE_STATUS.WAIVED) {
    throw Object.assign(new Error('Invoice is already fully paid'), { status: 400 });
  }
  if (roundCurrency(invoice.balanceDue || 0) <= 0) {
    throw Object.assign(new Error('Invoice has no remaining balance'), { status: 400 });
  }

  const [sender, branding] = await Promise.all([
    User.findById(senderId).lean(),
    resolveInvoiceEmailBranding(invoice),
  ]);
  const resolvedSenderEmail = senderEmail || sender?.email || process.env.FROM_EMAIL || '';
  const resolvedSenderPhone = senderPhone || sender?.phone || '';
  const resolvedSenderCompany = senderCompany || branding.organizationDisplayName;
  const invoiceNumber = invoice.invoiceId || String(invoice._id);
  const resolvedSubject = subject || buildInvoiceEmailSubject(`Payment Reminder - ${invoiceNumber}`, branding);

  const payers = filterInvoiceTenantsToCurrentOwners({
    ...invoice.toObject(),
    tenants: (invoice.tenants || []).map((t) =>
      (t && typeof t.toObject === 'function' ? t.toObject() : t)
    ),
    propertyId: invoice.propertyId && typeof invoice.propertyId.toObject === 'function'
      ? invoice.propertyId.toObject()
      : invoice.propertyId,
  });

  const recipients = Array.isArray(to) ? to : [to];

  invoice.reminderHistory = invoice.reminderHistory || [];
  invoice.reminderHistory.push({
    recipients,
    subject: resolvedSubject,
    sentBy: senderId,
    sentAt: ClockService.now()
  });

  const auditText = `Payment reminder sent for Invoice ${invoiceNumber} to ${recipients.join(', ')}.`;
  invoice.comments = invoice.comments || [];
  invoice.comments.push({
    text: auditText,
    isSystem: true,
    createdBy: senderId,
    updatedBy: senderId,
    createdAt: ClockService.now(),
    updatedAt: ClockService.now(),
  });
  await invoice.save();

  const payerIds = payers
    .map((t) => (t && t._id ? String(t._id) : null))
    .filter(Boolean);
  const portalUrls = buildPaymentReminderPortalUrls(invoice._id);
  const reminderMeta = {
    invoiceNumber,
    propertyName: invoice.propertyName,
    unit: invoice.unit,
    balanceDue: invoice.balanceDue,
    dueDate: invoice.dueDate,
    status: getEffectiveInvoiceStatus(invoice),
    recipients,
    subject: resolvedSubject,
  };

  setImmediate(() => {
    Promise.all(recipients.map((email) => {
      const recipientName = resolveReminderRecipientName(email, payers, ownerName);
      const emailData = buildPaymentReminderEmailData(invoice, {
        ownerName: recipientName,
        invoiceType,
        emailBody,
        senderCompany: resolvedSenderCompany,
        senderPhone: resolvedSenderPhone,
        senderEmail: resolvedSenderEmail,
        organizationDisplayName: branding.organizationDisplayName,
      });

      return emailHelper.sendEmail(
        'payment-reminder',
        email,
        {
          ...emailData,
          communityName: branding.communityName,
          organizationDisplayName: branding.organizationDisplayName,
        },
        {
          subject: resolvedSubject,
          template: 'payment-reminder',
          preheaderText: buildPaymentReminderPreheader({
            invoiceNumber: emailData.invoiceNumber,
            outstandingBalance: emailData.outstandingBalance,
            dueDate: emailData.dueDate,
          }),
          hoaId: invoice.hoaId,
          senderUserId: senderId,
          communityName: branding.communityName || resolvedSenderCompany,
          // Recipients are invoice owner emails selected in the UI; skip RCPT/MX re-probes.
          skipRecipientValidation: true,
        }
      );
    })).catch((err) => {
      console.error('[invoice] payment reminder email failed:', err?.message || err);
    });

    logActivity({
      userId: senderId,
      action: 'REMINDER_SENT',
      module: 'Invoice',
      entityId: invoice._id,
      entityName: `Invoice ${invoiceNumber}`,
      description: `Payment reminder sent for Invoice ${invoiceNumber}.`,
      meta: reminderMeta,
    }).catch((err) => {
      console.error('[invoice] payment reminder activity log failed:', err?.message || err);
    });

    if (payerIds.length) {
      notify(
        EVENTS.PAYMENT_REMINDER,
        {
          invoiceNumber,
          propertyName: invoice.propertyName || 'your property',
          unit: resolveInvoiceUnitName(invoice),
          unitName: resolveInvoiceUnitName(invoice),
          amount: invoice.balanceDue,
          balanceDueFormatted: formatReminderMoney(invoice.balanceDue),
          dueDate: invoice.dueDate ? formatDateInAppTimezone(invoice.dueDate) : '',
          status: getEffectiveInvoiceStatus(invoice),
          paymentUrl: portalUrls.paymentUrl,
          viewInvoiceUrl: portalUrls.viewInvoiceUrl,
        },
        payerIds,
        { invoiceId: String(invoice._id), invoiceNumber }
      ).catch((err) => {
        logger.error('[invoice] payment reminder in-app notify failed:', err?.message || err);
      });
    }
  });

  return { sentTo: recipients };
};

/**
 * Build the invoice match filter used by dashboard collection stats (summary + unit counts).
 * @returns {Promise<import('mongoose').FilterQuery<object>|null>} null when scope has no properties
 */
async function buildInvoiceDashboardMatchFilter({ landlordId, startDate, endDate, userContext = null }) {
  if ((startDate && !endDate) || (!startDate && endDate)) {
    throw new Error('Both startDate and endDate must be provided together');
  }

  const filter = { isDeleted: { $ne: true }, generatedFrom: { $ne: 'late_fee' } };
  const hoaPropMatch = buildHoaBoardPropertyMatch(userContext);

  if (hoaPropMatch) {
    const propIds = await resolveHoaPropertyIds(userContext);
    if (!propIds || propIds.length === 0) return null;
    filter.propertyId = { $in: propIds };
  } else if (landlordId) {
    const safeLandlordId = toObjectId(landlordId);
    if (!safeLandlordId) return null;
    const props = await Property.find({ landlord_id: safeLandlordId }).select('_id').lean();
    const propIds = (props || []).map((p) => p._id);
    if (!propIds || propIds.length === 0) return null;
    filter.propertyId = { $in: propIds };
  }

  if (startDate && endDate) {
    filter.dueDate = {
      $gte: parseDueDateQueryBound(startDate),
      $lte: parseDueDateQueryBound(endDate, true),
    };
  }

  return applyInvoiceListHoaFilter(filter, userContext);
}

/**
 * Count distinct portfolio units (properties) that currently have a past-due balance.
 * Uses the same unpaid-invoice aggregation as the property list, so one unit with
 * multiple overdue invoices is counted once.
 */
async function countUnitsWithOverdueBalance({ landlordId, userContext = null }) {
  const matchFilter = await buildInvoiceDashboardMatchFilter({ landlordId, userContext });
  if (!matchFilter) return 0;

  const propertyIds = matchFilter.propertyId?.$in
    ? [...matchFilter.propertyId.$in]
    : matchFilter.propertyId
      ? [matchFilter.propertyId]
      : [];
  if (propertyIds.length === 0) return 0;

  const summary = await Invoice.aggregateUnpaidSummaryByPropertyIds(propertyIds, ClockService.now());
  return (summary.byProperty || []).filter((row) => Number(row.pastDueAmount || 0) > 0).length;
}

/** Start of the current calendar billing period (YYYY-MM-01) in app timezone. */
function getCurrentBillingPeriodStartKey() {
  const { currentYear, currentMonth1 } = getCurrentAppMonthYear();
  return `${currentYear}-${String(currentMonth1).padStart(2, '0')}-01`;
}

/**
 * Outstanding overdue balances with due dates before `beforeDate`.
 * Paid / waived invoices are excluded by the summary aggregation; partial payments
 * contribute only their remaining balanceDue.
 *
 * Dashboard Past Overdue uses the start of the **current** billing period so the
 * amount stays stable when the dashboard date-range filter changes.
 */
async function getPastOverdueSummary({ landlordId, beforeDate, userContext = null }) {
  if (!beforeDate) {
    return { pastOverdueAmount: 0, pastOverdueCount: 0 };
  }

  const matchFilter = await buildInvoiceDashboardMatchFilter({ landlordId, userContext });
  if (!matchFilter) {
    return { pastOverdueAmount: 0, pastOverdueCount: 0 };
  }

  matchFilter.dueDate = { $lt: parseDueDateQueryBound(beforeDate) };
  const aggregated = await aggregateInvoiceSummaryAndCounts(matchFilter);

  return {
    pastOverdueAmount: aggregated.landlordSummary?.overdueAmount || 0,
    pastOverdueCount: aggregated.statusCounts?.overdue || 0,
  };
}

/**
 * Aggregate-only invoice summary for dashboard date ranges (avoids full getInvoices list path).
 * Also returns pastOverdueAmount for outstanding overdue invoices due before the
 * current billing period (independent of the selected `startDate`/`endDate` window).
 */
async function getInvoiceDashboardSummary({ landlordId, startDate, endDate, userContext = null }) {
  const matchFilter = await buildInvoiceDashboardMatchFilter({ landlordId, startDate, endDate, userContext });
  if (!matchFilter) {
    return {
      hoaBoardSummary: { ...EMPTY_HOA_INVOICE_SUMMARY },
      landlordSummary: { ...EMPTY_HOA_INVOICE_SUMMARY },
      statusCounts: { ...EMPTY_INVOICE_STATUS_COUNTS },
    };
  }

  const [aggregated, pastOverdue] = await Promise.all([
    aggregateInvoiceSummaryAndCounts(matchFilter),
    getPastOverdueSummary({
      landlordId,
      beforeDate: getCurrentBillingPeriodStartKey(),
      userContext,
    }),
  ]);

  const landlordSummary = {
    ...aggregated.landlordSummary,
    pastOverdueAmount: pastOverdue.pastOverdueAmount,
    pastOverdueCount: pastOverdue.pastOverdueCount,
  };

  return {
    hoaBoardSummary: landlordSummary,
    landlordSummary,
    statusCounts: aggregated.statusCounts,
  };
}

module.exports = {
  createInvoice,
  getInvoices,
  getInvoiceDashboardSummary,
  getPastOverdueSummary,
  countUnitsWithOverdueBalance,
  getInvoiceById,
  updateInvoice,
  deleteInvoice,
  deleteInvoicePayment,
  previewInvoicePaymentReversal,
  previewInvoicePaymentAllocation,
  applyCreditToInvoice,
  getInvoiceStatistics,
  getInvoiceSummaryStats,
  exportInvoicesCsv,
  generateInvoicesFromLease,
  generateRentAndDepositInvoices,
  generateInvoicesFromLeaseDueDates,
  addComment,
  addInvoiceNote,
  updateInvoiceNote,
  deleteInvoiceNote,
  sendPaymentReminder,
  waiveInvoiceBalance,
  reverseWaiveInvoiceBalance,
  getEffectiveInvoiceStatus,
  isDerivedOverdue,
  resolveInvoiceDepositBankDisplay,
  normalizeDepositBankLabel,
  appendDepositBankChangeHistory,
  logDepositBankChangeForUnitInvoices,
  getPolicyTermJobStatus: invoiceGenerationJobService.getPolicyTermJobStatus,
  // Exported for unit tests (cross-invoice Activity Timeline reconstruction)
  buildActivityTimelineAndReminderCount,
};
