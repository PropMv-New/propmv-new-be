const express = require('express');
const router = express.Router();

const supportController = require('../controller/support.controller');
const authMiddleware = require('../../../../middleware/auth');

// Authenticated: only logged-in portal users (HOA Board, HOA Owner, Tenant, etc.)
router.post('/contact', authMiddleware, supportController.submitContactRequest);

module.exports = router;
