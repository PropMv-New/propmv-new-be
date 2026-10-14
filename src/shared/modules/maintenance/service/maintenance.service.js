/**
 * ------------------------------------------------------------------
 * File: maintenance.service.js
 * Module: Maintenance Module
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * dashboard.service, maintenance.controller, maintenanceExport.service
 * ------------------------------------------------------------------
 */
const mongoose = require('mongoose');
const MaintenanceRequest = require('../model/maintenanceRequest.model');
const logger = require('../../../../common/logger');
const {
    resolveUnitForPropertyId,
    unitSubdocumentForMaintenance,
    unitDisplayNameFromMaintenance,
} = require('../../../../common/helpers/propertyUnitReference');
const { MAINTENANCE_REQUEST_STATUS } = require('../../../../common/constants/property');
const s3Client = require('../../../../integrations/s3');
const { UPLOAD_MAINTENANCE_SUBDIR } = require('../../../../common/constants/uploads');
const {
    sendMaintenanceRequestCreatedEmail,
    sendMaintenanceVendorAssignedEmail,
    sendMaintenanceActivityEmails,
} = require('../../../../common/helpers/maintenanceEmailHelper');
const { normalizeUserId, normalizeRequestedByUserIds, filterMaintenanceNotifyUserIds } = require('../../../../common/helpers/maintenanceEmailRecipients');
const {
    resolveMaintenanceNotificationRecipients,
} = require('../../../../common/helpers/hoaRecipientResolver');
const { enqueueOrRunInBackground } = require('../../../../common/jobs/enqueue');
const { JOB_TYPES } = require('../../../../common/jobs/constants');
const { buildJobIdempotencyKey } = require('../../../../common/jobs/idempotency');
const {
    findPropertyIdsByCreatedBy,
    requireCreatedBy,
    resolveCreatedBy,
    stripLegacyOwnerFields,
} = require('../../../../shared/utils/creatorScope.util');
const { withMaintenanceTransaction, applySession } = require('./maintenanceDb.util');
const { notifyActionUpdateInBackground } = require('../../notifications/service/actionUpdateEmail.service');
const {
    notifyMaintenanceUpdatedInAppInBackground,
    notifyMaintenanceCommentInAppInBackground,
    notifyMaintenanceNoteInAppInBackground,
    notifyMaintenanceDocumentsInAppInBackground,
    notifyMaintenanceCreatedInAppInBackground,
    notifyMaintenanceVendorAssignedInAppInBackground,
} = require('../../../../common/helpers/hoaInAppNotify.helper');
const { loadHoaMemberUserIds } = require('../../../../middleware/hoaDataIsolation');
const {
    isVendorMaintenanceActionAllowed,
    vendorMaintenanceDeniedError,
    isVendorAllowedMaintenanceStatus,
} = require('../helpers/vendorMaintenanceAccess.helper');
const { planMaintenanceUnitUpdate } = require('../helpers/normalizeMaintenanceUnitUpdate');
const {
    applyPrivateMaintenanceNotesForViewer,
    assertMaintenanceNoteOwner,
    findMaintenanceNoteById,
} = require('../helpers/maintenanceNoteAccess.helper');
const {
    attachMaintenanceAuditSnapshot,
    enrichMaintenanceAuditDisplay,
    buildMaintenanceActivityEntry,
    resolveMaintenanceActivityActor,
    updatesIncludeMaintenanceEditFields,
    isMaintenanceReopenUpdate,
} = require('../helpers/maintenanceAuditHelper');
const { resolveMaintenanceTicketNumber } = require('../helpers/maintenanceTicketNumber.helper');
const { buildMaintenanceSearchOrClauses } = require('../helpers/maintenanceListSearch.helper');
const { ClockService, DateUtil } = require('../../../../common/date');
const { isVendorRole } = require('../../../../common/helpers/hoaVendorRole');
const User = require('../../users/models/user.model');
const { buildHOAOwnerUserFilter } = require('../../../../common/helpers/hoaOwnerRole');
const {
    assertOwnerEligibleForMaintenanceRequest,
} = require('../../../../portals/hoa-board/modules/owners/helpers/ownerEligibility.helper');

const ALLOWED_CATEGORIES = ['Plumbing', 'Electrical', 'HVAC', 'Appliance', 'Structural', 'Pest Control', 'Landscaping', 'Other'];
const ALLOWED_PRIORITIES = ['Low', 'Medium', 'High', 'Emergency'];

const legacyMissingHoaIdClause = () => ({
    $or: [{ hoaId: null }, { hoaId: { $exists: false } }],
});

/** Tickets in the active HOA: explicit hoaId, legacy property rows, and legacy member rows. */
function buildHoaCommunityMaintenanceScope(hoaId, propertyIds = [], memberUserIds = []) {
    const hoaIdOid = new mongoose.Types.ObjectId(String(hoaId));
    const scopeOr = [{ hoaId: hoaIdOid }];
    if (propertyIds.length > 0) {
        const propOids = propertyIds.map((id) => new mongoose.Types.ObjectId(String(id)));
        scopeOr.push({
            $and: [legacyMissingHoaIdClause(), { property_id: { $in: propOids } }],
        });
    }
    const memberOids = [];
    for (const rawId of memberUserIds) {
        const str = String(rawId || '').trim();
        if (!str || !mongoose.Types.ObjectId.isValid(str)) continue;
        if (!memberOids.some((id) => String(id) === str)) {
            memberOids.push(new mongoose.Types.ObjectId(str));
        }
    }
    if (memberOids.length > 0) {
        scopeOr.push({
            $and: [
                legacyMissingHoaIdClause(),
                {
                    $or: [
                        { createdBy: { $in: memberOids } },
                        { requestedBy: { $in: memberOids } },
                    ],
                },
            ],
        });
    }
    return scopeOr;
}

/**
 * build Maintenance Query From Scope Or
 *
 * Performs logic operations for buildMaintenanceQueryFromScopeOr.
 *
 * @param scopeOr - Request/input argument
 * @returns Operations result
 */
function buildMaintenanceQueryFromScopeOr(scopeOr) {
    const base = { isDeleted: { $ne: true } };
    if (!scopeOr || scopeOr.length === 0) return null;
    if (scopeOr.length === 1) return { ...base, ...scopeOr[0] };
    return { ...base, $or: scopeOr };
}

async function resolveHoaBoardMaintenancePropertyIds(userContext) {
    const { resolveHoaPropertyIds, getCachedHoaPropertyIds } = require('../../../../common/helpers/hoaPropertyScope');
    const { buildHoaBoardPropertyMatch, buildActiveHoaIdMatch } = require('../../../../middleware/hoaDataIsolation');
    const HOAProperty = require('../../../../portals/hoa-board/modules/property/model/property.model');

    let hoaPropIds = getCachedHoaPropertyIds(userContext);
    if (hoaPropIds == null) {
        hoaPropIds = await resolveHoaPropertyIds(userContext);
    }
    if (!Array.isArray(hoaPropIds)) {
        hoaPropIds = [];
    }
    if (hoaPropIds.length === 0 && userContext?.isHOABoardMember) {
        const hoaMatch = buildHoaBoardPropertyMatch(userContext);
        if (hoaMatch) {
            const props = await HOAProperty.find(hoaMatch).select('_id').lean();
            hoaPropIds = props.map((p) => p._id);
        }
    }
    if (hoaPropIds.length === 0 && userContext?.hoaId) {
        const activeHoaMatch = buildActiveHoaIdMatch(userContext);
        if (activeHoaMatch) {
            const props = await HOAProperty.find({
                ...activeHoaMatch,
                isDeleted: { $ne: true },
            }).select('_id').lean();
            hoaPropIds = props.map((p) => p._id);
        }
    }
    return hoaPropIds;
}

async function resolveHoaBoardMaintenanceScopeOr(userContext) {
    if (!userContext?.hoaId || !mongoose.Types.ObjectId.isValid(String(userContext.hoaId))) {
        return [];
    }
    const hoaPropIds = await resolveHoaBoardMaintenancePropertyIds(userContext);
    const memberUserIds = Array.isArray(userContext.hoaMemberUserIds) && userContext.hoaMemberUserIds.length
        ? userContext.hoaMemberUserIds
        : (userContext.userId ? [userContext.userId] : []);
    return buildHoaCommunityMaintenanceScope(userContext.hoaId, hoaPropIds, memberUserIds);
}

/**
 * build Owner Maintenance Ticket Match
 *
 * Performs logic operations for buildOwnerMaintenanceTicketMatch.
 *
 * @param ownerOid - Request/input argument
 * @param ownerPropIds - Request/input argument
 * @returns Operations result
 */
function buildOwnerMaintenanceTicketMatch(ownerOid, ownerPropIds = []) {
    const match = [
        { requestedBy: ownerOid },
        { createdBy: ownerOid },
    ];
    if (ownerPropIds.length > 0) {
        match.push({ property_id: { $in: ownerPropIds } });
    }
    return match;
}

/** Owner list scope: with HOA header, limit to that community; otherwise all owner-associated tickets. */
function buildOwnerMaintenanceListScope(userContext, ownerOid, ownerPropIds = []) {
    const ownerTicketMatch = buildOwnerMaintenanceTicketMatch(ownerOid, ownerPropIds);
    if (userContext?.hoaId && mongoose.Types.ObjectId.isValid(String(userContext.hoaId))) {
        const hoaIdOid = new mongoose.Types.ObjectId(String(userContext.hoaId));
        const scopeOr = [{ hoaId: hoaIdOid, $or: ownerTicketMatch }];
        if (ownerPropIds.length > 0) {
            scopeOr.push({
                $and: [legacyMissingHoaIdClause(), { property_id: { $in: ownerPropIds } }],
            });
        }
        return scopeOr;
    }
    return [{ $or: ownerTicketMatch }];
}

/**
 * Apply HOA/owner list scope without clobbering an existing search `$or`.
 * Board community scope often has multiple `$or` branches (hoaId + legacy
 * property/member fallbacks); assigning that onto `q.$or` used to wipe title/ticket search.
 */
function applyMaintenanceListScopeToQuery(q, scopeOr, specificPropertyId) {
    const searchOr = Array.isArray(q.$or) ? q.$or : null;
    if (searchOr) {
        delete q.$or;
    }

    if (specificPropertyId) {
        q.$and = q.$and || [];
        q.$and.push({ $or: scopeOr });
        q.$and.push({ property_id: new mongoose.Types.ObjectId(String(specificPropertyId)) });
        delete q.property_id;
        if (searchOr) {
            q.$and.push({ $or: searchOr });
        }
        return;
    }

    // Single scope clause and no search: keep the cheap Object.assign path.
    if (scopeOr.length === 1 && !searchOr) {
        Object.assign(q, scopeOr[0]);
        return;
    }

    q.$and = q.$and || [];
    if (scopeOr.length === 1) {
        q.$and.push(scopeOr[0]);
    } else {
        q.$and.push({ $or: scopeOr });
    }
    if (searchOr) {
        q.$and.push({ $or: searchOr });
    }
}

async function resolveMaintenanceHoaIdForCreate(data, { userContext, requiresHoaScope, session }) {
    const fromPayload = data.hoaId && mongoose.Types.ObjectId.isValid(String(data.hoaId))
        ? String(data.hoaId).trim()
        : null;
    const fromContext = userContext?.hoaId
        ? String(userContext.hoaId).trim()
        : null;
    let hoaId = fromPayload || fromContext || null;

    if (data.property_id) {
        const HOAProperty = require('../../../../portals/hoa-board/modules/property/model/property.model');
        const prop = await applySession(
            HOAProperty.findOne({ _id: data.property_id, isDeleted: { $ne: true } }).select('hoaId'),
            session
        ).lean();
        if (!prop) {
            const err = new Error('property not found');
            err.status = 404;
            throw err;
        }
        if (prop.hoaId) {
            const propHoaId = String(prop.hoaId);
            if (hoaId && propHoaId !== hoaId) {
                const err = new Error('Property does not belong to the active community');
                err.status = 400;
                throw err;
            }
            hoaId = hoaId || propHoaId;
        }
    }

    if (requiresHoaScope && !hoaId) {
        const err = new Error('Active HOA community is required to create maintenance tickets');
        err.status = 400;
        throw err;
    }

    return hoaId && mongoose.Types.ObjectId.isValid(hoaId)
        ? new mongoose.Types.ObjectId(hoaId)
        : null;
}

