/**
 * ------------------------------------------------------------------
 * File: invoiceGenerationJob.model.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * invoiceGenerationJob.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');

const invoiceGenerationJobSchema = new mongoose.Schema({
  jobId: { type: String, required: true, unique: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  hoaId: { type: mongoose.Schema.Types.ObjectId, ref: 'HOA', index: true },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: 'pending',
    index: true,
  },
  totalInvoices: { type: Number, default: 0 },
  processedInvoices: { type: Number, default: 0 },
  invoiceCount: { type: Number, default: 0 },
  errorMessage: { type: String, default: '' },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  documentsPayload: { type: mongoose.Schema.Types.Mixed, default: null },
  resultInvoiceIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' }],
  completedAt: { type: Date },
}, { timestamps: true, suppressReservedKeysWarning: true });

module.exports = mongoose.model('InvoiceGenerationJob', invoiceGenerationJobSchema);
