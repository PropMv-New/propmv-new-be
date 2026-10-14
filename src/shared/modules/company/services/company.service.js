/**
 * ------------------------------------------------------------------
 * File: company.service.js
 * Module: Company Module
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * company.controller
 * ------------------------------------------------------------------
 */

const Company = require('../models/company.model');
const Module = require('../../auth/models/module.model');
const { ClockService } = require('../../../../common/date');

/**
 * Create a new company
 */
async function createCompany({ name, description, ownerId, roles = [], address, contactInfo, settings }) {
  const existingCompany = await Company.findByName(name);
  if (existingCompany) {
    throw new Error('Company with this name already exists');
  }

  const company = await Company.create({
    name,
    description,
    ownerId,
    roles,
    address,
    contactInfo,
    settings,
  });

  return company;
}

/**
 * Get all companies
 */
async function listCompanies() {
  return Company.find({ isDeleted: { $ne: true } })
    .populate('ownerId', 'firstName lastName email')
    .sort({ createdAt: -1 });
}

/**
 * Get company by ID
 */
async function getCompanyById(companyId) {
  const company = await Company.findOne({ _id: companyId, isDeleted: { $ne: true } })
    .populate('ownerId', 'firstName lastName email');
  
  if (!company) throw new Error('Company not found');
  return company;
}

/**
 * Update company
 */
async function updateCompany(companyId, updateData) {
  const company = await Company.findOne({ _id: companyId, isDeleted: { $ne: true } });
  if (!company) throw new Error('Company not found');

  const allowedFields = ['name', 'description', 'address', 'contactInfo', 'settings', 'isActive'];
  allowedFields.forEach(field => {
    if (updateData[field] !== undefined) {
      company[field] = updateData[field];
    }
  });

  await company.save();
  return company;
}

/**
 * Delete company (soft delete)
 */
async function deleteCompany(companyId) {
  const company = await Company.findOne({ _id: companyId, isDeleted: { $ne: true } });
  if (!company) throw new Error('Company not found');

  company.isDeleted = true;
  company.deletedAt = ClockService.now();
  await company.save();

  return { message: 'Company deleted successfully' };
}

/**
 * Add role to company
 */
async function addRoleToCompany(companyId, roleData) {
  const company = await Company.findOne({ _id: companyId, isDeleted: { $ne: true } });
  if (!company) throw new Error('Company not found');

  // Check if role name already exists in company
  const existingRole = company.findRoleByName(roleData.name);
  if (existingRole) {
    throw new Error('Role with this name already exists in company');
  }

  await company.addRole(roleData);
  return company;
}

/**
 * Update role in company
 */
async function updateRoleInCompany(companyId, roleId, updateData) {
  const company = await Company.findOne({ _id: companyId, isDeleted: { $ne: true } });
  if (!company) throw new Error('Company not found');

  await company.updateRole(roleId, updateData);
  return company;
}

/**
 * Delete role from company (soft delete)
 */
async function deleteRoleFromCompany(companyId, roleId) {
  const company = await Company.findOne({ _id: companyId, isDeleted: { $ne: true } });
  if (!company) throw new Error('Company not found');

  await company.removeRole(roleId);
  return company;
}

/**
 * Get all roles for a company
 */
async function getCompanyRoles(companyId) {
  const company = await Company.findOne({ _id: companyId, isDeleted: { $ne: true } });
  
  if (!company) throw new Error('Company not found');
  return company.getActiveRoles();
}

/**
 * Get specific role from company
 */
async function getCompanyRole(companyId, roleId) {
  const company = await Company.findOne({ _id: companyId, isDeleted: { $ne: true } });
  
  if (!company) throw new Error('Company not found');
  
  const role = company.findRoleById(roleId);
  if (!role) throw new Error('Role not found in company');
  
  return role;
}

module.exports = {
  createCompany,
  listCompanies,
  getCompanyById,
  updateCompany,
  deleteCompany,
  addRoleToCompany,
  updateRoleInCompany,
  deleteRoleFromCompany,
  getCompanyRoles,
  getCompanyRole,
};
