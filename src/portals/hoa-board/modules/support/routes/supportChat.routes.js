/**
 * ------------------------------------------------------------------
 * File: supportChat.routes.js
 * Module: HOA Board Portal
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
const supportChatController = require('../controller/supportChatController');
const authMiddleware = require('../../../../../middleware/auth');
const csrfProtection = require('../../../../../middleware/csrfProtection');

router.post('/init', authMiddleware, csrfProtection, supportChatController.initChat);
router.post('/message', authMiddleware, csrfProtection, supportChatController.sendMessage);
router.get('/history', authMiddleware, supportChatController.getChatHistory);
router.put('/close/:chatId', authMiddleware, csrfProtection, supportChatController.closeChat);

module.exports = router;
