/**
 * ------------------------------------------------------------------
 * File: email.controller.js
 * Module: Src Shared Email Controller
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * email.routes
 * ------------------------------------------------------------------
 */

const emailService = require('../service/email.service');

/**
 * EmailController
 *
 * Represents the Email Controller controller/model class.
 */
class EmailController {
  async getEmailContacts(req, res, next) {
    try {
      const userId = req.userId;
      const { search = '', limit } = req.query || {};
      const contacts = await emailService.getEmailContacts(userId, { search, limit });
      res.json({ message: 'Email contacts retrieved successfully', statuscode: 200, data: contacts });
    } catch (error) {
      next(error);
    }
  }

  async getEmailList(req, res, next) {
    try {
      const userId = req.userId;
      const emails = await emailService.getEmailList(userId);
      res.json({ message: 'Email list retrieved successfully', statuscode: 200, data: emails });
    } catch (error) {
      next(error);
    }
  }

  async getEmailThread(req, res, next) {
    try {
      const { otherUserId } = req.params;
      const { page = 1, limit = 50 } = req.query;
      const userId = req.userId;

      const result = await emailService.getEmailThread(userId, otherUserId, parseInt(page), parseInt(limit));
      
      res.json({ message: 'Email thread retrieved successfully', statuscode: 200, data: result });
    } catch (error) {
      next(error);
    }
  }

  async sendEmail(req, res, next) {
    try {
      const { receiverId, subject, content } = req.body;
      const userId = req.userId;

      const email = await emailService.sendEmail(userId, receiverId, subject, content);
      
      res.json({ message: 'Email sent successfully', statuscode: 200, data: email });
    } catch (error) {
      next(error);
    }
  }

  async markAsRead(req, res, next) {
    try {
      const { emailIds } = req.body;
      const userId = req.userId;

      await emailService.markAsRead(userId, emailIds);
      
      res.json({ message: 'Emails marked as read', statuscode: 200, data: null });
    } catch (error) {
      next(error);
    }
  }

  async deleteEmail(req, res, next) {
    try {
      const { emailId } = req.params;
      const userId = req.userId;

      await emailService.deleteEmail(emailId, userId);
      
      res.json({ message: 'Email deleted successfully', statuscode: 200, data: null });
    } catch (error) {
      next(error);
    }
  }

  async getUnreadCount(req, res, next) {
    try {
      const userId = req.userId;
      const count = await emailService.getUnreadCount(userId);
      
      res.json({ message: 'Unread count retrieved successfully', statuscode: 200, data: { count } });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new EmailController();
