/**
 * ------------------------------------------------------------------
 * File: owner.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * owner.controller
 * ------------------------------------------------------------------
 */
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const User = require('../../../../../shared/modules/users/models/user.model');
const logger = require('../../../../../common/logger');

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function toObjectIds(arr) {
  return (Array.isArray(arr) ? arr : []).map(toObjectId).filter(Boolean);
}
const { decryptIfEnabled } = require('../../../../../common/helpers/cryptoHelper');
const emailHelper = require('../../../../../common/helpers/emailHelper');
const { logActivity } = require('../../dashboard/service/activity.service');
const { logEntityNoteActivity } = require('../../../../../common/services/entityNoteActivity.service');
const { enrichNotesWithAuthors } = require('../../../../../common/helpers/enrichNotesWithAuthors');
const { nextEmbeddedNoteNumber } = require('../../../../../common/helpers/nextEmbeddedNoteNumber');
const { enrichNotesAttachments } = require('../../../../../common/helpers/enrichNoteAttachments');
const {
  parseRemoveAttachmentIds,
  removeAttachmentsFromNote,
  getAttachmentId,
} = require('../../../../../common/helpers/noteAttachmentUpdates');
const {
  uploadNoteAttachmentFiles,
  isLegacyLocalNoteAttachment,
} = require('../../../../../common/helpers/uploadNoteAttachments');
const fs = require('fs');
const { getHOADocumentsForOwner } = require('../../../../../shared/modules/documents/service/hoa.service');
const { parsePropertyAddress, extractFlatAddressFields } = require('../../../../../common/helpers/addressHelper');
const portalInvitationService = require('../../../../../shared/modules/auth/services/portalInvitation.service');
const { PORTAL_ONBOARDING_STATUS } = require('../../../../../common/constants/portalOnboarding');
const { USER_STATUSES } = require('../../../../../common/constants/user');
const { buildOwnerEligibilityFields } = require('../helpers/ownerEligibility.helper');
const { ClockService, DateUtil } = require('../../../../../common/date');
const {
  getEndOfDayInAppTimezone,
  parseDateOnlyToNoonUtc,
} = require('../../../../../common/helpers/hoaBillingDates');
const {
  addUtcCalendarMonths,
  parseDateOnlyToUtcParts,
} = require('../services/unitInvoice.service');
const {
  normalizeOwnerEmail,
  assertUniqueOwnerEmail,
  mapOwnerPersistenceError,
} = require('../helpers/ownerIdentityValidation');
const { getCurrentOwnerIdsFromUnit, resolveOwnershipEffectiveDateForOwner } = require('../services/unit.service');

function coerceOptionalOwnerPhone(phone) {
  if (phone === undefined) return undefined;
  if (phone === null) return null;
  const trimmed = String(phone).trim();
  return trimmed || null;
}

async function loadCurrentOwnerAssociationMap(propertyIds = []) {
  const Property = require('../../property/model/property.model');
  const ids = toObjectIds(propertyIds);
  if (ids.length === 0) return new Map();
  const rows = await Property.find({ _id: { $in: ids } })
    .select('_id ownershipRecords associatedOwnerIds createdAt balanceAsOf')
    .lean();
  const map = new Map();
  for (const row of rows) {
    const ownerIds = getCurrentOwnerIdsFromUnit(row).map((id) => String(id));
    const effectiveDatesByOwner = new Map();
    for (const ownerId of ownerIds) {
      const startDate = resolveOwnershipEffectiveDateForOwner(row, ownerId);
      if (startDate) {
        effectiveDatesByOwner.set(String(ownerId), startDate);
      }
    }
    map.set(String(row._id), {
      ownerIds: new Set(ownerIds),
      effectiveDatesByOwner,
      unit: row,
    });
  }
  return map;
}

function filterOwnerPropertiesByCurrentAssociation(ownerId, properties = [], associationMap = new Map()) {
  const ownerIdStr = String(ownerId);
  return (Array.isArray(properties) ? properties : []).filter((prop) => {
    const propId = String(prop?._id || prop?.id || '');
    const entry = associationMap.get(propId);
    if (!entry) return false;
    const currentOwners = entry.ownerIds || entry;
    return currentOwners instanceof Set
      ? currentOwners.has(ownerIdStr)
      : Boolean(currentOwners?.has?.(ownerIdStr));
  });
}

function resolveOwnerPropertyEffectiveDate(ownerId, propertyId, associationMap = new Map()) {
  const entry = associationMap.get(String(propertyId));
  if (!entry?.effectiveDatesByOwner) return null;
  return entry.effectiveDatesByOwner.get(String(ownerId)) || null;
}

const OWNER_PROPERTY_DOC_SELECT = 'name unitDetails.unitName address monthlyRecurringFee balanceAsOf paymentTerm';

/** Properties where each owner is still active on the ownership timeline (includes scheduled future removals). */
async function loadTimelinePropertyIdsByOwnerIds(ownerIds = [], propertyScope = {}) {
  const ids = toObjectIds(ownerIds);
  if (ids.length === 0) return new Map();

  const ownerIdStrs = ids.map((id) => String(id));
  const ownerSet = new Set(ownerIdStrs);
  const result = new Map(ownerIdStrs.map((id) => [id, new Set()]));

  const Property = require('../../property/model/property.model');
  const properties = await Property.find({
    isDeleted: { $ne: true },
    ...propertyScope,
    $or: [
      { associatedOwnerIds: { $in: ids } },
      { 'ownershipRecords.ownerId': { $in: ids } },
    ],
  })
    .select('_id name unitDetails address monthlyRecurringFee balanceAsOf paymentTerm ownershipRecords associatedOwnerIds createdAt')
    .lean();

  for (const row of properties) {
    const currentOwners = getCurrentOwnerIdsFromUnit(row).map(String);
    for (const ownerId of currentOwners) {
      if (ownerSet.has(ownerId)) {
        result.get(ownerId).add(String(row._id));
      }
    }
  }

  return result;
}

