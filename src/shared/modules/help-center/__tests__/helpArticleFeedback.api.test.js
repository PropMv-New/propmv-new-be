'use strict';

require('../../../../config/loadEnv');
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const HelpArticleFeedback = require('../model/helpArticleFeedback.model');
const helpCenterRouter = require('../routes/helpArticleFeedback.routes');
const errorHandler = require('../../../../middleware/errorHandler');
const config = require('../../../../config/default');

describe('Help Center Feedback - Integration / API Tests', () => {
  let server;
  let baseUrl;
  let store = [];
  const secret = process.env.JWT_SECRET || config.jwt.secret || 'default_jwt_secret';

  // Helper to generate valid auth header
  function makeAuthHeader(userId = '507f1f77bcf86cd799439011', role = 'User') {
    const token = jwt.sign({ sub: userId, role }, secret, { expiresIn: '1h' });
    return `Bearer ${token}`;
  }

  // Common headers for CSRF-protected POST requests
  const csrfHeaders = {
    'X-Requested-With': 'XMLHttpRequest',
  };

  before(async () => {
    // Intercept Mongoose queries with isolated in-memory store
    HelpArticleFeedback.countDocuments = async function (filter) {
      return store.filter((doc) => {
        if (filter.articleId && doc.articleId !== filter.articleId) return false;
        if (filter.vote && doc.vote !== filter.vote) return false;
        return true;
      }).length;
    };

    HelpArticleFeedback.findOne = function (filter) {
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
      let existingIndex = store.findIndex((d) => {
        if (filter.articleId && d.articleId !== filter.articleId) return false;
        if (filter.userId && (!d.userId || String(d.userId) !== String(filter.userId))) return false;
        if (filter.anonymousId && d.anonymousId !== filter.anonymousId) return false;
        return true;
      });

      if (existingIndex >= 0) {
        const doc = store[existingIndex];
        if (update.$set) Object.assign(doc, update.$set);
        doc.updatedAt = new Date();
        return { ...doc };
      }

      if (options.upsert) {
        const newDoc = {
          _id: new mongoose.Types.ObjectId(),
          articleId: update.$setOnInsert?.articleId || filter.articleId,
          vote: update.$set?.vote,
          userId: update.$set?.userId || null,
          anonymousId: update.$set?.anonymousId || null,
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

    // Create Express test application
    const app = express();
    app.use(express.json());
    app.use('/api/v1/help-center', helpCenterRouter);
    app.use(errorHandler);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}/api/v1/help-center`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(() => {
    store = [];
  });

  describe('GET /api/v1/help-center/articles/:articleId/feedback', () => {
    test('1. Anonymous GET with no anonymous ID: returns aggregate counts and null userVote', async () => {
      store.push({ articleId: 'art-1', vote: 'helpful', userId: new mongoose.Types.ObjectId() });
      store.push({ articleId: 'art-1', vote: 'not_helpful', userId: new mongoose.Types.ObjectId() });

      const res = await axios.get(`${baseUrl}/articles/art-1/feedback`, {
        validateStatus: () => true,
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.statuscode, 200);
      assert.equal(res.data.message, 'Success');
      assert.deepEqual(res.data.data, {
        articleId: 'art-1',
        helpful: 1,
        notHelpful: 1,
        total: 2,
        userVote: null,
      });
    });

    test('2. Anonymous GET with valid x-anonymous-id: returns aggregate counts and anonymous vote', async () => {
      const anonId = '550e8400-e29b-41d4-a716-446655440020';
      store.push({ articleId: 'art-2', vote: 'helpful', anonymousId: anonId });

      const res = await axios.get(`${baseUrl}/articles/art-2/feedback`, {
        headers: { 'x-anonymous-id': anonId },
        validateStatus: () => true,
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.data.helpful, 1);
      assert.equal(res.data.data.userVote, 'helpful');
    });

    test('3. Authenticated GET: returns authenticated user vote', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      store.push({ articleId: 'art-3', vote: 'not_helpful', userId });

      const res = await axios.get(`${baseUrl}/articles/art-3/feedback`, {
        headers: { authorization: makeAuthHeader(userId) },
        validateStatus: () => true,
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.data.userVote, 'not_helpful');
    });

    test('4. Authenticated GET with x-anonymous-id also present: authenticated identity takes precedence', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const anonId = '550e8400-e29b-41d4-a716-446655440040';

      // Seed both votes under different identities
      store.push({ articleId: 'art-4', vote: 'helpful', userId });
      store.push({ articleId: 'art-4', vote: 'not_helpful', anonymousId: anonId });

      const res = await axios.get(`${baseUrl}/articles/art-4/feedback`, {
        headers: {
          authorization: makeAuthHeader(userId),
          'x-anonymous-id': anonId,
        },
        validateStatus: () => true,
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.data.total, 2);
      assert.equal(res.data.data.userVote, 'helpful', 'Authenticated vote must take precedence');
    });

    test('5. GET for article with no feedback: zero counts and null userVote', async () => {
      const res = await axios.get(`${baseUrl}/articles/art-empty/feedback`, {
        validateStatus: () => true,
      });

      assert.equal(res.status, 200);
      assert.deepEqual(res.data.data, {
        articleId: 'art-empty',
        helpful: 0,
        notHelpful: 0,
        total: 0,
        userVote: null,
      });
    });

    test('6. GET for one article must not include votes from another article', async () => {
      store.push({ articleId: 'art-A', vote: 'helpful', userId: new mongoose.Types.ObjectId() });
      store.push({ articleId: 'art-B', vote: 'not_helpful', userId: new mongoose.Types.ObjectId() });

      const resA = await axios.get(`${baseUrl}/articles/art-A/feedback`);
      const resB = await axios.get(`${baseUrl}/articles/art-B/feedback`);

      assert.equal(resA.data.data.helpful, 1);
      assert.equal(resA.data.data.notHelpful, 0);

      assert.equal(resB.data.data.helpful, 0);
      assert.equal(resB.data.data.notHelpful, 1);
    });

    test('7. GET does not expose user IDs, anonymous IDs, IP addresses, or identity information', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const anonId = '550e8400-e29b-41d4-a716-446655440070';
      store.push({ articleId: 'art-privacy', vote: 'helpful', userId });

      const res = await axios.get(`${baseUrl}/articles/art-privacy/feedback`, {
        headers: { authorization: makeAuthHeader(userId), 'x-anonymous-id': anonId },
      });

      const dataKeys = Object.keys(res.data.data).sort();
      assert.deepEqual(dataKeys, ['articleId', 'helpful', 'notHelpful', 'total', 'userVote']);
      assert.equal(res.data.data.userId, undefined);
      assert.equal(res.data.data.anonymousId, undefined);
      assert.equal(res.data.data.ip, undefined);
    });

    test('8. Response envelope conforms to { message, statuscode, data }', async () => {
      const res = await axios.get(`${baseUrl}/articles/art-env/feedback`);
      assert.ok('message' in res.data);
      assert.ok('statuscode' in res.data);
      assert.ok('data' in res.data);
    });
  });

  describe('POST /api/v1/help-center/articles/:articleId/feedback', () => {
    test('1. Anonymous helpful vote creates record', async () => {
      const anonId = '550e8400-e29b-41d4-a716-446655440101';
      const res = await axios.post(
        `${baseUrl}/articles/art-post-1/feedback`,
        { vote: 'helpful' },
        { headers: { ...csrfHeaders, 'x-anonymous-id': anonId } }
      );

      assert.equal(res.status, 200);
      assert.equal(res.data.data.helpful, 1);
      assert.equal(res.data.data.userVote, 'helpful');
      assert.equal(store.length, 1);
      assert.equal(store[0].anonymousId, anonId);
    });

    test('2. Anonymous not-helpful vote creates record', async () => {
      const anonId = '550e8400-e29b-41d4-a716-446655440102';
      const res = await axios.post(
        `${baseUrl}/articles/art-post-2/feedback`,
        { vote: 'not_helpful' },
        { headers: { ...csrfHeaders, 'x-anonymous-id': anonId } }
      );

      assert.equal(res.status, 200);
      assert.equal(res.data.data.notHelpful, 1);
      assert.equal(res.data.data.userVote, 'not_helpful');
    });

    test('3. Authenticated helpful vote creates record', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const res = await axios.post(
        `${baseUrl}/articles/art-post-3/feedback`,
        { vote: 'helpful' },
        { headers: { ...csrfHeaders, authorization: makeAuthHeader(userId) } }
      );

      assert.equal(res.status, 200);
      assert.equal(res.data.data.helpful, 1);
      assert.equal(res.data.data.userVote, 'helpful');
      assert.equal(String(store[0].userId), userId);
      assert.equal(store[0].anonymousId, null);
    });

    test('4. Authenticated not-helpful vote creates record', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const res = await axios.post(
        `${baseUrl}/articles/art-post-4/feedback`,
        { vote: 'not_helpful' },
        { headers: { ...csrfHeaders, authorization: makeAuthHeader(userId) } }
      );

      assert.equal(res.status, 200);
      assert.equal(res.data.data.notHelpful, 1);
      assert.equal(res.data.data.userVote, 'not_helpful');
    });

    test('5 & 6. Anonymous vote change (helpful <-> not_helpful) updates existing record', async () => {
      const anonId = '550e8400-e29b-41d4-a716-446655440105';
      const res1 = await axios.post(
        `${baseUrl}/articles/art-post-5/feedback`,
        { vote: 'helpful' },
        { headers: { ...csrfHeaders, 'x-anonymous-id': anonId } }
      );
      assert.equal(res1.data.data.userVote, 'helpful');
      assert.equal(store.length, 1);

      // Change to not_helpful
      const res2 = await axios.post(
        `${baseUrl}/articles/art-post-5/feedback`,
        { vote: 'not_helpful' },
        { headers: { ...csrfHeaders, 'x-anonymous-id': anonId } }
      );
      assert.equal(res2.data.data.helpful, 0);
      assert.equal(res2.data.data.notHelpful, 1);
      assert.equal(res2.data.data.userVote, 'not_helpful');
      assert.equal(store.length, 1, 'Only one record must exist in DB');

      // Change back to helpful
      const res3 = await axios.post(
        `${baseUrl}/articles/art-post-5/feedback`,
        { vote: 'helpful' },
        { headers: { ...csrfHeaders, 'x-anonymous-id': anonId } }
      );
      assert.equal(res3.data.data.helpful, 1);
      assert.equal(res3.data.data.notHelpful, 0);
      assert.equal(res3.data.data.userVote, 'helpful');
      assert.equal(store.length, 1);
    });

    test('7 & 8. Authenticated vote change (helpful <-> not_helpful) updates existing record', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const authHeaders = { ...csrfHeaders, authorization: makeAuthHeader(userId) };

      await axios.post(`${baseUrl}/articles/art-post-7/feedback`, { vote: 'helpful' }, { headers: authHeaders });
      assert.equal(store.length, 1);

      const res2 = await axios.post(`${baseUrl}/articles/art-post-7/feedback`, { vote: 'not_helpful' }, { headers: authHeaders });
      assert.equal(res2.data.data.userVote, 'not_helpful');
      assert.equal(store.length, 1);

      const res3 = await axios.post(`${baseUrl}/articles/art-post-7/feedback`, { vote: 'helpful' }, { headers: authHeaders });
      assert.equal(res3.data.data.userVote, 'helpful');
      assert.equal(store.length, 1);
    });

    test('9. Repeated same vote does not duplicate logical record', async () => {
      const anonId = '550e8400-e29b-41d4-a716-446655440109';
      const headers = { ...csrfHeaders, 'x-anonymous-id': anonId };

      await axios.post(`${baseUrl}/articles/art-post-9/feedback`, { vote: 'helpful' }, { headers });
      await axios.post(`${baseUrl}/articles/art-post-9/feedback`, { vote: 'helpful' }, { headers });
      await axios.post(`${baseUrl}/articles/art-post-9/feedback`, { vote: 'helpful' }, { headers });

      assert.equal(store.length, 1);
      assert.equal(store[0].vote, 'helpful');
    });

    test('10. Anonymous POST without x-anonymous-id: rejected with 400 validation error', async () => {
      const res = await axios.post(
        `${baseUrl}/articles/art-post-10/feedback`,
        { vote: 'helpful' },
        { headers: csrfHeaders, validateStatus: () => true }
      );

      assert.equal(res.status, 400);
      assert.match(res.data.message, /Anonymous identifier .* is required/i);
      assert.equal(store.length, 0, 'No database record created');
    });

    test('11. Anonymous POST with invalid UUID: rejected with 400 validation error', async () => {
      const res = await axios.post(
        `${baseUrl}/articles/art-post-11/feedback`,
        { vote: 'helpful' },
        { headers: { ...csrfHeaders, 'x-anonymous-id': 'invalid-uuid-format' }, validateStatus: () => true }
      );

      assert.equal(res.status, 400);
      assert.match(res.data.message, /Invalid anonymous identifier format/i);
      assert.equal(store.length, 0);
    });

    test('12. Invalid vote value: rejected with 400 validation error', async () => {
      const anonId = '550e8400-e29b-41d4-a716-446655440112';
      const res = await axios.post(
        `${baseUrl}/articles/art-post-12/feedback`,
        { vote: 'yes_please' },
        { headers: { ...csrfHeaders, 'x-anonymous-id': anonId }, validateStatus: () => true }
      );

      assert.equal(res.status, 400);
      assert.equal(store.length, 0);
    });

    test('13. Missing vote in body: rejected with 400 validation error', async () => {
      const anonId = '550e8400-e29b-41d4-a716-446655440113';
      const res = await axios.post(
        `${baseUrl}/articles/art-post-13/feedback`,
        {},
        { headers: { ...csrfHeaders, 'x-anonymous-id': anonId }, validateStatus: () => true }
      );

      assert.equal(res.status, 400);
      assert.equal(store.length, 0);
    });

    test('14. Authenticated POST with fake client userId in body: fake userId ignored, authenticated req.userId used', async () => {
      const realUserId = new mongoose.Types.ObjectId().toString();
      const fakeAttackerUserId = new mongoose.Types.ObjectId().toString();

      // Body validator rejects unknown fields like userId outright
      const res = await axios.post(
        `${baseUrl}/articles/art-post-14/feedback`,
        { vote: 'helpful', userId: fakeAttackerUserId },
        {
          headers: { ...csrfHeaders, authorization: makeAuthHeader(realUserId) },
          validateStatus: () => true,
        }
      );

      assert.equal(res.status, 400);
      assert.match(res.data.message, /Validation failed/);
      assert.equal(store.length, 0, 'Must not accept fake userId');
    });

    test('15. Authenticated POST with x-anonymous-id present: authenticated identity wins and persists', async () => {
      const realUserId = new mongoose.Types.ObjectId().toString();
      const anonId = '550e8400-e29b-41d4-a716-446655440115';

      const res = await axios.post(
        `${baseUrl}/articles/art-post-15/feedback`,
        { vote: 'helpful' },
        {
          headers: {
            ...csrfHeaders,
            authorization: makeAuthHeader(realUserId),
            'x-anonymous-id': anonId,
          },
          validateStatus: () => true,
        }
      );

      assert.equal(res.status, 200);
      assert.equal(store.length, 1);
      assert.equal(String(store[0].userId), realUserId);
      assert.equal(store[0].anonymousId, null);
    });

    test('16. Different anonymous IDs can vote independently', async () => {
      const id1 = '550e8400-e29b-41d4-a716-446655440116';
      const id2 = '550e8400-e29b-41d4-a716-446655440117';

      await axios.post(`${baseUrl}/articles/art-multi/feedback`, { vote: 'helpful' }, { headers: { ...csrfHeaders, 'x-anonymous-id': id1 } });
      await axios.post(`${baseUrl}/articles/art-multi/feedback`, { vote: 'not_helpful' }, { headers: { ...csrfHeaders, 'x-anonymous-id': id2 } });

      assert.equal(store.length, 2);
    });

    test('17. Different authenticated users can vote independently', async () => {
      const u1 = new mongoose.Types.ObjectId().toString();
      const u2 = new mongoose.Types.ObjectId().toString();

      await axios.post(`${baseUrl}/articles/art-users/feedback`, { vote: 'helpful' }, { headers: { ...csrfHeaders, authorization: makeAuthHeader(u1) } });
      await axios.post(`${baseUrl}/articles/art-users/feedback`, { vote: 'not_helpful' }, { headers: { ...csrfHeaders, authorization: makeAuthHeader(u2) } });

      assert.equal(store.length, 2);
    });

    test('18. Same identity voting on different articles creates independent records', async () => {
      const anonId = '550e8400-e29b-41d4-a716-446655440118';
      const headers = { ...csrfHeaders, 'x-anonymous-id': anonId };

      await axios.post(`${baseUrl}/articles/art-X/feedback`, { vote: 'helpful' }, { headers });
      await axios.post(`${baseUrl}/articles/art-Y/feedback`, { vote: 'not_helpful' }, { headers });

      assert.equal(store.length, 2);
      assert.equal(store[0].articleId, 'art-X');
      assert.equal(store[1].articleId, 'art-Y');
    });

    test('19. Same article with authenticated and anonymous identities creates separate records', async () => {
      const u1 = new mongoose.Types.ObjectId().toString();
      const anonId = '550e8400-e29b-41d4-a716-446655440119';

      await axios.post(`${baseUrl}/articles/art-coexist/feedback`, { vote: 'helpful' }, { headers: { ...csrfHeaders, authorization: makeAuthHeader(u1) } });
      await axios.post(`${baseUrl}/articles/art-coexist/feedback`, { vote: 'not_helpful' }, { headers: { ...csrfHeaders, 'x-anonymous-id': anonId } });

      assert.equal(store.length, 2);
    });

    test('20 & 21. Response contains updated aggregate counts and caller resulting userVote', async () => {
      const anonId = '550e8400-e29b-41d4-a716-446655440120';
      const res = await axios.post(
        `${baseUrl}/articles/art-counts/feedback`,
        { vote: 'helpful', articleSlug: 'my-slug', categorySlug: 'my-cat' },
        { headers: { ...csrfHeaders, 'x-anonymous-id': anonId } }
      );

      assert.equal(res.status, 200);
      assert.equal(res.data.data.helpful, 1);
      assert.equal(res.data.data.notHelpful, 0);
      assert.equal(res.data.data.total, 1);
      assert.equal(res.data.data.userVote, 'helpful');
      assert.equal(res.data.data.articleId, 'art-counts');
    });

    test('22. POST response follows standard envelope { message, statuscode, data }', async () => {
      const anonId = '550e8400-e29b-41d4-a716-446655440122';
      const res = await axios.post(
        `${baseUrl}/articles/art-env-post/feedback`,
        { vote: 'helpful' },
        { headers: { ...csrfHeaders, 'x-anonymous-id': anonId } }
      );

      assert.equal(res.status, 200);
      assert.equal(res.data.statuscode, 200);
      assert.equal(res.data.message, 'Feedback recorded successfully');
      assert.ok(typeof res.data.data === 'object');
    });
  });

  describe('CSRF Protection Tests (STEP 7)', () => {
    test('1. POST without X-Requested-With header is rejected with 403 Forbidden', async () => {
      const anonId = '550e8400-e29b-41d4-a716-446655440201';
      const res = await axios.post(
        `${baseUrl}/articles/art-csrf-1/feedback`,
        { vote: 'helpful' },
        {
          headers: { 'x-anonymous-id': anonId }, // missing X-Requested-With
          validateStatus: () => true,
        }
      );

      assert.equal(res.status, 403);
      assert.match(res.data.message, /missing or invalid X-Requested-With header/i);
      assert.equal(store.length, 0);
    });

    test('2. POST with invalid X-Requested-With is rejected with 403', async () => {
      const anonId = '550e8400-e29b-41d4-a716-446655440202';
      const res = await axios.post(
        `${baseUrl}/articles/art-csrf-2/feedback`,
        { vote: 'helpful' },
        {
          headers: {
            'x-anonymous-id': anonId,
            'X-Requested-With': 'BadValue',
          },
          validateStatus: () => true,
        }
      );

      assert.equal(res.status, 403);
      assert.match(res.data.message, /missing or invalid X-Requested-With header/i);
    });

    test('3. POST with untrusted Origin is rejected with 403', async () => {
      const anonId = '550e8400-e29b-41d4-a716-446655440203';
      const res = await axios.post(
        `${baseUrl}/articles/art-csrf-3/feedback`,
        { vote: 'helpful' },
        {
          headers: {
            ...csrfHeaders,
            'x-anonymous-id': anonId,
            origin: 'https://evil-hacker-site.com',
          },
          validateStatus: () => true,
        }
      );

      assert.equal(res.status, 403);
      assert.match(res.data.message, /untrusted request origin/i);
      assert.equal(store.length, 0);
    });

    test('4. GET does not require CSRF header (safe method)', async () => {
      const res = await axios.get(`${baseUrl}/articles/art-csrf-4/feedback`, {
        validateStatus: () => true,
      });

      assert.equal(res.status, 200);
    });
  });
});
