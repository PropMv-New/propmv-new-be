/**
 * ------------------------------------------------------------------
 * File: userProfile.controller.js
 * Module: Users Module
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * userProfile.routes
 * ------------------------------------------------------------------
 */

const userProfileService = require('../services/userProfile.service');
const userCreationService = require('../services/userCreation.service');
const emailHelper = require('../../../../common/helpers/emailHelper');
const { createUpload } = require('../../../../common/helpers/uploadHelper');
const { UPLOAD_PROFILE_SUBDIR } = require('../../../../common/constants/uploads');
const { PRIVILEGE_EDIT_USERS } = require('../../../../common/constants/privileges');
const { multerImageFilter, assertUploadedFilesValid } = require('../../../../common/helpers/fileValidationHelper');
const { cleanupUploadedFiles } = require('../../../../middleware/multipartValidator');
const s3Client = require('../../../../integrations/s3');
const responseHelper = require('../../../../common/helpers/responseHelper');
const logger = require('../../../../common/logger');
const { logControllerStep, handleControllerError } = require('../../../../common/helpers/controllerLogger');
const { notifyBoardMemberProfileUpdatedIfApplicable } = require('../../../../common/helpers/hoaCommunityNotify.helper');

const { uploadArray } = createUpload('profilePicture', null, { maxCount: 1, maxSizeBytes: 5 * 1024 * 1024, defaultSubdir: UPLOAD_PROFILE_SUBDIR, fileFilter: multerImageFilter });

/**
 * Allow users to update their own profile without EDIT_USERS.
 * Updating another user still requires EDIT_USERS (admin user-management).
 */
function assertCanUpdateUserProfile(req, targetUserId) {
  const requesterId = String(req.userId || req.user?.id || '');
  const targetId = String(targetUserId || '');
  if (!requesterId) {
    const err = new Error('User not authenticated');
    err.status = 401;
    throw err;
  }
  if (requesterId === targetId) return;

  const privileges = req.userPrivileges || [];
  if (privileges.includes(PRIVILEGE_EDIT_USERS)) return;

  const err = new Error('Authorization failed: insufficient privileges');
  err.status = 403;
  throw err;
}

const getProfile = async (req, res) => {
  logControllerStep(req, 'START', { action: 'getProfile' });
  try {
    const userId = req.userId || req.user?.id;
    if (!userId) return responseHelper.error(res, 'User not authenticated', 401);
    
    const preferredHoaId = req.headers['x-hoa-id'] || req.hoaContext?.hoaId || null;
    const profile = await userProfileService.getProfile(userId, { preferredHoaId });
    return responseHelper.success(res, profile, 'Profile fetched', 200);
  } catch (err) {
    logger.error('Get profile error:', err);
    return responseHelper.error(res, err.message, 404);
  }
};

const updateProfile = async (req, res) => {
  logControllerStep(req, 'START', { action: 'updateProfile' });
  try {
    const userId = req.params.id;
    assertCanUpdateUserProfile(req, userId);
    const preferredHoaId = req.headers['x-hoa-id'] || req.hoaContext?.hoaId || null;
    const profile = await userProfileService.updateProfile(userId, req.body, { preferredHoaId });
    notifyBoardMemberProfileUpdatedIfApplicable(
      req.userId || req.user?.id,
      profile,
      preferredHoaId
    );
    return responseHelper.success(res, profile, 'Profile updated', 200);
  } catch (err) {
    logger.error('Update profile error:', err);
    const status = err.status || (err.message.includes('already associated') ? 409 : 400);
    return responseHelper.error(res, err.message, status);
  }
};

const deleteProfile = async (req, res) => {
  logControllerStep(req, 'START', { action: 'deleteProfile' });
  try {
    const userId = req.params.id;
    const result = await userProfileService.deleteProfile(userId);
    return responseHelper.success(res, result, 'Profile deleted', 200);
  } catch (err) {
    logger.error('Delete profile error:', err);
    const status = err.status || 400;
    return responseHelper.error(res, err.message, status);
  }
};