function mergeOwnerPropertyDocuments(owner, timelinePropertyIds = new Set(), extraPropertyById = new Map()) {
  const seen = new Set();
  const docs = [];
  for (const prop of owner.propertyIds || []) {
    const id = String(prop?._id || prop?.id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    docs.push(prop);
  }
  for (const propertyId of timelinePropertyIds) {
    if (seen.has(propertyId)) continue;
    const doc = extraPropertyById.get(propertyId);
    if (doc) {
      seen.add(propertyId);
      docs.push(doc);
    }
  }
  return docs;
}
const {
  assertEmailCanReceive,
} = require('../../../../../common/helpers/emailRecipientValidation.service');
const {
  resolveOwnerPropertyScopeIds,
  resolveOwnerPickerPropertyIds,
  findOwnerIdsByPaymentStatuses,
  buildOwnerStatusFilter,
  buildOwnerAccountStatusFilter,
  collectAssignedOwnerIdsFromUnits,
} = require('../helpers/ownerListFilters.helper');
const { sendOwnerRemovalNoticeEmail } = require('../../../../../common/helpers/ownerRemovalNoticeEmailHelper');
const Message = require('../../../../../shared/messaging/model/message.model');
const { HOA_BOARD_FEE_INVOICE_TYPES } = require('../../../../../common/constants/invoice');
const { resolveInvoiceUnitLabelFromProperty } = require('../../invoice/helpers/invoiceUnitFilter.helper');
const {
  getHOAOwnerRole,
  buildHOAOwnerUserFilter,
  assignHOAOwnerRoleFields,
} = require('../../../../../common/helpers/hoaOwnerRole');

const roundMoney = (n) => Math.round((Number(n) || 0) * 100) / 100;
const DEFAULT_OWNER_INVITE_SEND_TIMEOUT_MS = 10000;

/** Owner records only need practical format validation; deliverability probes run at send time. */
async function assertOwnerEmailAcceptable(email, options = {}) {
  if (!email) return;
  await assertEmailCanReceive(email, {
    skipMx: true,
    skipSmtpRcpt: true,
    skipMailbox: true,
    skipSuppression: true,
    ...options,
  });
}

function envPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function withOwnerInviteSendTimeout(promise, context) {
  const timeoutMs = envPositiveInt(
    'OWNER_INVITE_SEND_TIMEOUT_MS',
    DEFAULT_OWNER_INVITE_SEND_TIMEOUT_MS
  );
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${context || 'Owner invite'} timed out after ${timeoutMs}ms`);
      err.code = 'EOWNER_INVITE_TIMEOUT';
      err.status = 503;
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Owner delete/settlement display fields.
 * Aligns with PropMv-UI `getBalanceFromSummary(summary, true)` and list
 * `portfolioDisplayBalanceFromSummary` past-due (overdueAmount only - not
 * non-past-due partiallyPaidAmount).
 */
function portfolioFromBalanceSummary(summary) {
  const rawNet = roundMoney(summary?.netBalance);
  const pool = roundMoney(summary?.remainingCredit);
  const overdue = Math.max(0, roundMoney(summary?.overdueAmount));
  let net = rawNet;
  if (net === 0 && pool > 0) net = -pool;
  const credit = Math.max(0, overdue - Math.max(0, net));
  // Net credit after open charges - not raw pool (e.g. $100 pool + $50 due → $50 notice, not $100).
  let unappliedCreditNoticeAmount = 0;
  if (net < 0) unappliedCreditNoticeAmount = Math.abs(net);
  else if (net === 0 && pool > 0) unappliedCreditNoticeAmount = pool;
  return {
    portfolioAmountOwed: net > 0 ? net : 0,
    portfolioCreditApplied: net > 0 ? credit : 0,
    unappliedCreditNoticeAmount,
  };
}

async function isSoleActiveOwnerOnProperty(property, ownerOid) {
  const otherOwnerIds = (property?.associatedOwnerIds || []).filter(
    (id) => String(id) !== String(ownerOid)
  );
  if (otherOwnerIds.length === 0) return true;
  const activeOtherOwners = await User.countDocuments({
    _id: { $in: toObjectIds(otherOwnerIds) },
    isDeleted: { $ne: true },
  });
  return activeOtherOwners === 0;
}

/**
 * portal Verification Display
 *
 * Performs logic operations for portalVerificationDisplay.
 *
 * @param portalOnboardingStatus - Request/input argument
 * @returns Operations result
 */
function portalVerificationDisplay(portalOnboardingStatus) {
  if (portalOnboardingStatus === PORTAL_ONBOARDING_STATUS.INVITATION_SENT) return 'Invitation Sent';
  if (portalOnboardingStatus === PORTAL_ONBOARDING_STATUS.PENDING_VERIFICATION) return 'Pending Verification';
  if (portalOnboardingStatus === PORTAL_ONBOARDING_STATUS.ACTIVE) return 'Verified';
  return null;
}

/**
 * list Owner Account Status
 *
 * Performs logic operations for listOwnerAccountStatus.
 *
 * @param owner - Request/input argument
 * @returns Operations result
 */
function listOwnerAccountStatus(owner) {
  const label = portalVerificationDisplay(owner.portalOnboardingStatus);
  if (label) return label;
  return owner.status === USER_STATUSES.ACTIVE ? 'Active' : (owner.status || 'Active');
}
async function getOwnerRole() {
  return getHOAOwnerRole();
}

async function buildOwnerUserFilter(extra = {}) {
  return buildHOAOwnerUserFilter(extra);
}

async function findOwnerDocumentById(ownerId, { lean = false, session = null } = {}) {
  const safeId = toObjectId(ownerId);
  if (!safeId) {
    const err = new Error('Owner not found');
    err.status = 404;
    throw err;
  }
  const ownerFilter = await buildHOAOwnerUserFilter();
  let query = User.findOne({ $and: [ownerFilter, { _id: safeId }] });
  if (session) query = query.session(session);
  if (lean) query = query.lean();
  const owner = await query.exec();
  if (!owner) {
    const err = new Error('Owner not found');
    err.status = 404;
    throw err;
  }
  return owner;
}

/** HOA context stored on portal invitations (board member request or derived from owner's units). */
async function resolveHoaIdForOwnerPortalInvite(ownerLike, requestHoaContext) {
  if (requestHoaContext && requestHoaContext.hoaId && mongoose.Types.ObjectId.isValid(String(requestHoaContext.hoaId))) {
    return { hoaId: requestHoaContext.hoaId };
  }
  if (ownerLike.hoaInfo && ownerLike.hoaInfo.hoaId) {
    return { hoaId: ownerLike.hoaInfo.hoaId };
  }
  if (ownerLike.propertyIds && ownerLike.propertyIds.length > 0) {
    const Property = require('../../property/model/property.model');
    const prop = await Property.findById(ownerLike.propertyIds[0]).select('hoaId').lean();
    if (prop && prop.hoaId) return { hoaId: prop.hoaId };
  }
  return null;
}

async function resolveAssignerName(userId) {
  if (!userId) return process.env.APP_NAME || 'PropMv Team';
  const actor = await User.findById(userId).select('firstName lastName email').lean();
  if (!actor) return process.env.APP_NAME || 'PropMv Team';
  return `${actor.firstName || ''} ${actor.lastName || ''}`.trim() || actor.email || process.env.APP_NAME || 'PropMv Team';
}

/**
 * Send the owner portal invite after create. Runs in the background so the API
 * can return immediately after assertEmailCanReceive + owner persistence.
 */
async function sendCreateOwnerInvitationEmail({
  ownerData,
  createdOwnerId,
  portalInviteHoaContext,
  actorId,
}) {
  if (!ownerData?.email) return;

  try {
    if (!ownerData.password) {
      const inviteResult = await withOwnerInviteSendTimeout(
        portalInvitationService.issueHoaOwnerPortalInvite({
          inviteeUserId: createdOwnerId,
          inviterUserId: actorId,
          tenantName: ownerData.firstName || 'there',
          hoaContext: portalInviteHoaContext,
          skipRecipientValidation: true,
        }),
        'createOwner portal invitation'
      );
      logger.info('================================================');
      logger.info('[createUnit:newOwner] Owner activation link generated');
      logger.info(`[createUnit:newOwner] email   : ${ownerData.email}`);
      logger.info(`[createUnit:newOwner] ownerId : ${createdOwnerId}`);
      logger.info(`[createUnit:newOwner] url     : ${inviteResult?.inviteUrl || '(see email)'}`);
      logger.info('================================================');
    } else {
      const inviteBase =
        process.env.INVITE_ACCEPT_URL || process.env.INVITE_BASE_URL || process.env.FRONTEND_BASE_URL || '';
      const inviterName = await resolveAssignerName(actorId);
      const hoaInviteContext = await resolveHoaIdForOwnerPortalInvite(
        { hoaInfo: portalInviteHoaContext, propertyIds: ownerData.propertyIds },
        portalInviteHoaContext
      );
      const data = {
        tenantName: ownerData.firstName || 'there',
        landlordName: inviterName,
        inviteAudience: 'hoa_owner',
        appName: process.env.APP_NAME || 'propmv',
        inviteUrl: inviteBase || 'https://www.propmv.com',
        acknowledgeBlock: '',
        communityName: portalInviteHoaContext?.communityName || null,
        hoaId: hoaInviteContext?.hoaId || null,
      };
      await withOwnerInviteSendTimeout(
        emailHelper.sendEmail('invite', ownerData.email, data, {
          template: 'invite',
          skipRecipientValidation: true,
          senderUserId: actorId,
          hoaId: hoaInviteContext?.hoaId || null,
          communityName: portalInviteHoaContext?.communityName || null,
        }),
        'createOwner password invite email'
      );
    }
  } catch (e) {
    logger.warn('[createOwner] Background invite email failed:', e.message || e);
  }
}

async function assertOwnerPropertiesBelongToHoa(propertyIds = [], hoaId) {
  if (!hoaId || !Array.isArray(propertyIds) || propertyIds.length === 0) return;

  const ids = toObjectIds(propertyIds);
  if (ids.length !== propertyIds.length) {
    const err = new Error('One or more selected properties are invalid');
    err.status = 400;
    throw err;
  }

  const Property = require('../../property/model/property.model');
  const safeHoaId = toObjectId(hoaId);
  if (!safeHoaId) {
    const err = new Error('Invalid hoaId');
    err.status = 400;
    throw err;
  }
  const count = await Property.countDocuments({
    _id: { $in: ids },
    hoaId: safeHoaId,
    isDeleted: { $ne: true },
    isArchieved: { $ne: true },
  });

  if (count !== ids.length) {
    const err = new Error('Selected properties must belong to the active community');
    err.status = 403;
    throw err;
  }
}

const toRecurringFeesEndDate = (balanceAsOf, paymentTermMonths) => {
  if (!balanceAsOf) return null;
  const parts = parseDateOnlyToUtcParts(balanceAsOf);
  if (!parts) return null;

  const months = Number(paymentTermMonths);
  if (!Number.isFinite(months) || months <= 0) return null;

  const startDate = parseDateOnlyToNoonUtc(
    `${parts.year}-${String(parts.month + 1).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
  );
  if (!startDate) return null;
  return addUtcCalendarMonths(startDate, months);
};

/**
 * Shared Mongo filter for owner list + export so exported rows match the listing.
 */
async function buildOwnerListMongoFilter({
  userId,
  hoaContext = null,
  search = '',
  showArchived = false,
  accountStatusGroup = '',
  accountStatus = '',
  property: propertyFilter = '',
  propertyId: propertyIdFilter = '',
  unitId: unitIdFilter = '',
  unitName = '',
  ownerId: ownerIdFilter = '',
  ownerStatus = '',
  paymentStatus = '',
  feesExpiringThisYear = false,
} = {}) {
  const filter = await buildOwnerUserFilter();

  if (hoaContext && hoaContext.isHOABoardMember) {
    const { buildHoaOwnerUserFilter } = require('../../../../../middleware/hoaDataIsolation');
    const ownerScope = await buildHoaOwnerUserFilter(hoaContext);
    if (ownerScope) {
      filter.$and = filter.$and || [];
      filter.$and.push(ownerScope);
    }
  } else if (userId) {
    filter.hoaBoardMemberId = userId;
  }

  if (showArchived) {
    filter.isArchived = true;
  } else {
    filter.isArchived = { $ne: true };
  }

  if (search && String(search).trim()) {
    const {
      buildOwnerUserMatchClauses,
      defaultEscapeRegex,
    } = require('../../property/helpers/propertyListSearch.helper');
    const clauses = buildOwnerUserMatchClauses(String(search).trim(), defaultEscapeRegex);
    if (clauses.length) {
      const searchOr = { $or: clauses };
      if (filter.$and) {
        filter.$and.push(searchOr);
      } else if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, searchOr];
        delete filter.$or;
      } else {
        filter.$or = searchOr.$or;
      }
    }
  }

  if (accountStatusGroup) {
    const group = String(accountStatusGroup).toLowerCase();
    let groupOr;
    if (group === 'active') {
      groupOr = {
        $or: [
          { portalOnboardingStatus: { $in: ['active', 'verified'] } },
          { status: USER_STATUSES.ACTIVE },
        ],
      };
    } else if (group === 'pending') {
      groupOr = {
        $or: [
          { portalOnboardingStatus: { $in: ['pending_verification', 'invitation_sent', 'invited'] } },
        ],
      };
    } else if (group === 'inactive') {
      groupOr = {
        $or: [
          { status: { $in: [USER_STATUSES.INACTIVE, USER_STATUSES.LOCKED] } },
          { isArchived: true },
        ],
      };
    }
    if (groupOr) {
      filter.$and = filter.$and || [];
      filter.$and.push(groupOr);
    }
  }

  if (accountStatus) {
    const accountStatusFilter = buildOwnerAccountStatusFilter(accountStatus);
    if (accountStatusFilter) {
      filter.$and = filter.$and || [];
      filter.$and.push(accountStatusFilter);
    }
  }

  if (ownerStatus) {
    const ownerStatusFilter = buildOwnerStatusFilter(ownerStatus);
    if (ownerStatusFilter) {
      filter.$and = filter.$and || [];
      filter.$and.push(ownerStatusFilter);
    }
  }

  if (ownerIdFilter && mongoose.Types.ObjectId.isValid(String(ownerIdFilter))) {
    filter.$and = filter.$and || [];
    filter.$and.push({ _id: new mongoose.Types.ObjectId(String(ownerIdFilter)) });
  }

  const scopedPropertyIds = await resolveOwnerPropertyScopeIds({
    propertyId: propertyIdFilter,
    unitId: unitIdFilter,
    unitName,
  });
  if (scopedPropertyIds?.length) {
    filter.$and = filter.$and || [];
    filter.$and.push({
      propertyIds: { $in: scopedPropertyIds.map((id) => new mongoose.Types.ObjectId(String(id))) },
    });
  } else if (propertyFilter) {
    const Property = require('../../property/model/property.model');
    const { buildHoaBoardPropertyMatch } = require('../../../../../middleware/hoaDataIsolation');
    const hoaPropScope = hoaContext?.isHOABoardMember ? buildHoaBoardPropertyMatch(hoaContext) : null;
    const matchingProps = await Property.find({
      name: { $regex: propertyFilter, $options: 'i' },
      isDeleted: { $ne: true },
      ...(hoaPropScope || {}),
    }).select('_id').lean();
    const propIds = matchingProps.map((p) => p._id);
    filter.$and = filter.$and || [];
    filter.$and.push({
      $or: [
        { propertyIds: { $in: propIds } },
        ...(propIds.length === 0 ? [{ _id: null }] : []),
      ],
    });
  }

  if (paymentStatus) {
    const statuses = String(paymentStatus).split(',').map((s) => s.trim()).filter(Boolean);
    const ownerIdsForPayment = await findOwnerIdsByPaymentStatuses(statuses, hoaContext);
    const paymentOwnerIds = (ownerIdsForPayment || []).map((id) => new mongoose.Types.ObjectId(String(id)));
    filter.$and = filter.$and || [];
    filter.$and.push({
      _id: { $in: paymentOwnerIds.length ? paymentOwnerIds : [null] },
    });
  }

  if (feesExpiringThisYear === true || feesExpiringThisYear === 'true') {
    const Property = require('../../property/model/property.model');
    const { buildHoaBoardPropertyMatch } = require('../../../../../middleware/hoaDataIsolation');
    const hoaPropScope = hoaContext?.isHOABoardMember ? buildHoaBoardPropertyMatch(hoaContext) : null;
    const todayKey = DateUtil.toEST(ClockService.now());
    const year = todayKey ? todayKey.slice(0, 4) : String(ClockService.now().getUTCFullYear());
    const yearStart = parseDateOnlyToNoonUtc(`${year}-01-01`);
    const yearEnd = getEndOfDayInAppTimezone(`${year}-12-31`);
    const propsEndingThisYear = await Property.find({
      balanceAsOf: { $gte: yearStart, $lte: yearEnd },
      isDeleted: { $ne: true },
      ...(hoaPropScope || {}),
    }).select('_id').lean();
    const propIds = propsEndingThisYear.map((p) => p._id);
    filter.$and = filter.$and || [];
    filter.$and.push({ propertyIds: { $in: propIds.length ? propIds : [null] } });
  }

  return filter;
}

