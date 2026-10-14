/**
 * Unit tests for mock Zillow external API (exact path parity with real Zillow).
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const axios = require('axios');
const {
  createZillowMockRouter,
  ZILLOW_EXTERNAL_API_PATHS,
  ZILLOW_INTEGRATED_OUTBOUND_APIS,
} = require('../integrations/syndication/zillow/mock/zillowMockApi');
const mockState = require('../integrations/syndication/zillow/mock/zillowMockState');
const { parseMarkForUpdateResponse, parseGetStatusResponse } = require('../integrations/syndication/zillow/zillowResponseParser');

const MOCK_API_KEY = 'test-mock-key';
const MOCK_FEED_ID = 'test-feed';

async function withMockServer(handler, fn) {
  const app = express();
  app.use('/', handler);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    return await fn(base);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe('Zillow integrated outbound APIs catalog', () => {
  test('covers every outbound Zillow API used by PropMv', () => {
    assert.equal(ZILLOW_INTEGRATED_OUTBOUND_APIS.length, 2);
    const ids = ZILLOW_INTEGRATED_OUTBOUND_APIS.map((a) => a.id).sort();
    assert.deepEqual(ids, ['getStatus', 'markForUpdate']);
  });

  test('mock paths match official Zillow API path suffixes exactly', () => {
    assert.equal(
      ZILLOW_EXTERNAL_API_PATHS.MARK_FOR_UPDATE,
      '/listing-tools/api/v1/externalListing/markForUpdate'
    );
    assert.equal(
      ZILLOW_EXTERNAL_API_PATHS.GET_STATUS,
      '/listing-tools/api/v1/syndication/getStatus'
    );
  });
});

describe('Zillow mock API', () => {
  beforeEach(() => {
    mockState.reset();
  });

  test('markForUpdate uses exact Zillow path and returns XML with succes typo', async () => {
    const router = createZillowMockRouter({
      expectedApiKey: MOCK_API_KEY,
      expectedFeedId: MOCK_FEED_ID,
      simulateCallback: false,
    });

    await withMockServer(router, async (base) => {
      const url = `${base}${ZILLOW_EXTERNAL_API_PATHS.MARK_FOR_UPDATE}`;
      const response = await axios.get(url, {
        params: {
          apikey: MOCK_API_KEY,
          feedId: MOCK_FEED_ID,
          feedListingIds: '507f1f77bcf86cd799439011',
        },
        responseType: 'text',
      });

      assert.equal(response.status, 200);
      const parsed = parseMarkForUpdateResponse(response.data);
      assert.equal(parsed.success, true);
      assert.equal(parsed.queued, 1);
    });
  });

  test('markForUpdate rejects invalid api key', async () => {
    const router = createZillowMockRouter({
      expectedApiKey: MOCK_API_KEY,
      expectedFeedId: MOCK_FEED_ID,
      simulateCallback: false,
    });

    await withMockServer(router, async (base) => {
      const response = await axios.get(`${base}${ZILLOW_EXTERNAL_API_PATHS.MARK_FOR_UPDATE}`, {
        params: {
          apikey: 'wrong-key',
          feedId: MOCK_FEED_ID,
          feedListingIds: 'abc123',
        },
        responseType: 'text',
        validateStatus: () => true,
      });

      assert.equal(response.status, 401);
      const parsed = parseMarkForUpdateResponse(response.data);
      assert.equal(parsed.success, false);
    });
  });

  test('getStatus uses exact Zillow path and returns listing status', async () => {
    const router = createZillowMockRouter({
      expectedApiKey: MOCK_API_KEY,
      expectedFeedId: MOCK_FEED_ID,
      simulateCallback: false,
    });

    await withMockServer(router, async (base) => {
      await axios.get(`${base}${ZILLOW_EXTERNAL_API_PATHS.MARK_FOR_UPDATE}`, {
        params: {
          apikey: MOCK_API_KEY,
          feedId: MOCK_FEED_ID,
          feedListingIds: '507f1f77bcf86cd799439011',
        },
      });

      const statusResponse = await axios.get(`${base}${ZILLOW_EXTERNAL_API_PATHS.GET_STATUS}`, {
        params: {
          feedId: MOCK_FEED_ID,
          feedListingIds: '507f1f77bcf86cd799439011',
        },
      });

      const parsed = parseGetStatusResponse(statusResponse.data);
      assert.equal(parsed.success, true);
      assert.equal(parsed.listings.length, 1);
      assert.equal(parsed.listings[0].status, 'PENDING');
    });
  });

  test('simulated callback marks listing LIVE', async () => {
    let callbackHit = false;
    const callbackApp = express();
    callbackApp.get('/callback', (req, res) => {
      callbackHit = true;
      mockState.markCallbackFetched(
        String(req.query.feedListingIds || '').split(',')
      );
      res.set('Content-Type', 'application/xml');
      res.send('<?xml version="1.0"?><hotPadsItems></hotPadsItems>');
    });
    const callbackServer = http.createServer(callbackApp);
    await new Promise((resolve) => callbackServer.listen(0, resolve));
    const callbackPort = callbackServer.address().port;
    const callbackUrl = `http://127.0.0.1:${callbackPort}/callback`;

    const router = createZillowMockRouter({
      expectedApiKey: MOCK_API_KEY,
      expectedFeedId: MOCK_FEED_ID,
      callbackUrl,
      simulateCallback: true,
      callbackDelayMs: 50,
    });

    try {
      await withMockServer(router, async (base) => {
        await axios.get(`${base}${ZILLOW_EXTERNAL_API_PATHS.MARK_FOR_UPDATE}`, {
          params: {
            apikey: MOCK_API_KEY,
            feedId: MOCK_FEED_ID,
            feedListingIds: '507f1f77bcf86cd799439011',
          },
        });

        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(callbackHit, true);

        const statusResponse = await axios.get(`${base}${ZILLOW_EXTERNAL_API_PATHS.GET_STATUS}`, {
          params: {
            feedId: MOCK_FEED_ID,
            feedListingIds: '507f1f77bcf86cd799439011',
          },
        });
        const parsed = parseGetStatusResponse(statusResponse.data);
        assert.equal(parsed.listings[0].status, 'LIVE');
      });
    } finally {
      await new Promise((resolve) => callbackServer.close(() => resolve()));
    }
  });
});

describe('Zillow config mock mode', () => {
  test('mock URLs use exact Zillow path suffixes on local host', async () => {
    const keys = [
      'ZILLOW_MOCK_ENABLED',
      'ZILLOW_API_KEY_TEST',
      'ZILLOW_FEED_ID',
      'ZILLOW_COMPANY_ID',
      'API_PUBLIC_BASE_URL',
    ];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

    process.env.ZILLOW_MOCK_ENABLED = 'true';
    process.env.ZILLOW_API_KEY_TEST = '';
    process.env.ZILLOW_FEED_ID = '';
    process.env.ZILLOW_COMPANY_ID = '';
    process.env.API_PUBLIC_BASE_URL = 'http://localhost:5000';

    delete require.cache[require.resolve('../integrations/syndication/zillow/zillow.config')];
    const cfg = require('../integrations/syndication/zillow/zillow.config');

    keys.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
    delete require.cache[require.resolve('../integrations/syndication/zillow/zillow.config')];

    assert.equal(cfg.mockEnabled, true);
    assert.equal(cfg.apiKey, 'mock-zillow-api-key');
    assert.equal(cfg.feedId, 'mock-feed-id');
    assert.equal(cfg.companyId, 'mock-company-id');
    assert.equal(
      cfg.endpoints.markForUpdate,
      'http://127.0.0.1:5000/listing-tools/api/v1/externalListing/markForUpdate'
    );
    assert.equal(
      cfg.endpoints.getStatus,
      'http://127.0.0.1:5000/listing-tools/api/v1/syndication/getStatus'
    );
  });
});
