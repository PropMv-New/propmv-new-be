/**
 * ------------------------------------------------------------------
 * File: roles.service.js
 * Module: Src Shared Modules Auth Services
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * roles.controller
 * ------------------------------------------------------------------
 */

const Module = require('../models/module.model');
const User = require('../../users/models/user.model');
const Company = require('../../company/models/company.model');
const logger = require('../../../../common/logger');

// Get user's company from userId
async function getUserCompany(userId) {
  const user = await User.findById(userId).select('companyId').lean();
  if (!user || !user.companyId) {
    throw new Error('User company not found');
  }
  
  const company = await Company.findOne({ 
    _id: user.companyId, 
    isDeleted: { $ne: true } 
  }).lean();
  
  if (!company) {
    throw new Error('Company not found');
  }
  
  return company;
}

// List roles from user's company
async function listRoles(userId) {
  if (!userId) {
    throw new Error('User ID is required');
  }
  
  const company = await getUserCompany(userId);
  const roles = company.roles || [];
  
  // Count users for each role
  const userCounts = await User.aggregate([
    {
      $match: {
        companyId: company._id,
        isDeleted: { $ne: true }
      }
    },
    {
      $group: {
        _id: '$companyRoleId',
        count: { $sum: 1 }
      }
    }
  ]);
  
  const userCountMap = {};
  userCounts.forEach(item => {
    if (item._id) {
      userCountMap[item._id.toString()] = item.count;
    }
  });
  
  // Transform roles to include functions array from privileges and user count
  return roles
    .filter(role => role.isActive)
    .map(role => ({
      _id: role._id,
      name: role.name,
      description: role.description,
      privileges: role.privileges || [],
      isActive: role.isActive,
      userCount: userCountMap[role._id.toString()] || 0,
      functions: (role.privileges || []).map(priv => ({
        _id: priv,
        name: priv,
        description: `${priv} privilege`,
      })),
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
    }));
}

// Get signup roles - returns roles from default PropMv company for signup
async function getSignupRoles() {
  try {
    // Fetch roles from the default PropMv company
    const propMvCompany = await Company.findOne({ 
      name: 'PropMv', 
      isDeleted: { $ne: true } 
    }).lean();
    
    if (!propMvCompany) {
      logger.error('PropMv default company not found');
      throw new Error('Default company not found. Please contact support.');
    }
    
    const roles = propMvCompany.roles
      .filter(r => r.isActive)
      .map(role => ({
        _id: role._id,
        name: role.name,
        description: role.description || '',
      }));
    
    return roles;
  } catch (err) {
    logger.error('Error fetching signup roles:', err);
    throw new Error('Failed to fetch signup roles: ' + err.message);
  }
}

// Get role by ID from user's company
async function getRoleById(roleId, userId) {
  if (!userId) {
    throw new Error('User ID is required');
  }
  
  const company = await getUserCompany(userId);
  const role = company.roles.find(
    r => r._id.toString() === roleId.toString() && r.isActive
  );
  
  if (!role) {
    throw new Error('Role not found');
  }
  
  return role;
}

// Create role in user's company
async function createRole({ name, description, functions }, userId) {
  if (!userId) {
    throw new Error('User ID is required');
  }
  
  const user = await User.findById(userId).select('companyId').lean();
  if (!user || !user.companyId) {
    throw new Error('User company not found');
  }
  
  const company = await Company.findOne({ 
    _id: user.companyId, 
    isDeleted: { $ne: true } 
  });
  
  if (!company) {
    throw new Error('Company not found');
  }
  
  // Check if role with same name already exists
  const existingRole = company.roles.find(
    r => r.name === name && r.isActive
  );
  
  if (existingRole) {
    throw new Error('Role already exists');
  }
  
  // Convert function IDs to privileges
  const privileges = Array.isArray(functions) ? functions : [];
  
  // Create new role
  const newRole = {
    name: name || null,
    description: description || null,
    privileges: privileges,
    isActive: true,
  };
  
  company.roles.push(newRole);
  await company.save();
  
  // Return the newly created role
  const createdRole = company.roles[company.roles.length - 1];
  return {
    _id: createdRole._id,
    name: createdRole.name,
    description: createdRole.description,
    privileges: createdRole.privileges,
    isActive: createdRole.isActive,
    createdAt: createdRole.createdAt,
    updatedAt: createdRole.updatedAt,
  };
}