async function listOwners({ pageNumber = 1, pageSize = 10, sortBy = 'createdAt', sortOrder = 'desc', userId, hoaContext = null, search = '', showArchived = false, accountStatusGroup = '', accountStatus = '', property: propertyFilter = '', propertyId: propertyIdFilter = '', unitId: unitIdFilter = '', unitName = '', ownerId: ownerIdFilter = '', ownerStatus = '', paymentStatus = '', feesExpiringThisYear = false }) {
  const skip = (pageNumber - 1) * pageSize;
  const sortOptions = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

  const filter = await buildOwnerListMongoFilter({
    userId,
    hoaContext,
    search,
    showArchived,
    accountStatusGroup,
    accountStatus,
    property: propertyFilter,
    propertyId: propertyIdFilter,
    unitId: unitIdFilter,
    unitName,
    ownerId: ownerIdFilter,
    ownerStatus,
    paymentStatus,
    feesExpiringThisYear,
  });

  const [owners, total] = await Promise.all([
    User.find(filter)
      .select('-password -resetPasswordToken -resetPasswordExpiresAt -resetPasswordOtp -resetPasswordOtpExpiresAt -mfaOtp -mfaOtpExpiresAt -mfaOtpAction -mfaLoginVerifiedAt -refreshToken -loginAttempts')
      .populate('propertyIds', 'name unitDetails.unitName address monthlyRecurringFee balanceAsOf paymentTerm')
      .sort(sortOptions)
      .skip(skip)
      .limit(pageSize)
      .lean(),
    User.countDocuments(filter),
  ]);

  // Get Property collection to find properties associated with owners
  const Property = require('../../property/model/property.model');
  const { buildHoaBoardPropertyMatch } = require('../../../../../middleware/hoaDataIsolation');
  const hoaPropScope = hoaContext?.isHOABoardMember ? buildHoaBoardPropertyMatch(hoaContext) : {};

  const timelinePropertyIdsByOwner = await loadTimelinePropertyIdsByOwnerIds(
    owners.map((owner) => owner._id),
    hoaPropScope
  );

  const allPropertyIds = new Set();
  for (const owner of owners) {
    for (const prop of owner.propertyIds || []) {
      allPropertyIds.add(String(prop._id));
    }
    for (const propertyId of timelinePropertyIdsByOwner.get(String(owner._id)) || []) {
      allPropertyIds.add(String(propertyId));
    }
  }

  const extraPropertyDocs = allPropertyIds.size > 0
    ? await Property.find({ _id: { $in: [...allPropertyIds].map((id) => toObjectId(id)).filter(Boolean) } })
      .select(`_id ${OWNER_PROPERTY_DOC_SELECT}`)
      .lean()
    : [];
  const extraPropertyById = new Map(extraPropertyDocs.map((prop) => [String(prop._id), prop]));

  const currentOwnerAssociationMap = await loadCurrentOwnerAssociationMap([...allPropertyIds]);

  const formattedOwners = owners.map((owner) => {
    const ownerPropertyDocs = mergeOwnerPropertyDocuments(
      owner,
      timelinePropertyIdsByOwner.get(String(owner._id)) || new Set(),
      extraPropertyById
    );
    const properties = filterOwnerPropertiesByCurrentAssociation(
      owner._id,
      ownerPropertyDocs,
      currentOwnerAssociationMap
    );

    let propertyName = '-';
    let unitName = '-';

    if (properties && properties.length > 0) {
      // If owner has properties, use the first one's details
      const property = properties[0];
      propertyName = property.name || '-';
      unitName = property.unitDetails && property.unitDetails[0] ? property.unitDetails[0].unitName : '-';
    }

    // Extract flat address fields from mailingAddress or use existing flat fields
    let addressFields;
    if (owner.mailingAddress) {
      addressFields = extractFlatAddressFields(owner.mailingAddress);
    } else {
      addressFields = {
        address: owner.address || null,
        city: null,
        state: owner.state || null,
        zip: owner.zipCode || null,
      };
    }

    const totalFees = properties.reduce(
      (sum, prop) => sum + (Number(prop.monthlyRecurringFee) || 0),
      0
    );
    const primaryProperty = properties[0] || null;
    const recurringFeesEndDate = toRecurringFeesEndDate(
      primaryProperty?.balanceAsOf,
      primaryProperty?.paymentTerm
    );
    const primaryOwnershipEffectiveDate = primaryProperty
      ? resolveOwnerPropertyEffectiveDate(owner._id, primaryProperty._id, currentOwnerAssociationMap)
      : null;

    return {
      _id: owner._id,
      hoaId: owner.hoaInfo?.hoaId || null,
      name: `${owner.firstName} ${owner.lastName}`,
      email: owner.email,
      phone: owner.phone,
      profileImage: owner.profileImage || null,
      propertyName,
      unitName,
      isDifferentMailingAddress: owner.isDifferentMailingAddress || false,
      address: addressFields.address || 'N/A',
      city: addressFields.city || 'N/A',
      state: addressFields.state || 'N/A',
      zip: addressFields.zip || 'N/A',
      accountStatus: listOwnerAccountStatus(owner),
      portalOnboardingStatus: owner.portalOnboardingStatus || null,
      userAccountStatus: owner.status || USER_STATUSES.ACTIVE,
      ...buildOwnerEligibilityFields(owner),
      fees: totalFees,
      balanceAsOf: primaryProperty?.balanceAsOf || null,
      ownershipEffectiveDate: primaryOwnershipEffectiveDate,
      recurringFeesEndDate,
      notesCount: Array.isArray(owner.notes) ? owner.notes.length : 0,
      properties: properties.map(prop => {
        const addressParts = [];
        if (prop.address?.street) addressParts.push(prop.address.street);
        if (prop.address?.line2) addressParts.push(prop.address.line2);
        if (prop.address?.city) addressParts.push(prop.address.city);
        if (prop.address?.state) addressParts.push(prop.address.state);
        if (prop.address?.zip) addressParts.push(prop.address.zip);

        return {
          id: prop._id,
          name: prop.name,
          unitName: prop.unitDetails && prop.unitDetails[0] ? prop.unitDetails[0].unitName : 'N/A',
          address: addressParts.length > 0 ? addressParts.join(', ') : '',
          ownershipEffectiveDate: resolveOwnerPropertyEffectiveDate(
            owner._id,
            prop._id,
            currentOwnerAssociationMap
          ),
        };
      })
    };
  });

  return {
    data: formattedOwners,
    total,
    pageNumber,
    pageSize
  };
}

async function createOwner(ownerData, options = {}) {
  try {
    const shouldSendInvite = options.triggerInvite !== false;

    // emailConfirm is UI-only; never persist. Enforce match when inviting.
    const requireConfirm = !['0', 'false', 'no', 'off'].includes(
      String(process.env.EMAIL_REQUIRE_EMAIL_CONFIRM || 'false').trim().toLowerCase()
    );
    const emailForConfirm = String(ownerData.email || '').trim().toLowerCase();
    const emailConfirm = String(ownerData.emailConfirm || '').trim().toLowerCase();
    if (shouldSendInvite && requireConfirm) {
      if (!emailConfirm) {
        const err = new Error('Re-enter the email address to confirm before sending an invitation');
        err.status = 400;
        err.field = 'emailConfirm';
        throw err;
      }
      if (emailConfirm !== emailForConfirm) {
        const err = new Error('Email addresses do not match');
        err.status = 400;
        err.field = 'emailConfirm';
        throw err;
      }
    }
    if (ownerData && Object.prototype.hasOwnProperty.call(ownerData, 'emailConfirm')) {
      delete ownerData.emailConfirm;
    }

    if (ownerData.email) {
      ownerData.email = normalizeOwnerEmail(ownerData.email);
    }

    if (Object.prototype.hasOwnProperty.call(ownerData, 'phone')) {
      ownerData.phone = coerceOptionalOwnerPhone(ownerData.phone);
    }

    if (shouldSendInvite && !ownerData.email) {
      const err = new Error('Email is required to send owner invitation');
      err.status = 400;
      throw err;
    }

    // Validate email format only; deliverability is checked when an invite is actually sent.
    if (ownerData.email) {
      await assertOwnerEmailAcceptable(ownerData.email, {
        context: shouldSendInvite ? 'createOwner:invite' : 'createOwner',
        metadata: { sendInvite: shouldSendInvite },
      });
    }

    const actorId = options.createdBy || options.userId;
    if (actorId) {
      await portalInvitationService.assertInviterRole(actorId, ['HOA Board Member']);
    }
    const activeHoaId = options.hoaContext?.hoaId || ownerData.hoaId || null;
    await assertOwnerPropertiesBelongToHoa(ownerData.propertyIds || [], activeHoaId);

    await assertUniqueOwnerEmail(ownerData.email);

    // Format address
    let resolvedMailingAddress = ownerData.mailingAddress || null;

    // If isDifferentMailingAddress is false and properties are assigned,
    // use the first property's address as the mailing address
    if (!ownerData.isDifferentMailingAddress && ownerData.propertyIds && ownerData.propertyIds.length > 0) {
      const Property = require('../../property/model/property.model');
      const firstProperty = await Property.findById(ownerData.propertyIds[0]).lean();
      if (firstProperty?.address) {
        resolvedMailingAddress = parsePropertyAddress(firstProperty.address);
      }
    }

    // Extract flat address fields from structured mailing address
    const flatAddressFields = extractFlatAddressFields(resolvedMailingAddress);

    const userFields = {
      email: ownerData.email,
      phone: ownerData.phone || null,
      firstName: ownerData.firstName,
      lastName: ownerData.lastName,
      address: flatAddressFields.address,
      city: flatAddressFields.city,
      state: flatAddressFields.state,
      zipCode: flatAddressFields.zip,
      mailingAddress: resolvedMailingAddress,
      isDifferentMailingAddress: ownerData.isDifferentMailingAddress || false,
      hasUnits: ownerData.hasUnits || false,
      sendInvite: shouldSendInvite && Boolean(ownerData.email),
      propertyIds: ownerData.propertyIds || [],
      emergencyContact: ownerData.emergencyContact || null,
      createdBy: options.createdBy || options.userId,
      hoaBoardMemberId: options.hoaBoardMemberId || options.userId,
    };
    await assignHOAOwnerRoleFields(userFields, options.session ? { session: options.session } : {});

    if (activeHoaId) {
      userFields.hoaInfo = {
        ...(ownerData.hoaInfo || {}),
        hoaId: activeHoaId,
      };
    }

    if (!ownerData.password && shouldSendInvite && ownerData.email) {
      userFields.portalOnboardingStatus = PORTAL_ONBOARDING_STATUS.INVITATION_SENT;
    }

    if (userFields.propertyIds && userFields.propertyIds.length > 0) {
      const { assertOwnerEligibleForPropertyAssignment } = require('../helpers/ownerEligibility.helper');
      assertOwnerEligibleForPropertyAssignment({
        portalOnboardingStatus: userFields.portalOnboardingStatus ?? null,
        status: userFields.status || USER_STATUSES.ACTIVE,
        isArchived: false,
        isDeleted: false,
      });
    }

    // Hash password with reduced rounds for better performance
    if (ownerData.password) {
      let plainPassword;
      try {
        plainPassword = decryptIfEnabled(ownerData.password);
      } catch (e) {
        const err = new Error('Failed to decrypt password');
        err.status = 400;
        throw err;
      }
      userFields.password = await bcrypt.hash(plainPassword, 8);
    } else {
      const tempPassword = Math.random().toString(36).slice(-8);
      userFields.password = await bcrypt.hash(tempPassword, 8);
    }

    const created = await User.create(userFields);

    const portalInviteHoaContext = await resolveHoaIdForOwnerPortalInvite(
      { hoaInfo: created.hoaInfo, propertyIds: userFields.propertyIds || [] },
      options.hoaContext || null
    );

    logger.info('[createOwner] Owner created:', created._id);
    logger.info('[createOwner] propertyIds to sync:', userFields.propertyIds);

    // Sync bidirectional relationship: ownership timeline + future invoice payers (parity with addOwner).
    if (userFields.propertyIds && userFields.propertyIds.length > 0) {
      const unitService = require('../services/unit.service');
      await unitService.linkOwnerToUnitsFromOwnerFlow(
        userFields.propertyIds,
        created._id,
        {
          userId: options.createdBy || options.userId,
          hoaBoardMemberId: options.hoaBoardMemberId || options.userId,
          createdBy: options.createdBy || options.userId,
          source: 'create-owner',
          hoaId: activeHoaId,
          skipAssignmentEmailValidation: Boolean(ownerData.email),
        }
      );

      await unitService.ensureInvoicesWhenOwnerLinkedToUnits(
        userFields.propertyIds,
        created._id,
        {
          userId: options.createdBy || options.userId,
          hoaBoardMemberId: options.hoaBoardMemberId || options.userId,
          createdBy: options.createdBy || options.userId,
          hoaId: options.hoaContext?.hoaId || ownerData.hoaId,
        }
      );
    }

    // Log activity
    await logActivity({
      userId: options.createdBy || options.userId,
      action: 'CREATE',
      module: 'Owner',
      entityId: created._id,
      hoaId: options.hoaContext?.hoaId || ownerData.hoaId || undefined,
      entityName: `${ownerData.firstName} ${ownerData.lastName}`,
      description: `Created owner "${ownerData.firstName} ${ownerData.lastName}"`,
      meta: { email: ownerData.email, hoaId: options.hoaContext?.hoaId || ownerData.hoaId }
    });

    /** @type {{ invitationQueued: boolean, invitationSent: boolean, invitationError: string|null }} */
    const invitationMeta = { invitationQueued: false, invitationSent: false, invitationError: null };

    // Validate email up front (syntax/MX/RCPT), then queue invite delivery so create is fast.
    if (shouldSendInvite && ownerData.email) {
      invitationMeta.invitationQueued = true;
      const inviteJob = {
        ownerData: {
          email: ownerData.email,
          password: ownerData.password,
          firstName: ownerData.firstName,
        },
        createdOwnerId: created._id,
        portalInviteHoaContext,
        actorId: options.createdBy || options.userId,
      };
      setImmediate(() => {
        sendCreateOwnerInvitationEmail(inviteJob).catch((e) => {
          logger.warn('[createOwner] Unhandled background invite error:', e?.message || e);
        });
      });
    }

    created._invitationMeta = invitationMeta;
    return created;
  } catch (e) {
    throw mapOwnerPersistenceError(e);
  }
}

