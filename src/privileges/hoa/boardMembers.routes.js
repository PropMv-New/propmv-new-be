/**
 * ------------------------------------------------------------------
 * File: boardMembers.routes.js
 * Module: Src Privileges Hoa
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * authorize
 * ------------------------------------------------------------------
 */

/**
 * HOA board membership API Privileges
 * All routes require board-member role (enforced via requireRole in route file).
 * Privileges gate operational access within the board role.
 */

const {
  PRIVILEGE_VIEW_SETTINGS,
  PRIVILEGE_EDIT_SETTINGS,
} = require('../../common/constants/privileges');

module.exports = {
  'POST /api/v1/board-members': [PRIVILEGE_EDIT_SETTINGS],
  'GET /api/v1/board-members/my-hoas': [PRIVILEGE_VIEW_SETTINGS],
  'GET /api/v1/board-members/onboarding-status': [PRIVILEGE_VIEW_SETTINGS],
  'GET /api/v1/board-members/invite-config': [PRIVILEGE_VIEW_SETTINGS],
  'PATCH /api/v1/board-members/:hoaId/profile': [PRIVILEGE_EDIT_SETTINGS],
  'GET /api/v1/board-members/:hoaId/invite/validate': [PRIVILEGE_EDIT_SETTINGS],
  'POST /api/v1/board-members/:hoaId/invite': [PRIVILEGE_EDIT_SETTINGS],
  'GET /api/v1/board-members/:hoaId/members': [PRIVILEGE_VIEW_SETTINGS],
  'POST /api/v1/board-members/:hoaId/members/:membershipId/revoke': [PRIVILEGE_EDIT_SETTINGS],
  'POST /api/v1/board-members/:hoaId/members/:membershipId/restore': [PRIVILEGE_EDIT_SETTINGS],
  'DELETE /api/v1/board-members/:hoaId/members/:membershipId': [PRIVILEGE_EDIT_SETTINGS],
};
