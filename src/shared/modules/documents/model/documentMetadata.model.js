/**
 * ------------------------------------------------------------------
 * File: documentMetadata.model.js
 * Module: Documents Module
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * expense.service, invoice.service, invoicePolicyTerm.service, lease.service
 * ------------------------------------------------------------------
 */

// Document metadata schema for MongoDB
const mongoose = require('mongoose');

const DocumentMetadataSchema = new mongoose.Schema({
  key: { type: String, required: true },
  // Public URL or S3 location returned by the upload adapter (mock or aws)
  s3Location: { type: String },
  originalName: { type: String },
  bucketName: { type: String, required: true },
  region: { type: String, required: true },
  size: { type: Number, required: true },
  contentType: { type: String, required: true },
}, {
  timestamps: true
});

// Pre-save hook to decode HTML entities in URLs
DocumentMetadataSchema.pre('save', function(next) {
  // Decode HTML entities in s3Location
  if (this.s3Location && typeof this.s3Location === 'string') {
    let decoded = this.s3Location;
    // Keep decoding until no more HTML entities
    while (decoded.includes('&amp;')) {
      decoded = decoded.replace(/&amp;/g, '&');
    }
    this.s3Location = decoded;
  }
  next();
});

DocumentMetadataSchema.index({ key: 1 });

module.exports = mongoose.models.DocumentMetadata || mongoose.model('DocumentMetadata', DocumentMetadataSchema);
