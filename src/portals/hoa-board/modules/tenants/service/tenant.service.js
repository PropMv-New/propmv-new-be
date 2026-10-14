/**
 * ------------------------------------------------------------------
 * File: tenant.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * tenant.controller
 * ------------------------------------------------------------------
 */

const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const path = require('path');
const os = require('os');

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function sanitizeFilePath(filePath) {
  const resolved = path.resolve(filePath);
  const tmpDir = path.resolve(os.tmpdir());
  const uploadsDir = path.resolve('/tmp');
  if (!resolved.startsWith(tmpDir) && !resolved.startsWith(uploadsDir)) {
    const err = new Error('Invalid file path'); err.status = 400; throw err;
  }
  return resolved;
}
const User = require('../../../../../shared/modules/users/models/user.model');
const {
  getHOATenantRoleRefs,
  buildHOATenantUserFilter,
  assignHOATenantRoleFields,
  isTenantUserRecord,
} = require('../../../../../common/helpers/hoaTenantRole');
const { decryptIfEnabled } = require('../../../../../common/helpers/cryptoHelper');
const { validatePassword } = require('../../../../../common/helpers/validationHelper');
const { UPLOAD_TENANT_SUBDIR } = require('../../../../../common/constants/uploads');
const emailHelper = require('../../../../../common/helpers/emailHelper');
const { logActivity } = require('../../dashboard/service/activity.service');
const { ClockService, DateUtil } = require('../../../../../common/date');
const { parseAppYmd } = require('../../../../../common/helpers/hoaBillingDates');

// Small helper to escape CSV values. Kept in service layer for reuse by CSV export functions.
function csvEscape(val) {
  if (val === null || typeof val === 'undefined') return '';
  const s = String(val);
  if (s.indexOf('"') !== -1) return '"' + s.replace(/"/g, '""') + '"';
  if (s.indexOf(',') !== -1 || s.indexOf('\n') !== -1 || s.indexOf('\r') !== -1) return '"' + s + '"';
  return s;
}

/**
 * Create a tenant user. Expects data: { email, password, phone, firstName, lastName, ... }
 * Ensures a Role named 'Tenant' exists. If not, throws an error.
 * options may include { session }
 */
async function createTenant(userData, options = {}) {
  // If caller provided a session, use it. Otherwise manage a session/transaction here.
  let ownSession = false;
  let session = options && options.session;
  if (!session) {
    session = await mongoose.startSession();
    session.startTransaction();
    ownSession = true;
    options = Object.assign({}, options, { session });
  }

  try {
    const tenantRoleRefs = await getHOATenantRoleRefs(
      options.session ? { session: options.session } : {}
    );
    // Request data shape/format validation has been moved to Joi request validators at the route/controller layer.
    // Service continues to enforce deeper business constraints (role existence, uniqueness, DB lookups, etc.).

    // check duplicate email
    const emailQuery = { email: String(userData.email || '').trim().toLowerCase(), isDeleted: { $ne: true } };
    const existing = options.session ? await User.findOne(emailQuery).session(options.session) : await User.findOne(emailQuery);
    if (existing) {
      const err = new Error('Email already exists');
      err.status = 409;
      throw err;
    }

    // Decrypt password if encryption is enabled (service still supports encrypted inputs)
    let plainPassword;
    try {
      plainPassword = decryptIfEnabled(userData.password);
    } catch (e) {
      const err = new Error('Failed to decrypt password');
      err.status = 400;
      throw err;
    }

    // hash password (use decrypted/plain password)
    const hashed = await bcrypt.hash(plainPassword, 10);

    const userFields = {
      email: userData.email,
      password: hashed,
      phone: userData.phone || null,
      firstName: userData.firstName || null,
      lastName: userData.lastName || null,
      address: userData.address || null,
      state: userData.state || null,
      zipCode: userData.zipCode || null,
      landlordId: userData.landlordId || null,
    };
    await assignHOATenantRoleFields(
      userFields,
      options.session ? { session: options.session } : {}
    );

    if (options.session) {
      try {
        const docs = await User.create([userFields], { session: options.session });
        const created = docs[0];
        if (ownSession) {
          await session.commitTransaction();
          session.endSession();
        }
        if (!options.session || ownSession) {
          await logActivity({
            userId: options.userId || userData.landlordId,
            action: 'CREATE',
            module: 'Tenant',
            entityId: created._id,
            entityName: `${created.firstName || ''} ${created.lastName || ''}`.trim() || created.email,
            description: `Created tenant "${`${created.firstName || ''} ${created.lastName || ''}`.trim() || created.email}"`,
            meta: { email: created.email }
          });
        }
        return created;
      } catch (e) {
        // handle duplicate key race (e.g., another request created the same email concurrently)
        if (ownSession) {
          await session.abortTransaction();
          session.endSession();
        }
        if (e && e.code === 11000) {
          const err = new Error('Email already exists'); err.status = 409; throw err;
        }
        throw e;
      }
    }

    try {
      const user = await User.create(userFields);
      if (ownSession) {
        await session.commitTransaction();
        session.endSession();
      }
      if (!options.session || ownSession) {
        await logActivity({
          userId: options.userId || userData.landlordId,
          action: 'CREATE',
          module: 'Tenant',
          entityId: user._id,
          entityName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email,
          description: `Created tenant "${`${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email}"`,
          meta: { email: user.email }
        });
      }
      return user;
    } catch (e) {
      if (ownSession) {
        await session.abortTransaction();
        session.endSession();
      }
      if (e && e.code === 11000) {
        const err = new Error('Email already exists'); err.status = 409; throw err;
      }
      throw e;
    }
  } catch (e) {
    // If an error occurred and we started the session, ensure it's aborted and ended
    if (ownSession && session) {
      try { await session.abortTransaction(); } catch (ignore) { }
      try { session.endSession(); } catch (ignore) { }
    }
    throw e;
  }
}

module.exports = {
  createTenant,
};

/**
 * Update an existing tenant user.
 * tenantId - string id of the user
 * tenantData - fields to update (may include password)
 * options - may include { session }
 */
async function updateTenant(tenantId, tenantData, options = {}) {
  // If caller provided a session, use it. Otherwise manage a session/transaction here.
  let ownSession = false;
  let session = options && options.session;
  if (!session) {
    session = await mongoose.startSession();
    session.startTransaction();
    ownSession = true;
    options = Object.assign({}, options, { session });
  }

  try {
    if (!tenantId) {
      const err = new Error('tenant id is required');
      err.status = 400;
      throw err;
    }

    // find existing user
    const tenantOid = toObjectId(tenantId);
    if (!tenantOid) { const err = new Error('tenantId must be a valid ObjectId'); err.status = 400; throw err; }
    const findQuery = { _id: tenantOid, isDeleted: { $ne: true } };
    const existing = options.session ? await User.findOne(findQuery).session(options.session) : await User.findOne(findQuery);
    if (!existing) {
      const err = new Error('Tenant not found');
      err.status = 404;
      throw err;
    }

    const tenantRoleRefs = await getHOATenantRoleRefs(
      options.session ? { session: options.session } : {}
    );

    const updateFields = {};

    // allow updating email but ensure uniqueness
    if (tenantData.email && tenantData.email !== existing.email) {
      const dupQuery = { email: tenantData.email, isDeleted: { $ne: true } };
      const dup = options.session ? await User.findOne(dupQuery).session(options.session) : await User.findOne(dupQuery);
      if (dup) {
        const err = new Error('Email already exists');
        err.status = 409;
        throw err;
      }
      updateFields.email = tenantData.email;
    }

    // if password provided, hash it
    if (tenantData.password) {
      let plain;
      try {
        plain = decryptIfEnabled(tenantData.password);
      } catch (e) {
        const err = new Error('Failed to decrypt password'); err.status = 400; throw err;
      }
      const pwdValidation2 = validatePassword(plain);
      if (!pwdValidation2.isValid) {
        const err = new Error(pwdValidation2.errors.join('; ')); err.status = 400; throw err;
      }
      const hashedPwd = await bcrypt.hash(plain, 10);
      updateFields.password = hashedPwd;
    }

    // other basic profile fields
    const allowed = ['phone', 'firstName', 'lastName', 'address', 'state', 'zipCode', 'landlordId'];
    allowed.forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(tenantData, k)) {
        updateFields[k] = tenantData[k] || null;
      }
    });

    // If this user is a Tenant, ensure landlordId exists either on update payload or already on record
    const isTenantUser = isTenantUserRecord(existing, tenantRoleRefs);
    if (isTenantUser) {
      // if landlordId provided in payload, validate it
      if (Object.prototype.hasOwnProperty.call(tenantData, 'landlordId')) {
        if (!tenantData.landlordId) {
          const err = new Error('landlordId is required for tenant users'); err.status = 400; throw err;
        }
        if (!mongoose.Types.ObjectId.isValid(String(tenantData.landlordId))) {
          const err = new Error('landlordId must be a valid ObjectId'); err.status = 400; throw err;
        }
        const landlordUser = await User.findOne({ _id: tenantData.landlordId, isDeleted: { $ne: true } });
        if (!landlordUser) { const err = new Error('landlord user not found'); err.status = 400; throw err; }
        updateFields.landlordId = tenantData.landlordId;
      } else {
        // not provided in update payload - ensure existing record already has it
        if (!existing.landlordId) {
          const err = new Error('landlordId is required for tenant users'); err.status = 400; throw err;
        }
      }
    }

    if (Object.keys(updateFields).length === 0) {
      // nothing to update, return existing
      if (ownSession) {
        await session.commitTransaction();
        session.endSession();
      }
      return existing;
    }

    const opts = { new: true };
    if (options.session) opts.session = options.session;

    const updated = await User.findByIdAndUpdate(tenantId, { $set: updateFields }, opts);

    if (ownSession) {
      await session.commitTransaction();
      session.endSession();
    }

    if (!options.session || ownSession) {
      await logActivity({
        userId: options.userId || updated.landlordId,
        action: 'UPDATE',
        module: 'Tenant',
        entityId: updated._id,
        entityName: `${updated.firstName || ''} ${updated.lastName || ''}`.trim() || updated.email,
        description: `Updated tenant "${`${updated.firstName || ''} ${updated.lastName || ''}`.trim() || updated.email}"`,
        meta: { email: updated.email }
      });
    }

    return updated;
  } catch (e) {
    if (ownSession && session) {
      try { await session.abortTransaction(); } catch (ignore) { }
      try { session.endSession(); } catch (ignore) { }
    }
    throw e;
  }
}

