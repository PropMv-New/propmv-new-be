/**
 * ------------------------------------------------------------------
 * File: unitImportExport.controller.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * owner.routes
 * ------------------------------------------------------------------
 */

const importExportService = require('../services/unitImportExport.service');
const responseHelper = require('../../../../../common/helpers/responseHelper');
const { createUpload } = require('../../../../../common/helpers/uploadHelper');
const { ClockService, DateUtil } = require('../../../../../common/date');

const importUpload = createUpload('import', 'uploads/imports', {
  maxCount: 1,
  maxSizeBytes: 10 * 1024 * 1024,
  allowedMimeTypes: [
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/json',
  ],
});

function parseIdList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((id) => String(id).trim()).filter(Boolean);
  }
  return String(value)
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

const startImport = async (req, res) => {
  importUpload.uploadArray(req, res, async (err) => {
    if (err) {
      return responseHelper.error(res, err.message || 'File upload failed', 400);
    }

    try {
      const file = req.files?.[0];
      if (!file) {
        return responseHelper.error(res, 'No file uploaded', 400);
      }

      const { format } = req.query;
      if (!format || !['csv', 'xlsx', 'json'].includes(format)) {
        return responseHelper.error(res, 'Invalid format. Must be csv, xlsx, or json', 400);
      }

      const userId = req.user?._id || req.user?.id;
      const hoaContext = req.hoaContext || null;
      if (!hoaContext?.hoaId) {
        return responseHelper.error(res, 'Active HOA community is required for unit import', 400);
      }

      const defaultDepositBankAccountId =
        req.body?.defaultDepositBankAccountId || req.query?.defaultDepositBankAccountId || '';
      const allowedDepositBankAccountIds = parseIdList(
        req.body?.allowedDepositBankAccountIds || req.query?.allowedDepositBankAccountIds
      );

      const result = await importExportService.startImport(
        file.path,
        file.originalname,
        format,
        userId,
        hoaContext,
        {
          defaultDepositBankAccountId,
          allowedDepositBankAccountIds,
        }
      );

      return responseHelper.success(res, result, 'Import started successfully', 202);
    } catch (error) {
      const status = error.status || 500;
      return responseHelper.error(res, error.message, status);
    }
  });
};

const getImportStatus = async (req, res) => {
  try {
    const { jobId } = req.params;
    const status = await importExportService.getImportStatus(jobId);
    return responseHelper.success(res, status, 'Import status retrieved', 200);
  } catch (error) {
    const status = error.status || 500;
    return responseHelper.error(res, error.message, status);
  }
};

const exportUnits = async (req, res) => {
  try {
    const {
      format = 'csv',
      search,
      city,
      state,
      zip,
      status,
      hasOpenMaintenance,
      showArchived,
    } = req.query;
    if (!['csv', 'xlsx', 'json'].includes(format)) {
      return responseHelper.error(res, 'Invalid format. Must be csv, xlsx, or json', 400);
    }

    const userId = req.user?._id || req.user?.id;
    const hoaContext = req.hoaContext || null;
    if (!hoaContext?.hoaId && !userId) {
      return responseHelper.error(res, 'Active HOA community is required for unit export', 400);
    }

    const { content, mimeType, extension } = await importExportService.exportUnits(
      userId,
      format,
      hoaContext,
      { search, city, state, zip, status, hasOpenMaintenance, showArchived }
    );

    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `units_export_${timestamp}.${extension}`;

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  } catch (error) {
    const status = error.status || 500;
    return responseHelper.error(res, error.message, status);
  }
};

const downloadTemplate = async (req, res) => {
  try {
    const { format = 'csv', depositBankAccountId = '' } = req.query;
    if (!['csv', 'xlsx', 'json'].includes(format)) {
      return responseHelper.error(res, 'Invalid format. Must be csv, xlsx, or json', 400);
    }

    const { content, mimeType, extension } = await importExportService.downloadTemplate(format, {
      depositBankAccountId,
    });

    const filename = `units_import_template.${extension}`;
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  } catch (error) {
    const status = error.status || 500;
    return responseHelper.error(res, error.message, status);
  }
};

module.exports = {
  startImport,
  getImportStatus,
  exportUnits,
  downloadTemplate,
};
