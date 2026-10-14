const express = require('express');
const router = express.Router();

const feedbackController = require('../controller/helpArticleFeedback.controller');
const optionalAuth = require('../middleware/optionalAuth.middleware');
const csrfProtection = require('../../../../middleware/csrfProtection');
const { validateParams, validateBody } = require('../../../../middleware/requestValidator');
const {
  articleParamsSchema,
  submitFeedbackBodySchema,
} = require('../validators/helpArticleFeedback.validator');

// GET /api/v1/help-center/articles/:articleId/feedback - Public read-only stats & visitor vote
router.get(
  '/articles/:articleId/feedback',
  optionalAuth,
  validateParams(articleParamsSchema),
  feedbackController.getFeedback
);

// POST /api/v1/help-center/articles/:articleId/feedback - Public vote submission / change
router.post(
  '/articles/:articleId/feedback',
  csrfProtection,
  optionalAuth,
  validateParams(articleParamsSchema),
  validateBody(submitFeedbackBodySchema),
  feedbackController.submitFeedback
);

module.exports = router;
