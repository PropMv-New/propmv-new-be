/**
 * ------------------------------------------------------------------
 * File: email.routes.js
 * Module: Src Shared Email Routes
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const emailController = require('../controller/email.controller');
const authMiddleware = require('../../../middleware/auth');
const { validate } = require('../../../middleware/requestValidator');
const emailValidator = require('../validators/email.validator');

router.get('/list', authMiddleware, emailController.getEmailList);
router.get('/contacts', authMiddleware, emailController.getEmailContacts);
router.get('/thread/:otherUserId', authMiddleware, emailController.getEmailThread);
router.post('/send', authMiddleware, validate(emailValidator.sendEmail), emailController.sendEmail);
router.post('/mark-read', authMiddleware, validate(emailValidator.markAsRead), emailController.markAsRead);
router.delete('/:emailId', authMiddleware, emailController.deleteEmail);
router.get('/unread-count', authMiddleware, emailController.getUnreadCount);

module.exports = router;
