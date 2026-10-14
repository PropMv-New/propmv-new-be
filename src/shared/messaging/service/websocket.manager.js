/**
 * ------------------------------------------------------------------
 * File: websocket.manager.js
 * Module: Src Shared Messaging Service
 *
 * Purpose:
 * Backend utility/module providing helper functions for websocket.manager.
 *
 * Used By:
 * server, message.controller
 * ------------------------------------------------------------------
 */
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const User = require('../../modules/users/models/user.model');
const { resolveUserRoleName } = require('../../../common/helpers/companyRoleHelper');
const { isHOABoardMemberRole } = require('../../../common/helpers/hoaBoardRole');
const { isHOAOwnerRole } = require('../../../common/helpers/hoaOwnerRole');
const messageService = require('./message.service');
const groupChatService = require('./groupChat.service');
const logger = require('../../../common/logger');
const { ClockService } = require('../../../common/date');
const { resolveCorsOrigins } = require('../../../config/corsOrigins');

/**
 * is Allowed Messaging Role
 *
 * Performs logic operations for isAllowedMessagingRole.
 *
 * @param roleName - Request/input argument
 * @returns Operations result
 */
function isAllowedMessagingRole(roleName) {
  const n = String(roleName || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (n === 'landlord' || n === 'tenant') return true;
  if (isHOABoardMemberRole(roleName) || isHOAOwnerRole(roleName)) return true;
  return false;
}

/**
 * build Socket Hoa Options
 *
 * Performs logic operations for buildSocketHoaOptions.
 *
 * @param socket - Request/input argument
 * @param data - Request/input argument
 * @returns Operations result
 */
function buildSocketHoaOptions(socket, data = {}) {
  const hoaId = data?.hoaId || socket.hoaId || null;
  if (!hoaId && !socket.isHOAUser) return {};
  const options = {};
  if (socket.isHOAUser || hoaId) {
    options.isHOA = true;
  }
  if (hoaId) {
    options.hoaId = String(hoaId).trim();
  }
  return options;
}

/**
 * to Room Id
 *
 * Performs logic operations for toRoomId.
 *
 * @param userId - Request/input argument
 * @returns Operations result
 */
function toRoomId(userId) {
  return String(userId || '');
}

function toGroupRoomId(groupId) {
  return `group:${String(groupId || '')}`;
}

/**
 * WebSocketManager
 *
 * Represents the Web Socket Manager controller/model class.
 */
class WebSocketManager {
  constructor() {
    this.io = null;
    /** @type {Map<string, Set<string>>} userId → socket ids */
    this.onlineUsers = new Map();
  }

  isUserOnline(userId) {
    const set = this.onlineUsers.get(toRoomId(userId));
    return !!(set && set.size > 0);
  }

  trackOnline(userId, socketId) {
    const key = toRoomId(userId);
    if (!key) return;
    if (!this.onlineUsers.has(key)) this.onlineUsers.set(key, new Set());
    this.onlineUsers.get(key).add(socketId);
  }

  trackOffline(userId, socketId) {
    const key = toRoomId(userId);
    const set = this.onlineUsers.get(key);
    if (!set) return false;
    set.delete(socketId);
    if (set.size === 0) {
      this.onlineUsers.delete(key);
      return true; // fully offline
    }
    return false;
  }

  emitToUser(userId, eventName, payload) {
    const room = toRoomId(userId);
    if (!this.io || !room) return;
    this.io.to(room).emit(eventName, payload);
  }

  emitMessageToParticipants(messageDoc) {
    if (!this.io || !messageDoc) return;

    if (messageDoc.groupId) {
      this.emitGroupMessage(messageDoc);
      return;
    }

    const receiverRoom = toRoomId(messageDoc.receiverId?._id || messageDoc.receiverId);
    const senderRoom = toRoomId(messageDoc.senderId?._id || messageDoc.senderId);
    // Single canonical event + alias for older clients
    if (receiverRoom) {
      this.io.to(receiverRoom).emit('receive_message', messageDoc);
      this.io.to(receiverRoom).emit('message', messageDoc);
    }
    if (senderRoom) {
      this.io.to(senderRoom).emit('receive_message', messageDoc);
      this.io.to(senderRoom).emit('message', messageDoc);
    }
  }

  emitGroupMessage(messageDoc) {
    if (!this.io || !messageDoc) return;
    const groupId = messageDoc.groupId?._id || messageDoc.groupId;
    const groupRoom = toGroupRoomId(groupId);
    const senderRoom = toRoomId(messageDoc.senderId?._id || messageDoc.senderId);

    if (groupRoom) {
      this.io.to(groupRoom).emit('receive_message', messageDoc);
      this.io.to(groupRoom).emit('message', messageDoc);
    }
    // Also emit to sender's personal room if not in group room yet
    if (senderRoom) {
      this.io.to(senderRoom).emit('receive_message', messageDoc);
      this.io.to(senderRoom).emit('message', messageDoc);
    }
  }

  async joinUserGroupRooms(socket, userId) {
    try {
      const groupIds = await groupChatService.getUserGroupIds(userId);
      groupIds.forEach((groupId) => {
        socket.join(toGroupRoomId(groupId));
      });
    } catch (err) {
      logger.error('Failed to join group rooms:', err?.message || err);
    }
  }

  async refreshUserGroupRooms(userId) {
    if (!this.io) return;
    const groupIds = await groupChatService.getUserGroupIds(userId);
    const sockets = await this.io.in(toRoomId(userId)).fetchSockets();
    sockets.forEach((socket) => {
      groupIds.forEach((groupId) => {
        socket.join(toGroupRoomId(groupId));
      });
    });
  }

  initialize(server) {
    const { origins, allowAll, isProdLike } = resolveCorsOrigins();
    // Mirror HTTP CORS: allow configured portals; fall back to * only outside prod
    // when no origins are configured (local dev).
    const socketCorsOrigin =
      allowAll || (!isProdLike && origins.length === 0) ? '*' : origins;

    this.io = new Server(server, {
      cors: {
        origin: socketCorsOrigin,
        credentials: true,
      },
      path: '/socket.io/',
      transports: ['polling', 'websocket'],
    });

    logger.info('WebSocket server initialized on path: /socket.io/', {
      corsOriginCount: Array.isArray(socketCorsOrigin) ? socketCorsOrigin.length : 1,
    });

    this.io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth.token || socket.handshake.query.token;
        if (!token) {
          return next(new Error('Authentication required'));
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.sub)
          .select('companyId companyRoleId isDeleted landlordId landlord_id hoaInfo')
          .lean();

        if (!user || user.isDeleted) {
          return next(new Error('Invalid user'));
        }

        const roleName = await resolveUserRoleName(user);
        if (!isAllowedMessagingRole(roleName)) {
          return next(new Error('Unauthorized role'));
        }

        const handshakeHoaId =
          socket.handshake.auth?.hoaId ||
          socket.handshake.query?.hoaId ||
          user.hoaInfo?.hoaId ||
          null;

        socket.userId = String(decoded.sub);
        socket.userRole = roleName;
        socket.landlordId = user.landlordId || user.landlord_id || null;
        socket.isHOAUser = isHOABoardMemberRole(roleName) || isHOAOwnerRole(roleName);
        socket.hoaId = handshakeHoaId ? String(handshakeHoaId).trim() : null;
        next();
      } catch (error) {
        next(new Error('Authentication failed: ' + error.message));
      }
    });

    this.io.on('connection', async (socket) => {
      const userId = String(socket.userId);
      socket.join(userId);
      this.trackOnline(userId, socket.id);
      await this.joinUserGroupRooms(socket, userId);

      socket.emit('connected', { userId });

      // Announce presence (only when first connection for this user)
      if ((this.onlineUsers.get(userId)?.size || 0) === 1) {
        socket.broadcast.emit('user_online', userId);
      }

      // Deliver pending inbox messages now that receiver is online
      try {
        const delivered = await messageService.markPendingDeliveredForReceiver(userId);
        if (delivered.length) {
          const directBySender = new Map();
          const groupMessageIds = [];
          delivered.forEach((row) => {
            if (row.isGroup) {
              groupMessageIds.push(row.messageId);
            } else {
              if (!directBySender.has(row.senderId)) directBySender.set(row.senderId, []);
              directBySender.get(row.senderId).push(row.messageId);
            }
          });
          const deliveredAt = delivered[0].deliveredAt;
          directBySender.forEach((messageIds, senderId) => {
            this.emitToUser(senderId, 'message_delivered', {
              messageIds,
              deliveredAt,
            });
          });

          if (groupMessageIds.length) {
            const fullyDelivered = await messageService.getFullyDeliveredGroupMessages(groupMessageIds);
            fullyDelivered.forEach((event) => {
              this.emitToUser(event.senderId, 'message_delivered', {
                messageIds: [event.messageId],
                deliveredAt: event.deliveredAt,
              });
            });
          }
        }
      } catch (err) {
        logger.error('Failed to mark pending delivered:', err?.message || err);
      }

      socket.on('send_message', async (data) => {
        try {
          const { receiverId, groupId, content, attachments = [] } = data || {};
          if (!content && (!attachments || attachments.length === 0)) {
            return socket.emit('error', { message: 'Missing message content' });
          }

          if (groupId) {
            const populatedMessage = await messageService.sendGroupMessage(
              socket.userId,
              groupId,
              content || '',
              attachments,
              { isUserOnline: (memberId) => this.isUserOnline(memberId) }
            );

            this.emitGroupMessage(populatedMessage);

            if (populatedMessage?.allDelivered && populatedMessage?.deliveredAt) {
              this.emitToUser(socket.userId, 'message_delivered', {
                messageIds: [String(populatedMessage._id)],
                deliveredAt: populatedMessage.deliveredAt,
                groupId: String(groupId),
              });
            }
            return;
          }

          if (!receiverId) {
            return socket.emit('error', { message: 'Missing required fields' });
          }

          const receiver = await User.findById(receiverId).select('_id isDeleted');
          if (!receiver || receiver.isDeleted) {
            return socket.emit('error', { message: 'Receiver not found' });
          }

          const receiverOnline = this.isUserOnline(receiverId);
          const populatedMessage = await messageService.sendMessage(
            socket.userId,
            receiverId,
            content || '',
            attachments,
            {
              ...buildSocketHoaOptions(socket, data),
              deliveredAt: receiverOnline ? ClockService.now() : null,
            }
          );

          this.emitMessageToParticipants(populatedMessage);

          if (receiverOnline && populatedMessage?.deliveredAt) {
            this.emitToUser(socket.userId, 'message_delivered', {
              messageIds: [String(populatedMessage._id)],
              deliveredAt: populatedMessage.deliveredAt,
            });
          }
        } catch (error) {
          logger.error(' send_message failed:', error && error.message ? error.message : error);
          socket.emit('error', { message: error?.message || 'Failed to send message' });
        }
      });

      const markReadHandler = async (data) => {
        try {
          const ids = Array.isArray(data?.messageIds)
            ? data.messageIds
            : data?.messageId
              ? [data.messageId]
              : [];
          if (ids.length === 0) {
            return socket.emit('error', { message: 'Missing message ids' });
          }
          const updatedMessages = await messageService.markAsRead(socket.userId, ids);

          // Direct message receipts
          updatedMessages.filter((m) => !m.groupId).forEach((messageDoc) => {
            const senderRoom = toRoomId(messageDoc.senderId?._id || messageDoc.senderId);
            const receiverRoom = toRoomId(messageDoc.receiverId?._id || messageDoc.receiverId);
            const payload = {
              messageId: String(messageDoc._id),
              readAt: messageDoc.readAt || ClockService.now(),
            };
            if (senderRoom) this.io.to(senderRoom).emit('message_read_receipt', payload);
            if (receiverRoom) this.io.to(receiverRoom).emit('message_read_receipt', payload);
          });

          // Group message receipts - notify sender when ALL members have read
          const groupMessageIds = updatedMessages
            .filter((m) => m.groupId)
            .map((m) => String(m._id));
          if (groupMessageIds.length) {
            const fullyRead = await messageService.getFullyReadGroupMessages(groupMessageIds);
            fullyRead.forEach((event) => {
              const msg = updatedMessages.find((m) => String(m._id) === event.messageId);
              const payload = {
                messageId: event.messageId,
                readAt: event.readAt,
                groupId: msg?.groupId?._id ? String(msg.groupId._id) : String(msg?.groupId || ''),
              };
              this.emitToUser(event.senderId, 'message_read_receipt', payload);
            });
          }
        } catch (error) {
          socket.emit('error', { message: 'Failed to mark as read' });
        }
      };

      socket.on('mark_read', markReadHandler);
      socket.on('mark_message_read', markReadHandler);

      socket.on('typing_start', (data) => {
        const otherUserId = data?.otherUserId;
        if (!otherUserId) return;
        this.emitToUser(otherUserId, 'typing_start', {
          userId,
          otherUserId: String(otherUserId),
        });
      });

      socket.on('typing_stop', (data) => {
        const otherUserId = data?.otherUserId;
        if (!otherUserId) return;
        this.emitToUser(otherUserId, 'typing_stop', {
          userId,
          otherUserId: String(otherUserId),
        });
      });

      socket.on('disconnect', () => {
        const becameOffline = this.trackOffline(userId, socket.id);
        socket.leave(userId);
        if (becameOffline) {
          socket.broadcast.emit('user_offline', userId);
        }
      });
    });
  }
}

module.exports = new WebSocketManager();
