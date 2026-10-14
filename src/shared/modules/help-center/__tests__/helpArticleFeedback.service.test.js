'use strict';

require('../../../../config/loadEnv');
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const HelpArticleFeedback = require('../model/helpArticleFeedback.model');
const {
  getArticleFeedbackStats,
  submitArticleFeedback,
} = require('../service/helpArticleFeedback.service');
const { ValidationError } = require('../../../../common/exceptions');

describe('Help Center Feedback - Comprehensive Service Tests', () => {
  let store = [];
  let originalFindOneAndUpdate;
  let originalCountDocuments;
  let originalFindOne;
  let simulateDbError = null;
  let simulateE11000Once = false;

  beforeEach(() => {
    store = [];
    simulateDbError = null;
    simulateE11000Once = false;

    originalFindOneAndUpdate = HelpArticleFeedback.findOneAndUpdate;
    originalCountDocuments = HelpArticleFeedback.countDocuments;
    originalFindOne = HelpArticleFeedback.findOne;

    HelpArticleFeedback.countDocuments = async function (filter) {
      if (simulateDbError) throw simulateDbError;
      return store.filter((doc) => {
        if (filter.articleId && doc.articleId !== filter.articleId) return false;
        if (filter.vote && doc.vote !== filter.vote) return false;
        return true;
      }).length;
    };

    HelpArticleFeedback.findOne = function (filter) {
      if (simulateDbError) throw simulateDbError;
      const doc = store.find((d) => {
        if (filter.articleId && d.articleId !== filter.articleId) return false;
        if (filter.userId && (!d.userId || String(d.userId) !== String(filter.userId))) return false;
        if (filter.anonymousId && d.anonymousId !== filter.anonymousId) return false;
        return true;
      });

      return {
        select: function () {
          return {
            lean: async function () {
              return doc ? { ...doc } : null;
            },
          };
        },
      };
    };

    HelpArticleFeedback.findOneAndUpdate = async function (filter, update, options = {}) {
      if (simulateDbError) throw simulateDbError;
      if (simulateE11000Once) {
        simulateE11000Once = false;
        const err = new Error('E11000 duplicate key error collection: propmv.help_article_feedbacks index: articleId_1_anonymousId_1 dup key');
        err.code = 11000;
        err.name = 'MongoServerError';
        throw err;
      }

      let existingIndex = store.findIndex((d) => {
        if (filter.articleId && d.articleId !== filter.articleId) return false;
        if (filter.userId && (!d.userId || String(d.userId) !== String(filter.userId))) return false;
        if (filter.anonymousId && d.anonymousId !== filter.anonymousId) return false;
        return true;
      });

      if (existingIndex >= 0) {
        // Update existing record
        const doc = store[existingIndex];
        if (update.$set) {
          Object.assign(doc, update.$set);
        }
        doc.updatedAt = new Date();
        return { ...doc };
      }

      if (options.upsert) {
        // Enforce partial unique indexes
        const targetUserId = update.$set?.userId;
        const targetAnonId = update.$set?.anonymousId;
        const targetArticleId = update.$setOnInsert?.articleId || filter.articleId;

        if (targetUserId) {
          const duplicate = store.find(
            (d) => d.articleId === targetArticleId && d.userId && String(d.userId) === String(targetUserId)
          );
          if (duplicate) {
            const err = new Error('E11000 duplicate key error: articleId_1_userId_1');
            err.code = 11000;
            err.name = 'MongoServerError';
            throw err;
          }
        }

        if (targetAnonId) {
          const duplicate = store.find(
            (d) => d.articleId === targetArticleId && d.anonymousId === targetAnonId
          );
          if (duplicate) {
            const err = new Error('E11000 duplicate key error: articleId_1_anonymousId_1');
            err.code = 11000;
            err.name = 'MongoServerError';
            throw err;
          }
        }

        const newDoc = {
          _id: new mongoose.Types.ObjectId(),
          articleId: targetArticleId,
          vote: update.$set?.vote,
          userId: targetUserId || null,
          anonymousId: targetAnonId || null,
          articleSlug: update.$set?.articleSlug || '',
          categorySlug: update.$set?.categorySlug || '',
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        store.push(newDoc);
        return { ...newDoc };
      }

      return null;
    };
  });

  afterEach(() => {
    HelpArticleFeedback.findOneAndUpdate = originalFindOneAndUpdate;
    HelpArticleFeedback.countDocuments = originalCountDocuments;
    HelpArticleFeedback.findOne = originalFindOne;
  });

  test('1. Anonymous helpful vote creates record and returns stats', async () => {
    const anonId = '550e8400-e29b-41d4-a716-446655440001';
    const result = await submitArticleFeedback({
      articleId: 'article-sanity-101',
      vote: 'helpful',
      anonymousId: anonId,
    });

    assert.equal(store.length, 1);
    assert.equal(store[0].articleId, 'article-sanity-101');
    assert.equal(store[0].vote, 'helpful');
    assert.equal(store[0].anonymousId, anonId);
    assert.equal(store[0].userId, null);

    assert.equal(result.articleId, 'article-sanity-101');
    assert.equal(result.helpful, 1);
    assert.equal(result.notHelpful, 0);
    assert.equal(result.total, 1);
    assert.equal(result.userVote, 'helpful');
  });

  test('2. Anonymous not-helpful vote creates record and returns stats', async () => {
    const anonId = '550e8400-e29b-41d4-a716-446655440002';
    const result = await submitArticleFeedback({
      articleId: 'article-sanity-101',
      vote: 'not_helpful',
      anonymousId: anonId,
    });

    assert.equal(store.length, 1);
    assert.equal(store[0].vote, 'not_helpful');
    assert.equal(result.helpful, 0);
    assert.equal(result.notHelpful, 1);
    assert.equal(result.total, 1);
    assert.equal(result.userVote, 'not_helpful');
  });

  test('3. Authenticated helpful vote creates record referencing userId', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const result = await submitArticleFeedback({
      articleId: 'article-sanity-202',
      vote: 'helpful',
      userId,
    });

    assert.equal(store.length, 1);
    assert.equal(store[0].articleId, 'article-sanity-202');
    assert.equal(store[0].vote, 'helpful');
    assert.equal(String(store[0].userId), userId);
    assert.equal(store[0].anonymousId, null);

    assert.equal(result.helpful, 1);
    assert.equal(result.total, 1);
    assert.equal(result.userVote, 'helpful');
  });

  test('4. Authenticated not-helpful vote creates record referencing userId', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const result = await submitArticleFeedback({
      articleId: 'article-sanity-202',
      vote: 'not_helpful',
      userId,
    });

    assert.equal(store.length, 1);
    assert.equal(store[0].vote, 'not_helpful');
    assert.equal(String(store[0].userId), userId);
    assert.equal(result.notHelpful, 1);
    assert.equal(result.userVote, 'not_helpful');
  });

  test('5. Anonymous vote change: helpful -> not_helpful updates existing record', async () => {
    const anonId = '550e8400-e29b-41d4-a716-446655440005';
    await submitArticleFeedback({
      articleId: 'art-switch',
      vote: 'helpful',
      anonymousId: anonId,
    });
    assert.equal(store.length, 1);
    assert.equal(store[0].vote, 'helpful');

    const updated = await submitArticleFeedback({
      articleId: 'art-switch',
      vote: 'not_helpful',
      anonymousId: anonId,
    });

    assert.equal(store.length, 1, 'Must not create a new record when vote changes');
    assert.equal(store[0].vote, 'not_helpful');
    assert.equal(updated.helpful, 0);
    assert.equal(updated.notHelpful, 1);
    assert.equal(updated.total, 1);
    assert.equal(updated.userVote, 'not_helpful');
  });

  test('6. Anonymous vote change: not_helpful -> helpful updates existing record', async () => {
    const anonId = '550e8400-e29b-41d4-a716-446655440006';
    await submitArticleFeedback({
      articleId: 'art-switch',
      vote: 'not_helpful',
      anonymousId: anonId,
    });

    const updated = await submitArticleFeedback({
      articleId: 'art-switch',
      vote: 'helpful',
      anonymousId: anonId,
    });

    assert.equal(store.length, 1);
    assert.equal(store[0].vote, 'helpful');
    assert.equal(updated.helpful, 1);
    assert.equal(updated.notHelpful, 0);
    assert.equal(updated.total, 1);
    assert.equal(updated.userVote, 'helpful');
  });

  test('7. Authenticated vote change: helpful -> not_helpful updates existing record', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    await submitArticleFeedback({
      articleId: 'art-auth-switch',
      vote: 'helpful',
      userId,
    });

    const updated = await submitArticleFeedback({
      articleId: 'art-auth-switch',
      vote: 'not_helpful',
      userId,
    });

    assert.equal(store.length, 1);
    assert.equal(store[0].vote, 'not_helpful');
    assert.equal(updated.helpful, 0);
    assert.equal(updated.notHelpful, 1);
    assert.equal(updated.userVote, 'not_helpful');
  });

  test('8. Authenticated vote change: not_helpful -> helpful updates existing record', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    await submitArticleFeedback({
      articleId: 'art-auth-switch',
      vote: 'not_helpful',
      userId,
    });

    const updated = await submitArticleFeedback({
      articleId: 'art-auth-switch',
      vote: 'helpful',
      userId,
    });

    assert.equal(store.length, 1);
    assert.equal(store[0].vote, 'helpful');
    assert.equal(updated.helpful, 1);
    assert.equal(updated.notHelpful, 0);
    assert.equal(updated.userVote, 'helpful');
  });

  test('9. Repeated same vote updates existing record rather than creating a duplicate', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    await submitArticleFeedback({ articleId: 'art-repeat', vote: 'helpful', userId });
    await submitArticleFeedback({ articleId: 'art-repeat', vote: 'helpful', userId });
    await submitArticleFeedback({ articleId: 'art-repeat', vote: 'helpful', userId });

    assert.equal(store.length, 1);
    assert.equal(store[0].vote, 'helpful');
  });

  test('10. Missing identity is rejected with ValidationError', async () => {
    await assert.rejects(
      () => submitArticleFeedback({ articleId: 'art-noid', vote: 'helpful' }),
      (err) => err instanceof ValidationError && err.message.includes('Anonymous identifier (x-anonymous-id) is required')
    );
  });

  test('11 & 12. Authenticated identity takes precedence over anonymous identity and clears anonymousId', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const anonId = '550e8400-e29b-41d4-a716-446655440012';

    const result = await submitArticleFeedback({
      articleId: 'art-precedence',
      vote: 'helpful',
      userId,
      anonymousId: anonId, // Passed concurrently
    });

    assert.equal(store.length, 1);
    assert.equal(String(store[0].userId), userId);
    assert.equal(store[0].anonymousId, null, 'Must persist only authenticated identity');
    assert.equal(result.userVote, 'helpful');
  });

  test('13, 14, 15. Aggregate counts (helpful, not-helpful, total) calculate accurately', async () => {
    // 3 helpful votes
    store.push({ articleId: 'art-agg', vote: 'helpful', userId: new mongoose.Types.ObjectId() });
    store.push({ articleId: 'art-agg', vote: 'helpful', userId: new mongoose.Types.ObjectId() });
    store.push({ articleId: 'art-agg', vote: 'helpful', anonymousId: '550e8400-e29b-41d4-a716-446655440013' });

    // 2 not-helpful votes
    store.push({ articleId: 'art-agg', vote: 'not_helpful', userId: new mongoose.Types.ObjectId() });
    store.push({ articleId: 'art-agg', vote: 'not_helpful', anonymousId: '550e8400-e29b-41d4-a716-446655440014' });

    // 1 vote for unrelated article
    store.push({ articleId: 'art-unrelated', vote: 'helpful', userId: new mongoose.Types.ObjectId() });

    const stats = await getArticleFeedbackStats({ articleId: 'art-agg' });
    assert.equal(stats.articleId, 'art-agg');
    assert.equal(stats.helpful, 3);
    assert.equal(stats.notHelpful, 2);
    assert.equal(stats.total, 5);
    assert.equal(stats.userVote, null);
  });

  test('16. Current authenticated user vote is retrieved accurately', async () => {
    const myUserId = new mongoose.Types.ObjectId().toString();
    store.push({ articleId: 'art-voter', vote: 'not_helpful', userId: myUserId });

    const stats = await getArticleFeedbackStats({ articleId: 'art-voter', userId: myUserId });
    assert.equal(stats.userVote, 'not_helpful');
  });

  test('17. Current anonymous user vote is retrieved accurately', async () => {
    const myAnonId = '550e8400-e29b-41d4-a716-446655440017';
    store.push({ articleId: 'art-voter', vote: 'helpful', anonymousId: myAnonId });

    const stats = await getArticleFeedbackStats({ articleId: 'art-voter', anonymousId: myAnonId });
    assert.equal(stats.userVote, 'helpful');
  });

  test('18. No current identity provided: userVote returns null', async () => {
    store.push({ articleId: 'art-guest', vote: 'helpful', anonymousId: '550e8400-e29b-41d4-a716-446655440018' });

    const stats = await getArticleFeedbackStats({ articleId: 'art-guest', userId: null, anonymousId: null });
    assert.equal(stats.userVote, null);
    assert.equal(stats.helpful, 1);
  });

  test('19. Feedback from another identity is never returned as caller userVote', async () => {
    const otherUserId = new mongoose.Types.ObjectId().toString();
    const callerUserId = new mongoose.Types.ObjectId().toString();
    store.push({ articleId: 'art-iso', vote: 'helpful', userId: otherUserId });

    const stats = await getArticleFeedbackStats({ articleId: 'art-iso', userId: callerUserId });
    assert.equal(stats.helpful, 1);
    assert.equal(stats.userVote, null);
  });

  test('20. Different users can vote independently on the same article', async () => {
    const userA = new mongoose.Types.ObjectId().toString();
    const userB = new mongoose.Types.ObjectId().toString();

    await submitArticleFeedback({ articleId: 'art-multi-user', vote: 'helpful', userId: userA });
    await submitArticleFeedback({ articleId: 'art-multi-user', vote: 'not_helpful', userId: userB });

    assert.equal(store.length, 2);
    const statsA = await getArticleFeedbackStats({ articleId: 'art-multi-user', userId: userA });
    const statsB = await getArticleFeedbackStats({ articleId: 'art-multi-user', userId: userB });

    assert.equal(statsA.userVote, 'helpful');
    assert.equal(statsB.userVote, 'not_helpful');
    assert.equal(statsA.total, 2);
  });

  test('21. Same user can vote on different articles independently', async () => {
    const userId = new mongoose.Types.ObjectId().toString();

    await submitArticleFeedback({ articleId: 'art-1', vote: 'helpful', userId });
    await submitArticleFeedback({ articleId: 'art-2', vote: 'not_helpful', userId });

    assert.equal(store.length, 2);
    const stats1 = await getArticleFeedbackStats({ articleId: 'art-1', userId });
    const stats2 = await getArticleFeedbackStats({ articleId: 'art-2', userId });

    assert.equal(stats1.userVote, 'helpful');
    assert.equal(stats2.userVote, 'not_helpful');
  });

  test('22. Same anonymous identity can vote on different articles independently', async () => {
    const anonId = '550e8400-e29b-41d4-a716-446655440022';

    await submitArticleFeedback({ articleId: 'art-1', vote: 'helpful', anonymousId: anonId });
    await submitArticleFeedback({ articleId: 'art-2', vote: 'helpful', anonymousId: anonId });

    assert.equal(store.length, 2);
    const stats1 = await getArticleFeedbackStats({ articleId: 'art-1', anonymousId: anonId });
    const stats2 = await getArticleFeedbackStats({ articleId: 'art-2', anonymousId: anonId });

    assert.equal(stats1.userVote, 'helpful');
    assert.equal(stats2.userVote, 'helpful');
  });

  test('23. Invalid or different article identity does not cause cross-article data leakage', async () => {
    store.push({ articleId: 'real-article', vote: 'helpful', anonymousId: '550e8400-e29b-41d4-a716-446655440023' });

    const ghostStats = await getArticleFeedbackStats({ articleId: 'non-existent-article' });
    assert.equal(ghostStats.helpful, 0);
    assert.equal(ghostStats.notHelpful, 0);
    assert.equal(ghostStats.total, 0);
    assert.equal(ghostStats.userVote, null);
  });

  test('24. Unexpected database error is not silently swallowed', async () => {
    simulateDbError = new Error('Database connection lost');

    await assert.rejects(
      () => submitArticleFeedback({ articleId: 'art-err', vote: 'helpful', anonymousId: '550e8400-e29b-41d4-a716-446655440024' }),
      /Database connection lost/
    );

    await assert.rejects(
      () => getArticleFeedbackStats({ articleId: 'art-err' }),
      /Database connection lost/
    );
  });

  test('25. Duplicate-key (E11000) race handling recovers and updates the winning record', async () => {
    const anonId = '550e8400-e29b-41d4-a716-446655440025';

    // Simulate winning race document already exists in DB
    store.push({
      _id: new mongoose.Types.ObjectId(),
      articleId: 'art-race',
      vote: 'helpful',
      anonymousId: anonId,
      userId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Next call will trigger an E11000 on first findOneAndUpdate, then succeed on retry
    simulateE11000Once = true;

    const result = await submitArticleFeedback({
      articleId: 'art-race',
      vote: 'not_helpful',
      anonymousId: anonId,
    });

    assert.equal(store.length, 1);
    assert.equal(store[0].vote, 'not_helpful');
    assert.equal(result.userVote, 'not_helpful');
    assert.equal(result.notHelpful, 1);
  });

  describe('Sanity Boundary Tests', () => {
    test('Stores feedback against opaque Sanity string ID without MongoDB article lookup', async () => {
      const sanityId = 'drafts.3a4b5c6d-7e8f-9a0b-1c2d-3e4f5a6b7c8d';
      const result = await submitArticleFeedback({
        articleId: sanityId,
        vote: 'helpful',
        anonymousId: '550e8400-e29b-41d4-a716-446655440030',
        articleSlug: 'how-to-submit-maintenance',
        categorySlug: 'maintenance',
      });

      assert.equal(result.articleId, sanityId);
      assert.equal(store[0].articleId, sanityId);
      assert.equal(store[0].articleSlug, 'how-to-submit-maintenance');
      assert.equal(store[0].categorySlug, 'maintenance');
    });

    test('Slug is not primary identity: changing articleSlug does not create a second record', async () => {
      const sanityId = 'sanity-fixed-article-id';
      const anonId = '550e8400-e29b-41d4-a716-446655440031';

      await submitArticleFeedback({
        articleId: sanityId,
        vote: 'helpful',
        anonymousId: anonId,
        articleSlug: 'old-slug-title',
      });
      assert.equal(store.length, 1);
      assert.equal(store[0].articleSlug, 'old-slug-title');

      await submitArticleFeedback({
        articleId: sanityId,
        vote: 'helpful',
        anonymousId: anonId,
        articleSlug: 'new-renamed-slug-title',
      });

      assert.equal(store.length, 1, 'Changing articleSlug must update the same record');
      assert.equal(store[0].articleSlug, 'new-renamed-slug-title');
    });
  });
});
