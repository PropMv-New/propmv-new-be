/**
 * ------------------------------------------------------------------
 * File: roles.controller.js
 * Module: Src Shared Modules Auth Controllers
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * roles.routes
 * ------------------------------------------------------------------
 */

const rolesService = require('../services/roles.service');
const logger = require('../../../../common/logger');

async function listRoles(req, res, next) {
  try {
    const userId = req.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'User authentication required' });
    }
    const roles = await rolesService.listRoles(userId);
    res.json(roles);
  } catch (err) {
    next(err);
  }
}

async function getSignupRoles(req, res, next) {
  try {
    const { connectToDatabase } = require('../../../../database');
    await connectToDatabase();
    const roles = await rolesService.getSignupRoles();
    res.json({ data: roles, statuscode: 200 });
  } catch (err) {
    logger.error('Error in getSignupRoles controller:', err);
    next(err);
  }
}

async function getRoleById(req, res, next) {
  try {
    const userId = req.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'User authentication required' });
    }
    const role = await rolesService.getRoleById(req.params.id, userId);
    res.json(role);
  } catch (err) {
    next(err);
  }
}

async function createRole(req, res, next) {
  try {
    const userId = req.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'User authentication required' });
    }
    const { name, description, functions } = req.body;
    const created = await rolesService.createRole({ name, description, functions }, userId);
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
}

async function updateRole(req, res, next) {
  try {
    const userId = req.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'User authentication required' });
    }
    const { name, description, functions } = req.body;
    const updated = await rolesService.updateRole(req.params.id, { name, description, functions }, userId);
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

async function deleteRole(req, res, next) {
  try {
    const userId = req.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'User authentication required' });
    }
    await rolesService.deleteRole(req.params.id, userId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

async function listPermissions(req, res, next) {
  try {
    const permissions = await rolesService.listPermissions();
    res.json(permissions);
  } catch (err) {
    next(err);
  }
}

async function listModules(req, res, next) {
  try {
    const userId = req.userId || req.user?.id;
    const modules = await rolesService.listModules(userId);
    res.json(modules);
  } catch (err) {
    next(err);
  }
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