async function applyHoaCreateScope(data, { userContext, requiresHoaScope, session, actorUserId }) {
    if (actorUserId && mongoose.Types.ObjectId.isValid(String(actorUserId))) {
        data.createdBy = new mongoose.Types.ObjectId(String(actorUserId));
    }

    const resolvedHoaId = await resolveMaintenanceHoaIdForCreate(data, {
        userContext,
        requiresHoaScope,
        session,
    });
    if (resolvedHoaId) {
        data.hoaId = resolvedHoaId;
    }
}

/** Normalize requestedBy from string or string[] to a deduped list of ObjectIds (min length 1). */
function normalizeRequestedByToObjectIds(input) {
    if (input == null || input === '') return null;
    const arr = Array.isArray(input) ? input : [input];
    const out = [];
    for (const id of arr) {
        const s = String(id == null ? '' : id).trim();
        if (!s || !mongoose.Types.ObjectId.isValid(s)) continue;
        const oid = new mongoose.Types.ObjectId(s);
        if (!out.some((x) => String(x) === String(oid))) out.push(oid);
    }
    return out.length ? out : null;
}

async function assertRequestedByOwnersEligible(requestedByIds, session = null) {
    if (!Array.isArray(requestedByIds) || requestedByIds.length === 0) return;

    const ownerRoleFilter = await buildHOAOwnerUserFilter();
    let ownerQuery = User.find({
        $and: [ownerRoleFilter, { _id: { $in: requestedByIds } }],
    }).select('portalOnboardingStatus status isArchived isDeleted');
    if (session) ownerQuery = ownerQuery.session(session);
    const owners = await ownerQuery.lean();

    for (const owner of owners) {
        assertOwnerEligibleForMaintenanceRequest(owner);
    }
}

function normalizePartyUserId(value) {
    return normalizeUserId(value);
}

/**
 * maintenance Requested By User Ids
 *
 * Performs logic operations for maintenanceRequestedByUserIds.
 *
 * @param doc - Request/input argument
 * @returns Operations result
 */
function maintenanceRequestedByUserIds(doc) {
    if (!doc || !doc.requestedBy) return [];
    return normalizeRequestedByUserIds(doc.requestedBy);
}

/**
 * get Maintenance Notification Target
 *
 * Performs logic operations for getMaintenanceNotificationTarget.
 *
 * @param doc - Request/input argument
 * @returns Operations result
 */
function getMaintenanceNotificationTarget(doc) {
    const assignedId = normalizePartyUserId(doc && doc.assignedTo);
    const propertyId = doc && doc.property_id
        ? (doc.property_id._id || doc.property_id)
        : undefined;
    const userIds = filterMaintenanceNotifyUserIds(
        doc,
        [...maintenanceRequestedByUserIds(doc), assignedId].filter(Boolean)
    );
    return {
        propertyId,
        userIds,
    };
}

async function formatMaintenanceRequestResponse(saved, session) {
    const Property = require('../../../../portals/landlord/modules/property/model/property.model');
    const plainSaved = saved.toObject ? saved.toObject() : saved;
    let prop = null;
    if (plainSaved.property_id) {
        prop = await applySession(
            Property.findOne({ _id: plainSaved.property_id, isDeleted: { $ne: true } }).select('unitDetails'),
            session
        ).lean();
    }
    const displayUnit = unitDisplayNameFromMaintenance(prop, plainSaved);
    return enrichMaintenanceAuditDisplay(
        Object.assign({}, plainSaved, { units: displayUnit, unitName: displayUnit })
    );
}

/**
 * schedule Maintenance Created Email
 *
 * Performs logic operations for scheduleMaintenanceCreatedEmail.
 *
 * @param saved - Request/input argument
 * @returns Operations result
 */
function scheduleMaintenanceCreatedEmail(saved) {
    const maintenanceId = saved?._id;

    // Transactional create emails must run immediately.
    // Do NOT defer to the daily HOA_MAINTENANCE_NOTIFICATION_* schedule slot —
    // that slot is for batch/reminder sweeps, not ticket-created delivery.
    enqueueOrRunInBackground({
        jobType: JOB_TYPES.MAINTENANCE_CREATED,
        entityType: 'Maintenance',
        entityId: maintenanceId,
        idempotencyKey: buildJobIdempotencyKey('MAINTENANCE_CREATED', maintenanceId),
        payload: { maintenanceId: maintenanceId ? String(maintenanceId) : '' },
        run: () => sendMaintenanceRequestCreatedEmail(saved),
    });
}

/**
 * Dashboard Recent Activity (Activity collection). Ticket activityLog is separate.
 * Failures must not block create/update responses.
 */
async function logMaintenanceDashboardActivity({
    userId,
    action,
    request,
    description,
    hoaId,
} = {}) {
    if (!userId || !request?._id) return;
    try {
        const { logActivity } = require('../../../../portals/hoa-board/modules/dashboard/service/activity.service');
        const ticketNumber = resolveMaintenanceTicketNumber(request);
        const title = String(request.title || '').trim();
        const entityName = title || ticketNumber || 'Maintenance request';
        const normalizedAction = String(action || '').toUpperCase();
        const defaultDescription = normalizedAction === 'CREATE'
            ? `Created maintenance request${ticketNumber ? ` ${ticketNumber}` : ''}${title ? `: ${title}` : ''}`
            : `Updated maintenance request${ticketNumber ? ` ${ticketNumber}` : ''}${title ? `: ${title}` : ''}`;
        const propertyId = request.property_id && typeof request.property_id === 'object'
            ? (request.property_id._id || request.property_id)
            : request.property_id;

        await logActivity({
            userId,
            action: normalizedAction,
            module: 'Maintenance',
            entityId: request._id,
            entityName,
            description: description || defaultDescription,
            hoaId: hoaId || request.hoaId,
            meta: {
                ticketNumber: ticketNumber || undefined,
                status: request.status,
                propertyId: propertyId || undefined,
            },
        });
    } catch (err) {
        logger.error('Failed to log maintenance dashboard activity:', err);
    }
}

/**
 * Persist a maintenance request inside a transaction.
 */
async function createMaintenanceRequestInSession(data, session) {
    if (!data) {
        const err = new Error('request data is required');
        err.status = 400;
        throw err;
    }
    if (!data.title) {
        const err = new Error('title is required');
        err.status = 400;
        throw err;
    }
    if (!data.description) {
        const err = new Error('description is required');
        err.status = 400;
        throw err;
    }
    if (typeof data.isUrgent !== 'boolean') {
        const err = new Error('isUrgent is required and must be boolean');
        err.status = 400;
        throw err;
    }
    if (typeof data.notifyTenant !== 'boolean') {
        const err = new Error('notifyTenant is required and must be boolean');
        err.status = 400;
        throw err;
    }

    if (data.property_id && !mongoose.Types.ObjectId.isValid(String(data.property_id))) {
        const err = new Error('property_id must be a valid ObjectId');
        err.status = 400;
        throw err;
    }

    if (!data.primaryRequestType && !data.category) {
        const err = new Error('category or primaryRequestType is required');
        err.status = 400;
        throw err;
    }
    if (data.category && !ALLOWED_CATEGORIES.includes(data.category)) {
        const err = new Error('invalid category');
        err.status = 400;
        throw err;
    }

    const rbIds = normalizeRequestedByToObjectIds(data.requestedBy);
    // Requested-by is optional; persist an empty list when none selected.
    data.requestedBy = rbIds || [];
    await assertRequestedByOwnersEligible(data.requestedBy, session);

    if (data.property_id) {
        const Property = require('../../../../portals/landlord/modules/property/model/property.model');
        const prop = await applySession(
            Property.findOne({ _id: data.property_id, isDeleted: { $ne: true } }),
            session
        ).lean();
        if (!prop) {
            const err = new Error('property not found');
            err.status = 404;
            throw err;
        }

        if (data.unitId || data.units) {
            const resolved = await resolveUnitForPropertyId(
                data.property_id,
                data.unitId ? { unitId: data.unitId } : { unitName: data.units },
                { session }
            );
            data.unitId = resolved.unitId;
        }
    }

    if (data.assignedTo != null && data.assignedTo !== '') {
        if (!mongoose.Types.ObjectId.isValid(String(data.assignedTo))) {
            const err = new Error('assignedTo must be a valid ObjectId');
            err.status = 400;
            throw err;
        }
        data.assignedTo = new mongoose.Types.ObjectId(String(data.assignedTo));
        // Assigning a vendor at create time moves the ticket into active work.
        if (!data.status || String(data.status) === MAINTENANCE_REQUEST_STATUS.OPEN) {
            data.status = MAINTENANCE_REQUEST_STATUS.IN_PROGRESS;
        }
    }

    const { units: _omitUnits, ...persistData } = data;
    await attachMaintenanceAuditSnapshot(persistData, { session });
    const doc = new MaintenanceRequest(Object.assign({}, persistData));
    const created = await MaintenanceRequest.create([doc], { session });
    return created[0];
}

async function createMaintenanceRequest(data, options = {}) {
    assertVendorCannotCreateOrDeleteTickets(options);
    const runPostCommitEmail = !options.session;
    const saved = await withMaintenanceTransaction(async (session) => {
        await applyHoaCreateScope(data, {
            userContext: options.userContext,
            requiresHoaScope: options.requiresHoaScope,
            session,
            actorUserId: options.userId,
        });
        return createMaintenanceRequestInSession(data, session);
    }, options);
    if (runPostCommitEmail) {
        // In-app must not wait on the delayed email/job path (board/owner/vendor bell).
        notifyMaintenanceCreatedInAppInBackground(saved, options.userId || null);
        scheduleMaintenanceCreatedEmail(saved);
        await logMaintenanceDashboardActivity({
            userId: options.userId,
            action: 'CREATE',
            request: saved,
            hoaId: options.userContext?.hoaId || options.hoaContext?.hoaId,
        });
    }
    const formatted = await formatMaintenanceRequestResponse(saved);
    return formatted;
}

/**
 * Create request and attach uploaded documents in a single transaction.
 */
async function createMaintenanceRequestWithDocuments(data, options = {}) {
    assertVendorCannotCreateOrDeleteTickets(options);
    const files = (options.files || []).filter((f) => f && (f.size || 0) > 0 && f.path);
    const uploadedBy = options.uploadedBy || options.userId;

    const saved = await withMaintenanceTransaction(async (session) => {
        await applyHoaCreateScope(data, {
            userContext: options.userContext,
            requiresHoaScope: options.requiresHoaScope,
            session,
            actorUserId: options.userId,
        });
        const created = await createMaintenanceRequestInSession(data, session);
        if (!files.length) {
            return created;
        }
        const { request } = await uploadDocumentsInSession(String(created._id), files, { session, uploadedBy });
        return request;
    }, options);

    if (!options.session) {
        // In-app must not wait on the delayed email/job path (board/owner/vendor bell).
        notifyMaintenanceCreatedInAppInBackground(saved, options.userId || null);
        scheduleMaintenanceCreatedEmail(saved);
        await logMaintenanceDashboardActivity({
            userId: options.userId,
            action: 'CREATE',
            request: saved,
            hoaId: options.userContext?.hoaId || options.hoaContext?.hoaId,
        });
    }
    const formatted = await formatMaintenanceRequestResponse(saved);
    return formatted;
}

