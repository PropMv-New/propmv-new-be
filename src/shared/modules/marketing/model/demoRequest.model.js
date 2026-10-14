const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/**
 * A demo request captured from the public marketing site.
 *
 * Stored rather than only emailed: an email can be missed, filed, or lost with
 * whoever received it, and there is then no record that a prospect ever asked.
 * The row is the lead; the email is only the notification.
 */
const DemoRequestSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 200 },
    phone: { type: String, trim: true, maxlength: 40, default: '' },
    /** Free text, not an enum: the roles on the marketing site change more often than this model should. */
    role: { type: String, trim: true, maxlength: 60, default: '' },
    propertyCount: { type: String, trim: true, maxlength: 40, default: '' },
    /** ISO date (YYYY-MM-DD) the prospect asked for. Kept as a string, not a
     *  Date: it is a calendar day in the visitor's own locale, not an instant,
     *  and storing it as a Date would drag timezone conversion into it. */
    preferredDate: { type: String, trim: true, maxlength: 10, default: '' },
    preferredTime: { type: String, trim: true, maxlength: 120, default: '' },
    message: { type: String, trim: true, maxlength: 2000, default: '' },
    /** Which page the request came from, so campaigns can be told apart. */
    source: { type: String, trim: true, maxlength: 60, default: 'website' },
    status: {
      type: String,
      enum: ['new', 'contacted', 'scheduled', 'closed'],
      default: 'new',
      index: true,
    },
    /** Whether the internal notification actually went out. */
    notifiedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Newest first for the admin list, and grouped by status for triage.
DemoRequestSchema.index({ createdAt: -1 });
DemoRequestSchema.index({ status: 1, createdAt: -1 });
DemoRequestSchema.index({ email: 1, createdAt: -1 });

module.exports =
  mongoose.models.DemoRequest || mongoose.model('DemoRequest', DemoRequestSchema);