// augment exports
module.exports = Object.assign(module.exports, { updateTenant });

/**
 * List tenants with pagination. Accepts a filter object and pagination parameters.
 * @param {Object} filter - Filter parameters (landlordId required)
 * @param {Object} pagination - Pagination parameters (pageNumber, pageSize)
 * @returns {Promise<{data: Array, total: number, page: number, pageSize: number}>}
 */
async function listTenants(filter = {}, { pageNumber, pageSize } = {}) {
  const tenantRoleFilter = await buildHOATenantUserFilter();

  // Enforce landlordId presence at service boundary so callers get consistent behavior
  const landlordId = filter && filter.landlordId;
  if (!landlordId) {
    const err = new Error('landlordId is required'); err.status = 400; throw err;
  }

  if (!mongoose.Types.ObjectId.isValid(String(landlordId))) {
    const err = new Error('landlordId must be a valid ObjectId'); err.status = 400; throw err;
  }

  // Verify landlord user exists (not soft-deleted)
  const landlordUser = await User.findOne({ _id: landlordId, isDeleted: { $ne: true } });
  if (!landlordUser) {
    const err = new Error('landlord user not found'); err.status = 400; throw err;
  }

  // Build base query for tenant users (exclude soft-deleted) and ensure landlordId matches
  const q = { $and: [tenantRoleFilter, { landlordId }] };

  // Allow additional filters (email, firstName, lastName, etc.) but do not override landlordId
  const { landlordId: _drop, ...rest } = filter || {};
  Object.assign(q, rest);

  // Get standardized pagination parameters
  const { getPagination } = require('../../../../../common/helpers/paginationHelper');
  const { offset, limit: effectiveLimit, page, pageSize: effectivePageSize } = getPagination({
    page: pageNumber,
    pageSize
  });

  // Execute paginated query
  const [users, total] = await Promise.all([
    User.find(q)
      .select('-password')
      .skip(offset)
      .limit(effectiveLimit)
      .lean(),
    User.countDocuments(q)
  ]);

  return {
    data: users,
    total,
    page,
    pageSize: effectivePageSize
  };
}

/**
 * Get a tenant by id
 */
async function getTenantById(tenantId) {
  if (!tenantId) {
    const err = new Error('tenant id is required');
    err.status = 400;
    throw err;
  }
  const user = await User.findOne({ _id: tenantId, isDeleted: { $ne: true } }).select('-password');
  if (!user) {
    const err = new Error('Tenant not found');
    err.status = 404;
    throw err;
  }
  return user;
}

module.exports = Object.assign(module.exports, { listTenants, getTenantById });

/**
 * Get tenant names for filter dropdown - returns only id and name for tenants with leases
 */
async function getTenantNames(landlordId, searchText = '') {
  const Lease = require('../../leasing/model/lease.model');
  const Property = require('../../property/model/property.model');

  if (!landlordId) {
    const err = new Error('landlordId is required'); err.status = 400; throw err;
  }

  if (!mongoose.Types.ObjectId.isValid(String(landlordId))) {
    const err = new Error('landlordId must be a valid ObjectId'); err.status = 400; throw err;
  }

  const landlordOid = new mongoose.Types.ObjectId(String(landlordId));
  const scopedProperties = await Property.find({
    landlord_id: landlordOid,
    isDeleted: { $ne: true },
  })
    .select('_id')
    .lean();

  if (!scopedProperties.length) return [];

  const leases = await Lease.find({
    property_id: { $in: scopedProperties.map((property) => property._id) },
  })
    .select('rentAndDepositDestribution.split.tenantId')
    .lean();

  const tenantIds = new Set();
  leases.forEach(lease => {
    if (lease.rentAndDepositDestribution?.split) {
      lease.rentAndDepositDestribution.split.forEach(split => {
        if (split.tenantId) tenantIds.add(split.tenantId.toString());
      });
    }
  });

  const tenantOids = Array.from(tenantIds).map(toObjectId).filter(Boolean);
  const landlordOidForQuery = toObjectId(landlordId);
  if (!landlordOidForQuery) { const err = new Error('landlordId must be a valid ObjectId'); err.status = 400; throw err; }
  const query = {
    _id: { $in: tenantOids },
    isDeleted: { $ne: true },
    landlordId: landlordOidForQuery
  };

  if (searchText) {
    query.$or = [
      { firstName: { $regex: searchText, $options: 'i' } },
      { lastName: { $regex: searchText, $options: 'i' } }
    ];
  }

  const tenants = await User.find(query)
    .select('_id firstName lastName')
    .limit(4)
    .lean();

  return tenants.map(t => ({
    id: t._id,
    name: `${t.firstName || ''} ${t.lastName || ''}`.trim() || 'N/A'
  }));
}

module.exports = Object.assign(module.exports, { getTenantNames });

/**
 * Soft-delete a tenant by setting isDeleted = true
 */
