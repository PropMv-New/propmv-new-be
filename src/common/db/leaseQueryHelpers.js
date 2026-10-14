/**
 * ------------------------------------------------------------------
 * File: leaseQueryHelpers.js
 * Module: Src Common Db
 *
 * Purpose:
 * Backend utility/module providing helper functions for leaseQueryHelpers.
 *
 * Used By:
 * propertyRelatedQueries, lease.model, lease.service
 * ------------------------------------------------------------------
 */

/**
 * Shared Lease query helpers - work regardless of which Lease schema registered first.
 */
const mongoose = require('mongoose');
const { toObjectId, exactUnitNameRegex } = require('./mongooseHelpers');

/** Strict ObjectId sanitizer - returns null for anything that is not a valid 24-char hex string. */
function toSafeObjectId(value) {
  const str = String(
    value && typeof value === 'object' && value._id ? value._id : value ?? ''
  ).trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function toSafeObjectIdArray(values) {
  if (!Array.isArray(values)) return [];
  return values.map(toSafeObjectId).filter(Boolean);
}

const LEASE_LIST_PROJECTION = {
  _id: 1,
  property_id: 1,
  unitName: 1,
  status: 1,
  lease_status: 1,
  'rentDetails.amount': 1,
  end_date: 1,
  endDate: 1,
  lease_end: 1,
  lease_type: 1,
  leaseType: 1,
  type: 1,
  'rentAndDepositDestribution.split.tenantId': 1,
};

const LEASE_LANDLORD_LIST_PROJECTION = {
  _id: 1,
  property_id: 1,
  unitId: 1,
  unitName: 1,
  status: 1,
  leaseTerm: 1,
  start_date: 1,
  end_date: 1,
  rentDetails: 1,
  rentAndDepositDestribution: 1,
};

/** Sort leases by updatedAt desc; use createdAt when updatedAt is absent. */
function leaseListUpdatedAtSortStages() {
  return [
    { $addFields: { _listSortDate: { $ifNull: ['$updatedAt', '$createdAt'] } } },
    { $sort: { _listSortDate: -1 } },
  ];
}

async function findPaginatedLeasesForLandlordList(filter, options = {}) {
  const Lease = getLeaseModel();
  const {
    offset = 0,
    limit = 10,
    propertyCollectionName = 'properties',
    propertySelect = { name: 1, address: 1 },
  } = options;

  const paginationStages = [];
  paginationStages.push({ $skip: offset });
  // limit=0 means fetch all (no cap); otherwise apply the limit
  if (limit > 0) {
    paginationStages.push({ $limit: limit });
  }

  const pipeline = [
    { $match: filter },
    ...leaseListUpdatedAtSortStages(),
    ...paginationStages,
    {
      $lookup: {
        from: propertyCollectionName,
        localField: 'property_id',
        foreignField: '_id',
        as: '_populatedProperty',
        pipeline: [
          { $match: { isDeleted: { $ne: true } } },
          { $project: propertySelect },
        ],
      },
    },
    {
      $addFields: {
        property_id: { $arrayElemAt: ['$_populatedProperty', 0] },
      },
    },
    {
      $project: LEASE_LANDLORD_LIST_PROJECTION,
    },
  ];

  return Lease.aggregate(pipeline).exec();
}

/**
 * get Lease Model
 *
 * Performs logic operations for getLeaseModel.
 *
 * @returns Operations result
 */
function getLeaseModel() {
  const Lease = mongoose.models.Lease;
  if (!Lease) {
    require('../../portals/hoa-board/modules/leasing/model/lease.model');
  }
  return mongoose.models.Lease;
}

/**
 * extract Tenant Ids
 *
 * Performs logic operations for extractTenantIds.
 *
 * @param leases - Request/input argument
 * @returns Operations result
 */
function extractTenantIds(leases = []) {
  const tenantIds = new Set();
  for (const lease of leases) {
    const splits = lease?.rentAndDepositDestribution?.split;
    if (!Array.isArray(splits)) continue;
    for (const split of splits) {
      if (split?.tenantId) tenantIds.add(String(split.tenantId));
    }
  }
  return Array.from(tenantIds).map(toObjectId);
}

async function findLeasesByPropertyId(propertyId, options = {}) {
  const Lease = getLeaseModel();
  const { unitName, select, lean = true } = options;
  const safeId = toSafeObjectId(propertyId);
  if (!safeId) return [];
  const filter = { property_id: safeId };
  if (unitName) filter.unitName = exactUnitNameRegex(unitName);

  let query = Lease.find(filter);
  if (select) query = query.select(select);
  return lean ? query.lean().exec() : query.exec();
}

async function findLeasesByPropertyIds(propertyIds, options = {}) {
  const Lease = getLeaseModel();
  const { select = LEASE_LIST_PROJECTION, lean = true } = options;
  const ids = toSafeObjectIdArray(propertyIds);
  if (!ids.length) return [];
  let query = Lease.find({ property_id: { $in: ids } }).select(select);
  return lean ? query.lean().exec() : query.exec();
}

async function leaseExistsForProperty(propertyId, unitName) {
  const Lease = getLeaseModel();
  const safeId = toSafeObjectId(propertyId);
  if (!safeId) return false;
  const filter = { property_id: safeId };
  const safeUnitName = unitName != null && typeof unitName !== 'object'
    ? String(unitName).trim()
    : null;
  if (safeUnitName) filter.unitName = exactUnitNameRegex(safeUnitName);
  const doc = await Lease.findOne(filter).select('_id').lean().exec();
  return Boolean(doc);
}

/**
 * attach Lease Query Statics
 *
 * Performs logic operations for attachLeaseQueryStatics.
 *
 * @param LeaseModel - Request/input argument
 * @returns Operations result
 */
function attachLeaseQueryStatics(LeaseModel) {
  if (!LeaseModel || LeaseModel.__leaseQueryStaticsAttached) return LeaseModel;

  LeaseModel.findByPropertyId = (propertyId, options) => findLeasesByPropertyId(propertyId, options);
  LeaseModel.findByPropertyIds = (propertyIds, options) => findLeasesByPropertyIds(propertyIds, options);
  LeaseModel.existsForProperty = (propertyId, unitName) => leaseExistsForProperty(propertyId, unitName);
  LeaseModel.extractTenantIds = extractTenantIds;
  LeaseModel.__leaseQueryStaticsAttached = true;
  return LeaseModel;
}

module.exports = {
  LEASE_LIST_PROJECTION,
  LEASE_LANDLORD_LIST_PROJECTION,
  leaseListUpdatedAtSortStages,
  findPaginatedLeasesForLandlordList,
  extractTenantIds,
  findLeasesByPropertyId,
  findLeasesByPropertyIds,
  leaseExistsForProperty,
  attachLeaseQueryStatics,
  getLeaseModel,
};
