/**
 * ------------------------------------------------------------------
 * File: masterData.model.js
 * Module: Src Shared Modules Master Model
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * associationTypeHelper, seedAssociationTypes, seedHOARequestTypes, seedPropertyMasterDropdowns
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const MasterDataSchema = new Schema({
  type: { type: String, required: true },
  key: { type: String, required: true },
  data: { type: Array, required: true },
  /** global = system master data; user = landlord-scoped; hoa = community-scoped */
  scope: { type: String, enum: ['global', 'user', 'hoa'], default: 'global', index: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  hoaId: { type: Schema.Types.ObjectId, ref: 'HOA', index: true },
  normalizedName: { type: String, trim: true, index: true },
  isActive: { type: Boolean, default: true, index: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

MasterDataSchema.index(
  { type: 1, scope: 1, userId: 1, hoaId: 1, normalizedName: 1 },
  {
    unique: true,
    partialFilterExpression: { type: 'Expense_Custom_Category', isActive: true },
  },
);

module.exports = mongoose.models.MasterData || mongoose.model('MasterData', MasterDataSchema);
