const express = require('express');
const authMiddleware = require('../../../../middleware/auth');
const authorize = require('../../../../middleware/authorize');
const controller = require('../controller/notification.controller');

const router = express.Router();

router.get('/', authMiddleware, authorize, controller.listNotifications);
router.get('/unread-count', authMiddleware, authorize, controller.getUnreadCount);
router.patch('/:id/read', authMiddleware, authorize, controller.markAsRead);
router.post('/mark-read', authMiddleware, authorize, controller.markMultipleAsRead);
router.post('/mark-all-read', authMiddleware, authorize, controller.markAllAsRead);

module.exports = router;