async function deleteTenant(tenantId, options = {}) {
  // If caller provided a session, use it. Otherwise manage a session/transaction here.
  let ownSession = false;
  let session = options && options.session;
  if (!session) {
    session = await mongoose.startSession();
    session.startTransaction();
    ownSession = true;
    options = Object.assign({}, options, { session });
  }

  try {
    if (!tenantId) {
      const err = new Error('tenant id is required');
      err.status = 400;
      throw err;
    }

    const update = { isDeleted: true };
    const opts = { new: true };
    if (options.session) opts.session = options.session;

    const updated = options.session
      ? await User.findByIdAndUpdate(tenantId, update, opts).session(options.session)
      : await User.findByIdAndUpdate(tenantId, update, opts);

    if (!updated) {
      const err = new Error('Tenant not found');
      err.status = 404;
      throw err;
    }

    if (ownSession) {
      await session.commitTransaction();
      session.endSession();
    }

    if (!options.session || ownSession) {
      await logActivity({
        userId: options.userId || updated.landlordId,
        action: 'DELETE',
        module: 'Tenant',
        entityId: updated._id,
        entityName: `${updated.firstName || ''} ${updated.lastName || ''}`.trim() || updated.email,
        description: `Deleted tenant "${`${updated.firstName || ''} ${updated.lastName || ''}`.trim() || updated.email}"`,
        meta: { email: updated.email }
      });
    }

    return updated;
  } catch (e) {
    if (ownSession && session) {
      try { await session.abortTransaction(); } catch (ignore) { }
      try { session.endSession(); } catch (ignore) { }
    }
    throw e;
  }
}

module.exports = Object.assign(module.exports, { deleteTenant });

/**
 * Add uploaded documents metadata to tenant's documents array
 * uploaded: [{ key, url, originalName }]
 */
async function addDocumentsToTenantService(tenantId, uploaded = [], options = {}) {
  if (!tenantId) {
    const err = new Error('tenant id is required');
    err.status = 400;
    throw err;
  }
  if (!Array.isArray(uploaded) || uploaded.length === 0) {
    const err = new Error('No uploaded files provided');
    err.status = 400;
    throw err;
  }

  // uploaded should be array of metadataId (ObjectId)
  const docsToAdd = uploaded.map(u => ({ metadataId: u.metadataId }));

  const opts = { new: true };
  if (options.session) opts.session = options.session;

  const updated = options.session
    ? await User.findByIdAndUpdate(tenantId, { $push: { documents: { $each: docsToAdd } } }, opts).session(options.session)
    : await User.findByIdAndUpdate(tenantId, { $push: { documents: { $each: docsToAdd } } }, opts);

  if (!updated) {
    const err = new Error('Tenant not found');
    err.status = 404;
    throw err;
  }

  // remove password before returning
  const obj = updated.toObject ? updated.toObject() : updated;
  delete obj.password;
  return obj;
}

module.exports = Object.assign(module.exports, { addDocumentsToTenantService });

/**
 * Setup a tenant and create a lease transactionally.
 * Accepts payload: { tenant: { ... }, lease: { ... } } or legacy where tenant fields are at root and lease under `lease`.
 * Returns { tenant, lease } where tenant has password removed.
 */
