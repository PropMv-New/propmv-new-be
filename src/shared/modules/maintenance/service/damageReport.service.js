/**
 * ------------------------------------------------------------------
 * File: damageReport.service.js
 * Module: Maintenance Module
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * damageReport.controller
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const DamageReport = require('../model/damageReport.model');
const logger = require('../../../../common/logger');

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}
const s3Client = require('../../../../integrations/s3');
const DocumentMetadata = require('../../../../shared/modules/documents/model/documentMetadata.model');
const { withMaintenanceTransaction, applySession } = require('./maintenanceDb.util');
const { ClockService } = require('../../../../common/date');

async function cleanupDamageReportMetadata(uploadedMetadata) {
  for (const meta of uploadedMetadata || []) {
    try {
      const safeMetadataId = toObjectId(meta.metadataId);
      if (!safeMetadataId) continue;
      const doc = await DocumentMetadata.findById(safeMetadataId).lean();
      if (doc?.key) await s3Client.delete({ key: doc.key });
      await DocumentMetadata.deleteOne({ _id: safeMetadataId });
    } catch (cleanupErr) {
      logger.error('Cleanup error:', cleanupErr);
    }
  }
}

async function stageDamageReportFiles(files, data, options, session) {
  const uploadedMetadata = [];
  if (!files || files.length === 0) {
    return uploadedMetadata;
  }

  let totalAttachments = 0;
  for (const item of data.items) {
    totalAttachments += (item.attachments || []).length;
  }
  if (totalAttachments + files.length > 100) {
    const err = new Error('maximum 100 photos allowed per damage report');
    err.status = 400;
    throw err;
  }

  const cfg = require('../../../../config/default');
  const bucketName = cfg.s3?.bucket || process.env.S3_BUCKET || 'mock-bucket';
  const region = cfg.s3?.region || process.env.AWS_REGION || 'mock-region';
  const userId = options.userId || null;

  for (const file of files) {
    const filename = file.filename || file.originalname;
    const key = s3Client.getKey ? s3Client.getKey('damageReport', filename, userId) : `damage-reports/${filename}`;
    const s3Result = await s3Client.upload({ localFilePath: file.path, key });

    const metadataDoc = await DocumentMetadata.create(
      [
        {
          key: s3Result?.Key || key,
          s3Location: s3Result?.Location,
          bucketName,
          region,
          size: file.size || 0,
          contentType: file.mimetype || 'application/octet-stream',
          originalName: file.originalname || filename,
        },
      ],
      { session }
    );

    uploadedMetadata.push({
      metadataId: metadataDoc[0]._id,
      originalName: file.originalname,
      uploadedAt: ClockService.now(),
    });
  }

  return uploadedMetadata;
}

/**
 * assign Uploaded Files To Items
 *
 * Performs logic operations for assignUploadedFilesToItems.
 *
 * @param data - Request/input argument
 * @param uploadedMetadata - Request/input argument
 * @returns Operations result
 */
function assignUploadedFilesToItems(data, uploadedMetadata) {
  let fileIndex = 0;
  for (const item of data.items) {
    item.attachments = item.attachments || [];
    const itemFileCount = parseInt(item.fileCount || 0, 10);
    for (let i = 0; i < itemFileCount && fileIndex < uploadedMetadata.length; i++) {
      item.attachments.push(uploadedMetadata[fileIndex++]);
    }
  }
}

/**
 * validate Damage Report Payload
 *
 * Performs logic operations for validateDamageReportPayload.
 *
 * @param data - Request/input argument
 * @param options - Request/input argument
 * @returns Operations result
 */
function validateDamageReportPayload(data, options) {
  if (!data.location) {
    const err = new Error('location is required');
    err.status = 400;
    throw err;
  }
  if (!data.items || !Array.isArray(data.items) || data.items.length === 0) {
    const err = new Error('at least one item is required');
    err.status = 400;
    throw err;
  }
  if (!options.userId) {
    const err = new Error('userId is required');
    err.status = 401;
    throw err;
  }
  for (const item of data.items) {
    if (!item.title) {
      const err = new Error('item title is required');
      err.status = 400;
      throw err;
    }
    if (!item.condition) {
      const err = new Error('item condition is required');
      err.status = 400;
      throw err;
    }
  }
}

async function createDamageReport(data, files, options = {}) {
  let uploadedMetadata = [];
  try {
    const saved = await withMaintenanceTransaction(async (session) => {
      validateDamageReportPayload(data, options);
      uploadedMetadata = await stageDamageReportFiles(files, data, options, session);
      assignUploadedFilesToItems(data, uploadedMetadata);
      const report = new DamageReport({
        location: data.location,
        unit: data.unit,
        items: data.items,
        property_id: data.property_id,
        createdBy: options.userId,
      });
      return report.save({ session });
    }, options);
    return DamageReport.findById(saved._id).populate('createdBy', 'firstName lastName email');
  } catch (error) {
    await cleanupDamageReportMetadata(uploadedMetadata);
    throw error;
  }
}

