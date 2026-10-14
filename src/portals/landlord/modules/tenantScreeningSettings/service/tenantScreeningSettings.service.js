/**
 * ------------------------------------------------------------------
 * File: tenantScreeningSettings.service.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * tenantScreeningSettings.controller
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const logger = require('../../../../../common/logger');

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

const TenantScreeningSettings = require('../models/tenantScreeningSettings.model');
const User = require('../../../../../shared/modules/users/models/user.model');
const {
  buildPropertyOwnerFilter,
  requireCreatedBy,
  resolveCreatedBy,
} = require('../../../../../shared/utils/creatorScope.util');
const { ClockService, DateUtil, MS_PER_DAY } = require('../../../../../common/date');

/**
 * Create new screening settings with all three options
 */
async function createScreeningSettings(payload = {}, createdBy) {
  const ownerId = requireCreatedBy({ createdBy });
  if (!ownerId) {
    const err = new Error('createdBy is required');
    err.status = 400;
    throw err;
  }

  try {
    // Use screening options from payload, no defaults
    if (!payload.screeningOptions || !Array.isArray(payload.screeningOptions) || payload.screeningOptions.length === 0) {
      const err = new Error('screeningOptions array is required in request body');
      err.status = 400;
      throw err;
    }

    const settingsData = {
      createdBy: ownerId,
      screeningOptions: payload.screeningOptions,
      selectedOption: payload.selectedOption || 'application_only',
      includeIncomeVerification: payload.includeIncomeVerification !== undefined ? payload.includeIncomeVerification : false,
      useMultipleTemplates: payload.useMultipleTemplates !== undefined ? payload.useMultipleTemplates : false,
      includeCriminalHistory: payload.includeCriminalHistory !== undefined ? payload.includeCriminalHistory : false,
      property_id: payload.property_id || null,
      // Set expiration to 30 days for security (optional)
      expiresAt: payload.expiresAt || DateUtil.fromEpoch(ClockService.nowEpoch() + 30 * MS_PER_DAY),
    };

    const settings = await TenantScreeningSettings.create(settingsData);

    logger.info(`Screening settings created with ID: ${settings._id}`);

    return {
      _id: settings._id,
      createdBy: settings.createdBy,
      screeningOptions: settings.screeningOptions,
      selectedOption: settings.selectedOption,
      includeIncomeVerification: settings.includeIncomeVerification,
      useMultipleTemplates: settings.useMultipleTemplates,
      includeCriminalHistory: settings.includeCriminalHistory,
      property_id: settings.property_id,
      createdAt: settings.createdAt,
      expiresAt: settings.expiresAt,
    };
  } catch (err) {
    logger.error('Error creating screening settings:', err);
    throw err;
  }
}

/**
 * Get screening settings by ID (with optional landlord verification)
 */
async function getScreeningSettingsById(settingsId, createdBy = null) {
  if (!settingsId) {
    const err = new Error('Settings ID is required');
    err.status = 400;
    throw err;
  }

  if (!mongoose.Types.ObjectId.isValid(String(settingsId))) {
    const err = new Error('Invalid settings ID');
    err.status = 400;
    throw err;
  }

  try {
    const settingsOid = toObjectId(settingsId);
    if (!settingsOid) { const err = new Error('Invalid settings ID'); err.status = 400; throw err; }

    const query = {
      _id: settingsOid,
      isDeleted: { $ne: true },
    };

    // If createdBy provided, verify ownership
    if (createdBy) {
      Object.assign(query, buildPropertyOwnerFilter(createdBy));
    }

    // Include expiration check for public access (no createdBy provided)
    if (!createdBy) {
      query.expiresAt = { $gt: ClockService.now() };
    }

    const settings = await TenantScreeningSettings.findOne(query)
      .populate('createdBy', 'firstName lastName email')
      .lean();

    if (!settings) {
      const err = new Error('Screening settings not found or have expired');
      err.status = 404;
      throw err;
    }

    if (!settings.createdBy) {
      const ownerId = resolveCreatedBy(settings);
      if (ownerId) {
        const ownerOid = toObjectId(ownerId);
        const owner = ownerOid
          ? await User.findOne({ _id: ownerOid, isDeleted: { $ne: true } })
            .select('firstName lastName email')
            .lean()
          : null;
        if (owner) {
          settings.createdBy = owner;
        }
      }
    }

    return settings;
  } catch (err) {
    logger.error('Error retrieving screening settings:', err);
    throw err;
  }
}

/**
 * Get screening settings by creator
 */
