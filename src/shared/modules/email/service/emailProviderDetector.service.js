/**
 * ------------------------------------------------------------------
 * File: emailProviderDetector.service.js
 * Module: Email Module
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * smtpConfig.controller
 * ------------------------------------------------------------------
 */

const nodemailer = require('nodemailer');
const logger = require('../../../../common/logger');

/**
 * EmailProviderDetector
 *
 * Represents the Email Provider Detector controller/model class.
 */
class EmailProviderDetector {
  // Common email provider configurations
  static PROVIDERS = {
    'gmail.com': {
      smtpHost: 'smtp.gmail.com',
      smtpPort: 587,
      imapHost: 'imap.gmail.com',
      imapPort: 993
    },
    'outlook.com': {
      smtpHost: 'smtp.office365.com',
      smtpPort: 587,
      imapHost: 'outlook.office365.com',
      imapPort: 993
    },
    'hotmail.com': {
      smtpHost: 'smtp.office365.com',
      smtpPort: 587,
      imapHost: 'outlook.office365.com',
      imapPort: 993
    },
    'yahoo.com': {
      smtpHost: 'smtp.mail.yahoo.com',
      smtpPort: 587,
      imapHost: 'imap.mail.yahoo.com',
      imapPort: 993
    },
    'zoho.com': {
      smtpHost: 'smtp.zoho.com',
      smtpPort: 587,
      imapHost: 'imap.zoho.com',
      imapPort: 993
    }
  };

  static extractDomain(email) {
    return email.split('@')[1]?.toLowerCase();
  }

  static async detectSettings(email, password) {
    const domain = this.extractDomain(email);

    logger.info(`\n🔍 Email Provider Detection for: ${email}`);
    logger.info(`   Domain: ${domain}`);

    // Check if it's a known provider - instant return
    if (this.PROVIDERS[domain]) {
      logger.info(`Found in known providers: ${domain}`);
      const provider = this.PROVIDERS[domain];

      // For Gmail and other OAuth providers, also verify credentials
      if (domain === 'gmail.com') {
        logger.info('   [Gmail detected] Testing credentials...');
        try {
          await this.testSmtp(provider.smtpHost, provider.smtpPort, email, password);
          logger.info('   Credentials verified');
          return provider;
        } catch (err) {
          logger.info(`    Credential test failed: ${err.message}`);
          // For Gmail, provide helpful message
          throw new Error('Gmail SMTP authentication failed. Please use an App Password (not your regular password). Get one at https://myaccount.google.com/apppasswords');
        }
      }

      return provider;
    }

    // Build all possible configurations to test in parallel
    const allConfigs = [
      // Most common: domain-based patterns (fastest for custom domains)
      { name: `smtp.${domain}:587`, smtpHost: `smtp.${domain}`, smtpPort: 587, imapHost: `imap.${domain}`, imapPort: 993 },
      { name: `mail.${domain}:587`, smtpHost: `mail.${domain}`, smtpPort: 587, imapHost: `mail.${domain}`, imapPort: 993 },
      // Common hosting providers
      { name: 'Hostinger', smtpHost: 'smtp.hostinger.com', smtpPort: 587, imapHost: 'imap.hostinger.com', imapPort: 993 },
      { name: 'Namecheap', smtpHost: 'mail.privateemail.com', smtpPort: 587, imapHost: 'mail.privateemail.com', imapPort: 993 },
      { name: 'GoDaddy', smtpHost: 'smtpout.secureserver.net', smtpPort: 587, imapHost: 'imap.secureserver.net', imapPort: 993 },
      // Alternative ports
      { name: `smtp.${domain}:465`, smtpHost: `smtp.${domain}`, smtpPort: 465, imapHost: `imap.${domain}`, imapPort: 993 },
      { name: `mail.${domain}:465`, smtpHost: `mail.${domain}`, smtpPort: 465, imapHost: `mail.${domain}`, imapPort: 993 },
    ];

    logger.info(`\n� Testing ${allConfigs.length} configurations in parallel for custom domain...`);

    // Test ALL configurations in parallel - first one to succeed wins
    const results = await Promise.allSettled(
      allConfigs.map(config =>
        this.testSmtp(config.smtpHost, config.smtpPort, email, password)
          .then(() => {
            logger.info(`   ${config.name} SUCCESS`);
            return { success: true, config };
          })
          .catch((err) => {
            logger.info(`    ${config.name} FAILED`);
            return { success: false, config, error: err.message };
          })
      )
    );

    // Find first successful configuration
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled' && result.value.success) {
        const config = result.value.config;
        logger.info(`\nUsing config: ${config.name} (${config.smtpHost}:${config.smtpPort})`);
        return {
          smtpHost: config.smtpHost,
          smtpPort: config.smtpPort,
          imapHost: config.imapHost,
          imapPort: config.imapPort
        };
      }
    }

    logger.info('\n All configurations failed');
    throw new Error('Could not auto-detect email settings. Please use the Manual mode to enter your SMTP details.');
  }

  static async testSmtp(host, port, user, pass) {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 10000, // 10 seconds timeout
      greetingTimeout: 10000,
      socketTimeout: 10000
    });

    try {
      logger.info(`  ↳ Testing ${host}:${port}...`);
      await transporter.verify();
      logger.info(`  ${host}:${port} SUCCESS`);
    } catch (err) {
      logger.info(`   ${host}:${port} FAILED: ${err.message}`);
      throw err;
    }
  }
}

module.exports = EmailProviderDetector;
