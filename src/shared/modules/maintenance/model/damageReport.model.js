/**
 * ------------------------------------------------------------------
 * File: damageReport.model.js
 * Module: Maintenance Module
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * damageReport.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const DamageReportItemSchema = new Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  condition: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  attachments: [{
    metadataId: {
      type: Schema.Types.ObjectId,
      ref: 'DocumentMetadata',
      required: true
    },
    originalName: String,
    uploadedAt: {
      type: Date,
      default: Date.now
    }
  }]
}, { _id: true });

const DamageReportSchema = new Schema({
  location: {
    type: String,
    required: true,
    trim: true
  },
  unit: {
    type: String,
    required: true,
    trim: true
  },
  items: {
    type: [DamageReportItemSchema],
    required: true,
    validate: {
      validator: function(items) {
        return items && items.length > 0;
      },
      message: 'At least one item is required'
    }
  },
  property_id: {
    type: Schema.Types.ObjectId,
    ref: 'Property',
    index: true
  },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

DamageReportSchema.pre('validate', async function(next) {
  if (this.property_id && this.unit) {
    try {
      const Property = require('../../../../portals/landlord/modules/property/model/property.model');
      const property = await Property.findById(this.property_id).lean();
      if (property && property.unitDetails && property.unitDetails.length > 0) {
        const unitExists = property.unitDetails.some(u => u.unitName === this.unit);
        if (!unitExists) {
          this.invalidate('unit', 'Unit does not belong to the selected property');
        }
      }
    } catch (err) {
      return next(err);
    }
  }
  next();
});

DamageReportSchema.index({ property_id: 1, createdAt: -1 });

module.exports = mongoose.models.DamageReport || mongoose.model('DamageReport', DamageReportSchema);


