const notificationProxy = require('../service/notificationProxy.service');
const { userCanAccessHoaCommunity } = require('../../../../middleware/hoaDataIsolation');
const responseHelper = require('../../../../common/helpers/responseHelper');
const logger = require('../../../../common/logger');

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.substring(7);
}

async function assertHoaAccess(userId, hoaId) {
  if (!hoaId) return;
  const allowed = await userCanAccessHoaCommunity(userId, hoaId);
  if (!allowed) {
    const err = new Error('You do not have access to this community');
    err.status = 403;
    throw err;
  }
}

const listNotifications = async (req, res) => {
  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ success: false, message: 'Access token required' });

    const userId = req.userId;
    const hoaId = req.query.hoaId ? String(req.query.hoaId) : null;
    const unreadOnly = req.query.unread !== 'false';
    const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
    const skip = req.query.skip != null ? Number(req.query.skip) : undefined;

    if (hoaId) await assertHoaAccess(userId, hoaId);

    const notifications = await notificationProxy.listNotifications(token, {
      hoaId,
      unreadOnly,
      limit,
      skip,
    });
    return responseHelper.success(res, notifications, 'Notifications fetched', 200);
  } catch (err) {
    logger.error('listNotifications proxy failed', err);
    const status = err.status || 500;
    return responseHelper.error(res, err.message || 'Failed to fetch notifications', status);
  }
};

const getUnreadCount = async (req, res) => {
  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ success: false, message: 'Access token required' });

    const userId = req.userId;
    const hoaId = req.query.hoaId ? String(req.query.hoaId) : null;
    if (hoaId) await assertHoaAccess(userId, hoaId);

    const count = await notificationProxy.getUnreadCount(token, { hoaId });
    return responseHelper.success(res, { count }, 'Unread count fetched', 200);
  } catch (err) {
    logger.error('getUnreadCount proxy failed', err);
    const status = err.status || 500;
    return responseHelper.error(res, err.message || 'Failed to fetch unread count', status);
  }
};

const markAsRead = async (req, res) => {
  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ success: false, message: 'Access token required' });

    const hoaId = req.query.hoaId ? String(req.query.hoaId) : null;
    if (hoaId) await assertHoaAccess(req.userId, hoaId);

    const updated = await notificationProxy.markAsRead(token, req.params.id, req.userId);
    if (!updated) return responseHelper.error(res, 'Notification not found', 404);

    if (hoaId) {
      const notificationHoaId = notificationProxy.extractHoaId(updated);
      if (notificationHoaId && notificationHoaId !== hoaId) {
        return responseHelper.error(res, 'Notification not found in this community', 404);
      }
    }

    return responseHelper.success(res, updated, 'Notification marked as read', 200);
  } catch (err) {
    logger.error('markAsRead proxy failed', err);
    const status = err.status || 500;
    return responseHelper.error(res, err.message || 'Failed to mark notification as read', status);
  }
};

const markMultipleAsRead = async (req, res) => {
  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ success: false, message: 'Access token required' });

    const hoaId = req.query.hoaId ? String(req.query.hoaId) : null;
    if (hoaId) await assertHoaAccess(req.userId, hoaId);

    let notificationIds = Array.isArray(req.body?.notificationIds) ? req.body.notificationIds : [];
    if (hoaId && notificationIds.length) {
      const scoped = await notificationProxy.listNotifications(token, { hoaId, unreadOnly: true });
      const allowed = new Set(scoped.map((n) => String(n._id)));
      notificationIds = notificationIds.filter((id) => allowed.has(String(id)));
    }

    const result = await notificationProxy.markMultipleAsRead(token, notificationIds, req.userId);
    return responseHelper.success(res, result, 'Notifications marked as read', 200);
  } catch (err) {
    logger.error('markMultipleAsRead proxy failed', err);
    const status = err.status || 500;
    return responseHelper.error(res, err.message || 'Failed to mark notifications as read', status);
  }
};

const markAllAsRead = async (req, res) => {
  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ success: false, message: 'Access token required' });

    const hoaId = req.query.hoaId ? String(req.query.hoaId) : null;
    if (hoaId) await assertHoaAccess(req.userId, hoaId);

    const result = await notificationProxy.markAllAsRead(token, req.userId, { hoaId });
    return responseHelper.success(res, result, 'Notifications marked as read', 200);
  } catch (err) {
    logger.error('markAllAsRead proxy failed', err);
    const status = err.status || 500;
    return responseHelper.error(res, err.message || 'Failed to mark all notifications as read', status);
  }
};

module.exports = {
  listNotifications,
  getUnreadCount,
  markAsRead,
  markMultipleAsRead,
  markAllAsRead,
};
