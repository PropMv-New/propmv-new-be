const Joi = require('joi');
const { ValidationError } = require('../../../../common/exceptions');

const articleParamsSchema = Joi.object({
  articleId: Joi.string().trim().min(1).max(128).required(),
});

const submitFeedbackBodySchema = Joi.object({
  vote: Joi.string().valid('helpful', 'not_helpful').required(),
  articleSlug: Joi.string().trim().max(200).allow('', null),
  categorySlug: Joi.string().trim().max(200).allow('', null),
});

const anonymousIdSchema = Joi.string()
  .guid({ version: ['uuidv4', 'uuidv1', 'uuidv5'] })
  .required();

/**
 * Validates the raw anonymous identifier string if provided.
 *
 * @param {string|null|undefined} rawId - The raw header or input value
 * @param {boolean} [isRequired=false] - Whether the anonymous ID is mandatory
 * @returns {string|null} The trimmed, validated UUID or null
 * @throws {ValidationError} If required and missing, or if format is not a valid UUID
 */
function validateAnonymousId(rawId, isRequired = false) {
  const anonId = typeof rawId === 'string' ? rawId.trim() : null;

  if (!anonId) {
    if (isRequired) {
      throw new ValidationError('Anonymous identifier (x-anonymous-id) is required for unauthenticated feedback');
    }
    return null;
  }

  const { error, value } = anonymousIdSchema.validate(anonId);
  if (error) {
    throw new ValidationError('Invalid anonymous identifier format. Must be a valid UUID');
  }

  return value;
}

module.exports = {
  articleParamsSchema,
  submitFeedbackBodySchema,
  validateAnonymousId,
};
