const responseHelper = require('../../../../../common/helpers/responseHelper');
const vendorService = require('../service/vendor.service');
const { issueVendorPortalInvite } = require('../../../../../shared/modules/auth/services/portalInvitation.service');
const {
  notifyVendorCreatedInAppInBackground,
  notifyVendorUpdatedInAppInBackground,
  notifyVendorDeletedInAppInBackground,
} = require('../../../../../common/helpers/hoaInAppNotify.helper');
const logger = require('../../../../../common/logger');
const { logControllerStep, handleControllerError } = require('../../../../../common/helpers/controllerLogger');

const MODULE = 'vendor-portal';

async function createVendor(req, res) {
  logControllerStep(req, 'START', { action: 'createVendor' });
  const userId = req.userId || req.user?._id || req.user?.id;
  try {
    const result = await vendorService.createVendor(req.body || {}, userId, req.hoaContext || null);
    logger.info('Vendor created', { module: MODULE, action: 'createVendor', userId });

    notifyVendorCreatedInAppInBackground(
      result?.vendor || result?.user || result,
      userId,
      req.hoaContext?.hoaId || null
    );

    if (result.sendInvite && result.user?.id) {
      setImmediate(async () => {
        try {
          await issueVendorPortalInvite({
            inviteeUserId: result.user.id,
            inviterUserId: userId,
            hoaContext: req.hoaContext || null,
          });
          logger.info('Vendor portal invite sent', { module: MODULE, action: 'sendInvite', userId });
        } catch (inviteErr) {
          logger.error('Failed to send vendor portal invite', { module: MODULE, error: inviteErr.message });
        }
      });
    }

    return responseHelper.success(res, result, 'Vendor created', 201);
  } catch (err) {
    logger.error('createVendor failed', { module: MODULE, error: err.message, userId });
    return responseHelper.error(res, err.message || 'Failed to create vendor', err.status || 500);
  }
}

async function listVendors(req, res) {
  logControllerStep(req, 'START', { action: 'listVendors' });
  try {
    const result = await vendorService.listVendors(req.query || {}, req.hoaContext || null);
    return responseHelper.success(res, result, 'Vendors fetched', 200);
  } catch (err) {
    logger.error('listVendors failed', { module: MODULE, error: err.message });
    return responseHelper.error(res, err.message || 'Failed to list vendors', err.status || 500);
  }
}

async function getVendor(req, res) {
  logControllerStep(req, 'START', { action: 'getVendor' });
  try {
    const vendor = await vendorService.getVendorById(req.params.id, req.hoaContext || null);
    return responseHelper.success(res, { vendor }, 'Vendor fetched', 200);
  } catch (err) {
    logger.error('getVendor failed', { module: MODULE, error: err.message });
    return responseHelper.error(res, err.message || 'Failed to fetch vendor', err.status || 500);
  }
}

async function updateVendor(req, res) {
  logControllerStep(req, 'START', { action: 'updateVendor' });
  const userId = req.userId || req.user?._id || req.user?.id;
  try {
    const vendor = await vendorService.updateVendor(
      req.params.id,
      req.body || {},
      req.hoaContext || null
    );
    logger.info('Vendor updated', { module: MODULE, action: 'updateVendor', userId });
    notifyVendorUpdatedInAppInBackground(vendor, userId, req.hoaContext?.hoaId || null);
    return responseHelper.success(res, { vendor }, 'Vendor updated', 200);
  } catch (err) {
    logger.error('updateVendor failed', { module: MODULE, error: err.message, userId });
    return responseHelper.error(res, err.message || 'Failed to update vendor', err.status || 500);
  }
}

async function deleteVendor(req, res) {
  logControllerStep(req, 'START', { action: 'deleteVendor' });
  const userId = req.userId || req.user?._id || req.user?.id;
  try {
    const vendor = await vendorService.getVendorById(req.params.id, req.hoaContext || null);
    await vendorService.deleteVendor(req.params.id, req.hoaContext || null);
    logger.info('Vendor deleted', { module: MODULE, action: 'deleteVendor', userId });
    notifyVendorDeletedInAppInBackground(vendor, userId, req.hoaContext?.hoaId || null);
    return responseHelper.success(res, null, 'Vendor deleted', 200);
  } catch (err) {
    logger.error('deleteVendor failed', { module: MODULE, error: err.message, userId });
    return responseHelper.error(res, err.message || 'Failed to delete vendor', err.status || 500);
  }
}

async function sendVendorInvite(req, res) {
  logControllerStep(req, 'START', { action: 'sendVendorInvite' });
  const inviterUserId = req.userId || req.user?._id || req.user?.id;
  const inviteeUserId = req.params.id;
  try {
    const result = await issueVendorPortalInvite({
      inviteeUserId,
      inviterUserId,
      hoaContext: req.hoaContext || null,
    });
    logger.info('Vendor invite sent', { module: MODULE, action: 'sendVendorInvite', userId: inviterUserId });
    return responseHelper.success(res, result, 'Vendor invite sent', 200);
  } catch (err) {
    logger.error('sendVendorInvite failed', { module: MODULE, error: err.message, userId: inviterUserId });
    return responseHelper.error(res, err.message || 'Failed to send vendor invite', err.status || 500);
  }
}

module.exports = {
  createVendor,
  listVendors,
  getVendor,
  updateVendor,
  deleteVendor,
  sendVendorInvite,
};