const OWNER_DETAIL_SECTIONS = ['profile', 'financials', 'documents', 'messages'];

/**
 * parse Owner Detail Include
 *
 * Performs logic operations for parseOwnerDetailInclude.
 *
 * @param includeParam - Request/input argument
 * @returns Operations result
 */
function parseOwnerDetailInclude(includeParam) {
  if (includeParam == null || includeParam === '' || includeParam === 'all') {
    return new Set(OWNER_DETAIL_SECTIONS);
  }
  const parts = String(includeParam)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const selected = parts.filter((p) => OWNER_DETAIL_SECTIONS.includes(p));
  return selected.length > 0 ? new Set(selected) : new Set(OWNER_DETAIL_SECTIONS);
}

async function getOwnerById(ownerId, options = {}) {
  if (!ownerId) {
    const err = new Error('ownerId is required');
    err.status = 400;
    throw err;
  }

  const include = parseOwnerDetailInclude(options.include);

  // Migrate legacy local note attachments to DocumentMetadata when files still exist
  try {
    const ownerForMigrate = await User.findById(ownerId);
    if (ownerForMigrate) {
      const dirty = await migrateLegacyOwnerNoteAttachments(ownerForMigrate);
      if (dirty) await ownerForMigrate.save();
    }
  } catch (err) {
    logger.warn(`Owner note attachment migration skipped for ${ownerId}:`, err.message);
  }

  // Owner + properties are required for every section (fast path).
  const ownerFilter = await buildHOAOwnerUserFilter();
  const owner = await User.findOne({ $and: [ownerFilter, { _id: toObjectId(ownerId) }] })
    .select('-password -resetPasswordToken -resetPasswordExpiresAt -resetPasswordOtp -resetPasswordOtpExpiresAt -mfaOtp -mfaOtpExpiresAt -mfaOtpAction -mfaLoginVerifiedAt -refreshToken -loginAttempts')
    .populate('propertyIds', 'name unitDetails address monthlyRecurringFee balanceAsOf paymentTerm hoaId')
    .lean();
  if (!owner) {
    const err = new Error('Owner not found');
    err.status = 404;
    throw err;
  }

  const activeHoaId = options.hoaContext?.hoaId ? String(options.hoaContext.hoaId) : null;
  if (activeHoaId) {
    const belongsToActiveHoa =
      (owner.hoaInfo?.hoaId && String(owner.hoaInfo.hoaId) === activeHoaId) ||
      (Array.isArray(owner.propertyIds) && owner.propertyIds.some((p) => String(p.hoaId || p) === activeHoaId)) ||
      (Array.isArray(options.hoaContext?.propertyIds) &&
        options.hoaContext.propertyIds.some((pid) =>
          (owner.propertyIds || []).some((p) => String(p._id || p) === String(pid))
        ));

    if (!belongsToActiveHoa) {
      const err = new Error('Owner not found');
      err.status = 404;
      throw err;
    }
  }

  owner.notes = await enrichNotesWithAuthors(owner.notes || []);
  owner.notes = await enrichNotesAttachments(owner.notes || []);

  const { buildHoaBoardPropertyMatch } = require('../../../../../middleware/hoaDataIsolation');
  const Property = require('../../property/model/property.model');
  const hoaPropScope = activeHoaId
    ? { hoaId: activeHoaId, isDeleted: { $ne: true } }
    : (owner.hoaInfo?.hoaId
      ? { hoaId: owner.hoaInfo.hoaId, isDeleted: { $ne: true } }
      : {});

  const timelinePropertyIds = await loadTimelinePropertyIdsByOwnerIds([owner._id], hoaPropScope);
  const mergedPropertyIds = new Set([
    ...(owner.propertyIds || []).map((prop) => String(prop._id)),
    ...Array.from(timelinePropertyIds.get(String(owner._id)) || []),
  ]);

  const missingPropertyIds = [...mergedPropertyIds].filter(
    (id) => !(owner.propertyIds || []).some((prop) => String(prop._id) === id)
  );
  const extraPropertyDocs = missingPropertyIds.length > 0
    ? await Property.find({ _id: { $in: missingPropertyIds.map((id) => toObjectId(id)).filter(Boolean) } })
      .select(`_id ${OWNER_PROPERTY_DOC_SELECT}`)
      .lean()
    : [];
  const extraPropertyById = new Map(extraPropertyDocs.map((prop) => [String(prop._id), prop]));

  const currentOwnerAssociationMap = await loadCurrentOwnerAssociationMap([...mergedPropertyIds]);
  const ownerPropertyDocs = mergeOwnerPropertyDocuments(
    owner,
    timelinePropertyIds.get(String(owner._id)) || new Set(),
    extraPropertyById
  );
  const currentlyAssociatedProperties = filterOwnerPropertiesByCurrentAssociation(
    owner._id,
    ownerPropertyDocs,
    currentOwnerAssociationMap
  );

  const scopedAssociatedProperties = activeHoaId
    ? currentlyAssociatedProperties.filter((prop) => {
      if (prop.hoaId) return String(prop.hoaId) === activeHoaId;
      if (options.hoaContext?.propertyIds?.length) {
        return options.hoaContext.propertyIds.some((pid) => String(pid) === String(prop._id || prop));
      }
      return true;
    })
    : currentlyAssociatedProperties;

  const formattedProperties = scopedAssociatedProperties.map((prop) => {
    const addressParts = [];
    if (prop.address?.street) addressParts.push(prop.address.street);
    if (prop.address?.line2) addressParts.push(prop.address.line2);
    if (prop.address?.city) addressParts.push(prop.address.city);
    if (prop.address?.state) addressParts.push(prop.address.state);
    if (prop.address?.zip) addressParts.push(prop.address.zip);

    return {
      id: prop._id.toString(),
      name: prop.name,
      unitName: prop.unitDetails?.[0]?.unitName || '',
      address: addressParts.length > 0 ? addressParts.join(', ') : '',
      ownershipEffectiveDate: resolveOwnerPropertyEffectiveDate(
        owner._id,
        prop._id,
        currentOwnerAssociationMap
      ),
    };
  });

  const propertyIds = currentlyAssociatedProperties.map((p) => p._id);
  const propertyById = new Map(currentlyAssociatedProperties.map((p) => [String(p._id), p]));
  const totalFees = currentlyAssociatedProperties.reduce(
    (sum, property) => sum + (Number(property.monthlyRecurringFee) || 0),
    0,
  );
  const primaryProperty = currentlyAssociatedProperties[0] || null;
  const recurringFeesEndDate = toRecurringFeesEndDate(
    primaryProperty?.balanceAsOf,
    primaryProperty?.paymentTerm,
  );
  const primaryOwnershipEffectiveDate = formattedProperties[0]?.ownershipEffectiveDate || null;

  const response = { _id: owner._id };

  if (include.has('profile')) {
    Object.assign(response, {
      firstName: owner.firstName,
      lastName: owner.lastName,
      email: owner.email,
      phone: owner.phone,
      secondaryPhone: owner.secondaryPhone || null,
      isDifferentMailingAddress: owner.isDifferentMailingAddress || false,
      mailingAddress: owner.mailingAddress || null,
      auxiliaryEmails: owner.auxiliaryEmails || [],
      emergencyContact: owner.emergencyContact || null,
      initials: `${(owner.firstName || 'U')[0]}${(owner.lastName || 'N')[0]}`,
      properties: formattedProperties,
      ownerSince: primaryOwnershipEffectiveDate || owner.createdAt,
      ownershipEffectiveDate: primaryOwnershipEffectiveDate,
      currentStatus: formattedProperties.length > 0
        ? `${formattedProperties[0].unitName} | ${formattedProperties[0].name}`
        : null,
      fullAddress: owner.address || (owner.mailingAddress
        ? [owner.mailingAddress.line1, owner.mailingAddress.line2, owner.mailingAddress.city, owner.mailingAddress.state, owner.mailingAddress.zipCode]
          .filter(Boolean).join(', ')
        : null),
      fees: totalFees,
      balanceAsOf: primaryProperty?.balanceAsOf || null,
      recurringFeesEndDate,
      invoiceScheduleMeta: await (async () => {
        try {
          const { getInvoiceScheduleMetaForOwnerUnits } = require('../services/invoiceScheduleMeta.service');
          return await getInvoiceScheduleMetaForOwnerUnits(propertyIds);
        } catch (metaErr) {
          logger.warn('[owner] invoiceScheduleMeta failed:', metaErr?.message || metaErr);
          return { daysUntilNextInvoiceGeneration: null, units: [] };
        }
      })(),
      notes: owner.notes || [],
      communicationPreference: owner.communicationPreference || 'email',
      createdAt: owner.createdAt,
      updatedAt: owner.updatedAt,
      portalOnboardingStatus: owner.portalOnboardingStatus || null,
      accountVerificationLabel:
        portalVerificationDisplay(owner.portalOnboardingStatus)
        || (owner.status === USER_STATUSES.ACTIVE ? 'Active' : (owner.status || 'Active')),
      userAccountStatus: owner.status || USER_STATUSES.ACTIVE,
    });
  }

  const sectionTasks = [];

  if (include.has('financials')) {
    sectionTasks.push((async () => {
      const Invoice = require('../../invoice/model/invoice.model');
      // Calendar-day boundary (business TZ), same basis as ledger overdue/due-today.
      const todayStart = DateUtil.startOfDayEST(ClockService.now()) || ClockService.now();

      if (propertyIds.length === 0) {
        Object.assign(response, {
          invoices: { current: [], pastDue: [] },
          ownerRecord: { autoPay: 0, latePayment: false, totalAmountPaid: 0 },
          paymentSummary: { totalRentCollected: 0, otherCollected: 0, total: 0 },
          balanceTotals: {
            pastDueAmount: 0,
            dueTodayAmount: 0,
            creditBalance: 0,
            remainingCredit: 0,
            netBalance: 0,
          },
        });
        return;
      }

      const invoiceProjection = {
        propertyId: 1,
        invoiceId: 1,
        dueDate: 1,
        status: 1,
        subAmount: 1,
        alreadyPaid: 1,
        balanceDue: 1,
        processingAmount: 1,
        waivedAmount: 1,
        propertyName: 1,
        unit: 1,
        type: 1,
      };

      const mapInvoiceRow = (inv) => {
        const property = propertyById.get(String(inv.propertyId));
        const rawUnit = String(inv.unit || '').trim();
        const liveUnitName = resolveInvoiceUnitLabelFromProperty(property, rawUnit);
        return {
          id: inv._id,
          _id: inv._id,
          invoiceNumber: inv.invoiceId,
          dueDate: inv.dueDate,
          amount: inv.status === 'Paid' || inv.status === 'Waived' ? inv.subAmount : inv.balanceDue,
          alreadyPaid: inv.alreadyPaid || 0,
          balanceDue: inv.balanceDue || 0,
          processingAmount: inv.processingAmount || 0,
          waivedAmount: inv.waivedAmount || 0,
          status: inv.status,
          propertyId: inv.propertyId,
          propertyName: inv.propertyName || property?.name || 'N/A',
          unit: liveUnitName && liveUnitName !== 'Unit' ? liveUnitName : (rawUnit || 'N/A'),
          unitName: liveUnitName && liveUnitName !== 'Unit' ? liveUnitName : (rawUnit || 'N/A'),
        };
      };

      const [facetResult] = await Invoice.aggregate([
        {
          $match: {
            propertyId: { $in: propertyIds },
            tenants: new mongoose.Types.ObjectId(String(ownerId)),
            isDeleted: { $ne: true },
          },
        },
        {
          $facet: {
            current: [
              { $match: { dueDate: { $gte: todayStart } } },
              { $sort: { dueDate: -1 } },
              { $limit: 50 },
              { $project: invoiceProjection },
            ],
            pastDue: [
              { $match: { dueDate: { $lt: todayStart } } },
              { $sort: { dueDate: -1 } },
              { $limit: 50 },
              { $project: invoiceProjection },
            ],
            paymentTotals: [
              {
                $addFields: {
                  collectedAmount: {
                    $cond: [
                      { $eq: ['$status', 'Paid'] },
                      { $ifNull: ['$subAmount', 0] },
                      { $ifNull: ['$alreadyPaid', 0] },
                    ],
                  },
                },
              },
              { $match: { collectedAmount: { $gt: 0 } } },
              {
                $group: {
                  _id: '$type',
                  total: { $sum: '$collectedAmount' },
                },
              },
            ],
          },
        },
      ]);

      const currentInvoices = (facetResult?.current || []).map(mapInvoiceRow);
      const pastDueInvoices = (facetResult?.pastDue || []).map(mapInvoiceRow);

      let totalRentCollected = 0;
      let otherCollected = 0;
      for (const row of facetResult?.paymentTotals || []) {
        if (HOA_BOARD_FEE_INVOICE_TYPES.includes(row._id)) totalRentCollected += row.total || 0;
        else otherCollected += row.total || 0;
      }

      // Same ledger balance source as Property Listing / unit balance detail
      // so Owner Detail overdue/credit/net stay synchronized after payments.
      const ledgerService = require('../services/ledger.service');
      const balanceSummaries = await ledgerService.getBalanceSummariesBatch(propertyIds, {
        readOnly: true,
      });
      let pastDueAmount = 0;
      let dueTodayAmount = 0;
      let remainingCredit = 0;
      let netBalance = 0;
      for (let i = 0; i < propertyIds.length; i += 1) {
        const summary = balanceSummaries[String(propertyIds[i])];
        if (!summary) continue;
        const display = ledgerService.portfolioDisplayBalanceFromSummary(summary);
        pastDueAmount += Number(display.pastDueAmount || 0);
        dueTodayAmount += Number(display.dueTodayAmount || 0);
        const pool = Number(summary.remainingCredit || 0);
        remainingCredit += pool;
        netBalance += Number(display.netBalance || 0);
      }
      // Available/advance credit only - not portfolio "credit applied toward overdue" math.
      const creditBalance = Math.max(remainingCredit, Math.max(0, -netBalance));

      Object.assign(response, {
        invoices: {
          current: currentInvoices,
          pastDue: pastDueInvoices,
        },
        ownerRecord: {
          autoPay: 0,
          latePayment: pastDueInvoices.length > 0,
          totalAmountPaid: totalRentCollected + otherCollected,
        },
        paymentSummary: {
          totalRentCollected,
          otherCollected,
          total: totalRentCollected + otherCollected,
        },
        balanceTotals: {
          pastDueAmount: roundMoney(pastDueAmount),
          dueTodayAmount: roundMoney(dueTodayAmount),
          creditBalance: roundMoney(creditBalance),
          remainingCredit: roundMoney(remainingCredit),
          netBalance: roundMoney(netBalance),
        },
      });
    })());
  }

  if (include.has('messages')) {
    sectionTasks.push((async () => {
      const messages = await Message.findRecentForUser(ownerId, 10);

      Object.assign(response, {
        messageHistory: Message.formatHistoryForOwner(messages, owner),
      });
    })());
  }

  if (include.has('documents')) {
    sectionTasks.push((async () => {
      let linkedDocuments = [];
      try {
        const hoaContext = options.hoaContext || null;
        const role = options.role
          || (hoaContext?.isHOAOwner ? 'HOA Owner' : 'HOA Board Member');
        const viewer = options.viewer && typeof options.viewer === 'object'
          ? options.viewer
          : { userId: hoaContext?.userId || options.userId || null, email: options.email || null };
        const ownerDocsResult = await getHOADocumentsForOwner(owner._id.toString(), {
          role,
          hoaContext,
          viewer,
        });
        linkedDocuments = ownerDocsResult.data || [];
      } catch (docErr) {
        logger.warn('Failed to load linked HOA documents for owner:', docErr.message);
      }
      Object.assign(response, { documents: linkedDocuments });
    })());
  }

  if (sectionTasks.length > 0) {
    await Promise.all(sectionTasks);
  }

  return response;
}

