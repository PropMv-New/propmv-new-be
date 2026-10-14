const axios = require('axios');
const logger = require('../../../../common/logger');
const { extractHoaIdFromNotification } = require('../../../../common/helpers/hoaNotifyDispatch.helper');

const getServiceUrl = () => process.env.NOTIFICATION_SERVICE_URL || '';

function buildUserHttp(userToken) {
  return axios.create({
    baseURL: getServiceUrl().replace(/\/$/, ''),
    timeout: 8000,
    headers: {
      Authorization: `Bearer ${userToken}`,
      'Content-Type': 'application/json',
    },
  });
}

function extractHoaId(notification = {}) {
  return extractHoaIdFromNotification(notification);
}

/**
 * Scope notifications to the active community.
 * Keep rows with no hoaId (legacy / edge events) so the board-member badge is not
 * emptied when metadata is incomplete. Only hide rows that belong to another HOA.
 */
function filterByCommunity(notifications = [], hoaId) {
  if (!hoaId) return notifications;
  const scoped = String(hoaId);
  return notifications.filter((n) => {
    const found = extractHoaId(n);
    return found ? found === scoped : true;
  });
}

function isNotificationServiceUnavailable(err) {
  const code = err?.code || err?.cause?.code;
  return (
    code === 'ECONNREFUSED'
    || code === 'ENOTFOUND'
    || code === 'ECONNRESET'
    || code === 'ETIMEDOUT'
    || code === 'EAI_AGAIN'
    || err?.message?.includes('ECONNREFUSED')
  );
}

async function fetchUserNotifications(userToken, { unreadOnly = true, hoaId, limit, skip } = {}) {
  const url = getServiceUrl();
  if (!url) {
    logger.warn('Notification proxy skipped - NOTIFICATION_SERVICE_URL not configured');
    return [];
  }
  const http = buildUserHttp(userToken);
  const params = {
    unread: unreadOnly ? 'true' : 'false',
  };
  if (hoaId) params.hoaId = String(hoaId);
  if (limit != null) params.limit = String(limit);
  if (skip != null) params.skip = String(skip);
  try {
    const { data } = await http.get('/api/notifications', { params });
    return Array.isArray(data?.data) ? data.data : [];
  } catch (err) {
    // Local HOA often runs without notification-service on :3000 — do not 500 the SPA.
    if (isNotificationServiceUnavailable(err)) {
      logger.warn('Notification service unavailable - returning empty list', {
        error: err.message,
        code: err.code,
      });
      return [];
    }
    throw err;
  }
}

async function listNotifications(userToken, { hoaId, unreadOnly = true, limit, skip } = {}) {
  // Prefer server-side hoaId filtering so the page is not crowded out by other communities.
  const notifications = await fetchUserNotifications(userToken, {
    unreadOnly,
    hoaId,
    limit,
    skip,
  });
  // Defense-in-depth: keep client filter for nested/legacy edge cases.
  return filterByCommunity(notifications, hoaId);
}

async function getUnreadCount(userToken, { hoaId } = {}) {
  const url = getServiceUrl();
  if (!url) return 0;
  const http = buildUserHttp(userToken);
  const params = {};
  if (hoaId) params.hoaId = String(hoaId);
  try {
    const { data } = await http.get('/api/notifications/unread-count', { params });
    return Number(data?.data?.count ?? 0);
  } catch (err) {
    if (isNotificationServiceUnavailable(err)) {
      logger.warn('Notification service unavailable - unread count 0', {
        error: err.message,
        code: err.code,
      });
      return 0;
    }
    // Fallback for older notification-service builds without unread-count.
    logger.warn('unread-count endpoint unavailable, falling back to list length', {
      message: err.message,
    });
    try {
      const notifications = await listNotifications(userToken, { hoaId, unreadOnly: true, limit: 500 });
      return notifications.length;
    } catch (fallbackErr) {
      if (isNotificationServiceUnavailable(fallbackErr)) return 0;
      throw fallbackErr;
    }
  }
}

async function markAsRead(userToken, notificationId, userId) {
  const url = getServiceUrl();
  if (!url) return null;
  const http = buildUserHttp(userToken);
  const { data } = await http.patch(`/api/notifications/${notificationId}/read`, {});
  const updated = data?.data;
  if (updated && String(updated.userId) !== String(userId)) {
    const err = new Error('Notification not found');
    err.status = 404;
    throw err;
  }
  return updated;
}

async function markMultipleAsRead(userToken, notificationIds = [], userId) {
  const url = getServiceUrl();
  if (!url) return { modifiedCount: 0 };
  const http = buildUserHttp(userToken);
  const { data } = await http.post('/api/notifications/mark-read', { notificationIds });
  return data?.data || { modifiedCount: 0 };
}

async function markAllAsRead(userToken, userId, { hoaId } = {}) {
  const url = getServiceUrl();
  if (!url) return { modifiedCount: 0 };
  const http = buildUserHttp(userToken);

  // Prefer server-side mark-all with optional hoaId so every matching row is cleared
  // (not just the first list page of 100).
  try {
    const params = {};
    if (hoaId) params.hoaId = String(hoaId);
    const { data } = await http.post('/api/notifications/mark-all-read', hoaId ? { hoaId } : {}, { params });
    return data?.data || { modifiedCount: 0 };
  } catch (err) {
    // Fallback for older services: page through unread and mark in batches.
    logger.warn('mark-all-read with hoaId failed, falling back to batched mark-read', {
      message: err.message,
      hoaId: hoaId || null,
    });
    if (!hoaId) {
      const { data } = await http.post('/api/notifications/mark-all-read', {});
      return data?.data || { modifiedCount: 0 };
    }

    let totalModified = 0;
    for (let guard = 0; guard < 100; guard++) {
      const scoped = await listNotifications(userToken, { hoaId, unreadOnly: true, limit: 500 });
      const ids = scoped.map((n) => n._id).filter(Boolean);
      if (!ids.length) break;
      const result = await markMultipleAsRead(userToken, ids, userId);
      totalModified += result.modifiedCount || 0;
      if (ids.length < 500) break;
    }
    return { modifiedCount: totalModified };
  }
}

module.exports = {
  listNotifications,
  getUnreadCount,
  markAsRead,
  markMultipleAsRead,
  markAllAsRead,
  filterByCommunity,
  extractHoaId,
};
