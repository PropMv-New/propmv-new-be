/**
 * ------------------------------------------------------------------
 * File: lease.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * lease.controller, tenant.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Lease = require('../model/lease.model');
const { LEASE_STATUSES, LEASE_TYPES, FREQUENCY_TYPES } = require('../../../../../common/constants/lease');
const Property = require('../../property/model/property.model');
const logger = require('../../../../../common/logger');
const { formatDateInAppTimezone } = require('../../../../../common/helpers/hoaBillingDates');
const { ClockService, DateUtil, MS_PER_DAY } = require('../../../../../common/date');

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function toObjectIds(arr) {
  return (Array.isArray(arr) ? arr : []).map(toObjectId).filter(Boolean);
}

// Request-level input-shape validation for create/update is handled by Joi middleware
// in routes. Service assumes the payload has correct shape and required fields.

async function createLeaseService(leaseData, options = {}) {
  logger.info('🔍 Creating lease with data:');
  logger.info(JSON.stringify(leaseData, null, 2));
  
  // Input shape/required-field validation for create is performed by Joi middleware
  // (validateBody(createLeaseSchema)). Service assumes payload shape/required
  // fields are valid and focuses on business rules (uniqueness/conflict checks,
  // tenant existence, DB transactions, etc.).
  // On create, only SUBMITTED is allowed. Use the canonical LEASE_STATUSES constant.
  let statusValue = LEASE_STATUSES.SUBMITTED;
  if (typeof leaseData.status !== 'undefined' && leaseData.status !== null && leaseData.status !== '') {
    const s = String(leaseData.status).toLowerCase();
    const normalized = s.charAt(0).toUpperCase() + s.slice(1);
    if (normalized !== LEASE_STATUSES.SUBMITTED) {
      const err = new Error(`status must be ${LEASE_STATUSES.SUBMITTED} on create`);
      err.status = 400;
      logger.error(' Lease creation error - invalid status:', err.message);
      throw err;
    }
    statusValue = normalized;
  }

  // Validate payment frequency specific fields if rentDetails is being set
  if (leaseData.rentDetails) {
    const { frequency, dueOne, dueTwo, dueWeekday, semiAnnualDates } = leaseData.rentDetails;
    
    // Validate bi-monthly requires dueTwo
    if (frequency === FREQUENCY_TYPES.BI_MONTHLY && !dueTwo) {
      const err = new Error('rentDetails.dueTwo is required for bi-monthly frequency');
      err.status = 400;
      throw err;
    }
    
    // Validate weekly/bi-weekly requires dueWeekday
    if ([FREQUENCY_TYPES.WEEKLY, FREQUENCY_TYPES.BI_WEEKLY].includes(frequency) && (dueWeekday === undefined || dueWeekday === null)) {
      const err = new Error('rentDetails.dueWeekday is required for weekly/bi-weekly frequency');
      err.status = 400;
      throw err;
    }
    
    // Validate dueWeekday is between 0-6
    if ([FREQUENCY_TYPES.WEEKLY, FREQUENCY_TYPES.BI_WEEKLY].includes(frequency) && (dueWeekday < 0 || dueWeekday > 6)) {
      const err = new Error('rentDetails.dueWeekday must be between 0 (Sunday) and 6 (Saturday)');
      err.status = 400;
      throw err;
    }
    
    // Validate semi-annually requires exactly 2 dates
    if (frequency === FREQUENCY_TYPES.SEMI_ANNUALLY) {
      if (!semiAnnualDates || !Array.isArray(semiAnnualDates) || semiAnnualDates.length !== 2) {
        const err = new Error('rentDetails.semiAnnualDates must contain exactly 2 payment dates for semi-annually frequency');
        err.status = 400;
        throw err;
      }
      
      // Validate each date has valid month and day
      for (const date of semiAnnualDates) {
        if (!date.month || date.month < 1 || date.month > 12) {
          const err = new Error('rentDetails.semiAnnualDates month must be between 1 and 12');
          err.status = 400;
          throw err;
        }
        if (!date.day || date.day < 1 || date.day > 31) {
          const err = new Error('rentDetails.semiAnnualDates day must be between 1 and 31');
          err.status = 400;
          throw err;
        }
      }
    }
  }

  // Business rule: Only one lease should exist for a given property unit considering certain statuses.
  // Consider Active and Submitted as conflicting states for the same unit.
  const CONFLICT_STATUSES = [LEASE_STATUSES.ACTIVE, LEASE_STATUSES.SUBMITTED];
  if (CONFLICT_STATUSES.includes(statusValue)) {
    logger.info('🔍 Checking for existing lease conflicts:', {
      property_id: leaseData.property_id,
      unitName: leaseData.unitName,
      status: statusValue
    });
    
    const q = { property_id: leaseData.property_id, unitName: leaseData.unitName, status: { $in: CONFLICT_STATUSES } };
    let existing;
    if (options.session) existing = await Lease.findOne(q).session(options.session).lean();
    else existing = await Lease.findOne(q).lean();
    
    if (existing) {
      logger.error(' Lease conflict found:', existing);
      const err = new Error('A lease already exists for this unit with status Submitted/Active'); err.status = 409; throw err;
    }
  }

  // Validate tenant users (if rentAndDepositDestribution.split provided): ensure users exist and are not soft-deleted
  if (leaseData.rentAndDepositDestribution && Array.isArray(leaseData.rentAndDepositDestribution.split) && leaseData.rentAndDepositDestribution.split.length > 0) {
    const User = require('../../../../../shared/modules/users/models/user.model');
    const tenantIds = toObjectIds(leaseData.rentAndDepositDestribution.split.map((s) => s && s.tenantId));

    if (tenantIds.length > 0) {
      const query = { _id: { $in: tenantIds } };
      if (options.session) {
        // use session-aware query
        const users = await User.find(query).session(options.session).lean();
        const foundIds = users.map((u) => String(u._id));
        const missing = tenantIds.filter((id) => !foundIds.includes(String(id)));
        const deleted = users.filter((u) => u.isDeleted).map((u) => String(u._id));
        const problems = [];
        if (missing.length) problems.push(`tenant user(s) not found: ${missing.join(', ')}`);
        if (deleted.length) problems.push(`tenant user(s) deleted: ${deleted.join(', ')}`);
        if (problems.length) {
          const err = new Error(problems.join('; '));
          err.status = 400;
          throw err;
        }
      } else {
        const users = await User.find(query).lean();
        const foundIds = users.map((u) => String(u._id));
        const missing = tenantIds.filter((id) => !foundIds.includes(String(id)));
        const deleted = users.filter((u) => u.isDeleted).map((u) => String(u._id));
        const problems = [];
        if (missing.length) problems.push(`tenant user(s) not found: ${missing.join(', ')}`);
        if (deleted.length) problems.push(`tenant user(s) deleted: ${deleted.join(', ')}`);
        if (problems.length) {
          const err = new Error(problems.join('; '));
          err.status = 400;
          throw err;
        }
      }
    }
  }

  const doc = new Lease({
    property_id: leaseData.property_id,
    unitName: leaseData.unitName,
    leaseTerm: leaseData.leaseTerm,
    lease_type: leaseData.lease_type,
    start_date: leaseData.start_date,
    end_date: leaseData.end_date,
    switchMonthToMonth: leaseData.switchMonthToMonth,
    auto_renew: leaseData.auto_renew,
    rentDetails: leaseData.rentDetails || {},
    depositDetails: leaseData.depositDetails || {},
    additionalFees: leaseData.additionalFees,
    rentAndDepositDestribution: leaseData.rentAndDepositDestribution || {},
    includeDamageReport: typeof leaseData.includeDamageReport !== 'undefined' ? leaseData.includeDamageReport : false,
    status: statusValue,
  });

  if (options.session) {
    const docs = await Lease.create([doc], { session: options.session });
    // Run invoice generation asynchronously (do not block createLeaseService)
    (async () => {
      try {
        const invoiceService = require('../../invoice/service/invoice.service');
        // use string id
        await invoiceService.generateInvoicesFromLeaseDueDates(String(docs[0]._id));
      } catch (invErr) {
        // Log and continue; do not fail lease creation because invoice generation failed
        // eslint-disable-next-line no-console
        logger.warn('Failed to generate invoices for lease', docs && docs[0] && docs[0]._id, invErr && invErr.message);
      }
    })();

    return docs[0].toObject();
  }

  const saved = await doc.save();
  // After persisting lease (no external session), generate invoices asynchronously
  (async () => {
    try {
      const invoiceService = require('../../invoice/service/invoice.service');
      await invoiceService.generateInvoicesFromLeaseDueDates(String(saved._id));
    } catch (invErr) {
      // Log and continue; do not fail lease creation because invoice generation failed
      // eslint-disable-next-line no-console
      logger.warn('Failed to generate invoices for lease', saved && saved._id, invErr && invErr.message);
    }
  })();
  return saved.toObject();
}

async function getLeaseByIdService(id) {
  if (!id) {
    const err = new Error('leaseId is required');
    err.status = 400;
    throw err;
  }
  const lease = await Lease.findById(id)
    .populate('property_id', 'name address')
    .lean();
  if (!lease) {
    const err = new Error('Lease not found');
    err.status = 404;
    throw err;
  }
  
  // Manually populate tenant details since tenantId is Mixed type
  if (lease.rentAndDepositDestribution && lease.rentAndDepositDestribution.split) {
    const User = require('../../../../../shared/modules/users/models/user.model');
    const tenantIds = toObjectIds(
      lease.rentAndDepositDestribution.split.map(split => split.tenantId)
    );
    
    if (tenantIds.length > 0) {
      const tenantUsers = await User.find({ _id: { $in: tenantIds } })
        .select('firstName lastName email phone')
        .lean();
      
      lease.rentAndDepositDestribution.split = lease.rentAndDepositDestribution.split.map(split => {
        const tenantUser = tenantUsers.find(user => String(user._id) === String(split.tenantId));
        const tenantDetails = {
          _id: split.tenantId,
          firstName: tenantUser?.firstName,
          lastName: tenantUser?.lastName,
          email: tenantUser?.email,
          phone: tenantUser?.phone,
          rentAmount: split.rentAmount,
          rentPercentage: split.rentPercentage,
          depositAmount: split.depositAmount,
          depositPercentage: split.depositPercentage
        };
        
        return {
          ...split,
          tenantId: split.tenantId,
          tenantDetails
        };
      });
    } else {
      // If no valid tenant IDs, still add tenantDetails structure
      lease.rentAndDepositDestribution.split = lease.rentAndDepositDestribution.split.map(split => ({
        ...split,
        tenantDetails: {
          _id: split.tenantId,
          firstName: null,
          lastName: null,
          email: null,
          phone: null,
          rentAmount: split.rentAmount,
          rentPercentage: split.rentPercentage,
          depositAmount: split.depositAmount,
          depositPercentage: split.depositPercentage
        }
      }));
    }
  }
  
  return lease;
}

async function listLeasesService(query = {}) {
  const filter = {};
  if (query.property_id) filter.property_id = query.property_id;
  if (query.unitName) filter.unitName = query.unitName;
  if (query.status) filter.status = query.status;

  const { getPagination } = require('../../../../../common/helpers/paginationHelper');
  const { pageNumber = 1, pageSize } = query;
  const { offset, limit: effectiveLimit, page, pageSize: effectivePageSize } = getPagination({
    page: pageNumber,
    pageSize
  });

  const [leases, total] = await Promise.all([
    Lease.find(filter)
      .populate('property_id', 'name address unitDetails')
      .sort('-createdAt')
      .skip(offset)
      .limit(effectiveLimit)
      .lean(),
    Lease.countDocuments(filter)
  ]);

  const User = require('../../../../../shared/modules/users/models/user.model');
  const enrichedLeases = await Promise.all(leases.map(async (lease) => {
    let tenants = [];
    if (lease.rentAndDepositDestribution?.split?.length > 0) {
      const tenantIds = toObjectIds(
        lease.rentAndDepositDestribution.split.map(split => split.tenantId)
      );
      
      if (tenantIds.length > 0) {
        const tenantUsers = await User.find({ _id: { $in: tenantIds } })
          .select('firstName lastName email phone')
          .lean();
        
        tenants = tenantUsers.map(t => ({
          _id: t._id,
          name: `${t.firstName || ''} ${t.lastName || ''}`.trim() || 'Unknown',
          email: t.email,
          phone: t.phone
        }));
      }
    }
    return { ...lease, tenants };
  }));

  return {
    data: enrichedLeases,
    total,
    page,
    pageSize: effectivePageSize
  };
}

async function updateLeaseService(id, leaseData, options = {}) {
  if (!id) {
    const err = new Error('leaseId is required');
    err.status = 400;
    throw err;
  }

  // Validate payment frequency specific fields if rentDetails is being updated
  if (leaseData.rentDetails) {
    const { frequency, dueOne, dueTwo, dueWeekday, semiAnnualDates } = leaseData.rentDetails;
    
    // Validate bi-monthly requires dueTwo
    if (frequency === FREQUENCY_TYPES.BI_MONTHLY && !dueTwo) {
      const err = new Error('rentDetails.dueTwo is required for bi-monthly frequency');
      err.status = 400;
      throw err;
    }
    
    // Validate weekly/bi-weekly requires dueWeekday
    if ([FREQUENCY_TYPES.WEEKLY, FREQUENCY_TYPES.BI_WEEKLY].includes(frequency) && (dueWeekday === undefined || dueWeekday === null)) {
      const err = new Error('rentDetails.dueWeekday is required for weekly/bi-weekly frequency');
      err.status = 400;
      throw err;
    }
    
    // Validate dueWeekday is between 0-6
    if ([FREQUENCY_TYPES.WEEKLY, FREQUENCY_TYPES.BI_WEEKLY].includes(frequency) && (dueWeekday < 0 || dueWeekday > 6)) {
      const err = new Error('rentDetails.dueWeekday must be between 0 (Sunday) and 6 (Saturday)');
      err.status = 400;
      throw err;
    }
    
    // Validate semi-annually requires exactly 2 dates
    if (frequency === FREQUENCY_TYPES.SEMI_ANNUALLY) {
      if (!semiAnnualDates || !Array.isArray(semiAnnualDates) || semiAnnualDates.length !== 2) {
        const err = new Error('rentDetails.semiAnnualDates must contain exactly 2 payment dates for semi-annually frequency');
        err.status = 400;
        throw err;
      }
      
      // Validate each date has valid month and day
      for (const date of semiAnnualDates) {
        if (!date.month || date.month < 1 || date.month > 12) {
          const err = new Error('rentDetails.semiAnnualDates month must be between 1 and 12');
          err.status = 400;
          throw err;
        }
        if (!date.day || date.day < 1 || date.day > 31) {
          const err = new Error('rentDetails.semiAnnualDates day must be between 1 and 31');
          err.status = 400;
          throw err;
        }
      }
    }
  }

  // Validate tenant users (if rentAndDepositDestribution.split provided): ensure users exist and are not soft-deleted
  if (leaseData.rentAndDepositDestribution && Array.isArray(leaseData.rentAndDepositDestribution.split) && leaseData.rentAndDepositDestribution.split.length > 0) {
    const User = require('../../../../../shared/modules/users/models/user.model');
    const tenantIds = toObjectIds(leaseData.rentAndDepositDestribution.split.map((s) => s && s.tenantId));

    if (tenantIds.length > 0) {
      const query = { _id: { $in: tenantIds }, isDeleted: { $ne: true } };
      const users = options.session
        ? await User.find(query).session(options.session).lean()
        : await User.find(query).lean();
      const foundIds = users.map((u) => String(u._id));
      const missing = tenantIds.filter((id) => !foundIds.includes(String(id)));
      const problems = [];
      if (missing.length) problems.push(`tenant user(s) not found: ${missing.join(', ')}`);
      if (problems.length) {
        const err = new Error(problems.join('; '));
        err.status = 400;
        throw err;
      }
    }
  }

  // Validate status if provided: must be a known status (model enum)
  if (typeof leaseData.status !== 'undefined' && leaseData.status !== null && leaseData.status !== '') {
    const s = String(leaseData.status).toLowerCase();
    const normalized = s.charAt(0).toUpperCase() + s.slice(1);
    const allowed = Object.values(LEASE_STATUSES);
    if (!allowed.includes(normalized)) {
      const err = new Error(`status must be one of: ${allowed.join(', ')}`);
      err.status = 400;
      throw err;
    }
    // overwrite with normalized
    leaseData.status = normalized;
  }

  const opts = {};
  if (options.session) opts.session = options.session;

  const lease = await Lease.findById(id, null, opts);
  if (!lease) {
    const err = new Error('Lease not found');
    err.status = 404;
    throw err;
  }

  // Business rule: Only one ACTIVE lease should exist for a given property unit.
  // Determine the final values that will be saved and validate conflicts.
  const finalStatus = typeof leaseData.status !== 'undefined' && leaseData.status !== null && leaseData.status !== '' ? leaseData.status : lease.status;
  const finalPropertyId = typeof leaseData.property_id !== 'undefined' && leaseData.property_id !== null ? leaseData.property_id : lease.property_id;
  const finalUnitName = typeof leaseData.unitName !== 'undefined' && leaseData.unitName !== null ? leaseData.unitName : lease.unitName;
  const CONFLICT_STATUSES = [LEASE_STATUSES.ACTIVE, LEASE_STATUSES.SUBMITTED];
  if (CONFLICT_STATUSES.includes(finalStatus)) {
    const conflictQuery = { property_id: finalPropertyId, unitName: finalUnitName, status: { $in: CONFLICT_STATUSES }, _id: { $ne: id } };
    let conflict;
    if (options.session) conflict = await Lease.findOne(conflictQuery).session(options.session).lean();
    else conflict = await Lease.findOne(conflictQuery).lean();
    if (conflict) {
      const err = new Error('A lease already exists for this unit with status Submitted/Active'); err.status = 409; throw err;
    }
  }

  // update allowed fields (expecting full body similar to create)
  lease.property_id = leaseData.property_id;
  lease.unitName = typeof leaseData.unitName !== 'undefined' ? leaseData.unitName : lease.unitName;
  lease.leaseTerm = typeof leaseData.leaseTerm !== 'undefined' ? leaseData.leaseTerm : lease.leaseTerm;
  lease.lease_type = leaseData.lease_type;
  lease.start_date = leaseData.start_date;
  lease.end_date = typeof leaseData.end_date !== 'undefined' ? leaseData.end_date : lease.end_date;
  lease.switchMonthToMonth = typeof leaseData.switchMonthToMonth !== 'undefined' ? leaseData.switchMonthToMonth : lease.switchMonthToMonth;
  lease.auto_renew = typeof leaseData.auto_renew !== 'undefined' ? leaseData.auto_renew : lease.auto_renew;
  lease.rentDetails = typeof leaseData.rentDetails !== 'undefined' ? leaseData.rentDetails : lease.rentDetails;
  lease.depositDetails = typeof leaseData.depositDetails !== 'undefined' ? leaseData.depositDetails : lease.depositDetails;
  lease.additionalFees = typeof leaseData.additionalFees !== 'undefined' ? leaseData.additionalFees : lease.additionalFees;
  lease.rentAndDepositDestribution = typeof leaseData.rentAndDepositDestribution !== 'undefined' ? leaseData.rentAndDepositDestribution : lease.rentAndDepositDestribution;
  if (typeof leaseData.status !== 'undefined') lease.status = leaseData.status;

  const saved = await lease.save(opts);
  return saved.toObject();
}

async function deleteLeaseService(id, options = {}) {
  if (!id) {
    const err = new Error('leaseId is required');
    err.status = 400;
    throw err;
  }

  const opts = {};
  if (options.session) opts.session = options.session;

  const deleted = await Lease.findByIdAndDelete(id, opts);
  if (!deleted) {
    const err = new Error('Lease not found');
    err.status = 404;
    throw err;
  }

  return deleted.toObject();
}

/**
 * Terminates a lease by updating its status to Terminated
 * @param {string} id - The ID of the lease to terminate
 * @param {Object} options - Additional options like session for transactions
 * @returns {Promise<Object>} The updated lease object
 */
