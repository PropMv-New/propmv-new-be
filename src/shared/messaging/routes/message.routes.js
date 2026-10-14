/**
 * ------------------------------------------------------------------
 * File: message.routes.js
 * Module: Src Shared Messaging Routes
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * hoa-board, landlord
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const messageController = require('../controller/message.controller');
const groupChatController = require('../controller/groupChat.controller');
const authMiddleware = require('../../../middleware/auth');
const { hoaDataIsolation } = require('../../../middleware/hoaDataIsolation');
const { validate } = require('../../../middleware/requestValidator');
const messageValidator = require('../validators/message.validator');
const { validateUploadedFiles } = require('../../../middleware/multipartValidator');
const { multerNoteAttachmentFilter } = require('../../../common/helpers/fileValidationHelper');

router.get('/conversations', authMiddleware, hoaDataIsolation, messageController.getConversationList);
router.get('/contacts', authMiddleware, hoaDataIsolation, messageController.getChatContacts);
router.get('/conversations/:otherUserId', authMiddleware, messageController.getConversation);

// Group chat routes - static paths BEFORE parameterised ones
router.post('/groups', authMiddleware, hoaDataIsolation, validate(messageValidator.createGroup), groupChatController.createGroup);
router.get('/groups', authMiddleware, groupChatController.getUserGroups);
router.post('/groups/send', authMiddleware, validate(messageValidator.sendGroupMessage), groupChatController.sendGroupMessage);
router.get('/groups/:groupId', authMiddleware, groupChatController.getGroup);
router.post('/groups/:groupId/members', authMiddleware, hoaDataIsolation, validate(messageValidator.addGroupMembers), groupChatController.addMembers);
router.get('/groups/:groupId/messages', authMiddleware, groupChatController.getGroupConversation);

router.post('/send', authMiddleware, validate(messageValidator.sendMessage), messageController.sendMessage);
router.post('/mark-read', authMiddleware, validate(messageValidator.markAsRead), messageController.markAsRead);
router.post('/upload', authMiddleware, validate(messageValidator.uploadAttachment), messageController.uploadAttachments, validateUploadedFiles({ fileFilter: multerNoteAttachmentFilter, contentProfile: 'NOTE_ATTACHMENT' }), messageController.uploadAttachment);
router.get('/:messageId/attachments/:index/url', authMiddleware, messageController.getAttachmentUrl);
router.get('/:messageId/attachments/:index/file', authMiddleware, messageController.streamAttachment);
router.delete('/:messageId', authMiddleware, messageController.deleteMessage);
router.get('/unread-count', authMiddleware, messageController.getUnreadCount);

module.exports = router;
