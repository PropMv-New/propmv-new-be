/**
 * ------------------------------------------------------------------
 * File: user.model.js
 * Module: Users Module
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * check-company-roles, check-user-company, fix-property-manager-user, restoreDeletedAccount
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const logger = require('../../../../common/logger');
const { USER_STATUSES } = require('../../../../common/constants/user');

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true },
    phone: { type: String },
    password: { type: String, required: true },
    firstName: { type: String },
    lastName: { type: String },
    address: { type: String },
    city: { type: String },
    state: { type: String },
    zipCode: { type: String },
    // User status field
    status: {
      type: String,
      enum: Object.values(USER_STATUSES),
      default: USER_STATUSES.ACTIVE
    },
    // Portal invite onboarding (Tenant / HOA Owner); unset/null = not in invite-only flow
    portalOnboardingStatus: {
      type: String,
      default: null,
    },
    // Mailing address components
    isDifferentMailingAddress: { type: Boolean, default: false },
    mailingAddress: {
      line1: { type: String },
      line2: { type: String },
      city: { type: String },
      state: { type: String },
      zipCode: { type: String }
    },
    // Owner-specific fields
    hasUnits: { type: Boolean, default: false },
    sendInvite: { type: Boolean, default: false },
    secondaryPhone: { type: String },
    auxiliaryEmails: [{ type: String }],
    propertyIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Property' }],
    emergencyContact: {
      firstName: { type: String },
      lastName: { type: String },
      phone: { type: String },
      email: { type: String }
    },
    notes: [{
      title: { type: String },
      description: { type: String, required: true },
      /** Human-friendly sequential number within this owner's notes (Note #1, #2, …) */
      noteNumber: { type: Number, min: 1 },
      isPinned: { type: Boolean, default: false },
      isImportant: { type: Boolean, default: false },
      reminder: { type: Date },
      reminderNotifiedAt: { type: Date },
      createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      // DocumentMetadata ObjectIds (preferred) or legacy { filename, path, mimetype, size }
      attachments: [mongoose.Schema.Types.Mixed],
      createdAt: { type: Date, default: Date.now },
      updatedAt: { type: Date, default: Date.now }
    }],
    // For tenant users, this references the landlord (owner) user record
    landlordId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Tenant balance amount (positive = credit available for future invoices)
    balance: { type: Number, default: 0 },
    // Company association - all roles live in Company.roles
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },
    companyRoleId: { type: mongoose.Schema.Types.ObjectId }, // References embedded role in Company.roles array
    // Screening options selected for tenant (application, credit, criminal)
    screening: [{ type: String, enum: ['application', 'credit', 'criminal'] }],

    // HOA Board Member signup info
    hoaInfo: {
      hoaId: { type: mongoose.Schema.Types.ObjectId, ref: 'HOA' }, // stable reference - set on signup and synced when HOA is created
      communityName: { type: String },
      numberOfUnits: { type: Number },
      propertyAddress: { type: String },
      associationType: { type: String },
    },
    /** Set when all HOA board memberships are revoked/deleted; cleared on restore or new invite accept */
    hoaBoardAccessBlocked: {
      hoaName: { type: String },
      reason: { type: String, enum: ['revoked', 'deleted'] },
      blockedAt: { type: Date },
    },
    /**
     * Vendor (and similar standalone entities): optional associations to HOA communities.
     * Vendors are not HOA members - they can be linked to one or more HOAs / landlord flows.
     */
    associatedHoaIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'HOA' }],
    associatedLandlordIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    // HOA data isolation fields - Added for HOA Board Member data segregation
    // These fields ensure HOA Board Members can only access records they created
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // User who created this record
    hoaBoardMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // HOA Board Member who owns this record
    version: { type: String, default: '1.0' },
    // Store profile picture as a reference to DocumentMetadata (single file)
    profilePic: { type: mongoose.Schema.Types.ObjectId, ref: 'DocumentMetadata' },
    documents: [
      {
        metadataId: { type: mongoose.Schema.Types.ObjectId, ref: 'DocumentMetadata', required: true },
        createdAt: { type: Date, default: Date.now }
      }
    ],
    dob: { type: Date },
    gender: { type: String, enum: ['Male', 'Female', 'Other', 'Prefer not to say'] },
    resetPasswordToken: { type: String },
    resetPasswordExpiresAt: { type: Date },
    resetPasswordOtp: { type: String },
    resetPasswordOtpExpiresAt: { type: Date },
    mfaOtp: { type: String },
    mfaOtpExpiresAt: { type: Date },
    mfaOtpAction: { type: String, enum: ['login', 'signup', 'payment-verify'] },
    mfaLoginVerifiedAt: { type: Date },
    /**
     * Self-serve signup sets null until email OTP verify succeeds.
     * Legacy accounts omit this field (treated as already verified).
     */
    emailVerifiedAt: { type: Date, default: undefined },
    /** Set when password changes; access tokens issued before this instant are rejected */
    credentialsChangedAt: { type: Date },
    refreshToken: { type: String },
    lockAccount: { type: Boolean, default: false },
    failedLoginAttempts: { type: Number, default: 0 },
    lockUntil: { type: Date },
    loginAttempts: [
      {
        at: { type: Date, default: Date.now },
        success: { type: Boolean, required: true },
        reason: { type: String },
        ip: { type: String },
        userAgent: { type: String },
        browser: { type: String },
        os: { type: String },
        deviceType: { type: String },
        city: { type: String },
        state: { type: String },
        country: { type: String },
        timezone: { type: String },
        isLocalDevelopment: { type: Boolean, default: false },
        requiresMfa: { type: Boolean, default: false },
        mfaDecision: { type: String },
        mfaReason: { type: String },
        deviceFingerprintHash: { type: String },
      }
    ],
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
    isArchived: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Add index on isDeleted field for query performance
