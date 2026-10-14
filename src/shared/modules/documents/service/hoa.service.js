/**
 * ------------------------------------------------------------------
 * File: hoa.service.js
 * Module: Documents Module
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * owner.service, documents.controller, hoa.controller
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const HOADocument = require('../model/hoaDocument.model');
const storageClient = require('../../../../integrations/storage');
const logger = require('../../../../common/logger');
const { logActivity } = require('../../../../portals/hoa-board/modules/dashboard/service/activity.service');
const { formatDateInAppTimezone } = require('../../../../common/helpers/hoaBillingDates');
const { ClockService, DateUtil } = require('../../../../common/date');
const {
  ACCESS_LEVELS,
  isSelectiveBoardOwner,
  normalizeAccessLevel,
  assertCanViewDocument,
  assertCanManageDocuments,
  assertCanUpdateDocument,
  assertCanDeleteDocument,
  assertCanUploadDocuments,
  assertValidUploadAccessLevel,
  assertOwnerUploadGrantPolicy,
  buildRoleAccessFilter,
  resolveAccessLevelFilter,
  canViewAccessLevel,
  isHOAOwnerRole,
} = require('../helpers/hoaDocumentAccess');
const { notifyDocumentUploadedInBackground } = require('../helpers/hoaDocumentNotify');
const { notifyDocumentUploadedInAppInBackground } = require('../../../../common/helpers/hoaInAppNotify.helper');
const { assertHoaDocumentUploadSize } = require('../helpers/hoaDocumentUploadLimits');

/** Canonical HOA document folder definitions (id used as `category` on documents). */
const HOA_DOCUMENT_CATEGORIES = [
  { id: 'bylaws-ccrs', name: 'Bylaws & CC&Rs', accessLevel: ACCESS_LEVELS.ALL_RESIDENTS },
  { id: 'meeting-minutes', name: 'Meeting Minutes', accessLevel: ACCESS_LEVELS.ALL_RESIDENTS },
  { id: 'policies-rules', name: 'Policies & Rules', accessLevel: ACCESS_LEVELS.ALL_RESIDENTS },
  { id: 'legal-documents', name: 'Legal Documents', accessLevel: ACCESS_LEVELS.BOARD_ONLY },
  { id: 'financial-reports', name: 'Financial Reports', accessLevel: ACCESS_LEVELS.OWNERS_ONLY },
  { id: 'forms-applications', name: 'Forms & Applications', accessLevel: ACCESS_LEVELS.ALL_RESIDENTS },
  { id: 'miscellaneous', name: 'Miscellaneous', accessLevel: ACCESS_LEVELS.ALL_RESIDENTS },
];

function parseIdList(value) {
  if (value == null || value === '') return [];
  let raw = value;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        raw = JSON.parse(trimmed);
      } catch {
        raw = trimmed.split(',');
      }
    } else {
      raw = trimmed.split(',');
    }
  }
  if (!Array.isArray(raw)) raw = [raw];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const oid = toObjectIdOrNull(item);
    if (!oid) continue;
    const key = String(oid);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(oid);
  }
  return out;
}

