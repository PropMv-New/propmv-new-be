/**
 * ------------------------------------------------------------------
 * File: leaseTenantInviteAck.model.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * leaseAutoApproval.service, leaseTenantInviteAck.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');

/**
 * Tracks per-tenant lease invite acknowledgement for tenants who do not use the screening application flow.
 * Collection name matches legacy MongoDB: leasetenantinviteacks
 */
const leaseTenantInviteAckSchema = new mongoose.Schema(
  {
    // Legacy key format still present in DB indexes/documents.
    leaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lease', index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    // Canonical snake_case keys used by current backend code.
    lease_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Lease', required: true, index: true },
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    isAcknowledged: { type: Boolean, default: false },
    acknowledgedAt: { type: Date },
    inviteSentAt: { type: Date },
  },
  { timestamps: true, collection: 'leasetenantinviteacks' }
);

leaseTenantInviteAckSchema.index({ lease_id: 1, tenant_id: 1 }, { unique: true });
// leaseId/tenantId are aliases kept for legacy reads; uniqueness is enforced via lease_id+tenant_id above.

leaseTenantInviteAckSchema.pre('validate', function normalizeKeys(next) {
  if (!this.leaseId && this.lease_id) this.leaseId = this.lease_id;
  if (!this.lease_id && this.leaseId) this.lease_id = this.leaseId;
  if (!this.tenantId && this.tenant_id) this.tenantId = this.tenant_id;
  if (!this.tenant_id && this.tenantId) this.tenant_id = this.tenantId;
  next();
});

module.exports =
  mongoose.models.LeaseTenantInviteAck ||
  mongoose.model('LeaseTenantInviteAck', leaseTenantInviteAckSchema);
