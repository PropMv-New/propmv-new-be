/**
 * ------------------------------------------------------------------
 * File: listing.service.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * listing.controller, syndication.controller
 * ------------------------------------------------------------------
 */
const fs = require('fs').promises;
const mongoose = require('mongoose');

const Listing = require('../models/listing.model');
const Property = require('../../property/model/property.model');
const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
const s3Client = require('../../../../../integrations/s3');
const config = require('../../../../../config/default');
const { resolveUnitForPropertyId } = require('../../../../../common/helpers/propertyUnitReference');
const { getPagination } = require('../../../../../common/helpers/paginationHelper');
const { LISTING_STATUS } = require('../../../../../common/constants/listing');
const { UPLOAD_LISTING_SUBDIR } = require('../../../../../common/constants/uploads');
const {
  buildPropertyOwnerFilter,
  resolveCreatedBy,
} = require('../../../../../shared/utils/creatorScope.util');
const { ClockService, DateUtil } = require('../../../../../common/date');
const { runInTransaction } = require('../../../../../common/helpers/transactionHelper');
const syndicationService = require('./syndication.service');
const {
  enrichListingUnitFieldsFromProperty,
} = require('../helpers/listingUnitFields.helper');
const { SYNDICATION_PROVIDERS } = require('../../../../../integrations/syndication/syndication.constants');
const { SYNDICATION_SYNC_STATUS } = require('../../../../../integrations/syndication/syndication.constants');
const logger = require('../../../../../common/logger');
const { logLandlordFlow } = require('../../../utils/landlordFlowLog');

/**
 * Listing service - Step 5 of the landlord API pipeline (reference implementation).
 *
 * SERVICE LAYER STEPS (emitted via logListingService)
 *   SERVICE_START       - mutation or read begins (includes requestId + action)
 *   SERVICE_VALIDATE    - input rules, file limits, required fields
 *   SERVICE_DB_QUERY    - MongoDB reads (property lookup, list query, hydrate by id)
 *   SERVICE_DB_WRITE    - MongoDB writes (create, update, soft-delete)
 *   SERVICE_SYNDICATION - async Zillow publish/sync/unpublish (non-blocking)
 *   SERVICE_END         - successful completion
 *   HANDLER_ERROR       - failure inside runListingMutation (rolled back + logged)
 *
 * OPTIONS CONTRACT (passed from controller via serviceOptions)
 *   requestId  - correlates with REQUEST_START / HANDLER_* logs
 *   action     - handler name, e.g. 'createListing'
 *   files, uploadedBy, actorId, comment - business fields
 *
 * @see controller/listing.controller.js
 * @see portals/landlord/utils/landlordFlowLog.js
 */

/** Emits a listing-module service step into the shared landlord pipeline logger. */
function logListingService(step, meta = {}, message) {
  logLandlordFlow(step, { module: 'listing', layer: 'service', ...meta }, message);
}

// Transaction helper functions (inlined from listingDb.util.js)
function applySession(query, session) {
  if (session && query && typeof query.session === 'function') {
    return query.session(session);
  }
  return query;
}

/**
 * with Session
 *
 * Performs logic operations for withSession.
 *
 * @param options - Request/input argument
 * @param session - Request/input argument
 * @returns Operations result
 */
function withSession(options = {}, session) {
  if (!session) return options;
  return { ...options, session };
}

async function withListingTransaction(fn, options = {}) {
  if (options.session) {
    return fn(options.session);
  }
  return runInTransaction(fn);
}

const MAX_LISTING_IMAGES = 10;
const ACTIVE_LISTING_STATUSES = [
  LISTING_STATUS.ACTIVE,
  LISTING_STATUS.PUBLISHED,
  LISTING_STATUS.PUBLISH_IN_PROGRESS,
];
const INACTIVE_LISTING_STATUSES = [
  LISTING_STATUS.DRAFT,
  LISTING_STATUS.DRAFT_IN_PROGRESS,
  LISTING_STATUS.INACTIVE,
];

/**
 * resolve Syndication Outcome
 *
 * Performs logic operations for resolveSyndicationOutcome.
 *
 * @returns Operations result
 */
function resolveSyndicationOutcome() {
  // Bulk feed is the single source of truth - user actions only queue in-progress statuses.
  return null;
}

/**
 * apply Post Commit Syndication
 *
 * Performs logic operations for applyPostCommitSyndication.
 *
 * @returns Operations result
 */
function applyPostCommitSyndication() {
  // Syndication is handled by the daily bulk feed cron + process step.
}

/**
 * unwrap Listing Mutation Result
 *
 * Performs logic operations for unwrapListingMutationResult.
 *
 * @param result - Request/input argument
 * @returns Operations result
 */
function unwrapListingMutationResult(result) {
  if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'listing')) {
    return result;
  }
  return { listing: result, syndicationOutcome: null };
}

/**
 * platforms To Providers
 *
 * Performs logic operations for platformsToProviders.
 *
 * @param platformIds - Request/input argument
 * @returns Operations result
 */
function platformsToProviders(platformIds = []) {
  return platformIds
    .map((p) => String(p).toLowerCase())
    .filter((p) => p === 'zillow')
    .map(() => SYNDICATION_PROVIDERS.ZILLOW);
}

/**
 * listing Has Zillow Platform
 *
 * Performs logic operations for listingHasZillowPlatform.
 *
 * @param listing - Request/input argument
 * @returns Operations result
 */
function listingHasZillowPlatform(listing) {
  const platforms = listing?.syndicationPlatforms || [];
  return platforms.some((p) => String(p).toLowerCase() === 'zillow');
}