async function getScreeningSettingsByCreator(createdBy, filters = {}) {
  if (!createdBy) {
    const err = new Error('createdBy is required');
    err.status = 400;
    throw err;
  }

  const ownerId = requireCreatedBy({ createdBy });

  try {
    const pageNumber = filters.pageNumber || 1;
    const pageSize = filters.pageSize || 10;
    const skip = (pageNumber - 1) * pageSize;

    const query = {
      ...buildPropertyOwnerFilter(ownerId),
      isDeleted: { $ne: true },
    };

    // Filter by property if provided
    if (filters.propertyId) {
      const propOid = toObjectId(filters.propertyId);
      if (!propOid) { const err = new Error('Invalid propertyId'); err.status = 400; throw err; }
      query.property_id = propOid;
    }

    const [settings, total] = await Promise.all([
      TenantScreeningSettings.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      TenantScreeningSettings.countDocuments(query),
    ]);

    return {
      items: settings,
      total,
      pageNumber,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  } catch (err) {
    logger.error('Error retrieving screening settings by creator:', err);
    throw err;
  }
}

/**
 * Update screening settings
 */
async function updateScreeningSettings(settingsId, payload = {}, createdBy) {
  if (!settingsId) {
    const err = new Error('Settings ID is required');
    err.status = 400;
    throw err;
  }

  if (!mongoose.Types.ObjectId.isValid(String(settingsId))) {
    const err = new Error('Invalid settings ID');
    err.status = 400;
    throw err;
  }

  if (!createdBy) {
    const err = new Error('createdBy is required');
    err.status = 400;
    throw err;
  }

  const ownerId = requireCreatedBy({ createdBy });

  try {
    // Build update data from payload - only include fields that are provided
    const updateData = {
      updatedAt: ClockService.now(),
    };

    // Update screening options if provided
    if (payload.screeningOptions !== undefined) {
      updateData.screeningOptions = payload.screeningOptions;
    }

    // Update selected option if provided
    if (payload.selectedOption !== undefined) {
      updateData.selectedOption = payload.selectedOption;
    }

    // Update boolean flags if provided
    if (payload.includeIncomeVerification !== undefined) {
      updateData.includeIncomeVerification = payload.includeIncomeVerification;
    }

    if (payload.useMultipleTemplates !== undefined) {
      updateData.useMultipleTemplates = payload.useMultipleTemplates;
    }

    if (payload.includeCriminalHistory !== undefined) {
      updateData.includeCriminalHistory = payload.includeCriminalHistory;
    }

    // Update property_id if provided
    if (payload.property_id !== undefined) {
      updateData.property_id = payload.property_id;
    }

    // Update expiresAt if provided
    if (payload.expiresAt !== undefined) {
      updateData.expiresAt = payload.expiresAt;
    }

    const updateOid = toObjectId(settingsId);
    if (!updateOid) { const err = new Error('Invalid settings ID'); err.status = 400; throw err; }
    const opts = { new: true, runValidators: true };
    const updated = await TenantScreeningSettings.findOneAndUpdate(
      {
        _id: updateOid,
        ...buildPropertyOwnerFilter(ownerId),
        isDeleted: { $ne: true },
      },
      { $set: updateData },
      opts
    ).lean();

    if (!updated) {
      const err = new Error('Screening settings not found');
      err.status = 404;
      throw err;
    }

    logger.info(`Screening settings ${settingsId} updated`);

    return updated;
  } catch (err) {
    logger.error('Error updating screening settings:', err);
    throw err;
  }
}

/**
 * Delete (soft) screening settings
 */
async function deleteScreeningSettings(settingsId, createdBy) {
  if (!settingsId) {
    const err = new Error('Settings ID is required');
    err.status = 400;
    throw err;
  }

  if (!mongoose.Types.ObjectId.isValid(String(settingsId))) {
    const err = new Error('Invalid settings ID');
    err.status = 400;
    throw err;
  }

  if (!createdBy) {
    const err = new Error('createdBy is required');
    err.status = 400;
    throw err;
  }

  const ownerId = requireCreatedBy({ createdBy });

  try {
    const deleteOid = toObjectId(settingsId);
    if (!deleteOid) { const err = new Error('Invalid settings ID'); err.status = 400; throw err; }
    const deleted = await TenantScreeningSettings.findOneAndUpdate(
      {
        _id: deleteOid,
        ...buildPropertyOwnerFilter(ownerId),
        isDeleted: { $ne: true },
      },
      { $set: { isDeleted: true, updatedAt: ClockService.now() } },
      { new: true }
    ).lean();

    if (!deleted) {
      const err = new Error('Screening settings not found');
      err.status = 404;
      throw err;
    }

    logger.info(`Screening settings ${settingsId} deleted`);

    return { message: 'Screening settings deleted successfully' };
  } catch (err) {
    logger.error('Error deleting screening settings:', err);
    throw err;
  }
}

module.exports = {
  createScreeningSettings,
  getScreeningSettingsById,
  getScreeningSettingsByCreator,
  updateScreeningSettings,
  deleteScreeningSettings,
};