function parseBooleanFlag(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function bumpDocumentVersion(current = 'v1.0') {
  const match = String(current || 'v1.0').match(/^v(\d+)\.(\d+)$/i);
  if (!match) return 'v1.1';
  return `v${match[1]}.${Number(match[2]) + 1}`;
}

async function applyDocumentFileReplacement(document, file, uploaderId) {
  assertHoaDocumentUploadSize(file);
  const originalName = file.originalName || file.filename || 'document';
  const contentType = file.mimetype || 'application/octet-stream';
  const fileExtension = originalName.split('.').pop().toUpperCase();
  const objectKey = storageClient.getKey
    ? storageClient.getKey('hoa', originalName, uploaderId)
    : `HOA Documents/${Date.now()}-${originalName}`;

  let storageKey = objectKey;
  let storageUrl = null;
  try {
    const uploadResult = await storageClient.upload({
      localFilePath: file.path,
      key: objectKey,
      contentType,
    });
    storageKey = uploadResult.Key || objectKey;
    storageUrl = uploadResult.Location || null;
  } catch (err) {
    logger.error('HOA document file replacement failed', { error: err.message });
    try {
      if (file.path) {
        const resolvedPath = path.resolve(String(file.path));
        const uploadsBase = path.resolve('uploads');
        if (resolvedPath.startsWith(uploadsBase + path.sep) && fs.existsSync(resolvedPath)) {
          await fs.promises.unlink(resolvedPath);
        }
      }
    } catch (e) { /* ignore */ }
    const uploadErr = new Error(err.message || 'Document file replacement failed');
    uploadErr.status = err.status || 502;
    throw uploadErr;
  }

  document.type = fileExtension;
  document.size = formatFileSize(file.size);
  document.fileName = file.filename || originalName;
  document.filePath = storageKey;
  document.storageKey = storageKey;
  document.storageUrl = storageUrl;
  document.version = bumpDocumentVersion(document.version);
}
function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

/**
 * normalize Viewer
 *
 * Performs logic operations for normalizeViewer.
 *
 * @param viewer - Request/input argument
 * @param hoaContext - Request/input argument
 * @returns Operations result
 */
function normalizeViewer(viewer = {}, hoaContext = null) {
  const userId = viewer.userId || hoaContext?.userId || null;
  return { ...viewer, userId: toIdString(userId) };
}

/**
 * to Object Id Or Null
 *
 * Performs logic operations for toObjectIdOrNull.
 *
 * @param id - Request/input argument
 * @returns Operations result
 */
function toObjectIdOrNull(id) {
  const raw = String(id || '').trim();
  if (!mongoose.Types.ObjectId.isValid(raw)) return null;
  return new mongoose.Types.ObjectId(raw);
}

/**
 * resolve Hoa Object Id
 *
 * Performs logic operations for resolveHoaObjectId.
 *
 * @param hoaContext - Request/input argument
 * @returns Operations result
 */
function resolveHoaObjectId(hoaContext) {
  if (!hoaContext?.hoaId) return null;
  const raw = String(hoaContext.hoaId).trim();
  if (!mongoose.Types.ObjectId.isValid(raw)) return null;
  return new mongoose.Types.ObjectId(raw);
}

function hoaIdScopeValues(hoaContext) {
  const oid = resolveHoaObjectId(hoaContext);
  if (!oid) return [];
  const raw = String(hoaContext.hoaId).trim();
  // Include both ObjectId and string so documents stored either way still count.
  return raw ? [oid, raw] : [oid];
}

const NOT_DELETED = { isDeleted: { $ne: true } };

/** When board member has active community, scope queries to that HOA only. */
function applyHoaDocumentScope(baseQuery, hoaContext) {
  const variants = hoaIdScopeValues(hoaContext);
  if (!variants.length) return baseQuery;
  if (variants.length === 1) return { ...baseQuery, hoaId: variants[0] };
  return { ...baseQuery, hoaId: { $in: variants } };
}

/**
 * assert Document Hoa Access
 *
 * Performs logic operations for assertDocumentHoaAccess.
 *
 * @param document - Request/input argument
 * @param hoaContext - Request/input argument
 * @returns Operations result
 */
function assertDocumentHoaAccess(document, hoaContext) {
  const hoaId = resolveHoaObjectId(hoaContext);
  if (!hoaId) return;
  if (!document?.hoaId || String(document.hoaId) !== String(hoaId)) {
    const err = new Error('Document not found');
    err.status = 404;
    throw err;
  }
}

const getDateFilterRange = (dateFilter = 'all') => {
  if (!dateFilter || dateFilter === 'all') return null;
  const now = ClockService.now();
  if (dateFilter === 'week') {
    return { $gte: DateUtil.subtractDays(now, 7) };
  }
  if (dateFilter === 'month') {
    return { $gte: DateUtil.subtractDays(now, 30) };
  }
  if (dateFilter === 'year') {
    return { $gte: DateUtil.subtractDays(now, 365) };
  }
  return null;
};

const getHOADocumentRecord = async (documentId, hoaContext = null) => {
  const safeDocId = toObjectIdOrNull(documentId);
  if (!safeDocId) {
    const err = new Error('Document not found');
    err.status = 404;
    throw err;
  }
  const document = await HOADocument.findOne({ _id: safeDocId, ...NOT_DELETED }).lean();
  if (!document) {
    const err = new Error('Document not found');
    err.status = 404;
    throw err;
  }
  assertDocumentHoaAccess(document, hoaContext);
  return document;
};

const getHOADocumentById = async (documentId, role, hoaContext = null, viewer = {}) => {
  const document = await getHOADocumentRecord(documentId, hoaContext);
  assertCanViewDocument(role, document, normalizeViewer(viewer, hoaContext));

  return {
    id: document._id.toString(),
    name: document.name,
    type: document.type,
    fileName: document.fileName,
    filePath: document.filePath,
    accessLevel: document.accessLevel,
    description: document.description || '',
  };
};

const getHOADocumentStream = async (documentId, role, hoaContext = null, viewer = {}) => {
  const document = await getHOADocumentRecord(documentId, hoaContext);
  assertCanViewDocument(role, document, normalizeViewer(viewer, hoaContext));

  const storageKey = document.storageKey || null;
  const filePath = document.filePath || null;

  const { ensureDownloadFileName, contentTypeForFileName } = require('../../../../common/helpers/fileDownloadHelper');
  const rawName = document.fileName || document.name || 'document';
  const typeMime = getContentType(document.type);
  const contentType =
    typeMime !== 'application/octet-stream'
      ? typeMime
      : contentTypeForFileName(rawName) || typeMime;
  const fileName = ensureDownloadFileName(rawName, contentType);

  // Prefer cloud/object storage when a storage key is present
  if (storageKey && storageClient && typeof storageClient.getStream === 'function') {
    try {
      const stream = await storageClient.getStream({ key: storageKey });
      return {
        stream,
        fileName,
        contentType,
      };
    } catch (e) {
      logger.warn('HOA document storage stream failed; trying local path', { error: e.message });
    }
  }

  // Legacy local disk path, or filePath used as storage key when file is not on disk
  if (filePath) {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    if (fs.existsSync(resolved)) {
      return {
        stream: fs.createReadStream(resolved),
        fileName,
        contentType,
      };
    }

    // filePath may itself be an object key (post-migration without storageKey field)
    if (storageClient && typeof storageClient.getStream === 'function' && !path.isAbsolute(filePath) && !filePath.includes(path.sep)) {
      try {
        const stream = await storageClient.getStream({ key: filePath.replace(/\\/g, '/') });
        return {
          stream,
          fileName,
          contentType,
        };
      } catch (e) {
        logger.warn('HOA document key stream failed', { error: e.message });
      }
    }
  }

  const err = new Error('File not found');
  err.status = 404;
  throw err;
};

const getContentType = (fileType) => {
  const types = {
    'PDF': 'application/pdf',
    'DOC': 'application/msword',
    'DOCX': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'XLS': 'application/vnd.ms-excel',
    'XLSX': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'PNG': 'image/png',
    'JPG': 'image/jpeg',
    'JPEG': 'image/jpeg'
  };
  return types[fileType?.toUpperCase()] || 'application/octet-stream';
};

const getHOADocumentsByCategory = async (
  categoryId,
  { pageNumber = 1, pageSize = 10, search = '', accessLevel = 'all', fileType = 'all', dateFilter = 'all', uploadedBy = '', role, hoaContext = null, viewer = {} } = {}
) => {
  const skip = (pageNumber - 1) * pageSize;
  const viewerContext = normalizeViewer(viewer, hoaContext);

  const accessFilter = resolveAccessLevelFilter(role, accessLevel, viewerContext);
  let query = applyHoaDocumentScope(
    { category: categoryId, ...NOT_DELETED, ...accessFilter },
    hoaContext
  );

  // Compose search with $and so role access $or is never overwritten.
  if (search) {
    const safeSearch = escapeRegex(search);
    query = {
      $and: [
        query,
        {
          $or: [
            { name: { $regex: safeSearch, $options: 'i' } },
            { uploadedBy: { $regex: safeSearch, $options: 'i' } },
          ],
        },
      ],
    };
  }

  if (uploadedBy && uploadedBy !== 'all') {
    query = { ...query, uploadedBy: { $regex: escapeRegex(uploadedBy), $options: 'i' } };
  }

  if (fileType !== 'all') {
    const safeFileType = escapeRegex(fileType);
    query = { ...query, type: new RegExp(`^${safeFileType}$`, 'i') };
  }

  const createdAtFilter = getDateFilterRange(dateFilter);
  if (createdAtFilter) {
    query = { ...query, createdAt: createdAtFilter };
  }
  
  const total = await HOADocument.countDocuments(query);
  const documents = await HOADocument.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(pageSize)
    .lean();
  
  const formattedDocs = documents.map(formatHOADocumentRow);
  
  return {
    data: formattedDocs,
    total,
    pageNumber,
    pageSize,
    totalPages: Math.ceil(total / pageSize)
  };
};

async function getHOADocuments(role, hoaContext = null, viewer = {}) {
  const viewerContext = normalizeViewer(viewer, hoaContext);
  const categories = HOA_DOCUMENT_CATEGORIES;
  const categoryIds = categories.map((cat) => cat.id);
  const roleAccessFilter = buildRoleAccessFilter(role, viewerContext);
  const latestScope = applyHoaDocumentScope({ ...NOT_DELETED, ...roleAccessFilter }, hoaContext);

  // countDocuments (not aggregate) so Mongoose casts ObjectId grant fields the same way
  // as the category listing query — otherwise folder counts stay at 0 after upload.
  const [countPairs, latestDoc] = await Promise.all([
    Promise.all(
      categoryIds.map(async (categoryId) => {
        const count = await HOADocument.countDocuments(
          applyHoaDocumentScope(
            { category: categoryId, ...NOT_DELETED, ...roleAccessFilter },
            hoaContext
          )
        );
        return [categoryId, count];
      })
    ),
    HOADocument.findOne(latestScope).sort({ createdAt: -1 }).select('createdAt').lean(),
  ]);

  const countMap = Object.fromEntries(countPairs);

  const documentCategories = categories
    .filter((cat) => {
      const count = countMap[cat.id] || 0;
      if (count > 0) return true;
      // Owners Only folders are owner-audience: board only sees them when they
      // already have accessible documents (explicit board share), not as empty defaults.
      if (normalizeAccessLevel(cat.accessLevel) === ACCESS_LEVELS.OWNERS_ONLY) {
        return false;
      }
      return canViewAccessLevel(role, cat.accessLevel);
    })
    .map((cat) => ({
      id: cat.id,
      name: cat.name,
      documentCount: countMap[cat.id] || 0,
      accessLevel: cat.accessLevel,
    }));

  const totalDocuments = documentCategories.reduce((sum, cat) => sum + cat.documentCount, 0);
  
  const lastUpdated = latestDoc
    ? formatDateInAppTimezone(latestDoc.createdAt, { year: undefined })
    : formatDateInAppTimezone(ClockService.now(), { year: undefined });

  return {
    totalDocuments,
    categories: documentCategories.length,
    lastUpdated,
    documentCategories
  };
}

const formatHOADocumentRow = (doc) => {
  const isModified =
    Boolean(doc.updatedAt && doc.createdAt) &&
    new Date(doc.updatedAt).getTime() - new Date(doc.createdAt).getTime() > 1000;

  return {
    id: doc._id.toString(),
    name: doc.name,
    type: doc.type,
    size: doc.size,
    uploadedBy: doc.uploadedBy,
    uploadedById: doc.uploadedById ? String(doc.uploadedById) : null,
    uploadedDate: formatDateInAppTimezone(doc.createdAt),
    updatedDate: isModified ? formatDateInAppTimezone(doc.updatedAt) : null,
    updatedAt: doc.updatedAt ? (typeof doc.updatedAt === 'string' ? doc.updatedAt : doc.updatedAt.toISOString()) : null,
    createdAt: doc.createdAt ? (typeof doc.createdAt === 'string' ? doc.createdAt : doc.createdAt.toISOString()) : null,
    accessLevel: doc.accessLevel,
    version: doc.version,
    fileName: doc.fileName,
    filePath: doc.filePath,
    description: doc.description || '',
    category: doc.category,
    uploadSource: doc.uploadSource || 'hoa_board',
    allowCommunityBoardAccess: doc.allowCommunityBoardAccess === true,
    linkedOwnerId: doc.linkedOwnerId ? String(doc.linkedOwnerId) : null,
    allowedOwnerIds: Array.isArray(doc.allowedOwnerIds)
      ? doc.allowedOwnerIds.map((id) => String(id))
      : [],
    allowedBoardMemberIds: Array.isArray(doc.allowedBoardMemberIds)
      ? doc.allowedBoardMemberIds.map((id) => String(id))
      : [],
  };
};

/**
 * Documents linked to an owner profile. Board callers see all access levels; resident owners omit Board Only.
 */
const getHOADocumentsForOwner = async (ownerId, { role, hoaContext = null, viewer = {} } = {}) => {
  const safeOwnerId = toObjectIdOrNull(ownerId);
  if (!safeOwnerId) {
    const err = new Error('Invalid owner id');
    err.status = 400;
    throw err;
  }
  const viewerContext = normalizeViewer(viewer, hoaContext);

  const query = applyHoaDocumentScope(
    {
      linkedOwnerId: safeOwnerId,
      ...NOT_DELETED,
      ...buildRoleAccessFilter(role, viewerContext),
    },
    hoaContext
  );

  const documents = await HOADocument.find(query).sort({ createdAt: -1 }).lean();

  return {
    data: documents.map(formatHOADocumentRow),
    total: documents.length,
  };
};

const ALLOWED_ACCESS = [
  ACCESS_LEVELS.ALL_RESIDENTS,
  ACCESS_LEVELS.OWNERS_ONLY,
  ACCESS_LEVELS.BOARD_ONLY,
  ACCESS_LEVELS.SELECTIVE_BOARD_OWNER,
  'SELECTIVE_BOARD_OWNER',
];

const uploadHOADocument = async (documentData, role, hoaContext = null) => {
  assertCanUploadDocuments(role);

  const {
    name,
    category,
    accessLevel,
    description,
    file,
    uploadedBy,
    uploadedById,
    linkedOwnerId,
    uploadSource,
    allowCommunityBoardAccess,
    allowedOwnerIds: rawOwnerIds,
    allowedBoardMemberIds: rawBoardIds,
    allResidents: rawAllResidents,
  } = documentData;

  const trimmedDescription = typeof description === 'string' ? description.trim() : '';
  if (!trimmedDescription) {
    const err = new Error('Document description is required.');
    err.status = 400;
    throw err;
  }

  const hoaId = resolveHoaObjectId(hoaContext);
  const uploaderOid = toObjectIdOrNull(uploadedById);

  const normalizedAccessLevel = normalizeAccessLevel(accessLevel);
  assertValidUploadAccessLevel(role, normalizedAccessLevel);

  const fileExtension = file.originalName.split('.').pop().toUpperCase();

  let linkedOid = null;
  if (isHOAOwnerRole(role)) {
    if (!uploaderOid) {
      const err = new Error('Uploader identity is required');
      err.status = 400;
      throw err;
    }
    linkedOid = uploaderOid;
  } else {
    linkedOid = toObjectIdOrNull(linkedOwnerId);
  }

  const src = isHOAOwnerRole(role)
    ? 'owner'
    : (uploadSource === 'owner' ? 'owner' : 'hoa_board');

  const explicitOwnerGrants = parseIdList(rawOwnerIds);
  const explicitBoardGrants = parseIdList(rawBoardIds);
  const hasRawAllResidents = rawAllResidents !== undefined && rawAllResidents !== null && rawAllResidents !== '';
  const isExplicitAllResidents = parseBooleanFlag(rawAllResidents);

  // Reject contradictory recipient configurations
  if (normalizedAccessLevel === ACCESS_LEVELS.ALL_RESIDENTS) {
    if (explicitOwnerGrants.length > 0) {
      const err = new Error('All Residents access level cannot contain selective owner recipients');
      err.status = 400;
      throw err;
    }
    if (explicitBoardGrants.length > 0) {
      const err = new Error('All Residents access level cannot contain selective board recipients');
      err.status = 400;
      throw err;
    }
  } else if (normalizedAccessLevel === ACCESS_LEVELS.OWNERS_ONLY) {
    if (hasRawAllResidents && isExplicitAllResidents) {
      const err = new Error('Owners Only access level cannot be combined with All Residents');
      err.status = 400;
      throw err;
    }
    if (explicitBoardGrants.length > 0) {
      const err = new Error('Owners Only access level cannot contain board member recipients');
      err.status = 400;
      throw err;
    }
  } else if (normalizedAccessLevel === ACCESS_LEVELS.BOARD_ONLY) {
    if (hasRawAllResidents && isExplicitAllResidents) {
      const err = new Error('Board Only access level cannot be combined with All Residents');
      err.status = 400;
      throw err;
    }
    if (explicitOwnerGrants.length > 0) {
      const err = new Error('Board Only access level cannot contain owner recipients');
      err.status = 400;
      throw err;
    }
  } else if (isSelectiveBoardOwner(normalizedAccessLevel)) {
    if (hasRawAllResidents && isExplicitAllResidents) {
      const err = new Error('Selective board + owner access level cannot be combined with All Residents');
      err.status = 400;
      throw err;
    }
    if (explicitOwnerGrants.length === 0 && explicitBoardGrants.length === 0) {
      const err = new Error('Select at least one owner or board member recipient');
      err.status = 400;
      throw err;
    }
  }

  assertOwnerUploadGrantPolicy(role, {
    uploaderId: uploaderOid,
    ownerGrantIds: explicitOwnerGrants,
    boardGrantIds: explicitBoardGrants,
    allowCommunityBoardAccess: parseBooleanFlag(allowCommunityBoardAccess),
  });

  if (linkedOid && normalizedAccessLevel === ACCESS_LEVELS.OWNERS_ONLY) {
    const linkedKey = String(linkedOid);
    if (!explicitOwnerGrants.some((id) => String(id) === linkedKey)) {
      explicitOwnerGrants.push(linkedOid);
    }
  }

  const allResidents = normalizedAccessLevel === ACCESS_LEVELS.ALL_RESIDENTS;

  if (normalizedAccessLevel === ACCESS_LEVELS.OWNERS_ONLY) {
    if (explicitOwnerGrants.length === 0 && !isHOAOwnerRole(role)) {
      const err = new Error('Select at least one owner recipient');
      err.status = 400;
      throw err;
    }
  } else if (normalizedAccessLevel === ACCESS_LEVELS.BOARD_ONLY) {
    if (explicitBoardGrants.length === 0) {
      const err = new Error('Select at least one board member recipient');
      err.status = 400;
      throw err;
    }
  } else if (isSelectiveBoardOwner(normalizedAccessLevel)) {
    if (explicitOwnerGrants.length === 0 && explicitBoardGrants.length === 0) {
      const err = new Error('Select at least one owner or board member recipient');
      err.status = 400;
      throw err;
    }
  }

  assertHoaDocumentUploadSize(file);

  let ownerGrants = [];
  let boardGrants = [];
  let communityBoardAccess = false;

  if (allResidents) {
    ownerGrants = [];
    boardGrants = [];
    communityBoardAccess = false;
  } else if (isSelectiveBoardOwner(normalizedAccessLevel)) {
    ownerGrants = explicitOwnerGrants;
    boardGrants = explicitBoardGrants;
    communityBoardAccess = false;
  } else if (normalizedAccessLevel === ACCESS_LEVELS.BOARD_ONLY) {
    ownerGrants = [];
    boardGrants = explicitBoardGrants;
    communityBoardAccess = false;
  } else {
    ownerGrants = explicitOwnerGrants;
    boardGrants = [];
    communityBoardAccess = false;
  }
  // Upload to configured storage provider (S3 / Azure / mock)
  const originalName = file.originalName || file.filename || 'document';
  const contentType = file.mimetype || 'application/octet-stream';
  const objectKey = storageClient.getKey
    ? storageClient.getKey('hoa', originalName, uploadedById)
    : `HOA Documents/${Date.now()}-${originalName}`;

  let storageKey = objectKey;
  let storageUrl = null;
  try {
    const uploadResult = await storageClient.upload({
      localFilePath: file.path,
      key: objectKey,
      contentType,
    });
    storageKey = uploadResult.Key || objectKey;
    storageUrl = uploadResult.Location || null;
  } catch (err) {
    logger.error('HOA document upload to storage failed', { error: err.message });
    try {
      if (file.path) {
        const resolvedPath = path.resolve(String(file.path));
        const uploadsBase = path.resolve('uploads');
        if (resolvedPath.startsWith(uploadsBase + path.sep) && fs.existsSync(resolvedPath)) {
          await fs.promises.unlink(resolvedPath);
        }
      }
    } catch (e) { /* ignore */ }
    const uploadErr = new Error(err.message || 'Document upload failed');
    uploadErr.status = err.status || 502;
    throw uploadErr;
  }

  const newDocument = await HOADocument.create({
    name,
    category,
    type: fileExtension,
    size: formatFileSize(file.size),
    uploadedBy: uploadedBy || 'Current User',
    ...(uploaderOid ? { uploadedById: uploaderOid } : {}),
    accessLevel: normalizedAccessLevel,
    version: 'v1.0',
    // Prefer the client original name (with extension) so downloads open correctly
    fileName: originalName || file.filename,
    filePath: storageKey,
    storageKey,
    storageUrl,
    description: trimmedDescription,
    linkedOwnerId: linkedOid,
    allowedOwnerIds: ownerGrants,
    allowedBoardMemberIds: boardGrants,
    allowCommunityBoardAccess:
      normalizedAccessLevel === ACCESS_LEVELS.OWNERS_ONLY && communityBoardAccess === true,
    uploadSource: src,
    ...(hoaId ? { hoaId } : {}),
  });

  // Log activity
  await logActivity({
    userId: uploadedById,
    action: 'UPLOAD',
    module: 'Document',
    entityId: newDocument._id,
    entityName: name,
    description: `Uploaded document "${name}" to ${category}`,
    meta: { category, accessLevel: normalizedAccessLevel, type: fileExtension, size: formatFileSize(file.size) }
  });

  const documentPlain = newDocument.toObject ? newDocument.toObject() : newDocument;

  // Email recipients (owners / board / all residents by grant lists)
  notifyDocumentUploadedInBackground({
    document: documentPlain,
    hoaId,
    allResidents: allResidents || normalizedAccessLevel === ACCESS_LEVELS.ALL_RESIDENTS,
    ownerIds: ownerGrants.map((id) => String(id)),
    boardMemberIds: boardGrants.map((id) => String(id)),
    categories: HOA_DOCUMENT_CATEGORIES,
  });

  // In-app notifications for dependent users (excludes uploader)
  notifyDocumentUploadedInAppInBackground(documentPlain, uploadedById);

  return {
    document: {
      id: newDocument._id.toString(),
      name: newDocument.name,
      type: newDocument.type,
      size: newDocument.size,
      uploadedBy: newDocument.uploadedBy,
      uploadedDate: formatDateInAppTimezone(newDocument.createdAt),
      accessLevel: newDocument.accessLevel,
      version: newDocument.version,
      fileName: newDocument.fileName,
      filePath: newDocument.filePath,
      description: newDocument.description || '',
      allowedOwnerIds: ownerGrants.map((id) => String(id)),
      allowedBoardMemberIds: boardGrants.map((id) => String(id)),
    },
    message: 'Document uploaded successfully'
  };
};

const updateHOADocument = async (documentId, payload, viewer = null, role, hoaContext = null) => {
  const document = await HOADocument.findOne({ _id: documentId, ...NOT_DELETED });

  if (!document) {
    const err = new Error('Document not found');
    err.status = 404;
    throw err;
  }

  assertDocumentHoaAccess(document.toObject ? document.toObject() : document, hoaContext);
  const viewerContext =
    viewer && typeof viewer === 'object' ? viewer : { userId: viewer };
  const normalizedViewer = normalizeViewer(viewerContext, hoaContext);
  const documentPlain = document.toObject ? document.toObject() : document;
  assertCanUpdateDocument(role, documentPlain, normalizedViewer);

  const { name, accessLevel, description, allowedOwnerIds, allowedBoardMemberIds, allowCommunityBoardAccess, file } = payload;

  if (accessLevel !== undefined) {
    assertValidUploadAccessLevel(role, accessLevel);
  }

  const effectiveAccessLevel = accessLevel !== undefined ? accessLevel : document.accessLevel;
  const nextOwnerGrants =
    allowedOwnerIds !== undefined ? parseIdList(allowedOwnerIds) : (document.allowedOwnerIds || []);
  const nextBoardGrants =
    allowedBoardMemberIds !== undefined
      ? parseIdList(allowedBoardMemberIds)
      : (document.allowedBoardMemberIds || []);
  const nextCommunityBoardAccess =
    allowCommunityBoardAccess !== undefined
      ? parseBooleanFlag(allowCommunityBoardAccess)
      : document.allowCommunityBoardAccess === true;

  const normalizedEffective = normalizeAccessLevel(effectiveAccessLevel);
  if (normalizedEffective === ACCESS_LEVELS.OWNERS_ONLY && nextBoardGrants.length > 0) {
    const err = new Error('Owners Only access level cannot contain board member recipients');
    err.status = 400;
    throw err;
  }

  assertOwnerUploadGrantPolicy(role, {
    uploaderId: normalizedViewer.userId || document.uploadedById,
    ownerGrantIds: nextOwnerGrants,
    boardGrantIds: nextBoardGrants,
    allowCommunityBoardAccess: nextCommunityBoardAccess,
  });

  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed) {
      const err = new Error('Document name cannot be empty');
      err.status = 400;
      throw err;
    }
    document.name = trimmed;
  }
  if (accessLevel !== undefined) {
    const normalized = normalizeAccessLevel(accessLevel);
    if (!ALLOWED_ACCESS.includes(normalized) && !ALLOWED_ACCESS.includes(accessLevel)) {
      const err = new Error('Invalid access level');
      err.status = 400;
      throw err;
    }
    document.accessLevel = normalized;
  }
  if (description !== undefined) {
    document.description = String(description);
  }
  if (allowedOwnerIds !== undefined) {
    document.allowedOwnerIds = parseIdList(allowedOwnerIds);
  }
  if (allowedBoardMemberIds !== undefined) {
    document.allowedBoardMemberIds =
      normalizedEffective === ACCESS_LEVELS.OWNERS_ONLY
        ? []
        : parseIdList(allowedBoardMemberIds);
  }
  if (allowCommunityBoardAccess !== undefined) {
    document.allowCommunityBoardAccess =
      document.accessLevel === ACCESS_LEVELS.OWNERS_ONLY &&
      parseBooleanFlag(allowCommunityBoardAccess);
  }

  if (
    normalizedEffective === ACCESS_LEVELS.OWNERS_ONLY &&
    !(nextOwnerGrants || []).length &&
    nextCommunityBoardAccess !== true &&
    !document.linkedOwnerId
  ) {
    const err = new Error('Select at least one owner recipient for Owners Only documents');
    err.status = 400;
    throw err;
  }

  if (
    isSelectiveBoardOwner(effectiveAccessLevel) &&
    !(nextOwnerGrants || []).length &&
    !(nextBoardGrants || []).length
  ) {
    const err = new Error('Select at least one owner or board member recipient');
    err.status = 400;
    throw err;
  }

  if (file) {
    await applyDocumentFileReplacement(
      document,
      file,
      normalizedViewer.userId || document.uploadedById
    );
  }

  await document.save();

  await logActivity({
    userId: viewerContext.userId || document.uploadedById,
    action: 'UPDATE',
    module: 'Document',
    entityId: document._id,
    entityName: document.name,
    description: file
      ? `Replaced file for document "${document.name}"`
      : `Updated document "${document.name}"`,
    meta: {
      category: document.category,
      accessLevel: document.accessLevel,
      fileReplaced: Boolean(file),
      version: document.version,
    }
  });

  return {
    document: formatHOADocumentRow(document.toObject ? document.toObject() : document),
  };
};