// Update role in user's company
async function updateRole(roleId, { name, description, functions }, userId) {
  if (!userId) {
    throw new Error('User ID is required');
  }
  
  const user = await User.findById(userId).select('companyId').lean();
  if (!user || !user.companyId) {
    throw new Error('User company not found');
  }
  
  const company = await Company.findOne({ 
    _id: user.companyId, 
    isDeleted: { $ne: true } 
  });
  
  if (!company) {
    throw new Error('Company not found');
  }
  
  // Find the role to update
  const role = company.roles.id(roleId);
  if (!role) {
    throw new Error('Role not found');
  }
  
  // Convert function IDs to privileges
  const privileges = Array.isArray(functions) ? functions : [];
  
  // Update role fields
  role.name = name || role.name;
  role.description = description !== undefined ? description : role.description;
  role.privileges = privileges;
  
  await company.save();
  
  return {
    _id: role._id,
    name: role.name,
    description: role.description,
    privileges: role.privileges,
    isActive: role.isActive,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}

// Delete (deactivate) role in user's company
async function deleteRole(roleId, userId) {
  if (!userId) {
    throw new Error('User ID is required');
  }
  
  const user = await User.findById(userId).select('companyId').lean();
  if (!user || !user.companyId) {
    throw new Error('User company not found');
  }
  
  const company = await Company.findOne({ 
    _id: user.companyId, 
    isDeleted: { $ne: true } 
  });
  
  if (!company) {
    throw new Error('Company not found');
  }
  
  // Check if role is in use
  const inUse = await User.exists({ 
    companyId: company._id,
    companyRoleId: roleId,
    isDeleted: { $ne: true }
  });
  
  if (inUse) {
    throw new Error('Cannot delete role: it is assigned to users');
  }
  
  // Find and deactivate the role
  const role = company.roles.id(roleId);
  if (!role) {
    throw new Error('Role not found');
  }
  
  role.isActive = false;
  await company.save();
  
  return true;
}

async function listPermissions() {
  const modules = await Module.find().lean();
  
  const permissions = [];
  
  // Generate permissions by combining each function with each module
  for (const module of modules) {
    if (module.functions && Array.isArray(module.functions)) {
      for (const func of module.functions) {
        permissions.push({
          _id: `${func}_${module.name}`,
          name: `${func}_${module.name}`,
          description: `${func} access for ${module.name}`,
          module: module.name,
          function: func,
        });
      }
    }
  }
  
  return permissions;
}

async function listModules(userId) {
  // Determine if user is in HOA context
  let isHoaContext = false;
  if (userId) {
    try {
      const { resolveUserRoleName } = require('../../../../common/helpers/companyRoleHelper');
      const user = await User.findById(userId).select('role companyId companyRoleId').lean();
      const roleName = user ? await resolveUserRoleName(user) : null;
      if (roleName) {
        isHoaContext = roleName.toLowerCase().includes('hoa');
      }
    } catch (err) {
      logger.error('Error determining user context:', err);
    }
  }
  
  // Build query based on context
  const query = isHoaContext ? {} : { isHoaSpecificModule: { $ne: true } };
  
  // Fetch modules from database with filtering
  const modules = await Module.find(query).lean();
  
  // Transform modules to include function objects with IDs
  const transformedModules = modules.map(module => ({
    _id: module._id,
    name: module.name,
    description: module.description || '',
    isHoaSpecificModule: module.isHoaSpecificModule || false,
    functions: (module.functions || []).map(funcName => ({
      _id: `${funcName}_${module.name}`,
      name: `${funcName}_${module.name}`,
      description: `${funcName} access for ${module.name}`,
      moduleId: module._id,
      module: module.name,
    })),
  }));
  
  return transformedModules;
}

module.exports = {
  listRoles,
  getSignupRoles,
  getRoleById,
  createRole,
  updateRole,
  deleteRole,
  listPermissions,
  listModules,
};