async function setupTenant(payload = {}, options = {}) {
  // Create multiple tenants and a lease in a single transaction.
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const body = payload || {};
    const tenantsData = Array.isArray(body.tenants) ? body.tenants : [];
    const leaseData = body.lease;

    if (!Array.isArray(tenantsData) || tenantsData.length === 0) {
      const err = new Error('tenants array is required and must contain at least one tenant');
      err.status = 400;
      throw err;
    }
    if (!leaseData) {
      const err = new Error('lease payload is required in request body as `lease`');
      err.status = 400;
      throw err;
    }

    // Validate property early so we can derive landlordId from the property and
    // ensure tenants created here are associated with the correct landlord.
    if (!leaseData.property_id) {
      const err = new Error('lease.property_id is required'); err.status = 400; throw err;
    }
    if (!mongoose.Types.ObjectId.isValid(String(leaseData.property_id))) {
      const err = new Error('lease.property_id must be a valid ObjectId'); err.status = 400; throw err;
    }
    const Property = require('../../property/model/property.model');
    const propertyExists = await Property.findOne({ _id: leaseData.property_id }).session(session).lean();
    if (!propertyExists) {
      const err = new Error('property not found'); err.status = 400; throw err;
    }
    const landlordIdFromProperty = propertyExists.landlord_id;
    if (!landlordIdFromProperty) { const err = new Error('property is not associated with a landlord'); err.status = 400; throw err; }

    // Create tenants sequentially under the same session
    // We keep a local map of provided tenant keys (if any) to created IDs so rent split entries
    // can reference newly created tenants by key. If no key is provided, email is used as the key.
    const createdTenants = [];
    const createdTenantKeyMap = {}; // key => id
    for (const tData of tenantsData) {
      // enforce presence of explicit key in tenant object
      if (!tData || !tData.key) {
        const err = new Error('each tenant must include an explicit `key` field');
        err.status = 400;
        throw err;
      }
      const providedKey = String(tData.key);
      // ensure no duplicate keys in the same payload
      if (createdTenantKeyMap[providedKey]) {
        const err = new Error(`duplicate tenant key in payload: ${providedKey}`);
        err.status = 400;
        throw err;
      }

      // Enforce request-level validation: each tenant object must include email
      // (even if an existing user is being referenced). This ensures FE submits complete data.
      if (!tData.email) {
        const err = new Error("Without an email address, you will be unable to send documents to be signed, request renter's insurance, or collect payments online. Are you sure you'd like to proceed?"); err.status = 400; throw err;
      }
      // validate email format
      const { isValidEmail } = require('../../../../../common/helpers/validationHelper');
      if (!isValidEmail(tData.email)) {
        const err = new Error('tenant email must be a valid email address'); err.status = 400; throw err;
      }

      // Phone is now optional - only validate if provided
      if (tData.phone) {
        // Accept US phone numbers with optional country code (see comment above)
        const phoneRegex = /^(?:\+?1[-\s]?)?\(?\d{3}\)?[-\s.]?\d{3}[-\s.]?\d{4}$/;
        if (!phoneRegex.test(tData.phone)) {
          const err = new Error('tenant phone must be a valid US phone number'); err.status = 400; throw err;
        }
      }

      // Ensure tenant is associated with the landlord from the property unless explicitly provided
      if (!tData.landlordId) tData.landlordId = landlordIdFromProperty;

      // If a user with the same email already exists, reuse that user instead of creating a new one.
      // If the existing user has no landlordId, set it to the property's landlord. If it has a
      // different landlordId, treat that as an error to avoid cross-landlord tenant reuse.
      let created;
      if (tData.email) {
        const existingUser = await User.findOne({ email: tData.email, isDeleted: { $ne: true } }).session(session);
        if (existingUser) {
          // Existing user found: ensure landlord alignment
          if (!existingUser.landlordId) {
            // set landlordId on existing user within the same transaction
            await User.findByIdAndUpdate(existingUser._id, { $set: { landlordId: landlordIdFromProperty } }, { session });
            // reload the user document
            const reloaded = await User.findById(existingUser._id).session(session);
            created = reloaded;
          } else if (String(existingUser.landlordId) !== String(landlordIdFromProperty)) {
            const err = new Error('Existing tenant user belongs to a different landlord'); err.status = 400; throw err;
          } else {
            created = existingUser;
          }
        } else {
          created = await createTenant(tData, { session, userId: options.userId });
        }
      } else {
        // fallback to creating (createTenant will validate required fields like email)
        created = await createTenant(tData, { session, userId: options.userId });
      }

      createdTenants.push({ created, key: providedKey });
      createdTenantKeyMap[providedKey] = String(created._id || (created.toObject ? created.toObject()._id : ''));
    }

    // Build tenantId list (strings)
    const createdTenantIds = createdTenants.map((t) => String(t.created._id || (t.created.toObject ? t.created.toObject()._id : ''))).filter(Boolean);

    // Prepare rentAndDepositDestribution.split: REQUIRE that the client provides a non-empty split
    // and that the number of split entries equals the number of tenants in this request. Each split
    // item may reference a tenant by `tenantId` or by `key` (which maps to the `key` or email on a
    // tenant in this request). We will map keys to created tenant IDs and validate existence.
    if (!leaseData.rentAndDepositDestribution) leaseData.rentAndDepositDestribution = {};
    const rd = leaseData.rentAndDepositDestribution;

    // enforce presence
    if (!Array.isArray(rd.split) || rd.split.length === 0) {
      const err = new Error('rentAndDepositDestribution.split is required and must contain one entry per tenant');
      err.status = 400;
      throw err;
    }

    // enforce same count as tenants provided
    if (rd.split.length !== createdTenantIds.length) {
      const err = new Error('number of split entries must match number of tenants');
      err.status = 400;
      throw err;
    }

    // Map keys to ids where provided
    for (const s of rd.split) {
      if (s.key) {
        const k = String(s.key);
        if (createdTenantKeyMap[k]) {
          s.tenantId = createdTenantKeyMap[k];
        }
      }
    }



    // If lease.unitName is provided, validate it exists in property's unitDetails
    if (leaseData.unitName) {
      const unitDetails = Array.isArray(propertyExists.unitDetails) ? propertyExists.unitDetails : [];
      const unitNameLower = String(leaseData.unitName).toLowerCase();
      const foundUnit = unitDetails.some((ud) => (ud && ud.unitName && String(ud.unitName).toLowerCase()) === unitNameLower);
      if (!foundUnit) {
        const err = new Error(`unitName '${leaseData.unitName}' not found on property`);
        err.status = 400;
        throw err;
      }
    }

    // Validate that referenced tenantIds exist (either created in this transaction or existing users)
    const referencedIds = rd.split.map((s) => s.tenantId ? String(s.tenantId) : null).filter(Boolean);
    if (referencedIds.length > 0) {
      const users = await User.find({ _id: { $in: referencedIds } }).session(session).lean();
      const foundIds = users.map((u) => String(u._id));
      const missing = referencedIds.filter((id) => !foundIds.includes(id) && !createdTenantIds.includes(id));
      if (missing.length) {
        const err = new Error(`tenant user(s) not found: ${missing.join(', ')}`);
        err.status = 400;
        throw err;
      }
    }

    // Coerce numeric fields to Number and normalize tenantId to string
    rd.split = rd.split.map((s) => {
      const out = Object.assign({}, s);
      if (out.rentAmount !== undefined) out.rentAmount = Number(out.rentAmount);
      if (out.rentPercentage !== undefined) out.rentPercentage = Number(out.rentPercentage);
      if (out.depositAmount !== undefined) out.depositAmount = Number(out.depositAmount);
      if (out.depositPercentage !== undefined) out.depositPercentage = Number(out.depositPercentage);
      if (out.tenantId) out.tenantId = String(out.tenantId);
      return out;
    });

    // Normalize includeDamageReport if present (UI may send booleans or string/checkbox values)
    if (leaseData && typeof leaseData.includeDamageReport !== 'boolean') {
      const v = leaseData.includeDamageReport;
      leaseData.includeDamageReport = (v === true || v === 'true' || v === '1' || v === 1 || v === 'on');
    }

    // Now create the lease under same session
    const leasingService = require('../../leasing/service/lease.service');
    const createdLease = await leasingService.createLeaseService(leaseData, { session });

    await session.commitTransaction();
    session.endSession();

    // Prepare tenant safe payloads (remove passwords).
    // We used the request-level `key` internally to correlate tenants with split items
    // while creating tenants and the lease in the same API. Do not include that `key`
    // in the response - return only the data read from the database (with password removed).
    const tenantsSafe = createdTenants.map(({ created }) => {
      const obj = created && created.toObject ? created.toObject() : (created || {});
      if (obj && obj.password) delete obj.password;
      return obj;
    });

    // Send invitation emails to all tenants (created or existing) now that the
    // transaction has committed and users are persisted. Use the common email helper
    // and the 'invite' template we created. Failures to send email should not
    // cause the API to fail; log them instead.
    (async () => {
      try {
        // Resolve landlord display name for template
        let landlordName = '';
        try {
          const landlordUser = await User.findById(landlordIdFromProperty).lean();
          if (landlordUser) landlordName = `${landlordUser.firstName || ''} ${landlordUser.lastName || ''}`.trim() || (landlordUser.email || 'Landlord');
        } catch (e) {
          landlordName = 'Landlord';
        }

        // Invite URL: prefer INVITE_ACCEPT_URL (explicit invite acceptance link),
        // fall back to INVITE_BASE_URL or FRONTEND_BASE_URL, and finally a temporary default.
        const inviteBase = process.env.INVITE_ACCEPT_URL || process.env.INVITE_BASE_URL || process.env.FRONTEND_BASE_URL || 'https://www.google.com';

        const sendPromises = createdTenants.map(async ({ created }) => {
          try {
            const to = created && (created.email || (created.toObject ? created.toObject().email : null));
            if (!to) return;
            const data = {
              landlordName,
              appName: process.env.APP_NAME || 'propmv',
              inviteUrl: inviteBase,
            };
            // use template name 'invite' explicitly
            await emailHelper.sendEmail('invite', to, data, {
              template: 'invite',
              hoaId: property?.hoaId || null,
              senderUserId: landlordIdFromProperty || null,
            });
          } catch (e) {
            // Log and continue
            // eslint-disable-next-line no-console
            logger.warn('Failed to send tenant invite email to', created && created.email, e && e.message);
          }
        });

        await Promise.all(sendPromises);
      } catch (e) {
        // top-level unexpected error while sending invites should not break response
        // eslint-disable-next-line no-console
        logger.warn('Unexpected error sending tenant invite emails:', e && e.message);
      }
    })();

    // For easier referencing by clients, attach a minimal tenant object to each split entry
    // on the lease using the user records from the User collection. We do this after the
    // transaction commits so we read the most recent user documents (created above).
    try {
      const tenantIdsUsed = Array.isArray(rd.split) ? rd.split.map(s => s.tenantId).filter(Boolean) : [];
      if (tenantIdsUsed.length > 0) {
        const tenantUsers = await User.find({ _id: { $in: tenantIdsUsed } }).select('-password').lean();
        const userMap = tenantUsers.reduce((acc, u) => { acc[String(u._id)] = u; return acc; }, {});

        // convert createdLease to plain object if needed
        const leaseObj = createdLease && createdLease.toObject ? createdLease.toObject() : (createdLease || {});
        if (leaseObj && leaseObj.rentAndDepositDestribution && Array.isArray(leaseObj.rentAndDepositDestribution.split)) {
          leaseObj.rentAndDepositDestribution.split = leaseObj.rentAndDepositDestribution.split.map((sp) => {
            const out = Object.assign({}, sp);
            const tid = out.tenantId ? String(out.tenantId) : null;
            if (tid && userMap[tid]) {
              out.tenant = userMap[tid];
            } else {
              out.tenant = null;
            }
            return out;
          });
        }

        return { tenants: tenantsSafe, lease: leaseObj };
      }
    } catch (attachErr) {
      // Non-fatal: if we fail to attach tenant info, return created lease as-is
      // (do not fail the overall request because of this enrichment step)
      // eslint-disable-next-line no-console
      logger.warn('Failed to attach tenant user info to lease split:', attachErr && attachErr.message);
    }

    return { tenants: tenantsSafe, lease: createdLease };
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

module.exports = Object.assign(module.exports, { setupTenant });

/**
 * Update tenant setup and lease details transactionally.
 * Accepts payload: { tenant: { ... }, lease: { ... } } and tenantId.
 * Returns { tenant, lease } where tenant has password removed.
 */
async function updateTenantSetup(tenantId, payload = {}, options = {}) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    if (!tenantId) {
      const err = new Error('tenantId is required');
      err.status = 400;
      throw err;
    }

    const body = payload || {};
    const tenantData = body.tenant || {};
    const leaseData = body.lease || {};

    // Update tenant if tenant data provided
    let updatedTenant = null;
    if (Object.keys(tenantData).length > 0) {
      updatedTenant = await updateTenant(tenantId, tenantData, { session, userId: options.userId });
    } else {
      // Get existing tenant
      updatedTenant = await User.findById(tenantId).session(session);
      if (!updatedTenant) {
        const err = new Error('Tenant not found');
        err.status = 404;
        throw err;
      }
    }

    // Update lease if lease data provided
    let updatedLease = null;
    if (Object.keys(leaseData).length > 0 && leaseData.leaseId) {
      // Normalize includeDamageReport if present (UI may send booleans or string/checkbox values)
      if (leaseData && typeof leaseData.includeDamageReport !== 'boolean') {
        const v2 = leaseData.includeDamageReport;
        leaseData.includeDamageReport = (v2 === true || v2 === 'true' || v2 === '1' || v2 === 1 || v2 === 'on');
      }
      const leasingService = require('../../leasing/service/lease.service');
      updatedLease = await leasingService.updateLeaseService(leaseData.leaseId, leaseData, { session });
    }

    await session.commitTransaction();
    session.endSession();

    // Prepare safe tenant payload (remove password)
    const tenantSafe = updatedTenant && updatedTenant.toObject ? updatedTenant.toObject() : (updatedTenant || {});
    if (tenantSafe && tenantSafe.password) delete tenantSafe.password;

    return {
      tenant: tenantSafe,
      lease: updatedLease
    };
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

/**
 * Resend invitation email to a tenant for a given property.
 * Fetch tenant and property, resolve landlord, and send invite using emailHelper.
 */
async function resendInviteService(propertyId, tenantId) {
  if (!propertyId) { const err = new Error('propertyId is required'); err.status = 400; throw err; }
  if (!tenantId) { const err = new Error('tenantId is required'); err.status = 400; throw err; }
  if (!mongoose.Types.ObjectId.isValid(String(propertyId))) { const err = new Error('propertyId must be a valid ObjectId'); err.status = 400; throw err; }
  if (!mongoose.Types.ObjectId.isValid(String(tenantId))) { const err = new Error('tenantId must be a valid ObjectId'); err.status = 400; throw err; }

  const Property = require('../../property/model/property.model');
  const property = await Property.findById(propertyId).lean();
  if (!property) { const err = new Error('property not found'); err.status = 404; throw err; }

  const tenantUser = await User.findOne({ _id: tenantId, isDeleted: { $ne: true } }).lean();
  if (!tenantUser) { const err = new Error('tenant user not found'); err.status = 404; throw err; }

  const landlordId = property.landlord_id;
  if (!landlordId) { const err = new Error('property is not associated with a landlord'); err.status = 400; throw err; }

  const landlordUser = await User.findOne({ _id: landlordId, isDeleted: { $ne: true } }).lean();
  const landlordName = landlordUser ? `${landlordUser.firstName || ''} ${landlordUser.lastName || ''}`.trim() || (landlordUser.email || 'Landlord') : 'Landlord';

  // prepare template data
  const data = {
    landlordName,
    appName: process.env.APP_NAME || 'propmv',
    inviteUrl: process.env.INVITE_ACCEPT_URL || process.env.INVITE_BASE_URL || process.env.FRONTEND_BASE_URL || 'https://www.google.com',
  };

  try {
    await emailHelper.sendEmail('invite', tenantUser.email, data, {
      template: 'invite',
      hoaId: property?.hoaId || null,
      senderUserId: landlordId || null,
    });
  } catch (e) {
    const err = new Error('Failed to send invite email: ' + (e && e.message ? e.message : String(e)));
    err.status = 500;
    throw err;
  }
}

module.exports = Object.assign(module.exports, { resendInviteService });

// Upload files to storage and persist mapping transactionally
async function uploadTenantDocuments(tenantId, files = []) {
  if (!tenantId) {
    const err = new Error('tenant id is required'); err.status = 400; throw err;
  }
  if (!Array.isArray(files) || files.length === 0) {
    const err = new Error('No files provided'); err.status = 400; throw err;
  }

  const s3Client = require('../../../../../integrations/s3');
  const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
  const config = require('../../../../../config/default');
  const uploaded = [];
  try {
    for (const f of files) {
      const filename = f.filename || f.originalname;
      const key = s3Client.getKeyForTenant ? s3Client.getKeyForTenant(tenantId, filename) : `${UPLOAD_TENANT_SUBDIR || 'tenants'}/${filename}`;
      const safePath = sanitizeFilePath(f.path);
      const result = await s3Client.upload({ localFilePath: safePath, key });

      // Read bucket/region from config/env
      const bucketName = config.s3 && config.s3.bucketName ? config.s3.bucketName : (process.env.S3_BUCKET || 'mock-bucket');
      const region = config.s3 && config.s3.region ? config.s3.region : (process.env.AWS_REGION || 'mock-region');
      const contentType = f.mimetype || 'application/octet-stream';
      const size = f.size || 0;

      // Insert metadata into MongoDB
      const metadataDoc = await DocumentMetadata.create({
        key: result.Key || key,
        bucketName,
        region,
        size,
        contentType,
        originalName: filename
      });

      uploaded.push({ metadataId: metadataDoc._id });
    }

    // persist mapping in DB within a transaction
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const saved = await addDocumentsToTenantService(tenantId, uploaded, { session });
      await session.commitTransaction();
      session.endSession();

      // cleanup temp files
      for (const f of files) {
        try { require('fs').unlinkSync(sanitizeFilePath(f.path)); } catch (ignore) { /* ignore */ }
      }

      return saved;
    } catch (dbErr) {
      await session.abortTransaction();
      session.endSession();
      // delete uploaded objects (resolve metadataId -> key)
      try {
        const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
        for (const u of uploaded) {
          try {
            if (u.metadataId) {
              const meta = await DocumentMetadata.findById(u.metadataId).lean();
              if (meta && meta.key) await s3Client.delete({ key: meta.key });
            }
          } catch (ignore) { }
        }
      } catch (ignore) { }
      // cleanup temp files
      for (const f of files) {
        try { require('fs').unlinkSync(sanitizeFilePath(f.path)); } catch (ignore) { /* ignore */ }
      }
      throw dbErr;
    }
  } catch (e) {
    // If upload to storage failed, attempt to cleanup any partial temp files and rethrow
    for (const f of files) {
      try { require('fs').unlinkSync(sanitizeFilePath(f.path)); } catch (ignore) { /* ignore */ }
    }
    throw e;
  }
}

