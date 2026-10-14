/**
 * ------------------------------------------------------------------
 * File: masterData.service.js
 * Module: Src Shared Modules Master Service
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * masterData.controller
 * ------------------------------------------------------------------
 */

const MasterData = require('../model/masterData.model');

async function createMasterData(data, options = {}) {
  // options may contain { session }
  if (options.session) {
    // create with session
    const docs = await MasterData.create([data], { session: options.session });
    return docs[0];
  }
  return MasterData.create(data);
}

async function getMasterDataById(id) {
  return MasterData.findById(id);
}

async function updateMasterData(id, update, options = {}) {
  const opts = { new: true };
  if (options.session) opts.session = options.session;
  const updated = await MasterData.findByIdAndUpdate(id, update, opts);
  if (updated?.key === require('../../../../common/constants/masterDataKeys').MASTER_DATA_KEYS.HOA_ASSOCIATION_TYPES) {
    const { clearAssociationTypeCache } = require('../../../../common/helpers/associationTypeHelper');
    clearAssociationTypeCache();
  }
  return updated;
}

async function deleteMasterData(id, options = {}) {
  const opts = {};
  if (options.session) opts.session = options.session;
  return MasterData.findByIdAndDelete(id, opts);
}

async function listMasterData({ pageNumber, pageSize } = {}) {
  // Get standardized pagination parameters
  const { getPagination } = require('../../../../common/helpers/paginationHelper');
  const { offset, limit: effectiveLimit, page, pageSize: effectivePageSize } = getPagination({ 
    page: pageNumber, 
    pageSize
  });

  // Execute paginated query
  const [items, total] = await Promise.all([
    MasterData.find()
      .skip(offset)
      .limit(effectiveLimit)
      .lean(),
    MasterData.countDocuments()
  ]);

  return {
    data: items,
    total,
    page,
    pageSize: effectivePageSize
  };
}

async function getMasterDataByKeys(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return [];
  
  const records = await MasterData.find({ key: { $in: keys } });
  
  // Check if all keys are listing keys - if so, return organized data
  const listingKeys = [
    'Landlord_Listing_PetPolicy',
    'Landlord_Listing_UtilitiesIncluded',
    'Landlord_Listing_Amenities',
    'Landlord_Listing_SyndicationPlatforms'
  ];
  
  const isAllListingKeys = keys.every(key => listingKeys.includes(key));
  
  // If requesting listing keys, return organized object
  if (isAllListingKeys && keys.length === listingKeys.length) {
    const result = {
      petPolicy: [],
      utilitiesIncluded: [],
      amenities: [],
      syndicationPlatforms: []
    };
    
    records.forEach(record => {
      if (record.key === 'Landlord_Listing_PetPolicy') {
        result.petPolicy = record.data;
      } else if (record.key === 'Landlord_Listing_UtilitiesIncluded') {
        result.utilitiesIncluded = record.data;
      } else if (record.key === 'Landlord_Listing_Amenities') {
        result.amenities = record.data;
      } else if (record.key === 'Landlord_Listing_SyndicationPlatforms') {
        result.syndicationPlatforms = record.data;
      }
    });
    
    return result;
  }
  
  // Otherwise return raw array of records
  return records;
}

module.exports = {
  createMasterData,
  getMasterDataById,
  updateMasterData,
  deleteMasterData,
  listMasterData,
  getMasterDataByKeys,
};
