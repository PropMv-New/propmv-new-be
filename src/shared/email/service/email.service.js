/**
 * ------------------------------------------------------------------
 * File: email.service.js
 * Module: Src Shared Email Service
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * email.controller
 * ------------------------------------------------------------------
 */

const Email = require('../model/email.model');
const User = require('../../modules/users/models/user.model');
const { resolveUserRoleName } = require('../../../common/helpers/companyRoleHelper');
const { ClockService } = require('../../../common/date');
const { encryptEmailField, decryptEmailField } = require('../../../common/helpers/cryptoHelper');

/**
 * EmailService
 *
 * Represents the Email Service controller/model class.
 */
class EmailService {
  async getEmailContacts(userId, options = {}) {
    const { search = '', limit = 100 } = options;
    const user = await User.findOne({ _id: userId, isDeleted: { $ne: true } })
      .select('companyId companyRoleId landlordId landlord_id')
      .lean();
    if (!user) throw new Error('User not found');

    const roleName = String((await resolveUserRoleName(user)) || '').toLowerCase();
    const searchText = String(search || '').trim();
    const maxLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
    const toRegex = searchText ? new RegExp(searchText, 'i') : null;

    if (roleName === 'tenant') {
      const landlordRef = user.landlordId || user.landlord_id;
      if (!landlordRef) return [];
      const landlord = await User.findOne({
        _id: landlordRef,
        isDeleted: { $ne: true },
      }).select('firstName lastName email phone');
      if (!landlord) return [];

      const fullName = `${landlord.firstName || ''} ${landlord.lastName || ''}`.trim();
      if (toRegex && !toRegex.test(fullName) && !toRegex.test(String(landlord.email || ''))) {
        return [];
      }
      return [{
        _id: landlord._id,
        firstName: landlord.firstName || '',
        lastName: landlord.lastName || '',
        email: landlord.email || '',
        phone: landlord.phone || '',
        type: 'landlord',
      }];
    }

    if (roleName === 'landlord') {
      const query = {
        isDeleted: { $ne: true },
        $or: [
          { landlordId: user._id },
          { landlord_id: user._id },
        ],
      };
      if (toRegex) {
        query.$and = [{
          $or: [
            { firstName: toRegex },
            { lastName: toRegex },
            { email: toRegex },
          ],
        }];
      }

      const tenants = await User.find(query)
        .select('firstName lastName email phone')
        .sort({ firstName: 1, lastName: 1, email: 1 })
        .limit(maxLimit);

      return tenants.map((tenant) => ({
        _id: tenant._id,
        firstName: tenant.firstName || '',
        lastName: tenant.lastName || '',
        email: tenant.email || '',
        phone: tenant.phone || '',
        type: 'tenant',
      }));
    }

    return [];
  }

  async assertCanEmailWith(userId, otherUserId) {
    if (!otherUserId) throw new Error('Receiver is required');
    if (String(userId) === String(otherUserId)) {
      throw new Error('You cannot email yourself');
    }

    const contacts = await this.getEmailContacts(userId, { limit: 500 });
    const allowed = contacts.some((c) => String(c._id) === String(otherUserId));
    if (!allowed) {
      const err = new Error('You are not allowed to email this user');
      err.status = 403;
      throw err;
    }
  }

  async getEmailList(userId) {
    const emailContacts = await this.getEmailContacts(userId, { limit: 500 });

    const emailsWithUnread = await Promise.all(
      emailContacts.map(async (contact) => {
        const lastEmail = await Email.findOne({
          $or: [
            { senderId: userId, receiverId: contact._id },
            { senderId: contact._id, receiverId: userId }
          ],
          isDeleted: { $ne: true }
        })
          .sort({ createdAt: -1 })
          .populate('senderId', 'firstName lastName');

        if (lastEmail) {
          lastEmail.subject = decryptEmailField(lastEmail.subject);
          lastEmail.content = decryptEmailField(lastEmail.content);
        }

        const unreadCount = await Email.countDocuments({
          senderId: contact._id,
          receiverId: userId,
          isRead: false,
          isDeleted: { $ne: true }
        });

        return {
          user: contact,
          lastEmail: lastEmail,
          unreadCount
        };
      })
    );

    return emailsWithUnread.sort((a, b) => {
      const aTime = a.lastEmail?.createdAt || 0;
      const bTime = b.lastEmail?.createdAt || 0;
      return bTime - aTime;
    });
  }

  async getEmailThread(userId, otherUserId, page = 1, limit = 50) {
    await this.assertCanEmailWith(userId, otherUserId);
    const skip = (page - 1) * limit;

    const emails = await Email.find({
      $or: [
        { senderId: userId, receiverId: otherUserId },
        { senderId: otherUserId, receiverId: userId }
      ],
      isDeleted: { $ne: true }
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('senderId', 'firstName lastName email')
      .populate('receiverId', 'firstName lastName email');

    emails.forEach((email) => {
      email.subject = decryptEmailField(email.subject);
      email.content = decryptEmailField(email.content);
    });

    const total = await Email.countDocuments({
      $or: [
        { senderId: userId, receiverId: otherUserId },
        { senderId: otherUserId, receiverId: userId }
      ],
      isDeleted: { $ne: true }
    });

    return {
      emails: emails.reverse(),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };
  }

  async sendEmail(senderId, receiverId, subject, content) {
    await this.assertCanEmailWith(senderId, receiverId);
    const newEmail = await Email.create({
      senderId,
      receiverId,
      subject: encryptEmailField(subject),
      content: encryptEmailField(content),
    });

    const populated = await Email.findOne({ _id: newEmail._id, isDeleted: { $ne: true } })
      .populate('senderId', 'firstName lastName email')
      .populate('receiverId', 'firstName lastName email');
    if (populated) {
      populated.subject = decryptEmailField(populated.subject);
      populated.content = decryptEmailField(populated.content);
    }
    return populated;
  }

  async markAsRead(userId, emailIds) {
    await Email.updateMany(
      { _id: { $in: emailIds }, receiverId: userId, isDeleted: { $ne: true } },
      { isRead: true, readAt: ClockService.now() }
    );
    const updated = await Email.find({
      _id: { $in: emailIds },
      receiverId: userId,
      isDeleted: { $ne: true }
    }).populate('senderId', 'firstName lastName email')
      .populate('receiverId', 'firstName lastName email');
    updated.forEach((email) => {
      email.subject = decryptEmailField(email.subject);
      email.content = decryptEmailField(email.content);
    });
    return updated;
  }

  async deleteEmail(emailId, userId) {
    const email = await Email.findOne({ _id: emailId, senderId: userId, isDeleted: { $ne: true } });
    if (!email) throw new Error('Email not found or unauthorized');
    
    email.isDeleted = true;
    await email.save();
    return email;
  }

  async getUnreadCount(userId) {
    return await Email.countDocuments({
      receiverId: userId,
      isRead: false,
      isDeleted: { $ne: true }
    });
  }
}

module.exports = new EmailService();
