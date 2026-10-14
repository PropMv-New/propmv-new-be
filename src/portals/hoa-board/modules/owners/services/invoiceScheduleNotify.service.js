const logger = require('../../../../../common/logger');

/**
 * ------------------------------------------------------------------
 * File: invoiceScheduleNotify.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * invoiceScheduleMeta.service, unit.service, unitInvoice.service, unitScheduleRecalc.service
 * ------------------------------------------------------------------
 */
const { notify, EVENTS } = require('../../../../../common/notifications');
const {
  resolveBoardMemberIds,
  resolvePropertyOwnerUserIds,
} = require('../../../../../common/helpers/hoaRecipientResolver');
const {
  sendConsolidatedNextYearInvoiceCreatedEmails,
  sendConsolidatedScheduleInvoiceCreatedEmails,
  getInvoiceCalendarYear,
} = require('../../../../../common/helpers/invoiceLifecycleEmail.service');
const { enqueueOrRunInBackground } = require('../../../../../common/jobs/enqueue');
const { JOB_TYPES } = require('../../../../../common/jobs/constants');
const { buildJobIdempotencyKey, hashFingerprint } = require('../../../../../common/jobs/idempotency');
const { runHoaNotifyInBackground } = require('../../../../../common/helpers/hoaNotifyDispatch.helper');
const { notifyInvoiceCreatedInAppInBackground } = require('../../../../../common/helpers/hoaInAppNotify.helper');
const { getDateKeyInTimeZone, APP_TIMEZONE } = require('../../../../../common/helpers/hoaBillingDates');
const { ClockService } = require('../../../../../common/date');
const { resolveBoardMemberUserIds } = require('../helpers/hoaBoardMemberIds.helper');

function getCurrentCalendarYear() {
  const key = getDateKeyInTimeZone(ClockService.now(), APP_TIMEZONE);
  return key ? key.slice(0, 4) : String(ClockService.now().getUTCFullYear());
}

function isNextYearInvoice(invoice) {
  if (!invoice?.dueDate) return false;
  const currentYear = getCurrentCalendarYear();
  const dueYear = getInvoiceCalendarYear(invoice.dueDate);
  return dueYear > currentYear;
}

function filterNextYearInvoices(invoices = []) {
  return (Array.isArray(invoices) ? invoices : []).filter((inv) => inv && inv._id && isNextYearInvoice(inv));
}

function groupInvoicesByBillingYear(invoices = []) {
  const map = new Map();
  for (const invoice of invoices) {
    const year = getInvoiceCalendarYear(invoice.dueDate);
    if (!map.has(year)) map.set(year, []);
    map.get(year).push(invoice);
  }
  return map;
}

function buildNextYearIdempotencyKey(hoaId, billingYear, invoiceIds = []) {
  const sorted = [...invoiceIds].map(String).sort().join(',');
  return `next_year_invoices:${hoaId || 'unknown'}:${billingYear}:${sorted}`;
}

async function groupOwnerInvoicesByUser(invoices = []) {
  const map = new Map();
  for (const invoice of invoices) {
    const ownerIds = new Set();
    for (const tenant of invoice.tenants || []) {
      const id = tenant && (tenant._id || tenant);
      if (id) ownerIds.add(String(id));
    }
    if (ownerIds.size === 0 && invoice.propertyId) {
      // eslint-disable-next-line no-await-in-loop
      const propertyOwners = await resolvePropertyOwnerUserIds(invoice.propertyId);
      for (const ownerId of propertyOwners) ownerIds.add(ownerId);
    }
    for (const ownerId of ownerIds) {
      if (!map.has(ownerId)) map.set(ownerId, []);
      const list = map.get(ownerId);
      if (!list.some((row) => String(row._id) === String(invoice._id))) {
        list.push(invoice);
      }
    }
  }
  return map;
}

async function sendNextYearOwnerInAppNotifications({ hoaId, billingYear, invoices = [] }) {
  const ownerGroups = await groupOwnerInvoicesByUser(invoices);
  const invoiceIds = invoices.map((inv) => String(inv._id));
  const idempotencyBase = buildNextYearIdempotencyKey(hoaId, billingYear, invoiceIds);

  let sent = 0;
  for (const [ownerUserId, ownerInvoices] of ownerGroups.entries()) {
    const data = {
      billingYear,
      invoiceCount: ownerInvoices.length,
      context: 'schedule_extension',
    };
    // eslint-disable-next-line no-await-in-loop
    await notify(
      EVENTS.NEXT_YEAR_INVOICES_CREATED_OWNER,
      data,
      ownerUserId,
      {
        hoaId: hoaId ? String(hoaId) : undefined,
        billingYear,
        invoiceCount: ownerInvoices.length,
        invoiceIds: ownerInvoices.map((inv) => String(inv._id)),
        context: 'next_year_schedule_extension',
        audience: 'owner',
      },
      { idempotencyKey: `${idempotencyBase}:owner:${ownerUserId}` },
    );
    sent += 1;
  }
  return { sent };
}

