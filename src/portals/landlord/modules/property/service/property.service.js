/**
 * ------------------------------------------------------------------
 * File: property.service.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * property.controller, propertyExport.service, propertySearch.service, property.bank.persistence.check
 * ------------------------------------------------------------------
 */
const mongoose = require('mongoose');
const path = require('path');
const os = require('os');
const Property = require('../model/property.model');
const PaymentBankAccount = require('../../../../../shared/modules/payment/model/paymentBankAccount.model');
const LinkedBankAccount = require('../../../../../shared/modules/payment/account/model/linkedBankAccount.model');
const logger = require('../../../../../common/logger');
const { MAINTENANCE_STATUS, PROPERTY_STATUS, PROPERTY_SOURCE_PORTAL } = require('../../../../../common/constants/property');
const { INVOICE_STATUS, INVOICE_TYPES } = require('../../../../../common/constants/invoice');
const notificationClient = require('../../../../../integrations/notification');
const { notify, EVENTS } = require('../../../../../integrations/notification');

// Aliases for backward compatibility
const INCOME_STATUS = INVOICE_STATUS;
const INCOME_TYPES = INVOICE_TYPES;

/**
 * format Address
 *
 * Performs logic operations for formatAddress.
 *
 * @param address - Request/input argument
 * @returns Operations result
 */
function formatAddress(address) {
  if (!address) return '';
  return `${address.street || ''}${address.street ? ', ' : ''}${address.city || ''}${address.city ? ', ' : ''}${address.state || ''}${address.zip ? ', ' : ''}${address.zip || ''}${address.country ? ', ' : ''}${address.country || ''}`.replace(/, \s*,/g, ', ');
}

const { getPagination } = require('../../../../../common/helpers/paginationHelper');
const { LEASE_TYPES, LEASE_STATUSES } = require('../../../../../common/constants/lease');
const { LISTING_STATUS } = require('../../../../../common/constants/listing');
const { ClockService, DateUtil } = require('../../../../../common/date');
const { resolvePropertyBillingTimezoneFields } = require('../../../../../common/helpers/resolvePropertyBillingTimezone');

/** Listing statuses that block creating another listing for the same unit. */
const BLOCKING_LISTING_STATUSES = [
  LISTING_STATUS.ACTIVE,
  LISTING_STATUS.PUBLISHED,
  LISTING_STATUS.DRAFT,
];
const { UPLOAD_PROPERTY_SUBDIR } = require('../../../../../common/constants/uploads');
const { unitDisplayNameFromMaintenance } = require('../../../../../common/helpers/propertyUnitReference');
const {
  buildLandlordPropertyVisibilityFilter,
  requireCreatedBy,
  resolveCreatedBy,
} = require('../../../../../shared/utils/creatorScope.util');

const EMPTY_PORTFOLIO_OVERVIEW = Object.freeze({
  totalUnits: 0,
  occupancyPercentage: 0,
  occupiedUnits: 0,
  vacantUnits: 0,
  rentPaymentPercentage: 0,
  onTimeUnits: 0,
  behindUnits: 0,
});

function normalizeLandlordSourcePortal(value) {
  return value === PROPERTY_SOURCE_PORTAL.PROPERTY_MANAGER
    ? PROPERTY_SOURCE_PORTAL.PROPERTY_MANAGER
    : PROPERTY_SOURCE_PORTAL.LANDLORD;
}

/**
 * build Property List Filter
 *
 * Performs logic operations for buildPropertyListFilter.
 *
 * @param query - Request/input argument
 * @returns Operations result
 */
async function buildPropertyListFilter(query) {
  const { name, city, state: addrState, zip } = query;
  const search = query.search;
  const isArchived = parseBoolean(query.isArchived);
  const filter = { isDeleted: { $ne: true } };
  const andConditions = [];

  if (query.createdBy) {
    andConditions.push(await buildLandlordPropertyVisibilityFilter(query.createdBy, query.sourcePortal));
  }

  if (isArchived === null || isArchived === false) {
    filter.isArchieved = { $ne: true };
  } else if (isArchived === true) {
    filter.isArchieved = true;
  }

  if (search && search.trim().length > 0) {
    const searchRegex = { $regex: escapeRegex(search.trim()), $options: 'i' };
    andConditions.push({
      $or: [
        { name: searchRegex },
        { 'address.street': searchRegex },
        { 'address.city': searchRegex },
        { 'address.state': searchRegex },
        { 'address.zip': searchRegex },
        { 'address.country': searchRegex },
      ],
    });
  } else {
    if (name) filter.name = { $regex: escapeRegex(name), $options: 'i' };
    if (city) filter['address.city'] = { $regex: escapeRegex(city), $options: 'i' };
    if (addrState) filter['address.state'] = { $regex: escapeRegex(addrState), $options: 'i' };
    if (zip) filter['address.zip'] = { $regex: escapeRegex(zip), $options: 'i' };
  }

  if (andConditions.length === 1) {
    Object.assign(filter, andConditions[0]);
  } else if (andConditions.length > 1) {
    filter.$and = andConditions;
  }

  return filter;
}
const { runInTransaction } = require('../../../../../common/helpers/transactionHelper');

/**
 * apply Session
 *
 * Performs logic operations for applySession.
 *
 * @param query - Request/input argument
 * @param session - Request/input argument
 * @returns Operations result
 */
function applySession(query, session) {
  return session ? query.session(session) : query;
}

async function cleanupS3Keys(keys = []) {
  if (!keys || keys.length === 0) return;
  const s3Client = require('../../../../../integrations/s3');
  for (const key of keys) {
    if (!key) continue;
    try {
      if (s3Client && typeof s3Client.delete === 'function') {
        await s3Client.delete({ key });
      }
    } catch (err) {
      logger.warn('Failed to delete S3 object during rollback:', key, err.message);
    }
  }
}

async function cleanupUploadedAssets(tracker = []) {
  if (!tracker || tracker.length === 0) return;
  const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
  const keys = [];
  for (const item of tracker) {
    if (item.key) keys.push(item.key);
    if (item.metadataId) {
      try {
        await DocumentMetadata.findByIdAndDelete(item.metadataId);
      } catch (err) {
        logger.warn('Failed to delete metadata during rollback:', item.metadataId, err.message);
      }
    }
  }
  await cleanupS3Keys(keys);
}

/**
 * cleanup Temp Files
 *
 * Performs logic operations for cleanupTempFiles.
 *
 * @param files - Request/input argument
 * @returns Operations result
 */
function cleanupTempFiles(files = []) {
  if (!files || files.length === 0) return;
  const fs = require('fs');
  for (const f of files) {
    if (!f || !f.path) continue;
    try {
      fs.unlinkSync(sanitizeFilePath(f.path));
    } catch (ignore) {
      /* ignore */
    }
  }
}

// small helper to parse loose boolean-like query values into true/false/null
function parseBoolean(val) {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'undefined' || val === null) return null;
  const s = String(val).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return null; // unknown
}

/**
 * clone For Storage
 *
 * Performs logic operations for cloneForStorage.
 *
 * @param data - Request/input argument
 * @returns Operations result
 */
function cloneForStorage(data) {
  if (!data || typeof data !== 'object') return data;
  return JSON.parse(JSON.stringify(data));
}

/**
 * infer Late Fee Is Common
 *
 * Performs logic operations for inferLateFeeIsCommon.
 *
 * @param fee - Request/input argument
 * @returns Operations result
 */
function inferLateFeeIsCommon(fee = {}) {
  const scope = fee.applicableScope
    || (Array.isArray(fee.applicableUnits) && fee.applicableUnits.length > 0 ? 'specific' : 'all');
  return scope === 'all' || scope === 'none';
}

/**
 * normalize Property Settings
 *
 * Performs logic operations for normalizePropertySettings.
 *
 * @param settings - Request/input argument
 * @param unitDetails - Request/input argument
 * @returns Operations result
 */
function normalizePropertySettings(settings = {}, unitDetails = []) {
  const normalized = cloneForStorage(settings) || {};
  const unitNames = (Array.isArray(unitDetails) ? unitDetails : [])
    .map((unit) => (unit && unit.unitName ? String(unit.unitName).trim() : ''))
    .filter(Boolean);
  const bankAccountMode = normalized.bankAccountMode || 'shared';

  if (Array.isArray(normalized.lateFees)) {
    normalized.lateFees = normalized.lateFees.map((fee) => ({
      ...fee,
      isCommon: typeof fee.isCommon === 'boolean' ? fee.isCommon : inferLateFeeIsCommon(fee),
    }));
  }

  const incomingUnitAccounts = Array.isArray(normalized.unitBankAccounts)
    ? normalized.unitBankAccounts.filter((entry) => entry && entry.unitName && entry.bankAccount)
    : [];

  if (incomingUnitAccounts.length > 0) {
    normalized.unitBankAccounts = incomingUnitAccounts;
    return normalized;
  }

  const sharedBank = normalized.bankAccount;
  if (sharedBank && unitNames.length > 0) {
    normalized.unitBankAccounts = unitNames.map((unitName) => ({
      unitName,
      bankAccount: cloneForStorage(sharedBank),
    }));
  }

  if (bankAccountMode === 'shared' && sharedBank) {
    normalized.bankAccount = cloneForStorage(sharedBank);
  }

  return normalized;
}

async function checkPropertyNameAvailabilityService(name, createdBy, excludePropertyId = null, sourcePortal = null) {
  const ownerId = requireCreatedBy(createdBy);
  const trimmedName = String(name || '').trim();
  if (!trimmedName) {
    const err = new Error('Property name is required');
    err.status = 400;
    throw err;
  }

  const query = {
    ...(await buildLandlordPropertyVisibilityFilter(ownerId, sourcePortal)),
    name: trimmedName,
    isDeleted: { $ne: true },
    isArchieved: { $ne: true },
  };

  if (excludePropertyId) {
    query._id = { $ne: excludePropertyId };
  }

  const existing = await Property.findOne(query).select('_id name').lean();
  return {
    available: !existing,
    name: trimmedName,
  };
}

/** Merge stored bank fields with linked PaymentBankAccount or business LinkedBankAccount. */
async function enrichBankAccountFromPaymentReference(bankAccount, userId) {
  if (!bankAccount || !bankAccount.paymentBankAccountId) return bankAccount;

  logger.info('[Property] enrichBankAccountFromPaymentReference started', {
    userId,
    paymentBankAccountId: bankAccount.paymentBankAccountId,
  });

  const paymentBankOid = toObjectId(bankAccount.paymentBankAccountId);
  const userOid = toObjectId(userId);
  if (!paymentBankOid) {
    const err = new Error('paymentBankAccountId must be a valid ObjectId'); err.status = 400; throw err;
  }
  const paymentAccount = await PaymentBankAccount.findOne({
    _id: paymentBankOid,
    ...(userOid ? { createdBy: userOid } : {}),
  }).lean();

  if (paymentAccount) {
    const enriched = {
      ...cloneForStorage(bankAccount),
      bankName: bankAccount.bankName || paymentAccount.holderName,
      accountType: bankAccount.accountType || paymentAccount.accountType,
      routingNumber: bankAccount.routingNumber || paymentAccount.routingNumber,
      accountNumber: bankAccount.accountNumber || paymentAccount.last4,
      paymentBankAccountId: paymentAccount._id,
    };

    logger.info('[Property] enrichBankAccountFromPaymentReference completed (payment bank)', {
      userId,
      paymentBankAccountId: paymentAccount._id,
    });

    return enriched;
  }

  const linkedBusinessBank = await LinkedBankAccount.findOne({
    _id: paymentBankOid,
    ...(userOid ? { createdBy: userOid } : {}),
    isDeleted: { $ne: true },
  }).lean();

  if (!linkedBusinessBank) {
    const err = new Error('Linked payment bank account not found or access denied');
    err.status = 400;
    throw err;
  }

  const enrichedFromBusiness = {
    ...cloneForStorage(bankAccount),
    bankName: bankAccount.bankName || linkedBusinessBank.holderName,
    accountType: bankAccount.accountType || linkedBusinessBank.accountType,
    routingNumber: bankAccount.routingNumber || linkedBusinessBank.routingNumber,
    accountNumber: bankAccount.accountNumber || linkedBusinessBank.last4,
    paymentBankAccountId: linkedBusinessBank._id,
  };

  logger.info('[Property] enrichBankAccountFromPaymentReference completed (business linked bank)', {
    userId,
    linkedBankAccountId: linkedBusinessBank._id,
  });

  return enrichedFromBusiness;
}

/** Enrich shared and per-unit bank accounts from paymentbankaccounts before persistence. */
async function enrichPropertySettingsPaymentBanks(settings = {}, userId) {
  if (!settings) return settings;

  logger.info('[Property] enrichPropertySettingsPaymentBanks started', { userId });
  const next = cloneForStorage(settings) || {};

  if (next.bankAccount) {
    next.bankAccount = await enrichBankAccountFromPaymentReference(next.bankAccount, userId);
  }

  if (Array.isArray(next.unitBankAccounts)) {
    next.unitBankAccounts = await Promise.all(
      next.unitBankAccounts.map(async (entry) => {
        if (!entry || !entry.bankAccount) return entry;
        return {
          ...entry,
          bankAccount: await enrichBankAccountFromPaymentReference(entry.bankAccount, userId),
        };
      })
    );
  }

  logger.info('[Property] enrichPropertySettingsPaymentBanks completed', { userId });
  return next;
}

/**
 * merge Bank Account Fields
 *
 * Performs logic operations for mergeBankAccountFields.
 *
 * @param propertyData - Request/input argument
 * @param existingSettings - Request/input argument
 * @param existingUnitDetails - Request/input argument
 * @returns Operations result
 */
function mergeBankAccountFields(propertyData = {}, existingSettings = {}, existingUnitDetails = []) {
  const incomingSettings = propertyData.propertySettings || {};
  const unitDetails = Array.isArray(propertyData.unitDetails) && propertyData.unitDetails.length > 0
    ? propertyData.unitDetails
    : (Array.isArray(existingUnitDetails) ? existingUnitDetails : []);
  const existingBank = (existingSettings && existingSettings.bankAccount) || {};
  const incomingBank = (incomingSettings && incomingSettings.bankAccount) || {};

  const mergedBank = {
    ...cloneForStorage(existingBank),
    ...cloneForStorage(incomingBank),
  };

  // Defensive fallbacks: support flows that send bank fields at root
  // or directly under propertySettings instead of propertySettings.bankAccount.
  if (typeof mergedBank.bankName === 'undefined') {
    mergedBank.bankName = incomingSettings.bankName ?? propertyData.bankName ?? mergedBank.bankName;
  }
  if (typeof mergedBank.accountType === 'undefined') {
    mergedBank.accountType = incomingSettings.accountType ?? propertyData.accountType ?? mergedBank.accountType;
  }
  if (typeof mergedBank.routingNumber === 'undefined') {
    mergedBank.routingNumber = incomingSettings.routingNumber ?? propertyData.routingNumber ?? mergedBank.routingNumber;
  }
  if (typeof mergedBank.accountNumber === 'undefined') {
    mergedBank.accountNumber = incomingSettings.accountNumber ?? propertyData.accountNumber ?? mergedBank.accountNumber;
  }
  const existingBankAddress = (existingBank && existingBank.address) || {};
  const incomingBankAddress = (incomingBank && incomingBank.address) || {};
  mergedBank.address = {
    ...cloneForStorage(existingBankAddress),
    ...cloneForStorage(incomingBankAddress),
    line2: typeof incomingBankAddress.line2 !== 'undefined'
      ? incomingBankAddress.line2
      : (typeof incomingBankAddress.addressLine2 !== 'undefined' ? incomingBankAddress.addressLine2 : existingBankAddress.line2),
    addressLine2: typeof incomingBankAddress.addressLine2 !== 'undefined'
      ? incomingBankAddress.addressLine2
      : (typeof incomingBankAddress.line2 !== 'undefined' ? incomingBankAddress.line2 : existingBankAddress.addressLine2),
  };

  const mergedLateFees = Array.isArray(incomingSettings.lateFees)
    ? cloneForStorage(incomingSettings.lateFees)
    : (Array.isArray(existingSettings.lateFees) ? cloneForStorage(existingSettings.lateFees) : []);

  return normalizePropertySettings({
    ...cloneForStorage(existingSettings || {}),
    ...cloneForStorage(incomingSettings || {}),
    bankAccount: mergedBank,
    lateFees: mergedLateFees,
  }, unitDetails);
}

/**
 * Escape a string for use in a Regex pattern (exact-match safe)
 */
/**
 * Generate initials from property name
 * @param {string} name - Property name
 * @returns {string} - Initials (max 2 characters)
 */
