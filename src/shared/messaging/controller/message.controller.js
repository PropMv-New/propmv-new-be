/**
 * ------------------------------------------------------------------
 * File: message.controller.js
 * Module: Src Shared Messaging Controller
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * message.routes
 * ------------------------------------------------------------------
 */

const messageService = require('../service/message.service');
const { buildContactsOptionsFromRequest } = require('../../../common/services/contacts.service');
const { createUpload } = require('../../../common/helpers/uploadHelper');
const { UPLOAD_MESSAGE_SUBDIR } = require('../../../common/constants/uploads');
const { multerNoteAttachmentFilter } = require('../../../common/helpers/fileValidationHelper');
const storageClient = require('../../../integrations/storage');
const logger = require('../../../common/logger');
const { ClockService } = require('../../../common/date');
const fs = require('fs');
const Message = require('../model/message.model');
const GroupChat = require('../model/groupChat.model');

/**
 * Storage key of a saved attachment. Chat stores the object's plain URL; the
 * bucket is private, so that URL is refused and the file could neither be
 * opened nor downloaded. The key is the URL's path.
 */
function attachmentKeyFromUrl(url) {
  const value = String(url || '').trim();
  if (/^https?:\/\//i.test(value)) {
    try {
      return decodeURIComponent(new URL(value).pathname.replace(/^\/+/, '')) || null;
    } catch {
      return null;
    }
  }
  // Mock/local storage saves "<baseUrl>/<key>" (e.g. /mock-s3/Messaging/...).
  const base = String(storageClient.baseUrl || '').replace(/\/+$/, '');
  if (base && value.startsWith(`${base}/`)) {
    return decodeURIComponent(value.slice(base.length + 1)) || null;
  }
  return null;
}

/**
 * The attachment, if this user is in its conversation (sender, receiver or a
 * group member). Returns { status } on refusal so both routes answer alike.
 */
async function findAttachmentForUser(messageId, rawIndex, userId) {
  const index = Number.parseInt(rawIndex, 10);
  const message = await Message.findById(messageId)
    .select('senderId receiverId groupId attachments isDeleted')
    .lean();
  if (!message || message.isDeleted || !Number.isInteger(index) || index < 0) {
    return { status: 404 };
  }
  const uid = String(userId);
  let allowed = String(message.senderId) === uid || String(message.receiverId) === uid;
  if (!allowed && message.groupId) {
    allowed = Boolean(await GroupChat.exists({ _id: message.groupId, 'members.userId': uid }));
  }
  if (!allowed) return { status: 403 };
  const attachment = (message.attachments || [])[index];
  return attachment ? { attachment } : { status: 404 };
}

const ATTACHMENT_REFUSALS = {
  403: 'You do not have access to this attachment',
  404: 'Attachment not found',
};

const { uploadArray: uploadAttachments } = createUpload('attachments', UPLOAD_MESSAGE_SUBDIR, {
  maxCount: 5,
  maxSizeBytes: 10 * 1024 * 1024,
  fileFilter: multerNoteAttachmentFilter,
});

/**
 * emit Realtime Message
 *
 * Performs logic operations for emitRealtimeMessage.
 *
 * @param messageDoc - Request/input argument
 * @returns Operations result
 */
function emitRealtimeMessage(messageDoc) {
  const websocketManager = require('../service/websocket.manager');
  if (websocketManager.emitMessageToParticipants) {
    websocketManager.emitMessageToParticipants(messageDoc);
    return;
  }
  const io = websocketManager && websocketManager.io;
  if (!io || !messageDoc) return;

  const receiverRoom = String(messageDoc.receiverId?._id || messageDoc.receiverId || '');
  const senderRoom = String(messageDoc.senderId?._id || messageDoc.senderId || '');
  const eventNames = ['receive_message', 'message'];

  for (const eventName of eventNames) {
    if (receiverRoom) io.to(receiverRoom).emit(eventName, messageDoc);
    if (senderRoom) io.to(senderRoom).emit(eventName, messageDoc);
  }
}

/**
 * emit Message Read Receipts
 *
 * Performs logic operations for emitMessageReadReceipts.
 *
 * @param messages - Request/input argument
 * @returns Operations result
 */
function emitMessageReadReceipts(messages) {
  const websocketManager = require('../service/websocket.manager');
  const io = websocketManager && websocketManager.io;
  if (!io || !Array.isArray(messages) || messages.length === 0) return;

  messages.forEach((messageDoc) => {
    const senderRoom = String(messageDoc.senderId?._id || messageDoc.senderId || '');
    const receiverRoom = String(messageDoc.receiverId?._id || messageDoc.receiverId || '');
    const payload = {
      messageId: String(messageDoc._id),
      readAt: messageDoc.readAt || ClockService.now(),
    };
    if (senderRoom) io.to(senderRoom).emit('message_read_receipt', payload);
    if (receiverRoom) io.to(receiverRoom).emit('message_read_receipt', payload);
  });
}