async function sendNextYearBoardInAppNotifications({ hoaId, billingYear, invoices = [] }) {
  if (!hoaId) return { sent: 0 };
  const boardIds = await resolveBoardMemberIds(hoaId);
  if (boardIds.length === 0) return { sent: 0 };

  const invoiceIds = invoices.map((inv) => String(inv._id));
  const idempotencyBase = buildNextYearIdempotencyKey(hoaId, billingYear, invoiceIds);
  const data = {
    billingYear,
    invoiceCount: invoices.length,
    context: 'schedule_extension',
  };

  await notify(
    EVENTS.NEXT_YEAR_INVOICES_CREATED_BOARD,
    data,
    boardIds,
    {
      hoaId: String(hoaId),
      billingYear,
      invoiceCount: invoices.length,
      invoiceIds,
      context: 'next_year_schedule_extension',
      audience: 'board',
    },
    { idempotencyKey: `${idempotencyBase}:board` },
  );
  return { sent: boardIds.length };
}

/**
 * In-app notifications for automatically generated next-year schedule invoices.
 */
async function sendNextYearInvoicesCreatedInAppNotifications({
  invoices = [],
  hoaId = null,
}) {
  const nextYearInvoices = filterNextYearInvoices(invoices);
  if (nextYearInvoices.length === 0) return { sent: 0 };

  const resolvedHoaId = hoaId || nextYearInvoices[0]?.hoaId;
  const byYear = groupInvoicesByBillingYear(nextYearInvoices);
  let sent = 0;

  for (const [billingYear, yearInvoices] of byYear.entries()) {
    // eslint-disable-next-line no-await-in-loop
    const ownerResult = await sendNextYearOwnerInAppNotifications({
      hoaId: resolvedHoaId,
      billingYear,
      invoices: yearInvoices,
    });
    // eslint-disable-next-line no-await-in-loop
    const boardResult = await sendNextYearBoardInAppNotifications({
      hoaId: resolvedHoaId,
      billingYear,
      invoices: yearInvoices,
    });
    sent += (ownerResult.sent || 0) + (boardResult.sent || 0);
  }

  return { sent };
}

/**
 * Send consolidated next-year invoice-created emails (owners + board members).
 * One email per recipient per calendar year.
 */
function notifyNextYearInvoiceCreatedEmails(invoices = [], options = {}) {
  const list = filterNextYearInvoices(
    Array.isArray(invoices) ? invoices.filter((inv) => inv && inv._id) : [],
  );
  if (list.length === 0) return 0;

  const invoiceIds = list.map((inv) => String(inv._id));
  const fingerprint = hashFingerprint(invoiceIds.join(','));

  const deliver = async () => {
    try {
      await sendConsolidatedNextYearInvoiceCreatedEmails(list);
    } catch (err) {
      logger.error(
        '[invoiceScheduleNotify] consolidated next-year invoice emails failed:',
        err?.message || err,
      );
    }
  };

  if (options.background === false) {
    return deliver().then(() => list.length);
  }

  enqueueOrRunInBackground({
    jobType: JOB_TYPES.EMAIL_INVOICE_SCHEDULE_SUMMARY,
    entityType: 'Invoice',
    entityId: invoiceIds[0] || '',
    eventId: fingerprint,
    idempotencyKey: buildJobIdempotencyKey('EMAIL_NEXT_YEAR_INVOICE_SUMMARY', fingerprint),
    payload: { invoiceIds, mode: 'next_year' },
    run: deliver,
  });

  return list.length;
}

/**
 * In-app invoice_created for schedule-generated invoices (board + owners).
 * Uses the same idempotency key as manual create so duplicates are safe.
 */
function notifyScheduleInvoiceCreatedInApp(invoices = []) {
  const list = Array.isArray(invoices)
    ? invoices.filter((inv) => inv && inv._id)
    : [];
  if (list.length === 0) return 0;

  for (const invoice of list) {
    notifyInvoiceCreatedInAppInBackground(invoice, null);
  }
  return list.length;
}

/**
 * Send consolidated invoice-created emails for schedule invoices (including future months).
 * One email is sent per owner per calendar year, summarizing all invoices in that year.
 *
 * Also queues per-invoice in-app notifications so board/owner bells update immediately
 * (emails alone previously left the in-app feed empty for schedule generation).
 *
 * Use for initial owner assignment / billing setup. Cron schedule extensions use
 * notifyNextYearInvoiceCreatedEmails instead.
 */
