/**
 * ------------------------------------------------------------------
 * File: userProfile.routes.js
 * Module: Users Module
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * app, hoa-board, landlord
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const userProfileController = require('../controllers/userProfile.controller');
const authMiddleware = require('../../../../middleware/auth');
const authorize = require('../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../middleware/lockCheck');
const { validateBody, validateParams } = require('../../../../middleware/requestValidator');
const { idParamSchema, updateProfileSchema, assignRoleSchema, createUserSchema, createUsersSchema } = require('../validators/user.validator');

// GET /api/v1/users
router.get('/', authMiddleware, authorize, lockCheckMiddleware, userProfileController.getProfile);

// GET /api/v1/users/list - Get all users
router.get('/list', authMiddleware, authorize, lockCheckMiddleware, userProfileController.listUsers);

// POST /api/v1/users - Create a new user
router.post('/', authMiddleware, authorize, lockCheckMiddleware, validateBody(createUserSchema), userProfileController.createUser);

// POST /api/v1/users/batch - Create multiple users
router.post('/batch', authMiddleware, authorize, lockCheckMiddleware, validateBody(createUsersSchema), userProfileController.createUsers);

// PUT /api/v1/users/role
router.put('/role', authMiddleware, authorize, lockCheckMiddleware, validateBody(assignRoleSchema), userProfileController.assignRole);

// PUT /api/v1/users/:id
router.put('/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), validateBody(updateProfileSchema), userProfileController.updateProfile);

// DELETE /api/v1/users/:id
router.delete('/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), userProfileController.deleteProfile);

// GET /api/v1/users/privileges/:id
router.get('/privileges/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), userProfileController.getPrivileges);

// PUT /api/v1/users/picture/:id
router.put('/picture/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), userProfileController.updateProfilePicture);

// PATCH /api/v1/users/:id/activate
router.patch('/:id/activate', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), userProfileController.activateUser);

// POST /api/v1/users/:id/send-invite
router.post('/:id/send-invite', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), userProfileController.sendUserInvite);

module.exports = router;