/**
 * emit Message Deleted
 *
 * Performs logic operations for emitMessageDeleted.
 *
 * @param messageDoc - Request/input argument
 * @returns Operations result
 */
function emitMessageDeleted(messageDoc) {
  const websocketManager = require('../service/websocket.manager');
  const io = websocketManager && websocketManager.io;
  if (!io || !messageDoc) return;

  const senderRoom = String(messageDoc.senderId?._id || messageDoc.senderId || '');
  const receiverRoom = String(messageDoc.receiverId?._id || messageDoc.receiverId || '');
  const payload = {
    messageId: String(messageDoc._id),
    senderId: String(messageDoc.senderId?._id || messageDoc.senderId || ''),
    receiverId: String(messageDoc.receiverId?._id || messageDoc.receiverId || ''),
  };
  if (senderRoom) io.to(senderRoom).emit('message_deleted', payload);
  if (receiverRoom) io.to(receiverRoom).emit('message_deleted', payload);
}

/**
 * build Hoa Chat Options
 *
 * Performs logic operations for buildHoaChatOptions.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function buildHoaChatOptions(req) {
  return buildContactsOptionsFromRequest(req);
}

/**
 * MessageController
 *
 * Represents the Message Controller controller/model class.
 */
class MessageController {
  async getChatContacts(req, res, next) {
    try {
      const userId = req.userId;
      const { search = '', limit, forGroupChat } = req.query || {};

      const options = buildContactsOptionsFromRequest(req, {
        search,
        limit,
        forGroupChat: forGroupChat === 'true' || forGroupChat === true,
      });

      const contacts = await messageService.getChatContacts(userId, options);
      res.json({ message: 'Chat contacts retrieved successfully', statuscode: 200, data: contacts });
    } catch (error) {
      next(error);
    }
  }

  async getConversation(req, res, next) {
    try {
      const { otherUserId } = req.params;
      const { page = 1, limit = 50 } = req.query;
      const userId = req.userId;

      const result = await messageService.getConversation(
        userId,
        otherUserId,
        parseInt(page),
        parseInt(limit),
        buildHoaChatOptions(req)
      );

      res.json({ message: 'Conversation retrieved successfully', statuscode: 200, data: result });
    } catch (error) {
      next(error);
    }
  }

  async getConversationList(req, res, next) {
    try {
      const userId = req.userId;
      const conversations = await messageService.getConversationList(userId, buildHoaChatOptions(req));

      res.json({ message: 'Conversation list retrieved successfully', statuscode: 200, data: conversations });
    } catch (error) {
      next(error);
    }
  }

  async markAsRead(req, res, next) {
    try {
      const { messageIds } = req.body;
      const userId = req.userId;

      const updatedMessages = await messageService.markAsRead(userId, messageIds);

      // Direct message read receipts
      const directMessages = updatedMessages.filter((m) => !m.groupId);
      emitMessageReadReceipts(directMessages);

      // Group message read receipts - notify sender when ALL members have read
      const groupMessageIds = updatedMessages
        .filter((m) => m.groupId)
        .map((m) => String(m._id));
      if (groupMessageIds.length) {
        const fullyRead = await messageService.getFullyReadGroupMessages(groupMessageIds);
        const groupChatController = require('./groupChat.controller');
        const readEvents = fullyRead.map((event) => {
          const msg = updatedMessages.find((m) => String(m._id) === event.messageId);
          return {
            ...event,
            groupId: msg?.groupId?._id ? String(msg.groupId._id) : String(msg?.groupId || ''),
          };
        });
        groupChatController.emitGroupReadReceipts(readEvents);
      }

      res.json({ message: 'Messages marked as read', statuscode: 200, data: null });
    } catch (error) {
      next(error);
    }
  }

