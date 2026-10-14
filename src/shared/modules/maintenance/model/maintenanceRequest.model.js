/**
 * ------------------------------------------------------------------
 * File: maintenanceRequest.model.js
 * Module: Maintenance Module
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * backfill-maintenance-ticket-numbers, app, propertyRelatedQueries, hoaDataIsolation
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const { MAINTENANCE_REQUEST_STATUS } = require('../../../../common/constants/property');

const MaintenanceRequestSchema = new Schema({
  property_id: {
    type: Schema.Types.ObjectId,
    ref: 'Property',
    required: false,
    index: true
  },
  unitId: {
    type: Schema.Types.ObjectId,
    index: true,
  },
  // Legacy denormalized label; canonical unit is property.unitDetails via unitId.
  units: {
    type: String,
    trim: true,
  },
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 150
  },
  description: {
    type: String,
    required: true,
    trim: true
  },
  category: {
    type: String,
    required: false,
    enum: ['Plumbing', 'Electrical', 'HVAC', 'Appliance', 'Structural', 'Pest Control', 'Landscaping', 'Other', null],
    index: true
  },
  primaryRequestType: {
    type: String,
    trim: true,
    default: null
  },
  subRequestType: {
    type: String,
    trim: true,
    default: null
  },
  /** Required when subRequestType is "Other Maintenance" (owner/board free-text category). */
  otherSubRequestDetail: {
    type: String,
    trim: true,
    maxlength: 200,
    default: null,
  },
  priority: {
    type: String,
    required: false,
    enum: ['Low', 'Medium', 'High', "Urgent"],
    default: 'Medium'
  },
  isUrgent: {
    type: Boolean,
    required: true
  },
  requestedBy: {
    type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    default: [],
  },
  notifyTenant: {
    type: Boolean,
    required: true
  },
  request_date: {
    type: Date,
    required: true,
    default: Date.now
  },
  status: {
    type: String,
    enum: Object.values(MAINTENANCE_REQUEST_STATUS),
    default: MAINTENANCE_REQUEST_STATUS.OPEN,
    index: true
  },
  documents: [{
    metadataId: {
      type: Schema.Types.ObjectId,
      ref: 'DocumentMetadata',
      required: true
    },
    originalName: String,
    uploadedAt: {
      type: Date,
      default: Date.now
    },
    uploadedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    }
  }],
  assignedTo: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  completedDate: {
    type: Date,
    default: null
  },
  estimatedCost: {
    type: Number,
    default: 0
  },
  actualCost: {
    type: Number,
    default: 0
  },
  comments: [{
    author: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    text: {
      type: String,
      required: true,
      trim: true
    },
    // Files sent with the comment. They are ticket documents (also listed
    // under Attachments & Media); this links them to the comment they came
    // with. Optional - older comments and clients send none.
    attachments: [{
      type: Schema.Types.ObjectId,
      ref: 'DocumentMetadata'
    }],
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  notes: [{
    author: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000
    },
    createdAt: {
      type: Date,
      default: Date.now,
      immutable: true
    },
    updatedAt: {
      type: Date,
      default: Date.now
    }
  }],
  /** Ticket-scoped activity for Activity Timeline (notes, edits, resolve, reopen, etc.) */
  activityLog: [{
    type: {
      type: String,
      enum: ['created', 'note', 'edited', 'status', 'assigned'],
      required: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    performedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    performedByName: {
      type: String,
      trim: true,
      default: null,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    meta: {
      type: Schema.Types.Mixed,
      default: null,
    },
  }],
  isDeleted: {
    type: Boolean,
    default: false
  },
  /** HOA community scope - board members see all tickets with matching hoaId regardless of requestedBy */
  hoaId: {
    type: Schema.Types.ObjectId,
    ref: 'HOA',
    index: true,
    default: null,
  },
  /** User who created the ticket (audit; not used for landlord property scoping) */
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    index: true,
    default: null,
  },
  /** Denormalized creator snapshot for audit, reporting, and notifications */
  createdByName: {
    type: String,
    trim: true,
    default: null,
  },
  createdByRole: {
    type: String,
    trim: true,
    default: null,
  },
  /** Human-readable label for who/what the ticket is for (owner, tenant, unit, etc.) */
  requestedForLabel: {
    type: String,
    trim: true,
    default: null,
  },
  requestedForType: {
    type: String,
    enum: ['user', 'unit', 'property', null],
    default: null,
  },
  /** Public-facing ticket number (e.g. MNT123456), similar to invoiceId */
  ticketNumber: {
    type: String,
    trim: true,
    unique: true,
    sparse: true,
    index: true,
    default: null,
  },
}, {
  timestamps: true
});