async function getMaintenanceRequestById(id, options = {}) {
    if (!id) { const err = new Error('id is required'); err.status = 400; throw err; }
    if (!mongoose.Types.ObjectId.isValid(String(id))) { const err = new Error('id must be a valid ObjectId'); err.status = 400; throw err; }

    const req = await MaintenanceRequest.findOne({ _id: id, isDeleted: { $ne: true } })
        .populate('requestedBy', 'firstName lastName email')
        .populate('createdBy', 'firstName lastName email')
        .populate('assignedTo', 'firstName lastName email')
        .populate('property_id', 'name address ownerName ownerEmail ownerPhone unitDetails hoaId')
        .populate('documents.metadataId') // Populate complete DocumentMetadata object
        .populate('documents.uploadedBy', 'firstName lastName email')
        .populate('comments.author', 'firstName lastName email')
        .populate('notes.author', 'firstName lastName email')
        .lean();

    if (!req) { const err = new Error('Maintenance request not found'); err.status = 404; throw err; }

    const vendorContext = options.userContext || options.hoaContext;
    const vendorActor = isVendorActor({ userContext: vendorContext });
    if (vendorActor) {
        const actorId = maintenanceIdString(
            options.userId || vendorContext?.userId
        );
        const assignedTo = normalizePartyUserId(req.assignedTo) || '';
        if (!actorId || !assignedTo || assignedTo !== actorId) {
            const err = new Error('Access denied');
            err.status = 403;
            throw err;
        }
        // Assigned vendors may open tickets across associated communities (list is
        // already cross-community). Skip active-hoa isolation here; frontend may
        // still auto-switch the community chrome for UI consistency.
    } else if (options.hoaContext?.hoaId) {
        const activeHoaId = String(options.hoaContext.hoaId);
        if (req.hoaId && String(req.hoaId) !== activeHoaId) {
            const err = new Error('Maintenance request not found');
            err.status = 404;
            throw err;
        }
        if (!req.hoaId && req.property_id?.hoaId && String(req.property_id.hoaId) !== activeHoaId) {
            const err = new Error('Maintenance request not found');
            err.status = 404;
            throw err;
        }
    }

    const Property = require('../../../../portals/landlord/modules/property/model/property.model');
    let property = null;
    if (req.property_id) {
        property =
            typeof req.property_id === 'object' && Array.isArray(req.property_id.unitDetails)
                ? req.property_id
                : await Property.findOne({ _id: req.property_id._id || req.property_id, isDeleted: { $ne: true } }).select('unitDetails').lean();
    }

    const unitSub = unitSubdocumentForMaintenance(property, req);
    const unitDetails = unitSub
        ? {
            unitType: unitSub.unitType,
            squareFeet: unitSub.squareFeet,
            bedRooms: unitSub.bedRooms,
            bathRoom: unitSub.bathRoom,
        }
        : null;

    const displayUnit = unitDisplayNameFromMaintenance(property, req);

    const enhancedRequest = {
        ...req,
        propertyName: req.property_id?.name || null,
        propertyAddress: req.property_id?.address || null,
        unitName: displayUnit,
        units: displayUnit,
        unitDetails,
        property_id: req.property_id?._id || null,
    };

    const userContext = options.userContext || options.hoaContext;
    const viewerUserId = options.userId || userContext?.userId;
    const scopedRequest = applyPrivateMaintenanceNotesForViewer(
        enhancedRequest,
        viewerUserId,
        userContext
    );

    return enrichMaintenanceAuditDisplay(scopedRequest);
}

async function listMaintenanceRequests(filter = {}, { pageNumber, pageSize, userContext = null } = {}) {
    if (isVendorActor({ userContext }) && userContext.userId) {
        filter = { ...filter, vendorId: String(userContext.userId) };
    }
    const q = Object.assign({ isDeleted: { $ne: true } }, filter);
    const createdBy = resolveCreatedBy(filter);

    // Handle search text by title / ticket / description / property / requester.
    // Applied before HOA scope so applyMaintenanceListScopeToQuery can AND them.
    if (filter.searchText) {
        const searchOr = await buildMaintenanceSearchOrClauses(filter.searchText, userContext);
        if (searchOr && searchOr.length > 0) {
            q.$or = searchOr;
        }
        delete q.searchText;
    }

    // Skip landlord property-owner scoping when HOA list scopes are active.
    if (filter.hoaBoardMemberId || filter.hoaOwnerId || filter.vendorId) {
        delete q.createdBy;
    }

    // Handle owner filtering by finding properties owned by the user.
    // Skip when HOA board/owner/vendor list scopes are active - they use community property IDs instead.
    if (createdBy && !filter.hoaBoardMemberId && !filter.hoaOwnerId && !filter.vendorId) {
        const Property = require('../../../../portals/landlord/modules/property/model/property.model');
        const ownerId = requireCreatedBy({ createdBy });
        const propertyIds = await findPropertyIdsByCreatedBy(Property, ownerId);
        if (propertyIds.length === 0) {
            return { data: [], total: 0, page: pageNumber || 1, pageSize: pageSize || 10 };
        }
        if (filter.property_id) {
            if (!mongoose.Types.ObjectId.isValid(String(filter.property_id))) {
                const err = new Error('property_id must be a valid ObjectId'); err.status = 400; throw err;
            }
            const scopedPropertyId = String(filter.property_id);
            if (!propertyIds.some((id) => String(id) === scopedPropertyId)) {
                return { data: [], total: 0, page: pageNumber || 1, pageSize: pageSize || 10 };
            }
            q.property_id = new mongoose.Types.ObjectId(scopedPropertyId);
        } else {
            q.property_id = { $in: propertyIds };
        }
        delete q.createdBy;
        stripLegacyOwnerFields(q);
    }

    // Handle hoaBoardMemberId filter: scope by active community (hoaId), not requester identity
    if (filter.hoaBoardMemberId) {
        if (!mongoose.Types.ObjectId.isValid(String(filter.hoaBoardMemberId))) {
            const err = new Error('hoaBoardMemberId must be a valid ObjectId'); err.status = 400; throw err;
        }
        if (!userContext?.hoaId) {
            return { data: [], total: 0, page: pageNumber || 1, pageSize: pageSize || 10 };
        }
        const scopeOr = await resolveHoaBoardMaintenanceScopeOr(userContext);
        const specificPropertyId = typeof filter.property_id === 'string' && filter.property_id
            ? filter.property_id
            : null;
        applyMaintenanceListScopeToQuery(q, scopeOr, specificPropertyId);
        delete q.hoaBoardMemberId;
    }

    // Handle hoaOwnerId filter: tickets the owner requested, created, or tied to their units
    if (filter.hoaOwnerId) {
        if (!mongoose.Types.ObjectId.isValid(String(filter.hoaOwnerId))) {
            const err = new Error('hoaOwnerId must be a valid ObjectId'); err.status = 400; throw err;
        }
        const HOAProperty = require('../../../../portals/hoa-board/modules/property/model/property.model');
        const { buildActiveHoaIdMatch } = require('../../../../middleware/hoaDataIsolation');
        const ownerOid = new mongoose.Types.ObjectId(String(filter.hoaOwnerId));
        const ownerPropQuery = { associatedOwnerIds: ownerOid, isDeleted: { $ne: true } };
        const hoaMatch = buildActiveHoaIdMatch(userContext);
        if (hoaMatch) {
            Object.assign(ownerPropQuery, hoaMatch);
        }
        const ownerProps = await HOAProperty.find(ownerPropQuery).select('_id').lean();
        const ownerPropIds = ownerProps.map((p) => p._id);
        const scopeOr = buildOwnerMaintenanceListScope(userContext, ownerOid, ownerPropIds);
        const specificPropertyId = typeof filter.property_id === 'string' && filter.property_id
            ? filter.property_id
            : null;
        applyMaintenanceListScopeToQuery(q, scopeOr, specificPropertyId);
        delete q.hoaOwnerId;
    }

    // Handle vendorId filter: tickets assigned to this vendor user (any HOA / landlord flow)
    if (filter.vendorId) {
        if (!mongoose.Types.ObjectId.isValid(String(filter.vendorId))) {
            const err = new Error('vendorId must be a valid ObjectId'); err.status = 400; throw err;
        }
        q.assignedTo = new mongoose.Types.ObjectId(String(filter.vendorId));
        // Do not force hoaId scoping - vendors are not HOA-bound; they see all tickets assigned to them.
        delete q.vendorId;
    }

    // Handle requestedBy filter (used by tenants / PMs) - matches scalar or array field
    if (filter.requestedBy) {
        if (!mongoose.Types.ObjectId.isValid(String(filter.requestedBy))) {
            const err = new Error('requestedBy must be a valid ObjectId'); err.status = 400; throw err;
        }
        q.requestedBy = { $in: [new mongoose.Types.ObjectId(String(filter.requestedBy))] };
    }

    // if filtering by property_id, validate it exists
    if (q.property_id && !createdBy) {
        const propertyId = typeof q.property_id === 'object' && q.property_id.$in
            ? null
            : q.property_id;
        if (propertyId && !mongoose.Types.ObjectId.isValid(String(propertyId))) {
            const err = new Error('property_id must be a valid ObjectId'); err.status = 400; throw err;
        }
        if (propertyId) {
            const Property = require('../../../../portals/landlord/modules/property/model/property.model');
            const prop = await Property.findOne({ _id: propertyId, isDeleted: { $ne: true } }).lean();
            if (!prop) { const err = new Error('property not found'); err.status = 400; throw err; }
        }
    }

    // Get standardized pagination parameters
    const { getPagination } = require('../../../../common/helpers/paginationHelper');
    const { offset, limit: effectiveLimit, page, pageSize: effectivePageSize } = getPagination({
        page: pageNumber,
        pageSize
    });

    // Apply filters
    if (filter.status) {
        q.status = resolveMaintenanceListStatusFilter(filter.status, {
            vendorScoped: Boolean(filter.vendorId),
        });
    }
    if (filter.category) q.category = filter.category;
    if (filter.priority) q.priority = filter.priority;
    if (filter.isUrgent !== undefined) q.isUrgent = filter.isUrgent;
    if (filter.primaryRequestType) q.primaryRequestType = filter.primaryRequestType;
    if (filter.subRequestType) q.subRequestType = filter.subRequestType;

    // Apply date range filter - always on request_date, independent of sort field
    if (filter.startDate || filter.endDate) {
        const dateFilter = {};
        if (filter.startDate) dateFilter.$gte = DateUtil.startOfDayEST(filter.startDate) || DateUtil.toUTC(filter.startDate);
        if (filter.endDate) dateFilter.$lte = DateUtil.endOfDayEST(filter.endDate) || DateUtil.toUTC(filter.endDate);
        q.request_date = dateFilter;
    }

    const sortField = filter.sortBy || 'request_date';
    const sortDirection = filter.sortOrder === 'asc' ? 1 : -1;
    const sortSpec = { [sortField]: sortDirection };

    // Execute paginated query with property population
    const [requests, total] = await Promise.all([
        MaintenanceRequest.find(q)
            .sort(sortSpec)
            .populate('requestedBy', 'firstName lastName email')
            .populate('createdBy', 'firstName lastName email')
            .populate('assignedTo', 'firstName lastName email')
            .populate('property_id', 'name address unitDetails')
            .select('_id ticketNumber hoaId property_id unitId units title description category primaryRequestType subRequestType priority status isUrgent requestedBy createdBy createdByName createdByRole requestedForLabel requestedForType assignedTo request_date completedDate createdAt updatedAt')
            .skip(offset)
            .limit(effectiveLimit)
            .lean(),
        MaintenanceRequest.countDocuments(q)
    ]);

    // Enhance requests with property and unit information (property already populated)
    const enhancedRequests = requests.map((request) => {
        // Skip if property_id is null (property was deleted or not assigned)
        if (!request.property_id) {
            const du = unitDisplayNameFromMaintenance(null, request);
            return enrichMaintenanceAuditDisplay({
                ...request,
                propertyName: 'Not Applicable',
                propertyAddress: null,
                unitName: du || 'Not Applicable',
                units: du || 'Not Applicable',
                unitDetails: null,
                property_id: null,
            });
        }

        const property = request.property_id;
        const unitSub = unitSubdocumentForMaintenance(property, request);
        const unitDetails = unitSub
            ? {
                unitType: unitSub.unitType,
                squareFeet: unitSub.squareFeet,
                bedRooms: unitSub.bedRooms,
                bathRoom: unitSub.bathRoom,
            }
            : null;

        const displayUnit = unitDisplayNameFromMaintenance(property, request);

        return enrichMaintenanceAuditDisplay({
            ...request,
            propertyName: property.name,
            propertyAddress: property.address,
            unitName: displayUnit,
            units: displayUnit,
            unitDetails,
            property_id: property._id,
        });
    });

    return {
        data: enhancedRequests,
        total,
        page,
        pageSize: effectivePageSize
    };
}

