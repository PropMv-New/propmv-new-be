/**
 * ------------------------------------------------------------------
 * File: template.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * template.controller
 * ------------------------------------------------------------------
 */

const LeaseTemplate = require('../model/template.model');
const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
const s3 = require('../../../../../integrations/s3');
const { fileValidationHelper } = require('../../../../../common/helpers/fileValidationHelper');
const fs = require('fs').promises;

/**
 * LeaseTemplateService
 *
 * Represents the Lease Template Service controller/model class.
 */
class LeaseTemplateService {
  async createTemplate(landlordId, file, data = {}) {
    try {
      // Validate file type
      if (!file || file.mimetype !== 'application/pdf') {
        throw new Error('Only PDF files are allowed');
      }

      // Upload file to S3
      const s3Key = s3.getKeyForLease(landlordId, file.originalname);
      const s3Result = await s3.upload({
        localFilePath: file.path,
        key: s3Key
      });

      // Create document metadata for the uploaded file
      const docMetadata = await DocumentMetadata.create({
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        path: s3Result.Key, // Store S3 key instead of local path
        uploadedBy: landlordId,
        s3Location: s3Result.Location // Store S3 URL
      });

      // Create lease template
      const templatePayload = {
        landlordId,
        documentMetadataId: docMetadata._id,
      };
      if (data.templateName) templatePayload.templateName = data.templateName;
      if (typeof data.description !== 'undefined') templatePayload.description = data.description;
      if (typeof data.templateType !== 'undefined') templatePayload.templateType = data.templateType;

      const template = await LeaseTemplate.create(templatePayload);

      return template;
    } catch (error) {
      throw error;
    }
  }

  async getTemplateById(templateId) {
    try {
      const template = await LeaseTemplate.findById(templateId)
        .populate('documentMetadataId')
        .populate('landlordId', 'firstName lastName email');
      return template;
    } catch (error) {
      throw error;
    }
  }

  async getTemplatesByLandlord(landlordId, query = {}) {
    try {
      if (!landlordId) {
        const error = new Error('Landlord ID is required');
        error.status = 400;
        throw error;
      }

      // Build filter based on query parameters - landlordId is always required
      const filter = { landlordId: landlordId };

      // Apply optional filters
      if (query.templateName && query.templateName.trim()) {
        filter.templateName = new RegExp(query.templateName.trim(), 'i'); // case-insensitive search
      }
      if (query.templateType && query.templateType.trim()) {
        filter.templateType = query.templateType.trim();
      }

      // Get standardized pagination parameters
      const { getPagination } = require('../../../../../common/helpers/paginationHelper');
      const { pageNumber = 1, pageSize = 10 } = query;
      const { offset, limit: effectiveLimit, page, pageSize: effectivePageSize } = getPagination({
        page: pageNumber,
        pageSize
      });

      // Execute paginated query
      const [templates, total] = await Promise.all([
        LeaseTemplate.find(filter)
          .populate('documentMetadataId')
          .populate('landlordId', 'firstName lastName email')
          .sort('-createdAt')
          .skip(offset)
          .limit(effectiveLimit)
          .lean(),
        LeaseTemplate.countDocuments(filter)
      ]);

      return {
        data: templates,
        total,
        page,
        pageSize: effectivePageSize
      };
    } catch (error) {
      throw error;
    }
  }