function generatePropertyInitials(name) {
  if (!name || typeof name !== 'string') return 'P';
  
  const words = name.trim().split(/\s+/);
  if (words.length === 0) return 'P';
  
  if (words.length === 1) {
    // Single word: take first 2 characters
    return words[0].substring(0, 2).toUpperCase();
  }
  
  // Multiple words: take first character of first two words
  return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
}

/**
 * Get profile image URL for a property
 * @param {object} property - Property object with profileImageId
 * @returns {Promise<string|null>} - Profile image URL or null
 */
async function getProfileImageUrl(property) {
  if (!property || !property.profileImageId) return null;
  
  try {
    const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
    const documentsService = require('../../../../../shared/modules/documents/service/documents.service');
    
    const metadata = await DocumentMetadata.findById(property.profileImageId).lean();
    if (!metadata) return null;
    
    // Generate presigned URL for the profile image
    try {
      const url = await documentsService.getPresignedUrl(property.profileImageId.toString(), 3600);
      return url;
    } catch (e) {
      // Fallback to building public URL
      return documentsService.buildPublicUrl(metadata);
    }
  } catch (e) {
    logger.warn('Error fetching profile image URL:', e.message);
    return null;
  }
}

/**
 * escape Regex
 *
 * Performs logic operations for escapeRegex.
 *
 * @param s - Request/input argument
 * @returns Operations result
 */
function escapeRegex(s) {
  if (!s) return '';
  return String(s).replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
}

/**
 * Compute stats for a specific unit (scoped to a property). Returns amountOverdue, leaseExpiration, leaseExpiration90, rent, leasesCount
 * This is a small, focused helper used by getPropertiesService when expanding multi-unit properties.
 */
async function computeStatsForUnit(property, unitName) {
  const propObjId = toObjectId(property._id);
  const leaseColl = mongoose.connection.collection('leases');
  const incomeColl = mongoose.connection.collection('invoices');

  // Find leases for property (and optionally unitName)
  const leaseQuery = { property_id: propObjId, isDeleted: { $ne: true } };
  if (unitName) leaseQuery.unitName = { $regex: `^${escapeRegex(String(unitName))}$`, $options: 'i' };
  let leases = [];
  try { leases = await leaseColl.find(leaseQuery).toArray(); } catch (e) { leases = []; }

  const leaseIds = leases.map(l => l._id || l.id).map(toObjectId).filter(Boolean);

  // amountOverdue for these leases
  let amountOverdue = 0;
  if (leaseIds.length > 0) {
    try {
      const overdueIncomes = await incomeColl.find({ lease_id: { $in: leaseIds }, status: INCOME_STATUS.OVERDUE, type: INCOME_TYPES.RENT }).toArray();
      amountOverdue = overdueIncomes.reduce((s, inc) => {
        const items = inc.invoiceItemDetails || [];
        return s + items.reduce((sum, item) => sum + (item.balanceDue || 0), 0);
      }, 0);
    } catch (e) { amountOverdue = 0; }
  }

  // pick relevant lease for this unit
  const activeLower = String(LEASE_STATUSES.ACTIVE).toLowerCase();
  const relevant = leases.find(l => l.isDeleted !== true && ((l.status || l.lease_status || '').toString().toLowerCase() === activeLower)) || leases.find(l => l.isDeleted !== true) || leases[0];

  // compute lease info
  let leaseExpiration = 'Not Expiring';
  let leaseExpiration90 = 'Not Expiring';
  let rent = 0;
  if (relevant) {
    rent = (relevant.rentDetails && (relevant.rentDetails.amount || relevant.rentDetails.amount === 0) ? relevant.rentDetails.amount : (relevant.rent_amount || relevant.rentAmount || 0));
    const endDate = relevant.end_date || relevant.endDate || relevant.lease_end;
    const leaseType = relevant.lease_type || relevant.leaseType || relevant.type;
    if (leaseType && String(leaseType).toLowerCase().includes('month')) {
      leaseExpiration = 'Month-To-Month';
      leaseExpiration90 = 'Expiring'; // Month-to-month always shows as expiring for 90-day view
    } else if (endDate) {
      const end = DateUtil.toUTC(endDate);
      const now = ClockService.now();
      const diffDays = end ? DateUtil.diffDays(now, end) : 0;
      if (diffDays < 0) { leaseExpiration = 'Expired'; leaseExpiration90 = 'Expired'; }
      else {
        leaseExpiration = (diffDays <= 30) ? 'Expiring' : `${diffDays} days`;
        leaseExpiration90 = (diffDays <= 90) ? 'Expiring' : 'Not Expiring';
      }
    }
  }

  return { amountOverdue, leaseExpiration, leaseExpiration90, rent, leasesCount: leases.length };
}

/**
 * Compute maintenance counts for a property (open/closed). Returns { openMaintenance, closedMaintenance }
 */
async function computeMaintenanceCountsForProperty(property) {
  const propObjId = toObjectId(property._id);
  const maintColl = mongoose.connection.collection('maintenancerequests');
  let openMaintenance = 0; let closedMaintenance = 0;
  try {
    const maints = await maintColl.find({ property_id: propObjId, isDeleted: { $ne: true } }).toArray();
    const openStates = (MAINTENANCE_STATUS.OPEN || [MAINTENANCE_STATUS.SUBMITTED, MAINTENANCE_STATUS.INPROGRESS]).map(s => String(s).toLowerCase());
    const closedStates = [MAINTENANCE_STATUS.COMPLETED, MAINTENANCE_STATUS.CANCELLED, 'Closed'].map(s => String(s).toLowerCase());
    maints.forEach(m => {
      const status = (m.status || '').toString().toLowerCase();
      if (openStates.includes(status)) openMaintenance += 1;
      if (closedStates.includes(status)) closedMaintenance += 1;
    });
  } catch (e) { openMaintenance = 0; closedMaintenance = 0; }
  return { openMaintenance, closedMaintenance };
}

/**
 * Get tenants associated with a property through active leases
 */
async function getTenantsForProperty(propertyId) {
  const propObjId = toObjectId(propertyId);
  const leaseColl = mongoose.connection.collection('leases');
  const userColl = mongoose.connection.collection('users');
  
  try {
    // Only fetch ACTIVE leases for this property
    const activeLower = String(LEASE_STATUSES.ACTIVE).toLowerCase();
    const leases = await leaseColl.find({ 
      property_id: propObjId,
      isDeleted: { $ne: true },
      $expr: {
        $eq: [
          { $toLower: { $ifNull: ['$status', '$lease_status'] } },
          activeLower
        ]
      }
    }).toArray();
    
    if (!leases || leases.length === 0) return [];
    
    // Create a map of tenant IDs to their units
    const tenantUnitMap = {};
    const tenantIds = [];
    
    for (let i = 0; i < leases.length; i++) {
      const lease = leases[i];
      const unitName = lease.unit || lease.unitName || `Unit ${i + 1}`;
      
      if (lease.rentAndDepositDestribution && Array.isArray(lease.rentAndDepositDestribution.split)) {
        for (let j = 0; j < lease.rentAndDepositDestribution.split.length; j++) {
          const split = lease.rentAndDepositDestribution.split[j];
          if (split && split.tenantId) {
            try {
              if (mongoose.Types.ObjectId.isValid(split.tenantId)) {
                const tenantObjId = new mongoose.Types.ObjectId(split.tenantId);
                tenantIds.push(tenantObjId);
                // Store the unit for this tenant
                tenantUnitMap[tenantObjId.toString()] = unitName;
              }
            } catch (e) {
              logger.warn('Invalid tenantId:', split.tenantId);
            }
          }
        }
      }
    }
    
    if (tenantIds.length === 0) return [];
    
    const uniqueTenantIds = [...new Set(tenantIds.map(id => id.toString()))].map(id => new mongoose.Types.ObjectId(id));
    
    const tenants = await userColl.find({ 
      _id: { $in: uniqueTenantIds },
      isDeleted: { $ne: true }
    }, {
      projection: { _id: 1, firstName: 1, lastName: 1, email: 1, phone: 1 }
    }).toArray();
    
    return tenants.map(t => ({
      id: t._id,
      name: `${t.firstName || ''} ${t.lastName || ''}`.trim() || 'Unknown',
      email: t.email,
      phone: t.phone,
      unit: `Unit - ${tenantUnitMap[t._id.toString()] || 'Unknown Unit'}`
    }));
  } catch (e) {
    logger.error('Error fetching tenants for property:', e);
    return [];
  }
}

/**
 * Get tenants associated with a specific unit through active leases
 */
async function getTenantsForUnit(propertyId, unitName) {
  const propObjId = toObjectId(propertyId);
  const leaseColl = mongoose.connection.collection('leases');
  const userColl = mongoose.connection.collection('users');
  
  try {
    // Find active leases for this property and unit
    const leaseQuery = { 
      property_id: propObjId,
      isDeleted: { $ne: true }
    };
    
    if (unitName) {
      leaseQuery.unitName = { $regex: `^${escapeRegex(String(unitName))}$`, $options: 'i' };
    }
    
    const leases = await leaseColl.find(leaseQuery).toArray();
    
    if (!leases || leases.length === 0) return [];
    
    // Extract tenant IDs from lease splits
    const tenantIds = [];
    leases.forEach(lease => {
      if (lease.rentAndDepositDestribution && Array.isArray(lease.rentAndDepositDestribution.split)) {
        lease.rentAndDepositDestribution.split.forEach(split => {
          if (split.tenantId) {
            tenantIds.push(toObjectId(split.tenantId));
          }
        });
      }
    });
    
    if (tenantIds.length === 0) return [];
    
    // Get unique tenant IDs
    const uniqueTenantIds = [...new Set(tenantIds.map(id => id.toString()))].map(toObjectId);
    
    // Fetch tenant details (exclude password and other sensitive fields)
    const tenants = await userColl.find({ 
      _id: { $in: uniqueTenantIds },
      isDeleted: { $ne: true }
    }, {
      projection: {
        password: 0,
        __v: 0
      }
    }).toArray();
    
    return tenants.map(tenant => ({
      id: tenant._id,
      name: `${tenant.firstName || ''} ${tenant.lastName || ''}`.trim() || 'Unknown',
      email: tenant.email,
      phone: tenant.phone
    }));
  } catch (e) {
    return [];
  }
}

/**
 * Get properties with optional filters and pagination.
 * Supported query params (examples):
 * - page, pageSize / pagesize
 * - sortBy, order
 * - status (string) - 'all' means no status filter
 * - name, city, state, zip (string filters, case-insensitive, partial match)
 * - numberOfUnits (integer) - exact match against unitDetails.length
 * - hasOpenMaintenance (boolean) - true/false; applied only when `status` param is present
 * - rentStatus, maintenance, lease, search (existing computed filters)
 */
