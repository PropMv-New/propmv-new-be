require('../../../../config/loadEnv');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const {
  articleParamsSchema,
  submitFeedbackBodySchema,
  validateAnonymousId,
} = require('../validators/helpArticleFeedback.validator');
const optionalAuth = require('../middleware/optionalAuth.middleware');
const HelpArticleFeedback = require('../model/helpArticleFeedback.model');

describe('Help Center Feedback - Validators', () => {
  test('articleParamsSchema accepts valid articleId string', () => {
    const { error, value } = articleParamsSchema.validate({
      articleId: 'article-getting-started-roles',
    });
    assert.equal(error, undefined);
    assert.equal(value.articleId, 'article-getting-started-roles');
  });

  test('articleParamsSchema rejects empty articleId', () => {
    const { error } = articleParamsSchema.validate({ articleId: '   ' });
    assert.notEqual(error, undefined);
  });

  test('submitFeedbackBodySchema accepts helpful and not_helpful votes', () => {
    const res1 = submitFeedbackBodySchema.validate({ vote: 'helpful' });
    assert.equal(res1.error, undefined);

    const res2 = submitFeedbackBodySchema.validate({
      vote: 'not_helpful',
      articleSlug: 'my-slug',
      categorySlug: 'my-category',
    });
    assert.equal(res2.error, undefined);
    assert.equal(res2.value.vote, 'not_helpful');
  });

  test('submitFeedbackBodySchema rejects invalid vote value', () => {
    const { error } = submitFeedbackBodySchema.validate({ vote: 'yes' });
    assert.notEqual(error, undefined);
  });

  test('validateAnonymousId accepts valid UUID v4', () => {
    const validUuid = '550e8400-e29b-41d4-a716-446655440000';
    const result = validateAnonymousId(validUuid, true);
    assert.equal(result, validUuid);
  });

  test('validateAnonymousId rejects invalid or non-UUID strings', () => {
    assert.throws(
      () => validateAnonymousId('not-a-valid-uuid', true),
      /Invalid anonymous identifier format/
    );
  });

  test('validateAnonymousId throws when required and missing', () => {
    assert.throws(
      () => validateAnonymousId(null, true),
      /Anonymous identifier \(x-anonymous-id\) is required/
    );
  });

  test('validateAnonymousId returns null when optional and absent', () => {
    const result = validateAnonymousId(undefined, false);
    assert.equal(result, null);
  });
});

describe('Help Center Feedback - optionalAuth Middleware', () => {
  test('proceeds without setting req.userId when no auth header is present', () => {
    const req = { headers: {} };
    const res = {};
    let nextCalled = false;

    optionalAuth(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(req.userId, undefined);
  });

  test('sets req.userId and req.user when valid Bearer token is provided', () => {
    const secret = process.env.JWT_SECRET || 'default_jwt_secret';
    const token = jwt.sign({ sub: 'user_12345', role: 'Owner' }, secret);

    const req = {
      headers: { authorization: `Bearer ${token}` },
    };
    const res = {};
    let nextCalled = false;

    optionalAuth(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(req.userId, 'user_12345');
    assert.equal(req.user._id, 'user_12345');
    assert.equal(req.user.role, 'Owner');
  });

  test('does not throw 401 when token is malformed or invalid on public route', () => {
    const req = {
      headers: { authorization: 'Bearer invalid_garbage_token' },
    };
    const res = {};
    let nextCalled = false;

    optionalAuth(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(req.userId, undefined);
  });
});

describe('Help Center Feedback - Mongoose Model Definition', () => {
  test('uses correct collection name help_article_feedbacks', () => {
    assert.equal(HelpArticleFeedback.collection.name, 'help_article_feedbacks');
  });

  test('defines partial unique indexes for authenticated and anonymous identities', () => {
    const indexes = HelpArticleFeedback.schema.indexes();

    const authIndex = indexes.find(
      ([idx, opts]) => idx.articleId === 1 && idx.userId === 1 && opts.unique === true
    );
    assert.ok(authIndex, 'Authenticated partial unique index exists');
    assert.deepEqual(authIndex[1].partialFilterExpression, { userId: { $type: 'objectId' } });

    const anonIndex = indexes.find(
      ([idx, opts]) => idx.articleId === 1 && idx.anonymousId === 1 && opts.unique === true
    );
    assert.ok(anonIndex, 'Anonymous partial unique index exists');
    assert.deepEqual(anonIndex[1].partialFilterExpression, { anonymousId: { $type: 'string' } });

    const aggregationIndex = indexes.find(
      ([idx]) => idx.articleId === 1 && idx.vote === 1
    );
    assert.ok(aggregationIndex, 'Vote aggregation index exists');
  });
});

describe('Help Center Feedback - Service Logic', () => {
  const { submitArticleFeedback } = require('../service/helpArticleFeedback.service');

  test('submitArticleFeedback rejects when neither userId nor anonymousId is provided', async () => {
    await assert.rejects(
      () => submitArticleFeedback({ articleId: 'art-1', vote: 'helpful' }),
      /Anonymous identifier \(x-anonymous-id\) is required for unauthenticated feedback/
    );
  });
});

