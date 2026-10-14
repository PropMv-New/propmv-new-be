'use strict';

const NotificationLog = require('./models/notificationLog.model');
const { v4: uuidv4 } = require('uuid');
const { ClockService } = require('../date');

async function recordNotificationLog(entry = {}) {
  const notificationId = entry.notificationId || uuidv4();
  const created = await NotificationLog.create({
    notificationId,
    jobId: entry.jobId || '',
    type: entry.type || 'unknown',
    channel: entry.channel || 'in-app',
    recipientType: entry.recipientType || '',
    recipientId: entry.recipientId != null ? String(entry.recipientId) : '',
    recipientEmail: entry.recipientEmail || '',
    entityType: entry.entityType || '',
    entityId: entry.entityId != null ? String(entry.entityId) : '',
    activityId: entry.activityId || '',
    subject: entry.subject || '',
    status: entry.status || 'queued',
    providerMessageId: entry.providerMessageId || '',
    attempts: Number(entry.attempts) || 0,
    errorMessage: entry.errorMessage || '',
    sentAt: entry.status === 'sent' ? (entry.sentAt || ClockService.now()) : null,
    workerId: entry.workerId || '',
    metadata: entry.metadata || null,
  });
  return created.toObject();
}

module.exports = {
  recordNotificationLog,
};