userSchema.index({ isDeleted: 1 });
userSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { isDeleted: { $ne: true } } }
);
userSchema.index({ hoaBoardMemberId: 1, isDeleted: 1 });
userSchema.index({ propertyIds: 1, isDeleted: 1 });
userSchema.index({ createdBy: 1, isDeleted: 1 });
userSchema.index({ isDeleted: 1, isArchived: 1, createdAt: -1 });
// HOA owner scoping + owner list/picker filters (additive; verified via hoaDataIsolation owner queries)
userSchema.index({ 'hoaInfo.hoaId': 1, isDeleted: 1 });
userSchema.index({ associatedHoaIds: 1, isDeleted: 1 });
userSchema.index({ associatedLandlordIds: 1, isDeleted: 1 });
userSchema.index({ companyId: 1, companyRoleId: 1, isDeleted: 1 });

const { commonQueryHelpersPlugin } = require('../../../../common/db/schemaPlugins');
const { toObjectId } = require('../../../../common/db/mongooseHelpers');

commonQueryHelpersPlugin(userSchema);

const USER_SUMMARY_PROJECTION = {
  _id: 1,
  firstName: 1,
  lastName: 1,
  email: 1,
  phone: 1,
  propertyIds: 1,
  isDeleted: 1,
};

userSchema.statics.findByPropertyId = function findByPropertyId(propertyId, options = {}) {
  const { select = USER_SUMMARY_PROJECTION, lean = true } = options;
  let query = this.find({
    propertyIds: toObjectId(propertyId),
    isDeleted: { $ne: true },
  }).select(select);

  return lean ? query.lean().exec() : query.exec();
};

userSchema.statics.findByPropertyIds = function findByPropertyIds(propertyIds, options = {}) {
  const { select = USER_SUMMARY_PROJECTION, lean = true } = options;
  const ids = propertyIds.map(toObjectId);
  let query = this.find({
    propertyIds: { $in: ids },
    isDeleted: { $ne: true },
  }).select(select);

  return lean ? query.lean().exec() : query.exec();
};

