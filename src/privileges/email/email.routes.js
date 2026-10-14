/**
 * Email API Privileges (HOA + landlord mounts strip portal prefix → /api/v1/email/...)
 */

const {
  PRIVILEGE_VIEW_EMAIL,
  PRIVILEGE_COMPOSE_EMAIL,
} = require('../../common/constants/privileges');

module.exports = {
  'GET /api/v1/email/list': [PRIVILEGE_VIEW_EMAIL],
  'GET /api/v1/email/sent': [PRIVILEGE_VIEW_EMAIL],
  'POST /api/v1/email/send': [PRIVILEGE_COMPOSE_EMAIL],
  'GET /api/v1/email/contacts': [PRIVILEGE_VIEW_EMAIL],
  'GET /api/v1/email/check-access': [PRIVILEGE_VIEW_EMAIL],
  'POST /api/v1/email/mark-read/:emailId': [PRIVILEGE_VIEW_EMAIL],
  'GET /api/v1/email/:emailId': [PRIVILEGE_VIEW_EMAIL],
  'POST /api/v1/email/draft/save': [PRIVILEGE_COMPOSE_EMAIL],
  'GET /api/v1/email/draft/list': [PRIVILEGE_VIEW_EMAIL],
  'GET /api/v1/email/failed/list': [PRIVILEGE_VIEW_EMAIL],
  'DELETE /api/v1/email/draft/:draftId': [PRIVILEGE_COMPOSE_EMAIL],
  'POST /api/v1/email/draft/bulk-discard': [PRIVILEGE_COMPOSE_EMAIL],
  'POST /api/v1/email/draft/:draftId/discard': [PRIVILEGE_COMPOSE_EMAIL],
  'POST /api/v1/email/draft/:draftId/send': [PRIVILEGE_COMPOSE_EMAIL],
  'POST /api/v1/email/upload-attachments': [PRIVILEGE_COMPOSE_EMAIL],
  'GET /api/v1/email/:emailId/attachment/:attachmentId/download': [PRIVILEGE_VIEW_EMAIL],
  'DELETE /api/v1/email/:emailId/attachment/:attachmentId': [PRIVILEGE_COMPOSE_EMAIL],
  'POST /api/v1/email/smtp/test': [PRIVILEGE_COMPOSE_EMAIL],
  'POST /api/v1/email/smtp/configure': [PRIVILEGE_COMPOSE_EMAIL],
  'GET /api/v1/email/smtp/config': [PRIVILEGE_VIEW_EMAIL],
  'DELETE /api/v1/email/smtp/config': [PRIVILEGE_COMPOSE_EMAIL],
};
