const GroupChat = require('../model/groupChat.model');
const Message = require('../model/message.model');
const User = require('../../modules/users/models/user.model');
const mongoose = require('mongoose');
const contactsService = require('../../../common/services/contacts.service');
const { ClockService } = require('../../../common/date');

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function toObjectIds(arr) {
  return (Array.isArray(arr) ? arr : []).map(toObjectId).filter(Boolean);
}

function uniqueStrings(ids) {
  return [...new Set((ids || []).map((id) => String(id)).filter(Boolean))];
}

class GroupChatService {
  async assertCanAddMembers(userId, memberIds, options = {}) {
    const contacts = await contactsService.getContacts(userId, '', {
      ...options,
      forGroupChat: true,
    });
    const allowedIds = new Set(contacts.map((c) => String(c._id || c.id)));
    const invalid = memberIds.filter((id) => !allowedIds.has(String(id)));
    if (invalid.length) {
      const err = new Error('One or more selected members are not allowed');
      err.status = 403;
      throw err;
    }
  }

  async assertIsGroupMember(groupId, userId) {
    const safeGroupId = toObjectId(groupId);
    const safeUserId = toObjectId(userId);
    if (!safeGroupId || !safeUserId) {
      throw Object.assign(new Error('Invalid ID'), { status: 400 });
    }
    const group = await GroupChat.findOne({
      _id: safeGroupId,
      isDeleted: { $ne: true },
      'members.userId': safeUserId,
    }).lean();
    if (!group) {
      const err = new Error('Group not found or you are not a member');
      err.status = 403;
      throw err;
    }
    return group;
  }

  async getMemberIds(groupId) {
    const group = await GroupChat.findOne({
      _id: toObjectId(groupId),
      isDeleted: { $ne: true },
    })
      .select('members')
      .lean();
    if (!group) return [];
    return (group.members || []).map((m) => String(m.userId));
  }

  async getUserGroupIds(userId) {
    const safeUserId = toObjectId(userId);
    if (!safeUserId) return [];
    const groups = await GroupChat.find({
      isDeleted: { $ne: true },
      'members.userId': safeUserId,
    })
      .select('_id')
      .lean();
    return groups.map((g) => String(g._id));
  }

  async createGroup(creatorId, name, memberIds = [], options = {}) {
    const trimmedName = String(name || '').trim();
    if (!trimmedName) {
      throw Object.assign(new Error('Group name is required'), { status: 400 });
    }

    const creatorStr = String(creatorId);
    const uniqueMemberIds = uniqueStrings(memberIds).filter((id) => id !== creatorStr);
    if (uniqueMemberIds.length === 0) {
      throw Object.assign(new Error('At least one other member is required'), { status: 400 });
    }

    await this.assertCanAddMembers(creatorId, uniqueMemberIds, options);

    const now = ClockService.now();
    const members = [
      { userId: toObjectId(creatorId), joinedAt: now, addedBy: toObjectId(creatorId) },
      ...uniqueMemberIds.map((id) => ({
        userId: toObjectId(id),
        joinedAt: now,
        addedBy: toObjectId(creatorId),
      })),
    ];

    const group = await GroupChat.create({
      name: trimmedName,
      createdBy: creatorId,
      hoaId: options.hoaId ? toObjectId(options.hoaId) : null,
      members,
    });

    return this.populateGroup(group._id);
  }

  async populateGroup(groupId) {
    const group = await GroupChat.findOne({
      _id: toObjectId(groupId),
      isDeleted: { $ne: true },
    })
      .populate('createdBy', 'firstName lastName email')
      .populate('members.userId', 'firstName lastName email')
      .lean();

    if (!group) return null;

    return {
      _id: group._id,
      name: group.name,
      createdBy: group.createdBy,
      hoaId: group.hoaId,
      memberCount: (group.members || []).length,
      members: (group.members || []).map((m) => ({
        _id: m.userId?._id || m.userId,
        firstName: m.userId?.firstName || '',
        lastName: m.userId?.lastName || '',
        email: m.userId?.email || '',
        joinedAt: m.joinedAt,
      })),
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
    };
  }

  async addMembers(groupId, requesterId, memberIds = [], options = {}) {
    await this.assertIsGroupMember(groupId, requesterId);
    const uniqueMemberIds = uniqueStrings(memberIds).filter((id) => id !== String(requesterId));
    if (!uniqueMemberIds.length) {
      throw Object.assign(new Error('No new members to add'), { status: 400 });
    }

    await this.assertCanAddMembers(requesterId, uniqueMemberIds, options);

    const group = await GroupChat.findOne({
      _id: toObjectId(groupId),
      isDeleted: { $ne: true },
    });
    if (!group) {
      throw Object.assign(new Error('Group not found'), { status: 404 });
    }

    const existing = new Set((group.members || []).map((m) => String(m.userId)));
    const toAdd = uniqueMemberIds.filter((id) => !existing.has(String(id)));
    if (!toAdd.length) {
      throw Object.assign(new Error('All selected users are already members'), { status: 400 });
    }

    const now = ClockService.now();
    toAdd.forEach((id) => {
      group.members.push({
        userId: toObjectId(id),
        joinedAt: now,
        addedBy: toObjectId(requesterId),
      });
    });
    await group.save();

    return this.populateGroup(group._id);
  }

  async getUserGroups(userId) {
    const safeUserId = toObjectId(userId);
    if (!safeUserId) return [];

    const groups = await GroupChat.find({
      isDeleted: { $ne: true },
      'members.userId': safeUserId,
    })
      .sort({ updatedAt: -1 })
      .lean();

    const groupIds = groups.map((g) => g._id);
    if (!groupIds.length) return [];

    const lastMessages = await Message.aggregate([
      {
        $match: {
          groupId: { $in: groupIds },
          isDeleted: { $ne: true },
        },
      },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$groupId',
          messageId: { $first: '$_id' },
          lastMessageAt: { $first: '$createdAt' },
        },
      },
    ]);

    const lastMessageIdByGroup = new Map(
      lastMessages.map((row) => [String(row._id), row.messageId])
    );

    const unreadCounts = await Message.aggregate([
      {
        $match: {
          groupId: { $in: groupIds },
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
      {
        $group: {
          _id: '$groupId',
          unreadCount: { $sum: 1 },
        },
      },
    ]);

    const unreadByGroup = new Map(
      unreadCounts.map((row) => [String(row._id), row.unreadCount || 0])
    );

    const lastMessageDocs = lastMessageIdByGroup.size
      ? await Message.find({ _id: { $in: [...lastMessageIdByGroup.values()] } })
        .populate('senderId', 'firstName lastName')
        .lean()
      : [];

    const lastMessageByGroup = new Map(
      lastMessageDocs.map((doc) => [String(doc.groupId), doc])
    );

    const populatedGroups = await Promise.all(
      groups.map(async (group) => {
        const populated = await this.populateGroup(group._id);
        const groupIdStr = String(group._id);
        const lastMessageDoc = lastMessageByGroup.get(groupIdStr);
        return {
          group: populated,
          lastMessage: lastMessageDoc || null,
          unreadCount: unreadByGroup.get(groupIdStr) || 0,
          lastMessageAt: lastMessageDoc?.createdAt || group.updatedAt,
        };
      })
    );

    return populatedGroups.sort(
      (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
    );
  }
}

module.exports = new GroupChatService();
