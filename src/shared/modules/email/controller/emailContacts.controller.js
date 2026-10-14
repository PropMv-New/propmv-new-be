/**
 * ------------------------------------------------------------------
 * File: emailContacts.controller.js
 * Module: Email Module
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * email.routes
 * ------------------------------------------------------------------
 */
const contactsService = require('../../../../common/services/contacts.service');
const logger = require('../../../../common/logger');
const { buildContactsOptionsFromRequest } = contactsService;

const getEmailContacts = async (req, res) => {
  try {
    const userId = req.userId || req.user?.id;
    const searchText = req.query.search || '';

    // Email compose expands vendor contacts to HOA board members + owners (messaging stays ticket-scoped).
    const options = buildContactsOptionsFromRequest(req, { contactPurpose: 'email' });
    const contacts = await contactsService.getContacts(userId, searchText, options);

    const roleName = options.roleName
      ? String(options.roleName).toLowerCase()
      : null;

    res.json({
      message: 'Email contacts fetched successfully',
      statuscode: 200,
      data: {
        userType: roleName,
        contacts
      }
    });
  } catch (err) {
    logger.error('Get email contacts error:', err);
    res.status(500).json({
      message: err.message || 'Failed to fetch email contacts',
      statuscode: 500
    });
  }
};

module.exports = {
  getEmailContacts
};