  async deleteMessage(req, res, next) {
    try {
      const { messageId } = req.params;
      const userId = req.userId;

      const deletedMessage = await messageService.deleteMessage(messageId, userId);
      emitMessageDeleted(deletedMessage);

      res.json({ message: 'Message deleted successfully', statuscode: 200, data: null });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /messages/:messageId/attachments/:index/url
   * A short-lived link to one attachment, for the people in that conversation
   * only (sender, receiver, or a member of the group).
   */
  async getAttachmentUrl(req, res, next) {
    try {
      const found = await findAttachmentForUser(req.params.messageId, req.params.index, req.userId);
      if (found.status) {
        return res.status(found.status).json({ message: ATTACHMENT_REFUSALS[found.status], statuscode: found.status });
      }
      const { attachment } = found;

      const key = attachmentKeyFromUrl(attachment.url);
      // Local-disk uploads (development) are served as they are.
      const url = key
        ? await storageClient.getPresignedUrl({ key, expiresIn: 300 })
        : attachment.url;

      res.json({
        message: 'Attachment link ready',
        statuscode: 200,
        data: { url, originalName: attachment.originalName, mimeType: attachment.mimeType },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /messages/:messageId/attachments/:index/file
   * The attachment's bytes, for the same people as getAttachmentUrl. The app
   * downloads through this (with its login) and opens the file on the phone.
   * A link was not enough: in mock storage it is a /mock-s3 path that only
   * the API serves, and on the domain the app opens it reached the website's
   * 404 page.
   */
  async streamAttachment(req, res, next) {
    try {
      const found = await findAttachmentForUser(req.params.messageId, req.params.index, req.userId);
      if (found.status) {
        return res.status(found.status).json({ message: ATTACHMENT_REFUSALS[found.status], statuscode: found.status });
      }
      const { attachment } = found;
      const key = attachmentKeyFromUrl(attachment.url);
      if (!key) {
        return res.status(404).json({ message: ATTACHMENT_REFUSALS[404], statuscode: 404 });
      }
      let stream;
      try {
        stream = await storageClient.getStream({ key });
      } catch (err) {
        logger.error('Chat attachment read failed', { error: err.message, code: err.code });
        const status = err.status === 404 || err.code === 'OBJECT_NOT_FOUND' ? 404 : 502;
        return res.status(status).json({ message: status === 404 ? ATTACHMENT_REFUSALS[404] : 'Could not read the attachment', statuscode: status });
      }
      // Percent-encoded (RFC 6266 filename*), so quotes, line breaks or
      // non-Latin characters in a file name cannot break the header.
      const name = encodeURIComponent(String(attachment.originalName || 'attachment'));
      res.setHeader('Content-Type', attachment.mimeType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${name}`);
      res.setHeader('Cache-Control', 'private, no-store');
      stream.on('error', (err) => {
        logger.error('Chat attachment stream failed', { error: err.message });
        if (!res.headersSent) res.status(502).end(); else res.end();
      });
      stream.pipe(res);
    } catch (error) {
      next(error);
    }
  }

  async sendMessage(req, res, next) {
    try {
      const { receiverId, content, attachments = [] } = req.body;
      const userId = req.userId;
      const websocketManager = require('../service/websocket.manager');
      const receiverOnline = typeof websocketManager.isUserOnline === 'function'
        ? websocketManager.isUserOnline(receiverId)
        : false;

      const message = await messageService.sendMessage(
        userId,
        receiverId,
        content,
        attachments,
        {
          ...buildHoaChatOptions(req),
          deliveredAt: receiverOnline ? ClockService.now() : null,
        }
      );

      // Emit via WebSocket to receiver and sender for real-time sync
      emitRealtimeMessage(message);
      if (receiverOnline && message?.deliveredAt) {
        websocketManager.emitToUser?.(userId, 'message_delivered', {
          messageIds: [String(message._id)],
          deliveredAt: message.deliveredAt,
        });
      }

      res.json({ message: 'Message sent successfully', statuscode: 200, data: message });
    } catch (error) {
      next(error);
    }
  }

  async getUnreadCount(req, res, next) {
    try {
      const userId = req.userId;
      const count = await messageService.getUnreadCount(userId);

      res.json({ message: 'Unread count retrieved successfully', statuscode: 200, data: { count } });
    } catch (error) {
      next(error);
    }
  }

  async uploadAttachment(req, res, next) {
    try {
      const { receiverId, content } = req.body;
      const userId = req.userId;

      if (!receiverId) {
        return res.status(400).json({ message: 'Receiver ID is required', statuscode: 400 });
      }

      const attachments = [];
      for (const file of (req.files || [])) {
        const originalName = file.originalname || file.filename || 'attachment';
        const contentType = file.mimetype || 'application/octet-stream';
        const key = storageClient.getKey
          ? storageClient.getKey('message', originalName, userId)
          : `Messaging/${userId}/${Date.now()}-${originalName}`;

        try {
          const uploadResult = await storageClient.upload({
            localFilePath: file.path,
            key,
            contentType,
          });
          attachments.push({
            filename: file.filename,
            originalName,
            mimeType: contentType,
            size: file.size,
            url: uploadResult.Location || `/uploads/message-attachments/${file.filename}`,
          });
        } catch (err) {
          logger.error('Message attachment upload failed', { error: err.message, userId });
          try { if (file.path && fs.existsSync(file.path)) await fs.promises.unlink(file.path); } catch (e) { /* ignore */ }
          return res.status(502).json({ message: err.message || 'Attachment upload failed', statuscode: 502 });
        }
      }

      const message = await messageService.sendMessage(
        userId,
        receiverId,
        content || '',
        attachments,
        {
          ...buildHoaChatOptions(req),
          deliveredAt: (() => {
            const websocketManager = require('../service/websocket.manager');
            return typeof websocketManager.isUserOnline === 'function' && websocketManager.isUserOnline(receiverId)
              ? ClockService.now()
              : null;
          })(),
        }
      );

      // Emit via WebSocket to receiver and sender for real-time sync
      emitRealtimeMessage(message);

      res.json({ message: 'Message sent successfully', statuscode: 200, data: message });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new MessageController();
module.exports.uploadAttachments = uploadAttachments;