/**
 * Issue a fresh portal verification invite. Supersedes pending tokens and optionally
 * resets onboarding status + invalidates active sessions (email change / resend).
 */
async function issueOwnerPortalVerificationInvite(ownerId, options = {}) {
  if (!ownerId) {
    const err = new Error('ownerId is required');
    err.status = 400;
    throw err;
  }

  const owner = options.owner || await User.findById(ownerId).lean();
  if (!owner || owner.isDeleted) {
    const err = new Error('Owner not found');
    err.status = 404;
    throw err;
  }

  if (options.userId && owner.hoaBoardMemberId && owner.hoaBoardMemberId.toString() !== options.userId.toString()) {
    const err = new Error('Unauthorized to send invitation for this owner');
    err.status = 403;
    throw err;
  }

  if (!owner.email || !String(owner.email).trim()) {
    const err = new Error('This owner has no email address on file');
    err.status = 400;
    throw err;
  }

  const validationOptions = {
    context: options.validationContext || 'ownerPortalInvite',
    metadata: { ownerId: String(ownerId) },
    skipMx: true,
    skipSmtpRcpt: true,
    skipMailbox: true,
    skipSuppression: true,
  };
  await assertOwnerEmailAcceptable(owner.email, validationOptions);

  const inviterRolePromise = options.userId
    ? portalInvitationService.assertInviterRole(options.userId, ['HOA Board Member'])
    : Promise.resolve();
  const portalInviteHoaContextPromise = resolveHoaIdForOwnerPortalInvite(
    owner,
    options.hoaContext || null,
  );

  if (options.resetOnboardingStatus !== false) {
    await User.updateOne(
      { _id: ownerId },
      {
        $set: { portalOnboardingStatus: PORTAL_ONBOARDING_STATUS.INVITATION_SENT },
        $unset: { refreshToken: '' },
      }
    );
  }

  await inviterRolePromise;
  const portalInviteHoaContext = await portalInviteHoaContextPromise;

  const invitePayload = {
    inviteeUserId: ownerId,
    inviterUserId: options.userId,
    tenantName: owner.firstName || 'there',
    hoaContext: portalInviteHoaContext,
    skipRecipientValidation: true,
  };

  if (options.delivery === 'background') {
    setImmediate(() => {
      portalInvitationService.issueHoaOwnerPortalInvite(invitePayload).catch((inviteErr) => {
        console.warn('[issueOwnerPortalVerificationInvite] Background invite failed:', inviteErr?.message || inviteErr);
      });
    });
    return {
      emailedTo: owner.email,
      invitationQueued: true,
    };
  }

  await portalInvitationService.issueHoaOwnerPortalInvite(invitePayload);

  return {
    emailedTo: owner.email,
    invitationQueued: false,
  };
}

async function resendOwnerInvite(ownerId, options = {}) {
  const owner = await User.findById(ownerId).lean();
  if (!owner || owner.isDeleted) {
    const err = new Error('Owner not found');
    err.status = 404;
    throw err;
  }

  if (owner.portalOnboardingStatus === PORTAL_ONBOARDING_STATUS.ACTIVE) {
    const err = new Error('This owner has already completed invitation onboarding');
    err.status = 400;
    throw err;
  }

  return issueOwnerPortalVerificationInvite(ownerId, {
    ...options,
    owner,
    delivery: 'background',
    lightweightRecipientValidation: true,
    validationContext: 'ownerPortalInviteResend',
  });
}

async function updateOwner(ownerId, ownerData, options = {}) {
  if (!ownerId) {
    const err = new Error('ownerId is required');
    err.status = 400;
    throw err;
  }

  try {
    const owner = await findOwnerDocumentById(ownerId);

    // Check if user has permission to update this owner
    if (options.userId && owner.hoaBoardMemberId && owner.hoaBoardMemberId.toString() !== options.userId.toString()) {
      const err = new Error('Unauthorized to update this owner');
      err.status = 403;
      throw err;
    }

    const previousEmail = normalizeOwnerEmail(owner.email || '');
    const nextEmail = ownerData.email ? normalizeOwnerEmail(ownerData.email) : previousEmail;
    const emailChanged = Boolean(ownerData.email) && nextEmail !== previousEmail;

    if (emailChanged) {
      await assertUniqueOwnerEmail(nextEmail, ownerId);
      const emailConfirm = ownerData.emailConfirm
        ? normalizeOwnerEmail(ownerData.emailConfirm)
        : '';
      const requireConfirm = !['0', 'false', 'no', 'off'].includes(
        String(process.env.EMAIL_REQUIRE_EMAIL_CONFIRM || 'false').trim().toLowerCase()
      );
      if (requireConfirm && !emailConfirm) {
        const err = new Error('Re-enter the email address to confirm before sending a verification invite');
        err.status = 400;
        err.field = 'emailConfirm';
        throw err;
      }
      if (emailConfirm && emailConfirm !== nextEmail) {
        const err = new Error('Email addresses do not match');
        err.status = 400;
        err.field = 'emailConfirm';
        throw err;
      }
      await assertOwnerEmailAcceptable(nextEmail, {
        context: 'updateOwner:emailChange',
        metadata: { ownerId: String(ownerId) },
      });
    }
    delete ownerData.emailConfirm;

    if (ownerData.phone !== undefined) {
      ownerData.phone = coerceOptionalOwnerPhone(ownerData.phone);
    }

    // Build update object
    const updateData = {};
    if (ownerData.firstName) updateData.firstName = ownerData.firstName;
    if (ownerData.lastName) updateData.lastName = ownerData.lastName;
    if (ownerData.email) updateData.email = nextEmail;
    if (ownerData.phone !== undefined) updateData.phone = ownerData.phone;
    if (ownerData.secondaryPhone !== undefined) updateData.secondaryPhone = ownerData.secondaryPhone;
    if (ownerData.auxiliaryEmails) updateData.auxiliaryEmails = ownerData.auxiliaryEmails;
    if (ownerData.emergencyContact !== undefined) updateData.emergencyContact = ownerData.emergencyContact;
    if (ownerData.propertyIds !== undefined) updateData.propertyIds = ownerData.propertyIds;
    if (ownerData.hasUnits !== undefined) updateData.hasUnits = ownerData.hasUnits;
    if (ownerData.isDifferentMailingAddress !== undefined) updateData.isDifferentMailingAddress = ownerData.isDifferentMailingAddress;

    // Determine the effective isDifferentMailingAddress value
    const effectiveIsDifferent = ownerData.isDifferentMailingAddress !== undefined
      ? ownerData.isDifferentMailingAddress
      : owner.isDifferentMailingAddress;

    // Resolve mailing address
    if (effectiveIsDifferent === false) {
      // Use first assigned property's address as mailing address
      const propertyIds = ownerData.propertyIds !== undefined ? ownerData.propertyIds : owner.propertyIds || [];
      if (propertyIds.length > 0) {
        const Property = require('../../property/model/property.model');
        const firstProperty = await Property.findById(propertyIds[0]).lean();
        if (firstProperty?.address) {
          const resolvedMailingAddress = parsePropertyAddress(firstProperty.address);
          updateData.mailingAddress = resolvedMailingAddress;

          // Extract and update flat address fields
          const flatAddressFields = extractFlatAddressFields(resolvedMailingAddress);
          updateData.address = flatAddressFields.address;
          updateData.city = flatAddressFields.city;
          updateData.state = flatAddressFields.state;
          updateData.zipCode = flatAddressFields.zip;
        }
      } else {
        updateData.mailingAddress = null;
        updateData.address = null;
        updateData.city = null;
        updateData.state = null;
        updateData.zipCode = null;
      }
    } else if (ownerData.mailingAddress) {
      updateData.mailingAddress = ownerData.mailingAddress;

      // Extract and update flat address fields
      const flatAddressFields = extractFlatAddressFields(ownerData.mailingAddress);
      updateData.address = flatAddressFields.address;
      updateData.city = flatAddressFields.city;
      updateData.state = flatAddressFields.state;
      updateData.zipCode = flatAddressFields.zip;
    }

    updateData.updatedAt = ClockService.now();

    if (emailChanged) {
      updateData.portalOnboardingStatus = PORTAL_ONBOARDING_STATUS.INVITATION_SENT;
    }

    let updated;
    try {
      const updateOps = { $set: updateData };
      if (emailChanged) {
        updateOps.$unset = { refreshToken: '' };
      }
      updated = await User.findByIdAndUpdate(ownerId, updateOps, { new: true }).lean();
    } catch (persistErr) {
      throw mapOwnerPersistenceError(persistErr);
    }

    // Sync bidirectional relationship if propertyIds changed
    if (ownerData.propertyIds !== undefined) {
      const Property = require('../../property/model/property.model');
      const oldPropertyIds = owner.propertyIds || [];
      const newPropertyIds = ownerData.propertyIds || [];
      const idEq = (a, b) => String(a) === String(b);

      // Remove owner from old properties
      const removedPropertyIds = oldPropertyIds.filter((id) => !(newPropertyIds || []).some((nid) => idEq(id, nid)));
      if (removedPropertyIds.length > 0) {
        await Property.updateMany(
          { _id: { $in: toObjectIds(removedPropertyIds) } },
          { $pull: { associatedOwnerIds: ownerId } }
        );
      }

      // Add owner to new properties (ownership timeline + future invoice payers).
      const addedPropertyIds = newPropertyIds.filter((id) => !oldPropertyIds.some((oldId) => idEq(oldId, id)));
      if (addedPropertyIds.length > 0) {
        const unitService = require('../services/unit.service');
        await unitService.linkOwnerToUnitsFromOwnerFlow(addedPropertyIds, ownerId, {
          userId: options.userId,
          hoaBoardMemberId: options.userId,
          createdBy: options.userId,
          source: 'update-owner',
          hoaId: options.hoaContext?.hoaId || owner.hoaInfo?.hoaId || null,
        });

        await unitService.ensureInvoicesWhenOwnerLinkedToUnits(addedPropertyIds, ownerId, {
          userId: options.userId,
          hoaBoardMemberId: options.userId,
          createdBy: options.userId,
          hoaId: options.hoaContext?.hoaId,
        });
      }
    }

    // Log activity
    await logActivity({
      userId: options.userId,
      action: 'UPDATE',
      module: 'Owner',
      entityId: updated._id,
      hoaId: options.hoaContext?.hoaId || updated.hoaInfo?.hoaId || undefined,
      entityName: `${updated.firstName} ${updated.lastName}`,
      description: `Updated owner "${updated.firstName} ${updated.lastName}"`,
      meta: { email: updated.email, hoaId: options.hoaContext?.hoaId || updated.hoaInfo?.hoaId }
    });

    let invitationResent = false;
    let invitationError = null;
    if (emailChanged && updated.email) {
      try {
        await withOwnerInviteSendTimeout(
          issueOwnerPortalVerificationInvite(ownerId, {
            userId: options.userId,
            hoaContext: options.hoaContext || null,
            resetOnboardingStatus: false,
          }),
          'updateOwner verification invitation'
        );
        invitationResent = true;
      } catch (inviteErr) {
        invitationError =
          inviteErr?.isEmailValidationError || inviteErr?.status === 400
            ? inviteErr.message
            : "We're having trouble sending the verification email right now. You can resend it from the owner profile.";
        logger.warn('[updateOwner] Failed to send verification email after email change:', inviteErr.message);
      }
    }

    return {
      _id: updated._id,
      firstName: updated.firstName,
      lastName: updated.lastName,
      email: updated.email,
      phone: updated.phone,
      secondaryPhone: updated.secondaryPhone,
      mailingAddress: updated.mailingAddress,
      auxiliaryEmails: updated.auxiliaryEmails,
      emergencyContact: updated.emergencyContact,
      updatedAt: updated.updatedAt,
      portalOnboardingStatus: updated.portalOnboardingStatus,
      emailVerificationRequired: Boolean(emailChanged),
      invitationResent,
      invitationError,
    };
  } catch (e) {
    throw mapOwnerPersistenceError(e);
  }
}