async function markZillowQueuedForBulkFeed(listingId, { publishing = true } = {}) {
  const now = ClockService.now();
  const patch = {
    'syndication.zillow.enabled': true,
    'syndication.zillow.lastSyncedAt': now,
    'syndication.zillow.lastSyncStatus': SYNDICATION_SYNC_STATUS.PENDING,
    'syndication.zillow.lastSyncError': null,
  };

  if (publishing) {
    patch['syndication.zillow.published'] = false;
  }

  await Listing.updateOne({ _id: listingId }, { $set: patch });
}

const RESTRICTED_UPDATE_FIELDS = new Set([
  'propertyId',
  'propertyName',
  'propertyType',
  'address',
  'unitId',
  'unitName',
  'bedrooms',
  'bathrooms',
  'area',
  'images',
  'isDeleted',
  'documentsToDelete',
]);
const LISTING_IMAGE_METADATA_SELECT = '_id s3Location key bucketName region originalName createdAt';
const LISTING_LIST_SELECT = [
  '_id',
  'propertyId',
  'propertyName',
  'address',
  'city',
  'state',
  'zip',
  'unitId',
  'unitName',
  'bedrooms',
  'bathrooms',
  'area',
  'rentalAmount',
  'availableDate',
  'status',
  'images',
  'createdAt',
  'updatedAt',
].join(' ');
const LISTING_DETAIL_SELECT = [
  '_id',
  'propertyId',
  'propertyName',
  'propertyType',
  'address',
  'city',
  'state',
  'zip',
  'unitId',
  'unitName',
  'bedrooms',
  'bathrooms',
  'area',
  'listingHeadline',
  'description',
  'rentalAmount',
  'securityDeposit',
  'paymentFrequency',
  'availableDate',
  'leaseType',
  'petPolicies',
  'utilitiesIncluded',
  'amenities',
  'images',
  'virtualTourVideoUrl',
  'syndicationPlatforms',
  'syndication',
  'isAcceptingApplications',
  'status',
  'comments',
  'createdAt',
  'updatedAt',
].join(' ');
const LISTING_PROPERTY_SELECT = [
  'name',
  'address.street',
  'address.city',
  'address.state',
  'address.zip',
  'address.country',
  'unitDetails._id',
  'unitDetails.unitName',
  'unitDetails.bedRooms',
  'unitDetails.bathRoom',
  'unitDetails.squareFeet',
].join(' ');

/**
 * create Http Error
 *
 * Performs logic operations for createHttpError.
 *
 * @param message - Request/input argument
 * @param status - Request/input argument
 * @returns Operations result
 */
function createHttpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * assert Listing Id
 *
 * Performs logic operations for assertListingId.
 *
 * @param id - Request/input argument
 * @returns Operations result
 */
function assertListingId(id) {
  if (!id) {
    throw createHttpError('listingId is required', 400);
  }
  if (!mongoose.Types.ObjectId.isValid(String(id))) {
    throw createHttpError('listingId must be a valid ObjectId', 400);
  }
}

/**
 * to Plain
 *
 * Performs logic operations for toPlain.
 *
 * @param doc - Request/input argument
 * @returns Operations result
 */
function toPlain(doc) {
  if (!doc) return doc;
  return typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
}

/**
 * sanitize Listing Files
 *
 * Performs logic operations for sanitizeListingFiles.
 *
 * @param files - Request/input argument
 * @returns Operations result
 */
function sanitizeListingFiles(files = []) {
  return (Array.isArray(files) ? files : []).filter(
    (file) => file && (file.size || 0) > 0 && file.path
  );
}

/**
 * normalize Listing Query
 *
 * Performs logic operations for normalizeListingQuery.
 *
 * @param query - Request/input argument
 * @returns Operations result
 */
function normalizeListingQuery(query = {}) {
  const normalized = { ...query };

  if (normalized.pagesize != null && normalized.pageSize == null) {
    normalized.pageSize = normalized.pagesize;
  }
  if (normalized.page != null && normalized.pageNumber == null) {
    normalized.pageNumber = normalized.page;
  }
  if (normalized.pageNumber != null) {
    normalized.pageNumber = Number(normalized.pageNumber);
  }
  if (normalized.pageSize != null) {
    normalized.pageSize = Number(normalized.pageSize);
  }
  if (typeof normalized.propertyId === 'string' && normalized.propertyId.includes(',')) {
    normalized.propertyId = normalized.propertyId
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  }

  return normalized;
}

/**
 * build Listing Resolution
 *
 * Performs logic operations for buildListingResolution.
 *
 * @param file - Request/input argument
 * @returns Operations result
 */
function buildListingResolution(file) {
  return `${file.width || 0}x${file.height || 0}`;
}

/**
 * ensure Cover Image
 *
 * Performs logic operations for ensureCoverImage.
 *
 * @param images - Request/input argument
 * @returns Operations result
 */
function ensureCoverImage(images = []) {
  if (!Array.isArray(images) || images.length === 0) {
    return [];
  }

  let coverFound = false;
  images.forEach((image) => {
    if (!image) return;
    if (image.isCover && !coverFound) {
      coverFound = true;
      return;
    }
    image.isCover = false;
  });

  if (!coverFound) {
    images[0].isCover = true;
  }

  return images;
}

/**
 * get Listing Preview Images
 *
 * Performs logic operations for getListingPreviewImages.
 *
 * @param images - Request/input argument
 * @returns Operations result
 */
function getListingPreviewImages(images = []) {
  if (!Array.isArray(images) || images.length === 0) {
    return [];
  }

  const coverImage = images.find((image) => image && image.isCover && image.documentMetaDataId);
  return coverImage ? [coverImage] : [images[0]];
}

