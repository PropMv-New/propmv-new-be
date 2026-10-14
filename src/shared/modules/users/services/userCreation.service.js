/**
 * ------------------------------------------------------------------
 * File: userCreation.service.js
 * Module: Users Module
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * userProfile.controller
 * ------------------------------------------------------------------
 */

const bcrypt = require('bcryptjs');
const User = require('../models/user.model');
const Company = require('../../company/models/company.model');
const logger = require('../../../../common/logger');
const { USER_STATUSES } = require('../../../../common/constants/user');
const {
  assertUniqueUserEmail,
  assertUniqueUserPhone,
  normalizeUserEmail,
  mapUserPersistenceError,
} = require('../helpers/userIdentityValidation');

/**
 * Create a new user with company role assignment
 * Gets company from the creator user and validates role from that company
 * 
 * @param {Object} userData - User data
 * @param {string} userData.email - User email (required)
 * @param {string} [userData.password] - User password (optional; a secure random temp password is generated if omitted)
 * @param {string} userData.firstName - User first name
 * @param {string} userData.lastName - User last name
 * @param {string} userData.phone - User phone number
 * @param {string} userData.roleId - Company Role ID (required, must be from user's company)
 * @param {string} userData.createdByUserId - ID of user creating this user (required for company assignment)
 * @param {Object} userData.additionalInfo - Additional user information
 * @returns {Promise<Object>} Created user with company assignment
 */
async function createUser(userData) {
  const { checkTransactionSupport } = require('../../../../common/helpers/transactionHelper');
  const mongoose = require('mongoose');
  const Company = require('../../company/models/company.model');
  const transactionsSupported = await checkTransactionSupport();
  let session;

  if (transactionsSupported) {
    session = await mongoose.startSession();
    session.startTransaction();
  }

  try {
    // Validate required fields
    if (!userData.email) {
      throw new Error('Email is required');
    }
    if (!userData.roleId) {
      throw new Error('Role ID is required');
    }
    if (!userData.createdByUserId) {
      throw new Error('Creator user ID is required');
    }

    await assertUniqueUserEmail(userData.email, null, session);
    if (userData.phone) {
      await assertUniqueUserPhone(userData.phone, null, session);
    }

    // Get creator user and their company
    const creator = transactionsSupported
      ? await User.findById(userData.createdByUserId).select('companyId').session(session)
      : await User.findById(userData.createdByUserId).select('companyId');

    if (!creator) {
      throw new Error('Creator user not found');
    }

    if (!creator.companyId) {
      throw new Error('Creator user has no company associated');
    }

    // Get the company
    const company = transactionsSupported
      ? await Company.findById(creator.companyId).session(session)
      : await Company.findById(creator.companyId);

    if (!company) {
      throw new Error('Company not found');
    }

    // Validate role exists in company
    const companyRole = company.roles.id(userData.roleId);

    if (!companyRole) {
      // Provide helpful error with available company roles
      const availableRoles = company.roles
        .filter(r => r.isActive)
        .map(r => `${r.name} (${r._id})`)
        .join(', ');

      throw new Error(`Invalid role selected. Available roles: ${availableRoles}`);
    }

    if (!companyRole.isActive) {
      throw new Error('Selected role is inactive');
    }

    // Generate a secure random temporary password if none provided
    const crypto = require('crypto');
    const rawPassword = userData.password || crypto.randomBytes(32).toString('hex');
    const hashedPassword = await bcrypt.hash(rawPassword, 10);

    // Prepare user fields
    const userFields = {
      email: normalizeUserEmail(userData.email),
      password: hashedPassword,
      portalOnboardingStatus: userData.password ? undefined : 'invitation_sent',
      phone: userData.phone || null,
      firstName: userData.firstName || null,
      lastName: userData.lastName || null,
      companyId: creator.companyId, // Assign to creator's company
      companyRoleId: userData.roleId, // Company role from request
      address: userData.address || null,
      city: userData.city || null,
      state: userData.state || null,
      zipCode: userData.zipCode || null,
      status: userData.status || USER_STATUSES.ACTIVE,
      profilePic: userData.profilePic || null,
    };

    // Store additional info if provided
    if (userData.additionalInfo && Object.keys(userData.additionalInfo).length > 0) {
      if (userData.additionalInfo.address) {
        userFields.address = String(userData.additionalInfo.address).trim() || null;
      }
    }

    // Create user
    let user;
    if (transactionsSupported) {
      const userDoc = await User.create([userFields], { session });
      user = userDoc[0];
    } else {
      user = await User.create(userFields);
    }

    logger.info(`User created: ${user.email} with company role: ${companyRole.name}`);

    // Commit transaction
    if (transactionsSupported) {
      await session.commitTransaction();
      session.endSession();
    }

    // Return user (no need to populate global role as it doesn't exist)
    return user;

  } catch (err) {
    if (transactionsSupported && session) {
      await session.abortTransaction();
      session.endSession();
    }
    throw mapUserPersistenceError(err);
  }
}

/**
 * Create multiple users in batch
 * Automatically assigns Administrator role to Property Manager users
 * 
 * @param {Array<Object>} usersData - Array of user data objects
 * @returns {Promise<Array>} Array of created users
 */
async function createUsers(usersData) {
  const results = [];
  const errors = [];

  for (const userData of usersData) {
    try {
      const user = await createUser(userData);
      results.push({ success: true, user });
    } catch (error) {
      errors.push({
        success: false,
        email: userData.email,
        error: error.message
      });
    }
  }

  return {
    created: results,
    failed: errors,
    summary: {
      total: usersData.length,
      successful: results.length,
      failed: errors.length,
    }
  };
}

module.exports = {
  createUser,
  createUsers,
};
