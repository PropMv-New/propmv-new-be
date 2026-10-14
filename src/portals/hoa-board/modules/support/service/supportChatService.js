/**
 * ------------------------------------------------------------------
 * File: supportChatService.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for supportChatService.
 *
 * Used By:
 * supportChatController
 * ------------------------------------------------------------------
 */

const SupportChat = require('../models/SupportChat');

/**
 * SupportChatService
 *
 * Represents the Support Chat Service controller/model class.
 */
class SupportChatService {
  async createOrGetChat(userId, hoaId) {
    let chat = await SupportChat.findOne({ 
      userId, 
      status: 'open' 
    }).sort({ createdAt: -1 });

    if (!chat) {
      chat = await SupportChat.create({
        userId,
        hoaId,
        messages: [{
          text: "Hi! How can we help you today?",
          sender: "support",
          timestamp: new Date()
        }]
      });
    }

    return chat;
  }

  async sendMessage(chatId, text, sender) {
    const chat = await SupportChat.findByIdAndUpdate(
      chatId,
      {
        $push: {
          messages: {
            text,
            sender,
            timestamp: new Date()
          }
        }
      },
      { new: true }
    );

    return chat;
  }

  async getChatHistory(userId) {
    return await SupportChat.find({ userId })
      .sort({ createdAt: -1 })
      .limit(10);
  }

  async closeChat(chatId) {
    return await SupportChat.findByIdAndUpdate(
      chatId,
      {
        status: 'closed',
        closedAt: new Date()
      },
      { new: true }
    );
  }
}

module.exports = new SupportChatService();
