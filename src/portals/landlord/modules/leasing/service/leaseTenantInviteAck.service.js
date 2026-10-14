/**
 * ------------------------------------------------------------------
 * File: leaseTenantInviteAck.service.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * lease.service, leaseAutoApproval.service, leaseTenantInviteDelivery.service, tenant.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const LeaseTenantInviteAck = require('../model/leaseTenantInviteAck.model');
const { ClockService } = require('../../../../../common/date');

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

async function seedLeaseTenantInviteAcksForLease(lease, options = {}) {
  if (!lease || !lease._id) return;
  const safeLeaseId = toObjectId(lease._id);
  if (!safeLeaseId) return;
  const split = lease.rentAndDepositDestribution?.split || [];
  const session = options.session;

  for (const s of split) {
    const screening = Array.isArray(s.screening) ? s.screening : [];
    if (Array.isArray(screening) && screening.length > 0) continue;

    const safeTenantId = toObjectId(s.tenantId);
    if (!safeTenantId) continue;

    await LeaseTenantInviteAck.updateOne(
      { leaseId: safeLeaseId, tenantId: safeTenantId },
      {
        $setOnInsert: {
          leaseId: safeLeaseId,
          tenantId: safeTenantId,
          lease_id: safeLeaseId,
          tenant_id: safeTenantId,
          isAcknowledged: false,
        },
      },
      { upsert: true, ...(session ? { session } : {}) }
    );
  }
}

async function findAck(leaseId, tenantId) {
  const safeLeaseId = toObjectId(leaseId);
  const safeTenantId = toObjectId(tenantId);
  if (!safeLeaseId || !safeTenantId) return null;
  return LeaseTenantInviteAck.findOne({
    $or: [
      { leaseId: safeLeaseId, tenantId: safeTenantId },
      { lease_id: safeLeaseId, tenant_id: safeTenantId },
    ],
  }).lean();
}

async function findAcksForLease(leaseId, options = {}) {
  const safeLeaseId = toObjectId(leaseId);
  if (!safeLeaseId) return [];
  const session = options.session;
  const query = LeaseTenantInviteAck.find({
    $or: [{ leaseId: safeLeaseId }, { lease_id: safeLeaseId }],
  });
  if (session) query.session(session);
  return query.lean();
}

async function recordLeaseTenantInviteSent(leaseId, tenantId, options = {}) {
  if (!leaseId || !tenantId) return null;
  const safeLeaseId = toObjectId(leaseId);
  const safeTenantId = toObjectId(tenantId);
  if (!safeLeaseId || !safeTenantId) return null;
  const session = options.session;
  const now = ClockService.now();
  const update = {
    $set: { inviteSentAt: now },
    $setOnInsert: {
      leaseId: safeLeaseId,
      tenantId: safeTenantId,
      lease_id: safeLeaseId,
      tenant_id: safeTenantId,
      isAcknowledged: false,
    },
  };
  const opts = { upsert: true };
  if (session) opts.session = session;
  return LeaseTenantInviteAck.updateOne(
    {
      $or: [
        { leaseId: safeLeaseId, tenantId: safeTenantId },
        { lease_id: safeLeaseId, tenant_id: safeTenantId },
      ],
    },
    update,
    opts
  );
}

module.exports = {
  seedLeaseTenantInviteAcksForLease,
  findAck,
  findAcksForLease,
  recordLeaseTenantInviteSent,
};