  async getTemplateFile(templateId) {
    const template = await LeaseTemplate.findById(templateId).populate('documentMetadataId');
    if (!template) throw new Error('Template not found');

    const doc = template.documentMetadataId;
    if (!doc) throw new Error('Document metadata not found');
    if (!doc.path) throw new Error('Document path not found');

    // For both mock and real S3, path stores the key relative to the storage root
    const fs = require('fs');
    const pathUtil = require('path');
    const config = require('../../../../../config/default');

    // Read from configured mock directory (works for both mock and local testing)
    const mockDir = pathUtil.resolve((config.s3 && config.s3.mockDir) || pathUtil.join(__dirname, '../../../mock_s3'));
    const filePath = pathUtil.resolve(pathUtil.join(mockDir, doc.path));
    if (!filePath.startsWith(mockDir + pathUtil.sep) && filePath !== mockDir) {
      throw new Error('Invalid document path');
    }

    try {
      // Create a read stream from the file
      const stream = fs.createReadStream(filePath);
      const stats = fs.statSync(filePath);

      return {
        stream,
        mimeType: doc.mimeType || 'application/pdf',
        filename: doc.originalName || 'document.pdf',
        size: stats.size
      };
    } catch (error) {
      throw new Error('Failed to read template file: ' + error.message);
    }
  }

  async getTemplateDocument(templateId) {
    const template = await LeaseTemplate.findById(templateId).populate('documentMetadataId');
    if (!template) throw new Error('Template not found');

    const doc = template.documentMetadataId;
    if (!doc) throw new Error('Document metadata not found');
    if (!doc.path) throw new Error('Document path not found');

    // For both mock and real S3, path stores the key relative to the storage root
    const fs = require('fs').promises;
    const pathUtil = require('path');
    const config = require('../../../../../config/default');

    // Read from configured mock directory (works for both mock and local testing)
    const mockDir = pathUtil.resolve((config.s3 && config.s3.mockDir) || pathUtil.join(__dirname, '../../../mock_s3'));
    const filePath = pathUtil.resolve(pathUtil.join(mockDir, doc.path));
    if (!filePath.startsWith(mockDir + pathUtil.sep) && filePath !== mockDir) {
      throw new Error('Invalid document path');
    }

    try {
      const data = await fs.readFile(filePath);
      return {
        data,
        fileName: doc.originalName || 'document.pdf',
        mimeType: doc.mimeType || 'application/pdf',
        size: data.length
      };
    } catch (error) {
      throw new Error('Failed to read template document');
    }
  }

