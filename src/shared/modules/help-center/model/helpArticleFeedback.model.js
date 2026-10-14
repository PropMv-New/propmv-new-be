const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * Help Center Article Feedback Model
 *
 * Persists "Was this article helpful?" votes for public Sanity-backed articles.
 * Supports both authenticated portal users and anonymous visitors.
 * Content lives in Sanity; feedback persistence lives in MongoDB.
 */
const HelpArticleFeedbackSchema = new Schema(
  {
    // Canonical immutable Sanity document _id (or fallback offline article id)
    articleId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    // Denormalized snapshots for reporting and triage
    articleSlug: {
      type: String,
      trim: true,
      default: '',
    },
    categorySlug: {
      type: String,
      trim: true,
      default: '',
    },
    // Vote value
    vote: {
      type: String,
      required: true,
      enum: ['helpful', 'not_helpful'],
    },
    // Authenticated user identity (null for anonymous visitors)
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    // Dedicated anonymous browser UUID from x-anonymous-id (null for authenticated users)
    anonymousId: {
      type: String,
      trim: true,
      maxlength: 64,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'help_article_feedbacks',
  }
);

// Enforce one vote per authenticated user per article
HelpArticleFeedbackSchema.index(
  { articleId: 1, userId: 1 },
  {
    unique: true,
    partialFilterExpression: { userId: { $type: 'objectId' } },
  }
);

// Enforce one vote per anonymous identity per article
HelpArticleFeedbackSchema.index(
  { articleId: 1, anonymousId: 1 },
  {
    unique: true,
    partialFilterExpression: { anonymousId: { $type: 'string' } },
  }
);

// Fast covered index scan for article vote aggregation
HelpArticleFeedbackSchema.index({ articleId: 1, vote: 1 });

module.exports =
  mongoose.models.HelpArticleFeedback ||
  mongoose.model('HelpArticleFeedback', HelpArticleFeedbackSchema);