function mergeMaintenanceUpdateOperators(updateObject, activityEntry) {
    if (!activityEntry) return updateObject;
    const next = { ...updateObject };
    next.$push = {
        ...(next.$push || {}),
        activityLog: activityEntry,
    };
    return next;
}

/**
 * True when an update explicitly removes the ticket's property; the unit is
 * cleared with it (unitId null, units ''). Mutates updates.
 */
function applyLocationClear(updates) {
    if (!updates || !Object.prototype.hasOwnProperty.call(updates, 'property_id')) return false;
    const value = updates.property_id;
    if (value !== null && value !== undefined && String(value).trim() !== '') return false;
    updates.property_id = null;
    updates.unitId = null;
    updates.units = '';
    return true;
}

async function updateMaintenanceRequestInSession(id, updates = {}, session, activityEntry = null) {
    if (!id) {
        const err = new Error('id is required');
        err.status = 400;
        throw err;
    }
    if (!mongoose.Types.ObjectId.isValid(String(id))) {
        const err = new Error('id must be a valid ObjectId');
        err.status = 400;
        throw err;
    }

    const existingRequest = await applySession(
        MaintenanceRequest.findOne({ _id: id, isDeleted: { $ne: true } }),
        session
    );
    if (!existingRequest) {
        const err = new Error('Maintenance request not found');
        err.status = 404;
        throw err;
    }

    if (updates && updates.property_id) {
        if (!mongoose.Types.ObjectId.isValid(String(updates.property_id))) {
            const err = new Error('property_id must be a valid ObjectId');
            err.status = 400;
            throw err;
        }
        const Property = require('../../../../portals/landlord/modules/property/model/property.model');
        const prop = await applySession(
            Property.findOne({ _id: updates.property_id, isDeleted: { $ne: true } }),
            session
        ).lean();
        if (!prop) {
            const err = new Error('property not found');
            err.status = 404;
            throw err;
        }
    }

    // Property cleared (edit form sends property_id null / unitId null / units ''):
    // drop the unit with it. Property is optional on create; empty location must stay editable.
    applyLocationClear(updates);

    if (updates) {
        const unitPlan = planMaintenanceUnitUpdate(updates, existingRequest.property_id);
        if (unitPlan.action === 'clear') {
            updates.unitId = null;
            delete updates.units;
        } else if (unitPlan.action === 'resolve') {
            if (unitPlan.error) {
                const err = new Error(unitPlan.error);
                err.status = 400;
                throw err;
            }
            const propertyId = updates.property_id || existingRequest.property_id;
            const resolved = await resolveUnitForPropertyId(
                propertyId,
                unitPlan.unitId ? { unitId: unitPlan.unitId } : { unitName: unitPlan.unitName },
                { session }
            );
            updates.unitId = resolved.unitId;
            delete updates.units;
        }
    }

    if (updates) {
        if (Object.prototype.hasOwnProperty.call(updates, 'title')) {
            if (!updates.title || String(updates.title).trim().length === 0) {
                const err = new Error('title is required');
                err.status = 400;
                throw err;
            }
            if (String(updates.title).length > 150) {
                const err = new Error('title must be at most 150 characters');
                err.status = 400;
                throw err;
            }
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'description')) {
            if (!updates.description || String(updates.description).trim().length === 0) {
                const err = new Error('description is required');
                err.status = 400;
                throw err;
            }
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'category')) {
            if (!ALLOWED_CATEGORIES.includes(String(updates.category))) {
                const err = new Error('category is invalid');
                err.status = 400;
                throw err;
            }
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'priority')) {
            if (!ALLOWED_PRIORITIES.includes(String(updates.priority))) {
                const err = new Error('priority is invalid');
                err.status = 400;
                throw err;
            }
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'status')) {
            const allowedStatuses = Object.values(MAINTENANCE_REQUEST_STATUS)
                .filter((s) => s !== MAINTENANCE_REQUEST_STATUS.REJECTED);
            if (!allowedStatuses.includes(String(updates.status))) {
                const err = new Error(
                    String(updates.status) === MAINTENANCE_REQUEST_STATUS.REJECTED
                        ? 'Rejected status has been removed from the maintenance flow'
                        : 'status is invalid'
                );
                err.status = 400;
                throw err;
            }
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'request_date')) {
            const d = DateUtil.toUTC(updates.request_date);
            if (!d) {
                const err = new Error('request_date must be a valid date');
                err.status = 400;
                throw err;
            }
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'completed_date')) {
            const d2 = DateUtil.toUTC(updates.completed_date);
            if (!d2) {
                const err = new Error('completed_date must be a valid date');
                err.status = 400;
                throw err;
            }
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'requestedBy')) {
            const rawRequestedBy = updates.requestedBy;
            if (
                rawRequestedBy == null
                || rawRequestedBy === ''
                || (Array.isArray(rawRequestedBy) && rawRequestedBy.length === 0)
            ) {
                updates.requestedBy = [];
            } else {
                const rbIds = normalizeRequestedByToObjectIds(rawRequestedBy);
                if (!rbIds) {
                    const err = new Error('requestedBy must contain valid user ids when provided');
                    err.status = 400;
                    throw err;
                }
                updates.requestedBy = rbIds;
                await assertRequestedByOwnersEligible(updates.requestedBy, session);
            }
        }
    }

    let updateObject = { $set: updates };
    let metadataIdsToDelete = [];

    if (updates.requestToDelete && Array.isArray(updates.requestToDelete) && updates.requestToDelete.length > 0) {
        metadataIdsToDelete = updates.requestToDelete
            .map((metaId) => {
                if (mongoose.Types.ObjectId.isValid(String(metaId))) {
                    return new mongoose.Types.ObjectId(metaId);
                }
                return metaId;
            })
            .filter(Boolean);
        delete updates.requestToDelete;
        updateObject.$pull = { documents: { metadataId: { $in: metadataIdsToDelete } } };
        updateObject.$set = updates;
    } else if (updates.deletedDocuments && Array.isArray(updates.deletedDocuments) && updates.deletedDocuments.length > 0) {
        metadataIdsToDelete = updates.deletedDocuments
            .map((doc) => {
                const metadataId = doc.metadataId
                    ? typeof doc.metadataId === 'object'
                        ? doc.metadataId._id
                        : doc.metadataId
                    : doc._id;
                if (metadataId && mongoose.Types.ObjectId.isValid(String(metadataId))) {
                    return new mongoose.Types.ObjectId(metadataId);
                }
                return metadataId;
            })
            .filter(Boolean);
        delete updates.deletedDocuments;
        updateObject.$pull = {
            documents: { $or: [{ metadataId: { $in: metadataIdsToDelete } }, { _id: { $in: metadataIdsToDelete } }] },
        };
        updateObject.$set = updates;
    }

    updateObject = mergeMaintenanceUpdateOperators(updateObject, activityEntry);

    const updated = await applySession(
        MaintenanceRequest.findOneAndUpdate({ _id: id, isDeleted: { $ne: true } }, updateObject, { new: true }),
        session
    );

    if (!updated) {
        const err = new Error('Maintenance request not found');
        err.status = 404;
        throw err;
    }

    if (metadataIdsToDelete.length > 0) {
        const DocumentMetadata = require('../../../../shared/modules/documents/model/documentMetadata.model');
        await applySession(DocumentMetadata.deleteMany({ _id: { $in: metadataIdsToDelete } }), session);
    }

    return updated;
}

function maintenanceIdString(id) {
    if (!id) return '';
    return id.toString ? id.toString() : String(id);
}

function isVendorActor(options = {}) {
    const ctx = options.userContext || {};
    const roleName = ctx.roleName || ctx.role || '';
    return Boolean(ctx.isVendor) || isVendorRole(roleName);
}

/**
 * Normalize list status filters.
 * "Open" means active work (Open + InProgress, including vendor-assigned tickets).
 * "Resolved" / "Completed" includes Resolved and Completed closed tickets.
 * Applies for HOA board/owner/vendor so dashboard deep links match dashboard counts.
 */
function resolveMaintenanceListStatusFilter(status, { vendorScoped = false } = {}) {
    if (status == null || status === '') return status;

    if (Array.isArray(status)) {
        const values = status.map((s) => String(s).trim()).filter(Boolean);
        if (values.length === 0) return undefined;
        if (values.length === 1) {
            return resolveMaintenanceListStatusFilter(values[0], { vendorScoped });
        }
        return { $in: values };
    }

    const raw = String(status).trim();
    if (raw.includes(',')) {
        const values = raw.split(',').map((s) => s.trim()).filter(Boolean);
        return resolveMaintenanceListStatusFilter(values, { vendorScoped });
    }

    const key = raw.toLowerCase().replace(/[\s_]+/g, '');
    if (key === 'open') {
        return {
            $in: [
                MAINTENANCE_REQUEST_STATUS.OPEN,
                MAINTENANCE_REQUEST_STATUS.IN_PROGRESS,
            ],
        };
    }
    if (key === 'resolved' || key === 'completed') {
        return {
            $in: [
                MAINTENANCE_REQUEST_STATUS.RESOLVED,
                MAINTENANCE_REQUEST_STATUS.COMPLETED,
                'Completed',
            ],
        };
    }
    return raw;
}

/**
 * Vendors may only act on tickets assigned to them (view / note / mark Completed).
 */
async function assertVendorAssignedToMaintenance(id, options = {}) {
    if (!isVendorActor(options)) return;

    const actorId = maintenanceIdString(options.userId);
    if (!actorId) {
        const err = new Error('Access denied');
        err.status = 403;
        throw err;
    }

    const existing = await MaintenanceRequest.findOne({ _id: id, isDeleted: { $ne: true } })
        .select('assignedTo')
        .lean();
    if (!existing) {
        const err = new Error('Maintenance request not found');
        err.status = 404;
        throw err;
    }

    const assignedTo = maintenanceIdString(existing.assignedTo);
    if (!assignedTo || assignedTo !== actorId) {
        const err = new Error('Access denied');
        err.status = 403;
        throw err;
    }
}

/**
 * Block vendor document deletion / non-upload mutations.
 * Uploads for assigned vendors are allowed via upload_document (see uploadDocuments).
 */
function assertVendorCannotDeleteTicketDocuments(options = {}) {
    if (!isVendorActor(options)) return;
    const err = new Error('Vendors cannot delete or modify maintenance attachments');
    err.status = 403;
    throw err;
}

function assertVendorCanUploadTicketDocuments(options = {}) {
    if (!isVendorActor(options)) return;
    if (!isVendorMaintenanceActionAllowed('upload_document')) {
        const err = new Error('Vendors cannot upload or modify maintenance attachments');
        err.status = 403;
        throw err;
    }
}

function assertVendorCannotCreateOrDeleteTickets(options = {}) {
    if (!isVendorActor(options)) return;
    const err = new Error('Vendors cannot create or delete maintenance requests');
    err.status = 403;
    throw err;
}

async function assertVendorMaintenanceUpdateAccess(id, updates = {}, options = {}) {
    if (!isVendorActor(options)) return;

    await assertVendorAssignedToMaintenance(id, options);

    // Vendors may only set status to Completed via PUT. Notes use POST /notes.
    // Resolve route also maps vendor completion to Completed.
    const allowedKeys = new Set(['status']);
    const disallowed = Object.keys(updates || {}).filter(
        (key) => updates[key] !== undefined && !allowedKeys.has(key)
    );
    if (disallowed.length) {
        const err = new Error('Vendors may only mark tickets as Completed and add notes');
        err.status = 403;
        throw err;
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'status') && updates.status !== undefined) {
        if (!isVendorAllowedMaintenanceStatus(updates.status)) {
            const err = new Error('Vendors may only change ticket status to Completed');
            err.status = 403;
            throw err;
        }
    }
}

async function assertVendorAssignedToTicket(id, options = {}) {
    await assertVendorAssignedToMaintenance(id, {
        ...options,
        userId: options.userId || options.uploadedBy,
    });
}