/**
 * Attach short-lived display URLs onto listing images so private S3 objects render in the UI.
 */
async function attachListingImageUrls(images = []) {
  if (!Array.isArray(images) || images.length === 0) {
    return [];
  }

  const documentsService = require('../../../../../shared/modules/documents/service/documents.service');
  const resolved = [];

  for (const image of images) {
    if (!image) continue;
    const meta = image.documentMetaDataId;
    const metaObj = meta && typeof meta === 'object' ? { ...meta } : null;
    const metaId = metaObj?._id || (typeof meta === 'string' || meta?._bsontype ? meta : null);

    let url = null;
    if (metaId) {
      try {
        url = await documentsService.getPresignedUrl(String(metaId), 3600);
      } catch (e) {
        url = metaObj ? documentsService.buildPublicUrl(metaObj) : null;
      }
    }

    if (metaObj) {
      metaObj.url = url || metaObj.s3Location || metaObj.url || null;
      if (url) metaObj.s3Location = url;
    }

    resolved.push({
      ...image,
      documentMetaDataId: metaObj || meta,
      url: url || undefined,
    });
  }

  return resolved;
}

/**
 * optimize Listing List Response
 *
 * Performs logic operations for optimizeListingListResponse.
 *
 * @param listing - Request/input argument
 * @returns Operations result
 */
function optimizeListingListResponse(listing) {
  const enrichedListing = enrichListingUnitFieldsFromProperty(listing);
  if (!enrichedListing) {
    return enrichedListing;
  }

  return {
    ...enrichedListing,
    images: getListingPreviewImages(enrichedListing.images),
  };
}

async function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      logger.warn('Failed to cleanup temp file', { module: 'listing', error: error.message });
    }
  }
}

async function cleanupTempFiles(files = []) {
  await Promise.all(files.map((file) => safeUnlink(file && file.path)));
}

async function cleanupUploadedArtifacts(artifacts = []) {
  for (const artifact of artifacts) {
    if (!artifact) continue;

    if (artifact.key) {
      try {
        await s3Client.delete({ key: artifact.key });
      } catch (error) {
        logger.error('Failed to cleanup uploaded S3 object', { module: 'listing', error: error.message });
      }
    }

    if (artifact.metadataId) {
      try {
        await DocumentMetadata.deleteOne({ _id: artifact.metadataId });
      } catch (error) {
        logger.error('Failed to cleanup uploaded metadata', { module: 'listing', error: error.message });
      }
    }
  }
}

async function cleanupDeletedArtifacts(artifacts = []) {
  for (const artifact of artifacts) {
    if (!artifact || !artifact.key) continue;
    try {
      await s3Client.delete({ key: artifact.key });
    } catch (error) {
      logger.error('Failed to cleanup deleted listing image from S3', { module: 'listing', error: error.message });
    }
  }
}

async function restoreListingStatuses(listings = []) {
  if (!Array.isArray(listings) || listings.length === 0) {
    return;
  }

  const operations = listings
    .filter((listing) => listing && listing._id && listing.status)
    .map((listing) => ({
      updateOne: {
        filter: { _id: listing._id },
        update: { $set: { status: listing.status } },
      },
    }));

  if (!operations.length) {
    return;
  }

  try {
    await Listing.bulkWrite(operations);
  } catch (error) {
    logger.error('Failed to restore listing statuses after rollback', { module: 'listing', error: error.message });
  }
}

async function restoreListingSnapshot(snapshot) {
  if (!snapshot || !snapshot._id) {
    return;
  }

  try {
    const current = await Listing.findById(snapshot._id);
    if (!current) return;
    current.overwrite(snapshot);
    await current.save();
  } catch (error) {
    logger.error('Failed to restore listing snapshot after rollback', { module: 'listing', error: error.message });
  }
}

async function cleanupCreatedListing(createdListingId) {
  if (!createdListingId) {
    return;
  }

  try {
    await Listing.deleteOne({ _id: createdListingId });
  } catch (error) {
    logger.error('Failed to remove partially created listing', { module: 'listing', error: error.message });
  }
}

/**
 * create Mutation Compensation
 *
 * Performs logic operations for createMutationCompensation.
 *
 * @returns Operations result
 */
function createMutationCompensation() {
  return {
    createdListingId: null,
    originalListing: null,
    deactivatedListings: [],
    uploadedArtifacts: [],
    deletedArtifacts: [],
  };
}

/**
 * capture Original Listing
 *
 * Performs logic operations for captureOriginalListing.
 *
 * @param compensation - Request/input argument
 * @param listing - Request/input argument
 * @returns Operations result
 */
function captureOriginalListing(compensation, listing) {
  if (!compensation.originalListing && listing) {
    compensation.originalListing = toPlain(listing);
  }
}

