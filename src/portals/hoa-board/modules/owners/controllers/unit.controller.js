/**
 * ------------------------------------------------------------------
 * File: unit.controller.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * owner.routes
 * ------------------------------------------------------------------
 */

const unitService = require('../services/unit.service');
const responseHelper = require('../../../../../common/helpers/responseHelper');
const { isHOABoardMemberRole } = require('../../../../../common/helpers/hoaBoardRole');
const User = require('../../../../../shared/modules/users/models/user.model');
const logger = require('../../../../../common/logger');
const { createUpload } = require('../../../../../common/helpers/uploadHelper');

const { uploadArray: unitImageUpload } = createUpload('images', 'property-images', {
  maxCount: 5,
  maxSizeBytes: 10 * 1024 * 1024
});

const toArray = (value) => {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .map((item) => String(item).trim())
    .filter((item) => {
      if (!item) return false;
      const lowered = item.toLowerCase();
      return lowered !== 'undefined' && lowered !== 'null';
    });
};

const parseJsonObject = (value) => {
  if (!value || typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    return null;
  }
};

const normalizeUnitPayload = (req, res, next) => {
  const body = req.body || {};

  const normalizedAddress = parseJsonObject(body.address) || (typeof body.address === 'object' ? body.address : {});
  const bracketAddress = {
    line1: body['address[line1]'],
    line2: body['address[line2]'],
    city: body['address[city]'],
    state: body['address[state]'],
    zipCode: body['address[zipCode]']
  };

  const hasBracketAddress = Object.values(bracketAddress).some((value) => value !== undefined);
  if (hasBracketAddress) {
    body.address = {
      ...normalizedAddress,
      ...Object.fromEntries(Object.entries(bracketAddress).filter(([, value]) => value !== undefined))
    };
  } else if (Object.keys(normalizedAddress).length > 0) {
    body.address = normalizedAddress;
  }

  delete body['address[line1]'];
  delete body['address[line2]'];
  delete body['address[city]'];
  delete body['address[state]'];
  delete body['address[zipCode]'];

  // const normalizedEmergencyContact = parseJsonObject(body.emergencyContact)
  //   || (typeof body.emergencyContact === 'object' ? body.emergencyContact : {});
  // const bracketEmergency = {
  //   name: body['emergencyContact[name]'],
  //   firstName: body['emergencyContact[firstName]'],
  //   lastName: body['emergencyContact[lastName]'],
  //   phone: body['emergencyContact[phone]'],
  //   email: body['emergencyContact[email]']
  // };

  // const hasBracketEmergency = Object.values(bracketEmergency).some((value) => value !== undefined);
  // if (hasBracketEmergency) {
  //   body.emergencyContact = {
  //     ...normalizedEmergencyContact,
  //     ...Object.fromEntries(Object.entries(bracketEmergency).filter(([, value]) => value !== undefined))
  //   };
  // } else if (Object.keys(normalizedEmergencyContact).length > 0) {
  //   body.emergencyContact = normalizedEmergencyContact;
  // }

  // delete body['emergencyContact[name]'];
  // delete body['emergencyContact[firstName]'];
  // delete body['emergencyContact[lastName]'];
  // delete body['emergencyContact[phone]'];
  // delete body['emergencyContact[email]'];

  const tags = body['tags[]'] !== undefined ? body['tags[]'] : body.tags;
  if (tags !== undefined) {
    body.tags = toArray(tags);
  }
  delete body['tags[]'];

  const associatedOwnerIds = body['associatedOwnerIds[]'] !== undefined
    ? body['associatedOwnerIds[]']
    : body.associatedOwnerIds;
  if (associatedOwnerIds !== undefined) {
    body.associatedOwnerIds = toArray(associatedOwnerIds);
  }
  delete body['associatedOwnerIds[]'];

  const ownerIds = body['ownerIds[]'] !== undefined ? body['ownerIds[]'] : body.ownerIds;
  if (ownerIds !== undefined) {
    body.ownerIds = toArray(ownerIds);
  }
  delete body['ownerIds[]'];

  req.body = body;
  next();
};