async function archiveOwner(ownerId, options = {}) {
  if (!ownerId) {
    const err = new Error('ownerId is required');
    err.status = 400;
    throw err;
  }

  const owner = await findOwnerDocumentById(ownerId);

  if (options.userId && owner.hoaBoardMemberId && owner.hoaBoardMemberId.toString() !== options.userId.toString()) {
    const err = new Error('Unauthorized to archive this owner');
    err.status = 403;
    throw err;
  }

  const newArchivedState = !owner.isArchived;
  const updated = await User.findByIdAndUpdate(ownerId, { $set: { isArchived: newArchivedState } }, { new: true }).lean();

  // Log activity
  await logActivity({
    userId: options.userId,
    action: newArchivedState ? 'ARCHIVE' : 'RESTORE',
    module: 'Owner',
    entityId: updated._id,
    hoaId: options.hoaContext?.hoaId || owner.hoaInfo?.hoaId || undefined,
    entityName: `${updated.firstName} ${updated.lastName}`,
    description: `${newArchivedState ? 'Archived' : 'Unarchived'} owner "${updated.firstName} ${updated.lastName}"`,
    meta: { email: updated.email, hoaId: options.hoaContext?.hoaId || owner.hoaInfo?.hoaId }
  });

  return updated;
}

const endOwnershipRecordsForDeletedOwner = (records, ownerId, endDate) => {
  const ownerStr = String(ownerId);
  const endedAt = endDate instanceof Date ? endDate : (DateUtil.toUTC(endDate) || ClockService.now());
  return (Array.isArray(records) ? records : []).map((record) => {
    const recordOwnerId = record.ownerId?.toString?.() || String(record.ownerId || '');
    if (recordOwnerId !== ownerStr) return record;
    const recordEnd = record.endDate ? DateUtil.toUTC(record.endDate) : null;
    if (recordEnd && recordEnd <= endedAt) return record;
    return { ...record, endDate: endedAt };
  });
};

async function getOwnerDeletePreview(ownerId, options = {}) {
  if (!ownerId) {
    const err = new Error('ownerId is required');
    err.status = 400;
    throw err;
  }

  const owner = await findOwnerDocumentById(ownerId, { lean: true });

  if (options.userId && owner.hoaBoardMemberId && owner.hoaBoardMemberId.toString() !== options.userId.toString()) {
    const err = new Error('Unauthorized to preview delete for this owner');
    err.status = 403;
    throw err;
  }

  const Property = require('../../property/model/property.model');
  const ledgerService = require('../services/ledger.service');
  const ownerOid = owner._id;

  const safeOwnerOid = toObjectId(ownerOid);
  const linkedPropertyQuery = {
    isDeleted: { $ne: true },
    $or: [{ associatedOwnerIds: safeOwnerOid }],
  };
  if (Array.isArray(owner.propertyIds) && owner.propertyIds.length > 0) {
    linkedPropertyQuery.$or.push({ _id: { $in: toObjectIds(owner.propertyIds) } });
  }

  const linkedProperties = await Property.find(linkedPropertyQuery)
    .select('_id name associatedOwnerIds unitDetails address')
    .lean();

  const soleOwnerFlags = await Promise.all(
    linkedProperties.map((prop) => isSoleActiveOwnerOnProperty(prop, ownerOid))
  );

  const soleOwnerUnitIds = linkedProperties
    .filter((_, index) => soleOwnerFlags[index])
    .map((prop) => prop._id);

  const balanceSummaries = soleOwnerUnitIds.length
    ? await ledgerService.getBalanceSummariesBatch(soleOwnerUnitIds, { readOnly: true })
    : {};

  const units = [];
  let portfolioAmountOwed = 0;
  let portfolioCreditApplied = 0;
  let unappliedCreditNoticeAmount = 0;
  let soleOwnerUnitCount = 0;

  linkedProperties.forEach((prop, index) => {
    const soleOwner = soleOwnerFlags[index];
    const unitName = prop.unitDetails?.[0]?.unitName || prop.name || 'Unit';
    let financials = {
      portfolioAmountOwed: 0,
      portfolioCreditApplied: 0,
      unappliedCreditNoticeAmount: 0,
    };

    if (soleOwner) {
      soleOwnerUnitCount += 1;
      const summary = balanceSummaries[String(prop._id)];
      if (summary) {
        financials = portfolioFromBalanceSummary(summary);
        portfolioAmountOwed += financials.portfolioAmountOwed;
        portfolioCreditApplied += financials.portfolioCreditApplied;
        unappliedCreditNoticeAmount += financials.unappliedCreditNoticeAmount;
      }
    }

    units.push({
      unitId: String(prop._id),
      unitName,
      propertyName: prop.name || 'Property',
      soleOwner,
      ...financials,
    });
  });

  const needsBalanceSettlement = soleOwnerUnitCount > 0 && portfolioAmountOwed > 0;

  return {
    owner: {
      _id: String(owner._id),
      firstName: owner.firstName,
      lastName: owner.lastName,
      email: owner.email,
      name: `${owner.firstName || ''} ${owner.lastName || ''}`.trim(),
    },
    linkedUnitCount: linkedProperties.length,
    soleOwnerUnitCount,
    portfolioAmountOwed: roundMoney(portfolioAmountOwed),
    portfolioCreditApplied: roundMoney(portfolioCreditApplied),
    unappliedCreditNoticeAmount: roundMoney(unappliedCreditNoticeAmount),
    needsBalanceSettlement,
    units,
  };
}

