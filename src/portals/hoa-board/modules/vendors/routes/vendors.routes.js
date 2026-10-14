const express = require('express');
const router = express.Router();
const authMiddleware = require('../../../../../middleware/auth');
const authorize = require('../../../../../middleware/authorize');
const { validateBody, validateQuery, validateParams } = require('../../../../../common/middleware/requestValidator');
const controller = require('../controller/vendor.controller');
const {
  idParamSchema,
  createVendorSchema,
  updateVendorSchema,
  listQuerySchema,
} = require('../validators/vendor.validator');

router.post('/', authMiddleware, authorize, validateBody(createVendorSchema), controller.createVendor);
router.get('/', authMiddleware, authorize, validateQuery(listQuerySchema), controller.listVendors);
router.get('/:id', authMiddleware, authorize, validateParams(idParamSchema), controller.getVendor);
router.put('/:id', authMiddleware, authorize, validateParams(idParamSchema), validateBody(updateVendorSchema), controller.updateVendor);
router.delete('/:id', authMiddleware, authorize, validateParams(idParamSchema), controller.deleteVendor);
router.post('/:id/invite', authMiddleware, authorize, validateParams(idParamSchema), controller.sendVendorInvite);

module.exports = router;