function notifyScheduleInvoiceCreatedEmails(invoices = [], options = {}) {
  const list = Array.isArray(invoices)
    ? invoices.filter((inv) => inv && inv._id)
    : [];
  if (list.length === 0) return 0;

  // In-app is immediate and independent of the email job worker.
  notifyScheduleInvoiceCreatedInApp(list);

  const invoiceIds = list.map((inv) => String(inv._id));
  const fingerprint = hashFingerprint(invoiceIds.join(','));

  const deliver = async () => {
    try {
      await sendConsolidatedScheduleInvoiceCreatedEmails(list);
    } catch (err) {
      logger.error(
        '[invoiceScheduleNotify] consolidated invoice-created emails failed:',
        err?.message || err,
      );
    }
  };

  if (options.background === false) {
    return deliver().then(() => list.length);
  }

  enqueueOrRunInBackground({
    jobType: JOB_TYPES.EMAIL_INVOICE_SCHEDULE_SUMMARY,
    entityType: 'Invoice',
    entityId: invoiceIds[0] || '',
    eventId: fingerprint,
    idempotencyKey: buildJobIdempotencyKey('EMAIL_INVOICE_SCHEDULE_SUMMARY', fingerprint),
    payload: { invoiceIds },
    run: deliver,
  });

  return list.length;
}

/**
 * Notify owners and board when next-year schedule invoices are auto-generated.
 */
async function notifyNextYearInvoicesCreated({
  invoices = [],
  unit = null,
  hoaId = null,
  options = {},
}) {
  const nextYearInvoices = filterNextYearInvoices(invoices);
  if (nextYearInvoices.length === 0) return;

  const resolvedHoaId = hoaId || unit?.hoaId || nextYearInvoices[0]?.hoaId;

  runHoaNotifyInBackground(
    () => sendNextYearInvoicesCreatedInAppNotifications({
      invoices: nextYearInvoices,
      hoaId: resolvedHoaId,
    }),
    'next-year schedule invoices in-app notify',
  );

  notifyNextYearInvoiceCreatedEmails(nextYearInvoices, options);
}

/**
 * Batch notify after a multi-unit extension run (cron without per-unit defer).
 */
async function notifyNextYearInvoicesCreatedBatch(invoices = []) {
  const nextYearInvoices = filterNextYearInvoices(invoices);
  if (nextYearInvoices.length === 0) return;

  const byHoa = new Map();
  for (const invoice of nextYearInvoices) {
    const hoaKey = invoice.hoaId ? String(invoice.hoaId) : 'unknown';
    if (!byHoa.has(hoaKey)) byHoa.set(hoaKey, []);
    byHoa.get(hoaKey).push(invoice);
  }

  runHoaNotifyInBackground(async () => {
    for (const [hoaKey, hoaInvoices] of byHoa.entries()) {
      const hoaId = hoaKey === 'unknown' ? null : hoaKey;
      // eslint-disable-next-line no-await-in-loop
      await sendNextYearInvoicesCreatedInAppNotifications({ invoices: hoaInvoices, hoaId });
    }
  }, 'next-year batch schedule invoices in-app notify');

  notifyNextYearInvoiceCreatedEmails(nextYearInvoices);
}

/**
 * Notify owners and board members when schedule invoices are auto-generated.
 * Routes next-year invoices to dedicated high-priority notifications;
 * current-year (and other) invoices get standard invoice_created in-app events.
 */
async function notifyScheduleInvoicesGenerated({
  unit,
  invoiceCount = 0,
  context = 'schedule',
  invoices = [],
}) {
  if (!unit || invoiceCount <= 0) return;

  const invoiceList = Array.isArray(invoices) && invoices.length > 0
    ? invoices
    : [];

  if (invoiceList.length > 0) {
    const nextYear = filterNextYearInvoices(invoiceList);
    const currentYear = invoiceList.filter(
      (inv) => inv && inv._id && !isNextYearInvoice(inv),
    );

    if (currentYear.length > 0) {
      notifyScheduleInvoiceCreatedInApp(currentYear);
    }

    if (nextYear.length > 0) {
      await notifyNextYearInvoicesCreated({
        invoices: nextYear,
        unit,
        hoaId: unit.hoaId,
      });
    }
    return;
  }

  // Fallback when invoice docs are not passed (legacy callers)
  if (invoiceCount > 0) {
    runHoaNotifyInBackground(
      () => sendNextYearInvoicesCreatedInAppNotifications({
        invoices: [],
        hoaId: unit.hoaId,
      }),
      'schedule invoices generated in-app notify (no invoice docs)',
    );
  }
}

module.exports = {
  notifyScheduleInvoicesGenerated,
  notifyScheduleInvoiceCreatedEmails,
  notifyScheduleInvoiceCreatedInApp,
  notifyNextYearInvoiceCreatedEmails,
  notifyNextYearInvoicesCreated,
  notifyNextYearInvoicesCreatedBatch,
  sendNextYearInvoicesCreatedInAppNotifications,
  resolveBoardMemberUserIds,
  filterNextYearInvoices,
  isNextYearInvoice,
  getCurrentCalendarYear,
};