module.exports = Object.assign(module.exports, { uploadTenantDocuments });

/**
 * Export tenants as CSV for a landlord. Accepts same filter as listTenants (requires landlordId).
 * Returns: { filename, csv }
 */
async function exportTenantsCsvService(filter = {}) {
  // Ensure landlordId present (defensive)
  const landlordId = filter && filter.landlordId;
  if (!landlordId) {
    const err = new Error('landlordId is required'); err.status = 400; throw err;
  }

  // Reuse listTenants to apply the same filtering and tenant resolution
  const tenants = await listTenants(filter);

  // Header fields we want to export
  const headers = ['id', 'email', 'firstName', 'lastName', 'phone', 'address', 'state', 'zipCode', 'createdAt'];

  const rows = [headers.join(',')];
  for (const t of tenants || []) {
    const row = [
      csvEscape(t._id || ''),
      csvEscape(t.email || ''),
      csvEscape(t.firstName || ''),
      csvEscape(t.lastName || ''),
      csvEscape(t.phone || ''),
      csvEscape(t.address || ''),
      csvEscape(t.state || ''),
      csvEscape(t.zipCode || ''),
      csvEscape(t.createdAt ? DateUtil.toISO(t.createdAt) : ''),
    ];
    rows.push(row.join(','));
  }

  const csv = rows.join('\n');
  const filename = `tenants_export_${landlordId}_${Date.now()}.csv`;
  return { filename, csv };
}

