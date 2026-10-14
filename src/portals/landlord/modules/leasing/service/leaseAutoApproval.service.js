/**
 * ------------------------------------------------------------------
 * File: leaseAutoApproval.service.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * application.service, tenant.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Lease = require('../model/lease.model');
const User = require('../../../../../shared/modules/users/models/user.model');
const logger = require('../../../../../common/logger');
const { findAcksForLease } = require('./leaseTenantInviteAck.service');
const { LEASE_STATUSES } = require('../../../../../common/constants/lease');
const { USER_STATUSES } = require('../../../../../common/constants/user');
const { PORTAL_ONBOARDING_STATUS } = require('../../../../../common/constants/portalOnboarding');
const {
  activateLeaseService,
  autoFinalizeLeaseAfterOnboarding,
  leaseStartOnOrBeforeToday,
} = require('./leaseActivation.service');
const { runInTransaction } = require('./leaseDb.util');
const { ClockService } = require('../../../../../common/date');
const { resolveCreatedBy } = require('../../../../../shared/utils/creatorScope.util');

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

async function notifyLandlordLeaseInviteAcknowledged(leaseId, tenantId) {
  const { notify, EVENTS } = require('../../../../../integrations/notification');
  const Property = require('../../property/model/property.model');

  const safeLeaseId = toObjectId(leaseId);
  if (!safeLeaseId) return;
  const lease = await Lease.findOne({ _id: safeLeaseId, isDeleted: { $ne: true } })
    .select('unitName property_id')
    .lean();
  if (!lease?.property_id) return;

  const safePropertyId = toObjectId(lease.property_id);
  const property = safePropertyId
    ? await Property.findOne({ _id: safePropertyId, isDeleted: { $ne: true } })
        .select('name createdBy landlord_id')
        .lean()
    : null;
  const landlordId = resolveCreatedBy(property);
  if (!landlordId) return;

  const safeTenantId = toObjectId(tenantId);
  const tenant = safeTenantId
    ? await User.findOne({ _id: safeTenantId, isDeleted: { $ne: true } })
        .select('firstName lastName')
        .lean()
    : null;
  const tenantName = tenant
    ? `${tenant.firstName || ''} ${tenant.lastName || ''}`.trim() || 'A tenant'
    : 'A tenant';

  await notify(
    EVENTS.LEASE_INVITE_ACKNOWLEDGED,
    {
      tenantName,
      unitName: lease.unitName || 'Unit',
      propertyName: property?.name || 'Property',
    },
    String(landlordId),
    { leaseId: String(leaseId), tenantId: String(tenantId) }
  );
}

/**
 * invite Ack Done For Split Entry
 *
 * Performs logic operations for inviteAckDoneForSplitEntry.
 *
 * @param s - Request/input argument
 * @param ackByTenantId - Request/input argument
 * @returns Operations result
 */
function inviteAckDoneForSplitEntry(s, ackByTenantId) {
  const tid = String(s.tenantId || '');
  if (s.inviteAcknowledged) return true;
  const row = ackByTenantId[tid];
  return !!(row && row.isAcknowledged);
}

/**
 * Returns true when every tenant on the lease has acknowledged their lease invite.
 * Application approval is handled separately (invite is only sent after approval for screening tenants).
 */
async function leaseIsReadyForActivation(leaseDoc, options = {}) {
  const leaseId = leaseDoc._id;
  const split = leaseDoc.rentAndDepositDestribution?.split || [];
  if (!split.length) return false;

  const ackRows = await findAcksForLease(leaseId, options);
  const ackByTenantId = ackRows.reduce((acc, row) => {
    const key = String(row.tenant_id || row.tenantId || '');
    if (key) acc[key] = row;
    return acc;
  }, {});

  for (const s of split) {
    const tid = String(s.tenantId || '');
    if (!tid || !mongoose.Types.ObjectId.isValid(tid)) return false;
    if (!inviteAckDoneForSplitEntry(s, ackByTenantId)) return false;
  }
  return true;
}

/**
 * Public tenant action: record lease-invite acknowledgement and optionally activate the lease
 * when all tenants have satisfied their gates (screening approved or invite ack).
 */