async function getDamageReportById(id) {
  if (id === 'request') {
    const err = new Error('Routing conflict: maintenance request endpoint incorrectly routed to damage report service');
    err.status = 500;
    throw err;
  }

  if (!mongoose.Types.ObjectId.isValid(id)) {
    const err = new Error('invalid damage report ID');
    err.status = 400;
    throw err;
  }

  const report = await DamageReport.findById(id)
    .populate('createdBy', 'firstName lastName email')
    .populate('items.attachments.metadataId');

  if (!report) {
    const err = new Error('damage report not found');
    err.status = 404;
    throw err;
  }

  return report;
}

async function listDamageReports(queryParams = {}) {
  if (queryParams.unit && !queryParams.property_id) {
    const err = new Error('property_id is required when filtering by unit');
    err.status = 400;
    throw err;
  }

  const { getPagination } = require('../../../../common/helpers/paginationHelper');
  const { offset, limit, page, pageSize: effectivePageSize } = getPagination({
    page: queryParams.pageNumber,
    pageSize: queryParams.pageSize,
  });

  const query = {};
  if (queryParams.property_id) {
    const pid = toObjectId(queryParams.property_id);
    if (!pid) { const e = new Error('Invalid property_id'); e.status = 400; throw e; }
    query.property_id = pid;
  }
  if (queryParams.location) {
    const escaped = String(queryParams.location).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.location = { $regex: escaped, $options: 'i' };
  }
  if (queryParams.unit) query.unit = String(queryParams.unit).trim();
  if (queryParams.createdBy) {
    const cid = toObjectId(queryParams.createdBy);
    if (!cid) { const e = new Error('Invalid createdBy'); e.status = 400; throw e; }
    query.createdBy = cid;
  }

  const [reports, total] = await Promise.all([
    DamageReport.find(query)
      .sort({ createdAt: -1 })
      .populate('createdBy', 'firstName lastName email')
      .skip(offset)
      .limit(limit)
      .lean(),
    DamageReport.countDocuments(query),
  ]);

  return { data: reports, total, page, pageSize: effectivePageSize };
}

async function updateDamageReport(id, data, files, options = {}) {
  let uploadedMetadata = [];
  try {
    await withMaintenanceTransaction(async (session) => {
      if (!mongoose.Types.ObjectId.isValid(id)) {
        const err = new Error('invalid damage report ID');
        err.status = 400;
        throw err;
      }

      const safeId = toObjectId(id);
      const report = await applySession(DamageReport.findById(safeId), session);
      if (!report) {
        const err = new Error('damage report not found');
        err.status = 404;
        throw err;
      }

      if (data.location) report.location = data.location;
      if (data.unit) report.unit = data.unit;

      if (data.items) {
        if (!Array.isArray(data.items) || data.items.length === 0) {
          const err = new Error('at least one item is required');
          err.status = 400;
          throw err;
        }

        for (const item of data.items) {
          if (!item.title) {
            const err = new Error('item title is required');
            err.status = 400;
            throw err;
          }
          if (!item.condition) {
            const err = new Error('item condition is required');
            err.status = 400;
            throw err;
          }
        }

        if (files && files.length > 0) {
          uploadedMetadata = await stageDamageReportFiles(files, data, options, session);
          assignUploadedFilesToItems(data, uploadedMetadata);
        }

        report.items = data.items;
      }

      if (data.property_id) {
        const safePid = toObjectId(data.property_id);
        if (!safePid) { const e = new Error('Invalid property_id'); e.status = 400; throw e; }
        report.property_id = safePid;
      }

      await report.save({ session });
    }, options);
    return DamageReport.findById(toObjectId(id)).populate('createdBy', 'firstName lastName email');
  } catch (error) {
    await cleanupDamageReportMetadata(uploadedMetadata);
    throw error;
  }
}

async function deleteDamageReportInSession(id, session) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const err = new Error('invalid damage report ID');
    err.status = 400;
    throw err;
  }

  const report = await applySession(DamageReport.findByIdAndDelete(id), session);
  if (!report) {
    const err = new Error('damage report not found');
    err.status = 404;
    throw err;
  }
  return report;
}

async function deleteDamageReport(id, options = {}) {
  return withMaintenanceTransaction((session) => deleteDamageReportInSession(id, session), options);
}

module.exports = {
  createDamageReport,
  getDamageReportById,
  listDamageReports,
  updateDamageReport,
  deleteDamageReport,
};
