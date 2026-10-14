const mongoose = require('mongoose');

/**
 * ------------------------------------------------------------------
 * File: hoaDocumentAccess.js
 * Module: Documents Module
 *
 * Purpose:
 * Backend utility/module providing helper functions for hoaDocumentAccess.
 *
 * Used By:
 * hoaDocumentContext, hoa.service
 * ------------------------------------------------------------------
 */
const { isHOABoardMemberRole } = require('../../../../common/helpers/hoaBoardRole');

const ACCESS_LEVELS = {
  ALL_RESIDENTS: 'All Residents',
  OWNERS_ONLY: 'Owners Only',
  BOARD_ONLY: 'Board Only',
  SELECTIVE_BOARD_OWNER: 'Selective board + owner',
};

const ALL_LEVELS = [
  ACCESS_LEVELS.ALL_RESIDENTS,
  ACCESS_LEVELS.OWNERS_ONLY,
  ACCESS_LEVELS.BOARD_ONLY,
  ACCESS_LEVELS.SELECTIVE_BOARD_OWNER,
];

function isSelectiveBoardOwner(level) {
  if (!level) return false;
  const str = String(level).trim();
  return (
    str === ACCESS_LEVELS.SELECTIVE_BOARD_OWNER ||
    str.toUpperCase() === 'SELECTIVE_BOARD_OWNER' ||
    str.toLowerCase() === 'selective board + owner' ||
    str.toLowerCase() === 'selective'
  );
}

function normalizeAccessLevel(level) {
  if (!level) return '';
  if (isSelectiveBoardOwner(level)) return ACCESS_LEVELS.SELECTIVE_BOARD_OWNER;
  const str = String(level).trim();
  if (str === ACCESS_LEVELS.ALL_RESIDENTS || str.toUpperCase() === 'ALL_RESIDENTS' || str.toLowerCase() === 'all') {
    return ACCESS_LEVELS.ALL_RESIDENTS;
  }
  if (str === ACCESS_LEVELS.BOARD_ONLY || str.toUpperCase() === 'BOARD_ONLY' || str.toLowerCase() === 'board') {
    return ACCESS_LEVELS.BOARD_ONLY;
  }
  if (str === ACCESS_LEVELS.OWNERS_ONLY || str.toUpperCase() === 'OWNERS_ONLY' || str.toLowerCase() === 'owners') {
    return ACCESS_LEVELS.OWNERS_ONLY;
  }
  return str;
}

/**
 * normalize Role Name
 *
 * Performs logic operations for normalizeRoleName.
 *
 * @param role - Request/input argument
 * @returns Operations result
 */
