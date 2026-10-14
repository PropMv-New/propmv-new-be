/**
 * ------------------------------------------------------------------
 * File: message.service.js
 * Module: Src Shared Messaging Service
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * message.controller, websocket.manager
 * ------------------------------------------------------------------
 */
const Message = require('../model/message.model');
const GroupChat = require('../model/groupChat.model');
const groupChatService = require('./groupChat.service');
const crypto = require('crypto');
const mongoose = require('mongoose');
const MaintenanceRequest = require('../../../shared/modules/maintenance/model/maintenanceRequest.model');
const HOAProperty = require('../../../portals/hoa-board/modules/property/model/property.model');

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function toObjectIds(arr) {
  return (Array.isArray(arr) ? arr : []).map(toObjectId).filter(Boolean);
}
const contactsService = require('../../../common/services/contacts.service');
const { ClockService } = require('../../../common/date');

const ENCRYPTION_PREFIX = 'enc:v1:';

/**
 * get Encryption Key
 *
 * Performs logic operations for getEncryptionKey.
 *
 * @returns Operations result
 */
function getEncryptionKey() {
  const secret = process.env.MESSAGE_ENCRYPTION_KEY || process.env.JWT_SECRET || '';
  if (!secret) return null;
  return crypto.createHash('sha256').update(String(secret)).digest();
}

/**
 * encrypt Message Content
 *
 * Performs logic operations for encryptMessageContent.
 *
 * @param plainText - Request/input argument
 * @returns Operations result
 */
function encryptMessageContent(plainText) {
  const text = String(plainText || '');
  if (!text) return '';
  const key = getEncryptionKey();
  if (!key) return text;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
  return `${ENCRYPTION_PREFIX}${payload}`;
}

/**
 * decrypt Message Content
 *
 * Performs logic operations for decryptMessageContent.
 *
 * @param cipherText - Request/input argument
 * @returns Operations result
 */
