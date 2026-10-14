/**
 * Resolve HOA document notify recipients and send one email per unique address.
 * Failures are logged; they must not roll back a successful upload.
 */
const User = require('../../users/models/user.model');
const HOA = require('../../../../portals/hoa-board/modules/hoa/model/hoa.model');
const HOAMembership = require('../../../../portals/hoa-board/modules/hoa/model/hoaMembership.model');
const Property = require('../../../../portals/hoa-board/modules/property/model/property.model');
const { buildHOAOwnerUserFilter } = require('../../../../common/helpers/hoaOwnerRole');
const { buildHoaOwnerUserFilter } = require('../../../../middleware/hoaDataIsolation');
const emailHelper = require('../../../../common/helpers/emailHelper');
const { buildCommunityEmailSubject } = require('../../../../common/helpers/communityEmailContext.service');
const logger = require('../../../../common/logger');
const { formatEmailDate } = require('../../../../common/helpers/hoaBillingDates');

function toIdString(id) {
  if (!id) return '';
  return id.toString ? id.toString() : String(id);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function resolveFrontendBaseUrl() {
  const base =
    process.env.HOA_FRONTEND_BASE_URL ||
    process.env.FRONTEND_BASE_URL ||
    process.env.FRONTEND_APP_URL ||
    '';
  return String(base).replace(/\/$/, '');
}

function addRecipient(map, userLike) {
  const email = normalizeEmail(userLike?.email);
  if (!email || !email.includes('@')) return;
  if (map.has(email)) return;
  const first = userLike.firstName || '';
  const last = userLike.lastName || '';
  const name = `${first} ${last}`.trim() || email.split('@')[0];
  map.set(email, { email, name, userId: toIdString(userLike._id || userLike.id) });
}

async function collectAllResidentRecipients(hoaId) {
  const map = new Map();
  if (!hoaId) return map;

  const memberships = await HOAMembership.find({ hoaId, status: 'active' })
    .populate('userId', 'firstName lastName email isDeleted')
    .lean();
  for (const m of memberships) {
    const user = m.userId;
    if (!user || user.isDeleted) continue;
    addRecipient(map, { ...user, email: user.email || m.email });
  }

  const properties = await Property.find({ hoaId, isDeleted: { $ne: true } })
    .select('_id associatedOwnerIds')
    .lean();
  const propertyIds = properties.map((p) => p._id).filter(Boolean);
  const associatedOwnerIds = [];
  properties.forEach((property) => {
    (property.associatedOwnerIds || []).forEach((ownerId) => {
      const id = toIdString(ownerId);
      if (id) associatedOwnerIds.push(id);
    });
  });

  const ownerRoleFilter = await buildHOAOwnerUserFilter();
  const ownerScope = buildHoaOwnerUserFilter({ hoaId, propertyIds });
  const ownerMatchOr = [];
  if (ownerScope) ownerMatchOr.push(ownerScope);
  if (associatedOwnerIds.length) {
    ownerMatchOr.push({ _id: { $in: associatedOwnerIds } });
  }

  if (ownerMatchOr.length) {
    const owners = await User.find({
      $and: [ownerRoleFilter, { $or: ownerMatchOr }, { isDeleted: { $ne: true } }],
    })
      .select('firstName lastName email')
      .lean();
    owners.forEach((owner) => addRecipient(map, owner));
  }

  if (associatedOwnerIds.length) {
    const linked = await User.find({
      _id: { $in: associatedOwnerIds },
      isDeleted: { $ne: true },
    })
      .select('firstName lastName email')
      .lean();
    linked.forEach((owner) => addRecipient(map, owner));
  }

  return map;
}

async function collectUsersByIds(ids = []) {
  const map = new Map();
  const unique = [...new Set((ids || []).map(toIdString).filter(Boolean))];
  if (!unique.length) return map;
  const users = await User.find({ _id: { $in: unique }, isDeleted: { $ne: true } })
    .select('firstName lastName email')
    .lean();
  users.forEach((user) => addRecipient(map, user));
  return map;
}

/**
 * @returns {Promise<Array<{ email: string, name: string, userId: string }>>}
 */
async function resolveDocumentNotifyRecipients({
  hoaId,
  allResidents = false,
  ownerIds = [],
  boardMemberIds = [],
} = {}) {
  if (allResidents) {
    const map = await collectAllResidentRecipients(hoaId);
    return [...map.values()];
  }

  const map = new Map();
  const owners = await collectUsersByIds(ownerIds);
  const board = await collectUsersByIds(boardMemberIds);
  owners.forEach((r, email) => map.set(email, r));
  board.forEach((r, email) => {
    if (!map.has(email)) map.set(email, r);
  });
  return [...map.values()];
}

function categoryLabel(categoryId, categories = []) {
  const match = categories.find((c) => c.id === categoryId);
  return match?.name || categoryId || 'Documents';
}

async function notifyDocumentUploaded({
  document,
  hoaId,
  allResidents,
  ownerIds,
  boardMemberIds,
  categories = [],
}) {
  try {
    const recipients = await resolveDocumentNotifyRecipients({
      hoaId,
      allResidents,
      ownerIds,
      boardMemberIds,
    });
    if (!recipients.length) return { sent: 0, skipped: true };

    const frontendBase = resolveFrontendBaseUrl();
    const documentUrl = frontendBase
      ? `${frontendBase}/documents`
      : '/documents';

    let hoaName = 'your HOA';
    if (hoaId) {
      const hoa = await HOA.findById(hoaId).select('name').lean();
      if (hoa?.name) hoaName = hoa.name;
    }

    const payload = {
      documentTitle: document.name,
      categoryName: categoryLabel(document.category, categories),
      uploadedBy: document.uploadedBy || 'HOA Board',
      uploadDate: formatEmailDate(document.createdAt || new Date()),
      description: document.description || '',
      documentUrl,
      hoaName,
    };

    let sent = 0;
    for (const recipient of recipients) {
      try {
        await emailHelper.sendEmail(
          'hoa-document-uploaded',
          recipient.email,
          {
            ...payload,
            recipientName: recipient.name,
          },
          {
            template: 'hoa-document-uploaded',
            subject: buildCommunityEmailSubject(`New document shared: ${document.name}`, hoaName),
            preheaderText: `${document.name} was uploaded to ${hoaName}.`,
            hoaId,
            senderUserId: document.uploadedByUserId || document.createdBy || null,
            communityName: hoaName,
          }
        );
        sent += 1;
      } catch (emailErr) {
        logger.warn('HOA document notify email failed', {
          email: recipient.email,
          error: emailErr.message,
          documentId: toIdString(document._id || document.id),
        });
      }
    }

    return { sent, total: recipients.length };
  } catch (err) {
    logger.error('HOA document notify failed', { error: err.message });
    return { sent: 0, error: err.message };
  }
}

function notifyDocumentUploadedInBackground(args) {
  setImmediate(() => {
    notifyDocumentUploaded(args).catch((err) => {
      logger.error('HOA document background notify crashed', { error: err.message });
    });
  });
}

module.exports = {
  resolveDocumentNotifyRecipients,
  notifyDocumentUploaded,
  notifyDocumentUploadedInBackground,
  resolveFrontendBaseUrl,
};
