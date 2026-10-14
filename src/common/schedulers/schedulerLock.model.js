'use strict';

const mongoose = require('mongoose');

const SchedulerLockSchema = new mongoose.Schema(
  {
    lockKey: { type: String, required: true, unique: true, index: true },
    lockedBy: { type: String, default: '', trim: true },
    lockedAt: { type: Date, default: null },
    lockedUntil: { type: Date, default: null, index: true },
  },
  {
    collection: 'scheduler_locks',
    timestamps: true,
  }
);

module.exports = mongoose.models.SchedulerLock
  || mongoose.model('SchedulerLock', SchedulerLockSchema);
