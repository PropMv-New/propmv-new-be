/**
 * ------------------------------------------------------------------
 * File: owner.routes.js
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
const { ClockService, DateUtil } = require('../../../../../common/date');
const router = express.Router();
const mongoose = require('mongoose');
const responseHelper = require('../../../../../common/helpers/responseHelper');
const ownerController = require('../controller/owner.controller');
const unitController = require('../controllers/unit.controller');
const unitImportExportController = require('../controllers/unitImportExport.controller');
const authMiddleware = require('../../../../../middleware/auth');
const csrfProtection = require('../../../../../middleware/csrfProtection');
const authorize = require('../../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../../middleware/lockCheck');
const requireRole = require('../../../../../middleware/requireRole');
const { ROLE_NAMES } = require('../../../../../common/constants/roleNames');
const { validateBody, validateQuery, validateParams } = require('../../../../../common/middleware/requestValidator');
const { createOwnerSchema, deleteOwnerBodySchema } = require('../validators/owner.validator');
const {
  createUnitSchema,
  updateUnitSchema,
  addOwnerSchema,
  removeOwnerSchema,
  changeOwnershipSchema,
  reassignDepositBankSchema,
  ownershipEventLogParamSchema,
} = require('../validators/createUnit.validator');
const { idParamSchema } = require('../../tenants/validators/tenant.validator');
const { activityLogger } = require('../../../../../middleware/activityLogger');
const ledgerController = require('../controllers/ledger.controller');
const depositBankAccountController = require('../controllers/depositBankAccount.controller');
const {
  requireOwnerPropertyAccess,
  requireOwnerPropertyBatchAccess,
} = require('../../../../../middleware/hoaOwnerPropertyAccess');

// /api/v1/owners/me/units - HOA Owner self-service: fetch own assigned units
router.get('/me/units', authMiddleware, requireRole(ROLE_NAMES.HOA_OWNER), async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Not authenticated' });

    const User = require('../../../../../shared/modules/users/models/user.model');
    const Property = require('../../property/model/property.model');

    const ownerObjectId = mongoose.Types.ObjectId.isValid(userId)
      ? new mongoose.Types.ObjectId(String(userId))
      : null;
    /** Fall back to ownership timeline when User.propertyIds / associatedOwnerIds drift after scheduled removal */
    const { loadTimelinePropertyIdsByOwnerIds } = require('../service/owner.service');
    const [owner, assocDocIds] = await Promise.all([
      User.findById(userId).select('propertyIds hoaInfo').lean(),
      Property.find({
        isDeleted: { $ne: true },
        ...(ownerObjectId
          ? { associatedOwnerIds: ownerObjectId }
          : { associatedOwnerIds: userId }),
      })
        .select('_id')
        .lean(),
    ]);
    if (!owner) return responseHelper.error(res, 'Owner not found', 404);

    const fromProfile = (owner.propertyIds || []).map((id) => String(id)).filter(Boolean);

    const fromAssoc = assocDocIds.map((p) => String(p._id)).filter(Boolean);
    const timelineScope = owner.hoaInfo?.hoaId
      ? { hoaId: owner.hoaInfo.hoaId, isDeleted: { $ne: true } }
      : {};
    const timelineMap = await loadTimelinePropertyIdsByOwnerIds([userId], timelineScope);
    const fromTimeline = [...(timelineMap.get(String(userId)) || [])];
    const merged = [...new Set([...fromProfile, ...fromAssoc, ...fromTimeline])];
    const objectIds = merged
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    const properties =
      objectIds.length > 0
        ? await Property.find({ _id: { $in: objectIds }, isDeleted: { $ne: true } })
          .select('name unitDetails address')
          .lean()
        : [];

    const units = [];
    for (const p of properties) {
      const propertyId = p._id.toString();
      const address = {
        street: p.address?.street || '',
        city: p.address?.city || '',
        state: p.address?.state || '',
        zip: p.address?.zip || '',
      };
      const unitDetails = Array.isArray(p.unitDetails) ? p.unitDetails : [];

      if (unitDetails.length === 0) {
        units.push({
          id: propertyId,
          propertyId,
          unitId: '',
          name: p.name || '',
          unitName: '',
          address,
        });
        continue;
      }

      for (const ud of unitDetails) {
        units.push({
          id: propertyId,
          propertyId,
          unitId: ud._id ? String(ud._id) : '',
          name: p.name || '',
          unitName: ud.unitName || '',
          address,
          unitType: ud.unitType || '',
          squareFeet: ud.squareFeet,
          bedRooms: ud.bedRooms,
          bathRoom: ud.bathRoom,
        });
      }
    }

    /** Must use responseHelper so global formatter keeps `data` as the array (not double-nested). */
    return responseHelper.success(res, units, 'Assigned units fetched successfully', 200);
  } catch (err) {
    return responseHelper.error(res, err.message || 'Failed to load units', 500);
  }
});

// HOA Owner self-service balance (read-only ledger summary for owned properties)
router.get(
  '/me/units/:id/balance',
  authMiddleware,
  requireRole(ROLE_NAMES.HOA_OWNER),
  requireOwnerPropertyAccess,
  lockCheckMiddleware,
  ledgerController.getBalance
);
router.post(
  '/me/units/balances',
  csrfProtection,
  authMiddleware,
  requireRole(ROLE_NAMES.HOA_OWNER),
  requireOwnerPropertyBatchAccess,
  lockCheckMiddleware,
  ledgerController.getBalancesBatch
);

