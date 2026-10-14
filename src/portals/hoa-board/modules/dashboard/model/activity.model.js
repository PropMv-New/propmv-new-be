/**
 * ------------------------------------------------------------------
 * File: activity.model.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * activity.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const ActivitySchema = new Schema({
  module: { 
    type: String, 
    required: true, 
    enum: ['Property', 'Unit', 'Owner', 'Income', 'Expense', 'Maintenance', 'Document', 'Lease', 'Tenant', 'Invoice', 'Messaging', 'Settings', 'User', 'Other']
  },
  action: { 
    type: String, 
    required: true, 
    enum: [
      'CREATE',
      'UPDATE',
      'DELETE',
      'PAYMENT_SUCCESS',
      'PAYMENT_FAILED',
      'STATUS_CHANGE',
      'ARCHIVE',
      'RESTORE',
      'UPLOAD',
      'DOWNLOAD',
      'OWNER_ADDED',
      'OWNER_REMOVED',
      'OWNER_CHANGED',
      'OWNER_EVENT_REVERTED',
    ]
  },
  entityId: { type: Schema.Types.ObjectId, required: true },
  entityName: { type: String },
  description: { type: String, required: true },
  performedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String },
  hoaId: { type: Schema.Types.ObjectId, ref: 'HOA', index: true },
  meta: { type: Schema.Types.Mixed },
  // Legacy field for backward compatibility
  user_id: { type: Schema.Types.ObjectId, ref: 'User' },
  entityType: { type: String },
  metadata: { type: Schema.Types.Mixed }
}, { timestamps: true });

ActivitySchema.index({ hoaId: 1, createdAt: -1 });
ActivitySchema.index({ performedBy: 1, createdAt: -1 });
ActivitySchema.index({ module: 1, createdAt: -1 });
ActivitySchema.index({ createdAt: -1 });
ActivitySchema.index({ entityId: 1 });

module.exports = mongoose.model('Activity', ActivitySchema);
