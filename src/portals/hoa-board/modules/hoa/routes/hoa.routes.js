/**
 * ------------------------------------------------------------------
 * File: hoa.routes.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const hoaController = require('../controller/hoa.controller');
const authMiddleware = require('../../../../../middleware/auth');
const authorize = require('../../../../../middleware/authorize');
const requireRole = require('../../../../../middleware/requireRole');
const csrfProtection = require('../../../../../middleware/csrfProtection');
const { ROLE_NAMES } = require('../../../../../common/constants/roleNames');

const { enforceHoaTrialAccess } = require('../../../../../middleware/hoaTrialAccess');
const boardMemberOnly = requireRole(ROLE_NAMES.HOA_BOARD_MEMBER);
const boardMemberOrVendor = requireRole([ROLE_NAMES.HOA_BOARD_MEMBER, ROLE_NAMES.VENDOR]);
const guard = [csrfProtection, authMiddleware, authorize, enforceHoaTrialAccess];
const boardGuard = [csrfProtection, authMiddleware, boardMemberOnly, authorize, enforceHoaTrialAccess];

// GET    /api/v1/hoa/board-members/invite-preview?token=   - public invite details for onboarding UI
router.get('/invite-preview', hoaController.invitePreview);

// GET    /api/v1/hoa/board-members/invite-config            - runtime invite expiry (hours) for board UI
router.get('/invite-config', authMiddleware, boardMemberOnly, authorize, hoaController.getInviteConfig);

// POST   /api/v1/hoa/board-members                          - create a new HOA
router.post('/', ...guard, hoaController.createHOA);

// GET    /api/v1/hoa/board-members/my-hoas                  - get all HOAs the logged-in user belongs to
// Vendors also call this to resolve their associated HOA for invoice context
router.get('/my-hoas', authMiddleware, boardMemberOrVendor, authorize, hoaController.getMyHOAs);

router.get('/subscription', authMiddleware, boardMemberOnly, authorize, hoaController.getSubscription);

router.post('/:hoaId/subscribe', ...boardGuard, hoaController.subscribe);

// GET    /api/v1/hoa/board-members/onboarding-status        - community setup progress for active HOA
router.get('/onboarding-status', authMiddleware, boardMemberOnly, authorize, hoaController.getOnboardingStatus);

// POST   /api/v1/hoa/board-members/accept-invite            - accept an invite token (role assigned after acceptance)
router.post('/accept-invite', csrfProtection, authMiddleware, hoaController.acceptInvite);

// PATCH  /api/v1/hoa/board-members/:hoaId/profile            - update community address / association type
router.patch('/:hoaId/profile', ...boardGuard, hoaController.updateHOAProfile);

// GET    /api/v1/hoa/board-members/:hoaId/invite/validate?email= - pre-check invitee role
router.get('/:hoaId/invite/validate', authMiddleware, boardMemberOnly, authorize, enforceHoaTrialAccess, hoaController.validateInvite);

// POST   /api/v1/hoa/board-members/:hoaId/invite            - invite a member by email
router.post('/:hoaId/invite', ...boardGuard, hoaController.inviteMember);

// GET    /api/v1/hoa/board-members/:hoaId/members           - list members of an HOA
router.get('/:hoaId/members', authMiddleware, boardMemberOnly, authorize, enforceHoaTrialAccess, hoaController.getHOAMembers);

// POST   /api/v1/hoa/board-members/:hoaId/members/:membershipId/revoke  - revoke active member access
router.post('/:hoaId/members/:membershipId/revoke', ...boardGuard, hoaController.revokeMember);

// POST   /api/v1/hoa/board-members/:hoaId/members/:membershipId/restore - restore revoked member
router.post('/:hoaId/members/:membershipId/restore', ...boardGuard, hoaController.restoreMember);

// DELETE /api/v1/hoa/board-members/:hoaId/members/:membershipId - permanently delete membership record
router.delete('/:hoaId/members/:membershipId', ...boardGuard, hoaController.deleteMember);

module.exports = router;
