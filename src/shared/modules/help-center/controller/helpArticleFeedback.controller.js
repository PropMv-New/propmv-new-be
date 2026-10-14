const feedbackService = require('../service/helpArticleFeedback.service');
const responseHelper = require('../../../../common/helpers/responseHelper');
const { validateAnonymousId } = require('../validators/helpArticleFeedback.validator');

/**
 * GET /api/v1/help-center/articles/:articleId/feedback
 *
 * Retrieves aggregate feedback statistics and caller's current vote.
 */
async function getFeedback(req, res, next) {
  try {
    const { articleId } = req.params;
    const rawAnonId = req.get('x-anonymous-id') || req.query.anonymousId;
    const anonymousId = validateAnonymousId(rawAnonId, false);
    const userId = req.userId || null;

    const data = await feedbackService.getArticleFeedbackStats({
      articleId,
      userId,
      anonymousId,
    });

    return responseHelper.success(res, data, 'Success', 200);
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/help-center/articles/:articleId/feedback
 *
 * Submits or updates feedback for an article.
 * Authenticated identity (req.userId) takes precedence over anonymous identity.
 */
async function submitFeedback(req, res, next) {
  try {
    const { articleId } = req.params;
    const { vote, articleSlug, categorySlug } = req.body;
    const userId = req.userId || null;
    const rawAnonId = req.get('x-anonymous-id') || req.body.anonymousId;

    // Anonymous ID is required only when the request is unauthenticated
    const anonymousId = validateAnonymousId(rawAnonId, !userId);

    const data = await feedbackService.submitArticleFeedback({
      articleId,
      vote,
      userId,
      anonymousId,
      articleSlug,
      categorySlug,
    });

    return responseHelper.success(res, data, 'Feedback recorded successfully', 200);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getFeedback,
  submitFeedback,
};