async function getPropertiesService(query) {
  const t0 = Date.now();
  const {
    pageNumber = 1,
    pageSize,
    sortBy,
    order = 'asc',
    status,
    rentStatus,
    maintenance,
    lease,
    search,
  } = query;

  const { numberOfUnits } = query;
  const hasOpenMaintenance = parseBoolean(query.hasOpenMaintenance);

  const filter = await buildPropertyListFilter(query);

  // Sanitize createdBy in filter to prevent NoSQL injection via buildPropertyListFilter
  if (filter.createdBy && typeof filter.createdBy === 'object' && !mongoose.Types.ObjectId.isValid(String(filter.createdBy))) {
    const err = new Error('createdBy must be a valid ObjectId'); err.status = 400; throw err;
  }

  let properties = await Property.find(filter, {
    _id: 1,
  createdBy: 1,
    name: 1,
    address: 1,
    unitDetails: 1,
    status: 1,
    notes: 1,
    isArchieved: 1,
    profileImageId: 1,
    images: 1
  }).lean();
  logger.info(`[PERF] Property query: ${Date.now() - t0}ms`);

  if (typeof numberOfUnits !== 'undefined') {
    const n = parseInt(numberOfUnits);
    if (!isNaN(n)) properties = properties.filter(p => Array.isArray(p.unitDetails) ? p.unitDetails.length === n : (n === 0));
  }

  const propertyIds = properties.map(p => toObjectId(p._id));
  
  if (propertyIds.length === 0) {
    return {
      total: 0,
      page: pageNumber,
      pagesize: pageSize || 10,
      data: [],
      portfolioOverview: { ...EMPTY_PORTFOLIO_OVERVIEW },
    };
  }
  
  const t1 = Date.now();
  const leaseColl = mongoose.connection.collection('leases');
  const incomeColl = mongoose.connection.collection('invoices');
  const maintColl = mongoose.connection.collection('maintenancerequests');
  const userColl = mongoose.connection.collection('users');
  const listingColl = mongoose.connection.collection('listings');

  const [allLeases, allMaintenanceRequests, allListings] = await Promise.all([
    leaseColl.find({ property_id: { $in: propertyIds }, isDeleted: { $ne: true } }, {
      projection: {
        _id: 1,
        property_id: 1,
        unitName: 1,
        status: 1,
        lease_status: 1,
        rentDetails: 1,
        rent_amount: 1,
        rentAmount: 1,
        end_date: 1,
        endDate: 1,
        lease_end: 1,
        lease_type: 1,
        leaseType: 1,
        type: 1,
        rentAndDepositDestribution: 1
      }
    }).toArray(),
    maintColl.find({ property_id: { $in: propertyIds }, isDeleted: { $ne: true } }, {
      projection: { _id: 1, property_id: 1, status: 1 }
    }).toArray(),
    listingColl.find({ propertyId: { $in: propertyIds }, status: { $in: BLOCKING_LISTING_STATUSES }, isDeleted: { $ne: true } }, {
      projection: { _id: 1, propertyId: 1, unitName: 1, unitId: 1, status: 1 }
    }).toArray()
  ]);
  logger.info(`[PERF] Bulk fetch: ${Date.now() - t1}ms`);

  const t2 = Date.now();
  const allLeaseIds = allLeases.map(l => l._id).filter(Boolean);
  const allInvoices = allLeaseIds.length > 0 ? await incomeColl.find({ 
    lease_id: { $in: allLeaseIds }, 
    status: INVOICE_STATUS.OVERDUE, 
    type: INVOICE_TYPES.RENT,
    isDeleted: { $ne: true }
  }, {
    projection: { _id: 1, lease_id: 1, invoiceItemDetails: 1 }
  }).toArray() : [];

  const tenantIds = new Set();
  for (let i = 0; i < allLeases.length; i++) {
    const lease = allLeases[i];
    if (lease.rentAndDepositDestribution && lease.rentAndDepositDestribution.split) {
      const splits = lease.rentAndDepositDestribution.split;
      for (let j = 0; j < splits.length; j++) {
        if (splits[j].tenantId) tenantIds.add(splits[j].tenantId.toString());
      }
    }
  }

  const allTenants = tenantIds.size > 0 ? await userColl.find({ 
    _id: { $in: Array.from(tenantIds).map(toObjectId) },
    isDeleted: { $ne: true }
  }, {
    projection: { _id: 1, firstName: 1, lastName: 1, email: 1, phone: 1 }
  }).toArray() : [];
  logger.info(`[PERF] Invoice/tenant fetch: ${Date.now() - t2}ms`);

  const t3 = Date.now();
  const leasesByProperty = {};
  const invoicesByLease = {};
  const maintenanceByProperty = {};
  const listingsByProperty = {};
  const tenantsById = {};

  const openStates = ['submitted', 'inprogress', 'open'];
  const closedStates = ['completed', 'cancelled', 'closed'];

  for (let i = 0; i < allLeases.length; i++) {
    const lease = allLeases[i];
    const propId = lease.property_id.toString();
    if (!leasesByProperty[propId]) leasesByProperty[propId] = [];
    leasesByProperty[propId].push(lease);
  }

  for (let i = 0; i < allInvoices.length; i++) {
    const invoice = allInvoices[i];
    const leaseId = invoice.lease_id.toString();
    if (!invoicesByLease[leaseId]) invoicesByLease[leaseId] = [];
    invoicesByLease[leaseId].push(invoice);
  }

  for (let i = 0; i < allMaintenanceRequests.length; i++) {
    const maint = allMaintenanceRequests[i];
    const propId = maint.property_id.toString();
    if (!maintenanceByProperty[propId]) maintenanceByProperty[propId] = { open: 0, closed: 0 };
    const status = (maint.status || '').toLowerCase();
    if (openStates.includes(status)) maintenanceByProperty[propId].open++;
    else if (closedStates.includes(status)) maintenanceByProperty[propId].closed++;
  }

  for (let i = 0; i < allListings.length; i++) {
    const listing = allListings[i];
    const propId = listing.propertyId.toString();
    if (!listingsByProperty[propId]) listingsByProperty[propId] = [];
    listingsByProperty[propId].push(listing);
  }

  for (let i = 0; i < allTenants.length; i++) {
    const tenant = allTenants[i];
    tenantsById[tenant._id.toString()] = tenant;
  }
  logger.info(`[PERF] Build lookup maps: ${Date.now() - t3}ms`);

  const t4 = Date.now();
  const entries = [];
  const activeLower = 'active';
  const approvedLower = 'approved';
  const now = Date.now();
  
  for (let pi = 0; pi < properties.length; pi++) {
    const p = properties[pi];
    const propId = p._id.toString();
    const unitDetails = p.unitDetails || [];
    const maintCounts = maintenanceByProperty[propId] || { open: 0, closed: 0 };
    const propertyLeases = leasesByProperty[propId] || [];
    const propertyListings = listingsByProperty[propId] || [];
    
    const units = [];
    let totalRent = 0;
    let totalAmountOverdue = 0;
    let occupiedUnits = 0;
    let expiringUnits = 0;
    
    if (unitDetails.length > 0) {
      for (let ui = 0; ui < unitDetails.length; ui++) {
        const ud = unitDetails[ui];
        const unitName = ud.unitName || '';
        const unitNameLower = unitName.toLowerCase();
        
        const unitLeases = [];
        for (let li = 0; li < propertyLeases.length; li++) {
          const l = propertyLeases[li];
          if (l.unitName && l.unitName.toLowerCase() === unitNameLower) {
            unitLeases.push(l);
          }
        }
        
        let unitAmountOverdue = 0;
        for (let li = 0; li < unitLeases.length; li++) {
          const lease = unitLeases[li];
          const leaseId = lease._id.toString();
          const leaseInvoices = invoicesByLease[leaseId] || [];
          for (let ii = 0; ii < leaseInvoices.length; ii++) {
            const inv = leaseInvoices[ii];
            const items = inv.invoiceItemDetails || [];
            for (let iti = 0; iti < items.length; iti++) {
              unitAmountOverdue += items[iti].balanceDue || 0;
            }
          }
        }
        
        // Find ACTIVE or APPROVED lease (not any lease, only ACTIVE or APPROVED status)
        let relevantLease = null;
        for (let li = 0; li < unitLeases.length; li++) {
          const l = unitLeases[li];
          const leaseStatusLower = (l.status || l.lease_status || '').toLowerCase();
          if (leaseStatusLower === activeLower || leaseStatusLower === approvedLower) {
            relevantLease = l;
            break;
          }
        }
        // Only use first lease if we have no active or approved lease (for calculations)
        if (!relevantLease && unitLeases.length > 0) relevantLease = unitLeases[0];
        
        let leaseExpiration = 'Not Expiring';
        let leaseExpiration90 = 'Not Expiring';
        let rent = 0;
        
        if (relevantLease) {
          rent = (relevantLease.rentDetails && relevantLease.rentDetails.amount != null) 
            ? relevantLease.rentDetails.amount 
            : (relevantLease.rent_amount || relevantLease.rentAmount || 0);
          
          const endDate = relevantLease.end_date || relevantLease.endDate || relevantLease.lease_end;
          const leaseType = relevantLease.lease_type || relevantLease.leaseType || relevantLease.type;
          
          if (leaseType && leaseType.toLowerCase().includes('month')) {
            leaseExpiration = 'Month-To-Month';
            leaseExpiration90 = 'Expiring';
          } else if (endDate) {
            const diffDays = DateUtil.diffDays(now, endDate);
            if (diffDays < 0) { 
              leaseExpiration = 'Expired'; 
              leaseExpiration90 = 'Expired'; 
            } else {
              leaseExpiration = (diffDays <= 30) ? 'Expiring' : `${diffDays} days`;
              leaseExpiration90 = (diffDays <= 90) ? 'Expiring' : 'Not Expiring';
            }
          }
        }
        
        const unitTenantIds = [];
        for (let li = 0; li < unitLeases.length; li++) {
          const lease = unitLeases[li];
          if (lease.rentAndDepositDestribution && lease.rentAndDepositDestribution.split) {
            const splits = lease.rentAndDepositDestribution.split;
            for (let si = 0; si < splits.length; si++) {
              if (splits[si].tenantId) unitTenantIds.push(splits[si].tenantId.toString());
            }
          }
        }
        
        const uniqueTenantIds = [...new Set(unitTenantIds)];
        const unitTenants = [];
        for (let ti = 0; ti < uniqueTenantIds.length; ti++) {
          const tenant = tenantsById[uniqueTenantIds[ti]];
          if (tenant) {
            unitTenants.push({
              id: tenant._id,
              name: `${tenant.firstName || ''} ${tenant.lastName || ''}`.trim() || 'Unknown',
              email: tenant.email,
              phone: tenant.phone
            });
          }
        }
        
        // A unit is OCCUPIED if it has an ACTIVE or APPROVED lease that hasn't expired
        const leaseStatusLower = relevantLease ? (relevantLease.status || relevantLease.lease_status || '').toLowerCase() : '';
        const hasActiveOrApprovedLease = relevantLease && (leaseStatusLower === activeLower || leaseStatusLower === approvedLower);
        const isOccupied = hasActiveOrApprovedLease && leaseExpiration !== 'Expired';
        if (isOccupied) occupiedUnits++;
        if (leaseExpiration90 === 'Expiring') expiringUnits++;
        
        totalRent += rent || 0;
        totalAmountOverdue += unitAmountOverdue || 0;
        
  // Only consider a unit as "having a lease" when there's an ACTIVE or APPROVED lease
  const unitHasLease = hasActiveOrApprovedLease;
        let unitHasListing = false;
        for (let li = 0; li < propertyListings.length; li++) {
          const listing = propertyListings[li];
          // Match by unitName (case-insensitive) or by unitId (ObjectId or string)
          const listingUnitName = listing.unitName ? listing.unitName.toLowerCase() : null;
          let listingUnitId = null;
          if (listing.unitId) {
            // Handle both ObjectId and string
            listingUnitId = typeof listing.unitId === 'object' && listing.unitId.toString ? listing.unitId.toString() : String(listing.unitId);
          }
          const unitIdStr = ud && ud._id ? (typeof ud._id === 'object' && ud._id.toString ? ud._id.toString() : String(ud._id)) : null;
          if ((listingUnitName && listingUnitName === unitNameLower) ||
              (listingUnitId && unitIdStr && listingUnitId === unitIdStr)) {
            unitHasListing = true;
            break;
          }
        }
        
        units.push({
          unitId: ud && ud._id ? String(ud._id) : null,
          unitName: unitName,
          rent: rent || 0,
          amountOverdue: unitAmountOverdue || 0,
          status: isOccupied ? 'Occupied' : 'Vacant',
          openMaintenance: 0,
          closedMaintenance: 0,
          leaseExpiration: leaseExpiration === 'Not Expiring' ? null : leaseExpiration,
          tenants: unitTenants,
          hasLease: unitHasLease,
          hasListing: unitHasListing,
          bedRooms: ud.bedRooms,
          bathRoom: ud.bathRoom,
          squareFeet: ud.squareFeet,
          unitType: ud.unitType,
          rentIncludes: ud.rentIncludes || [],
          amenities: ud.amenities || []
        });
      }
    } else {
      let unitAmountOverdue = 0;
      for (let li = 0; li < propertyLeases.length; li++) {
        const lease = propertyLeases[li];
        const leaseId = lease._id.toString();
        const leaseInvoices = invoicesByLease[leaseId] || [];
        for (let ii = 0; ii < leaseInvoices.length; ii++) {
          const inv = leaseInvoices[ii];
          const items = inv.invoiceItemDetails || [];
          for (let iti = 0; iti < items.length; iti++) {
            unitAmountOverdue += items[iti].balanceDue || 0;
          }
        }
      }
      
      let relevantLease = null;
      for (let li = 0; li < propertyLeases.length; li++) {
        const l = propertyLeases[li];
        const leaseStatusLower = (l.status || l.lease_status || '').toLowerCase();
        if (leaseStatusLower === activeLower || leaseStatusLower === approvedLower) {
          relevantLease = l;
          break;
        }
      }
      if (!relevantLease && propertyLeases.length > 0) relevantLease = propertyLeases[0];
      
      let leaseExpiration = 'Not Expiring';
      let leaseExpiration90 = 'Not Expiring';
      let rent = 0;
      
      if (relevantLease) {
        rent = (relevantLease.rentDetails && relevantLease.rentDetails.amount != null) 
          ? relevantLease.rentDetails.amount 
          : (relevantLease.rent_amount || relevantLease.rentAmount || 0);
        
        const endDate = relevantLease.end_date || relevantLease.endDate || relevantLease.lease_end;
        const leaseType = relevantLease.lease_type || relevantLease.leaseType || relevantLease.type;
        
        if (leaseType && leaseType.toLowerCase().includes('month')) {
          leaseExpiration = 'Month-To-Month';
          leaseExpiration90 = 'Expiring';
        } else if (endDate) {
          const diffDays = DateUtil.diffDays(now, endDate);
          if (diffDays < 0) { 
            leaseExpiration = 'Expired'; 
            leaseExpiration90 = 'Expired'; 
          } else {
            leaseExpiration = (diffDays <= 30) ? 'Expiring' : `${diffDays} days`;
            leaseExpiration90 = (diffDays <= 90) ? 'Expiring' : 'Not Expiring';
          }
        }
      }
      
      const propertyTenantIds = [];
      for (let li = 0; li < propertyLeases.length; li++) {
        const lease = propertyLeases[li];
        if (lease.rentAndDepositDestribution && lease.rentAndDepositDestribution.split) {
          const splits = lease.rentAndDepositDestribution.split;
          for (let si = 0; si < splits.length; si++) {
            if (splits[si].tenantId) propertyTenantIds.push(splits[si].tenantId.toString());
          }
        }
      }
      
      const uniqueTenantIds = [...new Set(propertyTenantIds)];
      const propertyTenants = [];
      for (let ti = 0; ti < uniqueTenantIds.length; ti++) {
        const tenant = tenantsById[uniqueTenantIds[ti]];
        if (tenant) {
          propertyTenants.push({
            id: tenant._id,
            name: `${tenant.firstName || ''} ${tenant.lastName || ''}`.trim() || 'Unknown',
            email: tenant.email,
            phone: tenant.phone
          });
        }
      }
      
      // A property is OCCUPIED if it has an ACTIVE or APPROVED lease that hasn't expired
      const leaseStatusLower = relevantLease ? (relevantLease.status || relevantLease.lease_status || '').toLowerCase() : '';
      const hasActiveOrApprovedLease = relevantLease && (leaseStatusLower === activeLower || leaseStatusLower === approvedLower);
      const isOccupied = hasActiveOrApprovedLease && leaseExpiration !== 'Expired';
      
      if (isOccupied) occupiedUnits++;
      if (leaseExpiration90 === 'Expiring') expiringUnits++;
      
      totalRent = rent || 0;
      totalAmountOverdue = unitAmountOverdue || 0;
      
  // Only consider a property as "having a lease" when there's an ACTIVE or APPROVED lease
  const propertyHasLease = hasActiveOrApprovedLease;
      const propertyHasListing = propertyListings.length > 0;
      
      units.push({
        unitId: (property && Array.isArray(property.unitDetails) && property.unitDetails[0] && property.unitDetails[0]._id)
          ? String(property.unitDetails[0]._id)
          : null,
        unitName: 'Unit 1',
        rent: rent || 0,
        amountOverdue: unitAmountOverdue || 0,
        status: isOccupied ? 'Occupied' : 'Vacant',
        openMaintenance: 0,
        closedMaintenance: 0,
        leaseExpiration: leaseExpiration === 'Not Expiring' ? null : leaseExpiration,
        tenants: propertyTenants,
        hasLease: propertyHasLease,
        hasListing: propertyHasListing
      });
    }
    
    const unitsCount = units.length;
    const openPerUnit = Math.floor(maintCounts.open / unitsCount);
    const closedPerUnit = Math.floor(maintCounts.closed / unitsCount);
    
    for (let ui = 0; ui < units.length; ui++) {
      units[ui].openMaintenance = openPerUnit + (ui < (maintCounts.open % unitsCount) ? 1 : 0);
      units[ui].closedMaintenance = closedPerUnit + (ui < (maintCounts.closed % unitsCount) ? 1 : 0);
    }
    
    let overallStatus = 'Vacant';
    if (occupiedUnits === units.length) {
      overallStatus = 'Fully Occupied';
    } else if (occupiedUnits > 0) {
      overallStatus = 'Partially Occupied';
    }
    
    let leaseExpiration90 = 'Not Expiring';
    
    let hasAnyLeases = false;
    for (let ui = 0; ui < units.length; ui++) {
      if (units[ui].leaseExpiration) {
        hasAnyLeases = true;
        break;
      }
    }
    
    if (!hasAnyLeases) {
      leaseExpiration90 = '-';
    } else {
      let hasActiveLease = false;
      for (let ui = 0; ui < units.length; ui++) {
        if (units[ui].tenants && units[ui].tenants.length > 0 && units[ui].leaseExpiration !== 'Expired') {
          hasActiveLease = true;
          break;
        }
      }
      
      if (hasActiveLease) {
        leaseExpiration90 = 'Active';
      } else {
        let hasExpiredLease = false;
        for (let ui = 0; ui < units.length; ui++) {
          if (units[ui].leaseExpiration === 'Expired') {
            hasExpiredLease = true;
            break;
          }
        }
        
        if (hasExpiredLease) {
          leaseExpiration90 = 'Expired';
        }
      }
    }
    
    let occupancyStatus = 'Vacant';
    if (units.length > 0) {
      // A property is occupied if at least one unit has an ACTIVE or APPROVED lease
      const hasAnyOccupiedUnit = units.some(u => u.status === 'Occupied');
      if (occupiedUnits === units.length) {
        occupancyStatus = 'Fully Occupied';
      } else if (hasAnyOccupiedUnit) {
        occupancyStatus = 'Partially Occupied';
      } else {
        occupancyStatus = 'Vacant';
      }
    } else {
      // For properties without unit details, check if there are active or approved leases
      let hasActiveOrApprovedLease = false;
      for (let li = 0; li < propertyLeases.length; li++) {
        const leaseStatusLower = (propertyLeases[li].status || propertyLeases[li].lease_status || '').toLowerCase();
        if (leaseStatusLower === activeLower || leaseStatusLower === approvedLower) {
          hasActiveOrApprovedLease = true;
          break;
        }
      }
      occupancyStatus = hasActiveOrApprovedLease ? 'Occupied' : 'Vacant';
    }

    entries.push({
      ...p,
      totalRent,
      totalAmountOverdue,
      totalOpenMaintenance: maintCounts.open,
      totalClosedMaintenance: maintCounts.closed,
      totalUnits: units.length,
      occupiedUnits,
      vacantUnits: units.length - occupiedUnits,
      overallStatus,
      leaseExpiration90,
      occupancyStatus,
      units
    });
  }
  logger.info(`[PERF] Process properties: ${Date.now() - t4}ms`);

  let filtered = entries;
  
  // Apply occupancyStatus filter (replaces old status filter)
  if (status) {
    const statusLower = status.toLowerCase();
    if (statusLower === 'vacant' || statusLower === 'occupied') {
      filtered = filtered.filter(f => (f.occupancyStatus || '').toLowerCase() === statusLower);
    }
  }
  
  for (let i = 0; i < filtered.length; i++) {
    const f = filtered[i];
    const propId = f._id.toString();
    const propertyListings = listingsByProperty[propId] || [];
    
    let allHaveLease = true;
    let anyHasListing = propertyListings.length > 0;
    
    for (let ui = 0; ui < f.units.length; ui++) {
      if (!f.units[ui].hasLease) allHaveLease = false;
    }
    
  f.hasLease = allHaveLease;
  // Do not set property-level hasListing; only set at unit level
  if (typeof f.hasListing !== 'undefined') delete f.hasListing;
  }
  if (rentStatus) {
    const isOverdue = rentStatus.toLowerCase() === 'overdue';
    const isOntime = rentStatus.toLowerCase() === 'ontime' || rentStatus.toLowerCase() === 'on time';
    if (isOverdue) filtered = filtered.filter(f => (f.totalAmountOverdue || 0) > 0);
    if (isOntime) filtered = filtered.filter(f => (f.totalAmountOverdue || 0) === 0);
  }
  if (maintenance) {
    const isOpen = maintenance.toLowerCase() === 'open';
    const isClosed = maintenance.toLowerCase() === 'closed';
    if (isOpen) filtered = filtered.filter(f => (f.totalOpenMaintenance || 0) > 0);
    if (isClosed) filtered = filtered.filter(f => (f.totalClosedMaintenance || 0) > 0);
  }
  if (hasOpenMaintenance !== null) {
    if (hasOpenMaintenance === true) filtered = filtered.filter(f => (f.totalOpenMaintenance || 0) > 0);
    if (hasOpenMaintenance === false) filtered = filtered.filter(f => (f.totalOpenMaintenance || 0) === 0);
  }
  if (lease) {
    const leaseLower = lease.toLowerCase();
    if (leaseLower === 'expiring') filtered = filtered.filter(f => (f.leaseExpiration90 || '').toLowerCase().includes('expiring'));
    if (leaseLower === 'not_expiring' || leaseLower === 'notexpiring') filtered = filtered.filter(f => (f.leaseExpiration90 || '').toLowerCase().includes('not expiring'));
    const days = parseInt(lease);
    if (!isNaN(days)) {
      filtered = filtered.filter(f => {
        const m = f.leaseExpiration90 && f.leaseExpiration90.toString().match(/(\d+) units/);
        return m && parseInt(m[1]) <= days;
      });
    }
  }
  if (sortBy) {
    const dir = order && order.toLowerCase() === 'desc' ? -1 : 1;
    filtered.sort((a, b) => {
      const va = a[sortBy];
      const vb = b[sortBy];
      if (va == null && vb == null) return 0;
      if (va == null) return -1 * dir;
      if (vb == null) return 1 * dir;
      if (typeof va === 'string') return va.localeCompare(vb) * dir;
      return (va - vb) * dir;
    });
  }

  const { offset, limit: effectiveLimit, page: pageNum, pageSize: pageSizeNum } = getPagination({ page: pageNumber, pageSize });

  const total = filtered.length;

  if (typeof pageSizeNum !== 'undefined' && pageSizeNum === 0) {
    return {
      total,
      page: pageNum,
      pagesize: 0,
      data: [],
      portfolioOverview: buildPortfolioOverviewFromEntries(filtered),
    };
  }

  const paged = effectiveLimit === 0 ? filtered : filtered.slice(offset, offset + effectiveLimit);

  const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
  const documentsService = require('../../../../../shared/modules/documents/service/documents.service');
  const metadataIds = new Set();
  paged.forEach((p) => {
    if (p.profileImageId) metadataIds.add(String(p.profileImageId));
  });
  const metadataById = new Map();
  if (metadataIds.size > 0) {
    const metadataRows = await DocumentMetadata.find({ _id: { $in: [...metadataIds] } })
      .select('key originalName contentType size')
      .lean();
    metadataRows.forEach((row) => metadataById.set(String(row._id), row));
  }

  const profileUrls = await Promise.all(
    paged.map(async (p) => {
      if (!p.profileImageId) return null;
      const metadata = metadataById.get(String(p.profileImageId));
      if (metadata) {
        try {
          return documentsService.getPresignedUrl(String(p.profileImageId), 3600);
        } catch (e) {
          return documentsService.buildPublicUrl(metadata);
        }
      }
      return getProfileImageUrl(p);
    })
  );

  const data = [];
  for (let i = 0; i < paged.length; i++) {
    const p = paged[i];
    const profileImageUrl = profileUrls[i];
    
    // Generate initials for property name
    const initials = generatePropertyInitials(p.name);

    data.push({
      id: p._id,
      name: p.name,
      address: formatAddress(p.address),
      totalRent: p.totalRent || 0,
      totalAmountOverdue: p.totalAmountOverdue || 0,
      leaseExpiration90: p.leaseExpiration90 || 'Not Expiring',
      overallStatus: p.overallStatus || 'Vacant',
      occupancyStatus: p.occupancyStatus || 'Vacant',
      totalOpenMaintenance: p.totalOpenMaintenance || 0,
      totalClosedMaintenance: p.totalClosedMaintenance || 0,
      totalUnits: p.totalUnits || 0,
      occupiedUnits: p.occupiedUnits || 0,
      vacantUnits: p.vacantUnits || 0,
      units: p.units || [],
      unitDetails: p.unitDetails || [],
  hasLease: p.hasLease || false,
  // Do not include property-level hasListing in response
      notes: p.notes || [],
      isArchived: p.isArchieved || false,
      profileImageUrl: profileImageUrl,
      initials: initials,
      images: [],
    });
  }
  
  logger.info(`[PERF] Total getPropertiesService: ${Date.now() - t0}ms`);

  return {
    total,
    page: pageNum,
    pagesize: effectiveLimit,
    data,
    portfolioOverview: buildPortfolioOverviewFromEntries(filtered),
  };
}