const deleteHOADocument = async (documentId, viewer = null, role, hoaContext = null) => {
  const document = await HOADocument.findById(documentId);
  
  if (!document) {
    const err = new Error('Document not found');
    err.status = 404;
    throw err;
  }

  assertDocumentHoaAccess(document.toObject ? document.toObject() : document, hoaContext);
  const viewerContext =
    viewer && typeof viewer === 'object' ? viewer : { userId: viewer };
  assertCanDeleteDocument(role, document, normalizeViewer(viewerContext, hoaContext));
  
  document.isDeleted = true;
  document.deletedAt = ClockService.now();
  await document.save();
  
  // Log activity
  await logActivity({
    userId: viewerContext.userId || document.uploadedById,
    action: 'DELETE',
    module: 'Document',
    entityId: document._id,
    entityName: document.name,
    description: `Deleted document "${document.name}"`,
    meta: { category: document.category, type: document.type }
  });
  
  return {
    message: 'Document deleted successfully',
    documentId
  };
};

module.exports = {
  getHOADocuments,
  getHOADocumentsByCategory,
  getHOADocumentsForOwner,
  uploadHOADocument,
  updateHOADocument,
  deleteHOADocument,
  getHOADocumentById,
  getHOADocumentStream,
  HOA_DOCUMENT_CATEGORIES,
  parseIdList,
  bumpDocumentVersion,
  formatFileSize,
};
