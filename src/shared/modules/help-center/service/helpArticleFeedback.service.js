const HelpArticleFeedback = require('../model/helpArticleFeedback.model');
const { ValidationError } = require('../../../../common/exceptions');

/**
 * Retrieves aggregate helpful/not-helpful counts and the caller's vote for an article.
 *
 * @param {Object} params
 * @param {string} params.articleId - Canonical Sanity article ID
 * @param {string|null} [params.userId] - Authenticated user ObjectId string
 * @param {string|null} [params.anonymousId] - Anonymous browser UUID
 * @returns {Promise<Object>} Aggregated feedback stats and current user vote
 */
async function getArticleFeedbackStats({ articleId, userId = null, anonymousId = null }) {
  const [helpful, notHelpful] = await Promise.all([
    HelpArticleFeedback.countDocuments({ articleId, vote: 'helpful' }),
    HelpArticleFeedback.countDocuments({ articleId, vote: 'not_helpful' }),
  ]);

  let userVote = null;
  if (userId) {
    const existing = await HelpArticleFeedback.findOne({ articleId, userId })
      .select('vote')
      .lean();
    userVote = existing?.vote || null;
  } else if (anonymousId) {
    const existing = await HelpArticleFeedback.findOne({ articleId, anonymousId })
      .select('vote')
      .lean();
    userVote = existing?.vote || null;
  }

  return {
    articleId,
    helpful,
    notHelpful,
    total: helpful + notHelpful,
    userVote,
  };
}

/**
 * Atomically submits or updates an article feedback vote.
 * Authenticated identity takes precedence over anonymous identity.
 * Handles concurrent duplicate-key races safely via database partial unique index.
 *
 * @param {Object} params
 * @param {string} params.articleId - Canonical Sanity article ID
 * @param {string} params.vote - 'helpful' or 'not_helpful'
 * @param {string|null} [params.userId] - Authenticated user ObjectId string
 * @param {string|null} [params.anonymousId] - Anonymous browser UUID
 * @param {string} [params.articleSlug] - Optional article slug snapshot
 * @param {string} [params.categorySlug] - Optional category slug snapshot
 * @returns {Promise<Object>} Updated feedback stats and current user vote
 */
async function submitArticleFeedback({
  articleId,
  vote,
  userId = null,
  anonymousId = null,
  articleSlug = '',
  categorySlug = '',
}) {
  const isAuth = Boolean(userId);

  if (!isAuth && !anonymousId) {
    throw new ValidationError('Anonymous identifier (x-anonymous-id) is required for unauthenticated feedback');
  }

  // Identity filter: Authenticated identity takes absolute precedence
  const filter = isAuth
    ? { articleId, userId }
    : { articleId, anonymousId };

  const update = {
    $set: {
      vote,
      ...(articleSlug ? { articleSlug } : {}),
      ...(categorySlug ? { categorySlug } : {}),
      ...(isAuth ? { userId, anonymousId: null } : { anonymousId, userId: null }),
    },
    $setOnInsert: {
      articleId,
    },
  };

  const options = {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
  };

  try {
    await HelpArticleFeedback.findOneAndUpdate(filter, update, options);
  } catch (err) {
    // If a concurrent duplicate upsert hits E11000 duplicate key race, safely retry update on the winning record
    if (err && (err.code === 11000 || (err.name === 'MongoServerError' && err.code === 11000))) {
      await HelpArticleFeedback.findOneAndUpdate(filter, update, { new: true });
    } else {
      throw err;
    }
  }

  return getArticleFeedbackStats({ articleId, userId, anonymousId });
}

module.exports = {
  getArticleFeedbackStats,
  submitArticleFeedback,
};
