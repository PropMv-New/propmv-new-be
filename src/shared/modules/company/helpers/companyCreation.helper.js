/**
 * ------------------------------------------------------------------
 * File: companyCreation.helper.js
 * Module: Company Module
 *
 * Purpose:
 * Backend utility/module providing helper functions for companyCreation.helper.
 *
 * Used By:
 * fix-property-manager-user, auth.service, user.model
 * ------------------------------------------------------------------
 */

const Company = require('../models/company.model');
const Module = require('../../auth/models/module.model');
const logger = require('../../../../common/logger');

/**
 * Get all available privileges in the system by combining modules and their functions
 * Generates privileges in format: FUNCTION_MODULE (e.g., VIEW_PROPERTY, CREATE_TENANT)
 */
async function getAllSystemPrivileges() {
  // Get all modules with their functions
  const modules = await Module.find().lean();

  const privileges = [];

  // Generate privileges by combining each function with each module
  for (const module of modules) {
    if (module.functions && Array.isArray(module.functions)) {
      for (const func of module.functions) {
        // Create privilege in format: FUNCTION_MODULE
        // e.g., VIEW_PROPERTY, CREATE_TENANT, EDIT_LEASE
        const privilege = `${func.toUpperCase()}_${module.name.toUpperCase()}`;
        privileges.push(privilege);
      }
    }
  }

  return privileges;
}

/**
 * Create a company with Administrator role for Property Manager users
 * This is automatically called when a Property Manager user is created
 * 
 * @param {Object} userData - User data containing firstName, lastName, email, _id
 * @returns {Promise<Object>} - Created company document with Administrator role
 */
async function createCompanyForPropertyManager(userData) {
  try {
    // Get all available privileges in the system
    const allPrivileges = await getAllSystemPrivileges();

    // Create company name from user's name
    const companyName = `${userData.firstName} ${userData.lastName}'s Company`;

    // Create the company with Administrator role
    const company = await Company.create({
      name: companyName,
      description: `Property management company for ${userData.firstName} ${userData.lastName}`,
      ownerId: userData._id,
      roles: [
        {
          name: 'Administrator',
          description: 'Full system access with all privileges',
          privileges: allPrivileges,
          isActive: true,
        }
      ],
      isActive: true,
      contactInfo: {
        email: userData.email,
      },
    });

    logger.info(`Company created for Property Manager: ${companyName} (ID: ${company._id})`);
    logger.info(`Administrator role created with ${allPrivileges.length} privileges`);

    return company;
  } catch (error) {
    logger.error(' Error creating company for Property Manager:', error.message);
    throw error;
  }
}

/**
 * Assign company role to Property Manager user
 * Assigns the Administrator role from the company's embedded roles array
 * Clears the role field from Role table and uses company role instead
 * 
 * @param {Object} user - User document
 * @param {Object} company - Company document with embedded roles
 * @returns {Promise<Object>} - Updated user document
 */
async function assignCompanyRoleToUser(user, company) {
  try {
    const User = require('../../users/models/user.model');

    // Find the Administrator role from company's embedded roles
    const adminRole = company.roles.find(role => role.name === 'Administrator' && role.isActive);

    if (!adminRole) {
      throw new Error('Administrator role not found in company');
    }

    // Update user: clear role field and set company role
    const updatedUser = await User.findByIdAndUpdate(
      user._id,
      {
        $set: {
          companyId: company._id,
          companyRoleId: adminRole._id
        },
      },
      { new: true }
    );

    logger.info(`Assigned Administrator role from company to user: ${user.email}`);
    logger.info(`   Company: ${company.name}`);
    logger.info(`   Role: ${adminRole.name} (${adminRole._id})`);

    return updatedUser;
  } catch (error) {
    logger.error(' Error assigning company role to user:', error.message);
    throw error;
  }
}

/**
 * Check if user should have a company created
 * Only Property Manager users get automatic company creation
 * 
 * @param {String} roleName - Name of the role
 * @returns {Boolean} - True if company should be created
 */
function shouldCreateCompany(roleName) {
  return roleName === 'Property Manager';
}

/**
 * Ensure Property Manager has a company
 * Checks if company exists, creates one if it doesn't
 * Called during login to ensure every Property Manager has a company
 * 
 * @param {Object} user - User document with _id, firstName, lastName, email, role
 * @returns {Promise<Object|null>} - Company document or null if not applicable
 */
async function ensurePropertyManagerCompany(user) {
  try {
    const { resolveUserRoleName } = require('../../../../common/helpers/companyRoleHelper');
    const roleName = await resolveUserRoleName(user);

    if (!shouldCreateCompany(roleName)) {
      return null; // Not a Property Manager, no company needed
    }

    // Check if company already exists for this user
    const existingCompany = await Company.findOne({
      ownerId: user._id,
      isDeleted: { $ne: true }
    });

    if (existingCompany) {
      logger.info(`✓ Company already exists for Property Manager: ${user.email}`);

      // Ensure user has company role assigned
      if (!user.companyId || !user.companyRoleId) {
        await assignCompanyRoleToUser(user, existingCompany);
      }

      return existingCompany;
    }

    // No company exists, create one
    logger.info(`📝 Creating company for Property Manager: ${user.email}`);
    const company = await createCompanyForPropertyManager({
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      _id: user._id,
    });

    // Assign company role to user
    await assignCompanyRoleToUser(user, company);

    return company;
  } catch (error) {
    logger.error(' Error ensuring Property Manager company:', error.message);
    // Don't throw error - login should succeed even if company creation fails
    return null;
  }
}

module.exports = {
  getAllSystemPrivileges,
  createCompanyForPropertyManager,
  shouldCreateCompany,
  ensurePropertyManagerCompany,
  assignCompanyRoleToUser,
};
