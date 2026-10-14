/**
 * HOA in-app notification helpers.
 *
 * Resolves dependent users (all board members, property owners, assignees, payers)
 * and dispatches via notify(). Board members and affected owners (including the actor) all receive a copy.
 */

const mongoose = require('mongoose');
const { EVENTS } = require('../notifications');
const {
  toIdString,
  excludeActor,
  resolveMaintenanceNotificationRecipients,
  resolveVendorInvoiceNotificationRecipients,
  resolveExpenseNotificationRecipients,
  resolveInvoiceLifecycleRecipients,
  resolveInvoicePaymentRecipients,
  resolveVendorNotificationRecipients,
} = require('./hoaRecipientResolver');
const logger = require('../logger');
const {
  runHoaNotifyInBackground,
  dispatchHoaInAppNotification,
} = require('./hoaNotifyDispatch.helper');

/** Always stamp hoaId onto metadata so board-member community filtering keeps the bell count accurate. */
function notify(event, data, recipients, metadata = {}, options = {}) {
  return dispatchHoaInAppNotification(event, data, recipients, metadata, options);
}

function runInBackground(task, label = 'in-app notify') {
  runHoaNotifyInBackground(task, label);
}

/**
 * Shared HOA in-app dispatch. Matches document uploads: run immediately in
 * the background so delivery does not depend on the job worker / Redis.
 */
function enqueueInAppNotify(handler, payload, run, extra = {}) {
  runHoaNotifyInBackground(run, handler || extra.entityType || 'in-app notify');
}

