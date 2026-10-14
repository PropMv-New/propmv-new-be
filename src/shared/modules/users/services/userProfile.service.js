/**
 * ------------------------------------------------------------------
 * File: userProfile.service.js
 * Module: Users Module
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * authorize landloard, authorize, userProfile.controller
 * ------------------------------------------------------------------
 */

const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const User = require('../models/user.model');

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}
const { assertUniqueUserPhone } = require('../helpers/userIdentityValidation');
const HOA = require('../../../../portals/hoa-board/modules/hoa/model/hoa.model');
const HOAMembership = require('../../../../portals/hoa-board/modules/hoa/model/hoaMembership.model');
const { logActivity } = require('../../../../portals/hoa-board/modules/dashboard/service/activity.service');
const { resolveUserRole, attachRoleToProfile } = require('../../../../common/helpers/companyRoleHelper');
const s3Client = require('../../../../integrations/s3');
const { USER_STATUSES } = require('../../../../common/constants/user');
const { ClockService } = require('../../../../common/date');

async function resolvePreferredHoaId(user, preferredHoaId) {
  if (preferredHoaId) return String(preferredHoaId);

  if (user?.hoaInfo?.hoaId) return String(user.hoaInfo.hoaId);

  const { resolveUserRoleName } = require('../../../../common/helpers/companyRoleHelper');
  const roleName = await resolveUserRoleName(user);
  if (String(roleName) === 'HOA Board Member') {
    const safeUserId = toObjectId(user._id);
    const membership = safeUserId ? await HOAMembership.findOne({
      userId: safeUserId,
      status: 'active',
    })
      .select('hoaId')
      .lean() : null;
    if (membership?.hoaId) return String(membership.hoaId);
  }

  return null;
}

async function enrichHoaInfoFromDatabase(profile, preferredHoaId) {
  if (!profile) return profile;

  const roleName = profile.role?.name || profile.role;
  const isHoaRole = roleName === 'HOA Board Member' || roleName === 'HOA Owner';
  // profile.role may already be merged from company role in getProfile()
  if (!isHoaRole) return profile;

  const hoaId = await resolvePreferredHoaId(profile, preferredHoaId);
  if (!hoaId) return profile;

  const hoa = await HOA.findById(hoaId)
    .select('name numberOfUnits associationType propertyAddress')
    .lean();
  if (!hoa) return profile;

  profile.hoaInfo = {
    hoaId: hoa._id,
    communityName: hoa.name,
    numberOfUnits: hoa.numberOfUnits,
    associationType: hoa.associationType,
    propertyAddress: hoa.propertyAddress,
  };

  return profile;
}

async function resolveActiveHoaMembership(userId, preferredHoaId) {
  const safeUserId = toObjectId(userId);
  if (!safeUserId) return null;
  if (preferredHoaId) {
    const safeHoaId = toObjectId(preferredHoaId);
    if (safeHoaId) {
      const membership = await HOAMembership.findOne({
        userId: safeUserId,
        hoaId: safeHoaId,
        status: 'active',
      }).lean();
      if (membership) return membership;
    }
  }
  return HOAMembership.findOne({ userId: safeUserId, status: 'active' }).lean();
}

/**
 * format User Display Name
 *
 * Performs logic operations for formatUserDisplayName.
 *
 * @param user - Request/input argument
 * @returns Operations result
 */
function formatUserDisplayName(user) {
  const name = `${user?.firstName || ''} ${user?.lastName || ''}`.trim();
  return name || user?.email || 'User';
}

async function logHoaProfileActivity(user, options = {}) {
  const membership = await resolveActiveHoaMembership(user._id, options.preferredHoaId);
  if (!membership) return;

  const entityId = membership.hoaId || user._id;
  await logActivity({
    userId: user._id,
    action: 'UPDATE',
    module: 'User',
    entityId,
    entityName: formatUserDisplayName(user),
    description: options.description || 'Profile updated.',
    meta: options.meta || {},
  });
}

/**
 * Get user profile by userId
 * @param {string} userId
 * @param {Object} [options]
 * @param {string} [options.preferredHoaId] - Active HOA from x-hoa-id header
 * @returns {Promise<Object>} User profile (safe fields only)
 * @throws {Error} If user not found
 */
