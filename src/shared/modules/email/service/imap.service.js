/**
 * ------------------------------------------------------------------
 * File: imap.service.js
 * Module: Email Module
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * smtpConfig.controller, email.service
 * ------------------------------------------------------------------
 */

const Imap = require('imap');
const { simpleParser } = require('mailparser');
const EmailConfig = require('../model/emailConfig.model');
const logger = require('../../../../common/logger');
const { ClockService, DateUtil } = require('../../../../common/date');

/**
 * ImapService
 *
 * Represents the Imap Service controller/model class.
 */
class ImapService {
  async listEmails(userId, maxResults = 50, pageToken = null) {
    const config = await EmailConfig.findOne({ userId, provider: 'smtp' });
    
    if (!config || !config.imapHost) {
      throw new Error('IMAP configuration not found. Please configure your email settings.');
    }

    return new Promise((resolve, reject) => {
      const imap = new Imap({
        user: config.smtpUser,
        password: config.smtpPassword,
        host: config.imapHost,
        port: config.imapPort || 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false }
      });

      const emails = [];
      let pendingMessages = 0;

      imap.once('ready', () => {
        imap.openBox('INBOX', true, (err, box) => {
          if (err) {
            imap.end();
            return reject(err);
          }

          if (box.messages.total === 0) {
            imap.end();
            return resolve({ emails: [], nextPageToken: null });
          }

          const totalMessages = box.messages.total;
          const endSeq = pageToken ? parseInt(pageToken) : totalMessages;
          const startSeq = Math.max(1, endSeq - maxResults + 1);
          const hasMore = startSeq > 1;

          const fetchOptions = {
            bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)', 'TEXT', ''],
            struct: true
          };

          const fetch = imap.seq.fetch(`${startSeq}:${endSeq}`, fetchOptions);

          fetch.on('message', (msg, seqno) => {
            pendingMessages++;
            let emailData = { id: seqno.toString(), seqno, from: '', to: '', subject: '', date: '', snippet: '', body: '', unread: false };
            let buffer = '';

            msg.on('body', (stream, info) => {
              stream.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
              });
            });

            msg.once('attributes', (attrs) => {
              emailData.unread = !attrs.flags.includes('\\Seen');
            });

            msg.once('end', async () => {
              try {
                const parsed = await simpleParser(buffer);
                emailData.from = parsed.from?.text || 'Unknown';
                emailData.to = parsed.to?.text || '';
                emailData.subject = parsed.subject || 'No Subject';
                emailData.date = parsed.date?.toISOString() || DateUtil.toISO(ClockService.now());
                emailData.snippet = (parsed.text || '').substring(0, 150);
                emailData.body = parsed.html || parsed.textAsHtml || parsed.text || '';
                emailData.textBody = parsed.text || '';
                emails.push(emailData);
              } catch (err) {
                logger.error('Parse error for message', seqno, ':', err.message);
              }
              pendingMessages--;
            });
          });

          fetch.once('error', (err) => {
            imap.end();
            reject(err);
          });

          fetch.once('end', () => {
            // Wait for all messages to be parsed
            const checkComplete = setInterval(() => {
              if (pendingMessages === 0) {
                clearInterval(checkComplete);
                imap.end();
                const nextPageToken = hasMore ? String(startSeq - 1) : null;
                emails.sort((a, b) => b.seqno - a.seqno);
                resolve({ emails, nextPageToken });
              }
            }, 100);
          });
        });
      });

      imap.once('error', (err) => {
        reject(new Error(`IMAP error: ${err.message}`));
      });

      imap.once('end', () => {
        // Already resolved in checkComplete
      });

      imap.connect();
    });
  }

  async listSentEmails(userId, maxResults = 50, pageToken = null) {
    const config = await EmailConfig.findOne({ userId, provider: 'smtp' });
    
    if (!config || !config.imapHost) {
      throw new Error('IMAP configuration not found. Please configure your email settings.');
    }

    return new Promise((resolve, reject) => {
      const imap = new Imap({
        user: config.smtpUser,
        password: config.smtpPassword,
        host: config.imapHost,
        port: config.imapPort || 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false }
      });

      const emails = [];
      let pendingMessages = 0;

      imap.once('ready', () => {
        // Try common sent folder names
        const sentFolders = ['INBOX.Sent', 'Sent', '[Gmail]/Sent Mail', 'Sent Items', 'Sent Messages'];
        let folderIndex = 0;

        const tryNextFolder = () => {
          if (folderIndex >= sentFolders.length) {
            imap.end();
            return resolve({ emails: [], nextPageToken: null });
          }

          const folderName = sentFolders[folderIndex];
          imap.openBox(folderName, true, (err, box) => {
            if (err) {
              folderIndex++;
              tryNextFolder();
              return;
            }

            if (box.messages.total === 0) {
              imap.end();
              return resolve({ emails: [], nextPageToken: null });
            }

            const totalMessages = box.messages.total;
            const endSeq = pageToken ? parseInt(pageToken) : totalMessages;
            const startSeq = Math.max(1, endSeq - maxResults + 1);
            const hasMore = startSeq > 1;

            const fetchOptions = {
              bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)', 'TEXT', ''],
              struct: true
            };

            const fetch = imap.seq.fetch(`${startSeq}:${endSeq}`, fetchOptions);

            fetch.on('message', (msg, seqno) => {
              pendingMessages++;
              let emailData = { id: seqno.toString(), seqno, from: '', to: '', subject: '', date: '', snippet: '', body: '', unread: false };
              let buffer = '';

              msg.on('body', (stream, info) => {
                stream.on('data', (chunk) => {
                  buffer += chunk.toString('utf8');
                });
              });

              msg.once('attributes', (attrs) => {
                emailData.unread = !attrs.flags.includes('\\Seen');
              });

              msg.once('end', async () => {
                try {
                  const parsed = await simpleParser(buffer);
                  emailData.from = parsed.from?.text || 'Unknown';
                  emailData.to = parsed.to?.text || '';
                  emailData.subject = parsed.subject || 'No Subject';
                  emailData.date = parsed.date?.toISOString() || DateUtil.toISO(ClockService.now());
                  emailData.snippet = (parsed.text || '').substring(0, 150);
                  emailData.body = parsed.html || parsed.textAsHtml || parsed.text || '';
                  emailData.textBody = parsed.text || '';
                  emails.push(emailData);
                } catch (err) {
                  logger.error('Parse error for message', seqno, ':', err.message);
                }
                pendingMessages--;
              });
            });

            fetch.once('error', (err) => {
              imap.end();
              reject(err);
            });

            fetch.once('end', () => {
              const checkComplete = setInterval(() => {
                if (pendingMessages === 0) {
                  clearInterval(checkComplete);
                  imap.end();
                  const nextPageToken = hasMore ? String(startSeq - 1) : null;
                  emails.sort((a, b) => b.seqno - a.seqno);
                  resolve({ emails, nextPageToken });
                }
              }, 100);
            });
          });
        };

        tryNextFolder();
      });

      imap.once('error', (err) => {
        reject(new Error(`IMAP error: ${err.message}`));
      });

      imap.once('end', () => {
        // Already resolved in checkComplete
      });

      imap.connect();
    });
  }

  async verifyImapConfig(imapHost, imapPort, imapUser, imapPassword) {
    return new Promise((resolve, reject) => {
      const imap = new Imap({
        user: imapUser,
        password: imapPassword,
        host: imapHost,
        port: imapPort || 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        connTimeout: 10000
      });

      imap.once('ready', () => {
        imap.end();
        resolve({ success: true, message: 'IMAP configuration is valid' });
      });

      imap.once('error', (err) => {
        reject(new Error(`IMAP verification failed: ${err.message}`));
      });

      imap.connect();
    });
  }

  async getEmailDetail(userId, emailId) {
    const config = await EmailConfig.findOne({ userId, provider: 'smtp' });
    
    if (!config || !config.imapHost) {
      throw new Error('IMAP configuration not found.');
    }

    return new Promise((resolve, reject) => {
      const imap = new Imap({
        user: config.smtpUser,
        password: config.smtpPassword,
        host: config.imapHost,
        port: config.imapPort || 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false }
      });

      imap.once('ready', () => {
        const folders = ['INBOX', 'INBOX.Sent', 'Sent', '[Gmail]/Sent Mail', 'Sent Items', 'Sent Messages'];
        let folderIndex = 0;
        let emailFound = false;

        const tryNextFolder = () => {
          if (folderIndex >= folders.length) {
            imap.end();
            if (!emailFound) {
              return reject(new Error('Email not found'));
            }
            return;
          }

          const folderName = folders[folderIndex];
          imap.openBox(folderName, true, (err, box) => {
            if (err) {
              folderIndex++;
              tryNextFolder();
              return;
            }

            const fetch = imap.seq.fetch(emailId, {
              bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)', 'TEXT', ''],
              struct: true
            });

            let buffer = '';
            let emailData = { id: emailId, from: '', to: '', subject: '', date: '', body: '', textBody: '', unread: false };

            fetch.on('message', (msg, seqno) => {
              msg.on('body', (stream, info) => {
                stream.on('data', (chunk) => {
                  buffer += chunk.toString('utf8');
                });
              });

              msg.once('attributes', (attrs) => {
                emailData.unread = !attrs.flags.includes('\\Seen');
              });

              msg.once('end', async () => {
                try {
                  const parsed = await simpleParser(buffer);
                  emailData.from = parsed.from?.text || 'Unknown';
                  emailData.to = parsed.to?.text || '';
                  emailData.subject = parsed.subject || 'No Subject';
                  emailData.date = parsed.date?.toISOString() || DateUtil.toISO(ClockService.now());
                  emailData.body = parsed.html || parsed.textAsHtml || parsed.text || '';
                  emailData.textBody = parsed.text || '';
                  emailFound = true;
                  imap.end();
                  resolve(emailData);
                } catch (err) {
                  logger.error('Parse error:', err.message);
                  folderIndex++;
                  tryNextFolder();
                }
              });
            });

            fetch.once('error', (err) => {
              folderIndex++;
              tryNextFolder();
            });

            fetch.once('end', () => {
              if (!emailFound) {
                folderIndex++;
                tryNextFolder();
              }
            });
          });
        };

        tryNextFolder();
      });

      imap.once('error', (err) => {
        reject(new Error(`IMAP error: ${err.message}`));
      });

      imap.connect();
    });
  }

  async markAsRead(userId, emailId) {
    const config = await EmailConfig.findOne({ userId, provider: 'smtp' });
    
    if (!config || !config.imapHost) {
      throw new Error('IMAP configuration not found.');
    }

    return new Promise((resolve, reject) => {
      const imap = new Imap({
        user: config.smtpUser,
        password: config.smtpPassword,
        host: config.imapHost,
        port: config.imapPort || 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false }
      });

      imap.once('ready', () => {
        imap.openBox('INBOX', false, (err, box) => {
          if (err) {
            imap.end();
            return reject(err);
          }

          imap.seq.addFlags(emailId, '\\Seen', (err) => {
            imap.end();
            if (err) {
              return reject(new Error(`Failed to mark email as read: ${err.message}`));
            }
            resolve({ success: true, message: 'Email marked as read' });
          });
        });
      });

      imap.once('error', (err) => {
        reject(new Error(`IMAP error: ${err.message}`));
      });

      imap.connect();
    });
  }
}

module.exports = new ImapService();
