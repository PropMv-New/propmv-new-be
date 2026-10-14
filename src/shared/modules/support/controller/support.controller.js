const logger = require('../../../../common/logger');
const { success, error } = require('../../../../common/helpers/responseHelper');
const { submitSupportTicket } = require('../services/supportTicket.service');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_MESSAGE_LENGTH = 5000;
const MAX_TOPIC_LENGTH = 100;

async function submitContactRequest(req, res) {
  try {
    const { name, email, phone, topic, message } = req.body || {};

    const trimmedName = String(name || '').trim();
    const trimmedEmail = String(email || '').trim();
    const trimmedPhone = String(phone || '').trim();
    const trimmedTopic = String(topic || '').trim().slice(0, MAX_TOPIC_LENGTH);
    const trimmedMessage = String(message || '').trim();

    if (!trimmedName) {
      return error(res, 'Name is required', 400);
    }
    if (!trimmedEmail || !EMAIL_REGEX.test(trimmedEmail)) {
      return error(res, 'A valid email is required', 400);
    }
    if (!trimmedMessage) {
      return error(res, 'Message is required', 400);
    }
    if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
      return error(res, `Message must be under ${MAX_MESSAGE_LENGTH} characters`, 400);
    }

    const roleName =
      typeof req.user?.role === 'object' ? req.user.role?.name : req.user?.role;

    const ticket = {
      timestamp: new Date().toISOString(),
      name: trimmedName,
      email: trimmedEmail,
      phone: trimmedPhone,
      topic: trimmedTopic,
      message: trimmedMessage,
      role: roleName || '',
      userId: req.userId || '',
    };

    await submitSupportTicket(ticket);

    return success(res, null, "Your request has been received. We'll get back to you soon.");
  } catch (err) {
    logger.error('[Support] submitContactRequest failed:', err.message);
    return error(res, err.message || 'Failed to submit support request', 500);
  }
}

module.exports = { submitContactRequest };