userSchema.statics.findActiveByIds = function findActiveByIds(userIds, options = {}) {
  const { select = USER_SUMMARY_PROJECTION, lean = true } = options;
  const ids = userIds.map(toObjectId);
  let query = this.find({
    _id: { $in: ids },
    isDeleted: { $ne: true },
  }).select(select);

  return lean ? query.lean().exec() : query.exec();
};

userSchema.methods.toSafeJSON = async function toSafeJSON() {
  const obj = this.toObject({ versionKey: false });
  delete obj.password;
  delete obj.resetPasswordToken;
  delete obj.resetPasswordExpiresAt;
  delete obj.resetPasswordOtp;
  delete obj.resetPasswordOtpExpiresAt;
  delete obj.mfaOtp;
  delete obj.mfaOtpExpiresAt;
  delete obj.mfaOtpAction;
  delete obj.mfaLoginVerifiedAt;
  delete obj.refreshToken;
  delete obj.loginAttempts;

  // Add role information from company if available
  if (this.companyId && this.companyRoleId) {
    try {
      const role = await this.getCompanyRole();
      if (role) {
        obj.role = {
          _id: role._id,
          name: role.name,
          description: role.description,
          source: 'company'
        };
        obj.privileges = role.privileges || [];
      }
    } catch (error) {
      logger.error('Error fetching role in toSafeJSON:', error.message);
    }
  }

  return obj;
};

// Helper method to get user's role from company
userSchema.methods.getCompanyRole = async function getCompanyRole() {
  if (!this.companyId || !this.companyRoleId) {
    return null;
  }

  try {
    const Company = require('../../company/models/company.model');
    const company = await Company.findOne({ _id: this.companyId, isDeleted: { $ne: true } }).lean();

    if (!company || !company.roles) {
      return null;
    }

    const role = company.roles.find(
      r => r._id.toString() === this.companyRoleId.toString() && r.isActive
    );

    return role || null;
  } catch (error) {
    logger.error('Error in getCompanyRole:', error.message);
    return null;
  }
};

// Helper method to get user's privileges from company role
userSchema.methods.getPrivileges = async function getPrivileges() {
  const role = await this.getCompanyRole();
  return role && Array.isArray(role.privileges) ? role.privileges : [];
};

// Pre-save hook to automatically create company and assign Administrator role for Property Manager users
userSchema.pre('save', async function (next) {
  // Only run this hook for new documents (not updates)
  if (!this.isNew) {
    return next();
  }

  // Skip if company already assigned
  if (this.companyId && this.companyRoleId) {
    return next();
  }

  try {
    const role = await this.getCompanyRole();
    const roleName = role?.name || null;

    if (roleName === 'Property Manager') {
      logger.info(`🔄 Pre-save hook: Creating company for Property Manager: ${this.email}`);

      const { createCompanyForPropertyManager } = require('../../company/helpers/companyCreation.helper');

      // Create company with Administrator role
      const company = await createCompanyForPropertyManager({
        firstName: this.firstName,
        lastName: this.lastName,
        email: this.email,
        _id: this._id,
      });

      // Find the Administrator role from company's embedded roles
      const adminRole = company.roles.find(r => r.name === 'Administrator' && r.isActive);
      if (!adminRole) {
        logger.error('⚠️ Administrator role not found in company');
        return next();
      }

      // Assign company and role to user
      this.companyId = company._id;
      this.companyRoleId = adminRole._id;

      logger.info(`Pre-save hook: Company and Administrator role assigned to ${this.email}`);
      logger.info(`   Company ID: ${this.companyId}`);
      logger.info(`   Role ID: ${this.companyRoleId}`);
    }

    next();
  } catch (error) {
    logger.error('⚠️ Pre-save hook error:', error.message);
    // Don't fail the save operation if company creation fails
    // The company can be created later
    next();
  }
});

const User = mongoose.models.User || mongoose.model('User', userSchema);

module.exports = User;