async function buildMaintenanceUpdateActivityEntry(previous, updates = {}, userId, session) {
    if (!userId) return null;

    const formatStatusLabel = (status) => {
        const key = String(status || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
        switch (key) {
            case 'open': return 'Open';
            case 'inprogress': return 'In Progress';
            case 'resolved': return 'Resolved';
            case 'rejected': return 'Rejected';
            case 'reopened': return 'Reopened';
            case 'completed': return 'Completed';
            case 'closed': return 'Closed';
            default: {
                const raw = String(status || '').trim();
                return raw ? raw.replace(/([a-z])([A-Z])/g, '$1 $2') : 'None';
            }
        }
    };

    const actor = await resolveMaintenanceActivityActor(userId, { session });
    const nextStatus = Object.prototype.hasOwnProperty.call(updates, 'status')
        ? updates.status
        : null;

    if (nextStatus && isMaintenanceReopenUpdate(previous?.status, nextStatus)) {
        return buildMaintenanceActivityEntry({
            type: 'status',
            description: `Ticket reopened by ${actor.performedByName}.`,
            performedBy: actor.performedBy,
            performedByName: actor.performedByName,
            createdAt: ClockService.now(),
            meta: { action: 'reopened' },
        });
    }

    const assignedChanged = Object.prototype.hasOwnProperty.call(updates, 'assignedTo')
        && maintenanceIdString(previous?.assignedTo) !== maintenanceIdString(updates.assignedTo);
    if (assignedChanged && updates.assignedTo) {
        const wasReassign = Boolean(previous?.assignedTo);
        const statusAlsoChanged = nextStatus
            && String(previous?.status || '').toLowerCase() !== String(nextStatus || '').toLowerCase();
        let description = wasReassign
            ? `Vendor changed by ${actor.performedByName}.`
            : `Vendor assigned by ${actor.performedByName}.`;
        if (statusAlsoChanged) {
            description = `${description.slice(0, -1)}: status from "${formatStatusLabel(previous?.status)}" to "${formatStatusLabel(nextStatus)}".`;
        }
        return buildMaintenanceActivityEntry({
            type: 'assigned',
            description,
            performedBy: actor.performedBy,
            performedByName: actor.performedByName,
            createdAt: ClockService.now(),
            meta: {
                action: wasReassign ? 'reassigned' : 'assigned',
                assignedTo: maintenanceIdString(updates.assignedTo),
                previousAssignedTo: maintenanceIdString(previous?.assignedTo) || null,
                previousStatus: previous?.status || null,
                status: nextStatus || null,
            },
        });
    }

    const changeParts = [];
    if (
        Object.prototype.hasOwnProperty.call(updates, 'priority')
        && String(previous?.priority || '') !== String(updates.priority || '')
    ) {
        const from = previous?.priority || 'None';
        const to = updates.priority || 'None';
        changeParts.push(`priority from "${from}" to "${to}"`);
    }
    if (
        nextStatus
        && String(previous?.status || '').toLowerCase() !== String(nextStatus || '').toLowerCase()
    ) {
        const from = formatStatusLabel(previous?.status);
        const to = formatStatusLabel(nextStatus);
        changeParts.push(`status from "${from}" to "${to}"`);
    }

    if (changeParts.length > 0) {
        return buildMaintenanceActivityEntry({
            type: nextStatus ? 'status' : 'edited',
            description: `Maintenance ticket updated by ${actor.performedByName}: ${changeParts.join('; ')}.`,
            performedBy: actor.performedBy,
            performedByName: actor.performedByName,
            createdAt: ClockService.now(),
            meta: {
                action: 'edited',
                changes: changeParts,
                previousPriority: previous?.priority || null,
                priority: updates.priority || null,
                previousStatus: previous?.status || null,
                status: nextStatus || null,
            },
        });
    }

    if (updatesIncludeMaintenanceEditFields(updates)) {
        return buildMaintenanceActivityEntry({
            type: 'edited',
            description: `Maintenance ticket updated by ${actor.performedByName}.`,
            performedBy: actor.performedBy,
            performedByName: actor.performedByName,
            createdAt: ClockService.now(),
            meta: { action: 'edited' },
        });
    }

    return null;
}

async function updateMaintenanceRequest(id, updates = {}, options = {}) {
    await assertVendorMaintenanceUpdateAccess(id, updates, options);
    const previous = await MaintenanceRequest.findById(id).select('status assignedTo hoaId priority').lean();
    const saved = await withMaintenanceTransaction(
        async (session) => {
            const activityEntry = await buildMaintenanceUpdateActivityEntry(
                previous,
                updates,
                options.userId,
                session
            );
            return updateMaintenanceRequestInSession(id, updates, session, activityEntry);
        },
        options
    );
    const formatted = await formatMaintenanceRequestResponse(saved);
    if (!options.session && options.notify !== false) {
        dispatchMaintenanceVendorOrUpdateNotifications(formatted, previous, updates, options.userId);
    }
    if (!options.session) {
        await logMaintenanceDashboardActivity({
            userId: options.userId,
            action: 'UPDATE',
            request: saved,
            hoaId: previous?.hoaId || options.userContext?.hoaId || options.hoaContext?.hoaId,
        });
    }
    return formatted;
}

async function updateMaintenanceRequestWithDocuments(id, updates = {}, options = {}) {
    await assertVendorMaintenanceUpdateAccess(id, updates, options);
    const files = (options.files || []).filter((f) => f && (f.size || 0) > 0 && f.path);
    if (files.length) {
        // Vendors may attach files on assigned tickets; ticket field edits remain status-only.
        assertVendorCanUploadTicketDocuments(options);
    }
    if (updates.requestToDelete?.length || updates.deletedDocuments?.length) {
        assertVendorCannotDeleteTicketDocuments(options);
    }
    const uploadedBy = options.uploadedBy || options.userId;
    const previous = await MaintenanceRequest.findById(id).select('status assignedTo hoaId priority').lean();

    const saved = await withMaintenanceTransaction(async (session) => {
        const activityEntry = await buildMaintenanceUpdateActivityEntry(
            previous,
            updates,
            options.userId,
            session
        );
        // Treat new file uploads as an edit when no other activity was inferred.
        let entry = activityEntry;
        if (!entry && files.length && options.userId) {
            const actor = await resolveMaintenanceActivityActor(options.userId, { session });
            entry = buildMaintenanceActivityEntry({
                type: 'edited',
                description: `Maintenance ticket updated by ${actor.performedByName}.`,
                performedBy: actor.performedBy,
                performedByName: actor.performedByName,
                createdAt: ClockService.now(),
                meta: { action: 'edited', documentsUploaded: true },
            });
        }
        let doc = await updateMaintenanceRequestInSession(id, updates, session, entry);
        if (files.length) {
            const { request } = await uploadDocumentsInSession(String(id), files, { session, uploadedBy });
            doc = request;
        }
        return doc;
    }, options);

    const formatted = await formatMaintenanceRequestResponse(saved);
    if (!options.session && options.notify !== false) {
        const hasFieldUpdates = updates && Object.keys(updates).length > 0;
        if (hasFieldUpdates) {
            dispatchMaintenanceVendorOrUpdateNotifications(formatted, previous, updates, options.userId);
        }
        if (files.length) {
            notifyMaintenanceDocumentsUpdated(formatted, options.userId || uploadedBy);
        }
    }
    if (!options.session) {
        await logMaintenanceDashboardActivity({
            userId: options.userId,
            action: 'UPDATE',
            request: saved,
            hoaId: previous?.hoaId || options.userContext?.hoaId || options.hoaContext?.hoaId,
        });
    }
    return formatted;
}

async function deleteMaintenanceRequestInSession(id, session) {
    if (!id) {
        const err = new Error('id is required');
        err.status = 400;
        throw err;
    }
    if (!mongoose.Types.ObjectId.isValid(String(id))) {
        const err = new Error('id must be a valid ObjectId');
        err.status = 400;
        throw err;
    }

    const deleted = await applySession(
        MaintenanceRequest.findOneAndUpdate(
            { _id: id, isDeleted: { $ne: true } },
            { $set: { isDeleted: true } },
            { new: true }
        ),
        session
    );

    if (!deleted) {
        const err = new Error('Maintenance request not found');
        err.status = 404;
        throw err;
    }
    return deleted;
}

async function deleteMaintenanceRequest(id, options = {}) {
    assertVendorCannotCreateOrDeleteTickets(options);
    return withMaintenanceTransaction((session) => deleteMaintenanceRequestInSession(id, session), options);
}

async function uploadDocumentsInSession(maintenanceId, files, { session, uploadedBy } = {}) {
    if (!maintenanceId) {
        const err = new Error('maintenance request ID is required');
        err.status = 400;
        throw err;
    }
    if (!files || !Array.isArray(files) || files.length === 0) {
        const err = new Error('at least one file is required');
        err.status = 400;
        throw err;
    }

    const userId = uploadedBy || null;
    const documents = [];

    const request = await applySession(
        MaintenanceRequest.findOne({ _id: maintenanceId, isDeleted: { $ne: true } }),
        session
    );
    if (!request) {
        const err = new Error('maintenance request not found');
        err.status = 404;
        throw err;
    }

    const DocumentMetadata = require('../../../../shared/modules/documents/model/documentMetadata.model');
    const cfg = require('../../../../config/default');
    const bucketName = cfg.s3?.bucket || process.env.S3_BUCKET || 'mock-bucket';
    const region = cfg.s3?.region || process.env.AWS_REGION || 'mock-region';

    for (const file of files) {
        const filename = file.filename || file.originalname;
        const key = s3Client.getKey
            ? s3Client.getKey('maintenance', filename, userId)
            : `${UPLOAD_MAINTENANCE_SUBDIR || 'maintenance-attachments'}/${maintenanceId}/${filename}`;

        const s3Result = await s3Client.upload({
            localFilePath: file.path,
            key,
            contentType: file.mimetype || 'application/octet-stream',
        });

        const metadataDoc = await DocumentMetadata.create(
            [
                {
                    key: s3Result && s3Result.Key ? s3Result.Key : key,
                    s3Location: s3Result && s3Result.Location ? s3Result.Location : undefined,
                    bucketName,
                    region,
                    size: file.size || 0,
                    contentType: file.mimetype || 'application/octet-stream',
                    originalName: file.originalname || filename,
                },
            ],
            { session }
        );

        documents.push({
            metadataId: metadataDoc[0]._id,
            originalName: file.originalname,
            uploadedAt: ClockService.now(),
            uploadedBy,
        });
    }

    request.documents = request.documents || [];
    request.documents.push(...documents);
    await request.save({ session });
    return {
        request,
        newMetadataIds: documents.map((d) => d.metadataId).filter(Boolean),
    };
}

async function cleanupUploadedMaintenanceMetadata(metadataIds) {
    const DocumentMetadata = require('../../../../shared/modules/documents/model/documentMetadata.model');
    for (const metadataId of metadataIds || []) {
        if (!metadataId) continue;
        try {
            const meta = await DocumentMetadata.findById(metadataId).lean();
            if (meta?.key) await s3Client.delete({ key: meta.key });
            await DocumentMetadata.deleteOne({ _id: metadataId });
        } catch (cleanupError) {
            logger.error('Failed to cleanup uploaded maintenance file:', cleanupError);
        }
    }
}

/**
 * Upload documents to a maintenance request (transactional).
 * Assigned vendors may upload (notes/comments attachments); delete remains blocked elsewhere.
 */
async function uploadDocuments(maintenanceId, files, options = {}) {
    assertVendorCanUploadTicketDocuments(options);
    if (!maintenanceId) {
        const err = new Error('maintenance request ID is required');
        err.status = 400;
        throw err;
    }
    if (!files || !Array.isArray(files) || files.length === 0) {
        const err = new Error('at least one file is required');
        err.status = 400;
        throw err;
    }

    await assertVendorAssignedToTicket(maintenanceId, options);

    const uploadedBy = options.uploadedBy || options.userId || null;
    let stagedMetadataIds = [];

    try {
        await withMaintenanceTransaction(async (session) => {
            const result = await uploadDocumentsInSession(maintenanceId, files, { session, uploadedBy });
            stagedMetadataIds = result.newMetadataIds || [];
        }, options);
    } catch (error) {
        await cleanupUploadedMaintenanceMetadata(stagedMetadataIds);
        throw error;
    }

    const updatedRequest = await MaintenanceRequest.findOne({ _id: maintenanceId, isDeleted: { $ne: true } })
        .populate('requestedBy', 'firstName lastName email')
        .populate('assignedTo', 'firstName lastName email')
        .populate('documents.uploadedBy', 'firstName lastName email');

    if (!options.session && options.notify !== false) {
        notifyMaintenanceDocumentsUpdated(updatedRequest, options.userId || uploadedBy);
    }

    return updatedRequest;
}

/**
 * Get all documents for a maintenance request with presigned URLs
 */
async function getMaintenanceDocuments(maintenanceId) {
    if (!maintenanceId) {
        const err = new Error('maintenance request ID is required');
        err.status = 400;
        throw err;
    }
    if (!mongoose.Types.ObjectId.isValid(String(maintenanceId))) {
        const err = new Error('maintenance request ID must be a valid ObjectId');
        err.status = 400;
        throw err;
    }

    const request = await MaintenanceRequest.findOne({ _id: maintenanceId, isDeleted: { $ne: true } })
        .populate('documents.metadataId')
        .populate('documents.uploadedBy', 'firstName lastName email')
        .lean();

    if (!request) {
        const err = new Error('Maintenance request not found');
        err.status = 404;
        throw err;
    }

    const documentsService = require('../../../../shared/modules/documents/service/documents.service');

    const docs = await Promise.all((request.documents || []).map(async doc => {
        const meta = doc.metadataId || {};
        let url = null;
        if (meta._id) {
            try {
                url = await documentsService.getPresignedUrl(meta._id.toString(), 3600);
            } catch (e) {
                url = documentsService.buildPublicUrl(meta);
            }
        }
        return Object.assign({}, doc, { metadata: meta, url });
    }));

    return docs;
}

/**
 * Get a specific document file for download
 */
async function getDocumentFile(maintenanceId, metadataId) {
    if (!maintenanceId || !metadataId) {
        const err = new Error('maintenance request ID and metadata ID are required');
        err.status = 400;
        throw err;
    }

    // Validate IDs
    if (!mongoose.Types.ObjectId.isValid(String(maintenanceId))) {
        const err = new Error('maintenance request ID must be a valid ObjectId');
        err.status = 400;
        throw err;
    }
    if (!mongoose.Types.ObjectId.isValid(String(metadataId))) {
        const err = new Error('metadata ID must be a valid ObjectId');
        err.status = 400;
        throw err;
    }

    // Get maintenance request and verify document exists
    const request = await MaintenanceRequest.findOne({ _id: maintenanceId, isDeleted: { $ne: true } }).lean();
    if (!request) {
        const err = new Error('Maintenance request not found');
        err.status = 404;
        throw err;
    }

    // Verify document belongs to this maintenance request
    const docExists = request.documents.some(doc => doc.metadataId.toString() === metadataId);
    if (!docExists) {
        const err = new Error('Document not found in this maintenance request');
        err.status = 404;
        throw err;
    }

    // Get document metadata
    const DocumentMetadata = require('../../../../shared/modules/documents/model/documentMetadata.model');
    const metadata = await DocumentMetadata.findById(metadataId).lean();
    if (!metadata) {
        const err = new Error('Document metadata not found');
        err.status = 404;
        throw err;
    }

    // Get file from S3
    const fileStream = await s3Client.getStream({ key: metadata.key });

    return {
        fileStream,
        fileName: metadata.originalName,
        contentType: metadata.contentType
    };
}

/**
 * The comment's attachment ids that are documents of this ticket, de-duplicated.
 * Anything else is dropped: a comment can only point at files already uploaded
 * to the same request, never at another ticket's or the HOA library's.
 */
function linkableCommentAttachments(request, attachmentIds) {
    if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) return [];
    const ticketDocIds = new Set(
        (request.documents || [])
            .map((doc) => (doc && doc.metadataId ? String(doc.metadataId) : ''))
            .filter(Boolean)
    );
    const seen = new Set();
    const linked = [];
    for (const raw of attachmentIds) {
        const id = String(raw || '');
        if (!mongoose.Types.ObjectId.isValid(id) || !ticketDocIds.has(id) || seen.has(id)) continue;
        seen.add(id);
        linked.push(new mongoose.Types.ObjectId(id));
    }
    return linked;
}