async function getProfile(userId, options = {}) {
  const safeId = toObjectId(userId);
  if (!safeId) throw new Error('Invalid user ID');
  const user = await User.findOne({ _id: safeId, isDeleted: { $ne: true } }).populate('profilePic');
  if (!user) throw new Error('User not found');
  
  // If profilePic is populated DocumentMetadata, convert to a usable URL for clients
  try {
    if (user.profilePic && user.profilePic.key) {
      const cfg = require('../../../../config/default');
      const s3Base = (cfg.s3 && cfg.s3.baseUrl) || (require('../../../../integrations/s3').baseUrl) || '';
      const url = user.profilePic.Location || (s3Base ? `${s3Base}/${user.profilePic.key}` : `/${user.profilePic.key}`);
      user.profilePic = url;
    }
  } catch (ignore) {}
  
  const userProfile = user.toSafeJSON();
  await attachRoleToProfile(userProfile, user);
  return userProfile;
}

/**
 * Update user profile (only allowed fields)
 * @param {string} userId
 * @param {Object} updateData
 * @param {Object} [options]
 * @param {string} [options.preferredHoaId]
 * @returns {Promise<Object>} Updated user profile
 * @throws {Error} If user not found
 */
async function updateProfile(userId, updateData, options = {}) {
  const safeId = toObjectId(userId);
  if (!safeId) throw new Error('Invalid user ID');
  const { checkTransactionSupport } = require('../../../../common/helpers/transactionHelper');
  const transactionsSupported = await checkTransactionSupport();
  let session;
  if (transactionsSupported) {
    session = await mongoose.startSession();
    session.startTransaction();
  }
  try {
    // Only update fields present in the request body (avoids wiping profilePic/address when omitted)
    const allowedFields = [
      'phone',
      'firstName',
      'lastName',
      'address',
      'city',
      'state',
      'zipCode',
      'profilePic',
      'dob',
      'gender',
    ];
    const $set = {};
    for (const key of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(updateData, key)) {
        $set[key] = updateData[key];
      }
    }
    if (Object.prototype.hasOwnProperty.call($set, 'phone') && $set.phone) {
      await assertUniqueUserPhone($set.phone, safeId, session);
    }
    const user = transactionsSupported
      ? await User.findOneAndUpdate(
          { _id: safeId, isDeleted: { $ne: true } },
          { $set },
          { new: true, runValidators: true, session }
        )
      : await User.findOneAndUpdate(
          { _id: safeId, isDeleted: { $ne: true } },
          { $set },
          { new: true, runValidators: true }
        );
    if (!user) throw new Error('User not found');
    if (transactionsSupported) {
      await session.commitTransaction();
      session.endSession();
    }
    const profile = user.toSafeJSON();
    await attachRoleToProfile(profile, user);
    if (Object.keys($set).length) {
      await logHoaProfileActivity(user, {
        preferredHoaId: options.preferredHoaId,
        description: 'Profile updated.',
        meta: { fields: Object.keys($set) },
      });
    }
    return profile;
  } catch (err) {
    if (transactionsSupported && session) {
      await session.abortTransaction();
      session.endSession();
    }
    throw err;
  }
}

/**
 * Soft delete user profile (mark as inactive)
 * @param {string} userId
 * @returns {Promise<Object>} Result message
 * @throws {Error} If user not found
 */
async function deleteProfile(userId) {
  const safeId = toObjectId(userId);
  if (!safeId) throw new Error('Invalid user ID');
  const { checkTransactionSupport } = require('../../../../common/helpers/transactionHelper');
  const HOAMembership = require('../../../portals/hoa-board/modules/hoa/model/hoaMembership.model');
  const transactionsSupported = await checkTransactionSupport();
  let session;
  if (transactionsSupported) {
    session = await mongoose.startSession();
    session.startTransaction();
  }
  try {
    const user = transactionsSupported
      ? await User.findOneAndUpdate(
          { _id: safeId, isDeleted: { $ne: true } },
          { isDeleted: true, deletedAt: ClockService.now() },
          { new: true, session }
        )
      : await User.findOneAndUpdate(
          { _id: safeId, isDeleted: { $ne: true } },
          { isDeleted: true, deletedAt: ClockService.now() },
          { new: true }
        );
    if (!user) throw new Error('User not found');

    // Revoke all active/pending HOA memberships so the member no longer
    // appears as Active in any HOA board-members list.
    if (transactionsSupported) {
      await HOAMembership.updateMany(
        { userId: safeId, status: { $in: ['active', 'pending'] } },
        { $set: { status: 'revoked' }, $unset: { inviteToken: '', inviteTokenExpiresAt: '' } },
        { session }
      );
    } else {
      await HOAMembership.updateMany(
        { userId: safeId, status: { $in: ['active', 'pending'] } },
        { $set: { status: 'revoked' }, $unset: { inviteToken: '', inviteTokenExpiresAt: '' } }
      );
    }

    if (transactionsSupported) {
      await session.commitTransaction();
      session.endSession();
    }
    return { message: 'Profile deleted successfully' };
  } catch (err) {
    if (transactionsSupported && session) {
      await session.abortTransaction();
      session.endSession();
    }
    throw err;
  }
}

