/**
 * ------------------------------------------------------------------
 * File: application.service.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * application.controller
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Application = require('../models/application.model');
const { PORTAL_ONBOARDING_STATUS } = require('../../../../../common/constants/portalOnboarding');
const portalInvitationService = require('../../../../../shared/modules/auth/services/portalInvitation.service');
const logger = require('../../../../../common/logger');
const {
  APPLICATION_STATUS,
  BACKGROUND_CHECK_STATUS,
  INCOME_VERIFICATION_STATUS,
  EVICTION_REPORT_STATUS
} = require('../../../../../common/constants/application');
const { LEASE_STATUSES } = require('../../../../../common/constants/lease');
const {
  buildApplicationOwnerFilter,
  buildPropertyOwnerFilter,
  buildUserOwnerFilter,
  findPropertyIdsByCreatedBy,
  requireCreatedBy,
  resolveCreatedBy,
  stripLegacyOwnerFields,
} = require('../../../../../shared/utils/creatorScope.util');
const { runInTransaction } = require('../../../../../common/helpers/transactionHelper');
const { ClockService, DateUtil } = require('../../../../../common/date');
const {
  formatDateInAppTimezone,
  getDateKeyInTimeZone,
  parseAppYmd,
} = require('../../../../../common/helpers/hoaBillingDates');
const {
  buildApplicationApprovedPreheader,
  buildScreeningApplicationPreheader,
} = require('../../../../../common/helpers/emailDisplayHelper');

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

// Inline small DB utility helpers (previously in applicationDb.util.js)
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

async function createOne(Model, doc, session) {
  if (session) {
    const created = await Model.create([doc], { session });
    return created[0];
  }
  return Model.create(doc);
}

async function findOneAndUpdateOne(Model, filter, update, options = {}, session) {
  const query = applySession(Model.findOneAndUpdate(filter, update, options), session);
  return query;
}

/**
 * get Creator Id From Property
 *
 * Performs logic operations for getCreatorIdFromProperty.
 *
 * @param property - Request/input argument
 * @returns Operations result
 */
function getCreatorIdFromProperty(property) {
  return resolveCreatedBy(property);
}

/**
 * normalize Application Payload
 *
 * Performs logic operations for normalizeApplicationPayload.
 *
 * @param payload - Request/input argument
 * @returns Operations result
 */
function normalizeApplicationPayload(payload = {}) {
  const data = Object.assign({}, payload);
  if (data.propertyId && !data.property_id) data.property_id = data.propertyId;
  if (!data.createdBy) {
    data.createdBy = resolveCreatedBy(data);
  }
  if (Array.isArray(data.employmentHistory)) {
    data.employmentHistory = data.employmentHistory.map((e) => {
      const out = Object.assign({}, e);
      if (out.endDate === 'Present') out.endDate = null;
      return out;
    });
  }
  return data;
}

/**
 * assert Valid Application Id
 *
 * Performs logic operations for assertValidApplicationId.
 *
 * @param id - Request/input argument
 * @returns Operations result
 */
function assertValidApplicationId(id) {
  if (!id) {
    const err = new Error('application id is required');
    err.status = 400;
    throw err;
  }
  if (!mongoose.Types.ObjectId.isValid(String(id))) {
    const err = new Error('invalid application id');
    err.status = 400;
    throw err;
  }
}

/**
 * generate Share Token
 *
 * Performs logic operations for generateShareToken.
 *
 * @returns Operations result
 */
function generateShareToken() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

async function createApplication(payload = {}) {
  const data = normalizeApplicationPayload(payload);
  return runInTransaction(async (session) => createOne(Application, data, session));
}

async function updateApplication(id, payload = {}) {
  const data = normalizeApplicationPayload(payload);

  const oid = toObjectId(id);
  if (!oid) { const err = new Error('invalid application id'); err.status = 400; throw err; }
  return runInTransaction(async (session) => {
    const updated = await findOneAndUpdateOne(
      Application,
      { _id: oid, isDeleted: { $ne: true } },
      { $set: data },
      withSession({ new: true, runValidators: true }, session)
    );
    if (!updated) {
      const err = new Error('Application not found');
      err.status = 404;
      throw err;
    }
    return updated;
  });
}

async function getApplicationById(id) {
  const oid = toObjectId(id);
  if (!oid) { const err = new Error('invalid application id'); err.status = 400; throw err; }
  const app = await Application.findOne({ _id: oid, isDeleted: { $ne: true } })
    .populate({
      path: 'property_id',
      select: 'name address type status',
      options: { strictPopulate: false }
    })
    .populate({
      path: 'lease_id',
      select: 'status',
      options: { strictPopulate: false }
    })
    .populate({
      path: 'notes.createdBy',
      select: 'firstName lastName email',
      options: { strictPopulate: false }
    })
    .populate({
      path: 'comments.createdBy',
      select: 'firstName lastName email',
      options: { strictPopulate: false }
    })
    .lean();
  if (!app) { const err = new Error('Application not found'); err.status = 404; throw err; }

  // Format data for frontend
  return formatApplicationForFrontend(app);
}

