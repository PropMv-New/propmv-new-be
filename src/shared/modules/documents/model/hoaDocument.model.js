/**
 * ------------------------------------------------------------------
 * File: hoaDocument.model.js
 * Module: Documents Module
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * hoa.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');

const HOADocumentSchema = new mongoose.Schema({
  name: { type: String, required: true },
  category: { type: String, required: true },
  type: { type: String, required: true },
  size: { type: String, required: true },
  uploadedBy: { type: String, required: true },
  uploadedById: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  accessLevel: { type: String, required: true, enum: ['All Residents', 'Owners Only', 'Board Only', 'Selective board + owner', 'SELECTIVE_BOARD_OWNER'] },
  version: { type: String, default: 'v1.0' },
  fileName: { type: String },
  filePath: { type: String },
  /** Object storage key when uploaded via StorageProvider (S3/Azure/mock). */
  storageKey: { type: String },
  /** Public or provider Location URL at upload time. */
  storageUrl: { type: String },
  description: { type: String },
  /** When set, document appears on that owner's profile (board respects accessLevel; owners never see Board Only). */
  linkedOwnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  /** Explicit owner grants for Owners Only documents. */
  allowedOwnerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }],
  /** Explicit board-member grants for Owners Only documents. */
  allowedBoardMemberIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }],
  /** Owners Only documents stay private to uploader/owners unless this is true. */
  allowCommunityBoardAccess: { type: Boolean, default: false, index: true },
  /** HOA community this document belongs to. */
  hoaId: { type: mongoose.Schema.Types.ObjectId, ref: 'HOA', index: true },
  uploadSource: { type: String, enum: ['hoa_board', 'owner'], default: 'hoa_board' },
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date }
}, {
  timestamps: true
});

HOADocumentSchema.index({ category: 1, isDeleted: 1 });
HOADocumentSchema.index({ hoaId: 1, isDeleted: 1, category: 1 });
HOADocumentSchema.index({ isDeleted: 1, createdAt: -1 });
HOADocumentSchema.index({ accessLevel: 1, isDeleted: 1, category: 1 });
HOADocumentSchema.index({ linkedOwnerId: 1, isDeleted: 1 });
HOADocumentSchema.index({ uploadedById: 1, isDeleted: 1 });
HOADocumentSchema.index({ allowedOwnerIds: 1, isDeleted: 1 });
HOADocumentSchema.index({ allowedBoardMemberIds: 1, isDeleted: 1 });

module.exports = mongoose.model('HOADocument', HOADocumentSchema);