async function addCommentInSession(maintenanceId, commentData, session, accessOptions = {}) {
    if (!maintenanceId) {
        const err = new Error('maintenance request ID is required');
        err.status = 400;
        throw err;
    }
    if (!mongoose.Types.ObjectId.isValid(String(maintenanceId))) {
        const err = new Error('maintenance request ID must be a valid ObjectId');
        err.status = 400;
        throw err;
    }
    if (!commentData || !commentData.text || !commentData.text.trim()) {
        const err = new Error('comment text is required');
        err.status = 400;
        throw err;
    }
    if (!commentData.author) {
        const err = new Error('comment author is required');
        err.status = 400;
        throw err;
    }
    if (!mongoose.Types.ObjectId.isValid(String(commentData.author))) {
        const err = new Error('comment author must be a valid ObjectId');
        err.status = 400;
        throw err;
    }

    const User = require('../../../../shared/modules/users/models/user.model');
    const userExists = await applySession(
        User.findOne({ _id: commentData.author, isDeleted: { $ne: true } }),
        session
    ).lean();
    if (!userExists) {
        const err = new Error('User not found');
        err.status = 404;
        throw err;
    }

    const request = await applySession(
        MaintenanceRequest.findOne({ _id: maintenanceId, isDeleted: { $ne: true } }),
        session
    );
    if (!request) {
        const err = new Error('Maintenance request not found');
        err.status = 404;
        throw err;
    }

    const { assertUserCanParticipateInMaintenanceComments } = require('../helpers/maintenanceCommentAccess');
    await assertUserCanParticipateInMaintenanceComments(
        request,
        commentData.author,
        accessOptions.userContext || null
    );

    request.comments = request.comments || [];
    request.comments.push({
        author: commentData.author,
        text: commentData.text.trim(),
        attachments: linkableCommentAttachments(request, commentData.attachments),
        createdAt: ClockService.now(),
    });

    await request.save({ session, validateModifiedOnly: true });
    return request;
}

async function populateMaintenanceRequestLean(maintenanceId) {
    return MaintenanceRequest.findOne({ _id: maintenanceId, isDeleted: { $ne: true } })
        .populate('requestedBy', 'firstName lastName email')
        .populate('assignedTo', 'firstName lastName email')
        .populate('comments.author', 'firstName lastName email')
        .populate('notes.author', 'firstName lastName email')
        .lean();
}

/**
 * Add a comment to a maintenance request
 */
async function addComment(maintenanceId, commentData, options = {}) {
    if (isVendorActor(options) && !isVendorMaintenanceActionAllowed('add_comment')) {
        throw vendorMaintenanceDeniedError();
    }
    await assertVendorAssignedToMaintenance(maintenanceId, {
        ...options,
        userId: options.userId || commentData?.author,
    });
    await withMaintenanceTransaction(
        (session) => addCommentInSession(maintenanceId, commentData, session, options),
        options
    );

    const updated = await populateMaintenanceRequestLean(maintenanceId);

    if (!options.session && options.notify !== false) {
        notifyMaintenanceCommentAdded(updated, options.userId || commentData.author);
    }

    return updated;
}

/**
 * Get all comments for a maintenance request
 */
async function getComments(maintenanceId, options = {}) {
    if (!maintenanceId) {
        const err = new Error('maintenance request ID is required');
        err.status = 400;
        throw err;
    }
    if (!mongoose.Types.ObjectId.isValid(String(maintenanceId))) {
        const err = new Error('maintenance request ID must be a valid ObjectId');
        err.status = 400;
        throw err;
    }

    const request = await MaintenanceRequest.findOne({ _id: maintenanceId, isDeleted: { $ne: true } })
        .populate('comments.author', 'firstName lastName email')
        .lean();

    if (!request) {
        const err = new Error('Maintenance request not found');
        err.status = 404;
        throw err;
    }

    if (options.userId) {
        const { assertUserCanParticipateInMaintenanceComments } = require('../helpers/maintenanceCommentAccess');
        await assertUserCanParticipateInMaintenanceComments(
            request,
            options.userId,
            options.userContext || null
        );
    }

    return request.comments || [];
}

async function addNoteInSession(maintenanceId, noteData, session) {
    if (!maintenanceId) {
        const err = new Error('maintenance request ID is required');
        err.status = 400;
        throw err;
    }
    if (!mongoose.Types.ObjectId.isValid(String(maintenanceId))) {
        const err = new Error('maintenance request ID must be a valid ObjectId');
        err.status = 400;
        throw err;
    }
    if (!noteData || !noteData.content || !noteData.content.trim()) {
        const err = new Error('note content is required');
        err.status = 400;
        throw err;
    }
    if (!noteData.author) {
        const err = new Error('note author is required');
        err.status = 400;
        throw err;
    }
    if (!mongoose.Types.ObjectId.isValid(String(noteData.author))) {
        const err = new Error('note author must be a valid ObjectId');
        err.status = 400;
        throw err;
    }

    const User = require('../../../../shared/modules/users/models/user.model');
    const userExists = await applySession(
        User.findOne({ _id: noteData.author, isDeleted: { $ne: true } }),
        session
    ).lean();
    if (!userExists) {
        const err = new Error('User not found');
        err.status = 404;
        throw err;
    }

    const request = await applySession(
        MaintenanceRequest.findOne({ _id: maintenanceId, isDeleted: { $ne: true } }),
        session
    );
    if (!request) {
        const err = new Error('Maintenance request not found');
        err.status = 404;
        throw err;
    }

    const noteCreatedAt = ClockService.now();
    const noteId = new mongoose.Types.ObjectId();
    request.notes = request.notes || [];
    request.notes.push({
        _id: noteId,
        author: noteData.author,
        content: noteData.content.trim(),
        createdAt: noteCreatedAt,
        updatedAt: noteCreatedAt,
    });

    const actor = await resolveMaintenanceActivityActor(noteData.author, { session });
    const content = noteData.content.trim();
    const preview = content.length > 120 ? `${content.slice(0, 117)}...` : content;
    request.activityLog = request.activityLog || [];
    request.activityLog.push(buildMaintenanceActivityEntry({
        type: 'note',
        description: preview
            ? `Note added by ${actor.performedByName}: "${preview}"`
            : `Note added by ${actor.performedByName}.`,
        performedBy: actor.performedBy,
        performedByName: actor.performedByName,
        createdAt: noteCreatedAt,
        meta: {
            action: 'note_added',
            noteId: String(noteId),
        },
    }));

    await request.save({ session, validateModifiedOnly: true });
    return request;
}

/**
 * Add a note to a maintenance request
 */
async function addNote(maintenanceId, noteData, options = {}) {
    if (isVendorActor(options) && !isVendorMaintenanceActionAllowed('add_note')) {
        throw vendorMaintenanceDeniedError();
    }
    await assertVendorAssignedToMaintenance(maintenanceId, {
        ...options,
        userId: options.userId || noteData?.author,
    });
    await withMaintenanceTransaction((session) => addNoteInSession(maintenanceId, noteData, session), options);

    const updated = await populateMaintenanceRequestLean(maintenanceId);

    if (!options.session && options.notify !== false) {
        notifyMaintenanceNoteAdded(updated, options.userId || noteData.author);
    }

    return applyPrivateMaintenanceNotesForViewer(
        updated,
        options.userId || noteData?.author,
        options.userContext
    );
}

async function updateMaintenanceNote(maintenanceId, noteId, noteData, options = {}) {
    if (!maintenanceId) {
        const err = new Error('maintenance request ID is required');
        err.status = 400;
        throw err;
    }
    if (!noteId) {
        const err = new Error('noteId is required');
        err.status = 400;
        throw err;
    }
    if (!noteData || !noteData.content || !String(noteData.content).trim()) {
        const err = new Error('note content is required');
        err.status = 400;
        throw err;
    }
    if (isVendorActor(options) && !isVendorMaintenanceActionAllowed('update_note')) {
        throw vendorMaintenanceDeniedError();
    }
    await assertVendorAssignedToMaintenance(maintenanceId, options);

    const request = await MaintenanceRequest.findOne({ _id: maintenanceId, isDeleted: { $ne: true } });
    if (!request) {
        const err = new Error('Maintenance request not found');
        err.status = 404;
        throw err;
    }

    const note = request.notes.id(noteId) || findMaintenanceNoteById(request, noteId);
    assertMaintenanceNoteOwner(note, options.userId);

    note.content = String(noteData.content).trim();
    note.updatedAt = ClockService.now();
    await request.save({ validateModifiedOnly: true });

    const updated = await populateMaintenanceRequestLean(maintenanceId);
    return applyPrivateMaintenanceNotesForViewer(updated, options.userId, options.userContext);
}

