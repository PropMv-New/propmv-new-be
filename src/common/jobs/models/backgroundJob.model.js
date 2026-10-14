'use strict';

const mongoose = require('mongoose');
const { JOB_STATUS, QUEUE_NAMES, PRIORITY } = require('../constants');

const errorHistorySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    attempt: { type: Number, default: 0 },
    message: { type: String, default: '' },
    stack: { type: String, default: '' },
    workerId: { type: String, default: '' },
  },
  { _id: false }
);

const backgroundJobSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, unique: true, trim: true, index: true },
    idempotencyKey: { type: String, default: null, trim: true },
    jobType: { type: String, required: true, trim: true, index: true },
    queue: {
      type: String,
      enum: Object.values(QUEUE_NAMES),
      required: true,
      index: true,
    },
    entityType: { type: String, default: '', trim: true },
    entityId: { type: String, default: '', trim: true, index: true },
    eventId: { type: String, default: '', trim: true },
    recipientType: { type: String, default: '', trim: true },
    recipientId: { type: String, default: '', trim: true, index: true },
    status: {
      type: String,
      enum: Object.values(JOB_STATUS),
      default: JOB_STATUS.PENDING,
      index: true,
    },
    priority: { type: Number, default: PRIORITY.NORMAL },
    attempts: { type: Number, default: 0, min: 0 },
    maxAttempts: { type: Number, default: 3, min: 1 },
    scheduledAt: { type: Date, default: Date.now, index: true },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    nextRetryAt: { type: Date, default: Date.now, index: true },
    workerId: { type: String, default: '', trim: true },
    queueBackend: { type: String, enum: ['bullmq', 'mongo', ''], default: '' },
    lockedAt: { type: Date, default: null },
    lockedUntil: { type: Date, default: null },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    errorMessage: { type: String, default: '' },
    errorHistory: { type: [errorHistorySchema], default: [] },
    processingTimeMs: { type: Number, default: null },
  },
  {
    timestamps: true,
    collection: 'background_jobs',
  }
);

backgroundJobSchema.index({ status: 1, nextRetryAt: 1, createdAt: 1 });
backgroundJobSchema.index({ jobType: 1, createdAt: -1 });
backgroundJobSchema.index({ entityId: 1, jobType: 1 });
backgroundJobSchema.index({ createdAt: -1 });
backgroundJobSchema.index(
  { idempotencyKey: 1 },
  { unique: true, sparse: true }
);

module.exports =
  mongoose.models.BackgroundJob ||
  mongoose.model('BackgroundJob', backgroundJobSchema);
