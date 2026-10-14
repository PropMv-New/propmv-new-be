/**
 * ------------------------------------------------------------------
 * File: supportChatController.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for supportChatController.
 *
 * Used By:
 * supportChat.routes
 * ------------------------------------------------------------------
 */

const supportChatService = require('../service/supportChatService');
const { successResponse, errorResponse } = require('../../../../../common/helpers/responseHelper');

/**
 * SupportChatController
 *
 * Represents the Support Chat Controller controller/model class.
 */
class SupportChatController {
  async initChat(req, res) {
    try {
      const { userId, hoaId } = req.user;
      const chat = await supportChatService.createOrGetChat(userId, hoaId);
      return successResponse(res, chat, 'Chat initialized successfully');
    } catch (error) {
      return errorResponse(res, error.message);
    }
  }

  async sendMessage(req, res) {
    try {
      const { chatId, text } = req.body;
      const chat = await supportChatService.sendMessage(chatId, text, 'user');
      
      // Auto-response simulation (replace with real support logic)
      setTimeout(async () => {
        await supportChatService.sendMessage(
          chatId, 
          "Thanks for your message! Our team will respond shortly.", 
          'support'
        );
      }, 1000);

      return successResponse(res, chat, 'Message sent successfully');
    } catch (error) {
      return errorResponse(res, error.message);
    }
  }

  async getChatHistory(req, res) {
    try {
      const { userId } = req.user;
      const chats = await supportChatService.getChatHistory(userId);
      return successResponse(res, chats, 'Chat history retrieved successfully');
    } catch (error) {
      return errorResponse(res, error.message);
    }
  }

  async closeChat(req, res) {
    try {
      const { chatId } = req.params;
      const chat = await supportChatService.closeChat(chatId);
      return successResponse(res, chat, 'Chat closed successfully');
    } catch (error) {
      return errorResponse(res, error.message);
    }
  }
}

module.exports = new SupportChatController();
