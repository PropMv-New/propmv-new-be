'use strict';

require('../../../../config/loadEnv');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  articleParamsSchema,
  submitFeedbackBodySchema,
  validateAnonymousId,
} = require('../validators/helpArticleFeedback.validator');
const { ValidationError } = require('../../../../common/exceptions');

describe('Help Center Feedback - Comprehensive Validator Tests', () => {
  describe('articleParamsSchema', () => {
    test('1. Valid articleId accepted', () => {
      const validIds = [
        'article-123',
        'sanity-doc-id-abc_123',
        'drafts.article-welcome-to-propmv',
        'a',
      ];
      for (const articleId of validIds) {
        const { error, value } = articleParamsSchema.validate({ articleId });
        assert.equal(error, undefined, `Expected "${articleId}" to be valid`);
        assert.equal(value.articleId, articleId);
      }
    });

    test('2. Empty articleId rejected', () => {
      const invalidEmpty = ['', '   ', '\t\n'];
      for (const emptyVal of invalidEmpty) {
        const { error } = articleParamsSchema.validate({ articleId: emptyVal });
        assert.ok(error, `Expected empty value "${emptyVal}" to be rejected`);
      }
    });

    test('3. Missing articleId rejected', () => {
      assert.ok(articleParamsSchema.validate({}).error);
      assert.ok(articleParamsSchema.validate({ articleId: null }).error);
      assert.ok(articleParamsSchema.validate({ articleId: undefined }).error);
    });

    test('10a. Invalid oversized articleId (> 128 chars) rejected', () => {
      const boundaryValid = 'a'.repeat(128);
      const boundaryInvalid = 'a'.repeat(129);

      const validRes = articleParamsSchema.validate({ articleId: boundaryValid });
      assert.equal(validRes.error, undefined);

      const invalidRes = articleParamsSchema.validate({ articleId: boundaryInvalid });
      assert.ok(invalidRes.error, 'Expected articleId > 128 chars to be rejected');
      assert.match(invalidRes.error.message, /length must be less than or equal to 128/i);
    });
  });

  describe('submitFeedbackBodySchema', () => {
    test('4. Valid helpful vote accepted', () => {
      const { error, value } = submitFeedbackBodySchema.validate({ vote: 'helpful' });
      assert.equal(error, undefined);
      assert.equal(value.vote, 'helpful');
    });

    test('5. Valid not_helpful vote accepted', () => {
      const { error, value } = submitFeedbackBodySchema.validate({ vote: 'not_helpful' });
      assert.equal(error, undefined);
      assert.equal(value.vote, 'not_helpful');
    });

    test('6. Invalid vote rejected', () => {
      const invalidVotes = ['yes', 'no', 'upvote', 'downvote', 'HELPFUL', '1', 1, true, null, ''];
      for (const v of invalidVotes) {
        const { error } = submitFeedbackBodySchema.validate({ vote: v });
        assert.ok(error, `Expected vote "${v}" to be rejected`);
      }
    });

    test('7. Missing vote rejected', () => {
      const { error } = submitFeedbackBodySchema.validate({});
      assert.ok(error, 'Expected missing vote to be rejected');
    });

    test('8. Valid articleSlug accepted', () => {
      const res1 = submitFeedbackBodySchema.validate({ vote: 'helpful', articleSlug: 'getting-started-guide' });
      assert.equal(res1.error, undefined);
      assert.equal(res1.value.articleSlug, 'getting-started-guide');

      // Empty string and null are permitted snapshot values
      const res2 = submitFeedbackBodySchema.validate({ vote: 'helpful', articleSlug: '' });
      assert.equal(res2.error, undefined);
      const res3 = submitFeedbackBodySchema.validate({ vote: 'helpful', articleSlug: null });
      assert.equal(res3.error, undefined);
    });

    test('9. Valid categorySlug accepted', () => {
      const res1 = submitFeedbackBodySchema.validate({ vote: 'helpful', categorySlug: 'payments-and-billing' });
      assert.equal(res1.error, undefined);
      assert.equal(res1.value.categorySlug, 'payments-and-billing');

      const res2 = submitFeedbackBodySchema.validate({ vote: 'helpful', categorySlug: '' });
      assert.equal(res2.error, undefined);
      const res3 = submitFeedbackBodySchema.validate({ vote: 'helpful', categorySlug: null });
      assert.equal(res3.error, undefined);
    });

    test('10b. Invalid oversized articleSlug and categorySlug (> 200 chars) rejected', () => {
      const validSlug = 's'.repeat(200);
      const oversizedSlug = 's'.repeat(201);

      const okRes = submitFeedbackBodySchema.validate({
        vote: 'helpful',
        articleSlug: validSlug,
        categorySlug: validSlug,
      });
      assert.equal(okRes.error, undefined);

      const badArticleSlug = submitFeedbackBodySchema.validate({
        vote: 'helpful',
        articleSlug: oversizedSlug,
      });
      assert.ok(badArticleSlug.error, 'Expected oversized articleSlug to be rejected');

      const badCategorySlug = submitFeedbackBodySchema.validate({
        vote: 'helpful',
        categorySlug: oversizedSlug,
      });
      assert.ok(badCategorySlug.error, 'Expected oversized categorySlug to be rejected');
    });

    test('14. Client-supplied userId is not accepted as authenticated identity', () => {
      const rawInput = {
        vote: 'helpful',
        userId: '507f1f77bcf86cd799439011',
      };
      const { error } = submitFeedbackBodySchema.validate(rawInput);
      assert.ok(error, 'Expected client-supplied userId to be rejected by Joi');
      assert.match(error.message, /"userId" is not allowed/i);
    });
  });

  describe('validateAnonymousId', () => {
    test('11. Valid UUIDs (v4, v1, v5) accepted for anonymous identity', () => {
      const validUuids = [
        '550e8400-e29b-41d4-a716-446655440000', // v4
        '6ba7b810-9dad-11d1-80b4-00c04fd430c8', // v1
        'e5e40e6c-7f59-5b6c-bf93-27eb8e3ab0ef', // v5
        ' 550e8400-e29b-41d4-a716-446655440000 ', // trimmed
      ];

      for (const raw of validUuids) {
        const result = validateAnonymousId(raw, true);
        assert.equal(result, raw.trim());
      }
    });

    test('12. Invalid UUID rejected with ValidationError', () => {
      const invalidUuids = [
        'not-a-uuid',
        '12345',
        '550e8400-e29b-41d4-a716-44665544000Z', // invalid hex
        '550e8400-e29b-41d4-a716-44665544000', // short
        '550e8400-e29b-41d4-a716-4466554400000', // long
        '550e8400_e29b_41d4_a716_446655440000', // underscores
        '{"id": "550e8400-e29b-41d4-a716-446655440000"}',
      ];

      for (const bad of invalidUuids) {
        assert.throws(
          () => validateAnonymousId(bad, false),
          (err) => err instanceof ValidationError && err.message.includes('Invalid anonymous identifier format'),
          `Expected "${bad}" to throw ValidationError`
        );
      }
    });

    test('13. Missing anonymous ID behavior: allowed for GET, rejected for unauthenticated POST', () => {
      // Optional (e.g. GET) returns null
      assert.equal(validateAnonymousId(undefined, false), null);
      assert.equal(validateAnonymousId(null, false), null);
      assert.equal(validateAnonymousId('', false), null);
      assert.equal(validateAnonymousId('   ', false), null);

      // Required (e.g. unauthenticated POST) throws ValidationError
      assert.throws(
        () => validateAnonymousId(undefined, true),
        (err) => err instanceof ValidationError && err.message.includes('Anonymous identifier (x-anonymous-id) is required')
      );
      assert.throws(
        () => validateAnonymousId(null, true),
        (err) => err instanceof ValidationError && err.message.includes('Anonymous identifier (x-anonymous-id) is required')
      );
      assert.throws(
        () => validateAnonymousId('', true),
        (err) => err instanceof ValidationError && err.message.includes('Anonymous identifier (x-anonymous-id) is required')
      );
      assert.throws(
        () => validateAnonymousId('   ', true),
        (err) => err instanceof ValidationError && err.message.includes('Anonymous identifier (x-anonymous-id) is required')
      );
    });
  });
});