async function runListingMutation(work, options = {}) {
  const normalizedOptions = { ...options };
  normalizedOptions.files = sanitizeListingFiles(options.files);
  const action = normalizedOptions.action || 'listingMutation';

  // Step 5a - service entry
  logListingService('SERVICE_START', {
    requestId: normalizedOptions.requestId,
    action,
  }, `Listing service started: ${action}`);

  let sessionMode;
  const compensation = createMutationCompensation();

  try {
    if (normalizedOptions.files.length > MAX_LISTING_IMAGES) {
      throw createHttpError(`Maximum ${MAX_LISTING_IMAGES} images are allowed`, 400);
    }

    logListingService('SERVICE_VALIDATE', {
      requestId: normalizedOptions.requestId,
      action,
      fileCount: normalizedOptions.files.length,
    }, 'Listing mutation input validated');

    const result = await withListingTransaction(
      async (session) => {
        sessionMode = session;
        return work(session, compensation, normalizedOptions);
      },
      normalizedOptions
    );

    if (!normalizedOptions.session && compensation.deletedArtifacts.length > 0) {
      await cleanupDeletedArtifacts(compensation.deletedArtifacts);
    }

    logListingService('SERVICE_END', {
      requestId: normalizedOptions.requestId,
      action,
      success: true,
      listingId: result?._id || result?.listing?._id,
    }, `Listing service completed: ${action}`);

    return result;
  } catch (error) {
    logListingService('HANDLER_ERROR', {
      requestId: normalizedOptions.requestId,
      action,
      error: error?.message,
      status: error?.status || 500,
    }, `Listing service failed: ${action} - ${error?.message || 'unknown error'}`);

    await cleanupUploadedArtifacts(compensation.uploadedArtifacts);

    if (sessionMode === null) {
      if (compensation.createdListingId) {
        await cleanupCreatedListing(compensation.createdListingId);
      }
      if (compensation.originalListing) {
        await restoreListingSnapshot(compensation.originalListing);
      }
      if (compensation.deactivatedListings.length > 0) {
        await restoreListingStatuses(compensation.deactivatedListings);
      }
    }

    throw error;
  } finally {
    await cleanupTempFiles(normalizedOptions.files);
  }
}

async function findPropertyIdsByCreatedByInSession(createdBy, session) {
  if (!createdBy) {
    return [];
  }

  const properties = await applySession(
    Property.find({
      ...buildPropertyOwnerFilter(createdBy),
      isDeleted: { $ne: true },
    }).select('_id'),
    session
  ).lean();

  return properties.map((property) => property._id);
}

async function hydrateListingById(id, session) {
  const listing = await applySession(
    Listing.findOne({ _id: id, isDeleted: { $ne: true } })
      .select(LISTING_DETAIL_SELECT)
      .populate({
        path: 'propertyId',
        select: LISTING_PROPERTY_SELECT,
        match: { isDeleted: { $ne: true } },
      })
      .populate({
        path: 'images.documentMetaDataId',
        select: LISTING_IMAGE_METADATA_SELECT,
      }),
    session
  ).lean();

  if (!listing) {
    return null;
  }

  const enriched = enrichListingUnitFieldsFromProperty(listing);
  if (enriched && Array.isArray(enriched.images)) {
    enriched.images = await attachListingImageUrls(enriched.images);
  }
  return enriched;
}

async function loadListingForWrite(id, session) {
  assertListingId(id);
  return applySession(
    Listing.findOne({ _id: id, isDeleted: { $ne: true } }),
    session
  );
}

async function inactivateSiblingListings(listingLike, session, compensation) {
  if (!listingLike || !listingLike.propertyId) {
    return;
  }

  const filter = {
    propertyId: listingLike.propertyId,
    status: { $in: ACTIVE_LISTING_STATUSES },
    isDeleted: { $ne: true },
  };

  if (listingLike.excludeId) {
    filter._id = { $ne: listingLike.excludeId };
  }

  if (listingLike.unitId) {
    filter.unitId = listingLike.unitId;
  } else if (listingLike.unitName) {
    filter.unitName = listingLike.unitName;
  } else {
    return;
  }

  const siblings = await applySession(
    Listing.find(filter).select('_id status'),
    session
  ).lean();

  if (!siblings.length) {
    return;
  }

  compensation.deactivatedListings.push(...siblings.map((listing) => ({
    _id: listing._id,
    status: listing.status,
  })));

  await applySession(
    Listing.updateMany(
      { _id: { $in: siblings.map((listing) => listing._id) } },
      { $set: { status: LISTING_STATUS.INACTIVE } }
    ),
    session
  );
}

async function stageListingImages(files, { session, uploadedBy } = {}) {
  const bucketName = (config.s3 && config.s3.bucket) || process.env.S3_BUCKET || 'mock-bucket';
  const region = (config.s3 && config.s3.region) || process.env.AWS_REGION || 'mock-region';
  const uploadedArtifacts = [];
  const imageEntries = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const filename = file.originalname || file.filename || `listing-${Date.now()}`;
    const generatedKey = s3Client.getKey
      ? s3Client.getKey('listing', filename, uploadedBy || null)
      : `${UPLOAD_LISTING_SUBDIR}/${filename}`.replace(/\\/g, '/');

    const uploadResult = await s3Client.upload({
      localFilePath: file.path,
      key: generatedKey,
      contentType: file.mimetype || 'application/octet-stream',
    });

    const storedKey = (uploadResult && uploadResult.Key ? uploadResult.Key : generatedKey).replace(/\\/g, '/');
    const artifact = { key: storedKey };
    uploadedArtifacts.push(artifact);

    const metadataDocs = await DocumentMetadata.create(
      [
        {
          key: storedKey,
          s3Location: uploadResult && uploadResult.Location ? uploadResult.Location : undefined,
          originalName: file.originalname || filename,
          bucketName,
          region,
          size: file.size || 0,
          contentType: file.mimetype || 'application/octet-stream',
        },
      ],
      session ? { session } : {}
    );

    artifact.metadataId = metadataDocs[0]._id;

    imageEntries.push({
      isCover: index === 0,
      resolution: buildListingResolution(file),
      documentMetaDataId: metadataDocs[0]._id,
    });

    await safeUnlink(file.path);
  }

  return { imageEntries, uploadedArtifacts };
}

/**
 * build Create Listing Payload
 *
 * Performs logic operations for buildCreateListingPayload.
 *
 * @param listingData - Request/input argument
 * @param property - Request/input argument
 * @param resolvedUnit - Request/input argument
 * @param imageEntries - Request/input argument
 * @returns Operations result
 */
