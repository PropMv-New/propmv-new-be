'use strict';

const mongoose = require('mongoose');

const HoaOnboardingReportSnapshotSchema = new mongoose.Schema(
  {
    reportDate: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    period: {
      type: String,
      default: 'daily',
      enum: ['daily', 'weekly', 'monthly'],
      required: true,
    },
    periodStart: {
      type: Date,
      required: true,
    },
    periodEnd: {
      type: Date,
      required: true,
    },
    summary: {
      dailyCount: { type: Number, default: 0 },
      weeklyCount: { type: Number, default: 0 },
      monthlyCount: { type: Number, default: 0 },
    },
    recipients: [
      {
        type: String,
        trim: true,
      },
    ],
    emailSent: {
      type: Boolean,
      default: false,
      index: true,
    },
    emailSentAt: {
      type: Date,
      default: null,
    },
    errorMessage: {
      type: String,
      default: null,
    },
    triggerSource: {
      type: String,
      enum: ['cron', 'manual'],
      default: 'cron',
    },
    lastManualSentAt: {
      type: Date,
      default: null,
    },
    manualSendCount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
    collection: 'hoa_onboarding_report_snapshots',
  }
);

// Unique compound index to guarantee idempotency and prevent duplicate successful daily reports
HoaOnboardingReportSnapshotSchema.index({ reportDate: 1, period: 1 }, { unique: true });

module.exports =
  mongoose.models.HoaOnboardingReportSnapshot ||
  mongoose.model('HoaOnboardingReportSnapshot', HoaOnboardingReportSnapshotSchema);