module.exports = Object.assign(module.exports, { exportTenantsCsvService });
/**
 * Import tenants from a CSV file at local path `filePath`.
 * landlordId must be provided (resolved from request query) and will be applied to all imported tenants.
 * Expected CSV headers (case-insensitive):
 * email,phone,password,firstName,lastName,address,state,zipCode
 * Returns summary: { created: [{email,id}], failed: [{row,line,reason}] }
 */
async function importTenantsFromCsv(filePath, landlordId) {
  const fs = require('fs');
  const path = require('path');
  if (!filePath) { const err = new Error('filePath is required'); err.status = 400; throw err; }
  if (!fs.existsSync(filePath)) { const err = new Error('uploaded file not found'); err.status = 400; throw err; }

  // landlordId must be provided by the caller (controller) and must reference an existing landlord user
  if (!landlordId) { const err = new Error('landlordId is required'); err.status = 400; throw err; }
  if (!mongoose.Types.ObjectId.isValid(String(landlordId))) { const err = new Error('landlordId must be a valid ObjectId'); err.status = 400; throw err; }
  const landlordOid = toObjectId(landlordId);
  if (!landlordOid) { const err = new Error('landlordId must be a valid ObjectId'); err.status = 400; throw err; }
  const landlord = await User.findOne({ _id: landlordOid, isDeleted: { $ne: true } });
  if (!landlord) { const err = new Error('landlord user not found'); err.status = 400; throw err; }

  const content = fs.readFileSync(filePath, 'utf8');
  // Normalize newlines and split lines
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim() !== '');
  if (lines.length === 0) { const err = new Error('empty file'); err.status = 400; throw err; }

  // parse header
  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const required = ['email', 'phone', 'password', 'firstname', 'lastname', 'address', 'state', 'zipcode'];
  for (const r of required) {
    if (!header.includes(r)) {
      const err = new Error(`missing required column: ${r}`); err.status = 400; throw err;
    }
  }

  const idx = {}; header.forEach((h, i) => idx[h] = i);

  const created = [];
  const failed = [];

  // Process rows sequentially to avoid DB contention
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // simple CSV split - assumes no embedded commas or quotes in input cells
    const cols = line.split(',').map(c => c.trim());
    const rowNum = i + 1;
    try {
      const email = cols[idx['email']] || '';
      const phone = cols[idx['phone']] || '';
      const password = cols[idx['password']] || '';
      const firstName = cols[idx['firstname']] || '';
      const lastName = cols[idx['lastname']] || '';
      const address = cols[idx['address']] || '';
      const state = cols[idx['state']] || '';
      const zipCode = cols[idx['zipcode']] || '';
      // Build tenant payload. landlordId is passed to the service and applied to all rows.
      if (!email || !phone || !password || !firstName || !lastName) {
        failed.push({ line: rowNum, reason: 'required fields missing', row: line });
        continue;
      }

      const payload = {
        email, phone, password, firstName, lastName, address, state, zipCode,
        landlordId: String(landlord._id)
      };

      try {
        const createdUser = await createTenant(payload);
        created.push({ email: createdUser.email, id: String(createdUser._id) });
      } catch (e) {
        failed.push({ line: rowNum, reason: e && e.message ? e.message : 'create failed', row: line });
      }
    } catch (e) {
      failed.push({ line: i + 1, reason: e && e.message ? e.message : 'parse error', row: lines[i] });
    }
  }

  return { created, failed, totalRows: lines.length - 1 };
}

module.exports = Object.assign(module.exports, { importTenantsFromCsv });

/**
 * List tenants with advanced filtering, pagination, and property/lease data
 * Implementation is lease-based: fetch leases first, then get tenant and property details
 * @param {Object} filter - Filter parameters
 * @param {Object} pagination - Pagination parameters
 * @returns {Promise<{data: Array, total: number, page: number, pageSize: number}>}
 */
async function listTenantsWithDetails(filter = {}, pagination = {}) {
  const { getPagination } = require('../../../../../common/helpers/paginationHelper');
  const Property = require('../../property/model/property.model');
  const Lease = require('../../leasing/model/lease.model');
  const { LEASE_STATUSES } = require('../../../../../common/constants/lease');
  const { TENANT_STATUSES } = require('../../../../../common/constants/tenant');

  // Get pagination parameters
  const { offset, limit: effectiveLimit, page, pageSize: effectivePageSize } = getPagination({
    page: pagination.pageNumber,
    pageSize: pagination.pageSize
  });

  // Build lease query based on filters
  const leaseQuery = {};

  if (filter.propertyId) {
    leaseQuery.property_id = filter.propertyId;
  }
  if (filter.unit) {
    // Support both single unit (string) and multiple units (array)
    const units = Array.isArray(filter.unit) ? filter.unit : [filter.unit];
    leaseQuery.unitName = { $in: units };
  }

  // Get all leases with tenant splits
  const leases = await Lease.find(leaseQuery)
    .populate('property_id')
    .lean();

  if (leases.length === 0) {
    return {
      data: [],
      total: 0,
      page,
      pageSize: effectivePageSize
    };
  }

  // Extract all tenant IDs from lease splits
  const allTenantIds = new Set();
  const leaseTenantsMap = {};

  leases.forEach(lease => {
    if (lease.rentAndDepositDestribution?.split) {
      lease.rentAndDepositDestribution.split.forEach(split => {
        const tenantId = split.tenantId.toString();
        allTenantIds.add(tenantId);

        if (!leaseTenantsMap[tenantId]) {
          leaseTenantsMap[tenantId] = [];
        }

        leaseTenantsMap[tenantId].push({
          lease,
          property: lease.property_id,
          rentAmount: split.rentAmount,
          roommates: lease.rentAndDepositDestribution.split.length - 1,
          leaseId: lease._id
        });
      });
    }
  });

  // Build tenant query with filters
  const tenantQuery = {
    _id: { $in: Array.from(allTenantIds) },
    isDeleted: { $ne: true }
  };

  if (filter.tenantId) {
    tenantQuery._id = filter.tenantId;
  }
  if (filter.landlordId) {
    tenantQuery.landlordId = filter.landlordId;
  }

  // Get ALL tenants without pagination first (to apply status filter)
  const allTenants = await User.find(tenantQuery)
    .select('-password')
    .lean();

  // Helper function to determine tenant status based on lease
  const getTenantStatus = (tenant, tenantLeases) => {
    if (tenant.isArchived) {
      return TENANT_STATUSES.ARCHIVED;
    }

    // Find the most relevant lease (active first, then by start date)
    const activeLease = tenantLeases.find(tl => tl.lease.status === LEASE_STATUSES.ACTIVE);
    if (activeLease) {
      return TENANT_STATUSES.ACTIVE;
    }

    const now = ClockService.now();
    const futureLease = tenantLeases.find(tl => tl.lease.start_date && DateUtil.isFuture(tl.lease.start_date, now));
    if (futureLease) {
      return TENANT_STATUSES.FUTURE;
    }

    const expiredLease = tenantLeases.find(tl =>
      tl.lease.end_date && DateUtil.isPast(tl.lease.end_date, now)
    );
    if (expiredLease) {
      return TENANT_STATUSES.PAST;
    }

    return TENANT_STATUSES.ACTIVE; // Default fallback
  };

  // Build full response data with status
  const allResponseData = allTenants.map(tenant => {
    const tenantLeases = leaseTenantsMap[tenant._id.toString()] || [];
    const primaryLease = tenantLeases[0]; // Take first lease as primary

    const tenantStatus = getTenantStatus(tenant, tenantLeases);

    return {
      tenantId: tenant._id,
      name: `${tenant.firstName || ''} ${tenant.lastName || ''}`.trim() || 'N/A',
      propertyName: primaryLease?.property?.name || 'N/A',
      unitName: primaryLease?.lease?.unitName || 'N/A',
      address: tenant.address ||
        (primaryLease?.property ?
          `${primaryLease.property.address?.street || ''} ${primaryLease.property.address?.city || ''} ${primaryLease.property.address?.state || ''} ${primaryLease.property.address?.zip || ''}`.trim() || 'N/A'
          : 'N/A'),
      accountStatus: '', // Keep blank as requested
      tenantStatus,
      rent: primaryLease?.rentAmount || 0,
      roommates: primaryLease?.roommates || 0,
      leaseId: primaryLease?.leaseId || null,
      leaseStart: primaryLease?.lease?.start_date ? DateUtil.toISO(primaryLease.lease.start_date) : null,
      leaseEnd: primaryLease?.lease?.end_date ? DateUtil.toISO(primaryLease.lease.end_date) : null
    };
  });

  // Apply status filter if provided
  const filteredData = filter.status
    ? allResponseData.filter(item => item.tenantStatus === filter.status)
    : allResponseData;

  // Apply pagination AFTER filtering
  const paginatedData = filteredData.slice(offset, offset + effectiveLimit);
  const totalFiltered = filteredData.length;

  return {
    data: paginatedData,
    total: totalFiltered,
    page,
    pageSize: effectivePageSize
  };
}