/**
 * Change user password
 * @param {string} userId
 * @param {Object} param1
 * @param {string} param1.currentPassword
 * @param {string} param1.newPassword
 * @param {string} param1.confirmPassword
 * @returns {Promise<Object>} Result message
 * @throws {Error} If validation fails or user not found
 */
async function changePassword(userId, { currentPassword, newPassword, confirmPassword }) {
  const safeId = toObjectId(userId);
  if (!safeId) throw new Error('Invalid user ID');
  const { checkTransactionSupport } = require('../../../../common/helpers/transactionHelper');
  const transactionsSupported = await checkTransactionSupport();
  let session;
  if (transactionsSupported) {
    session = await mongoose.startSession();
    session.startTransaction();
  }
  try {
    if (newPassword !== confirmPassword) {
      throw new Error('New password and confirm password do not match');
    }
    const user = transactionsSupported
      ? await User.findOne({ _id: safeId, isDeleted: { $ne: true } }).session(session)
      : await User.findOne({ _id: safeId, isDeleted: { $ne: true } });
    if (!user) throw new Error('User not found');
    if (user.isDeleted) throw new Error('User not found');
    // Verify current password
    const isValidPassword = await bcrypt.compare(currentPassword, user.password);
    if (!isValidPassword) {
      throw new Error('Current password is incorrect');
    }
    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    if (transactionsSupported) {
      await User.findOneAndUpdate({ _id: safeId, isDeleted: { $ne: true } }, { password: hashedPassword }, { session });
    } else {
      await User.findOneAndUpdate({ _id: safeId, isDeleted: { $ne: true } }, { password: hashedPassword });
    }
    if (transactionsSupported) {
      await session.commitTransaction();
      session.endSession();
    }
    return { message: 'Password changed successfully' };
  } catch (err) {
    if (transactionsSupported && session) {
      await session.abortTransaction();
      session.endSession();
    }
    throw err;
  }
}

const PRIVILEGE_CACHE_TTL_MS = Number(process.env.PRIVILEGE_CACHE_TTL_MS || 60_000);
const privilegeCache = new Map();

/**
 * get Cached Privileges
 *
 * Performs logic operations for getCachedPrivileges.
 *
 * @param userId - Request/input argument
 * @returns Operations result
 */
function getCachedPrivileges(userId) {
  const hit = privilegeCache.get(String(userId));
  if (!hit) return null;
  if (Date.now() - hit.at > PRIVILEGE_CACHE_TTL_MS) {
    privilegeCache.delete(String(userId));
    return null;
  }
  return hit.data;
}

/**
 * set Cached Privileges
 *
 * Performs logic operations for setCachedPrivileges.
 *
 * @param userId - Request/input argument
 * @param data - Request/input argument
 * @returns Operations result
 */
function setCachedPrivileges(userId, data) {
  privilegeCache.set(String(userId), { at: Date.now(), data });
}

/**
 * Get user privileges (functions) by userId
 * For Property Manager users with company roles, get privileges from company's embedded role
 * For other users, get privileges from Role table
 * @param {string} userId
 * @returns {Promise<Object>} Role and privileges
 * @throws {Error} If user not found
 */
async function getPrivileges(userId) {
  const cached = getCachedPrivileges(userId);
  if (cached) return cached;

  const safeId = toObjectId(userId);
  if (!safeId) throw new Error('Invalid user ID');
  const user = await User.findOne({ _id: safeId, isDeleted: { $ne: true } })
    .select('companyId companyRoleId')
    .lean();
  if (!user) throw new Error('User not found');

  const resolvedRole = await resolveUserRole(user);
  if (resolvedRole) {
    const result = {
      role: {
        _id: resolvedRole._id,
        name: resolvedRole.name,
        description: resolvedRole.description,
        source: 'company',
      },
      privileges: resolvedRole.privileges,
    };
    setCachedPrivileges(userId, result);
    return result;
  }

  const empty = {
    role: null,
    privileges: [],
    message: 'No role assigned to this user',
  };
  setCachedPrivileges(userId, empty);
  return empty;
}