async function deleteMaintenanceNote(maintenanceId, noteId, options = {}) {
    if (!maintenanceId) {
        const err = new Error('maintenance request ID is required');
        err.status = 400;
        throw err;
    }
    if (!noteId) {
        const err = new Error('noteId is required');
        err.status = 400;
        throw err;
    }
    if (isVendorActor(options) && !isVendorMaintenanceActionAllowed('delete_note')) {
        throw vendorMaintenanceDeniedError();
    }
    await assertVendorAssignedToMaintenance(maintenanceId, options);

    const request = await MaintenanceRequest.findOne({ _id: maintenanceId, isDeleted: { $ne: true } });
    if (!request) {
        const err = new Error('Maintenance request not found');
        err.status = 404;
        throw err;
    }

    const note = request.notes.id(noteId) || findMaintenanceNoteById(request, noteId);
    assertMaintenanceNoteOwner(note, options.userId);

    const noteIdStr = String(note._id || note.id || noteId);
    request.notes = (request.notes || []).filter(
        (entry) => String(entry._id || entry.id) !== noteIdStr
    );
    if (Array.isArray(request.activityLog)) {
        request.activityLog = request.activityLog.filter(
            (entry) => String(entry?.meta?.noteId || '') !== noteIdStr
        );
    }

    await request.save({ validateModifiedOnly: true });

    const updated = await populateMaintenanceRequestLean(maintenanceId);
    return applyPrivateMaintenanceNotesForViewer(updated, options.userId, options.userContext);
}

async function resolveMaintenanceRequest(id, { comment, userId } = {}, options = {}) {
    const trimmedComment = comment != null ? String(comment).trim() : '';
    if (!trimmedComment) {
        const err = new Error('Comment is required to resolve this maintenance ticket');
        err.status = 400;
        throw err;
    }
    if (!userId) {
        const err = new Error('User authentication failed');
        err.status = 401;
        throw err;
    }

    await assertVendorAssignedToMaintenance(id, { ...options, userId: options.userId || userId });
    const saved = await withMaintenanceTransaction(async (session) => {
        const request = await applySession(
            MaintenanceRequest.findOne({ _id: id, isDeleted: { $ne: true } }),
            session
        );
        if (!request) {
            const err = new Error('Maintenance request not found');
            err.status = 404;
            throw err;
        }

        const { assertUserCanParticipateInMaintenanceComments } = require('../helpers/maintenanceCommentAccess');
        await assertUserCanParticipateInMaintenanceComments(
            request,
            userId,
            options.userContext || null
        );

        const actor = await resolveMaintenanceActivityActor(userId, { session });
        const vendorCompleting = isVendorActor({ ...options, userId });
        const nextStatus = vendorCompleting
            ? MAINTENANCE_REQUEST_STATUS.COMPLETED
            : MAINTENANCE_REQUEST_STATUS.RESOLVED;
        const statusVerb = vendorCompleting ? 'completed' : 'resolved';
        await addCommentInSession(
            id,
            {
                author: userId,
                text: `Action: Marked as ${statusVerb}. Comment: ${trimmedComment}`,
            },
            session,
            { userContext: options.userContext || null }
        );

        const activityEntry = buildMaintenanceActivityEntry({
            type: 'status',
            description: `Marked as ${statusVerb} by ${actor.performedByName}. Comment: ${trimmedComment}`,
            performedBy: actor.performedBy,
            performedByName: actor.performedByName,
            createdAt: ClockService.now(),
            meta: { action: statusVerb },
        });

        return updateMaintenanceRequestInSession(
            id,
            { status: nextStatus, completedDate: ClockService.now() },
            session,
            activityEntry
        );
    }, options);

    const formatted = await formatMaintenanceRequestResponse(saved);

    if (!options.session) {
        notifyMaintenanceResolved(formatted, userId);
    }

    return formatted;
}

async function rejectMaintenanceRequest() {
    const err = new Error('Rejected status has been removed from the maintenance flow');
    err.status = 410;
    throw err;
}

/**
 * build List Filter From Query
 *
 * Performs logic operations for buildListFilterFromQuery.
 *
 * @param query - Request/input argument
 * @param actorId - Request/input argument
 * @returns Operations result
 */
function buildListFilterFromQuery(query = {}, actorId) {
    const filter = {};
    const hasHoaListScope = Boolean(query.hoaBoardMemberId || query.hoaOwnerId || query.vendorId);
    const createdBy = hasHoaListScope
        ? resolveCreatedBy(query)
        : resolveCreatedBy(query, actorId);
    if (createdBy) filter.createdBy = createdBy;
    if (query.property_id) filter.property_id = query.property_id;
    if (query.status) filter.status = query.status;
    if (query.category) filter.category = query.category;
    if (query.priority) filter.priority = query.priority;
    if (query.isUrgent !== undefined) filter.isUrgent = query.isUrgent === true || query.isUrgent === 'true';
    if (query.searchText) filter.searchText = query.searchText;
    if (query.hoaBoardMemberId) filter.hoaBoardMemberId = query.hoaBoardMemberId;
    if (query.hoaOwnerId) filter.hoaOwnerId = query.hoaOwnerId;
    if (query.vendorId) filter.vendorId = query.vendorId;
    if (query.requestedBy) filter.requestedBy = query.requestedBy;
    if (query.startDate) filter.startDate = query.startDate;
    if (query.endDate) filter.endDate = query.endDate;
    if (query.sortBy) filter.sortBy = query.sortBy;
    if (query.sortOrder) filter.sortOrder = query.sortOrder;
    if (query.primaryRequestType) filter.primaryRequestType = query.primaryRequestType;
    if (query.subRequestType) filter.subRequestType = query.subRequestType;
    return filter;
}

/**
 * normalize List Pagination
 *
 * Performs logic operations for normalizeListPagination.
 *
 * @param query - Request/input argument
 * @returns Operations result
 */
function normalizeListPagination(query = {}) {
    const rawPageNumber = typeof query.pageNumber !== 'undefined' ? query.pageNumber : query.page;
    const rawPageSize = query.pageSize;
    const pageNumberParsed = rawPageNumber !== undefined && rawPageNumber !== null && rawPageNumber !== ''
        ? parseInt(rawPageNumber, 10)
        : undefined;
    // Allow pageSize 0 (= export/list all rows). Do not treat 0 as "missing".
    const pageSizeParsed = rawPageSize !== undefined && rawPageSize !== null && rawPageSize !== ''
        ? parseInt(rawPageSize, 10)
        : undefined;
    return {
        pageNumber: Number.isFinite(pageNumberParsed) ? pageNumberParsed : undefined,
        pageSize: Number.isFinite(pageSizeParsed) ? pageSizeParsed : undefined,
    };
}

function getMaintenanceDocHoaId(doc) {
    const hoaId = doc?.hoaId
        || (doc?.property_id && typeof doc.property_id === 'object' && doc.property_id.hoaId);
    return hoaId ? String(hoaId) : null;
}

function buildMaintenanceActionUpdateMetadata(doc, extra = {}) {
    return {
        title: doc?.title,
        ticketNumber: resolveMaintenanceTicketNumber(doc),
        hoaId: getMaintenanceDocHoaId(doc),
        ...extra,
    };
}

async function enrichMaintenanceNotificationTargetWithHoaBoard(doc, target) {
    const hoaId = doc?.hoaId
        || (doc?.property_id && typeof doc.property_id === 'object' && doc.property_id.hoaId);
    let resolvedHoaId = hoaId ? String(hoaId) : null;
    if (!resolvedHoaId && doc?.property_id) {
        try {
            const Property = require('../../../../portals/hoa-board/modules/property/model/property.model');
            const prop = await Property.findOne({
                _id: doc.property_id._id || doc.property_id,
                isDeleted: { $ne: true },
            })
                .select('hoaId')
                .lean();
            if (prop?.hoaId) resolvedHoaId = String(prop.hoaId);
        } catch (_) {
            /* ignore */
        }
    }
    if (!resolvedHoaId) {
        return {
            ...target,
            userIds: filterMaintenanceNotifyUserIds(doc, target?.userIds || []),
        };
    }
    const boardIds = await loadHoaMemberUserIds(resolvedHoaId);
    return {
        ...target,
        userIds: filterMaintenanceNotifyUserIds(doc, [
            ...(target.userIds || []).map((id) => normalizePartyUserId(id)).filter(Boolean),
            ...boardIds,
        ]),
    };
}

function dispatchMaintenanceVendorOrUpdateNotifications(doc, previous, updates = {}, actorUserId = null) {
    const assignedToChanged = Object.prototype.hasOwnProperty.call(updates, 'assignedTo')
        && maintenanceIdString(previous?.assignedTo) !== maintenanceIdString(updates.assignedTo);
    if (assignedToChanged && updates.assignedTo) {
        notifyMaintenanceVendorAssignedInAppInBackground(doc, actorUserId);
        setImmediate(() => {
            sendMaintenanceVendorAssignedEmail(doc, { actorUserId })
                .catch((err) => logger.error('[maintenance.service] vendor assignment email failed:', err.message));
        });
        return;
    }
    notifyMaintenanceRequestUpdated(doc, actorUserId, {
        status: updates && updates.status,
        previousStatus: previous?.status,
        priority: updates && updates.priority,
        previousPriority: previous?.priority,
    });
}

/**
 * notify Maintenance Request Updated
 *
 * Emails board + owners + assignee + requester via the same proven activity
 * email helper used for comments/notes/documents (create/assign delivery path).
 *
 * @param doc - Request/input argument
 * @param actorUserId - Request/input argument
 * @param options - Request/input argument
 * @returns Operations result
 */
function notifyMaintenanceRequestUpdated(doc, actorUserId, { status, previousStatus, priority, previousPriority } = {}) {
    const normalizedStatus = status ? String(status).toLowerCase() : '';
    const normalizedPrevious = previousStatus ? String(previousStatus).toLowerCase() : '';
    const isReopened = normalizedStatus === 'open'
        && (normalizedPrevious === 'resolved' || normalizedPrevious === 'completed');
    const becameResolved =
        (normalizedStatus === 'resolved' || normalizedStatus === 'completed')
        && normalizedPrevious !== 'resolved'
        && normalizedPrevious !== 'completed';
    const priorityChanged = Boolean(
        priority && previousPriority && String(priority) !== String(previousPriority)
    );
    const title = (doc && doc.title) || 'Maintenance request';
    const priorityMessage = priorityChanged
      ? `Priority changed from "${previousPriority}" to "${priority}" on maintenance request "${title}".`
      : undefined;

    if (becameResolved) {
        // Status flipped to Resolved/Completed via update path — same emails as /resolve.
        notifyMaintenanceResolved(doc, actorUserId);
        return;
    }

    const eventKey = isReopened ? 'maintenance_reopened' : 'maintenance_updated';
    const eventMessage = isReopened
      ? 'A maintenance ticket was reopened.'
      : (priorityMessage || 'A maintenance request was updated.');
    const dedupeKey = [
        eventKey,
        String(doc?._id || ''),
        status || doc?.status || '',
        priority || doc?.priority || '',
        doc?.updatedAt || Date.now(),
    ].join(':');

    setImmediate(async () => {
        try {
            let scoped = doc;
            try {
                const { ensureMaintenanceHoaId } = require('../../../../common/helpers/hoaInAppNotify.helper');
                scoped = await ensureMaintenanceHoaId(doc);
            } catch (_) {
                scoped = doc;
            }

            const result = await sendMaintenanceActivityEmails(scoped, {
                eventKey,
                eventMessage,
                dedupeKey,
                actorUserId,
            });

            if (!result?.sent) {
                logger.warn('[maintenance.service] update activity email sent=0', {
                    maintenanceRequestId: String(doc?._id || ''),
                    eventKey,
                    attempted: result?.attempted || 0,
                    failed: result?.failed || 0,
                });
            }
        } catch (err) {
            logger.error('[maintenance.service] update email failed:', err.message);
        }
    });

    notifyMaintenanceUpdatedInAppInBackground(doc, actorUserId, {
        status: status || doc?.status,
        eventKey: isReopened
          ? 'reopened'
          : (priorityChanged ? `priority:${previousPriority}:${priority}` : undefined),
        customMessage: priorityMessage,
    });
}