const createUnit = async (req, res) => {
  try {
    const unitData = req.body || {};
    const userId = req.user?._id;
    const files = req.files || [];
    const hoaContext = req.hoaContext || null;

    if (hoaContext?.hoaId) {
      unitData.hoaId = hoaContext.hoaId;
    }
    if (hoaContext?.userId || userId) {
      unitData.createdBy = unitData.createdBy || hoaContext?.userId || userId;
      unitData.hoaBoardMemberId = unitData.hoaBoardMemberId || hoaContext?.userId || userId;
    }

    logger.info('[createUnit] Full req.body:', JSON.stringify(req.body, null, 2));

    // Normalize associatedOwnerIds - multer sends single value as string, multiple as array
    // Also handle the case where it comes as 'associatedOwnerIds[]' from form-data
    if (unitData['associatedOwnerIds[]']) {
      const raw = unitData['associatedOwnerIds[]'];
      unitData.associatedOwnerIds = Array.isArray(raw) ? raw : [raw];
      delete unitData['associatedOwnerIds[]'];
      logger.info('[createUnit] Normalized associatedOwnerIds[] to:', unitData.associatedOwnerIds);
    } else if (typeof unitData.associatedOwnerIds === 'string') {
      // Single value as string
      unitData.associatedOwnerIds = unitData.associatedOwnerIds.trim() ? [unitData.associatedOwnerIds] : [];
      logger.info('[createUnit] Converted string associatedOwnerIds to array:', unitData.associatedOwnerIds);
    } else if (Array.isArray(unitData.associatedOwnerIds)) {
      // Already an array, filter out empty strings
      unitData.associatedOwnerIds = unitData.associatedOwnerIds.filter(id => id && id.trim());
      logger.info('[createUnit] associatedOwnerIds is already an array:', unitData.associatedOwnerIds);
    } else if (!unitData.associatedOwnerIds) {
      unitData.associatedOwnerIds = [];
      logger.info('[createUnit] No associatedOwnerIds provided, defaulting to empty array');
    }

    // Also check for ownerIds field (alternative field name used in updates)
    if (unitData.ownerIds && Array.isArray(unitData.ownerIds) && unitData.ownerIds.length > 0) {
      logger.info('[createUnit] Found ownerIds field, merging with associatedOwnerIds');
      const allOwnerIds = [...new Set([...(unitData.associatedOwnerIds || []), ...unitData.ownerIds])];
      unitData.associatedOwnerIds = allOwnerIds.filter(id => id && id.trim());
    }

    logger.info('[createUnit] Final unitData:', {
      ownerIds: unitData.ownerIds,
      associatedOwnerIds: unitData.associatedOwnerIds,
      associatedOwnerIdsLength: unitData.associatedOwnerIds?.length,
      filesCount: files.length,
      monthlyRecurringFee: unitData.monthlyRecurringFee,
      paymentTerm: unitData.paymentTerm
    });

    // Check if user is HOA Board Member and set landlordId
    if (userId) {
      const { fetchUserWithResolvedRole } = require('../../../../../common/helpers/companyRoleHelper');
      const { role } = await fetchUserWithResolvedRole(userId, 'role companyId companyRoleId');
      const userRole = role?.name || null;

      if (isHOABoardMemberRole(userRole)) {
        unitData.landlordId = userId;
        logger.info('Set landlordId to:', unitData.landlordId);
      }
    }

    const serviceOptions = { hoaContext };
    const created = files.length > 0
      ? await unitService.createUnitWithImages(unitData, files, serviceOptions)
      : await unitService.createUnit(unitData, serviceOptions);
    return responseHelper.success(res, { unit: created }, 'Unit created successfully', 201);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

const updateUnit = async (req, res) => {
  try {
    const { id } = req.params;
    const unitData = req.body || {};
    const files = req.files || [];
    const actorUserId = req.user?._id || req.user?.id || null;
    const serviceOptions = { userId: actorUserId, hoaContext: req.hoaContext || null };

    const updated = files.length > 0
      ? await unitService.updateUnitWithImages(id, unitData, files, serviceOptions)
      : await unitService.updateUnit(id, unitData, serviceOptions);
    return responseHelper.success(res, { unit: updated }, 'Unit updated successfully', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

const addOwner = async (req, res) => {
  try {
    const { id } = req.params;
    const actorId = req.user?._id;
    const result = await unitService.addOwner(id, req.body || {}, actorId);
    return responseHelper.success(res, result, 'Owner added successfully', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, err.status || 500);
  }
};

const removeOwner = async (req, res) => {
  try {
    const { id } = req.params;
    const actorId = req.user?._id;
    const result = await unitService.removeOwner(id, req.body || {}, actorId);
    return responseHelper.success(res, result, 'Owner removed successfully', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, err.status || 500);
  }
};

const changeOwnership = async (req, res) => {
  try {
    const { id } = req.params;
    const actorId = req.user?._id;
    const result = await unitService.changeOwnership(id, req.body || {}, actorId);
    return responseHelper.success(res, result, 'Ownership changed successfully', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, err.status || 500);
  }
};

const getOwnershipEventRevertPreview = async (req, res) => {
  try {
    const { id, logId } = req.params;
    const preview = await unitService.getOwnershipEventRevertPreview(id, logId);
    return responseHelper.success(res, preview, 'Ownership revert preview loaded', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, err.status || 500);
  }
};

const revertOwnershipEvent = async (req, res) => {
  try {
    const { id, logId } = req.params;
    const actorId = req.user?._id;
    const result = await unitService.revertOwnershipEvent(id, logId, actorId);
    return responseHelper.success(res, result, 'Ownership event reverted successfully', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, err.status || 500);
  }
};

const deleteUnit = async (req, res) => {
  try {
    const { id } = req.params;
    const actorId = req.user?._id;
    const result = await unitService.deleteUnit(id, { userId: actorId });
    return responseHelper.success(res, result, 'Unit deleted successfully', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

const getUnitById = async (req, res) => {
  try {
    const { id } = req.params;
    const unit = await unitService.getUnitById(id, { hoaContext: req.hoaContext });
    return responseHelper.success(res, { unit }, 'Unit retrieved successfully', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

module.exports = {
  createUnit,
  getUnitById,
  updateUnit,
  addOwner,
  removeOwner,
  changeOwnership,
  getOwnershipEventRevertPreview,
  revertOwnershipEvent,
  deleteUnit,
  unitImageUpload,
  normalizeUnitPayload
};