const changePassword = async (req, res) => {
  logControllerStep(req, 'START', { action: 'changePassword' });
  try {
    const userId = req.userId || req.user?.id;
    if (!userId) return responseHelper.error(res, 'User not authenticated', 401);
    
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const result = await userProfileService.changePassword(userId, { currentPassword, newPassword, confirmPassword });
    return responseHelper.success(res, result, 'Password changed successfully', 200);
  } catch (err) {
    logger.error('Change password error:', err);
    return responseHelper.error(res, err.message, 400);
  }
};

const getPrivileges = async (req, res) => {
  logControllerStep(req, 'START', { action: 'getPrivileges' });
  try {
    const userId = req.params.id;
    const privileges = await userProfileService.getPrivileges(userId);
    return responseHelper.success(res, privileges, 'Privileges fetched', 200);
  } catch (err) {
    logger.error('Get privileges error:', err);
    return responseHelper.error(res, err.message, 404);
  }
};

const updateProfilePicture = async (req, res) => {
  logControllerStep(req, 'START', { action: 'updateProfilePicture' });
  try {
    const userId = req.params.id;
    assertCanUpdateUserProfile(req, userId);
    const preferredHoaId = req.headers['x-hoa-id'] || req.hoaContext?.hoaId || null;
    uploadArray(req, res, async (err) => {
      if (err) {
        logger.error('File upload error:', err);
        return responseHelper.error(res, err.message || 'File upload failed', 400);
      }

      if (!req.files || req.files.length === 0) {
        return responseHelper.error(res, 'No file uploaded. Please select an image file.', 400);
      }

      await assertUploadedFilesValid(req.files, 'IMAGE');

      const file = req.files[0];
      try {
        const filename = file.filename || file.originalname;
        const key = s3Client.getKeyForProfile ? s3Client.getKeyForProfile(userId, filename) : `${UPLOAD_PROFILE_SUBDIR}/${filename}`;

        const uploadResult = await s3Client.upload({ localFilePath: file.path, key });

  const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
        const config = require('../../../../config/default');
        const bucketName = config.s3 && config.s3.bucketName ? config.s3.bucketName : (process.env.S3_BUCKET || 'mock-bucket');
        const region = config.s3 && config.s3.region ? config.s3.region : (process.env.AWS_REGION || 'mock-region');
        const contentType = file.mimetype || 'application/octet-stream';
        const size = file.size || 0;

        const metadataDoc = await DocumentMetadata.create({
          key: uploadResult.Key || key,
          bucketName,
          region,
          size,
          contentType,
          originalName: file.originalname || filename
        });

        const result = await userProfileService.updateProfilePicture(userId, {
          metadataId: metadataDoc._id,
          filename
        }, { preferredHoaId });

        return responseHelper.success(res, { profilePic: result.profilePic, filename }, 'Profile picture updated successfully', 200);
      } catch (serviceErr) {
        cleanupUploadedFiles(req.files);
        logger.error('Service error:', serviceErr);
        return responseHelper.error(res, serviceErr.message, 400);
      }
    });
  } catch (err) {
    logger.error('Update profile picture error:', err);
    return responseHelper.error(res, err.message, 400);
  }
};

const listUsers = async (req, res) => {
  logControllerStep(req, 'START', { action: 'listUsers' });
  try {
    const userId = req.userId || req.user?.id;
    if (!userId) {
      return responseHelper.error(res, 'User authentication required', 401);
    }
    const users = await userProfileService.listUsers(userId);
    const safeUsers = await Promise.all(users.map(u => u.toSafeJSON()));
    return responseHelper.success(res, safeUsers, 'Users fetched', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, 500);
  }
};

const updateUser = async (req, res) => {
  logControllerStep(req, 'START', { action: 'updateUser' });
  try {
    const updated = await userProfileService.updateUser(req.params.id, req.body);
    return responseHelper.success(res, updated.toSafeJSON(), 'User updated', 200);
  } catch (err) {
    const status = err.message === 'User not found' ? 404 : 400;
    return responseHelper.error(res, err.message, status);
  }
};