async function deleteOwner(ownerId, options = {}) {
  if (!ownerId) {
    const err = new Error('ownerId is required');
    err.status = 400;
    throw err;
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const owner = await findOwnerDocumentById(ownerId, { session });

    if (options.userId && owner.hoaBoardMemberId && owner.hoaBoardMemberId.toString() !== options.userId.toString()) {
      const err = new Error('Unauthorized to delete this owner');
      err.status = 403;
      throw err;
    }

    const Property = require('../../property/model/property.model');
    const ledgerService = require('../services/ledger.service');
    const ownerOid = owner._id;
    const deletedBy = options.userId || ownerOid;
    const now = ClockService.now();
    const originalEmail = owner.email;
    const deletePayload = options.deletePayload || {};
    const balanceSettlement = deletePayload.balanceSettlement || 'KEEP_AS_IS';
    const removalPayment =
      balanceSettlement === 'MARK_PAID' &&
        deletePayload.paymentMethod &&
        String(deletePayload.paymentMethod).trim()
        ? {
          paymentMethod: String(deletePayload.paymentMethod).trim(),
          checkNumber: deletePayload.checkNumber,
          moneyOrderNumber: deletePayload.moneyOrderNumber,
        }
        : null;

    const linkedPropertyQuery = {
      isDeleted: { $ne: true },
      $or: [{ associatedOwnerIds: ownerOid }],
    };
    if (Array.isArray(owner.propertyIds) && owner.propertyIds.length > 0) {
      linkedPropertyQuery.$or.push({ _id: { $in: toObjectIds(owner.propertyIds) } });
    }

    const linkedProperties = await Property.find(linkedPropertyQuery)
      .select('_id name hoaId ownershipRecords associatedOwnerIds unitDetails address')
      .session(session)
      .lean();

    const settlements = [];

    for (const prop of linkedProperties) {
      const soleOwner = await isSoleActiveOwnerOnProperty(prop, ownerOid);

      if (soleOwner) {
        await ledgerService.applyAllUnappliedCreditToDueInvoices(prop._id);
        await ledgerService.softDeleteFutureUnpaidInvoices(prop._id, deletedBy, session);
        const ownerlessSettlement = await ledgerService.settleUnitFinancialsWhenLastOwnerRemoved(
          prop._id,
          deletedBy,
          session,
          removalPayment,
          {
            removedOwnerId: String(ownerOid),
            balanceSettlement,
          }
        );
        settlements.push({ unitId: String(prop._id), ...ownerlessSettlement });
        await Property.findByIdAndUpdate(
          prop._id,
          { $set: { startingBalance: 0 }, $unset: { balanceAsOf: 1 } },
          { session }
        );
      } else {
        await ledgerService.softDeleteFutureUnpaidInvoicesForDeletedOwner(ownerOid, deletedBy, session, {
          propertyIds: [prop._id],
        });
      }

      await Property.findByIdAndUpdate(
        prop._id,
        {
          $pull: { associatedOwnerIds: ownerOid },
          $set: { ownershipRecords: endOwnershipRecordsForDeletedOwner(prop.ownershipRecords, ownerOid, now) },
        },
        { session }
      );
    }

    await User.findByIdAndUpdate(
      ownerId,
      {
        $set: {
          isDeleted: true,
          deletedAt: now,
          updatedAt: now,
          propertyIds: [],
        },
        $unset: { refreshToken: '' },
      },
      { session }
    );

    await session.commitTransaction();

    await logActivity({
      userId: options.userId,
      action: 'DELETE',
      module: 'Owner',
      entityId: owner._id,
      entityName: `${owner.firstName} ${owner.lastName}`,
      description: `Deleted owner "${owner.firstName} ${owner.lastName}"`,
      meta: { email: originalEmail, balanceSettlement, settlements },
    });

    setImmediate(async () => {
      try {
        for (const prop of linkedProperties) {
          await sendOwnerRemovalNoticeEmail({
            owner,
            property: prop,
            action: 'delete',
            balanceSettlement,
            performedBy: deletedBy,
          });
        }
      } catch (emailErr) {
        logger.warn('[deleteOwner] Failed to send owner removal notice:', emailErr.message);
      }
    });

    return {
      message: 'Owner deleted successfully',
      settlements,
      balanceSettlement,
      ownerName: `${owner.firstName || ''} ${owner.lastName || ''}`.trim() || 'Owner',
      hoaId: linkedProperties.find((prop) => prop.hoaId)?.hoaId || null,
    };
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
}

async function migrateLegacyOwnerNoteAttachments(owner) {
  if (!owner || !Array.isArray(owner.notes)) return false;
  let dirty = false;

  for (const note of owner.notes) {
    const current = Array.isArray(note.attachments) ? note.attachments : [];
    if (current.length === 0) continue;

    const next = [];
    for (const att of current) {
      if (isLegacyLocalNoteAttachment(att)) {
        if (att.path && fs.existsSync(att.path)) {
          try {
            const [metaId] = await uploadNoteAttachmentFiles({
              entityType: 'owner',
              entityId: String(owner._id),
              files: [
                {
                  path: att.path,
                  originalname: att.filename || 'attachment',
                  filename: att.filename,
                  mimetype: att.mimetype || 'application/octet-stream',
                  size: att.size || 0,
                },
              ],
            });
            if (metaId) {
              next.push(metaId);
              dirty = true;
              continue;
            }
          } catch (err) {
            logger.warn(`Failed to migrate owner note attachment ${att.path}:`, err.message);
          }
        }
        // Keep legacy record for display if migration failed / file missing
        next.push(att);
        continue;
      }
      next.push(att);
    }
    note.attachments = next;
  }

  return dirty;
}

async function enrichOwnerNotesForResponse(owner) {
  owner.notes = await enrichNotesWithAuthors(owner.notes || []);
  owner.notes = await enrichNotesAttachments(owner.notes || []);
  return owner;
}

async function addNoteToOwner(ownerId, noteData, files = [], userId) {
  const owner = await User.findById(ownerId);
  if (!owner || owner.isDeleted) {
    const err = new Error('Owner not found');
    err.status = 404;
    throw err;
  }

  await migrateLegacyOwnerNoteAttachments(owner);

  const uploadedMetaIds = await uploadNoteAttachmentFiles({
    entityType: 'owner',
    entityId: String(owner._id),
    files,
    maxSize: 10 * 1024 * 1024,
  });

  const now = ClockService.now();
  const newNote = {
    _id: new mongoose.Types.ObjectId(),
    title: noteData.title || '',
    description: noteData.description,
    noteNumber: nextEmbeddedNoteNumber(owner.notes),
    isPinned: noteData.isPinned || false,
    isImportant: noteData.isImportant || false,
    reminder: noteData.reminder ? (DateUtil.toUTC(noteData.reminder) || null) : null,
    reminderNotifiedAt: undefined,
    attachments: uploadedMetaIds,
    createdBy: userId || undefined,
    updatedBy: userId || undefined,
    createdAt: now,
    updatedAt: now
  };

  if (!owner.notes) owner.notes = [];
  owner.notes.push(newNote);
  await owner.save();

  const ownerLabel = `${owner.firstName || ''} ${owner.lastName || ''}`.trim() || 'Owner';
  if (userId) {
    await logEntityNoteActivity({
      userId,
      module: 'Owner',
      entityId: owner._id,
      entityName: ownerLabel,
      action: 'created',
      noteTitle: newNote.title,
      notePreview: newNote.description,
    });
    if (newNote.reminder) {
      await logEntityNoteActivity({
        userId,
        module: 'Owner',
        entityId: owner._id,
        entityName: ownerLabel,
        action: 'reminder_set',
        noteTitle: newNote.title,
        notePreview: newNote.description,
        meta: { reminder: newNote.reminder },
      });
    }
  }

  return enrichOwnerNotesForResponse(owner);
}

async function updateNoteInOwner(ownerId, noteId, noteData, userId, files = []) {
  const owner = await User.findById(ownerId);
  if (!owner || owner.isDeleted) {
    const err = new Error('Owner not found');
    err.status = 404;
    throw err;
  }

  const note = owner.notes?.id(noteId);
  if (!note) {
    const err = new Error('Note not found');
    err.status = 404;
    throw err;
  }

  const prevPinned = Boolean(note.isPinned);
  const prevImportant = Boolean(note.isImportant);
  const prevReminder = note.reminder ? (DateUtil.toEpoch(note.reminder) ?? 0) : null;
  const ownerLabel = `${owner.firstName || ''} ${owner.lastName || ''}`.trim() || 'Owner';

  if (noteData.description !== undefined) note.description = noteData.description;
  if (noteData.title !== undefined) note.title = noteData.title;
  if (noteData.isPinned !== undefined) note.isPinned = noteData.isPinned;
  if (noteData.isImportant !== undefined) note.isImportant = noteData.isImportant;
  if (noteData.reminder !== undefined) {
    note.reminder = noteData.reminder ? (DateUtil.toUTC(noteData.reminder) || null) : null;
    note.reminderNotifiedAt = null;
  }

  await migrateLegacyOwnerNoteAttachments(owner);

  const removedAttachmentCount = await removeOwnerNoteAttachments(note, noteData.removeAttachmentIds);
  const uploadedMetaIds = await uploadNoteAttachmentFiles({
    entityType: 'owner',
    entityId: String(owner._id),
    files: files || [],
    maxSize: 10 * 1024 * 1024,
  });
  if (uploadedMetaIds.length > 0) {
    note.attachments = [...(note.attachments || []), ...uploadedMetaIds];
  }

  const hasDescription = Boolean(String(note.description || '').trim());
  const hasAttachments = Array.isArray(note.attachments) && note.attachments.length > 0;
  if (!hasDescription && !hasAttachments) {
    const err = new Error('Note description or at least one attachment is required');
    err.status = 400;
    throw err;
  }
  if (!hasDescription && hasAttachments) {
    note.description = 'Attachment added.';
  }

  if (userId) note.updatedBy = userId;
  note.updatedAt = ClockService.now();

  await owner.save();

  if (userId) {
    const contentChanged =
      noteData.description !== undefined ||
      noteData.title !== undefined ||
      removedAttachmentCount > 0 ||
      uploadedMetaIds.length > 0;

    if (typeof noteData.isPinned === 'boolean' && noteData.isPinned !== prevPinned) {
      await logEntityNoteActivity({
        userId,
        module: 'Owner',
        entityId: owner._id,
        entityName: ownerLabel,
        action: noteData.isPinned ? 'pinned' : 'unpinned',
        noteTitle: note.title,
        notePreview: note.description,
      });
    }
    if (typeof noteData.isImportant === 'boolean' && noteData.isImportant !== prevImportant) {
      await logEntityNoteActivity({
        userId,
        module: 'Owner',
        entityId: owner._id,
        entityName: ownerLabel,
        action: noteData.isImportant ? 'important' : 'unimportant',
        noteTitle: note.title,
        notePreview: note.description,
      });
    }
    if (contentChanged) {
      await logEntityNoteActivity({
        userId,
        module: 'Owner',
        entityId: owner._id,
        entityName: ownerLabel,
        action: 'updated',
        noteTitle: note.title,
        notePreview: note.description,
      });
    }
    if (noteData.reminder !== undefined) {
      const nextReminder = note.reminder ? (DateUtil.toEpoch(note.reminder) ?? 0) : null;
      await logEntityNoteActivity({
        userId,
        module: 'Owner',
        entityId: owner._id,
        entityName: ownerLabel,
        action: nextReminder ? (prevReminder ? 'reminder_updated' : 'reminder_set') : 'reminder_cleared',
        noteTitle: note.title,
        notePreview: note.description,
        meta: { reminder: note.reminder },
      });
    }
  }

  return enrichOwnerNotesForResponse(owner);
}

async function removeOwnerNoteAttachments(note, removeAttachmentIds = []) {
  const removeSet = new Set(parseRemoveAttachmentIds(removeAttachmentIds));
  if (removeSet.size === 0) return 0;

  for (const att of note.attachments || []) {
    const id = getAttachmentId(att);
    if (id && removeSet.has(id) && isLegacyLocalNoteAttachment(att) && att.path) {
      try {
        fs.unlinkSync(att.path);
      } catch (err) {
        logger.warn(`Failed to delete owner note attachment file ${att.path}:`, err.message);
      }
    }
  }

  const removedIds = await removeAttachmentsFromNote(note, removeAttachmentIds);
  return removedIds.length;
}

async function exportOwners(userId, format = 'csv', hoaContext = null, listFilters = {}) {
  const filter = await buildOwnerListMongoFilter({
    userId,
    hoaContext,
    search: listFilters.search || '',
    showArchived: listFilters.showArchived === true || listFilters.showArchived === 'true',
    accountStatusGroup: listFilters.accountStatusGroup || '',
    accountStatus: listFilters.accountStatus || '',
    property: listFilters.property || '',
    propertyId: listFilters.propertyId || '',
    unitId: listFilters.unitId || '',
    unitName: listFilters.unitName || '',
    ownerId: listFilters.ownerId || '',
    ownerStatus: listFilters.ownerStatus || '',
    paymentStatus: listFilters.paymentStatus || '',
    feesExpiringThisYear: listFilters.feesExpiringThisYear === true || listFilters.feesExpiringThisYear === 'true',
  });

  const owners = await User.find(filter).limit(10000).select(
    'firstName lastName email phone secondaryPhone mailingAddress auxiliaryEmails emergencyContact'
  ).lean();

  const headers = [
    'firstName', 'lastName', 'email', 'phone', 'secondaryPhone',
    'mailingAddress[line1]', 'mailingAddress[line2]', 'mailingAddress[city]',
    'mailingAddress[state]', 'mailingAddress[zipCode]',
    'auxiliaryEmails',
    'emergencyContact[firstName]', 'emergencyContact[lastName]',
    'emergencyContact[phone]', 'emergencyContact[email]'
  ];

  const dataRows = owners.map(o => [
    o.firstName || '',
    o.lastName || '',
    o.email || '',
    o.phone || '',
    o.secondaryPhone || '',
    o.mailingAddress?.line1 || '',
    o.mailingAddress?.line2 || '',
    o.mailingAddress?.city || '',
    o.mailingAddress?.state || '',
    o.mailingAddress?.zipCode || '',
    (o.auxiliaryEmails || []).join(';'),
    o.emergencyContact?.firstName || '',
    o.emergencyContact?.lastName || '',
    o.emergencyContact?.phone || '',
    o.emergencyContact?.email || ''
  ]);

  if (format === 'csv') {
    const csv = [headers, ...dataRows].map(row => row.map(cell => {
      let s = cell == null ? '' : String(cell);
      if (/^[+\-=@]/.test(s.charAt(0))) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    }).join(',')).join('\n');
    return { content: csv, mimeType: 'text/csv', extension: 'csv' };
  }

  if (format === 'xlsx') {
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Owners');
    worksheet.addRow(headers);
    dataRows.forEach((row) => worksheet.addRow(row));
    worksheet.getRow(1).font = { bold: true };
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    return {
      content: buffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: 'xlsx',
    };
  }

  if (format === 'json') {
    const data = owners.map(o => ({
      firstName: o.firstName || '',
      lastName: o.lastName || '',
      email: o.email || '',
      phone: o.phone || '',
      secondaryPhone: o.secondaryPhone || '',
      'mailingAddress[line1]': o.mailingAddress?.line1 || '',
      'mailingAddress[line2]': o.mailingAddress?.line2 || '',
      'mailingAddress[city]': o.mailingAddress?.city || '',
      'mailingAddress[state]': o.mailingAddress?.state || '',
      'mailingAddress[zipCode]': o.mailingAddress?.zipCode || '',
      auxiliaryEmails: (o.auxiliaryEmails || []).join(';'),
      'emergencyContact[firstName]': o.emergencyContact?.firstName || '',
      'emergencyContact[lastName]': o.emergencyContact?.lastName || '',
      'emergencyContact[phone]': o.emergencyContact?.phone || '',
      'emergencyContact[email]': o.emergencyContact?.email || ''
    }));
    return { content: JSON.stringify(data, null, 2), mimeType: 'application/json', extension: 'json' };
  }
  throw new Error('Unsupported format');
}

/**
 * download Owner Template
 *
 * Performs logic operations for downloadOwnerTemplate.
 *
 * @param format - Request/input argument
 * @returns Operations result
 */
async function downloadOwnerTemplate(format = 'csv') {
  const headers = [
    'firstName', 'lastName', 'email', 'phone', 'secondaryPhone',
    'mailingAddress[line1]', 'mailingAddress[line2]', 'mailingAddress[city]',
    'mailingAddress[state]', 'mailingAddress[zipCode]',
    'auxiliaryEmails',
    'emergencyContact[firstName]', 'emergencyContact[lastName]',
    'emergencyContact[phone]', 'emergencyContact[email]',
    'propertyIds[]',
  ];
  const sampleRow = [
    'John', 'Doe', 'john.doe@example.com', '555-1234', '555-5678',
    '123 Main St', 'Apt 4', 'Los Angeles', 'CA', '90001',
    'alt@example.com',
    'Jane', 'Doe', '555-9999', 'jane@example.com',
    '',
  ];
  if (format === 'csv') {
    const csv = [headers, sampleRow].map(row => row.map(cell => {
      let s = cell == null ? '' : String(cell);
      if (/^[+\-=@]/.test(s.charAt(0))) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    }).join(',')).join('\n');
    return { content: csv, mimeType: 'text/csv', extension: 'csv' };
  }
  if (format === 'xlsx') {
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Owners');
    worksheet.addRow(headers);
    worksheet.addRow(sampleRow);
    worksheet.getRow(1).font = { bold: true };
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    return {
      content: buffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: 'xlsx',
    };
  }
  if (format === 'json') {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = sampleRow[i]; });
    return { content: JSON.stringify([obj], null, 2), mimeType: 'application/json', extension: 'json' };
  }
  throw new Error('Unsupported format');
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  values.push(current.trim());
  return values;
}