/**
 * build Portfolio Overview From Entries
 *
 * Performs logic operations for buildPortfolioOverviewFromEntries.
 *
 * @param entries - Request/input argument
 * @returns Operations result
 */
function buildPortfolioOverviewFromEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ...EMPTY_PORTFOLIO_OVERVIEW };
  }

  let totalUnits = 0;
  let occupiedUnits = 0;
  let vacantUnits = 0;
  let onTimeUnits = 0;
  let behindUnits = 0;

  for (const prop of entries) {
    totalUnits += prop.totalUnits || 0;
    occupiedUnits += prop.occupiedUnits || 0;
    vacantUnits += prop.vacantUnits || 0;
  }

  for (const prop of entries) {
    if ((prop.totalAmountOverdue || 0) > 0) {
      behindUnits += 1;
    } else {
      onTimeUnits += 1;
    }
  }

  return {
    totalUnits,
    occupiedUnits,
    vacantUnits,
    occupancyPercentage: totalUnits > 0 ? Math.round((occupiedUnits / totalUnits) * 100) : 0,
    onTimeUnits,
    behindUnits,
    rentPaymentPercentage: entries.length > 0 ? Math.round((onTimeUnits / entries.length) * 100) : 0,
  };
}

// Archive (soft-delete) a property by setting isArchieved = true
async function archivePropertyService(propertyId, options = {}) {
  if (!propertyId) {
    const err = new Error('propertyId is required');
    err.status = 400;
    throw err;
  }

  const doArchive = async (session) => {
    const findOpts = {};
    if (session) findOpts.session = session;
    const prop = await Property.findOne({ _id: propertyId, isDeleted: { $ne: true } }, null, findOpts);
    if (!prop) {
      const err = new Error('Property not found');
      err.status = 404;
      throw err;
    }
    prop.isArchieved = true;
    const saveOpts = {};
    if (session) saveOpts.session = session;
    const saved = await prop.save(saveOpts);
    return saved.toObject();
  };

  return runInTransaction(doArchive, options);
}

// Unarchive a property by setting isArchieved = false
async function unarchivePropertyService(propertyId, options = {}) {
  if (!propertyId) {
    const err = new Error('propertyId is required');
    err.status = 400;
    throw err;
  }

  const doUnarchive = async (session) => {
    const findOpts = {};
    if (session) findOpts.session = session;
    const prop = await Property.findOne({ _id: propertyId, isDeleted: { $ne: true } }, null, findOpts);
    if (!prop) {
      const err = new Error('Property not found');
      err.status = 404;
      throw err;
    }
    prop.isArchieved = false;
    const saveOpts = {};
    if (session) saveOpts.session = session;
    const saved = await prop.save(saveOpts);
    return saved.toObject();
  };

  return runInTransaction(doUnarchive, options);
}

// Add a note to a property, with file uploads
async function addNoteToPropertyService(propertyId, description, files = [], userId = null) {
  if (!propertyId) throw Object.assign(new Error('propertyId is required'), { status: 400 });
  if (!description || typeof description !== 'string') throw Object.assign(new Error('description is required'), { status: 400 });

  const allowedExts = ['.jpg', '.jpeg', '.png', '.pdf', '.doc', '.docx', '.txt', '.xlsx', '.xls'];
  const maxSize = 20 * 1024 * 1024;
  const path = require('path');
  const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
  const s3Client = require('../../../../../integrations/s3');
  const config = require('../../../../../config/default');
  const notesSubdir = require('../../../../../common/constants/uploads').UPLOAD_PROPERTY_SUBDIR || 'property-notes';
  const rollbackTracker = [];
  const s3Uploads = [];

  try {
    for (const f of files) {
      const ext = path.extname(f.originalname || f.filename || '').toLowerCase();
      if (!allowedExts.includes(ext)) {
        throw Object.assign(new Error(`File extension ${ext} not allowed`), { status: 400 });
      }
      if (f.size > maxSize) {
        throw Object.assign(new Error(`File ${f.originalname || f.filename} exceeds max size 20MB`), { status: 400 });
      }

      const key = s3Client.getKeyForProperty
        ? s3Client.getKeyForProperty(propertyId, f.originalname || f.filename, userId)
        : `${notesSubdir}/${propertyId}/${Date.now()}_${f.originalname || f.filename}`;
      const result = await s3Client.upload({ localFilePath: f.path, key });
      const s3Key = result.Key || key;
      rollbackTracker.push({ key: s3Key, metadataId: null });
      s3Uploads.push({
        key: s3Key,
        bucketName: config.s3 && config.s3.bucket ? config.s3.bucket : (process.env.S3_BUCKET || 'mock-bucket'),
        region: config.s3 && config.s3.region ? config.s3.region : (process.env.AWS_REGION || 'mock-region'),
        size: f.size || 0,
        contentType: f.mimetype || 'application/octet-stream',
        originalName: f.originalname || f.filename,
        s3Location: result.Location || (s3Client.baseUrl ? `${s3Client.baseUrl}/${key}` : `/${key}`),
      });
    }

    const prop = await runInTransaction(async (session) => {
      const uploadedMetaIds = [];
      for (let i = 0; i < s3Uploads.length; i++) {
        const upload = s3Uploads[i];
        const metadataDoc = session
          ? (await DocumentMetadata.create([upload], { session }))[0]
          : await DocumentMetadata.create(upload);
        if (rollbackTracker[i]) rollbackTracker[i].metadataId = metadataDoc._id;
        uploadedMetaIds.push(metadataDoc._id);
      }

      const propertyQuery = Property.findOne({ _id: propertyId, isDeleted: { $ne: true } });
      const property = await applySession(propertyQuery, session);
      if (!property) {
        throw Object.assign(new Error('Property not found'), { status: 404 });
      }

      property.notes = property.notes || [];
      property.notes.push({ description, attachments: uploadedMetaIds });
      property.images = property.images || [];
      for (const metaId of uploadedMetaIds) {
        if (metaId) property.images.push({ metadataId: metaId });
      }
      property.images = property.images.filter((img) => img && img.metadataId);

      const saveOpts = session ? { session } : {};
      await property.save(saveOpts);
      return property;
    });

    cleanupTempFiles(files);
    return prop;
  } catch (err) {
    await cleanupUploadedAssets(rollbackTracker);
    cleanupTempFiles(files);
    throw err;
  }
}

// CSV import: focus only on core fields now but keep extensible
/**
 * Import properties from CSV.
 * Accepts either:
 *  - filePath: string path to a local file
 *  - fileObj: multer file object (has `path` when stored to disk, or `buffer` when using memoryStorage)
 *
 * This makes the service flexible so controllers can pass the multer file directly.
 */
// Simple but reasonably safe CSV parser that supports quoted fields and escaped quotes ("" -> ")
function parseCsvWithSimpleSplit(content) {
  if (!content) return { header: [], rows: [] };
  // Normalize line endings and split lines, ignore empty lines
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim() !== '');
  if (lines.length === 0) return { header: [], rows: [] };

  // Parse a single CSV line into fields
  function parseLine(line) {
    const fields = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        // handle escaped quotes
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === ',' && !inQuotes) {
        fields.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    fields.push(cur);
    return fields;
  }

  const headerFields = parseLine(lines[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parsed = parseLine(lines[i]);
    const obj = {};
    for (let j = 0; j < headerFields.length; j++) {
      const key = headerFields[j] || `col${j}`;
      obj[key] = (typeof parsed[j] === 'undefined') ? '' : parsed[j].trim();
    }
    rows.push(obj);
  }

  return { header: headerFields, rows };
}

async function importPropertiesFromCsv(fileObj, createdBy, options = {}) {
  const fs = require('fs');

  // fileObj must be the multer file object (memory buffer or stream). We intentionally
  // require an object input because callers will POST multipart/form-data.
  if (!fileObj || typeof fileObj !== 'object') throw Object.assign(new Error('file (multer file object) is required'), { status: 400 });
  const ownerId = requireCreatedBy(createdBy);

  let content;
  try {
    // Preferred: multer memoryStorage provides `buffer`
    if (fileObj.buffer && Buffer.isBuffer(fileObj.buffer)) {
      content = fileObj.buffer.toString('utf8');
    } else if (fileObj.stream && typeof fileObj.stream.read === 'function') {
      content = await new Promise((resolve, reject) => {
        let data = '';
        fileObj.stream.setEncoding('utf8');
        fileObj.stream.on('data', (chunk) => { data += chunk; });
        fileObj.stream.on('end', () => resolve(data));
        fileObj.stream.on('error', (err) => reject(err));
      });
    } else if (fileObj.path) {
      content = fs.readFileSync(sanitizeFilePath(fileObj.path), 'utf8');
    } else {
      throw new Error('Unsupported file object: expected multer file with buffer, stream, or path');
    }
  } catch (e) {
    throw Object.assign(new Error('Failed to read uploaded file: ' + (e && e.message ? e.message : String(e))), { status: 400 });
  }

  const { header, rows } = parseCsvWithSimpleSplit(content);
  if (!header || rows.length === 0) return { totalRows: 0, created: [], failed: [] };

  const created = [];
  const failed = [];

  for (let i = 0; i < rows.length; i++) {
    const csvRow = rows[i];
    // Map only allowed core fields; collect others into additionalFields for future use
    const propertyData = mapCsvRowToCorePropertyData(csvRow);
    propertyData.createdBy = ownerId;
    propertyData.sourcePortal = normalizeLandlordSourcePortal(options.sourcePortal);

    try {
      const createdProp = await createPropertyService(propertyData);
      created.push({ row: i + 1, property: createdProp });
    } catch (e) {
      failed.push({ row: i + 1, error: e && e.message ? e.message : String(e) });
    }
  }

  if (fileObj.path) {
    try {
      fs.unlinkSync(fileObj.path);
    } catch (ignore) {
      /* ignore */
    }
  }

  return { totalRows: rows.length, created, failed };
}

/**
 * Map CSV row to core property payload. Only maps the following fields when present:
 * - name
 * - type
 * - address: street, city, state, country, zip
 * - contactName
 * - contactEmail
 * - contactPhone
 * Any other columns are preserved under `additionalFields` to make the importer extensible.
 */
function mapCsvRowToCorePropertyData(row) {
  const r = row || {};
  const propertyData = {};

  // core fields (per your request)
  propertyData.name = r.name || r.propertyName || r.property_name || '';
  // Support both 'propertyType' (new) and legacy 'type' CSV headers
  propertyData.propertyType = r.propertyType || r.property_type || r.type || '';
  // keep legacy field for backward compatibility inside service
  propertyData.type = propertyData.propertyType;
  propertyData.address = {
    street: r.street || r['street'] || r.address_street || r['address.street'] || r.address || '',
    city: r.city || r['city'] || r.address_city || r['address.city'] || '',
    state: r.state || r['state'] || r.address_state || r['address.state'] || '',
    zip: r.zip || r['zip'] || r.address_zip || r['address.zip'] || '',
    country: r.country || r['country'] || r.address_country || r['address.country'] || '',
  };
  propertyData.ownerName = r.ownerName || r.owner_name || r.contactName || r.contact_name || r.contact || '';
  propertyData.ownerEmail = r.ownerEmail || r.owner_email || r.contactEmail || r.contact_email || r.email || '';
  propertyData.ownerPhone = r.ownerPhone || r.owner_phone || r.contactPhone || r.contact_phone || r.phone || '';
  // new fields supported by schema
  propertyData.description = r.description || r.propertyDescription || r.property_description || '';
  propertyData.ownershipType = r.ownershipType || r.ownership_type || '';
  propertyData.propertyManager = r.propertyManager || r.property_manager || '';

  // Additional columns preserved for future mapping/extensions
  const additionalFields = {};
  for (const k of Object.keys(r)) {
    const lk = (k || '').toString().toLowerCase();
    // treat any 'address.' or 'address_' prefixed keys and contact/name/type as core
    if (lk === 'name' || lk === 'type' || lk.startsWith('address.') || lk.startsWith('address_') || ['street','city','state','zip','country','ownername','owneremail','ownerphone','contactname','contactemail','contactphone','contact','email','phone'].includes(lk)) {
      continue;
    }
    additionalFields[k] = r[k];
  }
  if (Object.keys(additionalFields).length > 0) propertyData.additionalFields = additionalFields;

  // Note: createPropertyService requires unitDetails and other fields; importer will
  // let createPropertyService validate and reject rows that are missing required fields.
  // Provide a minimal default unitDetails so CSVs that don't include unit info can still create a property.
  if (!Array.isArray(propertyData.unitDetails) || propertyData.unitDetails.length === 0) {
    propertyData.unitDetails = [{ unitName: 'Unit 1', unitType: 'Other', squareFeet: 0, rentIncludes: [] }];
  }
  return propertyData;
}