function decryptMessageContent(cipherText) {
  const text = String(cipherText || '');
  if (!text || !text.startsWith(ENCRYPTION_PREFIX)) return text;
  const key = getEncryptionKey();
  if (!key) return '';

  try {
    const payload = text.slice(ENCRYPTION_PREFIX.length);
    const [ivB64, authTagB64, encryptedB64] = payload.split(':');
    if (typeof ivB64 !== 'string' || typeof authTagB64 !== 'string' || typeof encryptedB64 !== 'string') return '';
    if (!ivB64 || !authTagB64 || !encryptedB64) return '';
    if (!/^[A-Za-z0-9+/=]+$/.test(ivB64) || !/^[A-Za-z0-9+/=]+$/.test(authTagB64) || !/^[A-Za-z0-9+/=]+$/.test(encryptedB64)) return '';
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const encrypted = Buffer.from(encryptedB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (_err) {
    return '';
  }
}

function computeGroupStatusFromReceipts(receipts = [], senderId) {
  const senderStr = String(senderId || '');
  const memberReceipts = (receipts || []).filter(
    (r) => String(r.userId?._id || r.userId) !== senderStr
  );
  if (!memberReceipts.length) {
    return { allDelivered: false, allRead: false };
  }
  const allDelivered = memberReceipts.every((r) => Boolean(r.deliveredAt));
  const allRead = memberReceipts.every((r) => Boolean(r.isRead));
  return { allDelivered, allRead };
}

function enrichGroupMessageResponse(messageDoc) {
  if (!messageDoc) return messageDoc;
  const json = typeof messageDoc.toObject === 'function'
    ? messageDoc.toObject()
    : { ...messageDoc };
  json.content = decryptMessageContent(json.content);

  if (json.groupId) {
    const senderId = json.senderId?._id || json.senderId;
    const { allDelivered, allRead } = computeGroupStatusFromReceipts(json.receipts, senderId);
    json.isGroupMessage = true;
    json.allDelivered = allDelivered;
    json.allRead = allRead;
    // Map aggregate status to top-level fields for tick rendering
    json.deliveredAt = allDelivered ? (json.deliveredAt || json.updatedAt || json.createdAt) : null;
    json.isRead = allRead;
    if (allRead) {
      const readTimes = (json.receipts || [])
        .filter((r) => r.isRead && r.readAt)
        .map((r) => new Date(r.readAt).getTime());
      if (readTimes.length) {
        json.readAt = new Date(Math.max(...readTimes));
      }
    }
  }

  return json;
}

/**
 * to Message Response
 *
 * Performs logic operations for toMessageResponse.
 *
 * @param messageDoc - Request/input argument
 * @returns Operations result
 */
function toMessageResponse(messageDoc) {
  if (!messageDoc) return messageDoc;
  if (messageDoc.groupId) {
    return enrichGroupMessageResponse(messageDoc);
  }
  const json = typeof messageDoc.toObject === 'function'
    ? messageDoc.toObject()
    : { ...messageDoc };
  json.content = decryptMessageContent(json.content);
  return json;
}

/**
 * normalize Contacts Options
 *
 * Performs logic operations for normalizeContactsOptions.
 *
 * @param options - Request/input argument
 * @returns Operations result
 */
function normalizeContactsOptions(options = {}) {
  const { search = '', limit = 100, isHOA = false, hoaId = null } = options;
  const searchText = String(search || '').trim();
  const maxLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
  const contactsOptions = {};
  if (isHOA || hoaId) {
    contactsOptions.isHOA = true;
    if (hoaId) {
      contactsOptions.hoaId = hoaId;
    }
  }
  if (options.hoaContext) contactsOptions.hoaContext = options.hoaContext;
  if (options.roleName) contactsOptions.roleName = options.roleName;
  if (options.authCompany) contactsOptions.authCompany = options.authCompany;
  if (options.user) contactsOptions.user = options.user;
  if (options.maintenanceRequestId) {
    contactsOptions.maintenanceRequestId = options.maintenanceRequestId;
  }
  if (options.forGroupChat) contactsOptions.forGroupChat = true;
  return { searchText, maxLimit, contactsOptions };
}

/**
 * MessageService
 *
 * Represents the Message Service controller/model class.
 */
class MessageService {
  async getAllowedChatContacts(userId, options = {}) {
    const { searchText, maxLimit, contactsOptions } = normalizeContactsOptions(options);
    const contacts = await contactsService.getContacts(userId, searchText, contactsOptions);
    return contacts.slice(0, maxLimit);
  }

  async hasExistingDirectConversation(userId, otherUserId) {
    const safeUserId = toObjectId(userId);
    const safeOtherUserId = toObjectId(otherUserId);
    if (!safeUserId || !safeOtherUserId) return false;
    const existing = await Message.exists({
      isDeleted: { $ne: true },
      groupId: null,
      $or: [
        { senderId: safeUserId, receiverId: safeOtherUserId },
        { senderId: safeOtherUserId, receiverId: safeUserId },
      ],
    });
    return Boolean(existing);
  }

  async assertCanChatWith(userId, otherUserId, options = {}) {
    if (!otherUserId) throw new Error('Receiver is required');
    if (String(userId) === String(otherUserId)) {
      throw new Error('You cannot message yourself');
    }

    const contacts = await this.getAllowedChatContacts(userId, { ...options, limit: 500 });
    const allowed = contacts.some((c) => String(c._id || c.id) === String(otherUserId));
    if (allowed) return;

    // Existing threads must stay open even if contact rules later tighten
    // (common for vendors: unread badge from a board member who isn't a ticket party).
    if (await this.hasExistingDirectConversation(userId, otherUserId)) return;

    const err = new Error('You are not allowed to chat with this user');
    err.status = 403;
    throw err;
  }

  async getConversation(userId, otherUserId, page = 1, limit = 50, options = {}) {
    await this.assertCanChatWith(userId, otherUserId, options);
    const safeUserId = toObjectId(userId);
    const safeOtherUserId = toObjectId(otherUserId);
    if (!safeUserId || !safeOtherUserId) throw Object.assign(new Error('Invalid user ID'), { status: 400 });
    const skip = (page - 1) * limit;

    const messages = await Message.find({
      $or: [
        { senderId: safeUserId, receiverId: safeOtherUserId },
        { senderId: safeOtherUserId, receiverId: safeUserId }
      ],
      isDeleted: { $ne: true }
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('senderId', 'firstName lastName email')
      .populate('receiverId', 'firstName lastName email');

    const total = await Message.countDocuments({
      $or: [
        { senderId: safeUserId, receiverId: safeOtherUserId },
        { senderId: safeOtherUserId, receiverId: safeUserId }
      ],
      isDeleted: { $ne: true }
    });

    return {
      messages: messages.reverse().map(toMessageResponse),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };
  }

  async getConversationList(userId, options = {}) {
    const directConversations = await this.getDirectConversationList(userId, options);
    const groupSummaries = await groupChatService.getUserGroups(userId);

    const groupConversations = groupSummaries.map((summary) => ({
      type: 'group',
      group: summary.group,
      lastMessage: summary.lastMessage ? toMessageResponse(summary.lastMessage) : null,
      unreadCount: summary.unreadCount || 0,
      lastMessageAt: summary.lastMessageAt,
    }));

    const directWithType = directConversations.map((conv) => ({
      type: 'direct',
      user: conv.user,
      lastMessage: conv.lastMessage,
      unreadCount: conv.unreadCount,
      lastMessageAt: conv.lastMessage?.createdAt || null,
    }));

    return [...directWithType, ...groupConversations].sort((a, b) => {
      const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return bTime - aTime;
    });
  }

  async getDirectConversationList(userId, options = {}) {
    const userObjectId = new mongoose.Types.ObjectId(String(userId));
    const baseMatch = {
      isDeleted: { $ne: true },
      groupId: null,
      $or: [{ senderId: userObjectId }, { receiverId: userObjectId }],
    };

    const partnerSummaries = await Message.aggregate([
      { $match: baseMatch },
      {
        $addFields: {
          partnerId: {
            $cond: [
              { $eq: ['$senderId', userObjectId] },
              '$receiverId',
              '$senderId',
            ],
          },
        },
      },
      {
        $group: {
          _id: '$partnerId',
          lastMessageAt: { $max: '$createdAt' },
          unreadCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$receiverId', userObjectId] },
                    { $ne: ['$isRead', true] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
      { $sort: { lastMessageAt: -1 } },
    ]);

    if (!partnerSummaries.length) {
      return [];
    }

    const partnerIds = partnerSummaries.map((row) => row._id);
    const lastMessages = await Message.aggregate([
      { $match: baseMatch },
      {
        $addFields: {
          partnerId: {
            $cond: [
              { $eq: ['$senderId', userObjectId] },
              '$receiverId',
              '$senderId',
            ],
          },
        },
      },
      { $match: { partnerId: { $in: partnerIds } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$partnerId',
          messageId: { $first: '$_id' },
        },
      },
    ]);

    const lastMessageIdByPartner = new Map(
      lastMessages.map((row) => [String(row._id), row.messageId])
    );
    const lastMessageDocs = await Message.find({
      _id: { $in: [...lastMessageIdByPartner.values()] },
    })
      .populate('senderId', 'firstName lastName')
      .lean();

    const lastMessageByPartner = new Map(
      lastMessageDocs.map((doc) => {
        const partnerId = String(doc.senderId?._id || doc.senderId) === String(userId)
          ? String(doc.receiverId?._id || doc.receiverId)
          : String(doc.senderId?._id || doc.senderId);
        return [partnerId, doc];
      })
    );

    const allContacts = await this.getAllowedChatContacts(userId, { ...options, limit: 500 });
    const contactById = new Map(
      allContacts.map((contact) => [String(contact._id || contact.id), contact])
    );

    // Keep existing threads visible even when the partner is outside the current
    // contact allow-list (vendor unread badge with empty chat list).
    const missingPartnerIds = partnerSummaries
      .map((row) => String(row._id || ''))
      .filter((id) => id && !contactById.has(id));
    if (missingPartnerIds.length) {
      try {
        const User = require('../../modules/users/models/user.model');
        const { resolveUserRoleName } = require('../../../common/helpers/companyRoleHelper');
        const { isVendorRole } = require('../../../common/helpers/hoaVendorRole');
        const missingObjectIds = missingPartnerIds.map(toObjectId).filter(Boolean);
        const users = missingObjectIds.length
          ? await User.find({
            _id: { $in: missingObjectIds },
            isDeleted: { $ne: true },
          })
            .select('firstName lastName email phone companyId companyRoleId')
            .lean()
          : [];

        await Promise.all(users.map(async (user) => {
          const id = String(user._id);
          let type = 'hoa_owner';
          try {
            const roleName = await resolveUserRoleName(user);
            const n = String(roleName || '').toLowerCase();
            if (isVendorRole(roleName)) type = 'vendor';
            else if (n.includes('board')) type = 'board_member';
            else if (n.includes('tenant')) type = 'tenant';
            else if (n.includes('landlord')) type = 'landlord';
            else if (n.includes('property manager')) type = 'property_manager';
            else if (n.includes('owner')) type = 'hoa_owner';
          } catch (_) {
            /* role label is best-effort for the inbox list */
          }
          const firstName = user.firstName || '';
          const lastName = user.lastName || '';
          contactById.set(id, {
            _id: user._id,
            id: user._id,
            firstName,
            lastName,
            name: `${firstName} ${lastName}`.trim() || user.email || 'User',
            email: user.email,
            phone: user.phone || '',
            type,
          });
        }));
      } catch (_) {
        /* fall through — partners still missing stay hidden */
      }
    }

    return partnerSummaries
      .map((summary) => {
        const partnerId = String(summary._id);
        const partner = contactById.get(partnerId);
        if (!partner) return null;

        const lastMessageDoc = lastMessageByPartner.get(partnerId);
        return {
          user: partner,
          lastMessage: lastMessageDoc ? toMessageResponse(lastMessageDoc) : null,
          unreadCount: summary.unreadCount || 0,
        };
      })
      .filter(Boolean);
  }

  async markAsRead(userId, messageIds) {
    const safeUserId = toObjectId(userId);
    const safeIds = toObjectIds(messageIds);
    if (!safeUserId || !safeIds.length) return [];

    // Direct messages
    await Message.updateMany(
      {
        _id: { $in: safeIds },
        receiverId: safeUserId,
        groupId: null,
        isDeleted: { $ne: true },
      },
      { isRead: true, readAt: ClockService.now() }
    );

    // Group messages - update per-user receipt
    const now = ClockService.now();
    const groupMessages = await Message.find({
      _id: { $in: safeIds },
      groupId: { $ne: null },
      isDeleted: { $ne: true },
      'receipts.userId': safeUserId,
    }).select('_id receipts senderId groupId');

    for (const msg of groupMessages) {
      const receipts = (msg.receipts || []).map((r) => {
        if (String(r.userId) === String(safeUserId)) {
          return { ...r.toObject?.() || r, isRead: true, readAt: now, deliveredAt: r.deliveredAt || now };
        }
        return r;
      });
      msg.receipts = receipts;
      await msg.save();
    }

    const updated = await Message.find({
      _id: { $in: safeIds },
      isDeleted: { $ne: true },
      $or: [
        { receiverId: safeUserId, groupId: null },
        { groupId: { $ne: null }, 'receipts.userId': safeUserId },
      ],
    })
      .populate('senderId', 'firstName lastName email')
      .populate('receiverId', 'firstName lastName email')
      .populate('groupId', 'name');

    return updated.map(toMessageResponse);
  }

  async deleteMessage(messageId, userId) {
    const safeMessageId = toObjectId(messageId);
    const safeUserId = toObjectId(userId);
    if (!safeMessageId || !safeUserId) throw Object.assign(new Error('Invalid ID'), { status: 400 });
    const message = await Message.findOne({ _id: safeMessageId, senderId: safeUserId, isDeleted: { $ne: true } });
    if (!message) throw new Error('Message not found or unauthorized');

    message.isDeleted = true;
    await message.save();
    return toMessageResponse(message);
  }

  async getUnreadCount(userId) {
    const safeUserId = toObjectId(userId);
    if (!safeUserId) return 0;

    const directUnread = await Message.countDocuments({
      receiverId: safeUserId,
      groupId: null,
      isRead: false,
      isDeleted: { $ne: true },
    });

    const groupUnreadResult = await Message.aggregate([
      {
        $match: {
          groupId: { $ne: null },
          isDeleted: { $ne: true },
          senderId: { $ne: safeUserId },
        },
      },
      { $unwind: '$receipts' },
      {
        $match: {
          'receipts.userId': safeUserId,
          'receipts.isRead': { $ne: true },
        },
      },
      { $count: 'count' },
    ]);

    const groupUnread = groupUnreadResult[0]?.count || 0;
    return directUnread + groupUnread;
  }

  async markAsDelivered(messageIds = []) {
    const ids = toObjectIds(messageIds);
    if (!ids.length) return [];
    const deliveredAt = ClockService.now();
    await Message.updateMany(
      {
        _id: { $in: ids },
        deliveredAt: null,
        isDeleted: { $ne: true },
      },
      { deliveredAt }
    );
    const updated = await Message.find({
      _id: { $in: ids },
      isDeleted: { $ne: true },
    })
      .populate('senderId', 'firstName lastName email')
      .populate('receiverId', 'firstName lastName email');
    return updated.map(toMessageResponse);
  }

  /**
   * Mark all undelivered inbox messages as delivered when a user comes online.
   */
  async markPendingDeliveredForReceiver(receiverId) {
    const safeReceiverId = toObjectId(receiverId);
    if (!safeReceiverId) return [];
    const deliveredAt = ClockService.now();

    // Direct messages
    const pendingDirect = await Message.find({
      receiverId: safeReceiverId,
      groupId: null,
      deliveredAt: null,
      isDeleted: { $ne: true },
    }).select('_id senderId groupId');

    const directIds = pendingDirect.map((m) => m._id);
    if (directIds.length) {
      await Message.updateMany({ _id: { $in: directIds } }, { deliveredAt });
    }

    // Group messages - update receipt for this user
    const pendingGroup = await Message.find({
      groupId: { $ne: null },
      isDeleted: { $ne: true },
      receipts: { $elemMatch: { userId: safeReceiverId, deliveredAt: null } },
    }).select('_id senderId groupId receipts');

    const groupDeliveryUpdates = [];
    for (const msg of pendingGroup) {
      let changed = false;
      const receipts = (msg.receipts || []).map((r) => {
        if (String(r.userId) === String(safeReceiverId) && !r.deliveredAt) {
          changed = true;
          return { ...r.toObject?.() || r, deliveredAt };
        }
        return r;
      });
      if (changed) {
        msg.receipts = receipts;
        const senderStr = String(msg.senderId);
        const memberReceipts = receipts.filter((r) => String(r.userId) !== senderStr);
        const allDelivered = memberReceipts.length > 0 && memberReceipts.every((r) => r.deliveredAt);
        if (allDelivered) {
          msg.deliveredAt = deliveredAt;
        }
        await msg.save();
        groupDeliveryUpdates.push({
          messageId: String(msg._id),
          senderId: String(msg.senderId),
          deliveredAt,
          allDelivered,
        });
      }
    }

    const directResults = pendingDirect.map((m) => ({
      messageId: String(m._id),
      senderId: String(m.senderId),
      deliveredAt,
      allDelivered: true,
      isGroup: false,
    }));

    return [...directResults, ...groupDeliveryUpdates.map((g) => ({ ...g, isGroup: true }))];
  }

  async sendMessage(senderId, receiverId, content, attachments = [], options = {}) {
    await this.assertCanChatWith(senderId, receiverId, options);
    const deliveredAt = options.deliveredAt === undefined ? null : options.deliveredAt;
    const newMessage = await Message.create({
      senderId,
      receiverId,
      content: encryptMessageContent(content),
      attachments,
      deliveredAt,
    });

    const populated = await Message.findById(newMessage._id)
      .populate('senderId', 'firstName lastName email')
      .populate('receiverId', 'firstName lastName email');
    return toMessageResponse(populated);
  }

  async getGroupConversation(userId, groupId, page = 1, limit = 50) {
    await groupChatService.assertIsGroupMember(groupId, userId);
    const safeGroupId = toObjectId(groupId);
    const safeUserId = toObjectId(userId);
    if (!safeGroupId || !safeUserId) {
      throw Object.assign(new Error('Invalid ID'), { status: 400 });
    }
    const skip = (page - 1) * limit;

    const messages = await Message.find({
      groupId: safeGroupId,
      isDeleted: { $ne: true },
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('senderId', 'firstName lastName email')
      .populate('groupId', 'name');

    const total = await Message.countDocuments({
      groupId: safeGroupId,
      isDeleted: { $ne: true },
    });

    return {
      messages: messages.reverse().map(toMessageResponse),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async sendGroupMessage(senderId, groupId, content, attachments = [], options = {}) {
    await groupChatService.assertIsGroupMember(groupId, senderId);
    const safeGroupId = toObjectId(groupId);
    const safeSenderId = toObjectId(senderId);
    if (!safeGroupId || !safeSenderId) {
      throw Object.assign(new Error('Invalid ID'), { status: 400 });
    }

    const group = await GroupChat.findOne({
      _id: safeGroupId,
      isDeleted: { $ne: true },
    }).select('members').lean();
    if (!group) {
      throw Object.assign(new Error('Group not found'), { status: 404 });
    }

    const memberIds = (group.members || [])
      .map((m) => String(m.userId))
      .filter((id) => id !== String(senderId));

    const onlineChecker = options.isUserOnline || (() => false);
    const now = ClockService.now();
    const receipts = memberIds.map((memberId) => ({
      userId: toObjectId(memberId),
      deliveredAt: onlineChecker(memberId) ? now : null,
      isRead: false,
      readAt: null,
    }));

    const allDelivered = receipts.length > 0 && receipts.every((r) => r.deliveredAt);

    const newMessage = await Message.create({
      senderId: safeSenderId,
      groupId: safeGroupId,
      content: encryptMessageContent(content),
      attachments,
      receipts,
      deliveredAt: allDelivered ? now : null,
    });

    const populated = await Message.findById(newMessage._id)
      .populate('senderId', 'firstName lastName email')
      .populate('groupId', 'name');

    return toMessageResponse(populated);
  }

  /**
   * After marking group messages read, return messages where all members have read (for sender notification).
   */
  async getFullyReadGroupMessages(messageIds) {
    const safeIds = toObjectIds(messageIds);
    if (!safeIds.length) return [];

    const messages = await Message.find({
      _id: { $in: safeIds },
      groupId: { $ne: null },
      isDeleted: { $ne: true },
    }).select('_id senderId receipts');

    return messages.filter((msg) => {
      const senderStr = String(msg.senderId);
      const memberReceipts = (msg.receipts || []).filter((r) => String(r.userId) !== senderStr);
      return memberReceipts.length > 0 && memberReceipts.every((r) => r.isRead);
    }).map((msg) => ({
      messageId: String(msg._id),
      senderId: String(msg.senderId),
      readAt: ClockService.now(),
    }));
  }

  /**
   * Check if group messages are now fully delivered after a member came online.
   */
  async getFullyDeliveredGroupMessages(messageIds) {
    const safeIds = toObjectIds(messageIds);
    if (!safeIds.length) return [];

    const messages = await Message.find({
      _id: { $in: safeIds },
      groupId: { $ne: null },
      isDeleted: { $ne: true },
    }).select('_id senderId receipts deliveredAt');

    return messages.filter((msg) => {
      const senderStr = String(msg.senderId);
      const memberReceipts = (msg.receipts || []).filter((r) => String(r.userId) !== senderStr);
      return memberReceipts.length > 0 && memberReceipts.every((r) => r.deliveredAt);
    }).map((msg) => ({
      messageId: String(msg._id),
      senderId: String(msg.senderId),
      deliveredAt: msg.deliveredAt || ClockService.now(),
    }));
  }

  async getChatContacts(userId, options = {}) {
    const contactsOptions = { ...options };
    if (options.forGroupChat) {
      contactsOptions.forGroupChat = true;
    }
    return this.getAllowedChatContacts(userId, contactsOptions);
  }
}

module.exports = new MessageService();