function normalizeRoleName(role) {
  if (!role) return '';
  if (typeof role === 'object' && role !== null && role.name) {
    return String(role.name).toLowerCase().replace(/\s+/g, ' ').trim();
  }
  return String(role).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * is H O A Owner Role
 *
 * Performs logic operations for isHOAOwnerRole.
 *
 * @param role - Request/input argument
 * @returns Operations result
 */
function isHOAOwnerRole(role) {
  const n = normalizeRoleName(role);
  return n === 'hoa owner' || n === 'hoa_owner';
}

/**
 * is Tenant Role
 *
 * Performs logic operations for isTenantRole.
 *
 * @param role - Request/input argument
 * @returns Operations result
 */
function isTenantRole(role) {
  const n = normalizeRoleName(role);
  return n === 'tenant' || n === 'hoa tenant';
}

/**
 * is Admin Role
 *
 * Performs logic operations for isAdminRole.
 *
 * @param role - Request/input argument
 * @returns Operations result
 */
function isAdminRole(role) {
  const n = normalizeRoleName(role);
  return n === 'administrator' || n === 'admin' || n === 'super admin';
}

/**
 * to Id String
 *
 * Performs logic operations for toIdString.
 *
 * @param id - Request/input argument
 * @returns Operations result
 */
function toIdString(id) {
  if (!id) return '';
  return id.toString ? id.toString() : String(id);
}

/** 24-char hex only so aggregation $match can compare against ObjectId fields. */
function toQueryObjectId(id) {
  const raw = String(id || '').trim();
  if (!/^[a-fA-F0-9]{24}$/.test(raw)) return null;
  return new mongoose.Types.ObjectId(raw);
}

/**
 * list Contains Id
 *
 * Performs logic operations for listContainsId.
 *
 * @param list - Request/input argument
 * @param userId - Request/input argument
 * @returns Operations result
 */
function listContainsId(list, userId) {
  const uid = toIdString(userId);
  if (!uid || !Array.isArray(list)) return false;
  return list.some((id) => toIdString(id) === uid);
}

/**
 * normalize Email
 *
 * Performs logic operations for normalizeEmail.
 *
 * @param email - Request/input argument
 * @returns Operations result
 */
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function sameUserId(left, right) {
  const a = toIdString(left);
  const b = toIdString(right);
  return Boolean(a && b && a === b);
}

/**
 * is Uploader
 *
 * Performs logic operations for isUploader.
 *
 * @param document - Request/input argument
 * @param viewer - Request/input argument
 * @returns Operations result
 */
function isUploader(document, viewer = {}) {
  if (sameUserId(document?.uploadedById, viewer.userId)) {
    return true;
  }
  const viewerEmail = normalizeEmail(viewer.email);
  return Boolean(viewerEmail && normalizeEmail(document?.uploadedBy) === viewerEmail);
}

/**
 * Access levels that appear as empty-folder defaults for a role.
 * Board members do not treat "Owners Only" as a default board folder -
 * those documents are owner-audience unless explicitly shared with the board.
 */
function getVisibleAccessLevels(role) {
  if (isHOABoardMemberRole(role)) {
    return [
      ACCESS_LEVELS.ALL_RESIDENTS,
      ACCESS_LEVELS.BOARD_ONLY,
      ACCESS_LEVELS.SELECTIVE_BOARD_OWNER,
    ];
  }
  if (isHOAOwnerRole(role)) {
    return [ACCESS_LEVELS.ALL_RESIDENTS, ACCESS_LEVELS.OWNERS_ONLY, ACCESS_LEVELS.SELECTIVE_BOARD_OWNER];
  }
  // Residents / tenants / other HOA-linked roles
  return [ACCESS_LEVELS.ALL_RESIDENTS];
}

/**
 * can View Access Level
 *
 * Performs logic operations for canViewAccessLevel.
 *
 * @param role - Request/input argument
 * @param accessLevel - Request/input argument
 * @returns Operations result
 */
function canViewAccessLevel(role, accessLevel) {
  const normalized = normalizeAccessLevel(accessLevel);
  return getVisibleAccessLevels(role).includes(normalized);
}

/**
 * can View Document
 *
 * Performs logic operations for canViewDocument.
 *
 * @param role - Request/input argument
 * @param document - Request/input argument
 * @param viewer - Request/input argument
 * @returns Operations result
 */
function canViewDocument(role, document, viewer = {}) {
  if (!document) return false;
  const userId = viewer.userId;
  const accessLevel = normalizeAccessLevel(document.accessLevel);

  if (accessLevel === ACCESS_LEVELS.ALL_RESIDENTS) {
    return true;
  }

  if (accessLevel === ACCESS_LEVELS.BOARD_ONLY) {
    return isHOABoardMemberRole(role);
  }

  // Owners Only: owners who are recipients, or board only when explicitly shared.
  // Uploading as board does not grant library visibility (accessibility is owner-audience).
  if (accessLevel === ACCESS_LEVELS.OWNERS_ONLY) {
    if (isHOAOwnerRole(role)) {
      return (
        isUploader(document, viewer) ||
        sameUserId(document.linkedOwnerId, userId) ||
        listContainsId(document.allowedOwnerIds, userId)
      );
    }
    if (isHOABoardMemberRole(role)) {
      return (
        document.allowCommunityBoardAccess === true ||
        listContainsId(document.allowedBoardMemberIds, userId)
      );
    }
    return false;
  }

  if (isUploader(document, viewer)) {
    return true;
  }

  if (isSelectiveBoardOwner(accessLevel)) {
    if (isHOABoardMemberRole(role)) {
      return listContainsId(document.allowedBoardMemberIds, userId);
    }
    if (isHOAOwnerRole(role)) {
      return (
        sameUserId(document.linkedOwnerId, userId) ||
        listContainsId(document.allowedOwnerIds, userId)
      );
    }
    return false;
  }

  if (!canViewAccessLevel(role, accessLevel)) {
    return false;
  }

  return true;
}

function buildViewerIdMatchValues(viewer = {}) {
  const values = [];
  const oid = toQueryObjectId(viewer.userId);
  if (oid) values.push(oid);
  const raw = String(viewer.userId || '').trim();
  if (raw && (!oid || raw !== String(oid))) values.push(raw);
  return values;
}

/**
 * build Role Access Filter
 *
 * Performs logic operations for buildRoleAccessFilter.
 *
 * @param role - Request/input argument
 * @param viewer - Request/input argument
 * @returns Operations result
 */
function buildRoleAccessFilter(role, viewer = {}) {
  const viewerIds = buildViewerIdMatchValues(viewer);
  const viewerOid = viewerIds.find((v) => v instanceof mongoose.Types.ObjectId) || null;
  const uploaderFilters = [];
  if (viewerOid) {
    uploaderFilters.push(
      { accessLevel: ACCESS_LEVELS.SELECTIVE_BOARD_OWNER, uploadedById: { $in: viewerIds } },
      { accessLevel: 'SELECTIVE_BOARD_OWNER', uploadedById: { $in: viewerIds } },
    );
  }
  if (viewer.email) {
    uploaderFilters.push(
      { accessLevel: ACCESS_LEVELS.SELECTIVE_BOARD_OWNER, uploadedBy: viewer.email },
      { accessLevel: 'SELECTIVE_BOARD_OWNER', uploadedBy: viewer.email },
    );
  }

  if (isHOABoardMemberRole(role)) {
    const boardGrantFilters = viewerIds.length
      ? [
          { accessLevel: ACCESS_LEVELS.OWNERS_ONLY, allowedBoardMemberIds: { $in: viewerIds } },
          { accessLevel: ACCESS_LEVELS.SELECTIVE_BOARD_OWNER, allowedBoardMemberIds: { $in: viewerIds } },
          { accessLevel: 'SELECTIVE_BOARD_OWNER', allowedBoardMemberIds: { $in: viewerIds } },
        ]
      : [];
    return {
      $or: [
        { accessLevel: ACCESS_LEVELS.ALL_RESIDENTS },
        { accessLevel: ACCESS_LEVELS.BOARD_ONLY },
        ...uploaderFilters,
        { accessLevel: ACCESS_LEVELS.OWNERS_ONLY, allowCommunityBoardAccess: true },
        ...boardGrantFilters,
      ],
    };
  }

  if (isHOAOwnerRole(role)) {
    const ownerUploaderFilters = [];
    if (viewerIds.length) {
      ownerUploaderFilters.push(
        { accessLevel: ACCESS_LEVELS.OWNERS_ONLY, uploadedById: { $in: viewerIds } },
        { accessLevel: ACCESS_LEVELS.SELECTIVE_BOARD_OWNER, uploadedById: { $in: viewerIds } },
        { accessLevel: 'SELECTIVE_BOARD_OWNER', uploadedById: { $in: viewerIds } },
      );
    }
    if (viewer.email) {
      ownerUploaderFilters.push(
        { accessLevel: ACCESS_LEVELS.OWNERS_ONLY, uploadedBy: viewer.email },
        { accessLevel: ACCESS_LEVELS.SELECTIVE_BOARD_OWNER, uploadedBy: viewer.email },
        { accessLevel: 'SELECTIVE_BOARD_OWNER', uploadedBy: viewer.email },
      );
    }
    const ownerGrantFilters = viewerIds.length
      ? [
          { accessLevel: ACCESS_LEVELS.OWNERS_ONLY, linkedOwnerId: { $in: viewerIds } },
          { accessLevel: ACCESS_LEVELS.OWNERS_ONLY, allowedOwnerIds: { $in: viewerIds } },
          { accessLevel: ACCESS_LEVELS.SELECTIVE_BOARD_OWNER, linkedOwnerId: { $in: viewerIds } },
          { accessLevel: ACCESS_LEVELS.SELECTIVE_BOARD_OWNER, allowedOwnerIds: { $in: viewerIds } },
          { accessLevel: 'SELECTIVE_BOARD_OWNER', linkedOwnerId: { $in: viewerIds } },
          { accessLevel: 'SELECTIVE_BOARD_OWNER', allowedOwnerIds: { $in: viewerIds } },
        ]
      : [];
    return {
      $or: [
        { accessLevel: ACCESS_LEVELS.ALL_RESIDENTS },
        ...ownerUploaderFilters,
        ...ownerGrantFilters,
      ],
    };
  }

  return { accessLevel: ACCESS_LEVELS.ALL_RESIDENTS };
}

/**
 * can Manage Documents
 *
 * Performs logic operations for canManageDocuments.
 *
 * @param role - Request/input argument
 * @returns Operations result
 */
function canManageDocuments(role) {
  return isHOABoardMemberRole(role) || isAdminRole(role);
}

/**
 * can Upload Documents
 *
 * Performs logic operations for canUploadDocuments.
 *
 * @param role - Request/input argument
 * @returns Operations result
 */
function canUploadDocuments(role) {
  return isHOABoardMemberRole(role) || isHOAOwnerRole(role);
}

/**
 * assert Can Upload Documents
 *
 * Performs logic operations for assertCanUploadDocuments.
 *
 * @param role - Request/input argument
 * @returns Operations result
 */
function assertCanUploadDocuments(role) {
  if (!canUploadDocuments(role)) {
    const err = new Error('You do not have permission to upload documents');
    err.status = 403;
    throw err;
  }
}

/**
 * assert Valid Upload Access Level
 *
 * Performs logic operations for assertValidUploadAccessLevel.
 *
 * @param role - Request/input argument
 * @param accessLevel - Request/input argument
 * @returns Operations result
 */
function assertValidUploadAccessLevel(role, accessLevel) {
  const normalized = normalizeAccessLevel(accessLevel);
  if (!ALL_LEVELS.includes(normalized)) {
    const err = new Error('Invalid access level');
    err.status = 400;
    throw err;
  }
  // Board may upload Owners Only for owner recipients even though that audience
  // is not a default board library filter.
  const boardMayUploadOwnersOnly =
    isHOABoardMemberRole(role) && normalized === ACCESS_LEVELS.OWNERS_ONLY;
  if (
    (!canViewAccessLevel(role, normalized) && !boardMayUploadOwnersOnly) ||
    (isSelectiveBoardOwner(normalized) && isHOAOwnerRole(role))
  ) {
    const err = new Error('You do not have permission to set this access level');
    err.status = 403;
    throw err;
  }
}

/**
 * HOA owners may upload/update only for themselves - not for other owners.
 * Board member grants and community board access are allowed on Owners Only documents.
 */
function assertOwnerUploadGrantPolicy(role, { uploaderId, ownerGrantIds = [], boardGrantIds = [], allowCommunityBoardAccess = false } = {}) {
  if (!isHOAOwnerRole(role)) return;

  const uploaderKey = toIdString(uploaderId);
  const foreignOwnerIds = ownerGrantIds.filter((id) => toIdString(id) !== uploaderKey);

  if (foreignOwnerIds.length > 0) {
    const err = new Error('HOA owners cannot share documents with other owners');
    err.status = 403;
    throw err;
  }
}

function canUpdateDocument(role, document, viewer = {}) {
  if (isAdminRole(role)) return true;
  if (isHOABoardMemberRole(role) && isUploader(document, viewer)) return true;
  if (isHOAOwnerRole(role) && isUploader(document, viewer)) return true;
  return false;
}

function canDeleteDocument(role, document, viewer = {}) {
  return canUpdateDocument(role, document, viewer);
}

function assertCanUpdateDocument(role, document = null, viewer = {}) {
  if (!document) {
    const err = new Error('Document not found');
    err.status = 404;
    throw err;
  }
  if (!canUpdateDocument(role, document, viewer)) {
    const err = new Error('You can only update documents you uploaded');
    err.status = 403;
    throw err;
  }
}

function assertCanDeleteDocument(role, document = null, viewer = {}) {
  if (!document) {
    const err = new Error('Document not found');
    err.status = 404;
    throw err;
  }
  if (!canDeleteDocument(role, document, viewer)) {
    const err = new Error('You can only delete documents you uploaded');
    err.status = 403;
    throw err;
  }
}

/**
 * assert Can View Document
 *
 * Performs logic operations for assertCanViewDocument.
 *
 * @param role - Request/input argument
 * @param document - Request/input argument
 * @param viewer - Request/input argument
 * @returns Operations result
 */
function assertCanViewDocument(role, document, viewer = {}) {
  if (!document) {
    const err = new Error('Document not found');
    err.status = 404;
    throw err;
  }
  if (!canViewDocument(role, document, viewer)) {
    const err = new Error('You do not have permission to access this document');
    err.status = 403;
    throw err;
  }
}

/**
 * can Manage Document
 *
 * Performs logic operations for canManageDocument.
 *
 * @param role - Request/input argument
 * @param document - Request/input argument
 * @param viewer - Request/input argument
 * @returns Operations result
 */
function canManageDocument(role, document, viewer = {}) {
  if (!canManageDocuments(role)) return false;
  if (isAdminRole(role)) return true;
  return isUploader(document, viewer);
}

/**
 * assert Can Manage Documents
 *
 * Performs logic operations for assertCanManageDocuments.
 *
 * @param role - Request/input argument
 * @param document - Request/input argument
 * @param viewer - Request/input argument
 * @returns Operations result
 */
function assertCanManageDocuments(role, document = null, viewer = {}) {
  if (!canManageDocuments(role)) {
    const err = new Error('You do not have permission to manage documents');
    err.status = 403;
    throw err;
  }
  if (document && !canManageDocument(role, document, viewer)) {
    const err = new Error('You can only manage documents you uploaded');
    err.status = 403;
    throw err;
  }
}

const ACCESS_QUERY_MAP = {
  residents: ACCESS_LEVELS.ALL_RESIDENTS,
  owners: ACCESS_LEVELS.OWNERS_ONLY,
  board: ACCESS_LEVELS.BOARD_ONLY,
  selective: ACCESS_LEVELS.SELECTIVE_BOARD_OWNER,
};

/**
 * resolve Access Level Filter
 *
 * Performs logic operations for resolveAccessLevelFilter.
 *
 * @param role - Request/input argument
 * @param accessLevelKey - Request/input argument
 * @param viewer - Request/input argument
 * @returns Operations result
 */
function resolveAccessLevelFilter(role, accessLevelKey = 'all', viewer = {}) {
  if (accessLevelKey === 'all') {
    return buildRoleAccessFilter(role, viewer);
  }
  const mapped = ACCESS_QUERY_MAP[accessLevelKey];
  // Board may filter Owners Only to review docs explicitly shared with the board.
  const boardMayFilterOwnersOnly =
    isHOABoardMemberRole(role) && mapped === ACCESS_LEVELS.OWNERS_ONLY;
  if (!mapped || (!canViewAccessLevel(role, mapped) && !boardMayFilterOwnersOnly)) {
    return { accessLevel: '__none__' };
  }
  if (mapped === ACCESS_LEVELS.OWNERS_ONLY || mapped === ACCESS_LEVELS.SELECTIVE_BOARD_OWNER) {
    const visibleFilter = buildRoleAccessFilter(role, viewer);
    return {
      $and: [
        {
          $or: [
            { accessLevel: mapped },
            ...(mapped === ACCESS_LEVELS.SELECTIVE_BOARD_OWNER ? [{ accessLevel: 'SELECTIVE_BOARD_OWNER' }] : []),
          ],
        },
        visibleFilter,
      ],
    };
  }
  return { accessLevel: mapped };
}

module.exports = {
  ACCESS_LEVELS,
  ACCESS_QUERY_MAP,
  isSelectiveBoardOwner,
  normalizeAccessLevel,
  normalizeRoleName,
  isHOAOwnerRole,
  isAdminRole,
  isHOABoardMemberRole,
  getVisibleAccessLevels,
  canViewAccessLevel,
  canViewDocument,
  buildRoleAccessFilter,
  canManageDocuments,
  canManageDocument,
  canUpdateDocument,
  canDeleteDocument,
  canUploadDocuments,
  assertCanViewDocument,
  assertCanManageDocuments,
  assertCanUpdateDocument,
  assertCanDeleteDocument,
  assertCanUploadDocuments,
  assertValidUploadAccessLevel,
  assertOwnerUploadGrantPolicy,
  resolveAccessLevelFilter,
};