function toObjectId(value) {
  const str = String(
    value && typeof value === 'object' && value._id ? value._id : value ?? ''
  ).trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function dedupeIds(ids = []) {
  return [...new Set(ids.map(toIdString).filter(Boolean))];
}

function maintenanceUnitName(doc = {}) {
  return doc.unitName || doc.units || 'Unit';
}

function maintenanceTitle(doc = {}) {
  return doc.title || 'Maintenance request';
}

function maintenanceMetadata(doc, extra = {}) {
  const hoaId = doc?.hoaId
    ? toIdString(doc.hoaId)
    : (doc?.property_id?.hoaId ? toIdString(doc.property_id.hoaId) : undefined);
  return {
    maintenanceRequestId: doc?._id ? String(doc._id) : undefined,
    entityType: 'maintenance',
    entityId: doc?._id ? String(doc._id) : undefined,
    hoaId,
    ...extra,
  };
}

function expenseMetadata(expense, extra = {}) {
  return {
    expenseId: expense?._id ? String(expense._id) : undefined,
    entityType: 'expense',
    entityId: expense?._id ? String(expense._id) : undefined,
    hoaId: expense?.hoaId ? String(expense.hoaId) : undefined,
    propertyId: toIdString(expense?.property || expense?.propertyId) || undefined,
    ...extra,
  };
}

async function ensureMaintenanceHoaId(doc) {
  if (doc?.hoaId) return doc;
  try {
    const { resolveHoaIdForMaintenance } = require('./hoaRecipientResolver');
    const hoaId = await resolveHoaIdForMaintenance(doc);
    if (!hoaId) return doc;
    const plain = doc?.toObject ? doc.toObject() : { ...doc };
    plain.hoaId = hoaId;
    return plain;
  } catch {
    return doc;
  }
}

async function ensureExpenseHoaId(expense) {
  if (expense?.hoaId) return expense;
  try {
    const { resolveHoaIdFromProperty, resolveExpensePropertyId } = require('./hoaRecipientResolver');
    const propertyId = resolveExpensePropertyId(expense);
    const hoaId = propertyId ? await resolveHoaIdFromProperty(propertyId) : '';
    if (!hoaId) return expense;
    const plain = expense?.toObject ? expense.toObject() : { ...expense };
    plain.hoaId = hoaId;
    return plain;
  } catch {
    return expense;
  }
}

function invoiceMetadata(invoice, extra = {}) {
  return {
    invoiceId: invoice?._id ? String(invoice._id) : undefined,
    entityType: 'invoice',
    entityId: invoice?._id ? String(invoice._id) : undefined,
    hoaId: invoice?.hoaId ? String(invoice.hoaId) : undefined,
    propertyId: invoice?.propertyId ? String(invoice.propertyId) : undefined,
    ...extra,
  };
}

async function ensureInvoiceHoaId(invoice) {
  if (invoice?.hoaId) return invoice;
  try {
    const { resolveHoaIdFromProperty } = require('./hoaRecipientResolver');
    const propertyId = toIdString(invoice?.propertyId);
    const hoaId = propertyId ? await resolveHoaIdFromProperty(propertyId) : '';
    if (!hoaId) return invoice;
    const plain = invoice?.toObject ? invoice.toObject() : { ...invoice };
    plain.hoaId = hoaId;
    return plain;
  } catch {
    return invoice;
  }
}

async function notifyMaintenanceCreatedInApp(doc, actorUserId = null, options = {}) {
  try {
    const scoped = await ensureMaintenanceHoaId(doc);
    const recipients = await resolveMaintenanceNotificationRecipients(scoped, actorUserId);
    if (!recipients.length) return { sent: 0 };

    const unitName = options.unitName || maintenanceUnitName(scoped);
    const ticketId = toIdString(scoped?._id);
    await notify(
      EVENTS.MAINTENANCE_REQUEST_CREATED,
      { title: maintenanceTitle(scoped), unitName },
      recipients,
      maintenanceMetadata(scoped),
      { idempotencyKey: `maintenance_created:${ticketId}` }
    );
    return { sent: recipients.length };
  } catch (err) {
    logger.error('notifyMaintenanceCreatedInApp failed', err);
    return { sent: 0 };
  }
}

async function notifyMaintenanceUpdatedInApp(doc, actorUserId = null, { status, customMessage, eventKey } = {}) {
  try {
    const scoped = await ensureMaintenanceHoaId(doc);
    const recipients = await resolveMaintenanceNotificationRecipients(scoped, actorUserId);
    if (!recipients.length) return { sent: 0 };

    const title = maintenanceTitle(scoped);
    const unitName = maintenanceUnitName(scoped);
    const resolvedStatus = status || scoped?.status || 'Open';
    const normalizedStatus = String(resolvedStatus).toLowerCase().trim();
    const ticketId = toIdString(scoped?._id);
    const meta = maintenanceMetadata(scoped, { status: resolvedStatus });
    const idempotencySuffix = eventKey || `${normalizedStatus}:${scoped?.updatedAt || Date.now()}`;

    // Vendors mark tickets Completed; board/owners mark Resolved — both are close actions.
    // Match the resolve email copy ("marked as resolved"), not the generic "updated" event.
    const becameResolvedOrCompleted =
      normalizedStatus === 'resolved' || normalizedStatus === 'completed';

    if (becameResolvedOrCompleted) {
      await notify(
        EVENTS.MAINTENANCE_REQUEST_COMPLETED,
        {
          title,
          unitName,
          status: resolvedStatus,
          customMessage:
            customMessage
            || `Maintenance request "${title}" for unit "${unitName}" has been marked as resolved.`,
        },
        recipients,
        meta,
        { idempotencyKey: `maintenance_resolved:${ticketId}:${idempotencySuffix}` }
      );
    } else if (normalizedStatus === 'open' && eventKey === 'reopened') {
      await notify(
        EVENTS.MAINTENANCE_REQUEST_REOPENED,
        {
          title,
          unitName,
          customMessage:
            customMessage
            || `Maintenance ticket "${title}" for unit "${unitName}" has been reopened.`,
        },
        recipients,
        meta,
        { idempotencyKey: `maintenance_reopened:${ticketId}:${Date.now()}` }
      );
    } else {
      await notify(
        EVENTS.MAINTENANCE_REQUEST_UPDATED,
        {
          title,
          unitName,
          status: resolvedStatus,
          customMessage:
            customMessage
            || `Maintenance request "${title}" for unit "${unitName}" has been updated.`,
        },
        recipients,
        meta,
        { idempotencyKey: `maintenance_updated:${ticketId}:${idempotencySuffix}` }
      );
    }
    return { sent: recipients.length };
  } catch (err) {
    logger.error('notifyMaintenanceUpdatedInApp failed', err);
    return { sent: 0 };
  }
}

async function notifyMaintenanceVendorAssignedInApp(doc, actorUserId = null) {
  try {
    const scoped = await ensureMaintenanceHoaId(doc);
    const recipients = await resolveMaintenanceNotificationRecipients(scoped, actorUserId);
    const title = maintenanceTitle(scoped);
    const unitName = maintenanceUnitName(scoped);
    const ticketId = toIdString(scoped?._id);
    const assignee = toIdString(scoped?.assignedTo && scoped.assignedTo._id ? scoped.assignedTo._id : scoped?.assignedTo);
    const vendorRecipients = assignee ? [assignee] : [];
    const otherRecipients = recipients.filter((id) => id !== assignee);
    const meta = maintenanceMetadata(scoped, { assignedTo: assignee });
    let sent = 0;

    if (vendorRecipients.length) {
      await notify(
        EVENTS.MAINTENANCE_VENDOR_ASSIGNED,
        {
          title,
          unitName,
          customMessage: `You have been assigned to maintenance ticket "${title}" for unit "${unitName}".`,
        },
        vendorRecipients,
        meta,
        { idempotencyKey: `maintenance_vendor_assigned:${ticketId}:${assignee || Date.now()}:vendor` }
      );
      sent += vendorRecipients.length;
    }

    if (otherRecipients.length) {
      await notify(
        EVENTS.MAINTENANCE_VENDOR_ASSIGNED,
        { title, unitName },
        otherRecipients,
        meta,
        { idempotencyKey: `maintenance_vendor_assigned:${ticketId}:${assignee || Date.now()}` }
      );
      sent += otherRecipients.length;
    }

    return { sent };
  } catch (err) {
    logger.error('notifyMaintenanceVendorAssignedInApp failed', err);
    return { sent: 0 };
  }
}

async function notifyMaintenanceCommentInApp(doc, actorUserId = null, options = {}) {
  try {
    const scoped = await ensureMaintenanceHoaId(doc);
    const recipients = await resolveMaintenanceNotificationRecipients(scoped, actorUserId, {
      ...options,
      includeVendorActor: true,
    });
    if (!recipients.length) return { sent: 0 };
    const title = maintenanceTitle(scoped);
    const ticketId = toIdString(scoped?._id);
    await notify(
      EVENTS.MAINTENANCE_COMMENT_ADDED,
      { title, unitName: maintenanceUnitName(scoped) },
      recipients,
      maintenanceMetadata(scoped),
      { idempotencyKey: `maintenance_comment:${ticketId}:${doc?.updatedAt || Date.now()}` }
    );
    return { sent: recipients.length };
  } catch (err) {
    logger.error('notifyMaintenanceCommentInApp failed', err);
    return { sent: 0 };
  }
}

async function notifyMaintenanceNoteInApp(doc, actorUserId = null) {
  try {
    const scoped = await ensureMaintenanceHoaId(doc);
    const recipients = await resolveMaintenanceNotificationRecipients(scoped, actorUserId);
    if (!recipients.length) return { sent: 0 };
    const title = maintenanceTitle(scoped);
    const ticketId = toIdString(scoped?._id);
    await notify(
      EVENTS.MAINTENANCE_NOTE_ADDED,
      { title, unitName: maintenanceUnitName(scoped) },
      recipients,
      maintenanceMetadata(scoped),
      { idempotencyKey: `maintenance_note:${ticketId}:${doc?.updatedAt || Date.now()}` }
    );
    return { sent: recipients.length };
  } catch (err) {
    logger.error('notifyMaintenanceNoteInApp failed', err);
    return { sent: 0 };
  }
}

async function notifyMaintenanceDocumentsInApp(doc, actorUserId = null) {
  try {
    const scoped = await ensureMaintenanceHoaId(doc);
    const recipients = await resolveMaintenanceNotificationRecipients(scoped, actorUserId);
    if (!recipients.length) return { sent: 0 };
    const title = maintenanceTitle(scoped);
    const ticketId = toIdString(scoped?._id);
    await notify(
      EVENTS.MAINTENANCE_DOCUMENTS_UPDATED,
      { title, unitName: maintenanceUnitName(scoped) },
      recipients,
      maintenanceMetadata(scoped),
      { idempotencyKey: `maintenance_documents:${ticketId}:${doc?.updatedAt || Date.now()}` }
    );
    return { sent: recipients.length };
  } catch (err) {
    logger.error('notifyMaintenanceDocumentsInApp failed', err);
    return { sent: 0 };
  }
}

function notifyMaintenanceInAppInBackground(task) {
  runInBackground(task, 'maintenance in-app notify');
}

function notifyMaintenanceCreatedInAppInBackground(doc, actorUserId = null, options = {}) {
  enqueueInAppNotify(
    'maintenance_created',
    { doc, actorUserId, options, maintenanceId: toIdString(doc?._id) },
    () => notifyMaintenanceCreatedInApp(doc, actorUserId, options),
    {
      entityType: 'Maintenance',
      entityId: toIdString(doc?._id),
      idempotencyKey: `maintenance_created:${toIdString(doc?._id)}`,
    }
  );
}

function notifyMaintenanceUpdatedInAppInBackground(doc, actorUserId = null, opts = {}) {
  enqueueInAppNotify(
    'maintenance_updated',
    { doc, actorUserId, options: opts, maintenanceId: toIdString(doc?._id) },
    () => notifyMaintenanceUpdatedInApp(doc, actorUserId, opts),
    {
      entityType: 'Maintenance',
      entityId: toIdString(doc?._id),
      eventId: opts.eventKey || String(doc?.updatedAt || ''),
      idempotencyKey: `maintenance_updated:${toIdString(doc?._id)}:${opts.eventKey || doc?.updatedAt || ''}`,
    }
  );
}

function notifyMaintenanceVendorAssignedInAppInBackground(doc, actorUserId = null) {
  enqueueInAppNotify(
    'maintenance_vendor_assigned',
    { doc, actorUserId, maintenanceId: toIdString(doc?._id) },
    () => notifyMaintenanceVendorAssignedInApp(doc, actorUserId),
    {
      entityType: 'Maintenance',
      entityId: toIdString(doc?._id),
      idempotencyKey: `maintenance_vendor_assigned:${toIdString(doc?._id)}:${doc?.vendorId || doc?.updatedAt || ''}`,
    }
  );
}

function notifyMaintenanceCommentInAppInBackground(doc, actorUserId = null) {
  enqueueInAppNotify(
    'maintenance_comment',
    { doc, actorUserId, maintenanceId: toIdString(doc?._id) },
    () => notifyMaintenanceCommentInApp(doc, actorUserId),
    {
      entityType: 'Maintenance',
      entityId: toIdString(doc?._id),
      eventId: String((doc?.comments || []).length),
      idempotencyKey: `maintenance_comment:${toIdString(doc?._id)}:${(doc?.comments || []).length}`,
    }
  );
}

function notifyMaintenanceNoteInAppInBackground(doc, actorUserId = null) {
  enqueueInAppNotify(
    'maintenance_note',
    { doc, actorUserId, maintenanceId: toIdString(doc?._id) },
    () => notifyMaintenanceNoteInApp(doc, actorUserId),
    {
      entityType: 'Maintenance',
      entityId: toIdString(doc?._id),
      eventId: String((doc?.notes || []).length),
      idempotencyKey: `maintenance_note:${toIdString(doc?._id)}:${(doc?.notes || []).length}`,
    }
  );
}

function notifyMaintenanceDocumentsInAppInBackground(doc, actorUserId = null) {
  enqueueInAppNotify(
    'maintenance_documents',
    { doc, actorUserId, maintenanceId: toIdString(doc?._id) },
    () => notifyMaintenanceDocumentsInApp(doc, actorUserId),
    {
      entityType: 'Maintenance',
      entityId: toIdString(doc?._id),
      eventId: String(doc?.updatedAt || ''),
      idempotencyKey: `maintenance_documents:${toIdString(doc?._id)}:${doc?.updatedAt || ''}`,
    }
  );
}

async function resolveDocumentRecipientIds(document, actorUserId = null) {
  const { resolveDocumentNotificationRecipients } = require('./hoaRecipientResolver');
  return resolveDocumentNotificationRecipients(document, actorUserId);
}

async function notifyDocumentUploadedInApp(document, actorUserId = null) {
  try {
    const recipients = await resolveDocumentRecipientIds(document, actorUserId);
    if (!recipients.length) return { sent: 0 };
    const documentId = toIdString(document?._id);
    await notify(
      EVENTS.DOCUMENT_UPLOADED,
      {
        documentName: document.name || 'Document',
        accessLevel: document.accessLevel || '',
      },
      recipients,
      {
        documentId,
        entityType: 'document',
        entityId: documentId,
        hoaId: document.hoaId ? String(document.hoaId) : undefined,
        accessLevel: document.accessLevel,
      },
      { idempotencyKey: `document_uploaded:${documentId}` }
    );
    return { sent: recipients.length };
  } catch (err) {
    logger.error('notifyDocumentUploadedInApp failed', err);
    return { sent: 0 };
  }
}

function notifyDocumentUploadedInAppInBackground(document, actorUserId = null) {
  runInBackground(
    () => notifyDocumentUploadedInApp(document, actorUserId),
    'document uploaded in-app notify'
  );
}

async function notifyExpenseCreatedInApp(expense, actorUserId = null) {
  try {
    const scoped = await ensureExpenseHoaId(expense);
    const recipients = await resolveExpenseNotificationRecipients(scoped, actorUserId);
    if (!recipients.length) return { sent: 0 };
    const amount = Number(expense.total || expense.amount || 0);
    const expenseId = toIdString(expense?._id);
    await notify(
      EVENTS.EXPENSE_CREATED,
      {
        vendorName: expense.vendorPaidTo || expense.payee || 'Vendor',
        amount: amount.toFixed(2),
        propertyName: expense.propertyName || '',
      },
      recipients,
      expenseMetadata(scoped),
      { idempotencyKey: `expense_created:${expenseId}` }
    );
    return { sent: recipients.length };
  } catch (err) {
    logger.error('notifyExpenseCreatedInApp failed', err);
    return { sent: 0 };
  }
}

async function notifyExpenseUpdatedInApp(expense, actorUserId = null) {
  try {
    const scoped = await ensureExpenseHoaId(expense);
    const recipients = await resolveExpenseNotificationRecipients(scoped, actorUserId);
    if (!recipients.length) return { sent: 0 };
    const amount = Number(expense.total || expense.amount || 0);
    const expenseId = toIdString(expense?._id);
    await notify(
      EVENTS.EXPENSE_UPDATED,
      {
        vendorName: expense.vendorPaidTo || expense.payee || 'Vendor',
        amount: amount.toFixed(2),
      },
      recipients,
      expenseMetadata(scoped),
      { idempotencyKey: `expense_updated:${expenseId}:${scoped?.updatedAt || ''}` }
    );
    return { sent: recipients.length };
  } catch (err) {
    logger.error('notifyExpenseUpdatedInApp failed', err);
    return { sent: 0 };
  }
}

async function notifyExpensePaidInApp(expense, actorUserId = null) {
  try {
    const scoped = await ensureExpenseHoaId(expense);
    const recipients = await resolveExpenseNotificationRecipients(scoped, actorUserId);
    if (!recipients.length) return { sent: 0 };
    const amount = Number(expense.total || expense.amount || 0);
    const expenseId = toIdString(expense?._id);
    await notify(
      EVENTS.EXPENSE_PAID,
      {
        vendorName: expense.vendorPaidTo || expense.payee || 'Vendor',
        amount: amount.toFixed(2),
      },
      recipients,
      expenseMetadata(scoped, { status: 'paid' }),
      { idempotencyKey: `expense_paid:${expenseId}` }
    );
    return { sent: recipients.length };
  } catch (err) {
    logger.error('notifyExpensePaidInApp failed', err);
    return { sent: 0 };
  }
}

async function notifyExpenseDeletedInApp(expense, actorUserId = null) {
  try {
    const scoped = await ensureExpenseHoaId(expense);
    const recipients = await resolveExpenseNotificationRecipients(scoped, actorUserId);
    if (!recipients.length) return { sent: 0 };
    const amount = Number(expense.total || expense.amount || 0);
    const expenseId = toIdString(expense?._id);
    await notify(
      EVENTS.EXPENSE_DELETED,
      {
        vendorName: expense.vendorPaidTo || expense.payee || 'Vendor',
        amount: amount.toFixed(2),
      },
      recipients,
      expenseMetadata(scoped),
      { idempotencyKey: `expense_deleted:${expenseId}` }
    );
    return { sent: recipients.length };
  } catch (err) {
    logger.error('notifyExpenseDeletedInApp failed', err);
    return { sent: 0 };
  }
}

function notifyExpenseInAppInBackground(task) {
  runInBackground(task, 'expense in-app notify');
}

function notifyExpenseCreatedInAppInBackground(expense, actorUserId = null) {
  runInBackground(
    () => notifyExpenseCreatedInApp(expense, actorUserId),
    'expense created in-app notify'
  );
}

function notifyExpenseUpdatedInAppInBackground(expense, actorUserId = null) {
  runInBackground(
    () => notifyExpenseUpdatedInApp(expense, actorUserId),
    'expense updated in-app notify'
  );
}

function notifyExpensePaidInAppInBackground(expense, actorUserId = null) {
  runInBackground(
    () => notifyExpensePaidInApp(expense, actorUserId),
    'expense paid in-app notify'
  );
}

function notifyExpenseDeletedInAppInBackground(expense, actorUserId = null) {
  runInBackground(
    () => notifyExpenseDeletedInApp(expense, actorUserId),
    'expense deleted in-app notify'
  );
}

async function notifyInvoiceCreatedInApp(invoice, actorUserId = null) {
  try {
    const scoped = await ensureInvoiceHoaId(invoice);
    const recipients = await resolveInvoiceLifecycleRecipients(scoped, actorUserId);
    if (!recipients.length) return { sent: 0 };
    const amount = Number(scoped.balanceDue ?? scoped.subAmount ?? scoped.amount ?? 0);
    const invoiceId = toIdString(scoped?._id);
    await notify(
      EVENTS.INVOICE_CREATED,
      {
        amount: amount.toFixed(2),
        unitName: scoped.unit || scoped.unitName || 'Unit',
        propertyName: scoped.propertyName || '',
      },
      recipients,
      invoiceMetadata(scoped),
      { idempotencyKey: `invoice_created:${invoiceId}` }
    );
    return { sent: recipients.length };
  } catch (err) {
    logger.error('notifyInvoiceCreatedInApp failed', err);
    return { sent: 0 };
  }
}

async function notifyInvoiceUpdatedInApp(invoice, actorUserId = null) {
  try {
    const scoped = await ensureInvoiceHoaId(invoice);
    const recipients = await resolveInvoiceLifecycleRecipients(scoped, actorUserId);
    if (!recipients.length) return { sent: 0 };
    const invoiceId = toIdString(scoped?._id);
    await notify(
      EVENTS.INVOICE_UPDATED,
      {
        unitName: scoped.unit || scoped.unitName || 'Unit',
        customMessage: `An invoice for unit "${scoped.unit || scoped.unitName || 'Unit'}" has been updated.`,
      },
      recipients,
      invoiceMetadata(scoped),
      { idempotencyKey: `invoice_updated:${invoiceId}:${scoped?.updatedAt || ''}` }
    );
    return { sent: recipients.length };
  } catch (err) {
    logger.error('notifyInvoiceUpdatedInApp failed', err);
    return { sent: 0 };
  }
}

async function notifyInvoiceDeletedInApp(invoice, actorUserId = null) {
  try {
    const scoped = await ensureInvoiceHoaId(invoice);
    const recipients = await resolveInvoiceLifecycleRecipients(scoped, actorUserId);
    if (!recipients.length) return { sent: 0 };
    const invoiceId = toIdString(scoped?._id);
    await notify(
      EVENTS.INVOICE_DELETED,
      {
        unitName: scoped.unit || scoped.unitName || 'Unit',
        customMessage: `An invoice for unit "${scoped.unit || scoped.unitName || 'Unit'}" has been deleted.`,
      },
      recipients,
      invoiceMetadata(scoped),
      { idempotencyKey: `invoice_deleted:${invoiceId}` }
    );
    return { sent: recipients.length };
  } catch (err) {
    logger.error('notifyInvoiceDeletedInApp failed', err);
    return { sent: 0 };
  }
}

function notifyInvoiceCreatedInAppInBackground(invoice, actorUserId = null) {
  const invoiceId = toIdString(invoice?._id);
  enqueueInAppNotify(
    'invoice_created',
    { invoiceId, actorUserId },
    () => notifyInvoiceCreatedInApp(invoice, actorUserId),
    { entityType: 'Invoice', entityId: invoiceId, idempotencyKey: `invoice_created:${invoiceId}` }
  );
}

function notifyInvoiceUpdatedInAppInBackground(invoice, actorUserId = null) {
  const invoiceId = toIdString(invoice?._id);
  enqueueInAppNotify(
    'invoice_updated',
    { invoiceId, actorUserId },
    () => notifyInvoiceUpdatedInApp(invoice, actorUserId),
    {
      entityType: 'Invoice',
      entityId: invoiceId,
      eventId: String(invoice?.updatedAt || ''),
      idempotencyKey: `invoice_updated:${invoiceId}:${invoice?.updatedAt || ''}`,
    }
  );
}

function notifyInvoiceDeletedInAppInBackground(invoice, actorUserId = null) {
  const invoiceId = toIdString(invoice?._id);
  enqueueInAppNotify(
    'invoice_deleted',
    { invoice, actorUserId },
    () => notifyInvoiceDeletedInApp(invoice, actorUserId),
    { entityType: 'Invoice', entityId: invoiceId, idempotencyKey: `invoice_deleted:${invoiceId}` }
  );
}

async function notifyInvoiceWaivedInApp(invoice, actorUserId = null, waivedAmount = 0) {
  try {
    const scoped = await ensureInvoiceHoaId(invoice);
    const recipients = await resolveInvoiceLifecycleRecipients(scoped, actorUserId);
    if (!recipients.length) return { sent: 0 };
    const invoiceId = toIdString(scoped?._id);
    const amount = Number(waivedAmount || 0).toFixed(2);
    const unitName = scoped.unit || scoped.unitName || 'Unit';
    await notify(
      EVENTS.INVOICE_WAIVED,
      {
        amount,
        unitName,
        customMessage: `$${amount} has been waived on the invoice for unit "${unitName}".`,
      },
      recipients,
      invoiceMetadata(scoped),
      { idempotencyKey: `invoice_waived:${invoiceId}:${amount}:${scoped?.waivedAt || Date.now()}` }
    );
    return { sent: recipients.length };
  } catch (err) {
    logger.error('notifyInvoiceWaivedInApp failed', err);
    return { sent: 0 };
  }
}

function notifyInvoiceWaivedInAppInBackground(invoice, actorUserId = null, waivedAmount = 0) {
  const invoiceId = toIdString(invoice?._id);
  enqueueInAppNotify(
    'invoice_waived',
    { invoiceId, actorUserId, waivedAmount },
    () => notifyInvoiceWaivedInApp(invoice, actorUserId, waivedAmount),
    {
      entityType: 'Invoice',
      entityId: invoiceId,
      idempotencyKey: `invoice_waived:${invoiceId}:${Number(waivedAmount || 0)}`,
    }
  );
}

function notifyPaymentReceivedInAppInBackground(invoice, actorUserId = null, amount = 0, eventSuffix = '') {
  const invoiceId = toIdString(invoice?._id);
  const paymentAmount = Number(amount || 0);
  const suffix = eventSuffix || String(paymentAmount);
  enqueueInAppNotify(
    'payment_received',
    { invoiceId, actorUserId, amount: paymentAmount, idempotencyKey: `payment_received:${invoiceId}:${suffix}` },
    async () => {
      const scoped = await ensureInvoiceHoaId(invoice);
      const recipients = await resolveInvoicePaymentRecipients(scoped, actorUserId);
      if (!recipients.length) return;
      await notify(
        EVENTS.PAYMENT_RECEIVED,
        {
          amount: paymentAmount.toFixed(2),
          unitName: scoped.unit || scoped.unitName || 'Unit',
        },
        recipients,
        invoiceMetadata(scoped),
        { idempotencyKey: `payment_received:${invoiceId}:${suffix}` }
      );
    },
    { entityType: 'Invoice', entityId: invoiceId, eventId: suffix, idempotencyKey: `NOTIFY_PAYMENT_RECEIVED:${invoiceId}:${suffix}` }
  );
}

function notifyPaymentDeletedInAppInBackground(invoice, actorUserId = null, amount = 0, eventSuffix = '') {
  const invoiceId = toIdString(invoice?._id);
  const paymentAmount = Number(amount || 0);
  const suffix = eventSuffix || String(paymentAmount);
  enqueueInAppNotify(
    'payment_deleted',
    { invoiceId, actorUserId, amount: paymentAmount, idempotencyKey: `payment_deleted:${invoiceId}:${suffix}` },
    async () => {
      const scoped = await ensureInvoiceHoaId(invoice);
      const recipients = await resolveInvoicePaymentRecipients(scoped, actorUserId);
      if (!recipients.length) return;
      await notify(
        EVENTS.PAYMENT_DELETED,
        {
          amount: paymentAmount.toFixed(2),
          unitName: scoped.unit || scoped.unitName || 'Unit',
        },
        recipients,
        invoiceMetadata(scoped),
        { idempotencyKey: `payment_deleted:${invoiceId}:${suffix}` }
      );
    },
    { entityType: 'Invoice', entityId: invoiceId, eventId: suffix, idempotencyKey: `NOTIFY_PAYMENT_DELETED:${invoiceId}:${suffix}` }
  );
}

function notifyPaymentFailedInAppInBackground(invoice, actorUserId = null, amount = 0, eventSuffix = '') {
  const invoiceId = toIdString(invoice?._id);
  const paymentAmount = Number(amount || 0);
  const suffix = eventSuffix || String(paymentAmount);
  enqueueInAppNotify(
    'payment_failed',
    { invoiceId, actorUserId, amount: paymentAmount, idempotencyKey: `payment_failed:${invoiceId}:${suffix}` },
    async () => {
      const scoped = await ensureInvoiceHoaId(invoice);
      const recipients = await resolveInvoicePaymentRecipients(scoped, actorUserId);
      if (!recipients.length) return;
      const unitName = scoped.unit || scoped.unitName || 'Unit';
      await notify(
        EVENTS.PAYMENT_FAILED,
        {
          amount: paymentAmount.toFixed(2),
          unitName,
          customMessage: `A payment of $${paymentAmount.toFixed(2)} for unit "${unitName}" could not be processed.`,
        },
        recipients,
        invoiceMetadata(scoped),
        { idempotencyKey: `payment_failed:${invoiceId}:${suffix}` }
      );
    },
    { entityType: 'Invoice', entityId: invoiceId, eventId: suffix, idempotencyKey: `NOTIFY_PAYMENT_FAILED:${invoiceId}:${suffix}` }
  );
}

function notifyPaymentProcessingInAppInBackground(invoice, actorUserId = null, amount = 0, eventSuffix = '') {
  const invoiceId = toIdString(invoice?._id);
  const paymentAmount = Number(amount || 0);
  const suffix = eventSuffix || String(paymentAmount);
  enqueueInAppNotify(
    'payment_processing',
    { invoiceId, actorUserId, amount: paymentAmount, idempotencyKey: `payment_processing:${invoiceId}:${suffix}` },
    async () => {
      const scoped = await ensureInvoiceHoaId(invoice);
      const recipients = await resolveInvoicePaymentRecipients(scoped, actorUserId);
      if (!recipients.length) return;
      const unitName = scoped.unit || scoped.unitName || 'Unit';
      await notify(
        EVENTS.PAYMENT_PROCESSING,
        {
          amount: paymentAmount.toFixed(2),
          unitName,
          customMessage: `A payment of $${paymentAmount.toFixed(2)} for unit "${unitName}" is being processed.`,
        },
        recipients,
        invoiceMetadata(scoped),
        { idempotencyKey: `payment_processing:${invoiceId}:${suffix}` }
      );
    },
    { entityType: 'Invoice', entityId: invoiceId, eventId: suffix, idempotencyKey: `NOTIFY_PAYMENT_PROCESSING:${invoiceId}:${suffix}` }
  );
}

function vendorMetadata(vendor, extra = {}) {
  const vendorId = toIdString(vendor?._id || vendor?.id || vendor?.userId);
  const hoaId = toIdString(vendor?.hoaId || vendor?.hoaInfo?.hoaId);
  return {
    vendorId,
    entityType: 'vendor',
    entityId: vendorId,
    hoaId: hoaId || undefined,
    ...extra,
  };
}

function vendorDisplayName(vendor = {}) {
  const user = vendor.user || vendor;
  const name = `${user.firstName || vendor.firstName || ''} ${user.lastName || vendor.lastName || ''}`.trim();
  return name || user.companyName || vendor.companyName || vendor.email || 'Vendor';
}

async function notifyVendorCreatedInApp(vendor, actorUserId = null, hoaId = null) {
  try {
    const resolvedHoaId = toIdString(hoaId || vendor?.hoaId || vendor?.hoaInfo?.hoaId);
    const recipients = await resolveVendorNotificationRecipients({ hoaId: resolvedHoaId, actorUserId });
    if (!recipients.length) return { sent: 0 };
    const vendorId = toIdString(vendor?._id || vendor?.id || vendor?.userId);
    const vendorName = vendorDisplayName(vendor);
    await notify(
      EVENTS.VENDOR_CREATED,
      { vendorName },
      recipients,
      vendorMetadata(vendor, { hoaId: resolvedHoaId }),
      { idempotencyKey: `vendor_created:${vendorId}` }
    );
    return { sent: recipients.length };
  } catch (err) {
    logger.error('notifyVendorCreatedInApp failed', err);
    return { sent: 0 };
  }
}

async function notifyVendorUpdatedInApp(vendor, actorUserId = null, hoaId = null) {
  try {
    const resolvedHoaId = toIdString(hoaId || vendor?.hoaId || vendor?.hoaInfo?.hoaId);
    const recipients = await resolveVendorNotificationRecipients({ hoaId: resolvedHoaId, actorUserId });
    if (!recipients.length) return { sent: 0 };
    const vendorId = toIdString(vendor?._id || vendor?.id || vendor?.userId);
    const vendorName = vendorDisplayName(vendor);
    await notify(
      EVENTS.VENDOR_UPDATED,
      { vendorName },
      recipients,
      vendorMetadata(vendor, { hoaId: resolvedHoaId }),
      { idempotencyKey: `vendor_updated:${vendorId}:${vendor?.updatedAt || Date.now()}` }
    );
    return { sent: recipients.length };
  } catch (err) {
    logger.error('notifyVendorUpdatedInApp failed', err);
    return { sent: 0 };
  }
}

async function notifyVendorDeletedInApp(vendor, actorUserId = null, hoaId = null) {
  try {
    const resolvedHoaId = toIdString(hoaId || vendor?.hoaId || vendor?.hoaInfo?.hoaId);
    const recipients = await resolveVendorNotificationRecipients({ hoaId: resolvedHoaId, actorUserId });
    if (!recipients.length) return { sent: 0 };
    const vendorId = toIdString(vendor?._id || vendor?.id || vendor?.userId);
    const vendorName = vendorDisplayName(vendor);
    await notify(
      EVENTS.VENDOR_DELETED,
      { vendorName },
      recipients,
      vendorMetadata(vendor, { hoaId: resolvedHoaId }),
      { idempotencyKey: `vendor_deleted:${vendorId}` }
    );
    return { sent: recipients.length };
  } catch (err) {
    logger.error('notifyVendorDeletedInApp failed', err);
    return { sent: 0 };
  }
}

async function notifyVendorAssignedInApp({ vendor, maintenanceDoc, actorUserId = null, hoaId = null } = {}) {
  try {
    const resolvedHoaId = toIdString(hoaId || maintenanceDoc?.hoaId);
    const boardRecipients = await resolveVendorNotificationRecipients({ hoaId: resolvedHoaId, actorUserId });
    const vendorId = toIdString(
      vendor?._id || vendor?.id || vendor?.userId
      || (maintenanceDoc?.assignedTo && maintenanceDoc.assignedTo._id
        ? maintenanceDoc.assignedTo._id
        : maintenanceDoc?.assignedTo)
    );
    const vendorRecipients = vendorId && vendorId !== toIdString(actorUserId) ? [vendorId] : [];
    const otherRecipients = boardRecipients.filter((id) => id !== vendorId);
    if (!vendorRecipients.length && !otherRecipients.length) return { sent: 0 };

    const vendorName = vendorDisplayName(vendor || {});
    const title = maintenanceTitle(maintenanceDoc || {});
    const unitName = maintenanceUnitName(maintenanceDoc || {});
    const ticketId = toIdString(maintenanceDoc?._id);
    const meta = {
      ...vendorMetadata(vendor || {}, { hoaId: resolvedHoaId }),
      maintenanceRequestId: ticketId || undefined,
    };
    let sent = 0;

    if (vendorRecipients.length) {
      await notify(
        EVENTS.VENDOR_ASSIGNED,
        {
          vendorName,
          title,
          unitName,
          customMessage: `You have been assigned to maintenance ticket "${title}" for unit "${unitName}".`,
        },
        vendorRecipients,
        meta,
        { idempotencyKey: `vendor_assigned:${ticketId}:${vendorId}:vendor` }
      );
      sent += vendorRecipients.length;
    }

    if (otherRecipients.length) {
      await notify(
        EVENTS.VENDOR_ASSIGNED,
        { vendorName, title, unitName },
        otherRecipients,
        meta,
        { idempotencyKey: `vendor_assigned:${ticketId}:${vendorId}` }
      );
      sent += otherRecipients.length;
    }

    return { sent };
  } catch (err) {
    logger.error('notifyVendorAssignedInApp failed', err);
    return { sent: 0 };
  }
}

function notifyVendorCreatedInAppInBackground(vendor, actorUserId = null, hoaId = null) {
  enqueueInAppNotify(
    'vendor_created',
    { vendor, actorUserId, hoaId },
    () => notifyVendorCreatedInApp(vendor, actorUserId, hoaId),
    {
      entityType: 'Vendor',
      entityId: toIdString(vendor?._id || vendor?.id || vendor?.userId),
      idempotencyKey: `vendor_created:${toIdString(vendor?._id || vendor?.id || vendor?.userId)}`,
    }
  );
}

function notifyVendorUpdatedInAppInBackground(vendor, actorUserId = null, hoaId = null) {
  enqueueInAppNotify(
    'vendor_updated',
    { vendor, actorUserId, hoaId },
    () => notifyVendorUpdatedInApp(vendor, actorUserId, hoaId),
    {
      entityType: 'Vendor',
      entityId: toIdString(vendor?._id || vendor?.id || vendor?.userId),
      idempotencyKey: `vendor_updated:${toIdString(vendor?._id || vendor?.id || vendor?.userId)}:${vendor?.updatedAt || ''}`,
    }
  );
}

function notifyVendorDeletedInAppInBackground(vendor, actorUserId = null, hoaId = null) {
  enqueueInAppNotify(
    'vendor_deleted',
    { vendor, actorUserId, hoaId },
    () => notifyVendorDeletedInApp(vendor, actorUserId, hoaId),
    {
      entityType: 'Vendor',
      entityId: toIdString(vendor?._id || vendor?.id || vendor?.userId),
      idempotencyKey: `vendor_deleted:${toIdString(vendor?._id || vendor?.id || vendor?.userId)}`,
    }
  );
}

function notifyVendorAssignedInAppInBackground(payload, actorUserId = null) {
  enqueueInAppNotify(
    'vendor_assigned',
    { ...payload, actorUserId },
    () => notifyVendorAssignedInApp({ ...payload, actorUserId }),
    {
      entityType: 'Maintenance',
      entityId: toIdString(payload?.maintenanceDoc?._id),
      idempotencyKey: `vendor_assigned:${toIdString(payload?.maintenanceDoc?._id)}:${toIdString(payload?.vendor?._id || payload?.vendor?.id)}`,
    }
  );
}

function vendorInvoiceDisplay(invoice = {}) {
  return invoice.title || invoice.invoiceNumber || 'Vendor invoice';
}

function vendorInvoiceMetadata(invoice, hoaId, extra = {}) {
  const invoiceId = toIdString(invoice?._id);
  return {
    entityType: 'vendor_invoice',
    entityId: invoiceId,
    hoaId: toIdString(hoaId) || undefined,
    expenseId: invoiceId,
    ...extra,
  };
}

async function notifyVendorInvoiceInApp(event, invoice, actorUserId = null, hoaId = null) {
  try {
    const resolvedHoaId = toIdString(hoaId || invoice?.hoaId);
    const recipients = await resolveVendorInvoiceNotificationRecipients(
      { ...invoice, hoaId: resolvedHoaId || invoice?.hoaId },
      actorUserId
    );
    if (!recipients.length) return { sent: 0 };
    const invoiceId = toIdString(invoice?._id);
    const amount = Number(invoice?.subAmount || invoice?.balanceDue || 0).toFixed(2);
    await notify(
      event,
      {
        invoiceTitle: vendorInvoiceDisplay(invoice),
        invoiceNumber: invoice?.invoiceNumber || '',
        amount,
      },
      recipients,
      vendorInvoiceMetadata(invoice, resolvedHoaId),
      { idempotencyKey: `${event.type}:${invoiceId}:${invoice?.updatedAt || ''}` }
    );
    return { sent: recipients.length };
  } catch (err) {
    logger.error('notifyVendorInvoiceInApp failed', err);
    return { sent: 0 };
  }
}

function notifyVendorInvoiceCreatedInAppInBackground(invoice, actorUserId = null, hoaId = null) {
  enqueueInAppNotify(
    'vendor_invoice_created',
    { invoice, actorUserId, hoaId },
    () => notifyVendorInvoiceInApp(EVENTS.VENDOR_INVOICE_CREATED, invoice, actorUserId, hoaId),
    {
      entityType: 'VendorInvoice',
      entityId: toIdString(invoice?._id),
      idempotencyKey: `vendor_invoice_created:${toIdString(invoice?._id)}`,
    }
  );
}

function notifyVendorInvoiceUpdatedInAppInBackground(invoice, actorUserId = null, hoaId = null) {
  enqueueInAppNotify(
    'vendor_invoice_updated',
    { invoice, actorUserId, hoaId },
    () => notifyVendorInvoiceInApp(EVENTS.VENDOR_INVOICE_UPDATED, invoice, actorUserId, hoaId),
    {
      entityType: 'VendorInvoice',
      entityId: toIdString(invoice?._id),
      idempotencyKey: `vendor_invoice_updated:${toIdString(invoice?._id)}:${invoice?.updatedAt || ''}`,
    }
  );
}

function notifyVendorInvoiceDeletedInAppInBackground(invoice, actorUserId = null, hoaId = null) {
  enqueueInAppNotify(
    'vendor_invoice_deleted',
    { invoice, actorUserId, hoaId },
    () => notifyVendorInvoiceInApp(EVENTS.VENDOR_INVOICE_DELETED, invoice, actorUserId, hoaId),
    {
      entityType: 'VendorInvoice',
      entityId: toIdString(invoice?._id),
      idempotencyKey: `vendor_invoice_deleted:${toIdString(invoice?._id)}`,
    }
  );
}

async function notifyVendorInvoiceCommentInApp(invoice, actorUserId = null, hoaId = null) {
  try {
    const resolvedHoaId = toIdString(hoaId || invoice?.hoaId);
    const recipients = await resolveVendorInvoiceNotificationRecipients(
      { ...invoice, hoaId: resolvedHoaId || invoice?.hoaId },
      actorUserId
    );
    if (!recipients.length) return { sent: 0 };
    const invoiceId = toIdString(invoice?._id);
    const commentCount = Array.isArray(invoice?.comments) ? invoice.comments.length : 0;
    await notify(
      EVENTS.VENDOR_INVOICE_COMMENT_ADDED,
      {
        invoiceTitle: vendorInvoiceDisplay(invoice),
        invoiceNumber: invoice?.invoiceNumber || '',
      },
      recipients,
      vendorInvoiceMetadata(invoice, resolvedHoaId),
      { idempotencyKey: `vendor_invoice_comment:${invoiceId}:${commentCount}` }
    );
    return { sent: recipients.length };
  } catch (err) {
    logger.error('notifyVendorInvoiceCommentInApp failed', err);
    return { sent: 0 };
  }
}

function notifyVendorInvoiceCommentInAppInBackground(invoice, actorUserId = null, hoaId = null) {
  const commentCount = Array.isArray(invoice?.comments) ? invoice.comments.length : 0;
  enqueueInAppNotify(
    'vendor_invoice_comment',
    { invoice, actorUserId, hoaId },
    () => notifyVendorInvoiceCommentInApp(invoice, actorUserId, hoaId),
    {
      entityType: 'VendorInvoice',
      entityId: toIdString(invoice?._id),
      eventId: String(commentCount),
      idempotencyKey: `vendor_invoice_comment:${toIdString(invoice?._id)}:${commentCount}`,
    }
  );
}

module.exports = {
  excludeActor,
  runInBackground,
  resolveMaintenanceNotificationRecipients,
  notifyMaintenanceCreatedInApp,
  notifyMaintenanceCreatedInAppInBackground,
  notifyMaintenanceUpdatedInApp,
  notifyMaintenanceUpdatedInAppInBackground,
  notifyMaintenanceVendorAssignedInApp,
  notifyMaintenanceVendorAssignedInAppInBackground,
  notifyMaintenanceCommentInApp,
  notifyMaintenanceCommentInAppInBackground,
  notifyMaintenanceNoteInApp,
  notifyMaintenanceNoteInAppInBackground,
  notifyMaintenanceDocumentsInApp,
  notifyMaintenanceDocumentsInAppInBackground,
  notifyMaintenanceInAppInBackground,
  notifyDocumentUploadedInApp,
  notifyDocumentUploadedInAppInBackground,
  notifyExpenseCreatedInApp,
  notifyExpenseCreatedInAppInBackground,
  notifyExpenseUpdatedInApp,
  notifyExpenseUpdatedInAppInBackground,
  notifyExpensePaidInApp,
  notifyExpensePaidInAppInBackground,
  notifyExpenseDeletedInApp,
  notifyExpenseDeletedInAppInBackground,
  notifyExpenseInAppInBackground,
  notifyInvoiceCreatedInApp,
  notifyInvoiceCreatedInAppInBackground,
  notifyInvoiceUpdatedInApp,
  notifyInvoiceUpdatedInAppInBackground,
  notifyInvoiceDeletedInApp,
  notifyInvoiceDeletedInAppInBackground,
  notifyInvoiceWaivedInApp,
  notifyInvoiceWaivedInAppInBackground,
  notifyPaymentReceivedInAppInBackground,
  notifyPaymentDeletedInAppInBackground,
  notifyPaymentFailedInAppInBackground,
  notifyPaymentProcessingInAppInBackground,
  notifyVendorCreatedInAppInBackground,
  notifyVendorUpdatedInAppInBackground,
  notifyVendorDeletedInAppInBackground,
  notifyVendorAssignedInAppInBackground,
  notifyVendorInvoiceCreatedInAppInBackground,
  notifyVendorInvoiceUpdatedInAppInBackground,
  notifyVendorInvoiceDeletedInAppInBackground,
  notifyVendorInvoiceCommentInApp,
  notifyVendorInvoiceCommentInAppInBackground,
  resolveDocumentRecipientIds,
  resolveExpenseNotificationRecipients,
  resolveInvoiceLifecycleRecipients,
};