function buildCreateListingPayload(listingData, property, resolvedUnit, imageEntries) {
  const {
    propertyName: ignoredPropertyName,
    propertyType: ignoredPropertyType,
    address: ignoredAddress,
    unitName: ignoredUnitName,
    bedrooms: ignoredBedrooms,
    bathrooms: ignoredBathrooms,
    area: ignoredArea,
    ...persistable
  } = normalizeListingStatusForSyndication(listingData);

  return {
    ...persistable,
    unitId: resolvedUnit.unitId,
    city: persistable.city || property.address?.city || undefined,
    state: persistable.state || property.address?.state || undefined,
    zip: persistable.zip || property.address?.zip || undefined,
    images: imageEntries,
  };
}

/**
 * normalize Listing Status For Syndication
 *
 * Performs logic operations for normalizeListingStatusForSyndication.
 *
 * @param listingData - Request/input argument
 * @returns Operations result
 */
function normalizeListingStatusForSyndication(listingData = {}) {
  const data = { ...listingData };
  if (data.status === LISTING_STATUS.PUBLISHED && listingHasZillowPlatform(data)) {
    data.status = LISTING_STATUS.PUBLISH_IN_PROGRESS;
  }
  return data;
}

/**
 * apply Listing Patch
 *
 * Performs logic operations for applyListingPatch.
 *
 * @param listing - Request/input argument
 * @param patch - Request/input argument
 * @returns Operations result
 */
function applyListingPatch(listing, patch = {}) {
  const normalizedPatch = normalizeListingStatusForSyndication(patch);
  Object.keys(normalizedPatch).forEach((key) => {
    if (normalizedPatch[key] === undefined || RESTRICTED_UPDATE_FIELDS.has(key)) {
      return;
    }
    listing[key] = normalizedPatch[key];
  });
}

/**
 * attach Syndication Status
 *
 * Performs logic operations for attachSyndicationStatus.
 *
 * @param listing - Request/input argument
 * @returns Operations result
 */
function attachSyndicationStatus(listing) {
  if (!listing) return listing;
  return {
    ...listing,
    syndicationStatus: syndicationService.getSyndicationStatusFromListing(listing),
  };
}

async function getListingByIdInSession(id, session, options = {}) {
  assertListingId(id);
  logListingService('SERVICE_DB_QUERY', {
    requestId: options.requestId,
    action: options.action || 'getListingById',
    listingId: id,
  }, 'Loading listing by ID from database');

  const listing = await hydrateListingById(id, session);
  if (!listing) {
    throw createHttpError('Listing not found', 404);
  }
  return attachSyndicationStatus(listing);
}

async function listListingsInSession(rawQuery = {}, session, options = {}) {
  logListingService('SERVICE_DB_QUERY', {
    requestId: options.requestId,
    action: options.action || 'listListings',
    page: rawQuery?.pageNumber,
    pageSize: rawQuery?.pageSize,
  }, 'Querying listings with filters');

  const query = normalizeListingQuery(rawQuery);
  const filter = { isDeleted: { $ne: true } };
  const createdBy = resolveCreatedBy(query);

  if (createdBy) {
    const propertyIds = await findPropertyIdsByCreatedByInSession(createdBy, session);
    if (!propertyIds.length) {
      return {
        data: [],
        total: 0,
        page: query.pageNumber || 1,
        pageSize: query.pageSize || 10,
      };
    }
    filter.propertyId = { $in: propertyIds };
  }

  if (query.propertyId) {
    filter.propertyId = Array.isArray(query.propertyId)
      ? { $in: query.propertyId }
      : query.propertyId;
  }
  if (query.status) filter.status = query.status;
  if (query.leaseType) filter.leaseType = query.leaseType;
  if (query.isAcceptingApplications !== undefined) {
    filter.isAcceptingApplications =
      query.isAcceptingApplications === true || query.isAcceptingApplications === 'true';
  }
  if (query.city) filter.city = new RegExp(query.city, 'i');
  if (query.state) filter.state = query.state;
  if (query.availableFrom) {
    filter.availableDate = { $gte: DateUtil.toUTC(query.availableFrom) };
  }
  if (query.availableTo) {
    filter.availableDate = {
      ...filter.availableDate,
      $lte: DateUtil.toUTC(query.availableTo),
    };
  }
  if (query.minRent !== undefined) {
    filter.rentalAmount = { $gte: Number(query.minRent) };
  }
  if (query.maxRent !== undefined) {
    filter.rentalAmount = {
      ...filter.rentalAmount,
      $lte: Number(query.maxRent),
    };
  }

  if (query.unitName) {
    const unitNameRegex = new RegExp(query.unitName, 'i');
    let propertyFilter = null;

    if (filter.propertyId) {
      propertyFilter = { _id: filter.propertyId, isDeleted: { $ne: true } };
    } else if (createdBy) {
      const propertyIds = await findPropertyIdsByCreatedByInSession(createdBy, session);
      propertyFilter = { _id: { $in: propertyIds }, isDeleted: { $ne: true } };
    }

    const matchedUnitIds = [];
    if (propertyFilter) {
      const properties = await applySession(
        Property.find(propertyFilter).select('unitDetails._id unitDetails.unitName'),
        session
      ).lean();

      properties.forEach((property) => {
        (property.unitDetails || []).forEach((unit) => {
          if (unit && unit._id && unit.unitName != null && unitNameRegex.test(String(unit.unitName))) {
            matchedUnitIds.push(unit._id);
          }
        });
      });
    }

    filter.$or = [{ unitId: { $in: matchedUnitIds } }, { unitName: unitNameRegex }];
  }

  const { offset, limit, page, pageSize } = getPagination({
    page: query.pageNumber,
    pageSize: query.pageSize,
  });

  const listingsQuery = Listing.find(filter)
    .select(LISTING_LIST_SELECT)
    .populate({
      path: 'propertyId',
      select: LISTING_PROPERTY_SELECT,
      match: { isDeleted: { $ne: true } },
    })
    .populate({
      path: 'images.documentMetaDataId',
      select: LISTING_IMAGE_METADATA_SELECT,
    })
    .sort('-updatedAt')
    .skip(offset)
    .limit(limit);

  const [listings, total] = await Promise.all([
    applySession(listingsQuery, session).lean(),
    applySession(Listing.countDocuments(filter), session),
  ]);

  logListingService('SERVICE_DB_QUERY', {
    requestId: options.requestId,
    action: options.action || 'listListings',
    total,
    page,
    pageSize,
    count: listings.length,
  }, `Listings query returned ${listings.length} of ${total} records`);

  return {
    data: await Promise.all(
      listings.map(async (listing) => {
        const optimized = optimizeListingListResponse(listing);
        if (optimized?.images?.length) {
          optimized.images = await attachListingImageUrls(optimized.images);
        }
        return optimized;
      })
    ),
    total,
    page,
    pageSize,
  };
}

