const responseHelper = require('../../../../../common/helpers/responseHelper');
const vendorInvoiceService = require('../service/vendorInvoice.service');
const { resolveUserRoleName } = require('../../../../../common/helpers/companyRoleHelper');
const logger = require('../../../../../common/logger');
const {
  notifyVendorInvoiceCreatedInAppInBackground,
  notifyVendorInvoiceUpdatedInAppInBackground,
  notifyVendorInvoiceDeletedInAppInBackground,
} = require('../../../../../common/helpers/hoaInAppNotify.helper');
const {
  notifyVendorInvoiceCreatedEmailInBackground,
} = require('../helpers/vendorInvoiceCreatedEmail.helper');

const MODULE = 'vendor-invoice';

function hoaIdFromRequest(req) {
  return req.hoaContext?.hoaId || null;
}

async function createVendorInvoice(req, res) {
  const userId = req.userId || req.user?._id || req.user?.id;
  try {
    const invoice = await vendorInvoiceService.createVendorInvoice(
      req.body || {},
      userId,
      req.hoaContext || null
    );
    logger.info('Vendor invoice created', { module: MODULE, action: 'createVendorInvoice', userId });
    notifyVendorInvoiceCreatedInAppInBackground(invoice, userId, hoaIdFromRequest(req) || invoice?.hoaId);
    notifyVendorInvoiceCreatedEmailInBackground(invoice, userId);
    return responseHelper.success(res, { invoice }, 'Vendor invoice created', 201);
  } catch (err) {
    logger.error('createVendorInvoice failed', { module: MODULE, error: err.message, userId });
    return responseHelper.error(res, err.message || 'Failed to create vendor invoice', err.status || 500);
  }
}

async function listVendorInvoices(req, res) {
  const userId = req.userId || req.user?._id || req.user?.id;
  try {
    const roleName = req.userRoleName || await resolveUserRoleName(req.authUser || { _id: userId });
    const result = await vendorInvoiceService.listVendorInvoices(
      req.query || {},
      userId,
      req.hoaContext || null,
      roleName
    );
    return responseHelper.success(res, result, 'Vendor invoices fetched', 200);
  } catch (err) {
    logger.error('listVendorInvoices failed', { module: MODULE, error: err.message, userId });
    return responseHelper.error(res, err.message || 'Failed to list vendor invoices', err.status || 500);
  }
}

async function getVendorInvoice(req, res) {
  const userId = req.userId || req.user?._id || req.user?.id;
  try {
    const invoice = await vendorInvoiceService.getVendorInvoiceById(
      req.params.id,
      userId,
      req.hoaContext || null
    );
    return responseHelper.success(res, { invoice }, 'Vendor invoice fetched', 200);
  } catch (err) {
    logger.error('getVendorInvoice failed', { module: MODULE, error: err.message, userId });
    return responseHelper.error(res, err.message || 'Failed to fetch vendor invoice', err.status || 500);
  }
}

async function updateVendorInvoice(req, res) {
  const userId = req.userId || req.user?._id || req.user?.id;
  try {
    const invoice = await vendorInvoiceService.updateVendorInvoice(
      req.params.id,
      req.body || {},
      userId,
      req.hoaContext || null
    );
    logger.info('Vendor invoice updated', { module: MODULE, action: 'updateVendorInvoice', userId });
    notifyVendorInvoiceUpdatedInAppInBackground(invoice, userId, hoaIdFromRequest(req) || invoice?.hoaId);
    return responseHelper.success(res, { invoice }, 'Vendor invoice updated', 200);
  } catch (err) {
    logger.error('updateVendorInvoice failed', { module: MODULE, error: err.message, userId });
    return responseHelper.error(res, err.message || 'Failed to update vendor invoice', err.status || 500);
  }
}

async function deleteVendorInvoice(req, res) {
  const userId = req.userId || req.user?._id || req.user?.id;
  try {
    const invoice = await vendorInvoiceService.deleteVendorInvoice(
      req.params.id,
      userId,
      req.hoaContext || null
    );
    logger.info('Vendor invoice deleted', { module: MODULE, action: 'deleteVendorInvoice', userId });
    notifyVendorInvoiceDeletedInAppInBackground(invoice, userId, hoaIdFromRequest(req) || invoice?.hoaId);
    return responseHelper.success(res, null, 'Vendor invoice deleted', 200);
  } catch (err) {
    logger.error('deleteVendorInvoice failed', { module: MODULE, error: err.message, userId });
    return responseHelper.error(res, err.message || 'Failed to delete vendor invoice', err.status || 500);
  }
}

async function getVendorInvoiceStats(req, res) {
  const userId = req.userId || req.user?._id || req.user?.id;
  try {
    const stats = await vendorInvoiceService.getVendorInvoiceStats(userId, req.hoaContext || null);
    return responseHelper.success(res, { stats }, 'Vendor invoice stats fetched', 200);
  } catch (err) {
    logger.error('getVendorInvoiceStats failed', { module: MODULE, error: err.message, userId });
    return responseHelper.error(res, err.message || 'Failed to fetch stats', err.status || 500);
  }
}