// /api/v1/owners
router.get('/picker', authMiddleware, authorize, lockCheckMiddleware, ownerController.listOwnersPicker);
router.get('/', authMiddleware, authorize, lockCheckMiddleware, ownerController.listOwners);
router.post('/',
  csrfProtection,
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validateBody(createOwnerSchema),
  ownerController.createOwner,
  activityLogger({
    type: 'owner',
    title: 'Owner Created',
    description: (req, res, data) => `Owner "${data.data?.firstName || ''} ${data.data?.lastName || ''}" created`,
    isHOAActivity: true
  })
);

// /api/v1/owners/import (legacy - owners) - MUST come before /:id
router.post('/import', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, ownerController.importOwners);
router.get('/export', authMiddleware, authorize, lockCheckMiddleware, ownerController.exportOwners);
router.get('/template', authMiddleware, authorize, lockCheckMiddleware, ownerController.downloadOwnerTemplate);

// /api/v1/owners/units - Specific routes MUST come before parameterized routes
// Import/Export routes
router.post('/units/import', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, unitImportExportController.startImport);
router.get('/units/import/:jobId/status', authMiddleware, authorize, lockCheckMiddleware, unitImportExportController.getImportStatus);
router.get('/units/export', authMiddleware, authorize, lockCheckMiddleware, unitImportExportController.exportUnits);
router.get('/units/template', authMiddleware, authorize, lockCheckMiddleware, unitImportExportController.downloadTemplate);

router.get(
  '/deposit-bank-accounts/:bankAccountId/usage',
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  depositBankAccountController.getUsage
);
router.post(
  '/deposit-bank-accounts/reassign',
  csrfProtection,
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validateBody(reassignDepositBankSchema),
  depositBankAccountController.reassign
);

// CRUD routes
router.post('/units',
  csrfProtection,
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  unitController.unitImageUpload,
  unitController.normalizeUnitPayload,
  validateBody(createUnitSchema),
  unitController.createUnit,
  activityLogger({
    type: 'property',
    title: 'Unit Created',
    description: (req, res, data) => `Unit "${data.data?.title || 'New Unit'}" created`,
    propertyId: (req, res, data) => data.data?._id,
    isHOAActivity: true
  })
);
router.get('/units/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), unitController.getUnitById);

// Ledger routes - must come before PUT /units/:id to avoid conflicts
router.post('/units/:id/adjustment', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), ledgerController.applyAdjustment);
router.post('/units/balances', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, ledgerController.getBalancesBatch);
router.get('/units/:id/balance', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), ledgerController.getBalance);
router.get('/units/:id/ledger', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), ledgerController.getLedger);
router.get('/units/:id/ledger/invoice/:invoiceId', authMiddleware, authorize, lockCheckMiddleware, ledgerController.getLedgerByInvoice);
router.post('/units/:id/add-owner', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), validateBody(addOwnerSchema), unitController.addOwner);
router.post('/units/:id/remove-owner', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), validateBody(removeOwnerSchema), unitController.removeOwner);
router.post('/units/:id/change-ownership', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), validateBody(changeOwnershipSchema), unitController.changeOwnership);
router.get(
  '/units/:id/ownership-events/:logId/revert-preview',
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validateParams(ownershipEventLogParamSchema),
  unitController.getOwnershipEventRevertPreview,
);
router.post(
  '/units/:id/ownership-events/:logId/revert',
  csrfProtection,
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validateParams(ownershipEventLogParamSchema),
  unitController.revertOwnershipEvent,
);

router.put('/units/:id',
  csrfProtection,
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  unitController.unitImageUpload,
  unitController.normalizeUnitPayload,
  validateParams(idParamSchema),
  validateBody(updateUnitSchema),
  unitController.updateUnit,
  activityLogger({
    type: 'property',
    title: 'Unit Updated',
    description: (req, res, data) => `Unit "${data.data?.title || 'Unit'}" updated`,
    propertyId: (req, res, data) => data.data?._id,
    isHOAActivity: true
  })
);
router.delete('/units/:id',
  csrfProtection,
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validateParams(idParamSchema),
  unitController.deleteUnit,
  activityLogger({
    type: 'property',
    title: 'Unit Deleted',
    description: (req) => `Unit deleted`,
    isHOAActivity: true
  })
);

// /api/v1/owners/:id - Parameterized routes come LAST
router.get('/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), ownerController.getOwnerById);
router.post(
  '/:id/resend-invite',
  csrfProtection,
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validateParams(idParamSchema),
  ownerController.resendOwnerInvite,
);

router.put('/:id',
  csrfProtection,
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validateParams(idParamSchema),
  ownerController.updateOwner,
  activityLogger({
    type: 'owner',
    title: 'Owner Updated',
    description: (req, res, data) => `Owner "${data.data?.firstName || ''} ${data.data?.lastName || ''}" updated`,
    isHOAActivity: true
  })
);
router.patch('/:id/archive', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), ownerController.archiveOwner);
router.get('/:id/delete-preview', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), ownerController.getOwnerDeletePreview);
router.delete('/:id',
  csrfProtection,
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validateParams(idParamSchema),
  validateBody(deleteOwnerBodySchema),
  ownerController.deleteOwner,
  activityLogger({
    type: 'owner',
    title: 'Owner Deleted',
    description: (req) => `Owner deleted`,
    isHOAActivity: true
  })
);

// /api/v1/owners/:id/notes
router.post('/:id/notes', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), ownerController.addNoteToOwner);
router.put('/:id/notes/:noteId', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, ownerController.updateNoteInOwner);
router.delete('/:id/notes/:noteId', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, ownerController.deleteNoteFromOwner);

module.exports = router;