// Indexes for common queries
MaintenanceRequestSchema.index({ property_id: 1, status: 1 });
MaintenanceRequestSchema.index({ requestedBy: 1, status: 1 });
MaintenanceRequestSchema.index({ assignedTo: 1, status: 1 });
MaintenanceRequestSchema.index({ property_id: 1, isDeleted: 1, createdAt: -1 });
MaintenanceRequestSchema.index({ isDeleted: 1, status: 1, createdAt: -1 });
MaintenanceRequestSchema.index({ hoaId: 1, isDeleted: 1, createdAt: -1 });

MaintenanceRequestSchema.pre('validate', async function assignTicketNumber(next) {
  try {
    if (this.isNew && !this.ticketNumber) {
      const { allocateUniqueMaintenanceTicketNumber: allocateTicketNumber } = require('../helpers/maintenanceTicketNumber.helper');
      this.ticketNumber = await allocateTicketNumber({
        session: typeof this.$session === 'function' ? this.$session() : null,
      });
    }
    next();
  } catch (error) {
    next(error);
  }
});

const { commonQueryHelpersPlugin } = require('../../../../common/db/schemaPlugins');
const { toObjectId } = require('../../../../common/db/mongooseHelpers');
const { MAINTENANCE_STATUS: MAINT_STATUS } = require('../../../../common/constants/property');

commonQueryHelpersPlugin(MaintenanceRequestSchema);

const OPEN_MAINTENANCE_STATUSES = ['open', 'submitted', 'inprogress'];

MaintenanceRequestSchema.statics.countForProperty = function countForProperty(propertyId) {
  return this.countDocuments({ property_id: toObjectId(propertyId) }).exec();
};

MaintenanceRequestSchema.statics.aggregateCountsByProperty = async function aggregateCountsByProperty(propertyId) {
  const openStates = (MAINT_STATUS.OPEN || [MAINT_STATUS.SUBMITTED, MAINT_STATUS.INPROGRESS])
    .map((s) => String(s).toLowerCase());
  const closedStates = [MAINT_STATUS.COMPLETED, MAINT_STATUS.CANCELLED, 'Closed', 'Resolved']
    .map((s) => String(s).toLowerCase());

  const groups = await this.aggregate([
    { $match: { property_id: toObjectId(propertyId) } },
    { $group: { _id: { $toLower: { $ifNull: ['$status', ''] } }, count: { $sum: 1 } } },
  ]).exec();

  let openMaintenance = 0;
  let closedMaintenance = 0;
  for (const group of groups) {
    const status = group._id || '';
    if (openStates.includes(status)) openMaintenance += group.count || 0;
    if (closedStates.includes(status)) closedMaintenance += group.count || 0;
  }
  return { openMaintenance, closedMaintenance };
};

MaintenanceRequestSchema.statics.aggregateCountsByPropertyIds = function aggregateCountsByPropertyIds(propertyIds) {
  const ids = propertyIds.map(toObjectId);
  return this.aggregate([
    { $match: { property_id: { $in: ids } } },
    {
      $group: {
        _id: '$property_id',
        open: {
          $sum: {
            $cond: [
              { $in: [{ $toLower: { $ifNull: ['$status', ''] } }, OPEN_MAINTENANCE_STATUSES] },
              1,
              0,
            ],
          },
        },
        closed: {
          $sum: {
            $cond: [
              { $in: [{ $toLower: { $ifNull: ['$status', ''] } }, ['completed', 'cancelled', 'closed']] },
              1,
              0,
            ],
          },
        },
      },
    },
  ]).exec();
};

MaintenanceRequestSchema.statics.distinctOpenPropertyIds = async function distinctOpenPropertyIds(
  propertyIds,
  openStatuses = OPEN_MAINTENANCE_STATUSES,
) {
  const ids = (propertyIds || []).map(toObjectId).filter(Boolean);
  if (!ids.length) return [];

  // Statuses are stored in mixed case (Open, Submitted, InProgress). Match
  // case-insensitively - the same way aggregateCountsByPropertyIds does - so
  // property list "has open maintenance" filters actually return matches.
  const normalizedStatuses = (openStatuses || OPEN_MAINTENANCE_STATUSES)
    .map((status) => String(status || '').toLowerCase())
    .filter(Boolean);

  const rows = await this.aggregate([
    {
      $match: {
        property_id: { $in: ids },
        $expr: {
          $in: [{ $toLower: { $ifNull: ['$status', ''] } }, normalizedStatuses],
        },
      },
    },
    { $group: { _id: '$property_id' } },
  ]).exec();

  return rows.map((row) => row._id).filter(Boolean);
};

MaintenanceRequestSchema.statics.findOpenByProperty = function findOpenByProperty(propertyId, limit = 3) {
  const openStatuses = ['Open', 'Submitted', 'InProgress'];
  return this.find({
    property_id: toObjectId(propertyId),
    status: { $in: openStatuses },
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean()
    .exec();
};

module.exports = mongoose.models.MaintenanceRequest || mongoose.model('MaintenanceRequest', MaintenanceRequestSchema);


