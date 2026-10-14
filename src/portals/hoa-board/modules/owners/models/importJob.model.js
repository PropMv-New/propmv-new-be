/**
 * ------------------------------------------------------------------
 * File: importJob.model.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * unitImportExport.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');

const importJobSchema = new mongoose.Schema({
  jobId: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  hoaId: { type: mongoose.Schema.Types.Mixed },
  defaultDepositBankAccountId: { type: String },
  allowedDepositBankAccountIds: { type: [String], default: [] },
  fileName: { type: String, required: true },
  fileFormat: { type: String, enum: ['csv', 'xlsx', 'json'], required: true },
  status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },
  totalRecords: { type: Number, default: 0 },
  processedRecords: { type: Number, default: 0 },
  successCount: { type: Number, default: 0 },
  failedCount: { type: Number, default: 0 },
  errors: [{
    row: Number,
    message: String,
    data: String
  }],
  createdAt: { type: Date, default: Date.now },
  completedAt: { type: Date }
}, { timestamps: true, suppressReservedKeysWarning: true });

module.exports = mongoose.model('ImportJob', importJobSchema);