async function createListingInSession(listingData, options, session) {
  if (!listingData || typeof listingData !== 'object') {
    throw createHttpError('listing data is required', 400);
  }
  if (!listingData.propertyId) {
    throw createHttpError('propertyId is required', 400);
  }

  logListingService('SERVICE_VALIDATE', {
    requestId: options.requestId,
    action: options.action || 'createListing',
    propertyId: listingData.propertyId,
  }, 'Create listing payload validated');

  const property = await applySession(
    Property.findOne({ _id: listingData.propertyId, isDeleted: { $ne: true } }),
    session
  ).lean();

  if (!property) {
    throw createHttpError('Property not found', 404);
  }

  logListingService('SERVICE_DB_QUERY', {
    requestId: options.requestId,
    action: options.action || 'createListing',
    propertyId: listingData.propertyId,
  }, 'Property resolved for new listing');

  const resolvedUnit = await resolveUnitForPropertyId(
    listingData.propertyId,
    { unitId: listingData.unitId, unitName: listingData.unitName },
    { session }
  );

  await inactivateSiblingListings(
    {
      propertyId: listingData.propertyId,
      unitId: resolvedUnit.unitId,
      unitName: resolvedUnit.unitName,
    },
    session,
    options.compensation
  );

  const { imageEntries, uploadedArtifacts } = await stageListingImages(options.files, {
    session,
    uploadedBy: options.uploadedBy,
  });
  options.compensation.uploadedArtifacts.push(...uploadedArtifacts);

  const listing = new Listing(
    buildCreateListingPayload(listingData, property, resolvedUnit, imageEntries)
  );
  const saved = await listing.save(session ? { session } : {});
  options.compensation.createdListingId = saved._id;

  logListingService('SERVICE_DB_WRITE', {
    requestId: options.requestId,
    action: options.action || 'createListing',
    listingId: saved._id,
    propertyId: listingData.propertyId,
  }, 'New listing record saved to database');

  const created = await getListingByIdInSession(saved._id, session, options);
  return created;
}

async function updateListingInSession(id, listingData, options, session) {
  if (!listingData || typeof listingData !== 'object') {
    throw createHttpError('listing data is required', 400);
  }

  const listing = await loadListingForWrite(id, session);
  if (!listing) {
    throw createHttpError('Listing not found', 404);
  }

  captureOriginalListing(options.compensation, listing);
  const previousStatus = listing.status;

  const requestedDeleteIds = Array.isArray(listingData.documentsToDelete)
    ? [...new Set(listingData.documentsToDelete.map((value) => String(value)))]
    : [];
  const removedDocumentIds = [];

  if (requestedDeleteIds.length > 0) {
    const deleteSet = new Set(requestedDeleteIds);
    listing.images = ensureCoverImage(
      (listing.images || []).filter((image) => {
        const documentId = image && image.documentMetaDataId ? String(image.documentMetaDataId) : '';
        if (documentId && deleteSet.has(documentId)) {
          removedDocumentIds.push(image.documentMetaDataId);
          return false;
        }
        return true;
      })
    );
  }

  applyListingPatch(listing, listingData);

  if (options.files.length > 0) {
    const { imageEntries, uploadedArtifacts } = await stageListingImages(options.files, {
      session,
      uploadedBy: options.uploadedBy,
    });
    options.compensation.uploadedArtifacts.push(...uploadedArtifacts);

    listing.images = Array.isArray(listing.images) ? listing.images : [];
    if (listing.images.length > 0) {
      listing.images.forEach((image) => {
        image.isCover = false;
      });
    }
    listing.images.push(...imageEntries);
    ensureCoverImage(listing.images);
  }

  if (ACTIVE_LISTING_STATUSES.includes(listing.status)) {
    await inactivateSiblingListings(
      {
        propertyId: listing.propertyId,
        unitId: listing.unitId,
        unitName: listing.unitName,
        excludeId: listing._id,
      },
      session,
      options.compensation
    );
  }

  await listing.save(session ? { session } : {});

  logListingService('SERVICE_DB_WRITE', {
    requestId: options.requestId,
    action: options.action || 'updateListing',
    listingId: listing._id,
  }, 'Listing record updated in database');

  const hydrated = await getListingByIdInSession(listing._id, session, options);

  if (removedDocumentIds.length > 0) {
    const deletedMetadata = await applySession(
      DocumentMetadata.find({ _id: { $in: removedDocumentIds } }).select('_id key'),
      session
    ).lean();

    if (deletedMetadata.length > 0) {
      await applySession(
        DocumentMetadata.deleteMany({ _id: { $in: deletedMetadata.map((doc) => doc._id) } }),
        session
      );
      options.compensation.deletedArtifacts.push(
        ...deletedMetadata.map((doc) => ({ key: doc.key }))
      );
    }
  }

  const syndicationOutcome = resolveSyndicationOutcome(previousStatus, hydrated.status, {
    allowSync: true,
  });
  if (syndicationOutcome) {
    logListingService('SERVICE_SYNDICATION', {
      requestId: options.requestId,
      action: options.action || 'updateListing',
      listingId: listing._id,
      provider: SYNDICATION_PROVIDERS.ZILLOW,
      outcome: syndicationOutcome,
      deferred: true,
    }, 'Syndication deferred until after update transaction commits');
  }

  return {
    listing: attachSyndicationStatus(hydrated),
    syndicationOutcome,
  };
}

