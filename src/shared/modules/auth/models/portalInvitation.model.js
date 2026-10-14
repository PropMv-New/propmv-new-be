/**
 * ------------------------------------------------------------------
 * File: portalInvitation.model.js
 * Module: Src Shared Modules Auth Models
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * portalInvitation.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const { PORTAL_INVITATION_PORTAL, PORTAL_INVITATION_STATUS } = require('../../../../common/constants/portalOnboarding');

const auditEventSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    type: { type: String, required: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const portalInvitationSchema = new mongoose.Schema(
  {
    inviteeUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    inviteeEmail: { type: String, required: true, lowercase: true, index: true },
    inviterUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    intendedCompanyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },
    intendedRoleId: { type: mongoose.Schema.Types.ObjectId, required: true },
    portal: {
      type: String,
      enum: Object.values(PORTAL_INVITATION_PORTAL),
      required: true,
      index: true,
    },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: Object.values(PORTAL_INVITATION_STATUS),
      default: PORTAL_INVITATION_STATUS.PENDING,
      index: true,
    },
    consumedAt: { type: Date },
    supersededAt: { type: Date },
    context: { type: mongoose.Schema.Types.Mixed, default: null },
    auditEvents: { type: [auditEventSchema], default: [] },
  },
  { timestamps: true }
);

portalInvitationSchema.index({ inviteeUserId: 1, portal: 1, status: 1 });

const PortalInvitation =
  mongoose.models.PortalInvitation || mongoose.model('PortalInvitation', portalInvitationSchema);

module.exports = PortalInvitation;
