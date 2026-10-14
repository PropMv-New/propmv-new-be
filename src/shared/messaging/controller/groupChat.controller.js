const groupChatService = require('../service/groupChat.service');
const messageService = require('../service/message.service');
const { buildContactsOptionsFromRequest } = require('../../../common/services/contacts.service');
const { ClockService } = require('../../../common/date');

function buildHoaChatOptions(req) {
  return buildContactsOptionsFromRequest(req);
}

function emitGroupMessage(messageDoc) {
  const websocketManager = require('../service/websocket.manager');
  if (websocketManager.emitGroupMessage) {
    websocketManager.emitGroupMessage(messageDoc);
  }
}

function emitGroupReadReceipts(readEvents) {
  const websocketManager = require('../service/websocket.manager');
  const io = websocketManager && websocketManager.io;
  if (!io || !Array.isArray(readEvents) || !readEvents.length) return;

  readEvents.forEach((event) => {
    const payload = {
      messageId: event.messageId,
      readAt: event.readAt || ClockService.now(),
      groupId: event.groupId,
    };
    if (event.senderId) {
      websocketManager.emitToUser?.(event.senderId, 'message_read_receipt', payload);
    }
  });
}

class GroupChatController {
  async getUserGroups(req, res, next) {
    try {
      const userId = req.userId;
      const groups = await groupChatService.getUserGroups(userId);
      res.json({
        message: 'Groups retrieved successfully',
        statuscode: 200,
        data: groups,
      });
    } catch (error) {
      next(error);
    }
  }

  async createGroup(req, res, next) {
    try {
      const userId = req.userId;
      const { name, memberIds = [] } = req.body;
      const options = buildHoaChatOptions(req);

      const group = await groupChatService.createGroup(userId, name, memberIds, options);

      res.status(201).json({
        message: 'Group created successfully',
        statuscode: 201,
        data: group,
      });
    } catch (error) {
      next(error);
    }
  }

  async getGroup(req, res, next) {
    try {
      const { groupId } = req.params;
      const userId = req.userId;

      await groupChatService.assertIsGroupMember(groupId, userId);
      const group = await groupChatService.populateGroup(groupId);

      res.json({
        message: 'Group retrieved successfully',
        statuscode: 200,
        data: group,
      });
    } catch (error) {
      next(error);
    }
  }

  async addMembers(req, res, next) {
    try {
      const { groupId } = req.params;
      const { memberIds = [] } = req.body;
      const userId = req.userId;

      const group = await groupChatService.addMembers(
        groupId,
        userId,
        memberIds,
        buildHoaChatOptions(req)
      );

      const websocketManager = require('../service/websocket.manager');
      if (websocketManager.refreshUserGroupRooms) {
        memberIds.forEach((memberId) => {
          websocketManager.refreshUserGroupRooms(memberId).catch(() => undefined);
        });
      }

      res.json({
        message: 'Members added successfully',
        statuscode: 200,
        data: group,
      });
    } catch (error) {
      next(error);
    }
  }

  async getGroupConversation(req, res, next) {
    try {
      const { groupId } = req.params;
      const { page = 1, limit = 50 } = req.query;
      const userId = req.userId;

      const result = await messageService.getGroupConversation(
        userId,
        groupId,
        parseInt(page, 10),
        parseInt(limit, 10)
      );

      res.json({
        message: 'Group conversation retrieved successfully',
        statuscode: 200,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async sendGroupMessage(req, res, next) {
    try {
      const { groupId, content, attachments = [] } = req.body;
      const userId = req.userId;
      const websocketManager = require('../service/websocket.manager');

      const message = await messageService.sendGroupMessage(
        userId,
        groupId,
        content,
        attachments,
        {
          isUserOnline: (memberId) => websocketManager.isUserOnline(memberId),
        }
      );

      emitGroupMessage(message);

      if (message?.allDelivered && message?.deliveredAt) {
        websocketManager.emitToUser?.(userId, 'message_delivered', {
          messageIds: [String(message._id)],
          deliveredAt: message.deliveredAt,
          groupId: String(groupId),
        });
      }

      res.json({
        message: 'Group message sent successfully',
        statuscode: 200,
        data: message,
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new GroupChatController();
module.exports.emitGroupReadReceipts = emitGroupReadReceipts;
