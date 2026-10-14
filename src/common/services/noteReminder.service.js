/**
 * ------------------------------------------------------------------
 * File: noteReminder.service.js
 * Module: Src Common Services
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */
const Invoice = require('../../portals/hoa-board/modules/invoice/model/invoice.model');
const Property = require('../../portals/hoa-board/modules/property/model/property.model');
const User = require('../../shared/modules/users/models/user.model');
const HOAMembership = require('../../portals/hoa-board/modules/hoa/model/hoaMembership.model');
const { notify, EVENTS } = require('../notifications');
const { logEntityNoteActivity } = require('./entityNoteActivity.service');
const { formatEmailDateTime } = require('../helpers/hoaBillingDates');
const { buildNoteReminderPreheader } = require('../helpers/emailDisplayHelper');
const emailHelper = require('../helpers/emailHelper');
const logger = require('../logger');
const { loadHoaMemberUserIds } = require('../../middleware/hoaDataIsolation');
const { ClockService, DateUtil } = require('../date');

/**
 * note Body
 *
 * Performs logic operations for noteBody.
 *
 * @param note - Request/input argument
 * @returns Operations result
 */
function noteBody(note) {
  return note.text || note.description || '';
}

/**
 * note Title
 *
 * Performs logic operations for noteTitle.
 *
 * @param note - Request/input argument
 * @returns Operations result
 */
function noteTitle(note) {
  return note.title?.trim() || noteBody(note).slice(0, 80) || 'Note';
}

/**
 * is Due Reminder
 *
 * Performs logic operations for isDueReminder.
 *
 * @param note - Request/input argument
 * @param now - Request/input argument
 * @returns Operations result
 */
function isDueReminder(note, now = ClockService.now()) {
  if (!note?.reminder || note.reminderNotifiedAt) return false;
  if (note.isSystem) return false;
  const reminderMs = DateUtil.toEpoch(note.reminder);
  if (reminderMs == null) return false;
  return reminderMs <= now.getTime();
}

/**
 * get Portal Base Url
 *
 * Performs logic operations for getPortalBaseUrl.
 *
 * @returns Operations result
 */
function getPortalBaseUrl() {
  return String(
    process.env.HOA_FRONTEND_BASE_URL ||
    process.env.FRONTEND_BASE_URL ||
    process.env.APP_URL ||
    'https://app.propmv.com'
  ).replace(/\/$/, '');
}

/**
 * build Entity View Url
 *
 * Performs logic operations for buildEntityViewUrl.
 *
 * @param module - Request/input argument
 * @param entityId - Request/input argument
 * @returns Operations result
 */
function buildEntityViewUrl(module, entityId) {
  const base = getPortalBaseUrl();
  switch (module) {
    case 'Invoice':
      return `${base}/invoices?id=${entityId}`;
    case 'Property':
      return `${base}/properties/${entityId}`;
    case 'Owner':
      return `${base}/property-owners/${entityId}`;
    default:
      return `${base}/dashboard`;
  }
}

