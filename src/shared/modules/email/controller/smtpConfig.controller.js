/**
 * ------------------------------------------------------------------
 * File: smtpConfig.controller.js
 * Module: Email Module
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * email.routes
 * ------------------------------------------------------------------
 */

const smtpService = require('../service/smtp.service');
const imapService = require('../service/imap.service');
const EmailProviderDetector = require('../service/emailProviderDetector.service');
const EmailConfig = require('../model/emailConfig.model');
const logger = require('../../../../common/logger');
const { connectToDatabase } = require('../../../../database');
const { ClockService } = require('../../../../common/date');

const configureSmtp = async (req, res) => {
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;
    let { smtpHost, smtpPort, smtpUser, smtpPassword, fromName, imapHost, imapPort } = req.body;

    logger.info('📧 SMTP Configuration Request:', {
      userId,
      smtpUser,
      smtpHost,
      smtpPort
    });

    // Validate required fields
    if (!smtpUser || !smtpPassword) {
      return res.status(400).json({
        message: 'Missing required fields: smtpUser, smtpPassword',
        statuscode: 400
      });
    }

    // Auto-detect settings if not provided
    if (!smtpHost || !smtpPort) {
      logger.info('🔍 Auto-detecting email settings...');
      try {
        const detected = await EmailProviderDetector.detectSettings(smtpUser, smtpPassword);
        smtpHost = smtpHost || detected.smtpHost;
        smtpPort = smtpPort || detected.smtpPort;
        imapHost = imapHost || detected.imapHost;
        imapPort = imapPort || detected.imapPort;
        logger.info(`Auto-detected: ${smtpHost}:${smtpPort}`);
      } catch (error) {
        logger.error(' Auto-detection failed:', error.message);
        return res.status(400).json({
          message: error.message || 'Could not auto-detect email settings. Please use the Manual tab to enter your SMTP details.',
          statuscode: 400
        });
      }
    }

    // Verify SMTP credentials before saving
    try {
      logger.info(`🔐 Verifying SMTP credentials: ${smtpUser}`);
      const smtpVerification = await smtpService.verifyConfig(smtpHost, smtpPort, smtpUser, smtpPassword);

      // Verify IMAP if provided
      let imapVerification = null;
      if (imapHost) {
        try {
          imapVerification = await imapService.verifyImapConfig(imapHost, imapPort || 993, smtpUser, smtpPassword);
        } catch (error) {
          logger.info('⚠️ IMAP verification failed, continuing without IMAP');
        }
      }

      // Save configuration
      await EmailConfig.findOneAndUpdate(
        { userId, provider: 'smtp' },
        {
          userId,
          provider: 'smtp',
          smtpHost,
          smtpPort: parseInt(smtpPort),
          smtpUser,
          smtpPassword,
          fromName: fromName || smtpUser,
          imapHost: imapHost || null,
          imapPort: imapPort ? parseInt(imapPort) : 993,
          isActive: true,
          verifiedAt: ClockService.now()
        },
        { upsert: true, new: true }
      );

      logger.info(`Email configuration saved for ${smtpUser}`);
      res.json({
        message: 'Email configured and verified successfully',
        statuscode: 200,
        data: {
          smtp: smtpVerification,
          imap: imapVerification,
          detectedSettings: {
            smtpHost,
            smtpPort,
            imapHost,
            imapPort
          }
        }
      });
    } catch (err) {
      logger.error(' SMTP verification failed:', err.message);
      res.status(400).json({
        message: err.message || 'Failed to verify SMTP credentials',
        statuscode: 400
      });
    }
  } catch (err) {
    logger.error('Configure SMTP error:', err);
    res.status(400).json({
      message: err.message || 'Failed to configure SMTP',
      statuscode: 400
    });
  }
};

const testSmtp = async (req, res) => {
  try {
    await connectToDatabase();
    const { smtpHost, smtpPort, smtpUser, smtpPassword } = req.body;

    // Test without saving
    const result = await smtpService.verifyConfig(smtpHost, smtpPort, smtpUser, smtpPassword);

    res.json({
      message: 'SMTP test successful',
      statuscode: 200,
      data: result
    });
  } catch (err) {
    logger.error('Test SMTP error:', err);
    res.status(400).json({
      message: err.message || 'SMTP test failed',
      statuscode: 400
    });
  }
};

const getSmtpConfig = async (req, res) => {
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;

    const config = await EmailConfig.findOne({ userId, provider: 'smtp' });

    if (!config) {
      return res.json({
        message: 'No SMTP configuration found',
        statuscode: 200,
        data: null
      });
    }

    res.json({
      message: 'SMTP configuration retrieved',
      statuscode: 200,
      data: {
        smtpHost: config.smtpHost,
        smtpPort: config.smtpPort,
        smtpUser: config.smtpUser,
        fromName: config.fromName,
        isActive: config.isActive,
        verifiedAt: config.verifiedAt
      }
    });
  } catch (err) {
    logger.error('Get SMTP config error:', err);
    res.status(500).json({
      message: err.message || 'Failed to get SMTP configuration',
      statuscode: 500
    });
  }
};

const deleteSmtpConfig = async (req, res) => {
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;

    await EmailConfig.deleteOne({ userId, provider: 'smtp' });

    res.json({
      message: 'SMTP configuration deleted',
      statuscode: 200
    });
  } catch (err) {
    logger.error('Delete SMTP config error:', err);
    res.status(500).json({
      message: err.message || 'Failed to delete SMTP configuration',
      statuscode: 500
    });
  }
};

module.exports = {
  configureSmtp,
  testSmtp,
  getSmtpConfig,
  deleteSmtpConfig
};