// Delete property service (soft delete)
async function deletePropertyService(propertyId, options = {}) {
  if (!propertyId) {
    const err = new Error('propertyId is required');
    err.status = 400;
    throw err;
  }
  // perform soft delete within a transaction managed by the service unless caller provided a session
  const runDelete = async (session) => {
    const opts = {};
    if (session) opts.session = session;
    const property = await Property.findOne({ _id: propertyId, isDeleted: { $ne: true } }, null, opts);
    if (!property) {
      const err = new Error('Property not found');
      err.status = 404;
      throw err;
    }
    property.isDeleted = true;
    property.deletedAt = ClockService.now();
    const saveOpts = {};
    if (session) saveOpts.session = session;
    const saved = await property.save(saveOpts);
    return saved.toObject();
  };

  return runInTransaction(runDelete, options);
}

// Update existing property service
async function updatePropertyService(propertyId, propertyData, createdBy, options = {}) {
  const ownerId = requireCreatedBy(resolveCreatedBy(propertyData, createdBy));
  const visibilityFilter = await buildLandlordPropertyVisibilityFilter(ownerId, options.sourcePortal);

  // For updates, only validate fields that are provided
  const errors = [];
  
  // Only validate address if it's provided
  if (propertyData.address) {
    const address = propertyData.address;
    const requiredAddressFields = ['street', 'city', 'state', 'zip', 'country'];
    requiredAddressFields.forEach((f) => {
      if (!address[f]) errors.push(`Address field '${f}' is required`);
    });
  }
  // For updates: validate unitDetails only when provided in the payload
  if (typeof propertyData.unitDetails !== 'undefined') {
    if (!Array.isArray(propertyData.unitDetails) || propertyData.unitDetails.length < 1) {
      errors.push('At least one unit is required in unitDetails');
    } else {
      propertyData.unitDetails.forEach((u, idx) => {
        if (!u || typeof u !== 'object') {
          errors.push(`unitDetails[${idx}] must be an object`);
          return;
        }
        if (!u.unitName) errors.push(`unitDetails[${idx}].unitName is required`);
        if (!u.unitType) errors.push(`unitDetails[${idx}].unitType is required`);
        if (u.rentIncludes && !Array.isArray(u.rentIncludes)) errors.push(`unitDetails[${idx}].rentIncludes must be an array`);
        // if unitType indicates residential, enforce additional residential fields
        const ut = (u.unitType || '').toString().toLowerCase();
        const isResidential = ut && ut.includes('resid');
        if (isResidential) {
          if (typeof u.bedRooms === 'undefined' || u.bedRooms === null || u.bedRooms < 1) errors.push(`unitDetails[${idx}].bedRooms is required for residential units and must be at least 1`);
          if (typeof u.bathRoom === 'undefined' || u.bathRoom === null) errors.push(`unitDetails[${idx}].bathRoom is required for residential units`);
          // Keep amenities optional for residential units (matches create validator behavior).
        }
        // squareFeet is required for all unit types
        if (typeof u.squareFeet === 'undefined' || u.squareFeet === null) errors.push(`unitDetails[${idx}].squareFeet is required`);
      });
    }
  }

  if (errors.length > 0) {
    const err = new Error(errors.join('; '));
    err.status = 400;
    throw err;
  }

  // core update logic extracted to allow transactional wrapper
  const doUpdate = async (session) => {
    const findOpts = {};
    if (session) findOpts.session = session;
    const prop = await Property.findOne({
      _id: propertyId,
      ...visibilityFilter,
      isDeleted: { $ne: true },
    }, null, findOpts);
    if (!prop) {
      const err = new Error('Property not found for this user');
      err.status = 404;
      throw err;
    }

    // ensure unique name per creator (if name changed, excluding deleted/archived properties)
    if (typeof propertyData.name !== 'undefined' && prop.name !== propertyData.name) {
      const existing = await applySession(
        Property.findOne({
          name: propertyData.name,
          ...visibilityFilter,
          isDeleted: { $ne: true },
          isArchieved: { $ne: true },
          _id: { $ne: propertyId },
        }),
        session
      );
      if (existing) {
        const err = new Error('Property name must be unique per user');
        err.status = 409;
        throw err;
      }
    }

  // update fields only if provided
  if (typeof propertyData.name !== 'undefined') prop.name = propertyData.name;
  // persist both new and legacy fields for compatibility
  if (propertyData.propertyType || propertyData.type) {
    prop.propertyType = propertyData.propertyType || propertyData.type;
    prop.type = propertyData.type || propertyData.propertyType;
  }
  if (typeof propertyData.description !== 'undefined') prop.description = propertyData.description;
  if (typeof propertyData.ownershipType !== 'undefined') prop.ownershipType = propertyData.ownershipType;
  if (typeof propertyData.imageMode !== 'undefined') prop.imageMode = propertyData.imageMode;
  if (typeof propertyData.propertyManager !== 'undefined') prop.propertyManager = propertyData.propertyManager;
  if (propertyData.address) {
    const address = propertyData.address;
    prop.address = {
      street: address.street,
      addressLine2: typeof address.addressLine2 !== 'undefined' ? address.addressLine2 : address.line2,
      city: address.city,
      state: address.state,
      zip: address.zip,
      country: address.country,
    };
  }
  const billingTzFields = resolvePropertyBillingTimezoneFields(propertyData, prop.toObject ? prop.toObject() : prop);
  if (
    typeof propertyData.billingTimezone !== 'undefined'
    || propertyData.address
    || !prop.billingTimezone
  ) {
    prop.billingTimezone = billingTzFields.billingTimezone;
    prop.billingTimezoneSource = billingTzFields.billingTimezoneSource;
  }
  // owner fields - only update if provided
  if (typeof propertyData.ownerName !== 'undefined') prop.ownerName = propertyData.ownerName;
  if (typeof propertyData.ownerEmail !== 'undefined') prop.ownerEmail = propertyData.ownerEmail;
  if (typeof propertyData.ownerPhone !== 'undefined') prop.ownerPhone = propertyData.ownerPhone;
  if (typeof propertyData.ownerType !== 'undefined') prop.ownerType = propertyData.ownerType;
  // jointOwners: replace only if provided in update payload
  if (typeof propertyData.jointOwners !== 'undefined') {
    prop.jointOwners = Array.isArray(propertyData.jointOwners) ? propertyData.jointOwners : [];
  }
    // 'units' field removed from schema; do not set it here.
    if (typeof propertyData.amenities !== 'undefined') {
      prop.amenities = Array.isArray(propertyData.amenities) ? propertyData.amenities : [];
    }
    // tags: replace only if provided in update payload
    if (typeof propertyData.tags !== 'undefined') {
      prop.tags = Array.isArray(propertyData.tags) ? propertyData.tags : [];
    }
    // unitDetails: replace only if provided in update payload
    // CRITICAL: Preserve existing _id for each unit to maintain lease references
    if (typeof propertyData.unitDetails !== 'undefined') {
      const incomingUnits = Array.isArray(propertyData.unitDetails) ? propertyData.unitDetails : [];
      const existingUnits = prop.unitDetails || [];
      
      // Map existing units by unitName for quick lookup
      const existingUnitsMap = {};
      for (let i = 0; i < existingUnits.length; i++) {
        const unit = existingUnits[i];
        if (unit && unit.unitName) {
          existingUnitsMap[unit.unitName.toLowerCase()] = unit;
        }
      }
      
      // Preserve _id for matching units, assign new for new units
      const updatedUnits = [];
      for (let i = 0; i < incomingUnits.length; i++) {
        const incomingUnit = incomingUnits[i];
        if (!incomingUnit || !incomingUnit.unitName) continue;
        
        const unitNameLower = incomingUnit.unitName.toLowerCase();
        const existingUnit = existingUnitsMap[unitNameLower];
        
        // If unit exists, preserve its _id; otherwise MongoDB will auto-generate
        if (existingUnit && existingUnit._id) {
          updatedUnits.push({
            ...incomingUnit,
            _id: existingUnit._id,
            images: existingUnit.images || incomingUnit.images || [],
          });
        } else {
          updatedUnits.push(incomingUnit);
        }
      }
      
      prop.unitDetails = updatedUnits;
    }
    // propertySettings: replace only if provided in update payload.
    // Keep full payload as-is to avoid dropping unknown bank-account fields.
    if (typeof propertyData.propertySettings !== 'undefined') {
      const enrichedSettings = await enrichPropertySettingsPaymentBanks(
        propertyData.propertySettings,
        ownerId
      );
      prop.propertySettings = mergeBankAccountFields(
        { ...propertyData, propertySettings: enrichedSettings },
        prop.propertySettings || {},
        prop.unitDetails || []
      );
    }
    if (typeof propertyData.startingBalance !== 'undefined') prop.startingBalance = propertyData.startingBalance ?? 0;
    if (typeof propertyData.balanceAsOf !== 'undefined') prop.balanceAsOf = propertyData.balanceAsOf || null;
    if (typeof propertyData.monthlyRecurringFee !== 'undefined') prop.monthlyRecurringFee = propertyData.monthlyRecurringFee ?? 0;
    if (typeof propertyData.paymentTerm !== 'undefined') prop.paymentTerm = propertyData.paymentTerm ?? 12;
    if (typeof propertyData.associatedOwnerIds !== 'undefined') {
      prop.associatedOwnerIds = Array.isArray(propertyData.associatedOwnerIds) ? propertyData.associatedOwnerIds : [];
    }
    if (typeof propertyData.emergencyContact !== 'undefined') prop.emergencyContact = propertyData.emergencyContact || {};
    if (typeof propertyData.isDeleted !== 'undefined') prop.isDeleted = propertyData.isDeleted ?? false;
    if (typeof propertyData.deletedAt !== 'undefined') prop.deletedAt = propertyData.deletedAt || null;
    const saveOpts = {};
    if (session) saveOpts.session = session;
    const saved = await prop.save(saveOpts);
    return saved.toObject();
  };

  return runInTransaction(doUpdate, options);
}

// Create property service
async function createPropertyService(propertyData, options = {}) {
  const ownerId = requireCreatedBy(propertyData);

  // Enrich linked payment bank accounts before merge/normalize.
  if (propertyData.propertySettings) {
    propertyData = {
      ...propertyData,
      propertySettings: await enrichPropertySettingsPaymentBanks(propertyData.propertySettings, ownerId),
    };
  }

  // Input-shape validation (required fields, address format, unitDetails structure,
  // contact format) is handled by Joi middleware attached to routes. Service focuses
  // on business rules: uniqueness, transactional persistence and DB checks.
  const address = propertyData.address || {};
  const sourcePortal = normalizeLandlordSourcePortal(propertyData.sourcePortal);

  // core create logic extracted so service can manage transactions when needed
  const doCreate = async (session) => {
    const existing = await applySession(
      Property.findOne({
        ...(await buildLandlordPropertyVisibilityFilter(ownerId, sourcePortal)),
        name: String(propertyData.name || '').trim(),
        isDeleted: { $ne: true },
        isArchieved: { $ne: true },
      }),
      session
    );
    if (existing) {
      const err = new Error('Property name must be unique per user');
      err.status = 409;
      throw err;
    }

    // construct and save
    const billingTzFields = resolvePropertyBillingTimezoneFields(propertyData);
    const prop = new Property({
      createdBy: ownerId,
      sourcePortal,
      name: propertyData.name,
      // include both new and legacy fields
      propertyType: propertyData.propertyType || propertyData.type,
      type: propertyData.type || propertyData.propertyType,
      description: propertyData.description,
      ownershipType: propertyData.ownershipType,
      imageMode: propertyData.imageMode || 'shared',
      propertyManager: propertyData.propertyManager,
      hasHOA: propertyData.hasHOA ?? false,
      address: {
        street: address.street,
        addressLine2: typeof address.addressLine2 !== 'undefined' ? address.addressLine2 : address.line2,
        city: address.city,
        state: address.state,
        zip: address.zip,
        country: address.country,
      },
      billingTimezone: billingTzFields.billingTimezone,
      billingTimezoneSource: billingTzFields.billingTimezoneSource,
      amenities: Array.isArray(propertyData.amenities) ? propertyData.amenities : [],
      tags: Array.isArray(propertyData.tags) ? propertyData.tags : [],
      unitDetails: Array.isArray(propertyData.unitDetails) ? propertyData.unitDetails : [],
      propertySettings: mergeBankAccountFields(propertyData, {}),
      ownerName: propertyData.ownerName,
      ownerEmail: propertyData.ownerEmail,
      ownerPhone: propertyData.ownerPhone,
      ownerType: propertyData.ownerType || propertyData.ownershipType,
      jointOwners: Array.isArray(propertyData.jointOwners) ? propertyData.jointOwners : [],
      startingBalance: propertyData.startingBalance ?? 0,
      balanceAsOf: propertyData.balanceAsOf || null,
      monthlyRecurringFee: propertyData.monthlyRecurringFee ?? 0,
      paymentTerm: propertyData.paymentTerm ?? 12,
      associatedOwnerIds: Array.isArray(propertyData.associatedOwnerIds) ? propertyData.associatedOwnerIds : [],
      emergencyContact: propertyData.emergencyContact || {},
      isDeleted: propertyData.isDeleted ?? false,
      deletedAt: propertyData.deletedAt || null,
    });
    if (session) {
      const docs = await Property.create([prop], { session });
      return docs[0].toObject({ virtuals: false });
    }

    const saved = await prop.save();
    return saved.toObject({ virtuals: false });
  };

  return runInTransaction(doCreate, options);
}