/**
 * Update user profile picture
 * @param {string} userId
 * @param {Object} param1
 * @param {string} param1.profilePic
 * @param {string} param1.filename
 * @param {Object} [options]
 * @param {string} [options.preferredHoaId]
 * @returns {Promise<Object>} Result message and new profilePic
 * @throws {Error} If user not found
 */
async function updateProfilePicture(userId, { metadataId, filename }, options = {}) {
  const safeId = toObjectId(userId);
  if (!safeId) throw new Error('Invalid user ID');
  const safeMetadataId = toObjectId(metadataId);
  if (!safeMetadataId) throw new Error('Invalid metadata ID');
  const user = await User.findOne({ _id: safeId, isDeleted: { $ne: true } });
  if (!user) throw new Error('User not found');
  const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');

  // Delete old profile picture from storage (if present) and delete metadata
  if (user.profilePic) {
    try {
      const oldMetaId = toObjectId(user.profilePic);
      const oldMeta = oldMetaId ? await DocumentMetadata.findOne({ _id: oldMetaId, isDeleted: { $ne: true } }).lean() : null;
      if (oldMeta && oldMeta.key) {
        try { await s3Client.delete({ key: oldMeta.key }); } catch (ignore) { /* ignore */ }
      }
      // Delete old metadata
      if (oldMetaId) try { await DocumentMetadata.findByIdAndDelete(oldMetaId); } catch (ignore) { /* ignore */ }
    } catch (e) { /* ignore errors during cleanup */ }
  }

  // Set new profilePic to metadata reference
  const updatedUser = await User.findOneAndUpdate(
    { _id: safeId, isDeleted: { $ne: true } },
    { profilePic: safeMetadataId },
    { new: true, runValidators: true }
  );

  // Prepare a friendly profilePic URL for response
  let profilePicUrl = null;
  try {
    const newMeta = await DocumentMetadata.findOne({ _id: safeMetadataId, isDeleted: { $ne: true } }).lean();
    if (newMeta && newMeta.key) {
      const config = require('../../../../config/default');
      const s3Base = (config.s3 && config.s3.baseUrl) || s3Client.baseUrl || '';
      profilePicUrl = newMeta.Location || (s3Base ? `${s3Base}/${newMeta.key}` : `/${newMeta.key}`);
    }
  } catch (e) { /* ignore */ }

  await logHoaProfileActivity(updatedUser, {
    preferredHoaId: options.preferredHoaId,
    description: 'Profile picture updated.',
  });

  return {
    message: 'Profile picture updated successfully',
    profilePic: profilePicUrl,
    filename
  };
}

/**
 * List all users for the current user's company
 * @param {string} userId - Current user's ID
 * @returns {Promise<Array>} List of users from the same company
 */
async function listUsers(userId) {
  if (!userId) {
    throw new Error('User ID is required');
  }
  const safeId = toObjectId(userId);
  if (!safeId) throw new Error('Invalid user ID');
  
  // Get the current user to find their company
  const currentUser = await User.findOne({ _id: safeId, isDeleted: { $ne: true } })
    .select('companyId companyRoleId')
    .lean();
  
  if (!currentUser) {
    throw new Error('Current user not found');
  }
  
  // If user has a company, return only users from that company
  if (currentUser.companyId) {
    const safeCompanyId = toObjectId(currentUser.companyId);
    if (!safeCompanyId) return User.find({ _id: safeId, isDeleted: { $ne: true } }).select('-password');
    return User.find({
      companyId: safeCompanyId,
      isDeleted: { $ne: true },
    }).select('-password');
  }

  return User.find({ _id: safeId, isDeleted: { $ne: true } }).select('-password');
}

/**
 * Update user (admin only, allowed fields only)
 * @param {string} userId
 * @param {Object} updates
 * @returns {Promise<Object>} Updated user
 * @throws {Error} If user not found
 */