async function terminateLeaseService(id, options = {}) {
  if (!id) {
    const err = new Error('leaseId is required');
    err.status = 400;
    throw err;
  }

  const opts = {};
  if (options.session) opts.session = options.session;

  // Find and update the lease status to Terminated
  const lease = await Lease.findById(id, null, opts);
  if (!lease) {
    const err = new Error('Lease not found');
    err.status = 404;
    throw err;
  }

  // Can only terminate Active or Expired leases
  if (![LEASE_STATUSES.ACTIVE, LEASE_STATUSES.EXPIRED].includes(lease.status)) {
    const err = new Error('Only Active or Expired leases can be terminated');
    err.status = 400;
    throw err;
  }

  lease.status = LEASE_STATUSES.TERMINATED;
  const updated = await lease.save(opts);
  return updated.toObject();
}

// Add a note to a lease, with file uploads
async function addNoteToLeaseService(leaseId, description, files = []) {
  if (!leaseId) throw Object.assign(new Error('leaseId is required'), { status: 400 });
  if (!description || typeof description !== 'string') throw Object.assign(new Error('description is required'), { status: 400 });

  // Allowed file extensions and max size
  const allowedExts = ['.jpg', '.jpeg', '.png', '.pdf', '.doc', '.docx', '.txt', '.xlsx', '.xls'];
  const maxSize = 20 * 1024 * 1024; // 20MB
  const path = require('path');
  const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
  const s3Client = require('../../../../../integrations/s3');
  const config = require('../../../../../config/default');
  const UPLOAD_LEASE_SUBDIR = require('../../../../../common/constants/uploads').UPLOAD_LEASE_SUBDIR || 'lease-documents';
  const uploadedMetaIds = [];

  for (const f of files) {
    const ext = path.extname(f.originalname || f.filename || '').toLowerCase();
    if (!allowedExts.includes(ext)) throw Object.assign(new Error(`File extension ${ext} not allowed`), { status: 400 });
    if (f.size > maxSize) throw Object.assign(new Error(`File ${f.originalname || f.filename} exceeds max size 20MB`), { status: 400 });

    // Upload to S3
    const key = s3Client.getKeyForLease ? s3Client.getKeyForLease(leaseId, f.originalname || f.filename) : `${UPLOAD_LEASE_SUBDIR}/${leaseId}/${Date.now()}_${f.originalname || f.filename}`;
    const result = await s3Client.upload({ localFilePath: f.path, key });

    // DocumentMetadata
    const bucketName = config.s3 && config.s3.bucketName ? config.s3.bucketName : (process.env.S3_BUCKET || 'mock-bucket');
    const region = config.s3 && config.s3.region ? config.s3.region : (process.env.AWS_REGION || 'mock-region');
    const contentType = f.mimetype || 'application/octet-stream';
    const size = f.size || 0;
    const metadataDoc = await DocumentMetadata.create({
      key: result.Key || key,
      bucketName,
      region,
      size,
      contentType,
      originalName: f.originalname || f.filename,
      s3Location: result.Location || (s3Client.baseUrl ? `${s3Client.baseUrl}/${key}` : `/${key}`)
    });
    uploadedMetaIds.push(metadataDoc._id);
  }

  // Add note to lease
  const lease = await Lease.findById(leaseId);
  if (!lease) throw Object.assign(new Error('Lease not found'), { status: 404 });
  lease.notes = lease.notes || [];
  lease.notes.push({ description, attachments: uploadedMetaIds });
  await lease.save();
  return lease;
}