/**
 * parse Csv Owners
 *
 * Performs logic operations for parseCsvOwners.
 *
 * @param content - Request/input argument
 * @returns Operations result
 */
function parseCsvOwners(content) {
  const lines = String(content || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter(l => l.trim());
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]).map(h => h.replace(/^"|"$/g, '').trim());
  return lines.slice(1).map(line => {
    const values = parseCsvLine(line).map(v => v.replace(/^"|"$/g, '').trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] || ''; });
    return row;
  });
}

async function parseExcelOwners(buffer) {
  // Validate XLSX magic bytes (PK ZIP header) and minimum ZIP size before deserializing
  const MIN_XLSX_SIZE = 22; // end-of-central-directory record minimum
  if (!Buffer.isBuffer(buffer) || buffer.length < MIN_XLSX_SIZE ||
    buffer[0] !== 0x50 || buffer[1] !== 0x4B || buffer[2] !== 0x03 || buffer[3] !== 0x04) {
    throw Object.assign(new Error('Invalid XLSX file format'), { status: 400 });
  }
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];

  let headers = [];
  const rows = [];
  worksheet.eachRow((row, rowNumber) => {
    const values = row.values.slice(1).map((v) => {
      if (v == null) return '';
      if (typeof v === 'object' && v.text) return String(v.text).trim();
      return String(v).trim();
    });
    if (rowNumber === 1) {
      headers = values;
      return;
    }
    const obj = {};
    headers.forEach((h, i) => { obj[h] = values[i] || ''; });
    rows.push(obj);
  });
  return rows;
}

async function importOwnersFromFile(fileObj, userId, hoaContext = null) {
  if (!fileObj || typeof fileObj !== 'object') {
    const err = new Error('file is required'); err.status = 400; throw err;
  }
  if (!userId) {
    const err = new Error('userId is required'); err.status = 400; throw err;
  }

  const sanitize = (value) => {
    let s = value == null ? '' : String(value).trim();
    if (/^[=+\-@]+/.test(s)) s = s.replace(/^[=+\-@]+/, '').trim();
    return s;
  };

  let content;
  let buffer;
  if (fileObj.buffer && Buffer.isBuffer(fileObj.buffer)) {
    buffer = fileObj.buffer;
    content = fileObj.buffer.toString('utf8');
  } else {
    const err = new Error('Unsupported file object: expected multer file with buffer');
    err.status = 400; throw err;
  }

  let rows;
  const originalName = (fileObj.originalname || '').toLowerCase();
  if (originalName.endsWith('.json')) {
    try {
      const parsed = JSON.parse(content);
      rows = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      const err = new Error('Invalid JSON file'); err.status = 400; throw err;
    }
  } else if (originalName.endsWith('.xlsx') || originalName.endsWith('.xls')) {
    rows = await parseExcelOwners(buffer);
  } else {
    rows = parseCsvOwners(content);
  }

  const MAX_OWNER_IMPORT_ROWS = 5000;
  if (rows.length > MAX_OWNER_IMPORT_ROWS) {
    const err = new Error(`Import is limited to ${MAX_OWNER_IMPORT_ROWS} rows. Split the file and try again.`);
    err.status = 400;
    throw err;
  }

  if (rows.length === 0) return { totalRows: 0, created: [], failed: [] };

  const created = [];
  const failed = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const firstName = sanitize(row.firstName);
    const lastName = sanitize(row.lastName);
    const email = sanitize(row.email).toLowerCase();
    if (!firstName || !lastName || !email) {
      failed.push({ row: i + 2, error: 'firstName, lastName, and email are required' });
      continue;
    }
    try {
      const propertyIds = String(row['propertyIds[]'] || row.propertyIds || '')
        .split(';')
        .map((id) => id.trim())
        .filter((id) => /^[0-9a-fA-F]{24}$/.test(id));

      const ownerData = {
        firstName,
        lastName,
        email,
        phone: sanitize(row.phone) || null,
        secondaryPhone: sanitize(row.secondaryPhone) || null,
        mailingAddress: (row['mailingAddress[line1]'] || row['mailingAddress[city]']) ? {
          line1: sanitize(row['mailingAddress[line1]'] || ''),
          line2: sanitize(row['mailingAddress[line2]'] || ''),
          city: sanitize(row['mailingAddress[city]'] || ''),
          state: sanitize(row['mailingAddress[state]'] || ''),
          zipCode: sanitize(row['mailingAddress[zipCode]'] || '')
        } : null,
        auxiliaryEmails: row.auxiliaryEmails
          ? String(row.auxiliaryEmails).split(';').map((e) => sanitize(e)).filter(Boolean)
          : [],
        emergencyContact: (row['emergencyContact[firstName]'] || row['emergencyContact[phone]']) ? {
          firstName: sanitize(row['emergencyContact[firstName]'] || ''),
          lastName: sanitize(row['emergencyContact[lastName]'] || ''),
          phone: sanitize(row['emergencyContact[phone]'] || ''),
          email: sanitize(row['emergencyContact[email]'] || '')
        } : null,
        propertyIds,
        sendInvite: false,
      };
      const result = await createOwner(ownerData, {
        userId,
        triggerInvite: false,
        hoaContext: hoaContext || null,
      });
      created.push({ row: i + 2, ownerId: result._id });
    } catch (e) {
      failed.push({ row: i + 2, error: e.message });
    }
  }

  return { totalRows: rows.length, created, failed };
}

async function deleteNoteFromOwner(ownerId, noteId, userId) {
  const owner = await User.findById(ownerId);
  if (!owner || owner.isDeleted) {
    const err = new Error('Owner not found');
    err.status = 404;
    throw err;
  }

  const note = owner.notes?.id(noteId);
  if (!note) {
    const err = new Error('Note not found');
    err.status = 404;
    throw err;
  }

  const ownerLabel = `${owner.firstName || ''} ${owner.lastName || ''}`.trim() || 'Owner';
  if (userId) {
    await logEntityNoteActivity({
      userId,
      module: 'Owner',
      entityId: owner._id,
      entityName: ownerLabel,
      action: 'deleted',
      noteTitle: note.title,
      notePreview: note.description,
    });
  }

  owner.notes.pull(noteId);
  await owner.save();
  return enrichOwnerNotesForResponse(owner);
}

/**
 * Lightweight owner rows for dropdowns / pickers (no notes, fees, or list DTO enrichment).
 */
async function listOwnersPicker({
  search = '',
  limit = 50,
  userId,
  hoaContext = null,
  propertyId = null,
  unitId = null,
  unitName = null,
}) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const filter = await buildOwnerUserFilter({ isArchived: { $ne: true } });

  const pickerPropertyIds = await resolveOwnerPickerPropertyIds({
    propertyId: propertyId || '',
    unitId: unitId || '',
    unitName: unitName || '',
  });
  const hasUnitScope = Boolean(pickerPropertyIds?.length);

  let assignedOwnerObjectIds = [];
  if (hasUnitScope) {
    const Property = require('../../property/model/property.model');
    const scopedObjectIds = pickerPropertyIds
      .map((id) => toObjectId(id))
      .filter(Boolean);
    const units = scopedObjectIds.length
      ? await Property.find({
        _id: { $in: scopedObjectIds },
        isDeleted: { $ne: true },
      })
        .select('_id associatedOwnerIds ownershipRecords createdAt')
        .lean()
      : [];

    assignedOwnerObjectIds = collectAssignedOwnerIdsFromUnits(units, getCurrentOwnerIdsFromUnit)
      .map((id) => toObjectId(id))
      .filter(Boolean);
  }

  // Unit-scoped invoice/owner pickers must follow unit association (same as property
  // detail), not User.propertyIds. HOA isolation via hoaInfo/propertyIds drops
  // co-owners whose reverse links were never synced.
  if (hasUnitScope) {
    const assignedFilter = {
      _id: { $in: assignedOwnerObjectIds },
      isDeleted: { $ne: true },
    };
    if (search && String(search).trim()) {
      const {
        buildOwnerUserMatchClauses,
        defaultEscapeRegex,
      } = require('../../property/helpers/propertyListSearch.helper');
      const clauses = buildOwnerUserMatchClauses(String(search).trim(), defaultEscapeRegex);
      if (clauses.length) {
        assignedFilter.$or = clauses;
      }
    }

    const owners = assignedOwnerObjectIds.length
      ? await User.find(assignedFilter)
        .select('firstName lastName email phone profileImage portalOnboardingStatus status isArchived isDeleted')
        .sort({ lastName: 1, firstName: 1 })
        .limit(cap)
        .lean()
      : [];

    return owners.map((owner) => ({
      _id: owner._id,
      name: `${owner.firstName || ''} ${owner.lastName || ''}`.trim() || owner.email || 'Owner',
      email: owner.email || '',
      phone: owner.phone || '',
      profileImage: owner.profileImage || null,
      portalOnboardingStatus: owner.portalOnboardingStatus || null,
      userAccountStatus: owner.status || USER_STATUSES.ACTIVE,
      ...buildOwnerEligibilityFields(owner),
      properties: [],
    }));
  }

  if (hoaContext && hoaContext.isHOABoardMember) {
    const { buildHoaOwnerUserFilter } = require('../../../../../middleware/hoaDataIsolation');
    const ownerScope = await buildHoaOwnerUserFilter(hoaContext);
    if (ownerScope) {
      filter.$and = [ownerScope];
    }
  } else if (userId) {
    filter.hoaBoardMemberId = userId;
  }

  if (search && String(search).trim()) {
    const {
      buildOwnerUserMatchClauses,
      defaultEscapeRegex,
    } = require('../../property/helpers/propertyListSearch.helper');
    const clauses = buildOwnerUserMatchClauses(String(search).trim(), defaultEscapeRegex);
    if (clauses.length) {
      const searchOr = { $or: clauses };
      if (filter.$and) {
        filter.$and.push(searchOr);
      } else if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, searchOr];
        delete filter.$or;
      } else {
        Object.assign(filter, searchOr);
      }
    }
  }

  const ownerQuery = User.find(filter)
    .select('firstName lastName email phone profileImage portalOnboardingStatus status isArchived isDeleted')
    .sort({ lastName: 1, firstName: 1 })
    .limit(cap)
    .populate('propertyIds', 'name unitDetails');

  const owners = await ownerQuery.lean();

  return owners.map((owner) => {
    const properties = (owner.propertyIds || []).map((prop) => ({
      id: String(prop._id),
      name: prop.name || '',
      unitName: prop.unitDetails?.[0]?.unitName || '',
    }));
    return {
      _id: owner._id,
      name: `${owner.firstName || ''} ${owner.lastName || ''}`.trim(),
      email: owner.email || '',
      phone: owner.phone || '',
      profileImage: owner.profileImage || null,
      portalOnboardingStatus: owner.portalOnboardingStatus || null,
      userAccountStatus: owner.status || USER_STATUSES.ACTIVE,
      ...buildOwnerEligibilityFields(owner),
      properties,
    };
  });
}

module.exports = {
  listOwners,
  listOwnersPicker,
  createOwner,
  getOwnerById,
  loadTimelinePropertyIdsByOwnerIds,
  parseOwnerDetailInclude,
  OWNER_DETAIL_SECTIONS,
  updateOwner,
  resendOwnerInvite,
  getOwnerDeletePreview,
  archiveOwner,
  deleteOwner,
  addNoteToOwner,
  updateNoteInOwner,
  deleteNoteFromOwner,
  exportOwners,
  downloadOwnerTemplate,
  importOwnersFromFile
};
