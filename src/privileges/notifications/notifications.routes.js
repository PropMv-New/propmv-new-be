/**
 * Notifications API privileges (propmv proxy → notification-service).
 *
 * In-app notifications are scoped to the authenticated user; HOA filtering is
 * enforced in notification.controller via assertHoaAccess. Empty arrays = auth-only.
 */

module.exports = {
  'GET /api/v1/notifications': [],
  'GET /api/v1/notifications/unread-count': [],
  'PATCH /api/v1/notifications/:id/read': [],
  'POST /api/v1/notifications/mark-read': [],
  'POST /api/v1/notifications/mark-all-read': [],
};
