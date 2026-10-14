const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const SiteVisitSchema = new Schema(
  {
    visitorId: { type: String, required: true, trim: true, index: true },
    sessionId: { type: String, required: true, trim: true, index: true },
    path: { type: String, required: true, trim: true, index: true },
    title: { type: String, trim: true },
    referrer: { type: String, trim: true },
    query: { type: String, trim: true },
    language: { type: String, trim: true },
    screenWidth: { type: Number },
    screenHeight: { type: Number },
    utmSource: { type: String, trim: true },
    utmMedium: { type: String, trim: true },
    utmCampaign: { type: String, trim: true },
    ip: { type: String, trim: true, index: true },
    userAgent: { type: String, trim: true },
    browser: { type: String, trim: true },
    os: { type: String, trim: true },
    deviceType: { type: String, trim: true, index: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, trim: true, index: true },
    timezone: { type: String, trim: true },
    isLocalDevelopment: { type: Boolean, default: false },
  },
  { timestamps: true }
);

SiteVisitSchema.index({ createdAt: -1 });
SiteVisitSchema.index({ visitorId: 1, createdAt: -1 });

module.exports = mongoose.models.SiteVisit || mongoose.model('SiteVisit', SiteVisitSchema);
