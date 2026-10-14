const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const EmailSubscriptionSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    source: {
      type: String,
      required: true,
      trim: true,
      default: 'coming-soon',
    },
    launchNotifiedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

EmailSubscriptionSchema.index({ email: 1 }, { unique: true });
EmailSubscriptionSchema.index({ createdAt: -1 });
EmailSubscriptionSchema.index({ source: 1, launchNotifiedAt: 1 });

module.exports =
  mongoose.models.EmailSubscription ||
  mongoose.model('EmailSubscription', EmailSubscriptionSchema);