async function uploadListingImagesInSession(id, files, options, session) {
  const listing = await loadListingForWrite(id, session);
  if (!listing) {
    throw createHttpError('Listing not found', 404);
  }

  captureOriginalListing(options.compensation, listing);

  const { imageEntries, uploadedArtifacts } = await stageListingImages(files, {
    session,
    uploadedBy: options.uploadedBy,
  });
  options.compensation.uploadedArtifacts.push(...uploadedArtifacts);

  listing.images = Array.isArray(listing.images) ? listing.images : [];
  if (listing.images.length > 0) {
    listing.images.forEach((image) => {
      image.isCover = false;
    });
  }
  listing.images.push(...imageEntries);
  ensureCoverImage(listing.images);

  await listing.save(session ? { session } : {});
  const hydrated = await getListingByIdInSession(listing._id, session);
  return hydrated.images || [];
}

async function updateListingStatusInSession(id, nextStatus, action, options, session) {
  const listing = await loadListingForWrite(id, session);
  if (!listing) {
    throw createHttpError('Listing not found', 404);
  }

  captureOriginalListing(options.compensation, listing);
  const previousStatus = listing.status;

  if (ACTIVE_LISTING_STATUSES.includes(nextStatus)) {
    await inactivateSiblingListings(
      {
        propertyId: listing.propertyId,
        unitId: listing.unitId,
        unitName: listing.unitName,
        excludeId: listing._id,
      },
      session,
      options.compensation
    );
  }

  listing.status = nextStatus;

  if (options.syndicationPlatforms !== undefined) {
    listing.syndicationPlatforms = options.syndicationPlatforms;
  }

  if (options.removeFromPlatforms !== undefined && options.removeFromPlatforms.length > 0) {
    const removeSet = new Set(
      options.removeFromPlatforms.map((p) => String(p).toLowerCase())
    );
    listing.syndicationPlatforms = (listing.syndicationPlatforms || [])
      .filter((p) => !removeSet.has(String(p).toLowerCase()));
    options.syndicationRemoveProviders = platformsToProviders(options.removeFromPlatforms);
  }

  if (options.comment && String(options.comment).trim()) {
    listing.comments = Array.isArray(listing.comments) ? listing.comments : [];
    listing.comments.push({
      text: String(options.comment).trim(),
      action,
      createdBy: options.actorId || undefined,
      createdAt: ClockService.now(),
    });
  }

  await listing.save(session ? { session } : {});
  const updated = await getListingByIdInSession(listing._id, session, options);
  const syndicationOutcome = resolveSyndicationOutcome(previousStatus, nextStatus);

  if (syndicationOutcome) {
    logListingService('SERVICE_SYNDICATION', {
      requestId: options.requestId,
      action: options.action || action,
      listingId: listing._id,
      provider: SYNDICATION_PROVIDERS.ZILLOW,
      outcome: syndicationOutcome,
      deferred: true,
    }, 'Syndication deferred until after status transaction commits');
  }

  return { listing: updated, syndicationOutcome, syndicationRemoveProviders: options.syndicationRemoveProviders };
}

async function deleteListingInSession(id, options, session) {
  const listing = await loadListingForWrite(id, session);
  if (!listing) {
    throw createHttpError('Listing not found', 404);
  }

  captureOriginalListing(options.compensation, listing);

  // Hydrate for Zillow removal but defer unpublish until after the transaction commits.
  // In-transaction async syndication writes cause MongoDB write conflicts on this document.
  let syndicationListing = null;
  const hydrated = await hydrateListingById(listing._id, session);
  if (hydrated) {
    syndicationListing = hydrated;
    logListingService('SERVICE_SYNDICATION', {
      requestId: options.requestId,
      action: options.action || 'deleteListing',
      listingId: listing._id,
      provider: SYNDICATION_PROVIDERS.ZILLOW,
      outcome: 'unpublishDeferred',
    }, 'Zillow unpublish deferred until after delete transaction commits');
  }

  listing.isDeleted = true;
  await listing.save(withSession({}, session));

  logListingService('SERVICE_DB_WRITE', {
    requestId: options.requestId,
    action: options.action || 'deleteListing',
    listingId: listing._id,
  }, 'Listing soft-deleted in database');
  return { listing: toPlain(listing), syndicationListing };
}