/**
 * List leases for a landlord based on status category with pagination.
 * Input: { landlordId, status, propertyId, from, to, pageNumber, pageSize }
 * status values supported:
 *  - Active
 *  - InProcess (Submitted)
 *  - FutureLease (Active and start_date > today)
 *  - Expiring90 (Active and end_date within next 90 days)
 *  - Expired
 *  - Terminated
 * propertyId: filter by specific property
 * from: start date filter
 * to: end date filter
 * Date filter logic:
 *  - If only 'to' is provided: filter from start of 'to' year to 'to' date
 *  - If only 'from' is provided: filter from 'from' date to current date
 *  - If both provided: filter between 'from' and 'to'
 * @returns {Promise<{data: Array, total: number, page: number, pageSize: number}>}
 */
async function listLeasesByLandlordService({ landlordId, status, propertyId, from, to, pageNumber, pageSize }) {
  if (!landlordId) {
    const err = new Error('landlordId is required'); err.status = 400; throw err;
  }

  // 1) fetch properties for landlord
  let propertyFilter = { landlord_id: toObjectId(landlordId) || landlordId };
  if (propertyId) {
    const safePropId = toObjectId(propertyId);
    if (!safePropId) {
      const err = new Error('Invalid propertyId'); err.status = 400; throw err;
    }
    propertyFilter._id = safePropId;
  }
  const properties = await Property.find(propertyFilter).select('_id').lean();
  const propertyIds = properties.map(p => p._id);
  if (!propertyIds || propertyIds.length === 0) {
    return {
      data: [],
      total: 0,
      page: 1,
      pageSize: 10
    };
  }

  // 2) build lease filter based on requested status
  const filter = { property_id: { $in: propertyIds } };

  const now = ClockService.now();
  const in90Days = DateUtil.fromEpoch(ClockService.nowEpoch() + 90 * MS_PER_DAY);

  // Apply date filters - leases that start and end within the date range
  let dateFilter = {};
  if (to && !from) {
    const toDate = DateUtil.toUTC(to);
    const toParts = DateUtil.parseAppYmd(DateUtil.toEST(toDate));
    const startOfYear = toParts ? DateUtil.parseDateOnlyToNoonUtc(`${toParts.y}-01-01`) : null;
    if (toDate && startOfYear) {
      dateFilter = { start_date: { $gte: startOfYear, $lte: toDate }, $or: [{ end_date: { $lte: toDate } }, { end_date: null }] };
    }
  } else if (from && !to) {
    const fromDate = DateUtil.toUTC(from);
    const currentDate = now;
    if (fromDate) {
      dateFilter = { start_date: { $gte: fromDate, $lte: currentDate }, $or: [{ end_date: { $lte: currentDate } }, { end_date: null }] };
    }
  } else if (from && to) {
    const fromDate = DateUtil.toUTC(from);
    const toDate = DateUtil.toUTC(to);
    if (fromDate && toDate) {
      dateFilter = { start_date: { $gte: fromDate, $lte: toDate }, $or: [{ end_date: { $lte: toDate } }, { end_date: null }] };
    }
  }

  if (Object.keys(dateFilter).length > 0) {
    Object.assign(filter, dateFilter);
  }

  switch ((status || '').toLowerCase()) {
    case 'active':
      filter.status = LEASE_STATUSES.ACTIVE;
      break;
    case 'submitted':
      filter.status = LEASE_STATUSES.SUBMITTED;
      break;
    case 'inprocess':
    case 'in-process':
    case 'in_process':
      filter.status = LEASE_STATUSES.SUBMITTED;
      break;
    case 'futurelease':
    case 'future-lease':
    case 'future_lease':
      filter.status = LEASE_STATUSES.ACTIVE;
      filter.start_date = { $gt: now };
      break;
    case 'expiring90':
    case 'expiring-90':
    case 'expiring_90':
      filter.status = LEASE_STATUSES.ACTIVE;
      filter.end_date = { $gte: now, $lte: in90Days };
      break;
    case 'expired':
      filter.status = LEASE_STATUSES.EXPIRED;
      break;
    case 'terminated':
      filter.status = LEASE_STATUSES.TERMINATED;
      break;
    default:
      // if no status provided, return all leases for landlord properties
      break;
  }

  // Get standardized pagination parameters
  const { getPagination } = require('../../../../../common/helpers/paginationHelper');
  const { offset, limit: effectiveLimit, page, pageSize: effectivePageSize } = getPagination({
    page: pageNumber,
    pageSize
  });

  // Execute paginated query and get counts for different lease categories
  const [
    leases, 
    total, 
    activeLeaseCount,
    inProcessLeaseCount,
    futureLeaseCount,
    expiringInNext90Days,
    expiredLease
  ] = await Promise.all([
    Lease.find(filter)
      .populate('property_id', 'name address')
      .skip(offset)
      .limit(effectiveLimit)
      .sort('-createdAt')
      .lean(),
    Lease.countDocuments(filter),
    // Active leases count
    Lease.countDocuments({ 
      property_id: { $in: propertyIds },
      status: LEASE_STATUSES.ACTIVE 
    }),
    // In-process leases count (Submitted status)
    Lease.countDocuments({ 
      property_id: { $in: propertyIds },
      status: LEASE_STATUSES.SUBMITTED
    }),
    // Future leases count (start date in future)
    Lease.countDocuments({ 
      property_id: { $in: propertyIds },
      start_date: { $gt: now }
    }),
    // Leases expiring in next 90 days
    Lease.countDocuments({ 
      property_id: { $in: propertyIds },
      status: LEASE_STATUSES.ACTIVE,
      end_date: { $gte: now, $lte: in90Days }
    }),
    // Expired leases count
    Lease.countDocuments({ 
      property_id: { $in: propertyIds },
      status: LEASE_STATUSES.EXPIRED
    })
  ]);

  // Transform data to return only required fields
  const transformedData = await Promise.all(leases.map(async (lease) => {
    let tenants = [];
    
    // Manually populate tenant details since tenantId is Mixed type
    if (lease.rentAndDepositDestribution?.split?.length > 0) {
      const User = require('../../../../../shared/modules/users/models/user.model');
      const tenantIds = toObjectIds(
        lease.rentAndDepositDestribution.split.map(split => split.tenantId)
      );
      
      if (tenantIds.length > 0) {
        const tenantUsers = await User.find({ _id: { $in: tenantIds } })
          .select('firstName lastName email phone profilePic')
          .populate('profilePic', 's3Location originalName')
          .lean();
        
        tenants = lease.rentAndDepositDestribution.split.map(split => {
          const tenantUser = tenantUsers.find(user => String(user._id) === String(split.tenantId));
          if (tenantUser) {
            const tenantName = `${tenantUser.firstName || ''} ${tenantUser.lastName || ''}`.trim();
            return {
              _id: tenantUser._id,
              name: tenantName || 'Unknown Tenant',
              email: tenantUser.email,
              phone: tenantUser.phone,
              profileImage: tenantUser.profilePic?.s3Location || null,
              rentAmount: split.rentAmount,
              rentPercentage: split.rentPercentage
            };
          }
          return null;
        }).filter(tenant => tenant !== null);
      }
    }

    // Calculate rent status based on invoices
    let rentStatus = 'Paid';
    try {
      const Invoice = require('../../invoice/model/invoice.model');
      const currentDate = ClockService.now();
      const firstDayOfMonth = DateUtil.startOfMonthEST(currentDate);
      
      // Check for current month's rent invoice
      const currentMonthInvoice = await Invoice.findOne({
        lease_id: lease._id,
        dueDate: { $gte: firstDayOfMonth },
        type: 'Rent'
      }).lean();
      
      if (currentMonthInvoice) {
        if (currentMonthInvoice.status === 'Paid') {
          rentStatus = 'Paid';
        } else if (DateUtil.isPast(currentMonthInvoice.dueDate, currentDate)) {
          rentStatus = 'Overdue';
        } else {
          rentStatus = 'Due';
        }
      }
    } catch (invoiceError) {
      logger.warn('Error calculating rent status:', invoiceError.message);
      rentStatus = 'Paid'; // Default to paid if we can't determine status
    }

    return {
      _id: lease._id,
      tenantId: tenants[0]?._id || null,
      name: tenants.map(t => t.name).join(', ') || 'No Tenant',
      email: tenants[0]?.email || 'not-available@email.com',
      phone: tenants[0]?.phone || 'N/A',
      profileImage: tenants[0]?.profileImage || null,
      tenants: tenants.map(t => t.name).join(', '),
      tenantDetails: tenants, // Include full tenant details array
      propertyName: lease.property_id?.name || 'N/A',
      unitName: lease.unitName || 'N/A',
      propertyAddress: lease.property_id?.address || 'N/A',
      address: lease.property_id?.address?.street || 'N/A',
      city: lease.property_id?.address?.city || 'Austin',
      state: lease.property_id?.address?.state || 'TX',
      zip: lease.property_id?.address?.zip || '73301',
      status: lease.status,
      tenantStatus: 'Active',
      accountStatus: 'Verified',
      rentStatus: rentStatus,
      rent: lease.rentDetails?.amount || 0,
      roommates: tenants.length || 1,
      leaseStart: lease.start_date,
      leaseEnd: lease.end_date,
      dates: `${lease.start_date ? formatDateInAppTimezone(lease.start_date) : 'N/A'} - ${lease.end_date ? formatDateInAppTimezone(lease.end_date) : 'N/A'}`,
      documents: 'Unsigned'
    };
  }));

  return {
    data: transformedData,
    activeLeaseCount,
    inProcessLeaseCount,
    futureLeaseCount,
    expiringInNext90Days,
    expiredLease,
    total,
    page,
    pageSize: effectivePageSize
  };
}