/**
 * notify Maintenance Resolved
 *
 * Email + in-app when a ticket is Resolved/Completed.
 * Email audience matches in-app: board + property owners + assignee + requester
 * (Notify Requester gated) via resolveMaintenanceNotificationRecipients.
 *
 * @param doc - Request/input argument
 * @param actorUserId - Request/input argument
 * @returns Operations result
 */
function notifyMaintenanceResolved(doc, actorUserId) {
    setImmediate(async () => {
        try {
            const recipientIds = await resolveMaintenanceNotificationRecipients(doc, actorUserId);
            if (!recipientIds.length) {
                logger.warn('[maintenance.service] resolve email skipped: no recipients', {
                    maintenanceRequestId: String(doc?._id || ''),
                });
                return;
            }
            notifyActionUpdateInBackground({
                userIds: recipientIds,
                eventKey: 'maintenance_resolved',
                actorUserId,
                entityType: 'Maintenance Request',
                entityId: doc._id,
                metadata: buildMaintenanceActionUpdateMetadata(doc, {
                    status: doc.status,
                }),
            });
        } catch (err) {
            logger.error('[maintenance.service] resolve email recipient resolution failed:', err.message);
            // Fallback: still notify requester + assignee + board when full resolution fails.
            try {
                const partyIds = filterMaintenanceNotifyUserIds(doc, [
                    ...maintenanceRequestedByUserIds(doc),
                    normalizePartyUserId(doc && doc.assignedTo),
                ]);
                const target = await enrichMaintenanceNotificationTargetWithHoaBoard(doc, { userIds: partyIds });
                notifyActionUpdateInBackground({
                    userIds: target.userIds,
                    eventKey: 'maintenance_resolved',
                    actorUserId,
                    entityType: 'Maintenance Request',
                    entityId: doc._id,
                    metadata: buildMaintenanceActionUpdateMetadata(doc, {
                        status: doc.status,
                    }),
                });
            } catch (fallbackErr) {
                logger.error('[maintenance.service] resolve email fallback failed:', fallbackErr.message);
            }
        }
    });

    notifyMaintenanceUpdatedInAppInBackground(doc, actorUserId, {
        status: doc?.status || 'Resolved',
        // Keep in-app copy aligned with maintenance_resolved email wording.
        customMessage: `A maintenance ticket was marked as resolved.`,
        eventKey: 'resolved',
    });
}

/**
 * Email board + property owners + assignee + requester for comment / note / documents.
 * Uses the same transactional helper path as create/assign emails (proven delivery),
 * includes the actor, and awaits send inside one background tick.
 */
function notifyMaintenanceActivityEmail(doc, actorUserId, {
    eventKey,
    eventMessage,
    logLabel,
    dedupeKey,
} = {}) {
    setImmediate(async () => {
        try {
            // Ensure hoaId is present so board members resolve even when only on property.
            let scoped = doc;
            try {
                const { ensureMaintenanceHoaId } = require('../../../../common/helpers/hoaInAppNotify.helper');
                scoped = await ensureMaintenanceHoaId(doc);
            } catch (_) {
                scoped = doc;
            }

            const result = await sendMaintenanceActivityEmails(scoped, {
                eventKey,
                eventMessage,
                dedupeKey: dedupeKey || `${eventKey}:${Date.now()}`,
                actorUserId,
            });

            if (!result?.sent) {
                logger.warn(`[maintenance.service] ${logLabel} activity email sent=0`, {
                    maintenanceRequestId: String(doc?._id || ''),
                    attempted: result?.attempted || 0,
                    failed: result?.failed || 0,
                });
            }
        } catch (err) {
            logger.error(`[maintenance.service] ${logLabel} email failed:`, err.message);
            // Last-resort fallback: action-update path with full resolver + board enrich.
            try {
                let recipientIds = await resolveMaintenanceNotificationRecipients(doc, null);
                if (!recipientIds.length) {
                    const partyIds = filterMaintenanceNotifyUserIds(doc, [
                        ...maintenanceRequestedByUserIds(doc),
                        normalizePartyUserId(doc && doc.assignedTo),
                    ]);
                    const target = await enrichMaintenanceNotificationTargetWithHoaBoard(doc, { userIds: partyIds });
                    recipientIds = target.userIds || [];
                }
                if (!recipientIds.length) {
                    logger.warn(`[maintenance.service] ${logLabel} fallback also found no recipients`, {
                        maintenanceRequestId: String(doc?._id || ''),
                    });
                    return;
                }
                const { sendActionUpdateEmail } = require('../../notifications/service/actionUpdateEmail.service');
                await sendActionUpdateEmail({
                    userIds: recipientIds,
                    eventKey,
                    eventMessage,
                    actorUserId: null, // include all associated users (including actor)
                    entityType: 'Maintenance Request',
                    entityId: doc && doc._id,
                    metadata: buildMaintenanceActionUpdateMetadata(doc, {
                        status: doc && doc.status,
                        dedupeKey: dedupeKey || `${eventKey}:${Date.now()}`,
                    }),
                });
            } catch (fallbackErr) {
                logger.error(`[maintenance.service] ${logLabel} email fallback failed:`, fallbackErr.message);
            }
        }
    });
}

/**
 * notify Maintenance Documents Updated
 *
 * Performs logic operations for notifyMaintenanceDocumentsUpdated.
 *
 * @param doc - Request/input argument
 * @param actorUserId - Request/input argument
 * @returns Operations result
 */
function notifyMaintenanceDocumentsUpdated(doc, actorUserId) {
    const docCount = Array.isArray(doc?.documents) ? doc.documents.length : 0;
    notifyMaintenanceActivityEmail(doc, actorUserId, {
        eventKey: 'maintenance_documents_updated',
        eventMessage: 'Maintenance request documents were updated.',
        logLabel: 'documents',
        dedupeKey: `documents:${doc?._id || ''}:${docCount}:${doc?.updatedAt || Date.now()}`,
    });

    notifyMaintenanceDocumentsInAppInBackground(doc, actorUserId);
}

/**
 * notify Maintenance Comment Added
 *
 * Performs logic operations for notifyMaintenanceCommentAdded.
 *
 * @param doc - Request/input argument
 * @param actorUserId - Request/input argument
 * @returns Operations result
 */
function notifyMaintenanceCommentAdded(doc, actorUserId) {
    const commentCount = Array.isArray(doc?.comments) ? doc.comments.length : 0;
    notifyMaintenanceActivityEmail(doc, actorUserId, {
        eventKey: 'maintenance_comment_added',
        eventMessage: 'A comment was added to a maintenance request.',
        logLabel: 'comment',
        dedupeKey: `comment:${doc?._id || ''}:${commentCount}:${doc?.updatedAt || Date.now()}`,
    });

    notifyMaintenanceCommentInAppInBackground(doc, actorUserId);
}

/**
 * notify Maintenance Note Added
 *
 * Performs logic operations for notifyMaintenanceNoteAdded.
 *
 * @param doc - Request/input argument
 * @param actorUserId - Request/input argument
 * @returns Operations result
 */
function notifyMaintenanceNoteAdded(doc, actorUserId) {
    const noteCount = Array.isArray(doc?.notes) ? doc.notes.length : 0;
    notifyMaintenanceActivityEmail(doc, actorUserId, {
        eventKey: 'maintenance_note_added',
        eventMessage: 'A note was added to a maintenance request.',
        logLabel: 'note',
        dedupeKey: `note:${doc?._id || ''}:${noteCount}:${doc?.updatedAt || Date.now()}`,
    });

    notifyMaintenanceNoteInAppInBackground(doc, actorUserId);
}

/**
 * Get active tenants for a property
 * Used by maintenance module to filter which tenants are active
 */
async function getActiveTenantsByPropertyService(propertyId, unitFilter = {}) {
    if (!propertyId) {
        const err = new Error('propertyId is required');
        err.status = 400;
        throw err;
    }

    try {
        // Import models here to avoid circular dependencies
        const Lease = require('../../../../portals/landlord/modules/leasing/model/lease.model');
        const User = require('../../users/models/user.model');
        const { LEASE_STATUSES } = require('../../../../common/constants/lease');

        // Build filter for active leases (both Approved and Active statuses)
        const filter = {
            property_id: propertyId,
            status: { $in: [LEASE_STATUSES.APPROVED, LEASE_STATUSES.ACTIVE] },
            isDeleted: { $ne: true }
        };

        // Prefer unitId; for backward compatibility also match legacy leases saved only with unitName.
        if (unitFilter && unitFilter.unitId) {
            const Property = require('../../../../portals/landlord/modules/property/model/property.model');
            const property = await Property.findOne({ _id: propertyId, isDeleted: { $ne: true } }).select('unitDetails').lean();
            const unitDetails = Array.isArray(property?.unitDetails) ? property.unitDetails : [];
            const matchedUnit = unitDetails.find(
                (u) => u && u._id && String(u._id) === String(unitFilter.unitId)
            );

            if (matchedUnit && matchedUnit.unitName) {
                filter.$or = [
                    { unitId: unitFilter.unitId },
                    { unitName: matchedUnit.unitName },
                ];
            } else {
                filter.unitId = unitFilter.unitId;
            }
        } else if (unitFilter && unitFilter.unitName) {
            filter.unitName = unitFilter.unitName;
        }

        // Find all active leases matching the filter
        const leases = await Lease.find(filter).lean();

        const tenantIds = new Set();
        for (const lease of leases) {
            if (lease.rentAndDepositDestribution && lease.rentAndDepositDestribution.split) {
                for (const split of lease.rentAndDepositDestribution.split) {
                    const tenantId = split.tenantId;
                    if (tenantId) {
                        tenantIds.add(String(tenantId));
                    }
                }
            }
        }

        if (tenantIds.size === 0) {
            return [];
        }

        const tenants = await User.find({
            _id: { $in: Array.from(tenantIds) },
            isDeleted: { $ne: true },
        }).select('_id name email phone').lean();

        return tenants.map((tenant) => ({
            _id: tenant._id,
            name: tenant.name,
            email: tenant.email,
            phone: tenant.phone,
        }));
    } catch (error) {
        logger.error('Error fetching active tenants by property:', error);
        const err = new Error('Failed to fetch active tenants');
        err.status = 500;
        throw err;
    }
}

module.exports = {
    applyLocationClear,
    createMaintenanceRequest,
    createMaintenanceRequestWithDocuments,
    getMaintenanceRequestById,
    listMaintenanceRequests,
    buildListFilterFromQuery,
    buildHoaCommunityMaintenanceScope,
    buildMaintenanceQueryFromScopeOr,
    resolveHoaBoardMaintenanceScopeOr,
    buildOwnerMaintenanceListScope,
    buildOwnerMaintenanceTicketMatch,
    applyMaintenanceListScopeToQuery,
    resolveMaintenanceListStatusFilter,
    normalizeListPagination,
    updateMaintenanceRequest,
    updateMaintenanceRequestWithDocuments,
    deleteMaintenanceRequest,
    resolveMaintenanceRequest,
    rejectMaintenanceRequest,
    notifyMaintenanceResolved,
    notifyMaintenanceRequestUpdated,
    notifyMaintenanceCommentAdded,
    notifyMaintenanceNoteAdded,
    notifyMaintenanceDocumentsUpdated,
    uploadDocuments,
    getMaintenanceDocuments,
    getDocumentFile,
    addComment,
    linkableCommentAttachments,
    getComments,
    addNote,
    updateMaintenanceNote,
    deleteMaintenanceNote,
    getActiveTenantsByPropertyService,
    maintenanceRequestedByUserIds,
};