module.exports = Object.assign(module.exports, { listTenantsWithDetails });

/**
 * Archive a tenant
 */
async function archiveTenant(tenantId, options = {}) {
  if (!tenantId) {
    const err = new Error('tenant id is required');
    err.status = 400;
    throw err;
  }

  const opts = { new: true };
  if (options.session) opts.session = options.session;

  const updated = await User.findByIdAndUpdate(
    tenantId,
    { $set: { isArchived: true } },
    opts
  );

  if (!updated) {
    const err = new Error('Tenant not found');
    err.status = 404;
    throw err;
  }

  const obj = updated.toObject ? updated.toObject() : updated;
  delete obj.password;

  await logActivity({
    userId: options.userId || updated.landlordId,
    action: 'ARCHIVE',
    module: 'Tenant',
    entityId: updated._id,
    entityName: `${updated.firstName || ''} ${updated.lastName || ''}`.trim() || updated.email,
    description: `Archived tenant "${`${updated.firstName || ''} ${updated.lastName || ''}`.trim() || updated.email}"`,
    meta: { email: updated.email }
  });
  return obj;
}

/**
 * Unarchive a tenant
 */
async function unarchiveTenant(tenantId, options = {}) {
  if (!tenantId) {
    const err = new Error('tenant id is required');
    err.status = 400;
    throw err;
  }

  const opts = { new: true };
  if (options.session) opts.session = options.session;

  const updated = await User.findByIdAndUpdate(
    tenantId,
    { $set: { isArchived: false } },
    opts
  );

  if (!updated) {
    const err = new Error('Tenant not found');
    err.status = 404;
    throw err;
  }

  const obj = updated.toObject ? updated.toObject() : updated;
  delete obj.password;

  await logActivity({
    userId: options.userId || updated.landlordId,
    action: 'RESTORE',
    module: 'Tenant',
    entityId: updated._id,
    entityName: `${updated.firstName || ''} ${updated.lastName || ''}`.trim() || updated.email,
    description: `Unarchived tenant "${`${updated.firstName || ''} ${updated.lastName || ''}`.trim() || updated.email}"`,
    meta: { email: updated.email }
  });
  return obj;
}

module.exports = Object.assign(module.exports, { archiveTenant, unarchiveTenant });

/**
 * Get tenant details with lease, invoice, and event information
 */