async function listApplications(query = {}) {
  const { getPagination } = require('../../../../../common/helpers/paginationHelper');

  const filter = { isDeleted: { $ne: true } };

  const createdBy = resolveCreatedBy(query);
  if (createdBy) {
    const Property = require('../../property/model/property.model');
    const propertyIds = await findPropertyIdsByCreatedBy(Property, createdBy);

    const ownerScope = [];
    if (propertyIds.length > 0) ownerScope.push({ property_id: { $in: propertyIds } });
    const directOwnerFilter = buildApplicationOwnerFilter(createdBy);
    if (Array.isArray(directOwnerFilter.$or)) {
      ownerScope.push(...directOwnerFilter.$or);
    }

    if (ownerScope.length === 0) {
      return {
        items: [],
        total: 0,
        pageNumber: query.pageNumber || 1,
        pageSize: query.pageSize || 10,
        totalPages: 0
      };
    }

    filter.$or = ownerScope;
  }

  if (query.email) filter['personalInformation.email'] = String(query.email || '').trim().toLowerCase();
  if (query.firstName) filter['personalInformation.firstName'] = { $regex: String(query.firstName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  if (query.lastName) filter['personalInformation.lastName'] = { $regex: String(query.lastName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };

  // Applicant name filter - search in combined firstName and lastName
  if (query.applicantName) {
    const escapedName = String(query.applicantName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$expr = {
      $regexMatch: {
        input: { $concat: ['$personalInformation.firstName', ' ', '$personalInformation.lastName'] },
        regex: escapedName,
        options: 'i'
      }
    };
  }

  // Status filter
  if (query.status) filter['status'] = query.status;

  // Property filter - support both single propertyId and multiple propertyIds
  if (query.propertyIds) {
    const propertyIdsArray = query.propertyIds.split(',').map(id => id.trim()).filter(id => mongoose.Types.ObjectId.isValid(id)).map(id => new mongoose.Types.ObjectId(id));
    if (propertyIdsArray.length > 0) {
      filter['property_id'] = { $in: propertyIdsArray };
    }
  } else if (query.propertyId) {
    if (mongoose.Types.ObjectId.isValid(query.propertyId)) {
      filter['property_id'] = new mongoose.Types.ObjectId(query.propertyId);
    }
  }

  const { offset, limit, page, pageSize } = getPagination({
    page: query.pageNumber,
    pageSize: query.pageSize
  });

  const APPLICATION_LIST_SELECT =
    'status personalInformation property_id createdAt desiredMoveInDate annualIncome creditScore backgroundCheckStatus incomeVerificationStatus verifiedAnnualIncome evictionReportStatus employmentHistory tenant_id';

  const [items, total] = await Promise.all([
    Application.find(filter)
      .select(APPLICATION_LIST_SELECT)
      .populate({
        path: 'property_id',
        select: 'name address type status',
        options: { strictPopulate: false }
      })
      .sort({ updatedAt: -1 })
      .skip(offset)
      .limit(limit)
      .lean(),
    Application.countDocuments(filter),
  ]);

  // Format all items for frontend
  const formattedItems = items.map(formatApplicationForFrontend);

  return {
    items: formattedItems,
    total,
    pageNumber: page,
    pageSize,
    totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 0
  };
}

async function deleteApplication(id) {
  assertValidApplicationId(id);
  return runInTransaction(async (session) => {
    const updated = await findOneAndUpdateOne(
      Application,
      { _id: id, isDeleted: { $ne: true } },
      { $set: { isDeleted: true } },
      withSession({ new: true }, session)
    );
    if (!updated) {
      const err = new Error('Application not found');
      err.status = 404;
      throw err;
    }
    return updated;
  });
}

async function getApplicantNames(searchText = '', createdBy = null) {
  const query = { isDeleted: { $ne: true } };
  const ownerId = resolveCreatedBy({ createdBy });
  if (ownerId) {
    Object.assign(query, buildApplicationOwnerFilter(ownerId));
  }

  if (searchText) {
    const escapedSearch = String(searchText).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.$expr = {
      $regexMatch: {
        input: { $concat: ['$personalInformation.firstName', ' ', '$personalInformation.lastName'] },
        regex: escapedSearch,
        options: 'i'
      }
    };
  }

  const applications = await Application.find(query)
    .select('personalInformation.firstName personalInformation.lastName')
    .limit(4)
    .lean();

  return applications.map(app => ({
    id: app._id,
    name: `${app.personalInformation?.firstName || ''} ${app.personalInformation?.lastName || ''}`.trim() || 'N/A'
  }));
}

/**
 * resolve Application Lease Id
 *
 * Performs logic operations for resolveApplicationLeaseId.
 *
 * @param application - Request/input argument
 * @returns Operations result
 */
function resolveApplicationLeaseId(application) {
  if (!application) return null;
  return application.lease_id || application.leaseId || null;
}

/**
 * resolve Application Tenant Id
 *
 * Performs logic operations for resolveApplicationTenantId.
 *
 * @param application - Request/input argument
 * @returns Operations result
 */
function resolveApplicationTenantId(application) {
  if (!application) return null;
  return application.tenant_id || application.tenantId || null;
}

async function loadApplicationForApproveSideEffects(id) {
  return Application.findOne({ _id: id, isDeleted: { $ne: true } })
    .select('lease_id tenant_id personalInformation property_id status')
    .populate({
      path: 'property_id',
      select: 'name address createdBy landlord_id',
      options: { strictPopulate: false },
    })
    .lean();
}

async function activateTenantUserForApprovedApplication(applicationDoc, session) {
  const User = require('../../../../../shared/modules/users/models/user.model');
  const { USER_STATUSES } = require('../../../../../common/constants/user');
  const applicantEmail = applicationDoc.personalInformation?.email;
  if (!applicantEmail) return;

  const tenant = await applySession(
    User.findOne({ email: String(applicantEmail).trim().toLowerCase(), isDeleted: { $ne: true } }),
    session
  );
  if (!tenant) return;

  await findOneAndUpdateOne(
    User,
    { _id: tenant._id, isDeleted: { $ne: true } },
    { $set: { status: USER_STATUSES.ACTIVE } },
    withSession({ new: true, runValidators: true }, session)
  );
  logger.info(`[Application] Tenant user activated for email: ${applicantEmail}`);
}

async function notifyTenantApplicationDecision(application, event) {
  try {
    const { notify, EVENTS } = require('../../../../../integrations/notification');
    const resolvedEvent = event || EVENTS.APPLICATION_APPROVED;

    const User = require('../../../../../shared/modules/users/models/user.model');
    let tenantUserId = resolveApplicationTenantId(application);

    if (!tenantUserId && application.personalInformation?.email) {
      const tenant = await User.findOne({
        email: String(application.personalInformation.email).trim().toLowerCase(),
        isDeleted: { $ne: true },
      })
        .select('_id')
        .lean();
      tenantUserId = tenant?._id;
    }
    if (!tenantUserId) return;

    let unitName = 'Unit';
    let propertyName = application.property_id?.name || 'Property';
    const linkedLeaseId = resolveApplicationLeaseId(application);
    if (linkedLeaseId) {
      const Lease = require('../../leasing/model/lease.model');
      const lease = await Lease.findOne({ _id: linkedLeaseId, isDeleted: { $ne: true } })
        .select('unitName property_id')
        .populate('property_id', 'name')
        .lean();
      if (lease) {
        unitName = lease.unitName || unitName;
        propertyName = lease.property_id?.name || propertyName;
      }
    }

    await notify(
      resolvedEvent,
      { unitName, propertyName },
      String(tenantUserId),
      {
        applicationId: String(application._id),
        leaseId: linkedLeaseId ? String(linkedLeaseId) : null,
      }
    );
  } catch (err) {
    logger.warn('[Application] Failed to send tenant application notification:', err.message);
  }
}

async function runPostApproveSideEffects(updated, actorId = null) {
  if (!updated) return;

  try {
    const emailHelper = require('../../../../../common/helpers/emailHelper');
    const User = require('../../../../../shared/modules/users/models/user.model');

    // Get landlord details
    let landlordName = 'Your Landlord';
    let landlordEmail = 'noreply@propmv.com';

    const propertyOwnerId = getCreatorIdFromProperty(updated.property_id);
    if (propertyOwnerId) {
      const safeOwnerId = toObjectId(propertyOwnerId);
      const landlord = safeOwnerId ? await User.findOne({ _id: safeOwnerId, isDeleted: { $ne: true } }).lean() : null;
      if (landlord) {
        landlordName = `${landlord.firstName || ''} ${landlord.lastName || ''}`.trim() || landlord.email || 'Your Landlord';
        landlordEmail = landlord.email || 'noreply@propmv.com';
      }
    }

    // Prepare email data
    const emailData = {
      applicantName: `${updated.personalInformation?.firstName || ''} ${updated.personalInformation?.lastName || ''}`.trim() || 'Applicant',
      landlordName,
      landlordEmail,
      propertyName: updated.property_id?.name || 'Property',
      propertyAddress: updated.property_id?.address ?
        `${updated.property_id.address.street || ''}, ${updated.property_id.address.city || ''}, ${updated.property_id.address.state || ''} ${updated.property_id.address.zip || ''}`.trim() :
        'N/A',
      applicationDate: updated.createdAt ? formatDateInAppTimezone(updated.createdAt) : 'N/A',
      approvalDate: formatDateInAppTimezone(ClockService.now()),
      dashboardUrl: process.env.FRONTEND_BASE_URL || 'https://propmv.com/dashboard',
      currentYear: (parseAppYmd(getDateKeyInTimeZone(ClockService.now())) || {}).y,
    };

    const applicantEmail = updated.personalInformation?.email;

    if (applicantEmail) {
      await emailHelper.sendEmail(
        'application-accepted',
        applicantEmail,
        emailData,
        {
          subject: 'Your rental application has been approved',
          preheaderText: buildApplicationApprovedPreheader({
            propertyName: emailData.propertyName,
          }),
        }
      );
      logger.info(`[Application] Approval email sent to ${applicantEmail}`);
    }
  } catch (emailError) {
    // Log email error but don't fail the approval
    logger.error('[Application] Failed to send approval email:', emailError.message);
  }

  const linkedLeaseId = resolveApplicationLeaseId(updated);
  if (linkedLeaseId) {
    const leaseId = String(linkedLeaseId);
    logger.info(`[Application] Application has lease_id: ${leaseId}, sending tenant invite after approval`);

    try {
      const Lease = require('../../leasing/model/lease.model');
      const { sendLeaseTenantInviteEmail } = require('../../leasing/service/leaseTenantInviteDelivery.service');
      const currentLease = await Lease.findOne({ _id: leaseId, isDeleted: { $ne: true } })
        .populate('property_id', 'name address createdBy landlord_id')
        .lean();

      if (currentLease) {
        const tenantId =
          resolveApplicationTenantId(updated) ||
          (await resolveTenantIdForApprovedApplication(updated, currentLease));

        if (tenantId) {
          const propertyOwnerId = getCreatorIdFromProperty(currentLease.property_id);
          const inviterUserId = actorId || propertyOwnerId;
          await sendLeaseTenantInviteEmail({
            leaseId,
            tenantId: String(tenantId),
            inviterUserId,
            // After screening approval the tenant already has an account; send lease invite, not portal activation.
            forceLeaseInviteEmail: true,
          });
          logger.info(`[Application] Lease invite email sent to approved tenant ${tenantId}`);
        } else {
          logger.warn('[Application] Could not resolve tenant id for approved application invite email');
        }
      } else {
        logger.warn(`[Application] Lease ${leaseId} not found for post-approve invite email`);
      }

      const { attemptLeaseAutoActivation } = require('../../leasing/service/leaseAutoApproval.service');
      await attemptLeaseAutoActivation(leaseId);
    } catch (postApproveErr) {
      logger.error('[Application] Post-approve lease invite/activation failed:', postApproveErr.message);
      if (postApproveErr.stack) logger.error(postApproveErr.stack);
    }
  } else {
    logger.info('[Application] Application does not have lease_id, skipping lease invite and activation');
  }

  const { EVENTS } = require('../../../../../integrations/notification');
  await notifyTenantApplicationDecision(updated, EVENTS.APPLICATION_APPROVED);
}

async function resolveTenantIdForApprovedApplication(application, lease) {
  const directTenantId = resolveApplicationTenantId(application);
  if (directTenantId) return directTenantId;

  const User = require('../../../../../shared/modules/users/models/user.model');
  const { normalizeSplitTenantId } = require('../../leasing/service/leaseTenantInviteDelivery.service');
  const email = application.personalInformation?.email;
  if (!email) return null;
  const tenant = await User.findOne({ email: email.toLowerCase(), isDeleted: { $ne: true } })
    .select('_id')
    .lean();
  if (tenant?._id) return tenant._id;

  const split = lease?.rentAndDepositDestribution?.split || [];
  const emailLower = email.toLowerCase();
  for (const s of split) {
    const tid = normalizeSplitTenantId(s?.tenantId);
    if (!tid) continue;
    const u = await User.findOne({ _id: tid, isDeleted: { $ne: true } }).select('email').lean();
    if (u?.email && u.email.toLowerCase() === emailLower) return tid;
  }
  return null;
}

async function approveApplication(id, actionComment = '', actorId = null) {
  assertValidApplicationId(id);

  const updateOp = { $set: { status: APPLICATION_STATUS.APPROVED } };
  if (actionComment && String(actionComment).trim()) {
    updateOp.$push = {
      comments: {
        text: String(actionComment).trim(),
        action: 'approve',
        createdBy: actorId || undefined,
        createdAt: ClockService.now(),
      },
    };
  }

  await runInTransaction(async (session) => {
    const updated = await findOneAndUpdateOne(
      Application,
      { _id: id, isDeleted: { $ne: true } },
      updateOp,
      withSession({ new: true, runValidators: true }, session)
    );
    if (!updated) {
      const err = new Error('Application not found');
      err.status = 404;
      throw err;
    }
    await activateTenantUserForApprovedApplication(updated, session);
    return updated;
  });

  const populated = await loadApplicationForApproveSideEffects(id);
  if (!populated) {
    const err = new Error('Application not found');
    err.status = 404;
    throw err;
  }

  await runPostApproveSideEffects(populated, actorId);
  return populated;
}

async function rejectApplication(id, rejectionReason = '', actionComment = '', actorId = null) {
  assertValidApplicationId(id);

  const updatePayload = { status: APPLICATION_STATUS.REJECTED, rejectionReason };
  const updateOp = { $set: updatePayload };
  if (actionComment && String(actionComment).trim()) {
    updateOp.$push = {
      comments: {
        text: String(actionComment).trim(),
        action: 'reject',
        createdBy: actorId || undefined,
        createdAt: ClockService.now(),
      },
    };
  }

  const updated = await runInTransaction(async (session) => {
    const result = await findOneAndUpdateOne(
      Application,
      { _id: id, isDeleted: { $ne: true } },
      updateOp,
      withSession({ new: true, runValidators: true }, session)
    );
    if (!result) {
      const err = new Error('Application not found');
      err.status = 404;
      throw err;
    }

    const linkedLeaseId = result.lease_id || result.leaseId;
    if (linkedLeaseId) {
      const Lease = require('../../leasing/model/lease.model');
      await findOneAndUpdateOne(
        Lease,
        {
          _id: linkedLeaseId,
          isDeleted: { $ne: true },
          status: { $in: [LEASE_STATUSES.SUBMITTED, LEASE_STATUSES.APPROVED] },
        },
        { $set: { status: LEASE_STATUSES.REJECTED } },
        withSession({ new: true }, session)
      );
    }

    return result;
  });

  const populated = await Application.findOne({ _id: updated._id, isDeleted: { $ne: true } })
    .select('lease_id tenant_id personalInformation property_id status')
    .populate({
      path: 'property_id',
      select: 'name address createdBy landlord_id',
      options: { strictPopulate: false },
    })
    .lean();

  if (populated) {
    const { EVENTS } = require('../../../../../integrations/notification');
    await notifyTenantApplicationDecision(populated, EVENTS.APPLICATION_REJECTED);
  }

  return updated;
}

async function updateScreeningInfo(id, screeningData = {}) {
  assertValidApplicationId(id);

  const updateData = {};
  if (screeningData.creditScore !== undefined) updateData.creditScore = screeningData.creditScore;
  if (screeningData.backgroundCheckStatus) updateData.backgroundCheckStatus = screeningData.backgroundCheckStatus;
  if (screeningData.incomeVerificationStatus) updateData.incomeVerificationStatus = screeningData.incomeVerificationStatus;
  if (screeningData.verifiedAnnualIncome !== undefined) updateData.verifiedAnnualIncome = screeningData.verifiedAnnualIncome;
  if (screeningData.evictionReportStatus) updateData.evictionReportStatus = screeningData.evictionReportStatus;

  return runInTransaction(async (session) => {
    const updated = await findOneAndUpdateOne(
      Application,
      { _id: id, isDeleted: { $ne: true } },
      { $set: updateData },
      withSession({ new: true, runValidators: true }, session)
    );
    if (!updated) {
      const err = new Error('Application not found');
      err.status = 404;
      throw err;
    }
    return updated;
  });
}

async function addNote(id, text, userId, action = 'note') {
  assertValidApplicationId(id);
  if (!text) {
    const err = new Error('note text is required');
    err.status = 400;
    throw err;
  }

  const comment = {
    text,
    action,
    createdBy: userId || undefined,
    createdAt: ClockService.now(),
  };

  return runInTransaction(async (session) => {
    const updated = await applySession(
      Application.findOneAndUpdate(
        { _id: toObjectId(id), isDeleted: { $ne: true } },
        { $push: { comments: comment } },
        withSession({ new: true, runValidators: true }, session)
      )
        .populate({
          path: 'property_id',
          select: 'name address type status',
          options: { strictPopulate: false },
        })
        .populate({
          path: 'comments.createdBy',
          select: 'firstName lastName email',
          options: { strictPopulate: false },
        }),
      session
    ).lean();

    if (!updated) {
      const err = new Error('Application not found');
      err.status = 404;
      throw err;
    }
    return formatApplicationForFrontend(updated);
  });
}

async function addComment(id, text, userId, action = 'comment') {
  return addNote(id, text, userId, action);
}

/**
 * Create a blank application for a tenant when they accept invitation
 * This creates a minimal application with only basic tenant information
 * Additional details will be filled when tenant completes the third-party form
 * @param {String} tenantId - Tenant user ID
 * @param {String} propertyId - Property ID (optional)
 * @param {String} leaseId - Lease ID (optional, stored for reference)
 * @returns {Object} - Created application
 */
async function createBlankApplicationForTenant(tenantId, propertyId = null, leaseId = null) {
  if (!tenantId) {
    const err = new Error('tenantId is required');
    err.status = 400;
    throw err;
  }

  if (!mongoose.Types.ObjectId.isValid(String(tenantId))) {
    const err = new Error('invalid tenantId');
    err.status = 400;
    throw err;
  }

  // Fetch tenant user details
  const User = require('../../../../../shared/modules/users/models/user.model');
  const tenant = await User.findOne({ _id: tenantId, isDeleted: { $ne: true } }).lean();

  if (!tenant) {
    const err = new Error('Tenant not found');
    err.status = 404;
    throw err;
  }

  // If propertyId is provided, validate it
  if (propertyId) {
    if (!mongoose.Types.ObjectId.isValid(String(propertyId))) {
      const err = new Error('invalid propertyId');
      err.status = 400;
      throw err;
    }

    const Property = require('../../property/model/property.model');
    const property = await Property.findOne({ _id: toObjectId(propertyId), isDeleted: { $ne: true } }).lean();

    if (!property) {
      const err = new Error('Property not found');
      err.status = 404;
      throw err;
    }
  } else {
    const tenantOwnerId = resolveCreatedBy(tenant);
    if (tenantOwnerId) {
      const safeOwnerId = toObjectId(tenantOwnerId);
      const Property = require('../../property/model/property.model');
      const property = safeOwnerId ? await Property.findOne({
        ...buildPropertyOwnerFilter(safeOwnerId),
        isDeleted: { $ne: true },
      }).lean() : null;
      if (property) {
        propertyId = property._id;
      }
    }

    // If still no property found, throw error
    if (!propertyId) {
      const err = new Error('propertyId is required and could not be determined from tenant data');
      err.status = 400;
      throw err;
    }
  }

  // Validate leaseId if provided
  if (leaseId && !mongoose.Types.ObjectId.isValid(String(leaseId))) {
    const err = new Error('invalid leaseId');
    err.status = 400;
    throw err;
  }

  const tenantEmailLower = tenant.email.toLowerCase();

  // Helper function to check if value is valid (not empty, not placeholder, not N/A)
  const isValid = (value) => {
    return value &&
      value !== '' &&
      value !== 'N/A' &&
      value !== 'n/a' &&
      value !== '00000' &&
      value !== '000-000-0000' &&
      value !== '(000) 000-0000';
  };

  // Build personal information with only valid data from tenant
  const personalInformation = {
    firstName: isValid(tenant.firstName) ? tenant.firstName : '',
    lastName: isValid(tenant.lastName) ? tenant.lastName : '',
    mobileNumber: isValid(tenant.phone) ? tenant.phone : '',
    email: tenant.email || '', // Email should be from tenant
    birthDate: tenant.dob ? tenant.dob : null // No default date, keep null if not available
  };

  // Build address information with only valid data from tenant
  const addressInformation = {
    addressLine1: isValid(tenant.address) ? tenant.address : '',
    city: '', // Not available from tenant, keep blank
    state: isValid(tenant.state) ? tenant.state : '',
    zip: isValid(tenant.zipCode) ? tenant.zipCode : ''
  };

  // Build emergency contact with only valid data from tenant
  const emergencyContact = {};
  if (tenant.emergencyContact) {
    if (isValid(tenant.emergencyContact.firstName)) {
      emergencyContact.firstName = tenant.emergencyContact.firstName;
    }
    if (isValid(tenant.emergencyContact.lastName)) {
      emergencyContact.lastName = tenant.emergencyContact.lastName;
    }
    if (isValid(tenant.emergencyContact.phone)) {
      emergencyContact.mobileNumber = tenant.emergencyContact.phone;
    }
    if (isValid(tenant.emergencyContact.email)) {
      emergencyContact.email = tenant.emergencyContact.email;
    }
  }

  // Build references with only valid data from tenant (if available)
  const references = {};
  // Note: References data might not be available in tenant profile during initial blank creation
  // Only include references if data exists
  const hasValidReferences = Object.keys(references).length > 0;
  const hasValidEmergencyContact = Object.keys(emergencyContact).length > 0;

  // Create blank application with minimal tenant information
  const blankApplication = {
    property_id: propertyId,
    tenant_id: tenantId,
    lease_id: leaseId,
    createdBy: resolveCreatedBy(tenant),
    personalInformation,
    addressInformation,
    employmentHistory: [],
    rentalHistory: [],
    status: APPLICATION_STATUS.SUBMITTED,
    backgroundCheckStatus: BACKGROUND_CHECK_STATUS.PENDING,
    incomeVerificationStatus: INCOME_VERIFICATION_STATUS.PENDING,
    evictionReportStatus: EVICTION_REPORT_STATUS.PENDING,
    comments: [{
      text: 'Blank application created automatically when tenant accepted invitation. Awaiting tenant to complete full application details.',
      action: 'system',
      createdBy: resolveCreatedBy(tenant, tenant._id) || tenant._id,
      createdAt: ClockService.now()
    }]
  };

  // Only add emergency contact if it has valid data
  if (hasValidEmergencyContact) {
    blankApplication.emergencyContact = emergencyContact;
  }

  // Only add references if it has valid data
  if (hasValidReferences) {
    blankApplication.references = references;
  }

  return runInTransaction(async (session) => {
    const existingApp = await applySession(
      Application.findOne({
        'personalInformation.email': tenantEmailLower,
        isDeleted: { $ne: true },
      }),
      session
    ).lean();

    if (existingApp) {
      const err = new Error('Application already exists for this tenant');
      err.status = 409;
      throw err;
    }

    return createOne(Application, blankApplication, session);
  });
}

// Format application data for frontend consumption
function formatApplicationForFrontend(app) {
  // Helper function to check if value is valid (not empty, not placeholder, not null)
  const isValidValue = (value) => {
    return value &&
      value !== '' &&
      value !== 'N/A' &&
      value !== 'n/a';
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return null;
    try {
      const formatted = formatDateInAppTimezone(dateStr, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
      return formatted || null;
    } catch {
      return null;
    }
  };

  const formatDateTime = (dateStr) => {
    if (!dateStr) return null;
    try {
      const formatted = formatDateTimeInAppTimezone(dateStr, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
      return formatted || null;
    } catch {
      return null;
    }
  };

  const calculateAge = (birthDate) => {
    if (!birthDate) return null;
    try {
      const birth = parseAppYmd(getDateKeyInTimeZone(birthDate));
      const today = parseAppYmd(getDateKeyInTimeZone(ClockService.now()));
      if (!birth || !today) return null;
      let age = today.y - birth.y;
      const monthDiff = today.m - birth.m;
      if (monthDiff < 0 || (monthDiff === 0 && today.d < birth.d)) {
        age--;
      }
      return age;
    } catch {
      return null;
    }
  };

  // Build formatted object, only including valid data
  const formatted = {
    // Basic info
    id: app._id,
    status: app.status || 'submitted',

    // Formatted personal info
    applicantName: `${app.personalInformation?.firstName || ''} ${app.personalInformation?.lastName || ''}`.trim() || 'Unknown Applicant',
  };

  // Only add email if valid
  if (isValidValue(app.personalInformation?.email)) {
    formatted.email = app.personalInformation.email;
  }

  // Only add phone if valid
  if (isValidValue(app.personalInformation?.mobileNumber)) {
    formatted.phone = app.personalInformation.mobileNumber;
  }

  // Only add birthday if valid
  const formattedBirthday = formatDate(app.personalInformation?.birthDate);
  if (formattedBirthday) {
    formatted.birthday = formattedBirthday;
  }

  // Only add age if valid
  const calculatedAge = calculateAge(app.personalInformation?.birthDate);
  if (calculatedAge !== null) {
    formatted.age = calculatedAge;
  }

  // Property info - only when a property is actually linked (lease/property-specific flows)
  const linkedProperty =
    app.property_id &&
      typeof app.property_id === 'object' &&
      (app.property_id.name || app.property_id._id)
      ? app.property_id
      : null;

  if (linkedProperty) {
    formatted.hasLinkedProperty = true;
    if (isValidValue(linkedProperty.name)) {
      formatted.property = linkedProperty.name;
    }

    const addressParts = [
      linkedProperty.address?.street,
      linkedProperty.address?.city,
      linkedProperty.address?.state,
    ].filter((part) => isValidValue(part));

    if (addressParts.length > 0) {
      formatted.propertyAddress = addressParts.join(', ');
    }

    if (isValidValue(linkedProperty.type)) {
      formatted.propertyType = linkedProperty.type;
    }
  } else {
    formatted.hasLinkedProperty = false;
  }

  // Application dates
  const appliedOnDate = formatDateTime(app.createdAt);
  if (appliedOnDate) {
    formatted.appliedOn = appliedOnDate;
  }

  // Only add moveInDate if valid
  const formattedMoveIn = formatDate(app.desiredMoveInDate);
  if (formattedMoveIn) {
    formatted.moveInDate = formattedMoveIn;
  }

  // Financial info - only add if values exist
  if (app.annualIncome) {
    formatted.annualIncome = `$${app.annualIncome.toLocaleString()}`;
    formatted.incomeReported = `$${app.annualIncome.toLocaleString()}.00 / year`;
  }

  // Screening info - only add if not pending or if there's actual data
  if (app.creditScore) {
    formatted.residentScore = app.creditScore;
  }

  formatted.backgroundReport = app.backgroundCheckStatus === 'clear' ? 'Clear' :
    app.backgroundCheckStatus === 'issues_found' ? 'Issues Found' :
      app.backgroundCheckStatus === 'failed' ? 'Failed' : 'Pending';

  if (app.verifiedAnnualIncome) {
    formatted.incomeVerified = `$${app.verifiedAnnualIncome.toLocaleString()}/year`;
  } else if (app.incomeVerificationStatus === 'verified') {
    formatted.incomeVerified = 'Verified';
  } else if (app.incomeVerificationStatus === 'unverified') {
    formatted.incomeVerified = 'Unverified';
  } else if (app.incomeVerificationStatus === 'insufficient') {
    formatted.incomeVerified = 'Insufficient';
  } else {
    formatted.incomeVerified = 'Pending';
  }

  formatted.evictionReport = app.evictionReportStatus === 'no_records' ? 'No records found' :
    app.evictionReportStatus === 'records_found' ? 'Records found' : 'Pending';

  formatted.employmentStatus = app.employmentHistory?.length > 0 ? 'Employed' : 'Unemployed';

  // Employment history
  formatted.employmentHistory = app.employmentHistory?.map((job, index) => ({
    id: job._id || index,
    period: `${formatDate(job.startDate)} – ${job.endDate ? formatDate(job.endDate) : 'Present'}`,
    position: job.titleOrPosition || 'N/A',
    company: job.employer || 'N/A',
    duration: job.endDate ? 'Completed' : 'Current',
    supervisor: `${job.contact?.firstName || ''} ${job.contact?.lastName || ''}`.trim() || 'N/A',
    phone: job.contact?.phone || 'N/A',
    email: job.contact?.email || 'N/A',
  })) || [];

  // Rental history
  formatted.rentalHistory = app.rentalHistory?.map((rental, index) => ({
    id: rental._id || index,
    period: `${formatDate(rental.moveInDate)} – ${rental.moveOutDate ? formatDate(rental.moveOutDate) : 'Present'}`,
    address: rental.streetAddress || 'N/A',
    duration: rental.moveOutDate ? 'Completed' : 'Current',
    rent: rental.monthlyRent ? `$${rental.monthlyRent}` : 'N/A',
    landlord: rental.landlordOrManager?.name || 'N/A',
    phone: rental.landlordOrManager?.phone || 'N/A',
    email: rental.landlordOrManager?.email || 'N/A',
  })) || [];

  // References - only add if reference has at least one valid field
  if (app.references && (isValidValue(app.references.firstName) || isValidValue(app.references.lastName) ||
    isValidValue(app.references.mobileNumber) || isValidValue(app.references.email))) {
    formatted.references = [{
      name: `${app.references.firstName || ''} ${app.references.lastName || ''}`.trim() || undefined,
      ...(isValidValue(app.references.mobileNumber) && { phone: app.references.mobileNumber }),
      ...(isValidValue(app.references.relation) && { relation: app.references.relation })
    }];
  } else {
    formatted.references = [];
  }

  // Emergency contact - only add if has at least one valid field
  if (app.emergencyContact && (isValidValue(app.emergencyContact?.firstName) ||
    isValidValue(app.emergencyContact?.lastName) ||
    isValidValue(app.emergencyContact?.mobileNumber) ||
    isValidValue(app.emergencyContact?.email))) {
    formatted.emergencyContact = {
      ...(isValidValue(app.emergencyContact?.firstName) && { firstName: app.emergencyContact.firstName }),
      ...(isValidValue(app.emergencyContact?.lastName) && { lastName: app.emergencyContact.lastName }),
      ...(isValidValue(app.emergencyContact?.mobileNumber) && { phone: app.emergencyContact.mobileNumber }),
      ...(isValidValue(app.emergencyContact?.email) && { email: app.emergencyContact.email }),
    };
  }

  // Lease information - include if available
  if (app.lease_id) {
    formatted.lease = {
      id: app.lease_id._id || app.lease_id,
      status: app.lease_id.status
    };
  }

  // Notes
  formatted.notes = app.comments || app.notes || [];
  formatted.comments = app.comments || [];

  // Raw data for any additional processing
  formatted._raw = app;

  return formatted;
}

/**
 * sanitize Screening Submission Data
 *
 * Performs logic operations for sanitizeScreeningSubmissionData.
 *
 * @param applicationData - Request/input argument
 * @param options - Request/input argument
 * @returns Operations result
 */
function sanitizeScreeningSubmissionData(applicationData = {}, options = {}) {
  const data = Object.assign({}, applicationData);
  delete data.propertyId;
  stripLegacyOwnerFields(data);

  if (options.independentSubmission) {
    delete data.propertyId;
    delete data.property_id;
  }

  if (!data.status) {
    data.status = APPLICATION_STATUS.SUBMITTED || 'SUBMITTED';
  }

  if (Array.isArray(data.employmentHistory)) {
    data.employmentHistory = data.employmentHistory.map((e) => {
      const out = Object.assign({}, e);
      if (out.endDate === 'Present') out.endDate = null;
      return out;
    });
  }

  if (Array.isArray(data.rentalHistory)) {
    data.rentalHistory = data.rentalHistory.map((r) => {
      const out = Object.assign({}, r);
      const mov = out.moveOutDate;
      if (mov === 'Present' || mov === '' || mov == null) {
        delete out.moveOutDate;
      }
      return out;
    });
  }

  if (data.desiredMoveInDate === '' || data.desiredMoveInDate == null) {
    delete data.desiredMoveInDate;
  }
  if (data.screeningPropertyStatus === '' || data.screeningPropertyStatus == null) {
    delete data.screeningPropertyStatus;
  }
  if (data.annualIncome === '' || (typeof data.annualIncome === 'number' && Number.isNaN(data.annualIncome))) {
    delete data.annualIncome;
  }

  return data;
}

async function notifyLandlordOfScreeningSubmission(created, { leaseId, tenantId, applicationData = {} } = {}) {
  try {
    const { notify, EVENTS } = require('../../../../../integrations/notification');
    let targetLandlordId = resolveCreatedBy(applicationData);
    let propertyName = 'Property';
    let unitName = 'Unit';

    if (leaseId) {
      const Lease = require('../../leasing/model/lease.model');
      const lease = await Lease.findOne({ _id: leaseId, isDeleted: { $ne: true } })
        .populate('property_id', 'createdBy landlord_id landlord name')
        .lean();

      if (lease) {
        unitName = lease.unitName || unitName;
        if (lease.property_id) {
          targetLandlordId = resolveCreatedBy(lease.property_id, targetLandlordId);
          propertyName = lease.property_id.name || propertyName;
        }
      }
    }

    if (!targetLandlordId || !created || !created._id) return;

    const tenantName = applicationData.personalInformation
      ? `${applicationData.personalInformation.firstName} ${applicationData.personalInformation.lastName}`.trim()
      : 'A tenant';

    await notify(
      EVENTS.APPLICATION_SUBMITTED,
      { applicantName: tenantName, unitName },
      String(targetLandlordId),
      {
        applicationId: created._id.toString(),
        leaseId: leaseId || null,
        tenantId: tenantId || null,
        propertyName,
      }
    );
  } catch (notificationError) {
    logger.warn('Failed to send landlord screening submission notification:', notificationError.message);
  }
}

/**
 * Submit screening application from tenant
 * Creates or updates application with all provided data and tenant/lease info
 * Supports two flows:
 * 1. With leaseId and tenantId (from lease creation flow)
 * 2. With createdBy only (from request application flow)
 */
async function submitScreeningApplication(leaseId, tenantId, applicationData = {}) {
  const createdBy = resolveCreatedBy(applicationData);

  if (!leaseId && !tenantId && !createdBy) {
    const err = new Error('Either (leaseId and tenantId) or createdBy is required');
    err.status = 400;
    throw err;
  }

  const created = await runInTransaction(async (session) => {
    if (leaseId && tenantId) {
      if (!mongoose.Types.ObjectId.isValid(String(leaseId))) {
        const err = new Error('invalid leaseId');
        err.status = 400;
        throw err;
      }

      if (!mongoose.Types.ObjectId.isValid(String(tenantId))) {
        const err = new Error('invalid tenantId');
        err.status = 400;
        throw err;
      }

      const Lease = require('../../leasing/model/lease.model');
      const User = require('../../../../../shared/modules/users/models/user.model');
      const Property = require('../../property/model/property.model');

      const safeLeaseId = toObjectId(leaseId);
      const lease = safeLeaseId ? await Lease.findOne({ _id: safeLeaseId, isDeleted: { $ne: true } }).lean() : null;
      if (!lease) {
        const err = new Error('Lease not found');
        err.status = 404;
        throw err;
      }
      if (!lease.property_id) {
        const err = new Error('Lease does not have a valid property reference');
        err.status = 400;
        throw err;
      }
      if (!mongoose.Types.ObjectId.isValid(String(lease.property_id))) {
        const err = new Error('Invalid property_id in lease');
        err.status = 400;
        throw err;
      }

      const tenant = await User.findOne({ _id: tenantId, isDeleted: { $ne: true } });
      if (!tenant) {
        const err = new Error('Tenant not found');
        err.status = 404;
        throw err;
      }

      const property = await Property.findOne({ _id: lease.property_id, isDeleted: { $ne: true } }).lean();
      const ownerId = property ? getCreatorIdFromProperty(property) : null;
      if (!ownerId) {
        const err = new Error('Lease property is not associated with an owner');
        err.status = 400;
        throw err;
      }

      const data = sanitizeScreeningSubmissionData(applicationData);
      data.tenant_id = new mongoose.Types.ObjectId(tenantId);
      data.lease_id = new mongoose.Types.ObjectId(leaseId);
      data.property_id = new mongoose.Types.ObjectId(lease.property_id);
      data.createdBy = ownerId;

      return createOne(Application, data, session);
    }

    if (createdBy) {
      const ownerId = requireCreatedBy({ createdBy });
      const User = require('../../../../../shared/modules/users/models/user.model');

      const safeOwnerId = toObjectId(ownerId);
      const owner = safeOwnerId ? await User.findOne({ _id: safeOwnerId, isDeleted: { $ne: true } }) : null;
      if (!owner) {
        const err = new Error('Owner not found');
        err.status = 404;
        throw err;
      }

      const data = sanitizeScreeningSubmissionData(applicationData, { independentSubmission: true });
      data.createdBy = ownerId;

      return createOne(Application, data, session);
    }

    const err = new Error('Invalid submission parameters');
    err.status = 400;
    throw err;
  });

  await notifyLandlordOfScreeningSubmission(created, { leaseId, tenantId, applicationData });
  return created;
}

/**
 * Share application via email
 * Stores screening options and email for sharing
 */
async function shareApplicationViaEmail(applicationId, payload = {}) {
  if (!applicationId) {
    const err = new Error('application id is required');
    err.status = 400;
    throw err;
  }

  if (!mongoose.Types.ObjectId.isValid(String(applicationId))) {
    const err = new Error('invalid application id');
    err.status = 400;
    throw err;
  }

  const { screeningOptions, email } = payload;

  if (!email || !screeningOptions || screeningOptions.length === 0) {
    const err = new Error('email and screening options are required');
    err.status = 400;
    throw err;
  }

  return runInTransaction(async (session) => {
    const updated = await findOneAndUpdateOne(
      Application,
      { _id: applicationId, isDeleted: { $ne: true } },
      {
        $set: {
          shareInfo: {
            method: 'email',
            email,
            screeningOptions,
            sharedAt: ClockService.now(),
          },
        },
      },
      withSession({ new: true, runValidators: true }, session)
    );

    if (!updated) {
      const err = new Error('Application not found');
      err.status = 404;
      throw err;
    }

    return updated;
  });
}

/**
 * Share application via URL
 * Generates and stores a unique share token with custom screening settings
 */
async function shareApplicationViaUrl(applicationId, payload = {}) {
  if (!applicationId) {
    const err = new Error('application id is required');
    err.status = 400;
    throw err;
  }

  if (!mongoose.Types.ObjectId.isValid(String(applicationId))) {
    const err = new Error('invalid application id');
    err.status = 400;
    throw err;
  }

  const { screeningSettings } = payload;
  const shareToken = payload.shareToken || generateShareToken();
  const appBase = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
  const shareUrl = `${appBase}/application/${applicationId}/share?token=${shareToken}`;

  await runInTransaction(async (session) => {
    const updated = await findOneAndUpdateOne(
      Application,
      { _id: applicationId, isDeleted: { $ne: true } },
      {
        $set: {
          shareInfo: {
            method: 'url',
            shareToken,
            screeningSettings: screeningSettings || { selectedOption: 'application_only' },
            sharedAt: ClockService.now(),
          },
        },
      },
      withSession({ new: true, runValidators: true }, session)
    );

    if (!updated) {
      const err = new Error('Application not found');
      err.status = 404;
      throw err;
    }

    return updated;
  });

  return { shareToken, shareUrl };
}

/**
 * Send application request email to prospective tenant
 * Simple endpoint that just sends the screening email without creating a lease
 */
async function sendApplicationRequestEmail(data = {}) {
  const { email, screening = [], propertyName = 'Property' } = data;
  const createdBy = requireCreatedBy(data);

  if (!email) {
    const err = new Error('Email is required');
    err.status = 400;
    throw err;
  }

  const emailHelper = require('../../../../../common/helpers/emailHelper');

  try {
    // Get owner details
    const User = require('../../../../../shared/modules/users/models/user.model');
    const safeCreatedBy = toObjectId(createdBy);
    const ownerUser = safeCreatedBy ? await User.findOne({ _id: safeCreatedBy, isDeleted: { $ne: true } }).lean() : null;

    if (!ownerUser) {
      const err = new Error('Owner not found');
      err.status = 404;
      throw err;
    }

    const ownerName = `${ownerUser.firstName || ''} ${ownerUser.lastName || ''}`.trim() || ownerUser.email || 'Your Property Manager';

    // Create application link with createdBy using environment variable
    const screeningBaseUrl = process.env.SCREENING_APPLICATION_BASE_URL ||
      `${(process.env.FRONTEND_BASE_URL || 'http://localhost:8080').replace(/\/$/, '')}/application/screening`;
    const applicationLink = `${screeningBaseUrl}?createdBy=${createdBy}`;
    const screeningLabels = {
      application: 'Application Form',
      credit: 'Credit Check',
      criminal: 'Criminal Background Check',
    };
    const screeningDescriptions = {
      application: 'Complete your rental application and references',
      credit: 'Authorize a credit history review',
      criminal: 'Authorize a criminal background check',
    };
    const screeningChecksList = (Array.isArray(screening) ? screening : [])
      .map(
        (type) =>
          `<div style="background:#fff7ed;border-left:4px solid #f97316;padding:12px 14px;margin:10px 0;border-radius:8px;font-size:14px;line-height:1.5"><strong style="color:#0f172a">${screeningLabels[type] || type}</strong><br/><span style="color:#64748b">${screeningDescriptions[type] || ''}</span></div>`
      )
      .join('');
    const appName = process.env.APP_NAME || 'PropMv';

    await emailHelper.sendEmail(
      'screening-application',
      email,
      {
        tenantName: 'there',
        landlordName: ownerName,
        propertyName,
        appDisplayName: appName,
        screeningTitle: 'Complete your tenant screening',
        screeningIntro: `${ownerName} invited you to complete tenant screening for ${propertyName}.`,
        screeningChecksList,
        applicationUrl: applicationLink,
        screeningCtaText: 'Apply now',
      },
      {
        template: 'screening-application',
        subject: `Complete your tenant screening - ${propertyName}`,
        preheaderText: buildScreeningApplicationPreheader({
          landlordName: ownerName,
          propertyName,
        }),
        replyTo: ownerUser.email,
      }
    );

    logger.info(`Screening invitation email sent to ${email} with createdBy: ${createdBy}`);

    return {
      email,
      screening,
      propertyName,
      createdBy,
      message: 'Application request email sent successfully'
    };
  } catch (err) {
    logger.error('Error sending application request email:', err);
    throw err;
  }
}

/**
 * Check if all tenants with screening requirements have approved applications
 * This is used to determine if we should send invite emails to non-screening tenants
 * @param {Object} lease - The lease document
 * @returns {Boolean} - True if all screening tenants have approved applications
 */
/**
 * Multi-tenant screening status for the lease linked to an application.
 */
async function getLeaseScreeningSummary(applicationId) {
  assertValidApplicationId(applicationId);

  const safeApplicationId = toObjectId(applicationId);
  const app = safeApplicationId ? await Application.findOne({ _id: safeApplicationId, isDeleted: { $ne: true } })
    .select('lease_id')
    .lean() : null;

  if (!app) {
    const err = new Error('Application not found');
    err.status = 404;
    throw err;
  }

  if (!app.lease_id) {
    return {
      leaseId: null,
      leaseStatus: null,
      tenants: [],
      allApplicationScreeningsApproved: false,
      screeningTenantCount: 0,
    };
  }

  const Lease = require('../../leasing/model/lease.model');
  const User = require('../../../../../shared/modules/users/models/user.model');
  const approvedLower = String(APPLICATION_STATUS.APPROVED).toLowerCase();

  const lease = await Lease.findOne({ _id: app.lease_id, isDeleted: { $ne: true } })
    .select('status rentAndDepositDestribution')
    .lean();

  if (!lease) {
    return {
      leaseId: String(app.lease_id),
      leaseStatus: null,
      tenants: [],
      allApplicationScreeningsApproved: false,
      screeningTenantCount: 0,
    };
  }

  const split = lease.rentAndDepositDestribution?.split || [];
  const tenantRows = [];
  let screeningTenantCount = 0;
  let allApproved = true;

  for (const entry of split) {
    const screening = Array.isArray(entry.screening) ? entry.screening : [];
    if (!screening.includes('application')) continue;

    screeningTenantCount += 1;
    const tenantId = String(entry.tenantId || '');

    if (!tenantId || !mongoose.Types.ObjectId.isValid(tenantId)) {
      allApproved = false;
      tenantRows.push({
        tenantId,
        displayName: 'Unknown tenant',
        requiresApplicationScreening: true,
        applicationId: null,
        applicationStatus: 'none',
        isApproved: false,
      });
      continue;
    }

    const user = await User.findById(tenantId).select('firstName lastName email').lean();
    const displayName = user
      ? `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email || 'Tenant'
      : 'Tenant';

    const tenantApp = await Application.findOne({
      lease_id: lease._id,
      tenant_id: tenantId,
      isDeleted: { $ne: true },
    })
      .sort({ createdAt: -1 })
      .select('_id status')
      .lean();

    const applicationStatus = tenantApp?.status ? String(tenantApp.status) : 'none';
    const isApproved = applicationStatus.toLowerCase() === approvedLower;
    if (!isApproved) allApproved = false;

    tenantRows.push({
      tenantId,
      displayName,
      requiresApplicationScreening: true,
      applicationId: tenantApp?._id ? String(tenantApp._id) : null,
      applicationStatus,
      isApproved,
    });
  }

  return {
    leaseId: String(lease._id),
    leaseStatus: lease.status ? String(lease.status) : null,
    tenants: tenantRows,
    allApplicationScreeningsApproved: screeningTenantCount > 0 && allApproved,
    screeningTenantCount,
  };
}

async function checkAllScreeningTenantsApproved(lease) {
  if (!lease) return false;

  const split = lease.rentAndDepositDestribution?.split || [];
  if (split.length === 0) return false;

  const { APPLICATION_STATUS } = require('../../../../../common/constants/application');
  const approvedLower = String(APPLICATION_STATUS.APPROVED).toLowerCase();

  for (const s of split) {
    const screening = Array.isArray(s.screening) ? s.screening : [];
    const needsApplication = screening.includes('application');

    // Only check tenants with screening requirements
    if (needsApplication) {
      const tid = String(s.tenantId || '');
      if (!tid || !mongoose.Types.ObjectId.isValid(tid)) {
        logger.info(`[Application] Invalid tenant ID: ${tid}`);
        return false;
      }

      // Find the latest application for this tenant on this lease
      const app = await Application.findOne({
        lease_id: lease._id,
        tenant_id: tid,
        isDeleted: { $ne: true },
      })
        .sort({ createdAt: -1 })
        .lean();

      const appStatus = app?.status ? String(app.status).toLowerCase() : '';
      logger.info(`[Application] Tenant ${tid} application status: ${appStatus}`);

      if (appStatus !== approvedLower) {
        logger.info(`[Application] Tenant ${tid} application not approved yet (status: ${appStatus})`);
        return false;
      }
    }
  }

  logger.info(`[Application] All screening tenants have approved applications`);
  return true;
}

/**
 * Send invite emails to tenants without screening on a lease
 * This is called after lease activation when an application is approved
 * @param {String} leaseId - Lease ID
 */
async function sendInviteEmailsToNonScreeningTenants(leaseId, options = {}) {
  const { sendLeaseInvitesForNonScreeningTenants } = require('../../leasing/service/leaseTenantInviteDelivery.service');
  return sendLeaseInvitesForNonScreeningTenants(leaseId, options);
}

/**
 * Send invite email to approved tenant who had screening requirement
 * This is called after application approval when lease is ready
 * @param {Object} application - The approved application
 * @param {Object} lease - The lease document
 */
async function sendInviteEmailToApprovedTenant(application, lease, options = {}) {
  if (!application || !lease) return;
  const tenantId = await resolveTenantIdForApprovedApplication(application, lease);
  if (!tenantId || !lease._id) return;
  const { sendLeaseTenantInviteEmail } = require('../../leasing/service/leaseTenantInviteDelivery.service');
  const inviterUserId =
    options.inviterUserId || getCreatorIdFromProperty(application.property_id || lease.property_id);
  return sendLeaseTenantInviteEmail({
    leaseId: String(lease._id),
    tenantId: String(tenantId),
    inviterUserId,
    forceLeaseInviteEmail: true,
  });
}

async function acknowledgeLeaseInvitePublic({ leaseId, tenantId } = {}) {
  const { acknowledgeLeaseInvite } = require('../../leasing/service/leaseAutoApproval.service');
  return acknowledgeLeaseInvite(leaseId, tenantId);
}

module.exports = {
  createApplication,
  updateApplication,
  getApplicationById,
  getLeaseScreeningSummary,
  listApplications,
  deleteApplication,
  approveApplication,
  rejectApplication,
  updateScreeningInfo,
  getApplicantNames,
  addNote,
  addComment,
  createBlankApplicationForTenant,
  submitScreeningApplication,
  shareApplicationViaEmail,
  shareApplicationViaUrl,
  sendApplicationRequestEmail,
  acknowledgeLeaseInvitePublic,
};

/* -------------------------------------------------------------------------- */
/* Export helpers (merged from applicationExport.service.js)                  */
/* -------------------------------------------------------------------------- */
const ExcelJS = require('exceljs');

async function exportApplicationsAsCSV(filters = {}) {
  const filtersWithoutPagination = { ...filters };
  delete filtersWithoutPagination.pageNumber;
  delete filtersWithoutPagination.pageSize;

  const result = await listApplications(filtersWithoutPagination);
  const data = (result && result.items) || [];

  if (!data || data.length === 0) {
    return { filename: `applications_export_${Date.now()}.csv`, content: 'No applications found', contentType: 'text/csv' };
  }

  const headers = ['applicantName', 'email', 'phone', 'property', 'propertyAddress', 'status', 'annualIncome', 'creditScore', 'appliedOn', 'moveInDate'];

  /**
   * csv Escape
   *
   * Performs logic operations for csvEscape.
   *
   * @param val - Request/input argument
   * @returns Operations result
   */
  function csvEscape(val) {
    if (val === null || typeof val === 'undefined') return '""';
    if (typeof val === 'object') {
      try { val = JSON.stringify(val); } catch { val = String(val); }
    }
    let s = String(val);
    if (/^[+\-=@]/.test(s.charAt(0))) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  const rows = [headers.join(',')];
  for (const rowObj of data) {
    const mapped = {
      applicantName: rowObj.applicantName || '',
      email: rowObj.email || '',
      phone: rowObj.phone || '',
      property: rowObj.property || '',
      propertyAddress: rowObj.propertyAddress || '',
      status: rowObj.status || '',
      annualIncome: rowObj.annualIncome || 'N/A',
      creditScore: rowObj.residentScore || 'N/A',
      appliedOn: rowObj.appliedOn || '',
      moveInDate: rowObj.moveInDate || ''
    };
    const row = headers.map(h => csvEscape(mapped[h]));
    rows.push(row.join(','));
  }

  const csv = rows.join('\n');
  const ts = DateUtil.buildExportFilenameTimestamp();
  const filename = `applications_${ts}.csv`;

  return { filename, content: csv, contentType: 'text/csv' };
}

async function exportApplicationsAsExcel(filters = {}) {
  const filtersWithoutPagination = { ...filters };
  delete filtersWithoutPagination.pageNumber;
  delete filtersWithoutPagination.pageSize;

  const result = await listApplications(filtersWithoutPagination);
  const data = (result && result.items) || [];

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Applications');

  worksheet.columns = [
    { header: 'Applicant Name', key: 'applicantName', width: 25 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Phone', key: 'phone', width: 18 },
    { header: 'Property', key: 'property', width: 30 },
    { header: 'Property Address', key: 'propertyAddress', width: 40 },
    { header: 'Status', key: 'status', width: 15 },
    { header: 'Annual Income', key: 'annualIncome', width: 18 },
    { header: 'Credit Score', key: 'creditScore', width: 15 },
    { header: 'Applied On', key: 'appliedOn', width: 20 },
    { header: 'Move In Date', key: 'moveInDate', width: 18 }
  ];

  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE0E0E0' }
  };

  for (const rowObj of data) {
    worksheet.addRow({
      applicantName: rowObj.applicantName || '',
      email: rowObj.email || '',
      phone: rowObj.phone || '',
      property: rowObj.property || '',
      propertyAddress: rowObj.propertyAddress || '',
      status: rowObj.status || '',
      annualIncome: rowObj.annualIncome || 'N/A',
      creditScore: rowObj.residentScore || 'N/A',
      appliedOn: rowObj.appliedOn || '',
      moveInDate: rowObj.moveInDate || ''
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();

  const ts = DateUtil.buildExportFilenameTimestamp();
  const filename = `applications_${ts}.xlsx`;

  return { filename, content: buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}

async function exportApplicationsAsJSON(filters = {}) {
  const filtersWithoutPagination = { ...filters };
  delete filtersWithoutPagination.pageNumber;
  delete filtersWithoutPagination.pageSize;

  const result = await listApplications(filtersWithoutPagination);
  const data = (result && result.items) || [];

  const exportData = data.map(rowObj => ({
    applicantName: rowObj.applicantName || '',
    email: rowObj.email || '',
    phone: rowObj.phone || '',
    property: rowObj.property || '',
    propertyAddress: rowObj.propertyAddress || '',
    status: rowObj.status || '',
    annualIncome: rowObj.annualIncome || 'N/A',
    creditScore: rowObj.residentScore || 'N/A',
    appliedOn: rowObj.appliedOn || '',
    moveInDate: rowObj.moveInDate || '',
    employmentHistory: rowObj.employmentHistory || [],
    rentalHistory: rowObj.rentalHistory || [],
    references: rowObj.references || [],
    emergencyContact: rowObj.emergencyContact || {}
  }));

  const json = JSON.stringify({ applications: exportData, total: data.length, exportedAt: DateUtil.toISO(ClockService.now()) }, null, 2);

  const ts = DateUtil.buildExportFilenameTimestamp();
  const filename = `applications_${ts}.json`;

  return { filename, content: json, contentType: 'application/json' };
}

async function exportApplications(filters = {}, format = 'csv') {
  const formatLower = String(format).toLowerCase();
  switch (formatLower) {
    case 'xlsx':
    case 'excel':
      return await exportApplicationsAsExcel(filters);
    case 'json':
      return await exportApplicationsAsJSON(filters);
    case 'csv':
    default:
      return await exportApplicationsAsCSV(filters);
  }
}

// Export the export function on module.exports
module.exports.exportApplications = exportApplications;