/**
 * format Reminder At
 *
 * Performs logic operations for formatReminderAt.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function formatReminderAt(value) {
  return formatEmailDateTime(value);
}

/**
 * escape Html Text
 *
 * Performs logic operations for escapeHtmlText.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function escapeHtmlText(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function resolveHoaIdForOwner(owner) {
  if (owner?.hoaInfo?.hoaId) return owner.hoaInfo.hoaId;

  const memberUserId = owner?.hoaBoardMemberId || owner?.createdBy;
  if (memberUserId) {
    const membership = await HOAMembership.findOne({
      userId: memberUserId,
      status: 'active',
    })
      .select('hoaId')
      .lean();
    if (membership?.hoaId) return membership.hoaId;
  }

  return null;
}

async function resolveReminderRecipients(hoaId, creatorId) {
  const boardMemberIds = hoaId ? await loadHoaMemberUserIds(hoaId) : [];
  const userIds = [...new Set([
    ...(creatorId ? [String(creatorId)] : []),
    ...boardMemberIds.map(String),
  ])].filter(Boolean);

  if (!userIds.length) return { userIds: [], users: [] };

  const users = await User.find({
    _id: { $in: userIds },
    isDeleted: { $ne: true },
  })
    .select('firstName lastName email')
    .lean();

  return { userIds, users };
}

async function sendNoteReminderEmails({
  users,
  module,
  entityName,
  note,
  reminderAt,
  entityId,
  hoaId = null,
  creatorId = null,
}) {
  const title = noteTitle(note);
  const body = noteBody(note);
  const subject = `Note Reminder: ${title}`;
  const senderCompany = process.env.FROM_NAME || 'PropMv';
  const viewUrl = buildEntityViewUrl(module, entityId);
  const moduleLabel = module;

  const sends = users
    .filter((u) => u?.email)
    .map((user) => {
      const recipientName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'there';
      return emailHelper.sendEmail(
        'note-reminder',
        user.email,
        {
          recipientName: escapeHtmlText(recipientName),
          senderCompany: escapeHtmlText(senderCompany),
          moduleLabel: escapeHtmlText(moduleLabel),
          entityName: escapeHtmlText(entityName),
          noteTitle: escapeHtmlText(title),
          noteBody: escapeHtmlText(body),
          reminderAt: escapeHtmlText(reminderAt),
          viewUrl,
          hasNoteTitle: Boolean(title && title !== 'Note'),
          hasViewUrl: Boolean(viewUrl),
        },
        { subject, template: 'note-reminder', hoaId, senderUserId: creatorId,
          preheaderText: buildNoteReminderPreheader({ noteTitle: title, reminderAt }),
        }
      ).catch((err) => {
        logger.error('[noteReminder] Email failed:', user.email, err.message);
      });
    });

  if (sends.length) {
    await Promise.allSettled(sends);
  }
}

async function notifyNoteReminder({
  hoaId,
  creatorId,
  module,
  entityId,
  entityName,
  note,
  contextLabel,
}) {
  const title = noteTitle(note);
  const body = noteBody(note);
  const when = formatReminderAt(note.reminder);
  const displayEntity = contextLabel || entityName;

  const { userIds, users } = await resolveReminderRecipients(hoaId, creatorId);
  if (!userIds.length) {
    logger.warn('[noteReminder] No recipients for due reminder', { module, entityId, noteId: note._id });
    return false;
  }

  await notify(
    EVENTS.NOTE_REMINDER,
    {
      noteTitle: title,
      noteBody: body,
      entityName: displayEntity,
      reminderAt: when,
    },
    userIds,
    { module, entityId, noteId: String(note._id) }
  );

  await sendNoteReminderEmails({
    users,
    module,
    entityName: displayEntity,
    note,
    reminderAt: when,
    entityId,
    hoaId,
    creatorId,
  });

  await logEntityNoteActivity({
    userId: creatorId || userIds[0],
    module,
    entityId,
    entityName,
    action: 'reminder_completed',
    noteTitle: title,
    notePreview: body,
    meta: { reminderAt: note.reminder, notifiedUserIds: userIds },
  });

  return true;
}

async function processInvoiceNoteReminders(now = ClockService.now()) {
  const invoices = await Invoice.find({
    isDeleted: { $ne: true },
    'comments.reminder': { $lte: now, $ne: null },
  }).select('invoiceId propertyName hoaId comments').limit(200).lean();

  for (const inv of invoices) {
    for (const comment of inv.comments || []) {
      if (!isDueReminder(comment, now)) continue;
      const creatorId = comment.createdBy ? String(comment.createdBy) : null;

      const sent = await notifyNoteReminder({
        hoaId: inv.hoaId,
        creatorId,
        module: 'Invoice',
        entityId: inv._id,
        entityName: `Invoice ${inv.invoiceId}`,
        note: comment,
        contextLabel: inv.propertyName
          ? `${inv.propertyName} · Invoice ${inv.invoiceId}`
          : `Invoice ${inv.invoiceId}`,
      });

      if (!sent) continue;

      await Invoice.updateOne(
        { _id: inv._id, 'comments._id': comment._id },
        { $set: { 'comments.$.reminderNotifiedAt': now } }
      );
    }
  }
}

async function processPropertyNoteReminders(now = ClockService.now()) {
  const properties = await Property.find({
    'notes.reminder': { $lte: now, $ne: null },
  }).select('name hoaId notes').limit(200).lean();

  for (const prop of properties) {
    for (const note of prop.notes || []) {
      if (!isDueReminder(note, now)) continue;
      const creatorId = note.createdBy ? String(note.createdBy) : null;

      const sent = await notifyNoteReminder({
        hoaId: prop.hoaId,
        creatorId,
        module: 'Property',
        entityId: prop._id,
        entityName: prop.name || 'Property',
        note: { ...note, text: note.description },
        contextLabel: prop.name || 'Property',
      });

      if (!sent) continue;

      await Property.updateOne(
        { _id: prop._id, 'notes._id': note._id },
        { $set: { 'notes.$.reminderNotifiedAt': now } }
      );
    }
  }
}

async function processOwnerNoteReminders(now = ClockService.now()) {
  const owners = await User.find({
    'notes.reminder': { $lte: now, $ne: null },
    isDeleted: { $ne: true },
  })
    .select('firstName lastName notes hoaInfo hoaBoardMemberId createdBy')
    .limit(200)
    .lean();

  for (const owner of owners) {
    const ownerLabel = `${owner.firstName || ''} ${owner.lastName || ''}`.trim() || 'Owner';
    const hoaId = await resolveHoaIdForOwner(owner);

    for (const note of owner.notes || []) {
      if (!isDueReminder(note, now)) continue;
      const creatorId = note.createdBy ? String(note.createdBy) : null;

      const sent = await notifyNoteReminder({
        hoaId,
        creatorId,
        module: 'Owner',
        entityId: owner._id,
        entityName: ownerLabel,
        note: { ...note, text: note.description },
        contextLabel: ownerLabel,
      });

      if (!sent) continue;

      await User.updateOne(
        { _id: owner._id, 'notes._id': note._id },
        { $set: { 'notes.$.reminderNotifiedAt': now } }
      );
    }
  }
}

async function processDueNoteReminders() {
  try {
    const now = ClockService.now();
    await processInvoiceNoteReminders(now);
    await processPropertyNoteReminders(now);
    await processOwnerNoteReminders(now);
  } catch (err) {
    logger.error('[noteReminder] Failed to process due note reminders:', err.message);
  }
}

module.exports = { processDueNoteReminders };