async function computeStatsForProperty(property) {
  const propId = property._id;
  const propObjId = toObjectId(propId);

  // Collections (use lowercase plural names as commonly stored)
  const leaseColl = mongoose.connection.collection('leases');
  const incomeColl = mongoose.connection.collection('invoices');
  const maintColl = mongoose.connection.collection('maintenancerequests');

  // Helper: fetch leases for a property
  async function fetchLeases() {
    try {
      return await leaseColl.find({ property_id: propObjId, isDeleted: { $ne: true } }).toArray();
    } catch (e) {
      return [];
    }
  }

  // Helper: compute amount overdue using income records
  async function computeAmountOverdue(leases) {
    const leaseIds = (leases || []).map(l => l._id || l.id).map(toObjectId).filter(Boolean);
    if (leaseIds.length === 0) return 0;
    try {
      const overdueIncomes = await incomeColl.find({ lease_id: { $in: leaseIds }, status: INCOME_STATUS.OVERDUE, type: INCOME_TYPES.RENT, isDeleted: { $ne: true } }).toArray();
      return overdueIncomes.reduce((s, inc) => {
        const items = inc.invoiceItemDetails || [];
        return s + items.reduce((sum, item) => sum + (item.balanceDue || 0), 0);
      }, 0);
    } catch (e) {
      return 0;
    }
  }

  // Helper: pick the most relevant lease (prefers ACTIVE lease)
  function pickRelevantLease(leases) {
    if (!leases || leases.length === 0) return null;
    const activeLower = String(LEASE_STATUSES.ACTIVE).toLowerCase();
    const active = leases.find(l => l.isDeleted !== true && ((l.status || l.lease_status || '').toString().toLowerCase() === activeLower));
    return active || leases.find(l => l.isDeleted !== true) || leases[0];
  }

  // Helper: compute lease expiration strings and rent from a lease
  function computeLeaseInfo(lease) {
    let leaseExpiration = 'Not Expiring';
    let leaseExpiration90 = 'Not Expiring';
    let rent = 0;
    if (!lease) return { leaseExpiration, leaseExpiration90, rent };

    rent = (lease.rentDetails && (lease.rentDetails.amount || lease.rentDetails.amount === 0) ? lease.rentDetails.amount : (lease.rent_amount || lease.rentAmount || 0));
    const endDate = lease.end_date || lease.endDate || lease.lease_end;
    const leaseType = lease.lease_type || lease.leaseType || lease.type;

    // If lease_type explicitly indicates month-to-month, honor it
    if (leaseType && String(leaseType).toLowerCase().includes('month')) {
      leaseExpiration = 'Month-To-Month';
      leaseExpiration90 = 'Expiring'; // Month-to-month always shows as expiring for 90-day view
      return { leaseExpiration, leaseExpiration90, rent };
    }

    if (endDate) {
      const diffDays = DateUtil.diffDays(ClockService.now(), endDate);
      if (diffDays < 0) {
        leaseExpiration = 'Expired';
        leaseExpiration90 = 'Expired';
      } else {
        if (diffDays <= 30) leaseExpiration = 'Expiring';
        else leaseExpiration = `${diffDays} days`;

        leaseExpiration90 = (diffDays <= 90) ? 'Expiring' : 'Not Expiring';
      }
      return { leaseExpiration, leaseExpiration90, rent };
    }

    // Fallback when neither lease_type nor endDate present: treat as Not Expiring
    return { leaseExpiration, leaseExpiration90, rent };
  }

  // Helper: compute maintenance counts
  async function computeMaintenanceCounts() {
    let openMaintenance = 0;
    let closedMaintenance = 0;
    try {
      const maints = await maintColl.find({ property_id: propObjId, isDeleted: { $ne: true } }).toArray();
      const openStates = (MAINTENANCE_STATUS.OPEN || [MAINTENANCE_STATUS.SUBMITTED, MAINTENANCE_STATUS.INPROGRESS]).map(s => String(s).toLowerCase());
      const closedStates = [MAINTENANCE_STATUS.COMPLETED, MAINTENANCE_STATUS.CANCELLED, 'Closed'].map(s => String(s).toLowerCase());
      maints.forEach(m => {
        const status = (m.status || '').toString().toLowerCase();
        if (openStates.includes(status)) openMaintenance += 1;
        if (closedStates.includes(status)) closedMaintenance += 1;
      });
    } catch (e) {
      openMaintenance = 0;
      closedMaintenance = 0;
    }
    return { openMaintenance, closedMaintenance };
  }

  // Compose computations
  const leases = await fetchLeases();
  const amountOverdue = await computeAmountOverdue(leases);
  const relevantLease = pickRelevantLease(leases);
  const { leaseExpiration, leaseExpiration90, rent } = computeLeaseInfo(relevantLease);
  const { openMaintenance, closedMaintenance } = await computeMaintenanceCounts();

  return {
    amountOverdue,
    leaseExpiration,
    leaseExpiration90,
    rent,
    openMaintenance,
    closedMaintenance,
  };
}

