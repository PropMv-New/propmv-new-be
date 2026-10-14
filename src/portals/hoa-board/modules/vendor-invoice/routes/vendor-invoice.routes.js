const express = require('express');
const router = express.Router();
const authMiddleware = require('../../../../../middleware/auth');
const authorize = require('../../../../../middleware/authorize');
const { validateBody, validateQuery, validateParams } = require('../../../../../common/middleware/requestValidator');
const controller = require('../controller/vendorInvoice.controller');
const {
  idParamSchema,
  createVendorInvoiceSchema,
  updateVendorInvoiceSchema,
  listQuerySchema,
  noteIdParamSchema,
  entityNotePayloadSchema,
  updateEntityNoteSchema,
} = require('../validators/vendorInvoice.validator');
const Joi = require('joi');

const assignableQuerySchema = Joi.object({
  searchText: Joi.string().trim().max(200).optional().allow(''),
  hoaId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  maintenanceRequestId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
});

router.get(
  '/received/statistics',
  authMiddleware,
  authorize,
  controller.getReceivedInvoiceStats
);

router.get(
  '/received',
  authMiddleware,
  authorize,
  validateQuery(listQuerySchema),
  controller.listReceivedInvoices
);

router.get(
  '/dashboard',
  authMiddleware,
  authorize,
  controller.getVendorDashboard
);

router.get(
  '/statistics',
  authMiddleware,
  authorize,
  controller.getVendorInvoiceStats
);

router.get(
  '/assignable-users',
  authMiddleware,
  authorize,
  validateQuery(assignableQuerySchema),
  controller.listAssignableUsers
);

router.post(
  '/',
  authMiddleware,
  authorize,
  validateBody(createVendorInvoiceSchema),
  controller.createVendorInvoice
);

router.get(
  '/',
  authMiddleware,
  authorize,
  validateQuery(listQuerySchema),
  controller.listVendorInvoices
);

router.get(
  '/:id',
  authMiddleware,
  authorize,
  validateParams(idParamSchema),
  controller.getVendorInvoice
);

router.put(
  '/:id',
  authMiddleware,
  authorize,
  validateParams(idParamSchema),
  validateBody(updateVendorInvoiceSchema),
  controller.updateVendorInvoice
);

router.post(
  '/:id/notes',
  authMiddleware,
  authorize,
  validateParams(idParamSchema),
  validateBody(entityNotePayloadSchema),
  controller.addVendorInvoiceNote
);

router.put(
  '/:id/notes/:noteId',
  authMiddleware,
  authorize,
  validateParams(noteIdParamSchema),
  validateBody(updateEntityNoteSchema),
  controller.updateVendorInvoiceNote
);

router.delete(
  '/:id/notes/:noteId',
  authMiddleware,
  authorize,
  validateParams(noteIdParamSchema),
  controller.deleteVendorInvoiceNote
);

router.delete(
  '/:id',
  authMiddleware,
  authorize,
  validateParams(idParamSchema),
  controller.deleteVendorInvoice
);

module.exports = router;