async function acknowledgeLeaseInvite(leaseId, tenantId, options = {}) {
  if (!leaseId || !tenantId) {
    const err = new Error('leaseId and tenantId are required');
    err.status = 400;
    throw err;
  }
  if (!mongoose.Types.ObjectId.isValid(String(leaseId)) || !mongoose.Types.ObjectId.isValid(String(tenantId))) {
    const err = new Error('invalid leaseId or tenantId');
    err.status = 400;
    throw err;
  }

  if (!options.session) {
    return runInTransaction((session) => acknowledgeLeaseInvite(leaseId, tenantId, { session }));
  }

  const session = options.session;

  const safeLeaseId = toObjectId(leaseId);
  const safeTenantId = toObjectId(tenantId);
  if (!safeLeaseId || !safeTenantId) {
    const err = new Error('invalid leaseId or tenantId');
    err.status = 400;
    throw err;
  }

  const lease = await Lease.findOne({ _id: safeLeaseId, isDeleted: { $ne: true } }).session(session);
  if (!lease) {
    const err = new Error('Lease not found');
    err.status = 404;
    throw err;
  }

  const split = lease.rentAndDepositDestribution?.split || [];
  const idx = split.findIndex((s) => String(s?.tenantId) === String(tenantId));
  if (idx === -1) {
    const err = new Error('Tenant is not on this lease');
    err.status = 403;
    throw err;
  }

  const wasAlreadyAcknowledged = !!split[idx].inviteAcknowledged;

  const LeaseTenantInviteAck = require('../model/leaseTenantInviteAck.model');
  await LeaseTenantInviteAck.updateOne(
    { lease_id: safeLeaseId, tenant_id: safeTenantId },
    {
      $set: { isAcknowledged: true, acknowledgedAt: ClockService.now() },
      $setOnInsert: { leaseId: safeLeaseId, tenantId: safeTenantId, lease_id: safeLeaseId, tenant_id: safeTenantId },
    },
    { upsert: true, session }
  );

  split[idx].inviteAcknowledged = true;
  split[idx].inviteAcknowledgedAt = ClockService.now();
  lease.rentAndDepositDestribution.split = split;
  lease.markModified('rentAndDepositDestribution');
  await lease.save({ session });

  // Retries of an already-acked invite must stay fast - skip activation / invoice regeneration.
  let leaseActivated = false;
  let activationPayload = null;
  if (!wasAlreadyAcknowledged) {
    const activation = await attemptLeaseAutoActivation(leaseId, {
      session,
      skipInvoiceRegeneration: true,
    });
    leaseActivated = activation.leaseActivated;
    activationPayload = activation.activationPayload;
  }

  // Activate tenant status unconditionally after the transaction commits -
  // done outside the transaction so a lease-activation failure cannot roll it back.
  await User.updateOne(
    { _id: safeTenantId, isDeleted: { $ne: true } },
    {
      $set: {
        status: USER_STATUSES.ACTIVE,
        portalOnboardingStatus: PORTAL_ONBOARDING_STATUS.ACTIVE,
      },
    }
  );

  if (!options.skipLandlordNotification) {
    setImmediate(() => {
      notifyLandlordLeaseInviteAcknowledged(leaseId, tenantId).catch((err) => {
        logger.warn('[LeaseAck] Failed to notify landlord:', err.message);
      });
    });
  }

  return {
    acknowledged: true,
    leaseId: String(leaseId),
    tenantId: String(tenantId),
    leaseActivated,
    activation: leaseActivated && activationPayload
      ? { leaseId: String(activationPayload.lease?._id || leaseId) }
      : null,
  };
}

/**
 * Re-check whether a Submitted lease can now auto-activate.
 * This must be called after any onboarding milestone (application approval / invite ack).
 */
async function attemptLeaseAutoActivation(leaseId, options = {}) {
  if (!options.session) {
    return runInTransaction((session) => attemptLeaseAutoActivation(leaseId, { session }));
  }

  const session = options.session;
  const safeLeaseId = toObjectId(leaseId);
  if (!safeLeaseId) return { leaseActivated: false, activationPayload: null, regeneration: null };
  const fresh = await Lease.findOne({ _id: safeLeaseId, isDeleted: { $ne: true } }).session(session);
  let leaseActivated = false;
  let activationPayload = null;
  let regeneration = null;

  if (!fresh) {
    return { leaseActivated, activationPayload, regeneration };
  }

  const txnOpts = { session };

  if (fresh.status === LEASE_STATUSES.SUBMITTED) {
    const ready = await leaseIsReadyForActivation(fresh, txnOpts);
    if (ready) {
      try {
        activationPayload = await autoFinalizeLeaseAfterOnboarding(String(leaseId), txnOpts);
        leaseActivated = true;
      } catch (e) {
        if (e && e.message === 'Lease is already active') {
          leaseActivated = true;
          activationPayload = { lease: fresh, invoices: [] };
        } else {
          throw e;
        }
      }
    }
  } else if (fresh.status === LEASE_STATUSES.APPROVED) {
    const ready = await leaseIsReadyForActivation(fresh, txnOpts);
    if (ready) {
      if (leaseStartOnOrBeforeToday(fresh.start_date)) {
        try {
          activationPayload = await activateLeaseService(String(leaseId), txnOpts);
          leaseActivated = true;
        } catch (e) {
          if (e && e.message === 'Lease is already active') {
            leaseActivated = true;
            activationPayload = { lease: fresh, invoices: [] };
          } else {
            throw e;
          }
        }
      } else {
        const leaseService = require('./lease.service');
        regeneration = await leaseService.regenerateFuturePendingInvoicesForLease(String(leaseId), txnOpts);
      }
    }
  } else if (fresh.status === LEASE_STATUSES.ACTIVE && !options.skipInvoiceRegeneration) {
    const ready = await leaseIsReadyForActivation(fresh, txnOpts);
    if (ready) {
      const leaseService = require('./lease.service');
      regeneration = await leaseService.regenerateFuturePendingInvoicesForLease(String(leaseId), txnOpts);
    }
  }

  return { leaseActivated, activationPayload, regeneration };
}

module.exports = {
  acknowledgeLeaseInvite,
  leaseIsReadyForActivation,
  attemptLeaseAutoActivation,
  notifyLandlordLeaseInviteAcknowledged,
};