async function getVendorDashboard(req, res) {
  const userId = req.userId || req.user?._id || req.user?.id;
  try {
    const startDate = req.query?.startDate ? String(req.query.startDate).trim() : null;
    const endDate = req.query?.endDate ? String(req.query.endDate).trim() : null;
    const range = startDate && endDate ? { startDate, endDate } : null;
    const dashboard = await vendorInvoiceService.getVendorDashboardStats(
      userId,
      req.hoaContext || null,
      range
    );
    return responseHelper.success(res, { dashboard }, 'Vendor dashboard fetched', 200);
  } catch (err) {
    logger.error('getVendorDashboard failed', { module: MODULE, error: err.message, userId });
    return responseHelper.error(res, err.message || 'Failed to fetch dashboard', err.status || 500);
  }
}

async function listReceivedInvoices(req, res) {
  const userId = req.userId || req.user?._id || req.user?.id;
  try {
    const roleName = req.userRoleName || await resolveUserRoleName(req.authUser || { _id: userId });
    const result = await vendorInvoiceService.listReceivedInvoices(
      req.query || {},
      userId,
      req.hoaContext || null,
      roleName
    );
    return responseHelper.success(res, result, 'Vendor invoices fetched', 200);
  } catch (err) {
    logger.error('listReceivedInvoices failed', { module: MODULE, error: err.message, userId });
    return responseHelper.error(res, err.message || 'Failed to list received invoices', err.status || 500);
  }
}

async function getReceivedInvoiceStats(req, res) {
  const userId = req.userId || req.user?._id || req.user?.id;
  try {
    const stats = await vendorInvoiceService.getReceivedInvoiceStats(userId, req.hoaContext || null);
    return responseHelper.success(res, { stats }, 'Received invoice stats fetched', 200);
  } catch (err) {
    logger.error('getReceivedInvoiceStats failed', { module: MODULE, error: err.message, userId });
    return responseHelper.error(res, err.message || 'Failed to fetch stats', err.status || 500);
  }
}

async function listAssignableUsers(req, res) {
  const userId = req.userId || req.user?._id || req.user?.id;
  try {
    const result = await vendorInvoiceService.listAssignableUsers(
      req.hoaContext || null,
      req.query?.searchText || '',
      req.query?.hoaId || null,
      userId,
      req.query?.maintenanceRequestId || null
    );
    return responseHelper.success(res, result, 'Assignable users fetched', 200);
  } catch (err) {
    logger.error('listAssignableUsers failed', { module: MODULE, error: err.message });
    return responseHelper.error(res, err.message || 'Failed to list users', err.status || 500);
  }
}

async function addVendorInvoiceNote(req, res) {
  const userId = req.userId || req.user?._id || req.user?.id;
  try {
    const invoice = await vendorInvoiceService.addVendorInvoiceNote(
      req.params.id,
      req.body || {},
      userId,
      req.hoaContext || null
    );
    logger.info('Vendor invoice note added', { module: MODULE, action: 'addVendorInvoiceNote', userId });
    return responseHelper.success(res, { invoice }, 'Note added', 201);
  } catch (err) {
    logger.error('addVendorInvoiceNote failed', { module: MODULE, error: err.message, userId });
    return responseHelper.error(res, err.message || 'Failed to add note', err.status || 500);
  }
}

async function updateVendorInvoiceNote(req, res) {
  const userId = req.userId || req.user?._id || req.user?.id;
  try {
    const invoice = await vendorInvoiceService.updateVendorInvoiceNote(
      req.params.id,
      req.params.noteId,
      req.body || {},
      userId,
      req.hoaContext || null
    );
    return responseHelper.success(res, { invoice }, 'Note updated', 200);
  } catch (err) {
    logger.error('updateVendorInvoiceNote failed', { module: MODULE, error: err.message, userId });
    return responseHelper.error(res, err.message || 'Failed to update note', err.status || 500);
  }
}

async function deleteVendorInvoiceNote(req, res) {
  const userId = req.userId || req.user?._id || req.user?.id;
  try {
    const invoice = await vendorInvoiceService.deleteVendorInvoiceNote(
      req.params.id,
      req.params.noteId,
      userId,
      req.hoaContext || null
    );
    return responseHelper.success(res, { invoice }, 'Note deleted', 200);
  } catch (err) {
    logger.error('deleteVendorInvoiceNote failed', { module: MODULE, error: err.message, userId });
    return responseHelper.error(res, err.message || 'Failed to delete note', err.status || 500);
  }
}

module.exports = {
  createVendorInvoice,
  listVendorInvoices,
  getVendorInvoice,
  updateVendorInvoice,
  deleteVendorInvoice,
  addVendorInvoiceNote,
  updateVendorInvoiceNote,
  deleteVendorInvoiceNote,
  getVendorInvoiceStats,
  getVendorDashboard,
  listAssignableUsers,
  listReceivedInvoices,
  getReceivedInvoiceStats,
};
