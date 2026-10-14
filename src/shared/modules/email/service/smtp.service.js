/**
 * ------------------------------------------------------------------
 * File: smtp.service.js
 * Module: Email Module
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * smtpConfig.controller, email.service
 * ------------------------------------------------------------------
 */

const nodemailer = require('nodemailer');
const Imap = require('imap');
const EmailConfig = require('../model/emailConfig.model');
const logger = require('../../../../common/logger');
const { ClockService } = require('../../../../common/date');

const SMTP_TLS_REJECT_UNAUTHORIZED = process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== 'false';

/**
 * SmtpService
 *
 * Represents the Smtp Service controller/model class.
 */
class SmtpService {
  async sendEmail(userId, { to, subject, body, cc = null, bcc = null }) {
    const config = await EmailConfig.findOne({ userId, provider: 'smtp' });

    if (!config) {
      throw new Error('SMTP configuration not found. Please configure your email settings.');
    }

    const transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: true,
      auth: {
        user: config.smtpUser,
        pass: config.smtpPassword
      },
      tls: {
        rejectUnauthorized: SMTP_TLS_REJECT_UNAUTHORIZED,
        minVersion: 'TLSv1.2'
      }
    });

    // Detect if body is HTML or plain text
    const isHtml = /<[a-z][\s\S]*>/i.test(body);

    const mailOptions = {
      from: `${config.fromName || config.smtpUser} <${config.smtpUser}>`,
      to,
      subject,
      html: isHtml ? body : undefined,
      text: isHtml ? body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : body,
      cc: cc || undefined,
      bcc: bcc || undefined
    };

    try {
      const info = await transporter.sendMail(mailOptions);

      // Save to Sent folder via IMAP
      await this._saveToSentFolder(config, mailOptions);

      return {
        id: info.messageId,
        threadId: info.messageId
      };
    } catch (error) {
      throw new Error(`SMTP send failed: ${this._parseSmtpError(error)}`);
    }
  }

  async _saveToSentFolder(config, mailOptions) {
    return new Promise((resolve, reject) => {
      const imap = new Imap({
        user: config.smtpUser,
        password: config.smtpPassword,
        host: config.imapHost,
        port: config.imapPort || 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: SMTP_TLS_REJECT_UNAUTHORIZED }
      });

      imap.once('ready', () => {
        const sentFolders = ['INBOX.Sent', 'Sent', '[Gmail]/Sent Mail', 'Sent Items', 'Sent Messages'];
        let folderIndex = 0;

        const tryNextFolder = () => {
          if (folderIndex >= sentFolders.length) {
            imap.end();
            return resolve(); // Don't fail if Sent folder not found
          }

          const folderName = sentFolders[folderIndex];
          imap.openBox(folderName, false, (err, box) => {
            if (err) {
              folderIndex++;
              tryNextFolder();
              return;
            }

            // Build proper RFC822 message
            const date = ClockService.now().toUTCString();
            const messageId = `<${ClockService.nowEpoch()}.${Math.random().toString(36).substr(2, 9)}@${config.smtpUser.split('@')[1]}>`;

            // Build proper RFC822 message with HTML support
            const isHtml = mailOptions.html != null;
            const boundary = `----=_Part_${ClockService.nowEpoch()}_${Math.random().toString(36).substr(2, 9)}`;

            let message;
            if (isHtml) {
              message = [
                `Message-ID: ${messageId}`,
                `Date: ${date}`,
                `From: ${mailOptions.from}`,
                `To: ${mailOptions.to}`,
                mailOptions.cc ? `Cc: ${mailOptions.cc}` : '',
                mailOptions.bcc ? `Bcc: ${mailOptions.bcc}` : '',
                `Subject: ${mailOptions.subject}`,
                'MIME-Version: 1.0',
                `Content-Type: multipart/alternative; boundary="${boundary}"`,
                '',
                `--${boundary}`,
                'Content-Type: text/plain; charset=utf-8',
                'Content-Transfer-Encoding: 7bit',
                '',
                mailOptions.text,
                '',
                `--${boundary}`,
                'Content-Type: text/html; charset=utf-8',
                'Content-Transfer-Encoding: 7bit',
                '',
                mailOptions.html,
                '',
                `--${boundary}--`,
                ''
              ].filter(line => line !== '').join('\r\n');
            } else {
              message = [
                `Message-ID: ${messageId}`,
                `Date: ${date}`,
                `From: ${mailOptions.from}`,
                `To: ${mailOptions.to}`,
                mailOptions.cc ? `Cc: ${mailOptions.cc}` : '',
                mailOptions.bcc ? `Bcc: ${mailOptions.bcc}` : '',
                `Subject: ${mailOptions.subject}`,
                'MIME-Version: 1.0',
                'Content-Type: text/plain; charset=utf-8',
                'Content-Transfer-Encoding: 7bit',
                '',
                mailOptions.text,
                ''
              ].filter(line => line !== '').join('\r\n');
            }

            imap.append(message, { mailbox: folderName, flags: ['\\Seen'] }, (err) => {
              imap.end();
              if (err) {
                logger.error('Failed to save to Sent folder:', err.message);
              }
              resolve();
            });
          });
        };

        tryNextFolder();
      });

      imap.once('error', (err) => {
        logger.error('IMAP error while saving to Sent:', err.message);
        resolve(); // Don't fail the send operation
      });

      imap.connect();
    });
  }

  async verifyConfig(smtpHost, smtpPort, smtpUser, smtpPassword) {
    // Validate inputs
    if (!smtpHost || !smtpPort || !smtpUser || !smtpPassword) {
      throw new Error('All SMTP fields are required');
    }

    if (smtpPort < 1 || smtpPort > 65535) {
      throw new Error('Invalid SMTP port. Must be between 1-65535');
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: true,
      auth: { user: smtpUser, pass: smtpPassword },
      tls: {
        rejectUnauthorized: SMTP_TLS_REJECT_UNAUTHORIZED,
        minVersion: 'TLSv1.2'
      },
      connectionTimeout: 10000,
      socketTimeout: 10000,
      greetingTimeout: 10000
    });

    try {
      // Verify connection and authentication
      logger.info(`🔐 Testing SMTP credentials: ${smtpUser} @ ${smtpHost}:${smtpPort}`);
      await transporter.verify();
      logger.info(`SMTP verification successful for ${smtpUser}`);
      return { success: true, message: 'SMTP configuration is valid' };
    } catch (error) {
      logger.error(` SMTP verification failed: ${error.message}`);
      const parsedError = this._parseSmtpError(error, smtpHost);
      throw new Error(parsedError);
    }
  }

  _parseSmtpError(error, smtpHost = '') {
    const message = error.message || '';
    const code = error.code || '';

    logger.info(`[SMTP Error Details] Code: ${code}, Message: ${message}, Host: ${smtpHost}`);

    // Check for Gmail-specific authentication errors
    if (smtpHost.includes('gmail.com') || smtpHost.includes('smtp.gmail')) {
      if (message.includes('Invalid login') || message.includes('535') || message.includes('authentication failed')) {
        return 'Invalid Gmail credentials. Gmail requires an App Password, not your regular password. Go to https://myaccount.google.com/apppasswords to generate one.';
      }
      if (message.includes('Username and Password not accepted') || message.includes('SMTP AUTH failed')) {
        return 'Gmail SMTP authentication failed. Please use an App Password instead of your regular password.';
      }
    }

    // Check for Outlook/Microsoft errors
    if (smtpHost.includes('office365.com') || smtpHost.includes('outlook.com')) {
      if (message.includes('Invalid login') || message.includes('535') || message.includes('authentication failed')) {
        return 'Invalid Outlook credentials. If you have 2-Step Verification enabled, use an App Password from https://account.microsoft.com/security/';
      }
    }

    // Check for Yahoo errors
    if (smtpHost.includes('yahoo.com')) {
      if (message.includes('Invalid login') || message.includes('535') || message.includes('authentication failed')) {
        return 'Invalid Yahoo credentials. Yahoo requires an App Password. Generate one at https://login.yahoo.com';
      }
    }

    // Generic authentication errors
    if (message.includes('Invalid login') || message.includes('535')) {
      return 'Invalid email or password. If you have 2FA enabled, use an App Password instead.';
    }
    if (message.includes('Username and Password not accepted') || message.includes('SMTP AUTH failed')) {
      return 'Authentication failed. Enable "Less secure app access" or use App Password if available.';
    }

    // Connection errors
    if (message.includes('ECONNREFUSED') || code === 'ECONNREFUSED') {
      return 'Cannot connect to SMTP server. Check host and port.';
    }
    if (message.includes('ETIMEDOUT') || message.includes('timeout') || code === 'ETIMEDOUT') {
      return 'Connection timeout. Check your network or SMTP server.';
    }
    if (message.includes('ENOTFOUND') || code === 'ENOTFOUND') {
      return 'SMTP host not found. Check the server address.';
    }
    if (message.includes('EHOSTUNREACH') || code === 'EHOSTUNREACH') {
      return 'Cannot reach SMTP host. Check your network connection.';
    }

    // TLS/SSL errors
    if (message.includes('CERT') || message.includes('certificate') || code === 'CERT_HAS_EXPIRED') {
      return 'SSL/TLS certificate error. Contact your email provider.';
    }
    if (message.includes('DEPTH_ZERO_SELF_SIGNED_CERT')) {
      return 'SSL certificate verification failed. This is usually a network issue.';
    }

    // Rate limiting
    if (message.includes('rate limit') || message.includes('too many')) {
      return 'Rate limit exceeded. Try again later.';
    }

    // Fallback
    return message || 'SMTP configuration error';
  }
}

module.exports = new SmtpService();
