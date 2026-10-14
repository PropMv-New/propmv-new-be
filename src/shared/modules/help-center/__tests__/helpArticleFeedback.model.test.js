'use strict';

require('../../../../config/loadEnv');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const HelpArticleFeedback = require('../model/helpArticleFeedback.model');

describe('Help Center Feedback - Comprehensive Model & Schema Tests', () => {
  test('1. Model name is HelpArticleFeedback', () => {
    assert.equal(HelpArticleFeedback.modelName, 'HelpArticleFeedback');
  });

  test('2. Collection name is help_article_feedbacks', () => {
    assert.equal(HelpArticleFeedback.collection.name, 'help_article_feedbacks');
  });

  test('3. Required fields: articleId and vote are required', () => {
    const docMissingAll = new HelpArticleFeedback({});
    const err = docMissingAll.validateSync();
    assert.ok(err, 'Expected validation error for missing required fields');
    assert.ok(err.errors.articleId, 'articleId must be required');
    assert.ok(err.errors.vote, 'vote must be required');
  });

  test('4. Vote enum accepts only "helpful" and "not_helpful"', () => {
    const validHelpful = new HelpArticleFeedback({
      articleId: 'art-1',
      vote: 'helpful',
      anonymousId: '550e8400-e29b-41d4-a716-446655440000',
    });
    assert.equal(validHelpful.validateSync(), undefined);

    const validNotHelpful = new HelpArticleFeedback({
      articleId: 'art-1',
      vote: 'not_helpful',
      anonymousId: '550e8400-e29b-41d4-a716-446655440000',
    });
    assert.equal(validNotHelpful.validateSync(), undefined);

    const invalidEnum = new HelpArticleFeedback({
      articleId: 'art-1',
      vote: 'invalid_vote_option',
      anonymousId: '550e8400-e29b-41d4-a716-446655440000',
    });
    const err = invalidEnum.validateSync();
    assert.ok(err, 'Expected validation error for invalid vote enum');
    assert.ok(err.errors.vote);
    assert.match(err.errors.vote.message, /`invalid_vote_option` is not a valid enum value/);
  });

  test('5. Timestamps configuration is enabled on schema', () => {
    assert.equal(HelpArticleFeedback.schema.options.timestamps, true);
  });

  test('6. userId is ObjectId referencing User model with null default', () => {
    const userIdPath = HelpArticleFeedback.schema.path('userId');
    assert.ok(userIdPath);
    assert.equal(userIdPath.instance, 'ObjectId');
    assert.equal(userIdPath.options.ref, 'User');
    assert.equal(userIdPath.defaultValue, null);

    // Casting valid ObjectId string works
    const doc = new HelpArticleFeedback({
      articleId: 'art-1',
      vote: 'helpful',
      userId: '507f1f77bcf86cd799439011',
    });
    assert.ok(doc.userId instanceof mongoose.Types.ObjectId);
  });

  test('7. anonymousId is String with max length 64 and null default', () => {
    const anonPath = HelpArticleFeedback.schema.path('anonymousId');
    assert.ok(anonPath);
    assert.equal(anonPath.instance, 'String');
    assert.equal(anonPath.defaultValue, null);

    const validDoc = new HelpArticleFeedback({
      articleId: 'art-1',
      vote: 'helpful',
      anonymousId: '550e8400-e29b-41d4-a716-446655440000',
    });
    assert.equal(validDoc.validateSync(), undefined);

    // Oversized anonymousId (> 64 chars) rejected by Mongoose
    const oversizedDoc = new HelpArticleFeedback({
      articleId: 'art-1',
      vote: 'helpful',
      anonymousId: 'a'.repeat(65),
    });
    const err = oversizedDoc.validateSync();
    assert.ok(err);
    assert.ok(err.errors.anonymousId);
  });

  test('8. Partial unique index on { articleId: 1, userId: 1 } exists with objectId filter', () => {
    const indexes = HelpArticleFeedback.schema.indexes();
    const authUniqueIdx = indexes.find(
      ([fields, opts]) =>
        fields.articleId === 1 && fields.userId === 1 && opts.unique === true
    );
    assert.ok(authUniqueIdx, 'Partial unique index on articleId + userId must exist');
    assert.deepEqual(authUniqueIdx[1].partialFilterExpression, {
      userId: { $type: 'objectId' },
    });
  });

  test('9. Partial unique index on { articleId: 1, anonymousId: 1 } exists with string filter', () => {
    const indexes = HelpArticleFeedback.schema.indexes();
    const anonUniqueIdx = indexes.find(
      ([fields, opts]) =>
        fields.articleId === 1 && fields.anonymousId === 1 && opts.unique === true
    );
    assert.ok(anonUniqueIdx, 'Partial unique index on articleId + anonymousId must exist');
    assert.deepEqual(anonUniqueIdx[1].partialFilterExpression, {
      anonymousId: { $type: 'string' },
    });
  });

  test('10. Aggregation index on { articleId: 1, vote: 1 } exists', () => {
    const indexes = HelpArticleFeedback.schema.indexes();
    const aggIdx = indexes.find(
      ([fields]) => fields.articleId === 1 && fields.vote === 1
    );
    assert.ok(aggIdx, 'Index on { articleId: 1, vote: 1 } must exist for fast covered countDocuments');
  });

  test('11. Authenticated and anonymous records can coexist for the same article', () => {
    const authDoc = new HelpArticleFeedback({
      articleId: 'article-common',
      vote: 'helpful',
      userId: new mongoose.Types.ObjectId(),
      anonymousId: null,
    });
    assert.equal(authDoc.validateSync(), undefined);

    const anonDoc = new HelpArticleFeedback({
      articleId: 'article-common',
      vote: 'not_helpful',
      userId: null,
      anonymousId: '550e8400-e29b-41d4-a716-446655440000',
    });
    assert.equal(anonDoc.validateSync(), undefined);

    // Both documents satisfy schema constraints
    assert.notEqual(authDoc.userId, null);
    assert.equal(authDoc.anonymousId, null);
    assert.equal(anonDoc.userId, null);
    assert.notEqual(anonDoc.anonymousId, null);
  });

  test('12 & 13. Index definitions isolate authenticated and anonymous identities independently', () => {
    const indexes = HelpArticleFeedback.schema.indexes();

    // Verify authenticated partial index ignores null/missing userId records
    const authIdx = indexes.find(([f, o]) => f.userId === 1 && o.unique);
    assert.equal(authIdx[1].partialFilterExpression.userId.$type, 'objectId');

    // Verify anonymous partial index ignores null/missing anonymousId records
    const anonIdx = indexes.find(([f, o]) => f.anonymousId === 1 && o.unique);
    assert.equal(anonIdx[1].partialFilterExpression.anonymousId.$type, 'string');
  });

  test('14 & 15. Documents with different users or different anonymous IDs validate independently', () => {
    const user1Doc = new HelpArticleFeedback({
      articleId: 'art-multi',
      vote: 'helpful',
      userId: new mongoose.Types.ObjectId(),
    });
    const user2Doc = new HelpArticleFeedback({
      articleId: 'art-multi',
      vote: 'not_helpful',
      userId: new mongoose.Types.ObjectId(),
    });
    assert.notEqual(String(user1Doc.userId), String(user2Doc.userId));
    assert.equal(user1Doc.validateSync(), undefined);
    assert.equal(user2Doc.validateSync(), undefined);

    const anon1Doc = new HelpArticleFeedback({
      articleId: 'art-multi',
      vote: 'helpful',
      anonymousId: '550e8400-e29b-41d4-a716-446655440001',
    });
    const anon2Doc = new HelpArticleFeedback({
      articleId: 'art-multi',
      vote: 'not_helpful',
      anonymousId: '550e8400-e29b-41d4-a716-446655440002',
    });
    assert.notEqual(anon1Doc.anonymousId, anon2Doc.anonymousId);
    assert.equal(anon1Doc.validateSync(), undefined);
    assert.equal(anon2Doc.validateSync(), undefined);
  });
});
