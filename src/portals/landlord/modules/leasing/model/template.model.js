/**
 * ------------------------------------------------------------------
 * File: template.model.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * template.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const leaseTemplateSchema = new Schema({
  createdBy: {
    type: Schema.Types.ObjectId,
    required: true,
    ref: 'User'
  },
  landlordId: {
    type: Schema.Types.ObjectId,
    required: false,
    ref: 'User'
  },
  documentMetadataId: {
    type: Schema.Types.ObjectId,
    required: true,
    ref: 'DocumentMetadata'
  }
  ,
  templateName: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: false,
    trim: true
  },
  templateType: {
    type: String,
    required: true,
    trim: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.models.Template || mongoose.model('Template', leaseTemplateSchema);
