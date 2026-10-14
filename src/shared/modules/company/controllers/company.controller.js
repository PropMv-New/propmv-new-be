/**
 * ------------------------------------------------------------------
 * File: company.controller.js
 * Module: Company Module
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * company.routes
 * ------------------------------------------------------------------
 */

const companyService = require('../services/company.service');
const responseHelper = require('../../../../common/helpers/responseHelper');
const { logControllerStep, handleControllerError } = require('../../../../common/helpers/controllerLogger');

/**
 * Create a new company
 */
async function createCompany(req, res) {
  logControllerStep(req, 'START', { action: 'createCompany' });
  try {
    const company = await companyService.createCompany(req.body);
    return responseHelper.success(res, company, 'Company created successfully', 201);
  } catch (err) {
    const status = err.message.includes('already exists') ? 409 : 400;
    return responseHelper.error(res, err.message, status);
  }
}

/**
 * Get all companies
 */
async function listCompanies(req, res) {
  logControllerStep(req, 'START', { action: 'listCompanies' });
  try {
    const companies = await companyService.listCompanies();
    return responseHelper.success(res, companies, 'Companies fetched successfully', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, 500);
  }
}

/**
 * Get company by ID
 */
async function getCompanyById(req, res) {
  logControllerStep(req, 'START', { action: 'getCompanyById' });
  try {
    const company = await companyService.getCompanyById(req.params.id);
    return responseHelper.success(res, company, 'Company fetched successfully', 200);
  } catch (err) {
    const status = err.message === 'Company not found' ? 404 : 500;
    return responseHelper.error(res, err.message, status);
  }
}

/**
 * Update company
 */
async function updateCompany(req, res) {
  logControllerStep(req, 'START', { action: 'updateCompany' });
  try {
    const company = await companyService.updateCompany(req.params.id, req.body);
    return responseHelper.success(res, company, 'Company updated successfully', 200);
  } catch (err) {
    const status = err.message === 'Company not found' ? 404 : 400;
    return responseHelper.error(res, err.message, status);
  }
}

/**
 * Delete company
 */
async function deleteCompany(req, res) {
  logControllerStep(req, 'START', { action: 'deleteCompany' });
  try {
    const result = await companyService.deleteCompany(req.params.id);
    return responseHelper.success(res, result, 'Company deleted successfully', 200);
  } catch (err) {
    const status = err.message === 'Company not found' ? 404 : 400;
    return responseHelper.error(res, err.message, status);
  }
}

/**
 * Add role to company
 */
async function addRoleToCompany(req, res) {
  logControllerStep(req, 'START', { action: 'addRoleToCompany' });
  try {
    const company = await companyService.addRoleToCompany(req.params.id, req.body);
    return responseHelper.success(res, company, 'Role added to company successfully', 201);
  } catch (err) {
    const status = err.message.includes('already exists') ? 409 : 
                   err.message === 'Company not found' ? 404 : 400;
    return responseHelper.error(res, err.message, status);
  }
}

/**
 * Update role in company
 */
async function updateRoleInCompany(req, res) {
  logControllerStep(req, 'START', { action: 'updateRoleInCompany' });
  try {
    const company = await companyService.updateRoleInCompany(
      req.params.id,
      req.params.roleId,
      req.body
    );
    return responseHelper.success(res, company, 'Role updated successfully', 200);
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 400;
    return responseHelper.error(res, err.message, status);
  }
}

/**
 * Delete role from company
 */
async function deleteRoleFromCompany(req, res) {
  logControllerStep(req, 'START', { action: 'deleteRoleFromCompany' });
  try {
    const company = await companyService.deleteRoleFromCompany(
      req.params.id,
      req.params.roleId
    );
    return responseHelper.success(res, company, 'Role deleted successfully', 200);
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 400;
    return responseHelper.error(res, err.message, status);
  }
}

/**
 * Get all roles for a company
 */
async function getCompanyRoles(req, res) {
  logControllerStep(req, 'START', { action: 'getCompanyRoles' });
  try {
    const roles = await companyService.getCompanyRoles(req.params.id);
    return responseHelper.success(res, roles, 'Company roles fetched successfully', 200);
  } catch (err) {
    const status = err.message === 'Company not found' ? 404 : 500;
    return responseHelper.error(res, err.message, status);
  }
}

/**
 * Get specific role from company
 */
async function getCompanyRole(req, res) {
  logControllerStep(req, 'START', { action: 'getCompanyRole' });
  try {
    const role = await companyService.getCompanyRole(req.params.id, req.params.roleId);
    return responseHelper.success(res, role, 'Role fetched successfully', 200);
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    return responseHelper.error(res, err.message, status);
  }
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