async function createListing(listingData, options = {}) {
  const { listing } = unwrapListingMutationResult(
    await runListingMutation(
      (session, compensation, mutationOptions) =>
        createListingInSession(
          listingData,
          { ...mutationOptions, compensation },
          session
        ),
      options
    )
  );

  if (ACTIVE_LISTING_STATUSES.includes(listing?.status) && listingHasZillowPlatform(listing)) {
    logListingService('SERVICE_SYNDICATION', {
      requestId: options.requestId,
      action: options.action || 'createListing',
      listingId: listing?._id,
      provider: SYNDICATION_PROVIDERS.ZILLOW,
      outcome: 'bulk_feed_queued',
    }, 'Listing queued for next Zillow bulk feed run');
    markZillowQueuedForBulkFeed(listing._id, { publishing: true }).catch((error) => {
      logListingService('SERVICE_SYNDICATION', {
        requestId: options.requestId,
        listingId: listing?._id,
        error: error.message,
      }, 'Failed to mark listing for bulk feed');
    });
  }

  return listing;
}

async function getListingById(id, options = {}) {
  const action = options.action || 'getListingById';
  logListingService('SERVICE_START', { requestId: options.requestId, action, listingId: id });
  const result = await withListingTransaction(
    (session) => getListingByIdInSession(id, session, { ...options, action }),
    options
  );
  logListingService('SERVICE_END', {
    requestId: options.requestId,
    action,
    listingId: id,
    success: true,
  });
  return result;
}

async function listListings(query = {}, options = {}) {
  const action = options.action || 'listListings';
  logListingService('SERVICE_START', { requestId: options.requestId, action });
  const result = await withListingTransaction(
    (session) => listListingsInSession(query, session, { ...options, action }),
    options
  );
  logListingService('SERVICE_END', {
    requestId: options.requestId,
    action,
    total: result?.total,
    success: true,
  });
  return result;
}

async function updateListing(id, listingData, options = {}) {
  const { listing } = unwrapListingMutationResult(
    await runListingMutation(
      (session, compensation, mutationOptions) =>
        updateListingInSession(
          id,
          listingData,
          { ...mutationOptions, compensation },
          session
        ),
      options
    )
  );

  if (listing?.status === LISTING_STATUS.PUBLISH_IN_PROGRESS && listingHasZillowPlatform(listing)) {
    await markZillowQueuedForBulkFeed(listing._id, { publishing: true });
  }

  return listing;
}

async function deleteListing(id, options = {}) {
  const mutationResult = await runListingMutation(
    (session, compensation, mutationOptions) =>
      deleteListingInSession(
        id,
        { ...mutationOptions, compensation },
        session
      ),
    options
  );

  const { listing, syndicationListing } = mutationResult || {};
  if (syndicationListing && listingHasZillowPlatform(syndicationListing)) {
    markZillowQueuedForBulkFeed(syndicationListing._id, { publishing: false }).catch(() => {});
  }
  return listing;
}

async function uploadListingImages(id, files = [], options = {}) {
  return runListingMutation(
    (session, compensation, mutationOptions) =>
      uploadListingImagesInSession(
        id,
        mutationOptions.files,
        { ...mutationOptions, compensation },
        session
      ),
    { ...options, files }
  );
}

async function runStatusChangeMutation(id, nextStatus, action, options = {}) {
  const { listing } = unwrapListingMutationResult(
    await runListingMutation(
      (session, compensation, mutationOptions) =>
        updateListingStatusInSession(
          id,
          nextStatus,
          action,
          { ...mutationOptions, ...options, compensation },
          session
        ),
      options
    )
  );

  if (listing?.status === LISTING_STATUS.PUBLISH_IN_PROGRESS && listingHasZillowPlatform(listing)) {
    await markZillowQueuedForBulkFeed(listing._id, { publishing: true });
  } else if (listing?.status === LISTING_STATUS.DRAFT_IN_PROGRESS) {
    await markZillowQueuedForBulkFeed(listing._id, { publishing: false });
  }

  return listing;
}

async function publishListing(id, options = {}) {
  return runStatusChangeMutation(
    id,
    LISTING_STATUS.PUBLISH_IN_PROGRESS,
    'publish',
    options
  );
}

async function activateListing(id, options = {}) {
  return runStatusChangeMutation(
    id,
    LISTING_STATUS.ACTIVE,
    'activate',
    options
  );
}

async function saveDraftListing(id, options = {}) {
  return runStatusChangeMutation(
    id,
    LISTING_STATUS.DRAFT_IN_PROGRESS,
    'draft',
    options
  );
}

async function setInactiveListing(id, options = {}) {
  return runStatusChangeMutation(
    id,
    LISTING_STATUS.INACTIVE,
    'inactive',
    options
  );
}

async function publishFromDraftListing(id, options = {}) {
  return runStatusChangeMutation(
    id,
    LISTING_STATUS.PUBLISH_IN_PROGRESS,
    'publish',
    options
  );
}

async function publishFromInactiveListing(id, options = {}) {
  return runStatusChangeMutation(
    id,
    LISTING_STATUS.PUBLISH_IN_PROGRESS,
    'publish',
    options
  );
}

module.exports = {
  createListing,
  getListingById,
  listListings,
  updateListing,
  deleteListing,
  uploadListingImages,
  publishListing,
  activateListing,
  saveDraftListing,
  setInactiveListing,
  publishFromDraftListing,
  publishFromInactiveListing,
  withListingTransaction,
  runInTransaction, 
  createListingService: createListing,
  getListingByIdService: getListingById,
  listListingsService: listListings,
  updateListingService: updateListing,
  deleteListingService: deleteListing,
  uploadListingImagesService: uploadListingImages,
  publishListingService: publishListing,
  activateListingService: activateListing,
  saveDraftListingService: saveDraftListing,
  setInactiveListingService: setInactiveListing,
  publishFromDraftListingService: publishFromDraftListing,
  publishFromInactiveListingService: publishFromInactiveListing,
};