// Helper to safely convert possible string id to ObjectId
function toObjectId(id) {
  const str = String(id && typeof id === 'object' && id._id ? id._id : id ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function sanitizeFilePath(filePath) {
  const resolved = path.resolve(filePath);
  const tmpDir = path.resolve(os.tmpdir());
  if (!resolved.startsWith(tmpDir) && !resolved.startsWith('/tmp') && !resolved.startsWith('/var/folders')) {
    const err = new Error('Invalid file path'); err.status = 400; throw err;
  }
  return resolved;
}

// Get property by id with computed stats and normalized fields
async function getPropertyByIdService(id) {
  if (!id) {
    const err = new Error('propertyId is required');
    err.status = 400;
    throw err;
  }

  const idOid = toObjectId(id);
  if (!idOid) { const err = new Error('propertyId must be a valid ObjectId'); err.status = 400; throw err; }
  const prop = await Property.findOne({ _id: idOid, isDeleted: { $ne: true } }).lean();
  if (!prop) {
    const err = new Error('Property not found');
    err.status = 404;
    throw err;
  }

  const stats = await computeStatsForProperty(prop);
  const leaseColl = mongoose.connection.collection('leases');
  const propObjId = toObjectId(prop._id);
  let propertyLeases = [];
  try {
    propertyLeases = await leaseColl.find({ property_id: propObjId, isDeleted: { $ne: true } }).toArray();
  } catch (e) {
    propertyLeases = [];
  }
  const activeLower = String(LEASE_STATUSES.ACTIVE).toLowerCase();
  const isOccupied = propertyLeases.some((l) => {
    const leaseStatusLower = (l.status || l.lease_status || '').toString().toLowerCase();
    return leaseStatusLower === activeLower || leaseStatusLower === 'approved' || leaseStatusLower === 'signed';
  });
  const leaseExpirationNormalized = isOccupied ? (stats.leaseExpiration || 'Not Expiring') : '-';
  
  // Get tenants associated with this property
  const tenants = await getTenantsForProperty(prop._id);
  
  // Get upcoming and past/overdue invoices for this property
  const invoiceData = await getInvoicesForProperty(prop._id);
  
  // Get unit-specific lease details
  const unitLeases = await getUnitLeasesForProperty(prop._id, prop.unitDetails);
  
  // Get latest 3 open maintenance requests
  const openMaintenanceRequests = await getOpenMaintenanceRequests(prop._id);
  
  // Get profile image URL if available
  let profileImageUrl = null;
  if (prop.profileImageId) {
    profileImageUrl = await getProfileImageUrl(prop);
  }
  
  // Generate initials for property name
  const initials = generatePropertyInitials(prop.name);
  
  // Get presigned URLs for all images
  const imagesWithUrls = [];
  const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
  const documentsService = require('../../../../../shared/modules/documents/service/documents.service');

  async function mapStoredImagesWithUrls(images = []) {
    const mapped = [];
    for (const img of images) {
      if (!img || !img.metadataId) continue;
      try {
        const metadata = await DocumentMetadata.findById(img.metadataId).lean();
        if (!metadata) continue;
        let imageUrl = null;
        try {
          imageUrl = await documentsService.getPresignedUrl(img.metadataId.toString(), 3600);
        } catch (e) {
          imageUrl = documentsService.buildPublicUrl(metadata);
        }
        mapped.push({
          _id: img._id,
          metadataId: img.metadataId,
          url: imageUrl,
          originalName: metadata.originalName,
          contentType: metadata.contentType,
          size: metadata.size,
        });
      } catch (e) {
        logger.warn(`Failed to get image URL for ${img.metadataId}:`, e.message);
      }
    }
    return mapped;
  }

  if (prop.images && Array.isArray(prop.images)) {
    imagesWithUrls.push(...(await mapStoredImagesWithUrls(prop.images)));
  }

  const unitDetailsWithImages = [];
  if (Array.isArray(prop.unitDetails)) {
    for (const unit of prop.unitDetails) {
      const unitObj = unit && typeof unit.toObject === 'function' ? unit.toObject() : { ...unit };
      unitObj.images = await mapStoredImagesWithUrls(unitObj.images || []);
      unitDetailsWithImages.push(unitObj);
    }
  }

  return Object.assign({}, prop, stats, { 
    leaseExpirationNormalized, 
    tenants: tenants || [],
    upcomingInvoices: invoiceData.upcomingInvoices || [],
    pastOverdueInvoices: invoiceData.pastOverdueInvoices || [],
    unitLeases: unitLeases || [],
    openMaintenanceRequests: openMaintenanceRequests || [],
    profileImageUrl: profileImageUrl,
    initials: initials,
    images: imagesWithUrls,
    unitDetails: unitDetailsWithImages.length > 0 ? unitDetailsWithImages : (prop.unitDetails || []),
  });
}

// Append uploaded images metadata to a property and return the updated images array
async function addImagesToPropertyService(propertyId, imagesArray, options = {}) {
  if (!propertyId) {
    const err = new Error('propertyId is required');
    err.status = 400;
    throw err;
  }
  if (!Array.isArray(imagesArray) || imagesArray.length === 0) {
    const err = new Error('imagesArray must be a non-empty array');
    err.status = 400;
    throw err;
  }
  // persist images; allow caller to provide session or let service manage a transaction
  const doPersist = async (session) => {
    const propertyOid = toObjectId(propertyId);
    if (!propertyOid) { const err = new Error('propertyId must be a valid ObjectId'); err.status = 400; throw err; }
    if (session) {
  // imagesArray expected to contain { metadataId }
  const pushed = await Property.findOneAndUpdate({ _id: propertyOid, isDeleted: { $ne: true } }, { $push: { images: { $each: imagesArray.map(img => ({
    metadataId: img.metadataId,
    unitName: img.unitName || null,
    isCommon: typeof img.isCommon === 'boolean' ? img.isCommon : true,
  })) } } }, { new: true, session });
      if (!pushed) {
        const err = new Error('Property not found');
        err.status = 404;
        throw err;
      }
      return pushed.images || [];
    }

    const prop = await Property.findOne({ _id: propertyOid, isDeleted: { $ne: true } });
    if (!prop) {
      const err = new Error('Property not found');
      err.status = 404;
      throw err;
    }

    // push each image metadataId into property.images
    imagesArray.forEach(img => {
      prop.images = prop.images || [];
      prop.images.push({
        metadataId: img.metadataId,
        unitName: img.unitName || null,
        isCommon: typeof img.isCommon === 'boolean' ? img.isCommon : true,
      });
    });

    const saved = await prop.save();
    return saved.images || [];
  };

  return runInTransaction(doPersist, options);
}

/**
 * Upload files to S3 and persist metadata + property image references atomically.
 */
async function persistPropertyImageUploads(propertyId, files = [], options = {}, rollbackTracker = []) {
  if (!propertyId) throw Object.assign(new Error('propertyId is required'), { status: 400 });
  if (!Array.isArray(files) || files.length === 0) {
    throw Object.assign(new Error('files is required and must be a non-empty array'), { status: 400 });
  }

  const { session, uploadedBy } = options;
  const s3Client = require('../../../../../integrations/s3');
  const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
  const config = require('../../../../../config/default');
  const userId = uploadedBy || null;
  const uploaded = [];

  for (const f of files) {
    const filename = f.filename || f.originalname;
    const key = s3Client.getKeyForProperty
      ? s3Client.getKeyForProperty(propertyId, filename, userId)
      : `${UPLOAD_PROPERTY_SUBDIR || 'properties'}/${propertyId}/${Date.now()}_${filename}`;
    const result = await s3Client.upload({
      localFilePath: f.path,
      key,
      contentType: f.mimetype || 'application/octet-stream',
    });
    const s3Key = result.Key || key;
    rollbackTracker.push({ key: s3Key, metadataId: null });

    const bucketName = s3Client.bucket || (config.s3 && config.s3.bucket) || process.env.S3_BUCKET || process.env.AZURE_STORAGE_CONTAINER || 'mock-bucket';
    const region = s3Client.region || (config.s3 && config.s3.region) || process.env.AWS_REGION || 'mock-region';
    const contentType = f.mimetype || 'application/octet-stream';
    const size = f.size || 0;
    const metadataPayload = {
      key: s3Key,
      s3Location: result.Location,
      bucketName,
      region,
      size,
      contentType,
      originalName: filename,
    };

    const metadataDoc = session
      ? (await DocumentMetadata.create([metadataPayload], { session }))[0]
      : await DocumentMetadata.create(metadataPayload);

    rollbackTracker[rollbackTracker.length - 1].metadataId = metadataDoc._id;
    uploaded.push({
      key: s3Key,
      url: result.Location || (s3Client.baseUrl ? `${s3Client.baseUrl}/${key}` : `/${key}`),
      metadataId: metadataDoc._id,
    });
  }

  const persistOid = toObjectId(propertyId);
  if (!persistOid) throw Object.assign(new Error('propertyId must be a valid ObjectId'), { status: 400 });
  const propertyQuery = Property.findOne({ _id: persistOid, isDeleted: { $ne: true } });
  const property = await applySession(propertyQuery, session);
  if (!property) {
    throw Object.assign(new Error('Property not found'), { status: 404 });
  }

  await addImagesToPropertyService(
    propertyId,
    uploaded.map((img) => ({ ...img, isCommon: true })),
    { session }
  );

  if (Array.isArray(property.unitDetails)) {
    property.unitDetails.forEach((unit) => {
      if (!unit || !unit.unitName) return;
      unit.images = unit.images || [];
      uploaded.forEach((img) => {
        unit.images.push({
          metadataId: img.metadataId,
          unitName: unit.unitName,
          isCommon: true,
        });
      });
    });
    property.markModified('unitDetails');
  }

  if (!property.profileImageId && uploaded.length > 0) {
    property.profileImageId = uploaded[0].metadataId;
  }

  const saveOpts = session ? { session } : {};
  await property.save(saveOpts);

  cleanupTempFiles(files);
  return uploaded;
}

async function deletePropertyImagesInternal(propertyId, imageIds = [], options = {}) {
  const { session, s3KeysToDeleteAfterCommit = [] } = options;
  const propertyQuery = Property.findOne({ _id: propertyId, isDeleted: { $ne: true } });
  const property = await applySession(propertyQuery, session);
  if (!property) {
    throw Object.assign(new Error('Property not found'), { status: 404 });
  }

  const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
  const errors = [];

  for (const imageId of imageIds) {
    const imageExistsInProperty = property.images && property.images.some(
      (img) => img.metadataId && img.metadataId.toString() === imageId.toString()
    );
    let imageExistsInUnit = false;
    let unitImageMatch = null;

    if (Array.isArray(property.unitDetails)) {
      property.unitDetails.forEach((unit, unitIndex) => {
        if (!Array.isArray(unit.images)) return;
        const match = unit.images.find(
          (img) => img.metadataId && img.metadataId.toString() === imageId.toString()
        );
        if (match) {
          imageExistsInUnit = true;
          unitImageMatch = { unitIndex, imageId };
        }
      });
    }

    if (!imageExistsInProperty && !imageExistsInUnit) {
      const err = new Error(`Image ${imageId} not found in property`);
      err.status = 404;
      throw err;
    }

    const metadataQuery = DocumentMetadata.findById(imageId);
    const metadata = await applySession(metadataQuery, session);
    if (metadata && metadata.key) {
      s3KeysToDeleteAfterCommit.push(metadata.key);
    }
    if (metadata) {
      if (session) {
        await DocumentMetadata.findByIdAndDelete(metadata._id, { session });
      } else {
        await DocumentMetadata.findByIdAndDelete(metadata._id);
      }
    }

    property.images = (property.images || []).filter(
      (img) => !(img.metadataId && img.metadataId.toString() === imageId.toString())
    );

    if (unitImageMatch && Array.isArray(property.unitDetails) && property.unitDetails[unitImageMatch.unitIndex]) {
      const unit = property.unitDetails[unitImageMatch.unitIndex];
      unit.images = (unit.images || []).filter(
        (img) => !(img.metadataId && img.metadataId.toString() === imageId.toString())
      );
      property.unitDetails[unitImageMatch.unitIndex] = unit;
      property.markModified('unitDetails');
    }

    if (property.profileImageId && property.profileImageId.toString() === imageId.toString()) {
      property.profileImageId = property.images.length > 0 ? property.images[0].metadataId : null;
    }
  }

  const saveOpts = session ? { session } : {};
  await property.save(saveOpts);

  return {
    success: true,
    deletedCount: imageIds.length,
    failedCount: errors.length,
    totalRequested: imageIds.length,
    errors: errors.length > 0 ? errors : undefined,
  };
}

// Upload files to S3 and persist metadata into Property.images transactionally.
// files: array of multer file objects { path, filename, originalname }
async function uploadPropertyImagesService(propertyId, files = [], options = {}) {
  const rollbackTracker = [];
  try {
    return await runInTransaction(
      (session) => persistPropertyImageUploads(propertyId, files, { ...options, session }, rollbackTracker),
      options
    );
  } catch (err) {
    await cleanupUploadedAssets(rollbackTracker);
    cleanupTempFiles(files);
    throw err;
  }
}

// Export properties as CSV using the same filters/pagination as getPropertiesService
async function exportPropertiesCsvService(filters = {}) {
  // Delegate to getPropertiesService so we apply the same filtering, sorting and pagination
  const result = await getPropertiesService(filters);
  const data = (result && result.data) || [];

  // If no data, return an informative CSV
  if (!data || data.length === 0) {
    const filename = `properties_export_${Date.now()}.csv`;
    return { filename, csv: 'No properties found' };
  }

  // Use a stable header order that matches the GET /properties response fields
  const headers = ['name', 'address', 'rent', 'amountOverdue', 'leaseExpiration90', 'status', 'openMaintenance', 'closedMaintenance', 'tenants'];

  // CSV escape helper
  function csvEscape(val) {
    if (val === null || typeof val === 'undefined') return '""';
    if (typeof val === 'object') {
      try { val = JSON.stringify(val); } catch { val = String(val); }
    }
    let s = String(val);
    if (/^[+\-=@]/.test(s.charAt(0))) s = "'" + s; // prevent Excel eval
    return '"' + s.replace(/"/g, '""') + '"';
  }

  const rows = [headers.join(',')];
  for (const rowObj of data) {
      // Ensure we map the leaseExpiration90 value where available; fall back to leaseExpirationNormalized or leaseExpiration
      const tenantNames = Array.isArray(rowObj.tenants) ? rowObj.tenants.map(t => `${t.firstName || ''} ${t.lastName || ''}`.trim() || t.email || 'Unknown').join('; ') : '';
      const mapped = Object.assign({}, rowObj, {
        leaseExpiration90: rowObj.leaseExpiration90 || rowObj.leaseExpirationNormalized || rowObj.leaseExpiration,
        name: rowObj.name || rowObj.unitName || rowObj.propertyName || '',
        tenants: tenantNames
      });
      const row = headers.map(h => csvEscape(mapped[h]));
    rows.push(row.join(','));
  }

  const csv = rows.join('\n');
  // Keep export filenames creator-scoped without legacy owner params
  const dt = ClockService.now();
  const pad = (n) => (n < 10 ? '0' + n : n);
  const ts = `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}_${pad(dt.getHours())}${pad(dt.getMinutes())}${pad(dt.getSeconds())}`;
  const filename = `properties_${ts}.csv`;

  return { filename, csv };
}

/**
 * Check if a property has any active listings
 */
async function checkPropertyHasListing(propertyId) {
  try {
    const listingColl = mongoose.connection.collection('listings');
    const propObjId = toObjectId(propertyId);
    const listing = await listingColl.findOne({ 
      propertyId: propObjId,
      status: { $in: ['Active', 'Published'] },
      isDeleted: { $ne: true }
    });
    return !!listing;
  } catch (error) {
    logger.warn('Error checking property listing:', error.message);
    return false;
  }
}

/**
 * Check if a specific unit has any active listings
 */
async function checkUnitHasListing(propertyId, unitName) {
  try {
    const listingColl = mongoose.connection.collection('listings');
    const propObjId = toObjectId(propertyId);
    const listingQuery = { 
      propertyId: propObjId,
      status: { $in: ['Active', 'Published'] },
      isDeleted: { $ne: true }
    };
    
    if (unitName) {
      listingQuery.unitName = { $regex: `^${escapeRegex(String(unitName))}$`, $options: 'i' };
    }
    
    const listing = await listingColl.findOne(listingQuery);
    return !!listing;
  } catch (error) {
    logger.warn('Error checking unit listing:', error.message);
    return false;
  }
}

/**
 * Check if a property has any active leases
 */
async function checkPropertyHasLease(propertyId) {
  try {
    const leaseColl = mongoose.connection.collection('leases');
    const propObjId = toObjectId(propertyId);
    const lease = await leaseColl.findOne({ 
      property_id: propObjId,
      isDeleted: { $ne: true }
    });
    return !!lease;
  } catch (error) {
    logger.warn('Error checking property lease:', error.message);
    return false;
  }
}

/**
 * Check if a specific unit has any active leases
 */
async function checkUnitHasLease(propertyId, unitName) {
  try {
    const leaseColl = mongoose.connection.collection('leases');
    const propObjId = toObjectId(propertyId);
    const leaseQuery = {
      property_id: propObjId,
      isDeleted: { $ne: true }
    };
    
    if (unitName) {
      leaseQuery.unitName = { $regex: `^${escapeRegex(String(unitName))}$`, $options: 'i' };
    }
    
    const lease = await leaseColl.findOne(leaseQuery);
    return !!lease;
  } catch (error) {
    logger.warn('Error checking unit lease:', error.message);
    return false;
  }
}

/**
 * Add hasLease flag to properties based on lease existence
 */
async function addLeaseFlagsToProperties(properties) {
  const propertiesWithFlags = await Promise.all(
    properties.map(async (property) => {
      const hasLease = await checkPropertyHasLease(property._id || property.id);
      return {
        ...property,
        hasLease
      };
    })
  );
  return propertiesWithFlags;
}

async function getPortfolioOverviewService(createdBy, sourcePortal) {
  const t0 = Date.now();
  const ownerId = requireCreatedBy({ createdBy });

  // Define lowercase status helpers for comparisons
  const activeLower = String(LEASE_STATUSES.ACTIVE).toLowerCase();
  const approvedLower = 'approved';

  const properties = await Property.find({
    ...(await buildLandlordPropertyVisibilityFilter(ownerId, sourcePortal)),
    isDeleted: { $ne: true },
    isArchieved: { $ne: true },
  }, {
    _id: 1,
    unitDetails: 1,
  }).lean();

  if (!properties || properties.length === 0) {
    return { ...EMPTY_PORTFOLIO_OVERVIEW };
  }

  const propertyIds = properties.map((property) => toObjectId(property._id));
  const leaseColl = mongoose.connection.collection('leases');
  const incomeColl = mongoose.connection.collection('invoices');

  const allLeases = await leaseColl.find({
    property_id: { $in: propertyIds },
    isDeleted: { $ne: true },
  }, {
    projection: { _id: 1, property_id: 1, unitName: 1 },
  }).toArray();

  const allLeaseIds = allLeases.map((lease) => lease._id).filter(Boolean);
  const allInvoices = allLeaseIds.length > 0
    ? await incomeColl.find({
      lease_id: { $in: allLeaseIds },
      status: INVOICE_STATUS.OVERDUE,
      type: INVOICE_TYPES.RENT,
      isDeleted: { $ne: true },
    }, {
      projection: { _id: 1, lease_id: 1 },
    }).toArray()
    : [];

  const leasesByProperty = {};
  const invoicesByLease = {};

  for (const lease of allLeases) {
    const propId = lease.property_id.toString();
    if (!leasesByProperty[propId]) leasesByProperty[propId] = [];
    leasesByProperty[propId].push(lease);
  }

  for (const invoice of allInvoices) {
    invoicesByLease[invoice.lease_id.toString()] = true;
  }

  let totalUnits = 0;
  let occupiedUnits = 0;
  let onTimeUnits = 0;
  let behindUnits = 0;

  for (const property of properties) {
    const propId = property._id.toString();
    const unitDetails = property.unitDetails || [];
    const propertyLeases = leasesByProperty[propId] || [];

    if (unitDetails.length > 0) {
      totalUnits += unitDetails.length;

      for (const unit of unitDetails) {
        const unitNameLower = (unit.unitName || '').toLowerCase();
        let isOccupied = false;
        let hasOverdue = false;

        for (const lease of propertyLeases) {
          if (lease.unitName && lease.unitName.toLowerCase() === unitNameLower) {
            const leaseStatusLower = (lease.status || lease.lease_status || '').toString().toLowerCase();
            if (leaseStatusLower === activeLower || leaseStatusLower === 'approved') {
              isOccupied = true;
              if (invoicesByLease[lease._id.toString ? lease._id.toString() : lease._id]) {
                hasOverdue = true;
              }
              break; // stop after finding an active/approved lease for this unit
            }
          }
        }

        if (isOccupied) {
          occupiedUnits += 1;
          if (hasOverdue) behindUnits += 1;
          else onTimeUnits += 1;
        }
      }
    } else {
      totalUnits += 1;
      // For properties without unit details, consider the unit occupied only when
      // there exists a lease with status ACTIVE or APPROVED
      let isOccupied = false;
      for (const lease of propertyLeases) {
        const leaseStatusLower = (lease.status || lease.lease_status || '').toString().toLowerCase();
        if (leaseStatusLower === activeLower || leaseStatusLower === 'approved') {
          isOccupied = true;
          break;
        }
      }

      if (isOccupied) {
        occupiedUnits += 1;
        const hasOverdue = propertyLeases.some(
          (lease) => invoicesByLease[lease._id.toString()]
        );
        if (hasOverdue) behindUnits += 1;
        else onTimeUnits += 1;
      }
    }
  }

  const vacantUnits = totalUnits - occupiedUnits;
  const occupancyPercentage = totalUnits > 0 ? Math.round((occupiedUnits / totalUnits) * 100) : 0;
  const rentPaymentPercentage = occupiedUnits > 0 ? Math.round((onTimeUnits / occupiedUnits) * 100) : 0;

  logger.info(`[PERF] Portfolio overview: ${Date.now() - t0}ms`);

  return {
    totalUnits,
    occupancyPercentage,
    occupiedUnits,
    vacantUnits,
    rentPaymentPercentage,
    onTimeUnits,
    behindUnits,
  };
}


/**
 * Get upcoming and past/overdue invoices for a property
 * Only includes invoices from ACTIVE leases and within lease duration
 * For Fixed-Term leases: fetch from start_date to end_date
 * For Month-to-Month leases: fetch for 1 year from current date
 */
async function getInvoicesForProperty(propertyId) {
  try {
    const propObjId = toObjectId(propertyId);
    const leaseColl = mongoose.connection.collection('leases');
    const invoiceColl = mongoose.connection.collection('invoices');
    const now = ClockService.now();
    
    // Get only ACTIVE leases for this property
    const activeLower = String(LEASE_STATUSES.ACTIVE).toLowerCase();
    const activeLeases = await leaseColl.find({ 
      property_id: propObjId,
      isDeleted: { $ne: true },
      $expr: {
        $eq: [
          { $toLower: { $ifNull: ['$status', '$lease_status'] } },
          activeLower
        ]
      }
    }).toArray();
    
    if (!activeLeases || activeLeases.length === 0) {
      return { upcomingInvoices: [], pastOverdueInvoices: [] };
    }
    
    // Get lease IDs - includes all ACTIVE leases for all units
    const leaseIds = activeLeases.map(l => l._id).filter(Boolean);
    
    // Get invoices for these active leases from all units
    let invoices = await invoiceColl.find({ lease_id: { $in: leaseIds }, isDeleted: { $ne: true } }).toArray();
    
    // Fallback: also try direct propertyId lookup
    if (!invoices || invoices.length === 0) {
      invoices = await invoiceColl.find({ propertyId: propObjId, isDeleted: { $ne: true } }).toArray();
    }
    
    if (!invoices || invoices.length === 0) {
      return { upcomingInvoices: [], pastOverdueInvoices: [] };
    }
    
    // Filter invoices to only those within valid lease duration
    const validInvoices = [];
    for (const invoice of invoices) {
      const leaseId = invoice.lease_id || invoice.leaseId;
      if (!leaseId) continue;
      
      // Find the lease for this invoice
      const lease = activeLeases.find(l => l._id.toString() === (leaseId.toString ? leaseId.toString() : leaseId));
      if (!lease) continue;
      
      // Determine valid date range based on lease type
      let validStartDate = null;
      let validEndDate = null;
      
      const leaseType = (lease.lease_type || lease.leaseType || lease.type || '').toLowerCase();
      const isMonthToMonth = leaseType.includes('month');
      
      if (isMonthToMonth) {
        // For month-to-month: 1 year from now
        validStartDate = DateUtil.addDays(now, -365);
        validEndDate = DateUtil.addDays(now, 365);
      } else {
        // For fixed-term: use lease start and end dates
        const leaseStart = lease.start_date || lease.startDate;
        const leaseEnd = lease.end_date || lease.endDate || lease.lease_end;
        
        if (leaseStart) validStartDate = DateUtil.toUTC(leaseStart);
        if (leaseEnd) validEndDate = DateUtil.toUTC(leaseEnd);
      }
      
      // Check if invoice is within valid date range
      const invoiceDate = invoice.dueDate || invoice.createdAt;
      if (!invoiceDate) {
        // Include invoices without a date - they'll be categorized by status below
        validInvoices.push(invoice);
        continue;
      }
      
      const invDate = DateUtil.toUTC(invoiceDate);
      if (validStartDate && invDate < validStartDate) continue;
      if (validEndDate && invDate > validEndDate) continue;
      
      validInvoices.push(invoice);
    }
    
    // Separate upcoming vs past/overdue invoices
    const upcomingInvoices = [];
    const pastOverdueInvoices = [];
    
    validInvoices.forEach(invoice => {
      const dueDate = invoice.dueDate ? DateUtil.toUTC(invoice.dueDate) : null;
      const isOverdue = invoice.status === 'Overdue';
      const isPaid = invoice.status === 'Paid';
      
      if (isPaid) {
        // Skip paid invoices
        return;
      }
      
      if (!dueDate) {
        // Skip invoices without due date
        return;
      }
      
      // Set today's date to start of day for comparison
      const todayStart = DateUtil.startOfDayEST(now);
      
      // Set invoice due date to start of day for comparison
      const invDueDateStart = DateUtil.startOfDayEST(dueDate);
      
      // UPCOMING: Today and future dates
      if (invDueDateStart >= todayStart) {
        upcomingInvoices.push(invoice);
      }
      // PAST/OVERDUE: Only dates strictly before today
      else if (invDueDateStart < todayStart || isOverdue) {
        pastOverdueInvoices.push(invoice);
      }
    });
    
    // Format invoices (no limit - fetch all for entire lease duration)
    const formatInvoice = (invoice) => ({
      id: invoice._id,
      invoiceId: invoice.invoiceId || null,
      invoiceNumber: invoice.invoiceId || null,
      type: invoice.type,
      status: invoice.status,
      unit: invoice.unit,
      term: invoice.term,
      subAmount: invoice.subAmount || 0,
      alreadyPaid: invoice.alreadyPaid || 0,
      balanceDue: invoice.balanceDue || 0,
      dueDate: invoice.dueDate,
      paidOn: invoice.paidOn,
      createdAt: invoice.createdAt,
      updatedAt: invoice.updatedAt,
      leaseId: invoice.lease_id
    });
    
    return {
      upcomingInvoices: upcomingInvoices
        .sort((a, b) => (DateUtil.toEpoch(a.dueDate) ?? 0) - (DateUtil.toEpoch(b.dueDate) ?? 0))
        .map(formatInvoice),
      pastOverdueInvoices: pastOverdueInvoices
        .sort((a, b) => (DateUtil.toEpoch(b.dueDate) ?? 0) - (DateUtil.toEpoch(a.dueDate) ?? 0))
        .map(formatInvoice)
    };
  } catch (e) {
    logger.error('Error fetching invoices for property:', e);
    return { upcomingInvoices: [], pastOverdueInvoices: [] };
  }
}

/**
 * Get latest 3 open maintenance requests for a property
 */
async function getOpenMaintenanceRequests(propertyId) {
  try {
    const propObjId = toObjectId(propertyId);
    const maintColl = mongoose.connection.collection('maintenancerequests');
    
    // Get open maintenance requests (status: Open, Submitted, or InProgress)
    const openStatuses = ['Open', 'Submitted', 'InProgress'];
    const requests = await maintColl.find({ 
      property_id: propObjId,
      status: { $in: openStatuses },
      isDeleted: { $ne: true }
    })
    .sort({ createdAt: -1 })
    .limit(3)
    .toArray();
    
    if (!requests || requests.length === 0) {
      return [];
    }

    const property = await Property.findOne({ _id: propertyId, isDeleted: { $ne: true } }).select('unitDetails').lean();

    // Format maintenance requests
    return requests.map(request => ({
      id: request._id,
      title: request.title,
      description: request.description,
      category: request.category,
      status: request.status,
      isUrgent: request.isUrgent,
      unitId: request.unitId,
      units: unitDisplayNameFromMaintenance(property, request),
      requestDate: request.request_date,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      requestedBy: request.requestedBy,
      assignedTo: request.assignedTo
    }));
  } catch (e) {
    logger.error('Error fetching maintenance requests for property:', e);
    return [];
  }
}

/**
 * Get unit-specific lease information for a property
 * Only returns ACTIVE leases
 */
async function getUnitLeasesForProperty(propertyId, unitDetails) {
  try {
    const propObjId = toObjectId(propertyId);
    const leaseColl = mongoose.connection.collection('leases');
    
    // Only fetch ACTIVE leases for this property
    const activeLower = String(LEASE_STATUSES.ACTIVE).toLowerCase();
    const leases = await leaseColl.find({ 
      property_id: propObjId,
      isDeleted: { $ne: true },
      $expr: {
        $eq: [
          { $toLower: { $ifNull: ['$status', '$lease_status'] } },
          activeLower
        ]
      }
    }, {
      projection: {
        _id: 1,
        property_id: 1,
        unitName: 1,
        start_date: 1,
        end_date: 1,
        lease_type: 1,
        status: 1,
        rentDetails: 1,
        depositDetails: 1,
        leaseTerm: 1,
        auto_renew: 1,
        switchMonthToMonth: 1,
        rentAndDepositDestribution: 1,
        createdAt: 1,
        updatedAt: 1
      }
    }).toArray();
    
    if (!leases || leases.length === 0) return [];
    
    const unitLeases = [];
    const units = unitDetails || [];
    
    if (units.length > 0) {
      for (const unit of units) {
        const unitName = unit.unitName || '';
        const unitLease = leases.find(l => 
          l.unitName && l.unitName.toLowerCase() === unitName.toLowerCase()
        );
        
        if (unitLease) {
          unitLeases.push(await formatLeaseDetails(unitLease));
        }
      }
    } else {
      // For properties without specific units, return the first ACTIVE lease
      if (leases.length > 0) {
        unitLeases.push(await formatLeaseDetails(leases[0]));
      }
    }
    
    return unitLeases;
  } catch (e) {
    logger.error('Error fetching unit leases for property:', e);
    return [];
  }
}

async function formatLeaseDetails(lease) {
  let remainingDays = null;
  let leaseStatus = lease.status || 'Unknown';
  let daysDescription = null;
  
  if (lease.end_date) {
    const now = ClockService.now();
    remainingDays = DateUtil.diffDays(now, lease.end_date);
    
    if (remainingDays < 0) {
      leaseStatus = 'Expired';
      daysDescription = `Expired ${Math.abs(remainingDays)} days ago`;
    } else if (remainingDays === 0) {
      leaseStatus = 'Expires Today';
      daysDescription = 'Expires today';
    } else if (remainingDays <= 30) {
      leaseStatus = 'Expiring Soon';
      daysDescription = `${remainingDays} days remaining`;
    } else {
      daysDescription = `${remainingDays} days remaining`;
    }
  } else if (lease.lease_type && lease.lease_type.toLowerCase().includes('month')) {
    leaseStatus = 'Month-to-Month';
    remainingDays = 'Ongoing';
    daysDescription = 'Month-to-month lease';
  }
  
  const tenants = [];
  if (lease.rentAndDepositDestribution && Array.isArray(lease.rentAndDepositDestribution.split)) {
    const userColl = mongoose.connection.collection('users');
    const tenantIds = [];
    
    for (let i = 0; i < lease.rentAndDepositDestribution.split.length; i++) {
      const split = lease.rentAndDepositDestribution.split[i];
      if (split && split.tenantId) {
        try {
          if (mongoose.Types.ObjectId.isValid(split.tenantId)) {
            tenantIds.push(new mongoose.Types.ObjectId(split.tenantId));
          }
        } catch (e) {
          logger.warn('Invalid tenantId:', split.tenantId);
        }
      }
    }
    
    if (tenantIds.length > 0) {
      try {
        const tenantDocs = await userColl.find({ 
          _id: { $in: tenantIds },
          isDeleted: { $ne: true }
        }, {
          projection: { _id: 1, firstName: 1, lastName: 1, email: 1, phone: 1 }
        }).toArray();
        
        for (let i = 0; i < tenantDocs.length; i++) {
          const t = tenantDocs[i];
          tenants.push({
            id: t._id,
            name: `${t.firstName || ''} ${t.lastName || ''}`.trim() || 'Unknown',
            email: t.email,
            phone: t.phone
          });
        }
      } catch (e) {
        logger.error('Error fetching tenants:', e);
      }
    }
  }
  
  return {
    id: lease._id,
    unitName: lease.unitName || 'Unit 1',
    startDate: lease.start_date,
    endDate: lease.end_date,
    leaseType: lease.lease_type,
    status: leaseStatus,
    remainingDays: remainingDays,
    daysDescription: daysDescription,
    rentAmount: lease.rentDetails ? lease.rentDetails.amount : 0,
    rentFrequency: lease.rentDetails ? lease.rentDetails.frequency : null,
    leaseTerm: lease.leaseTerm,
    autoRenew: lease.auto_renew || false,
    switchMonthToMonth: lease.switchMonthToMonth || false,
    depositAmount: lease.depositDetails ? lease.depositDetails.amount : 0,
    isDepositCollected: lease.depositDetails ? lease.depositDetails.isDepositAlreadyCollected : false,
    tenants: tenants,
    createdAt: lease.createdAt,
    updatedAt: lease.updatedAt
  };
}

/**
 * Delete property images and remove references from property
 * @param {string} propertyId - Property ID
 * @param {array} imageIds - Array of document metadata IDs to delete
 * @param {object} options - Options (deletedBy)
 * @returns {Promise<object>} - Result with deleted count
 */
async function deletePropertyImagesService(propertyId, imageIds = [], options = {}) {
  if (!propertyId) throw Object.assign(new Error('propertyId is required'), { status: 400 });
  if (!Array.isArray(imageIds) || imageIds.length === 0) {
    throw Object.assign(new Error('imageIds must be a non-empty array'), { status: 400 });
  }

  const s3KeysToDeleteAfterCommit = [];
  const result = await runInTransaction(
    (session) => deletePropertyImagesInternal(propertyId, imageIds, {
      ...options,
      session,
      s3KeysToDeleteAfterCommit,
    }),
    options
  );
  await cleanupS3Keys(s3KeysToDeleteAfterCommit);
  return result;
}

/**
 * Set or update the profile image for a property
 * @param {string} propertyId - Property ID
 * @param {string} imageId - Document metadata ID of the image
 * @returns {Promise<object>} - Updated property
 */
async function setProfileImageService(propertyId, imageId, options = {}) {
  if (!propertyId) throw Object.assign(new Error('propertyId is required'), { status: 400 });
  if (!imageId) throw Object.assign(new Error('imageId is required'), { status: 400 });

  const doSetProfile = async (session) => {
    const propertyQuery = Property.findOne({ _id: propertyId, isDeleted: { $ne: true } });
    const property = await applySession(propertyQuery, session);
    if (!property) {
      throw Object.assign(new Error('Property not found'), { status: 404 });
    }

    const imageExists = property.images && property.images.some(
      (img) => img.metadataId && img.metadataId.toString() === imageId.toString()
    );
    if (!imageExists) {
      throw Object.assign(new Error('Image not found in property images'), { status: 404 });
    }

    property.profileImageId = imageId;
    const saveOpts = session ? { session } : {};
    await property.save(saveOpts);
    return property.toObject();
  };

  return runInTransaction(doSetProfile, options);
}

/**
 * Upload property or unit-scoped images based on imageMode metadata.
 */
async function persistPropertyMediaUploads(propertyId, propertyData = {}, files = [], options = {}, rollbackTracker = []) {
  const imageMode = propertyData.imageMode || 'shared';
  const unitGroups = Array.isArray(propertyData.unitImageUploadGroups)
    ? propertyData.unitImageUploadGroups
    : [];

  if (imageMode === 'per-unit' && unitGroups.length > 0) {
    return persistUnitPropertyImageUploads(propertyId, unitGroups, files, options, rollbackTracker);
  }

  if (files && files.length > 0) {
    return persistPropertyImageUploads(propertyId, files, options, rollbackTracker);
  }

  return [];
}

async function persistUnitPropertyImageUploads(
  propertyId,
  unitImageUploadGroups = [],
  files = [],
  options = {},
  rollbackTracker = []
) {
  if (!propertyId) throw Object.assign(new Error('propertyId is required'), { status: 400 });
  if (!Array.isArray(files) || files.length === 0) {
    throw Object.assign(new Error('files is required and must be a non-empty array'), { status: 400 });
  }

  const { session, uploadedBy } = options;
  const s3Client = require('../../../../../integrations/s3');
  const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
  const config = require('../../../../../config/default');
  const userId = uploadedBy || null;
  const uploaded = [];
  let fileIndex = 0;

  const propertyQuery = Property.findOne({ _id: propertyId, isDeleted: { $ne: true } });
  const property = await applySession(propertyQuery, session);
  if (!property) {
    throw Object.assign(new Error('Property not found'), { status: 404 });
  }

  property.unitDetails = Array.isArray(property.unitDetails) ? property.unitDetails : [];

  for (const group of unitImageUploadGroups) {
    const unitIndex = Number(group.unitIndex);
    const count = Number(group.count) || 0;
    if (count <= 0) continue;

    const unitFiles = files.slice(fileIndex, fileIndex + count);
    fileIndex += count;
    if (!unitFiles.length) continue;
    if (!property.unitDetails[unitIndex]) continue;

    property.unitDetails[unitIndex].images = property.unitDetails[unitIndex].images || [];

    for (const f of unitFiles) {
      const filename = f.filename || f.originalname;
      const key = s3Client.getKeyForProperty
        ? s3Client.getKeyForProperty(propertyId, filename, userId)
        : `${UPLOAD_PROPERTY_SUBDIR || 'properties'}/${propertyId}/units/${unitIndex}/${Date.now()}_${filename}`;
      const result = await s3Client.upload({ localFilePath: f.path, key });
      const s3Key = result.Key || key;
      rollbackTracker.push({ key: s3Key, metadataId: null });

      const metadataPayload = {
        key: s3Key,
        s3Location: result.Location,
        bucketName: config.s3 && config.s3.bucket ? config.s3.bucket : (process.env.S3_BUCKET || 'mock-bucket'),
        region: config.s3 && config.s3.region ? config.s3.region : (process.env.AWS_REGION || 'mock-region'),
        size: f.size || 0,
        contentType: f.mimetype || 'application/octet-stream',
        originalName: filename,
      };

      const metadataDoc = session
        ? (await DocumentMetadata.create([metadataPayload], { session }))[0]
        : await DocumentMetadata.create(metadataPayload);

      rollbackTracker[rollbackTracker.length - 1].metadataId = metadataDoc._id;
      const unitName = property.unitDetails[unitIndex].unitName || null;
      property.unitDetails[unitIndex].images.push({
        metadataId: metadataDoc._id,
        unitName,
        isCommon: false,
      });
      property.images = property.images || [];
      property.images.push({
        metadataId: metadataDoc._id,
        unitName,
        isCommon: false,
      });
      uploaded.push({
        key: s3Key,
        url: result.Location || (s3Client.baseUrl ? `${s3Client.baseUrl}/${key}` : `/${key}`),
        metadataId: metadataDoc._id,
        unitIndex,
      });
    }
  }

  property.markModified('unitDetails');
  const saveOpts = session ? { session } : {};
  await property.save(saveOpts);
  cleanupTempFiles(files);
  return uploaded;
}

/**
 * Create property and optional images in a single atomic operation.
 */
async function createPropertyWithMediaService(propertyData, files = [], options = {}) {
  const rollbackTracker = [];
  try {
    const created = await runInTransaction(async (session) => {
      const property = await createPropertyService(propertyData, { session });
      if (files && files.length > 0) {
        await persistPropertyMediaUploads(
          property._id,
          propertyData,
          files,
          { uploadedBy: options.uploadedBy, session },
          rollbackTracker
        );
      }
      return property;
    }, options);

    return getPropertyByIdService(created._id);
  } catch (err) {
    await cleanupUploadedAssets(rollbackTracker);
    cleanupTempFiles(files);
    throw err;
  }
}

/**
 * Update property, delete and/or upload images in a single atomic operation.
 */
async function updatePropertyWithMediaService(
  propertyId,
  propertyData,
  createdBy,
  { files = [], attachmentsToDelete = [], uploadedBy, sourcePortal } = {}
) {
  const rollbackTracker = [];
  const s3KeysToDeleteAfterCommit = [];
  try {
    await runInTransaction(async (session) => {
      if (attachmentsToDelete && attachmentsToDelete.length > 0) {
        await deletePropertyImagesInternal(propertyId, attachmentsToDelete, {
          session,
          s3KeysToDeleteAfterCommit,
        });
      }
      await updatePropertyService(propertyId, propertyData, createdBy, { session, sourcePortal });
      if (files && files.length > 0) {
        await persistPropertyMediaUploads(
          propertyId,
          propertyData,
          files,
          { uploadedBy, session },
          rollbackTracker
        );
      }
    });

    await cleanupS3Keys(s3KeysToDeleteAfterCommit);
    return getPropertyByIdService(propertyId);
  } catch (err) {
    await cleanupUploadedAssets(rollbackTracker);
    cleanupTempFiles(files);
    throw err;
  }
}

/**
 * Toggle archive state for a property atomically.
 */
async function toggleArchivePropertyService(propertyId, options = {}) {
  return runInTransaction(async (session) => {
    const propertyQuery = Property.findOne({ _id: propertyId, isDeleted: { $ne: true } });
    const property = await applySession(propertyQuery, session);
    if (!property) {
      throw Object.assign(new Error('Property not found'), { status: 404 });
    }
    if (property.isArchieved) {
      return unarchivePropertyService(propertyId, { session });
    }
    return archivePropertyService(propertyId, { session });
  }, options);
}

/**
 * Get current lease information for a property
 */
async function getCurrentLeaseForProperty(propertyId) {
  try {
    const propObjId = toObjectId(propertyId);
    const leaseColl = mongoose.connection.collection('leases');
    
    // Find the most relevant lease for this property
    // Priority: Active > Signed > any other status
    if (!propObjId) return null;
    const leases = await leaseColl.find({ 
      property_id: propObjId,
      isDeleted: { $ne: true }
    })
    .sort({ 
      // Sort by status priority and then by creation date
      status: 1,
      createdAt: -1 
    })
    .toArray();
    
    if (!leases || leases.length === 0) return null;
    
    // Find the best lease based on priority
    let currentLease = null;
    const statusPriority = ['Active', 'Signed', 'Pending', 'Expired'];
    
    for (const status of statusPriority) {
      currentLease = leases.find(lease => String(lease.status || '') === status);
      if (currentLease) break;
    }
    
    // If no lease found with priority statuses, take the first one
    if (!currentLease) {
      currentLease = leases[0];
    }
    
    // Calculate remaining days and determine lease status
    let remainingDays = null;
    let leaseStatus = currentLease.status || 'Unknown';
    let daysDescription = null;
    
    if (currentLease.end_date) {
      const now = ClockService.now();
      remainingDays = DateUtil.diffDays(now, currentLease.end_date);
      
      if (remainingDays < 0) {
        leaseStatus = 'Expired';
        daysDescription = `Expired ${Math.abs(remainingDays)} days ago`;
      } else if (remainingDays === 0) {
        leaseStatus = 'Expires Today';
        daysDescription = 'Expires today';
      } else if (remainingDays <= 30) {
        leaseStatus = 'Expiring Soon';
        daysDescription = `${remainingDays} days remaining`;
      } else {
        daysDescription = `${remainingDays} days remaining`;
      }
    } else if (currentLease.lease_type && currentLease.lease_type.toLowerCase().includes('month')) {
      leaseStatus = 'Month-to-Month';
      remainingDays = 'Ongoing';
      daysDescription = 'Month-to-month lease';
    }
    
    return {
      id: currentLease._id,
      startDate: currentLease.start_date,
      endDate: currentLease.end_date,
      leaseType: currentLease.lease_type,
      status: leaseStatus,
      remainingDays: remainingDays,
      daysDescription: daysDescription,
      rentAmount: currentLease.rentDetails ? currentLease.rentDetails.amount : 0,
      rentFrequency: currentLease.rentDetails ? currentLease.rentDetails.frequency : null,
      unitName: currentLease.unitName,
      leaseTerm: currentLease.leaseTerm,
      autoRenew: currentLease.auto_renew || false,
      switchMonthToMonth: currentLease.switchMonthToMonth || false,
      // Additional useful information
      depositAmount: currentLease.depositDetails ? currentLease.depositDetails.amount : 0,
      isDepositCollected: currentLease.depositDetails ? currentLease.depositDetails.isDepositAlreadyCollected : false,
      createdAt: currentLease.createdAt,
      updatedAt: currentLease.updatedAt
    };
  } catch (e) {
    logger.error('Error fetching current lease for property:', e);
    return null;
  }
}

module.exports = {
  getPropertiesService,
  getPropertyByIdService,
  createPropertyService,
  createPropertyWithMediaService,
  updatePropertyService,
  updatePropertyWithMediaService,
  deletePropertyService,
  archivePropertyService,
  unarchivePropertyService,
  toggleArchivePropertyService,
  checkPropertyNameAvailabilityService,
  addImagesToPropertyService,
  uploadPropertyImagesService,
  deletePropertyImagesService,
  exportPropertiesCsvService,
  addNoteToPropertyService,
  importPropertiesFromCsv,
  getTenantsForProperty,
  getTenantsForUnit,
  getPortfolioOverviewService,
  checkPropertyHasLease,
  checkUnitHasLease,
  checkPropertyHasListing,
  checkUnitHasListing,
  addLeaseFlagsToProperties,
  getInvoicesForProperty,
  getCurrentLeaseForProperty,
  getOpenMaintenanceRequests,
  getUnitLeasesForProperty,
  setProfileImageService,
  generatePropertyInitials,
	getProfileImageUrl
};