async function updateUser(userId, updates) {
  const safeId = toObjectId(userId);
  if (!safeId) throw new Error('Invalid user ID');
  const { checkTransactionSupport } = require('../../../../common/helpers/transactionHelper');
  const transactionsSupported = await checkTransactionSupport();
  let session;
  if (transactionsSupported) {
    session = await mongoose.startSession();
    session.startTransaction();
  }
  try {
    // Always set all allowed fields, using existing values if not provided
    const allowed = [
      'phone', 'firstName', 'lastName', 'address', 'state', 'zipCode', 'profilePic', 'dob', 'gender',
      'secondaryPhone', 'isDifferentMailingAddress', 'mailingAddress', 'auxiliaryEmails', 'emergencyContact'
    ];
    const $set = {};
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        $set[key] = updates[key];
      }
    }
    if (Object.prototype.hasOwnProperty.call($set, 'phone') && $set.phone) {
      await assertUniqueUserPhone($set.phone, safeId, session);
    }
    const user = transactionsSupported
      ? await User.findOneAndUpdate({ _id: safeId, isDeleted: { $ne: true } }, { $set }, { new: true, runValidators: true, session })
      : await User.findOneAndUpdate({ _id: safeId, isDeleted: { $ne: true } }, { $set }, { new: true, runValidators: true });
    if (!user) throw new Error('User not found');
    if (transactionsSupported) {
      await session.commitTransaction();
      session.endSession();
    }
    return user;
  } catch (err) {
    if (transactionsSupported && session) {
      await session.abortTransaction();
      session.endSession();
    }
    throw err;
  }
}

/**
 * Assign a company embedded role to a user.
 * @param {string} userId
 * @param {string} roleId
 * @returns {Promise<Object>} Updated user
 * @throws {Error} If user or role not found
 */
async function assignUserRole(userId, roleId) {
  const { checkTransactionSupport } = require('../../../../common/helpers/transactionHelper');
  const Company = require('../../company/models/company.model');
  const transactionsSupported = await checkTransactionSupport();
  let session;
  if (transactionsSupported) {
    session = await mongoose.startSession();
    session.startTransaction();
  }
  try {
    if (!roleId) {
      throw new Error('roleId is required');
    }
    const safeUserId = toObjectId(userId);
    if (!safeUserId) throw new Error('userId (valid ObjectId) is required');

    const user = transactionsSupported
      ? await User.findOne({ _id: safeUserId, isDeleted: { $ne: true } }).session(session)
      : await User.findOne({ _id: safeUserId, isDeleted: { $ne: true } });

    if (!user) throw new Error('User not found');
    if (!user.companyId) throw new Error('User has no company assigned');

    const safeCompanyId = toObjectId(user.companyId);
    if (!safeCompanyId) throw new Error('User has an invalid company ID');
    const company = transactionsSupported
      ? await Company.findOne({ _id: safeCompanyId, isDeleted: { $ne: true } }).session(session)
      : await Company.findOne({ _id: safeCompanyId, isDeleted: { $ne: true } });

    if (!company) throw new Error('Company not found for user');

    const safeRoleId = toObjectId(roleId);
    if (!safeRoleId) throw new Error('roleId must be a valid ObjectId');
    const companyRole = company.roles.id(safeRoleId);
    if (!companyRole || !companyRole.isActive) {
      throw new Error('Role not found in company or is inactive');
    }

    user.companyRoleId = safeRoleId;
    await user.save({ session: transactionsSupported ? session : undefined });

    if (transactionsSupported) {
      await session.commitTransaction();
      session.endSession();
    }

    return user;
  } catch (err) {
    if (transactionsSupported && session) {
      await session.abortTransaction();
      session.endSession();
    }
    throw err;
  }
}

/**
 * Activate a user by setting status to Active
 * @param {string} userId
 * @returns {Promise<Object>} Updated user
 * @throws {Error} If user not found
 */
async function activateUser(userId) {
  const safeId = toObjectId(userId);
  if (!safeId) throw new Error('Invalid user ID');
  const user = await User.findOneAndUpdate(
    { _id: safeId, isDeleted: { $ne: true } },
    { $set: { status: USER_STATUSES.ACTIVE } },
    { new: true, runValidators: true }
  );

  if (!user) {
    throw new Error('User not found');
  }

  return user;
}

module.exports = {
  getProfile,
  updateProfile,
  deleteProfile,
  changePassword,
  getPrivileges,
  updateProfilePicture,
  listUsers,
  updateUser,
  assignUserRole,
  activateUser,
};