const assignRole = async (req, res) => {
  logControllerStep(req, 'START', { action: 'assignRole' });
  try {
    const { userId, roleId } = req.body;
    const user = await userProfileService.assignUserRole(userId, roleId);
    return responseHelper.success(res, user.toSafeJSON(), 'Role assigned', 200);
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 400;
    return responseHelper.error(res, err.message, status);
  }
};

const activateUser = async (req, res) => {
  logControllerStep(req, 'START', { action: 'activateUser' });
  try {
    const user = await userProfileService.activateUser(req.params.id);
    return responseHelper.success(res, user.toSafeJSON(), 'User activated', 200);
  } catch (err) {
    const status = err.message === 'User not found' ? 404 : 400;
    return responseHelper.error(res, err.message, status);
  }
};

const createUser = async (req, res) => {
  logControllerStep(req, 'START', { action: 'createUser' });
  try {
    const currentUserId = req.userId || req.user?.id;
    if (!currentUserId) {
      return responseHelper.error(res, 'User authentication required', 401);
    }
    
    // Pass current user ID to the creation service for company assignment
    const userData = {
      ...req.body,
      createdByUserId: currentUserId,
    };
    
    const user = await userCreationService.createUser(userData);
    return responseHelper.success(res, await user.toSafeJSON(), 'User created successfully', 201);
  } catch (err) {
    const status = err.status === 409 || err.message.includes('already associated') || err.message.includes('already exists') ? 409 :
                   err.message.includes('required') ? 400 :
                   err.message.includes('Invalid role') ? 400 : 500;
    return responseHelper.error(res, err.message, status);
  }
};

const createUsers = async (req, res) => {
  logControllerStep(req, 'START', { action: 'createUsers' });
  try {
    const result = await userCreationService.createUsers(req.body.users);
    return responseHelper.success(res, result, 'Batch user creation completed', 201);
  } catch (err) {
    return responseHelper.error(res, err.message, 500);
  }
};

const sendUserInvite = async (req, res) => {
  logControllerStep(req, 'START', { action: 'sendUserInvite' });
  try {
    const inviterUserId = req.userId || req.user?.id;
    if (!inviterUserId) return responseHelper.error(res, 'User authentication required', 401);

    const User = require('../models/user.model');
    const invitee = await User.findOne({ _id: req.params.id, isDeleted: { $ne: true } }).lean();
    if (!invitee || !invitee.email) {
      return responseHelper.error(res, 'User not found or has no email', 404);
    }

    const inviter = await User.findOne({ _id: inviterUserId, isDeleted: { $ne: true } })
      .select('firstName lastName email')
      .lean();
    const inviterName =
      `${inviter?.firstName || ''} ${inviter?.lastName || ''}`.trim() || inviter?.email || 'PropMv';

    const base =
      process.env.PORTAL_INVITE_VERIFY_BASE_URL ||
      process.env.FRONTEND_BASE_URL ||
      'http://localhost:8080';
    const inviteUrl = `${String(base).replace(/\/$/, '')}/login`;
    const tenantName =
      `${invitee.firstName || ''} ${invitee.lastName || ''}`.trim() || invitee.email;
    const appName = process.env.APP_NAME || 'PropMv';

    await emailHelper.sendEmail(
      'invite',
      invitee.email,
      {
        tenantName,
        landlordName: inviterName,
        appName,
        inviteUrl,
        acknowledgeLink: inviteUrl,
        acknowledgeBlock: '',
      },
      { template: 'invite', subject: `You've been invited to ${appName}` }
    );

    return responseHelper.success(res, { sent: true, email: invitee.email }, 'Invite email sent', 200);
  } catch (err) {
    logger.error('Send user invite error:', err);
    return responseHelper.error(res, err.message, 500);
  }
};

module.exports = {
  getProfile,
  updateProfile,
  deleteProfile,
  changePassword,
  getPrivileges,
  updateProfilePicture,
  listUsers,
  updateUser,
  assignRole,
  activateUser,
  createUser,
  createUsers,
  sendUserInvite
};