// Add a document to a lease and set status to Submitted
// documentMeta is expected to contain { metadataId, originalName, uploadedAt }
async function addDocumentToLeaseService(leaseId, documentMeta, options = {}) {
  if (!leaseId) {
    const err = new Error('leaseId is required');
    err.status = 400;
    throw err;
  }
  if (!documentMeta || !documentMeta.metadataId) {
    const err = new Error('document metadataId is required');
    err.status = 400;
    throw err;
  }

  const opts = {};
  if (options.session) opts.session = options.session;

  const lease = await Lease.findById(leaseId, null, opts);
  if (!lease) {
    const err = new Error('Lease not found');
    err.status = 404;
    throw err;
  }


  // store only a reference to DocumentMetadata
  const doc = {
    metadataId: documentMeta.metadataId,
    originalName: documentMeta.originalName,
    uploadedAt: documentMeta.uploadedAt || ClockService.now(),
  };

  if (options.uploadedBy) doc.uploadedBy = options.uploadedBy;

  // push document and set status to Submitted
  lease.documents = lease.documents || [];
  lease.documents.push(doc);
  lease.status = LEASE_STATUSES.SUBMITTED;

  const saved = await lease.save(opts);
  return saved.toObject();
}

// Upload file to storage, persist metadata into Lease and set status to Submitted.
// This method contains the full business logic for uploading and persisting a lease document.
async function uploadLeaseDocumentService(leaseId, fileObj, options = {}) {
  if (!leaseId) {
    const err = new Error('leaseId is required');
    err.status = 400;
    throw err;
  }
  if (!fileObj || !fileObj.path) {
    const err = new Error('file object with local path is required');
    err.status = 400;
    throw err;
  }

  const s3Client = require('../../../../../integrations/s3');
  const { UPLOAD_LEASE_SUBDIR } = require('../../../../../common/constants/uploads');

  const filename = fileObj.filename || fileObj.originalname;
  const key = s3Client.getKeyForLease ? s3Client.getKeyForLease(leaseId, filename) : `${UPLOAD_LEASE_SUBDIR || 'lease-documents'}/${filename}`;

  // upload to storage first
  let uploadResult;
  try {
    uploadResult = await s3Client.upload({ localFilePath: fileObj.path, key });
  } catch (e) {
    const err = new Error(e && e.message ? e.message : 'Failed to upload file to storage');
    err.status = 500;
    throw err;
  }

  const uploaded = {
    // persist document metadata and pass metadataId to DB
    originalName: fileObj.originalname,
    uploadedAt: ClockService.now(),
  };

  // persist into DB transactionally
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // create metadata record
  const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
    const cfg = require('../../../../../config/default');
    const bucketName = cfg.s3 && cfg.s3.bucketName ? cfg.s3.bucketName : (process.env.S3_BUCKET || 'mock-bucket');
    const region = cfg.s3 && cfg.s3.region ? cfg.s3.region : (process.env.AWS_REGION || 'mock-region');
    const metadataDoc = await DocumentMetadata.create({ key: uploadResult.Key || key, bucketName, region, size: fileObj.size || 0, contentType: fileObj.mimetype || 'application/octet-stream', originalName: fileObj.originalname || filename });
    uploaded.metadataId = metadataDoc._id;
    const updated = await addDocumentToLeaseService(leaseId, uploaded, { session, uploadedBy: options.uploadedBy });
    await session.commitTransaction();
    session.endSession();
    return updated;
  } catch (dbErr) {
    await session.abortTransaction();
    session.endSession();
    // attempt to cleanup uploaded object
    try {
      // Attempt to delete by metadata if possible
  const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
      if (uploaded.metadataId) {
        const meta = await DocumentMetadata.findById(uploaded.metadataId).lean();
        if (meta && meta.key) await s3Client.delete({ key: meta.key });
      } else if (uploaded.key) {
        await s3Client.delete({ key: uploaded.key });
      }
    } catch (delErr) {
      logger.warn('Failed to delete uploaded object after DB failure:', delErr && delErr.message);
    }
    const err = new Error(dbErr && dbErr.message ? dbErr.message : 'Failed to persist uploaded document');
    err.status = dbErr && dbErr.status ? dbErr.status : 500;
    throw err;
  }
}

async function getLeaseByTenantService({ tenantId, propertyId, unit }) {
  if (!tenantId || !propertyId || !unit) {
    const err = new Error('tenantId, propertyId and unit are required');
    err.status = 400;
    throw err;
  }

  const lease = await Lease.findOne({
    property_id: propertyId,
    unitName: unit,
    'rentAndDepositDestribution.split.tenantId': tenantId
  }).lean();

  if (!lease) {
    const err = new Error('Lease not found');
    err.status = 404;
    throw err;
  }

  return lease;
}

module.exports = {
  createLeaseService,
  getLeaseByIdService,
  listLeasesService,
  updateLeaseService,
  deleteLeaseService,
  terminateLeaseService,
  addNoteToLeaseService,
  listLeasesByLandlordService,
  addDocumentToLeaseService,
  uploadLeaseDocumentService,
  getLeaseByTenantService
};