async function getTenantDetailsService(leaseId, tenantId) {
  const logger = require('../../../../../common/logger');

  logger.info('getTenantDetailsService called', { leaseId, tenantId });

  if (!tenantId) {
    logger.error('getTenantDetailsService: tenantId is required');
    const err = new Error('tenantId is required');
    err.status = 400;
    throw err;
  }

  if (!mongoose.Types.ObjectId.isValid(tenantId)) {
    logger.error('getTenantDetailsService: Invalid tenantId format', { tenantId });
    const err = new Error('Invalid tenantId format');
    err.status = 400;
    throw err;
  }

  if (leaseId && !mongoose.Types.ObjectId.isValid(leaseId)) {
    logger.error('getTenantDetailsService: Invalid leaseId format', { leaseId });
    const err = new Error('Invalid leaseId format');
    err.status = 400;
    throw err;
  }

  // Initialize variables outside try block
  let lease = null;
  let collectionStats = {
    totalRentCollected: 0,
    otherCollected: 0,
    total: 0,
    currentInvoices: []
  };
  let tenant = null;
  let formattedLeaseHistory = [];
  let latestEvents = [];

  try {
    // Always fetch tenant details from User collection
    logger.info('Fetching tenant details from User collection', { tenantId });

    tenant = await User.findOne({
      _id: tenantId,
      isDeleted: { $ne: true }
    })
      .select('-password -resetPasswordToken -resetPasswordExpiresAt -resetPasswordOtp -resetPasswordOtpExpiresAt -refreshToken')
      .lean();

    if (!tenant) {
      logger.error('getTenantDetailsService: Tenant not found or deleted', { tenantId });
      const err = new Error('Tenant not found or has been deleted');
      err.status = 404;
      throw err;
    }

    logger.info('Tenant details retrieved from User collection', { tenantId, tenantName: `${tenant.firstName} ${tenant.lastName}` });

    // Fetch lease details and collection stats only if leaseId is provided
    if (leaseId) {
      logger.info('Fetching lease details from Lease collection', { leaseId });

      const Lease = require('../../leasing/model/lease.model');
      const leaseDoc = await Lease.findById(leaseId).lean();

      if (!leaseDoc) {
        logger.error('getTenantDetailsService: Lease not found', { leaseId });
        const err = new Error('Lease not found');
        err.status = 404;
        throw err;
      }

      // Verify tenant exists in this lease
      const tenantExistsInLease = leaseDoc.rentAndDepositDestribution?.split?.some(
        split => split.tenantId?.toString() === tenantId
      );

      if (!tenantExistsInLease) {
        logger.error('getTenantDetailsService: Tenant not found in lease', { leaseId, tenantId });
        const err = new Error('Tenant not found in this lease');
        err.status = 404;
        throw err;
      }

      logger.info('Lease found and tenant verified', { leaseId, tenantId });

      lease = {
        _id: leaseDoc._id,
        start_date: leaseDoc.start_date,
        end_date: leaseDoc.end_date,
        status: leaseDoc.status,
        rentDetails: leaseDoc.rentDetails,
        depositDetails: leaseDoc.depositDetails
      };

      // Fetch collection stats from Invoice collection
      const Invoice = require('../../invoice/model/invoice.model');
      const { INVOICE_TYPES, INVOICE_STATUS, HOA_UNIT_SCHEDULE_INVOICE_TYPES } = require('../../../../../common/constants/invoice');

      logger.info('Fetching collection stats from Invoice collection', { leaseId });

      const leaseOid = toObjectId(leaseId);
      if (!leaseOid) { const err = new Error('leaseId must be a valid ObjectId'); err.status = 400; throw err; }
      const invoices = await Invoice.find({ lease_id: leaseOid })
        .sort({ createdAt: -1 })
        .lean();

      logger.info('Invoices retrieved for collection stats', { leaseId, invoiceCount: invoices.length });

      // Filter for current month and past due invoices
      const now = ClockService.now();
      const todayParts = parseAppYmd(DateUtil.toEST(now));

      const currentMonthInvoice = invoices.find(inv => {
        const invoiceParts = parseAppYmd(DateUtil.toEST(inv.createdAt));
        if (!invoiceParts || !todayParts) return false;
        return invoiceParts.y === todayParts.y && invoiceParts.m === todayParts.m;
      });

      const pastDueInvoices = invoices.filter(inv => {
        return inv.status !== INVOICE_STATUS.PAID && inv.dueDate && DateUtil.isPast(inv.dueDate, now);
      });

      const relevantInvoices = [];
      if (currentMonthInvoice) relevantInvoices.push(currentMonthInvoice);
      relevantInvoices.push(...pastDueInvoices);

      logger.info('Filtered invoices for current month and past due', {
        leaseId,
        currentMonthInvoice: !!currentMonthInvoice,
        pastDueCount: pastDueInvoices.length
      });

      const paidInvoices = invoices.filter(inv => inv?.status === INVOICE_STATUS.PAID);

      const totalRentCollected = paidInvoices
        .filter(inv => HOA_UNIT_SCHEDULE_INVOICE_TYPES.includes(String(inv?.type || '')))
        .reduce((sum, inv) => sum + (inv?.subAmount || 0), 0);

      const otherCollected = paidInvoices
        .filter(inv => inv?.type && !HOA_UNIT_SCHEDULE_INVOICE_TYPES.includes(String(inv.type)))
        .reduce((sum, inv) => sum + (inv?.subAmount || 0), 0);

      const totalCollected = totalRentCollected + otherCollected;

      logger.info('Collection statistics calculated from Invoice collection', {
        leaseId,
        totalRentCollected,
        otherCollected,
        totalCollected
      });

      collectionStats = {
        totalRentCollected: Number(totalRentCollected.toFixed(2)),
        otherCollected: Number(otherCollected.toFixed(2)),
        total: Number(totalCollected.toFixed(2)),
        currentInvoices: relevantInvoices
      };
    }

    // Always fetch lease history from Lease collection for the tenant
    logger.info('Fetching lease history from Lease collection', { tenantId });

    const Lease = require('../../leasing/model/lease.model');
    const tenantOidForHistory = toObjectId(tenantId);
    const leaseHistory = await Lease.find({
      'rentAndDepositDestribution.split.tenantId': tenantOidForHistory,
      ...(leaseId && { _id: { $ne: leaseId } }) // Exclude current lease if leaseId provided
    })
      .select('start_date end_date rentDetails')
      .sort({ start_date: -1 })
      .lean();

    logger.info('Lease history retrieved from Lease collection', { tenantId, historyCount: leaseHistory.length });

    const now = ClockService.now();
    formattedLeaseHistory = (leaseHistory || []).map(historyLease => {
      const daysRemaining = historyLease.end_date && !DateUtil.isPast(historyLease.end_date, now)
        ? DateUtil.diffDays(now, historyLease.end_date)
        : 0;

      return {
        monthlyRent: historyLease.rentDetails?.amount || 0,
        startDate: historyLease.start_date,
        endDate: historyLease.end_date,
        daysRemaining
      };
    });

    // Fetch messages from Events collection based on tenant's properties
    logger.info('Fetching messages from Events collection for tenant', { tenantId });

    const Event = require('../../events/model/event.model');

    if (lease && lease.property_id) {
      // If lease provided, get events for that property
      const propertyOid = toObjectId(lease.property_id);
      latestEvents = await Event.find({
        propertyId: propertyOid
      })
        .populate('from', 'firstName lastName email')
        .populate('to', 'firstName lastName email')
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();

      logger.info('Messages retrieved from Events collection for property', { propertyId: lease.property_id, eventCount: latestEvents.length });
    } else {
      // If no lease, get events where tenant is involved
      latestEvents = await Event.find({
        $or: [
          { from: tenantId },
          { to: tenantId }
        ]
      })
        .populate('from', 'firstName lastName email')
        .populate('to', 'firstName lastName email')
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();

      logger.info('Messages retrieved from Events collection for tenant', { tenantId, eventCount: latestEvents.length });
    }

  } catch (error) {
    logger.error('Error fetching tenant details', {
      leaseId,
      tenantId,
      error: error.message,
      stack: error.stack
    });

    // Re-throw validation and business logic errors
    if (error.status && error.status < 500) {
      throw error;
    }

    // For unexpected errors, throw a generic 500 error
    const err = new Error('Internal server error while fetching tenant details');
    err.status = 500;
    throw err;
  }

  logger.info('Tenant details service completed successfully', { leaseId: leaseId || 'none', tenantId });

  // Return segregated response structure with data from correct collections
  return {
    lease,
    collectionStats,
    tenantDetails: tenant,
    leaseHistory: formattedLeaseHistory,
    messageHistory: latestEvents || []
  };
}

/**
 * Update tenant setup - completely separate API from setupTenant
 * Accepts payload: { tenants: [...], lease: { leaseId, ... } }
 * For UPDATE flow: finds existing tenant users by email, updates them, and updates the lease
 * If tenant user doesn't exist, creates new one
 * Returns { tenants, lease }
 */
async function updateSetupTenant(payload = {}, options = {}) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const body = payload || {};
    const tenantsData = Array.isArray(body.tenants) ? body.tenants : [];
    const leaseData = body.lease;

    if (!Array.isArray(tenantsData) || tenantsData.length === 0) {
      const err = new Error('tenants array is required and must contain at least one tenant');
      err.status = 400;
      throw err;
    }
    if (!leaseData || !leaseData.leaseId) {
      const err = new Error('lease payload with leaseId is required in request body as `lease.leaseId`');
      err.status = 400;
      throw err;
    }

    // Update tenants if provided
    if (tenantsData.length > 0) {
      for (const tData of tenantsData) {
        if (tData.id) {
          const tidOid = toObjectId(tData.id);
          if (!tidOid) { const err = new Error('tenant id must be a valid ObjectId'); err.status = 400; throw err; }
          // Update existing tenant
          const updated = await updateTenant(tidOid, tData, { session, userId: options.userId });
          updatedTenants.push(updated);
        }
      }
    }

    // Coerce numeric fields to Number and normalize tenantId to string
    rd.split = rd.split.map((s) => {
      const out = Object.assign({}, s);
      if (out.rentAmount !== undefined) out.rentAmount = Number(out.rentAmount);
      if (out.rentPercentage !== undefined) out.rentPercentage = Number(out.rentPercentage);
      if (out.depositAmount !== undefined) out.depositAmount = Number(out.depositAmount);
      if (out.depositPercentage !== undefined) out.depositPercentage = Number(out.depositPercentage);
      if (out.tenantId) out.tenantId = String(out.tenantId);
      return out;
    });

    // Normalize includeDamageReport if present (UI may send booleans or string/checkbox values)
    if (leaseData && typeof leaseData.includeDamageReport !== 'boolean') {
      const v3 = leaseData.includeDamageReport;
      leaseData.includeDamageReport = (v3 === true || v3 === 'true' || v3 === '1' || v3 === 1 || v3 === 'on');
    }

    // Update the lease
    const leasingService = require('../../leasing/service/lease.service');
    const updatedLease = await leasingService.updateLeaseService(leaseData.leaseId, leaseData, { session });

    await session.commitTransaction();
    session.endSession();

    // Prepare safe tenant payloads
    const tenantsSafe = updatedTenants.map(({ user }) => {
      const obj = user && user.toObject ? user.toObject() : (user || {});
      if (obj && obj.password) delete obj.password;
      return obj;
    });

    return { tenants: tenantsSafe, lease: updatedLease };
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

module.exports = Object.assign(module.exports, { getTenantDetailsService, updateTenantSetup, updateSetupTenant });
