/**
 * ------------------------------------------------------------------
 * File: template.controller.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const LeaseTemplateService = require('../service/template.service');
const { createUpload } = require('../../../../../common/helpers/uploadHelper');
const { multerPdfFilter } = require('../../../../../common/helpers/fileValidationHelper');
const responseHelper = require('../../../../../common/helpers/responseHelper');

const { uploadArray: upload, tempDir } = createUpload('template', 'lease-templates', {
  maxCount: 1,
  fileFilter: multerPdfFilter,
  maxSizeBytes: 10 * 1024 * 1024 // 10MB limit
});

/**
 * LeaseTemplateController
 *
 * Represents the Lease Template Controller controller/model class.
 */
class LeaseTemplateController {
  async createTemplate(req, res, next) {
    try {
      const { landlordId } = req.params;
      const { templateName, description, templateType } = req.body || {};
      if (!req.file) {
        return responseHelper.error(res, 'PDF file is required', 400);
      }

      const template = await LeaseTemplateService.createTemplate(landlordId, req.file, { templateName, description, templateType });
      return responseHelper.success(res, template);
    } catch (error) {
      next(error);
    }
  }

  async getTemplateById(req, res, next) {
    try {
      const { templateId } = req.params;
      const template = await LeaseTemplateService.getTemplateById(templateId);
      if (!template) {
        return responseHelper.error(res, 'Template not found', 404);
      }
      return responseHelper.success(res, template);
    } catch (error) {
      next(error);
    }
  }

  async getTemplatesByLandlord(req, res, next) {
    try {
      const { landlordId } = req.params;
      if (!landlordId) {
        return responseHelper.error(res, 'Landlord ID is required', 400);
      }

      const { templateName, templateType, pageNumber, pageSize } = req.query;
      
      const result = await LeaseTemplateService.getTemplatesByLandlord(landlordId, {
        templateName,
        templateType,
        pageNumber,
        pageSize
      });

      return responseHelper.success(res, result);
    } catch (error) {
      next(error);
    }
  }

  async downloadTemplate(req, res, next) {
    try {
      const { templateId } = req.params;
      // Delegate business logic to service which returns a readable stream and metadata
      const file = await LeaseTemplateService.getTemplateFile(templateId);
      const { stream, mimeType, filename, size } = file;

      // Set headers and stream the file to the client
      res.setHeader('Content-Type', mimeType || 'application/octet-stream');
      // Suggest a filename for download
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename || 'file') }"`);
      if (typeof size === 'number') res.setHeader('Content-Length', String(size));

      stream.on('error', (err) => next(err));
      stream.pipe(res);
    } catch (error) {
      const status = error.status || (error.message && error.message.includes('not found') ? 404 : 500);
      return responseHelper.error(res, error.message, status);
    }
  }

  async updateTemplate(req, res, next) {
    try {
      const { templateId, landlordId } = req.params;
      const { templateName, description, templateType } = req.body || {};

      // file is optional on update; if provided it will replace the document
      const template = await LeaseTemplateService.updateTemplate(templateId, landlordId, req.file, { templateName, description, templateType });
      return responseHelper.success(res, template);
    } catch (error) {
      next(error);
    }
  }

  async deleteTemplate(req, res, next) {
    try {
      const { templateId, landlordId } = req.params;
      const template = await LeaseTemplateService.deleteTemplate(templateId, landlordId);
      return responseHelper.success(res, template);
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new LeaseTemplateController();