  /**
   * Return a download URL for the template document.
   * - prefers a stored s3Location (public URL)
   * - falls back to mock S3 baseUrl + path when available
   * Throws an Error with status 404 when template or metadata not found.
   */
  async getTemplateDownloadUrl(templateId) {
    try {
      const template = await LeaseTemplate.findById(templateId).populate('documentMetadataId');
      if (!template) { const err = new Error('Template not found'); err.status = 404; throw err; }
      const doc = template.documentMetadataId;
      if (!doc) { const err = new Error('Document metadata not found'); err.status = 404; throw err; }

      if (doc.s3Location) return doc.s3Location;

      if (doc.path) {
        const s3 = require('../../../../../integrations/s3');
        if (s3 && s3.baseUrl) return `${s3.baseUrl}/${doc.path}`;
      }

      const err = new Error('Unable to retrieve file for download'); err.status = 500; throw err;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Fetch the template document and return a readable stream along with metadata.
   * The controller will stream this to the client.
   * Returns: { stream, mimeType, filename, size }
   */
  async getTemplateFile(templateId) {
    try {
      const template = await LeaseTemplate.findById(templateId).populate('documentMetadataId');
      if (!template) { const err = new Error('Template not found'); err.status = 404; throw err; }
      const doc = template.documentMetadataId;
      if (!doc) { const err = new Error('Document metadata not found'); err.status = 404; throw err; }

      // Prefer doc.path (S3 key) and use the configured S3 integration
      const s3 = require('../../../../../integrations/s3');
      const config = require('../../../../../config/default');
      const pathUtil = require('path');
      const fs = require('fs');

      // If aws s3 adapter is active (has bucket property), stream via SDK v3
      if (s3 && s3.bucket) {
        const key = doc.path;
        if (!key) { const err = new Error('Document key missing'); err.status = 500; throw err; }
        const stream = await s3.getStream({ key });
        return { stream, mimeType: doc.mimeType, filename: doc.originalName, size: doc.size };
      }

      // If mockS3 or local mock is used, read from configured mock directory
      const mockDir = pathUtil.resolve((config.s3 && config.s3.mockDir) || pathUtil.join(__dirname, '../../../mock_s3'));
      if (doc.path) {
        const filePath = pathUtil.resolve(pathUtil.join(mockDir, doc.path));
        if (!filePath.startsWith(mockDir + pathUtil.sep) && filePath !== mockDir) {
          throw new Error('Invalid document path');
        }
        if (!fs.existsSync(filePath)) { const err = new Error('File not found'); err.status = 404; throw err; }
        const stream = fs.createReadStream(filePath);
        return { stream, mimeType: doc.mimeType, filename: doc.originalName, size: doc.size };
      }

      // As a last resort, if we have a public s3Location (URL), perform an HTTP/HTTPS GET and return the response stream
      if (doc.s3Location) {
        const parsed = new URL(doc.s3Location);
        const httpMod = parsed.protocol === 'https:' ? require('https') : require('http');
        return await new Promise((resolve, reject) => {
          const req = httpMod.get(doc.s3Location, (resp) => {
            if (resp.statusCode && resp.statusCode >= 400) return reject(Object.assign(new Error('Failed to fetch remote file'), { status: resp.statusCode }));
            resolve({ stream: resp, mimeType: resp.headers['content-type'] || doc.mimeType, filename: doc.originalName, size: resp.headers['content-length'] ? Number(resp.headers['content-length']) : doc.size });
          });
          req.on('error', (e) => reject(e));
        });
      }

      const err = new Error('Unable to retrieve file'); err.status = 500; throw err;
    } catch (error) {
      throw error;
    }
  }

  async updateTemplate(templateId, landlordId, file, data = {}) {
    try {
      const template = await LeaseTemplate.findOne({ _id: templateId, landlordId });
      if (!template) {
        throw new Error('Template not found or unauthorized');
      }

      // Validate file type
      if (file && file.mimetype !== 'application/pdf') {
        throw new Error('Only PDF files are allowed');
      }

      // Get the old document metadata to delete old file later
      const oldDocMetadata = await DocumentMetadata.findById(template.documentMetadataId);

      let docMetadata = null;
      // If a new file was provided, upload it and create new metadata
      if (file) {
        const s3Key = s3.getKeyForLease(landlordId, file.originalname);
        const s3Result = await s3.upload({
          localFilePath: file.path,
          key: s3Key
        });

        // Create new document metadata
        docMetadata = await DocumentMetadata.create({
          originalName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          path: s3Result.Key,
          uploadedBy: landlordId,
          s3Location: s3Result.Location
        });

        // Update template with new document metadata
        template.documentMetadataId = docMetadata._id;
      }
      if (typeof data.templateName !== 'undefined') template.templateName = data.templateName;
      if (typeof data.description !== 'undefined') template.description = data.description;
      if (typeof data.templateType !== 'undefined') template.templateType = data.templateType;
      await template.save();

      // Delete old file from S3 if we uploaded a new one and old metadata exists
      if (docMetadata && oldDocMetadata && oldDocMetadata.path) {
        await s3.delete({ key: oldDocMetadata.path });
      }

      return template;
    } catch (error) {
      throw error;
    }
  }

  async deleteTemplate(templateId, landlordId) {
    try {
      const template = await LeaseTemplate.findOne({ _id: templateId, landlordId });
      if (!template) {
        throw new Error('Template not found or unauthorized');
      }

      // Get document metadata to delete file from S3
      const docMetadata = await DocumentMetadata.findById(template.documentMetadataId);
      if (docMetadata && docMetadata.path) {
        await s3.delete({ key: docMetadata.path });
      }

      // Delete document metadata
      await DocumentMetadata.findByIdAndDelete(template.documentMetadataId);

      // Delete template
      await template.deleteOne();

      return template;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = new LeaseTemplateService();