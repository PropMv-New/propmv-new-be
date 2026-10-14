# Zillow Rentals Feed Integration

This document describes how PropMv syndicates rental listings to **Zillow Rentals (ZGR)** using the HotPads XML bulk feed (v2.1) and the Real-Time Listing API.

## Architecture

```
listing.service.js  →  syndication.service.js  →  SyndicationProviderFactory  →  ZillowSyndicationProvider
                                                                                      ├── zillowXmlBuilder
                                                                                      ├── zillowRealtimeApiClient
                                                                                      └── zillowFeedFileService
```

The **Factory Pattern** keeps listing CRUD provider-agnostic. To add Apartments.com:

1. Add `APARTMENTS_COM` handler in `SyndicationProviderFactory.js`
2. Create `integrations/syndication/apartments/` with provider class
3. Extend `Listing.syndication.apartmentsCom` sub-document
4. No changes needed in `listing.service.js` beyond optional provider list

## Mock Zillow API (local testing without credentials)

When you do not have Zillow Feed Connect credentials, enable the built-in mock that replicates Zillow's external APIs:

```bash
ZILLOW_MOCK_ENABLED=true
```

With mock mode on, PropMv:

- Serves mock handlers at the **exact same path suffixes** as real Zillow (only the host changes to your local server)
- Auto-fills `ZILLOW_API_KEY_TEST`, `ZILLOW_FEED_ID`, and `ZILLOW_COMPANY_ID` with mock defaults when real values are empty
- Routes `zillowRealtimeApiClient` and live status checks to the local mock URLs
- Optionally simulates Zillow calling your **callback** URL after `markForUpdate` (`ZILLOW_MOCK_SIMULATE_CALLBACK=true`)

### Mocked outbound Zillow APIs (complete list)

PropMv integrates **two** outbound Zillow APIs - both have mock handlers:

| API | Method | Exact path (same as Zillow) |
|-----|--------|----------------------------|
| Real-Time `markForUpdate` | GET | `/listing-tools/api/v1/externalListing/markForUpdate` |
| Syndication `getStatus` | GET | `/listing-tools/api/v1/syndication/getStatus` |

Mock URLs when `ZILLOW_MOCK_ENABLED=true` (example):

```
http://localhost:5000/listing-tools/api/v1/externalListing/markForUpdate
http://localhost:5000/listing-tools/api/v1/syndication/getStatus
```

Real Zillow test URLs use the same path suffix on different hosts (`feeds.testpads.net`, `listing-tools-api.hotpads.com`).

Inbound endpoints (Zillow → PropMv) are **not mocked** - they are PropMv routes you already implement:

- Callback: `/api/v1/zillow/callback`
- Bulk feed: `/feeds/zillow/hotpads.xml`

| Variable | Default | Purpose |
|----------|---------|---------|
| `ZILLOW_MOCK_ENABLED` | `false` | Toggle mock vs real Zillow APIs |
| `ZILLOW_MOCK_API_KEY` | `mock-zillow-api-key` | API key accepted by mock |
| `ZILLOW_MOCK_FEED_ID` | `mock-feed-id` | Feed ID for mock validation |
| `ZILLOW_MOCK_COMPANY_ID` | `mock-company-id` | Used when `ZILLOW_COMPANY_ID` is empty |
| `ZILLOW_MOCK_SIMULATE_CALLBACK` | `true` | Mock "Zillow" fetches listing XML from your callback |
| `ZILLOW_MOCK_CALLBACK_DELAY_MS` | `500` | Delay before simulated callback |

Debug endpoints (PropMv-only, not Zillow APIs):

- `GET /api/v1/zillow/mock/state` - mock state snapshot
- `POST /api/v1/zillow/mock/reset` - clear in-memory mock listing state

Set `ZILLOW_MOCK_ENABLED=false` before production or when real Zillow credentials are available.

## Setup

### 1. Environment variables

Copy the full block from `.env.zillow.example` into your `.env` (also synced to `.env.local` and `.env.production`).

**Required secrets (from Zillow onboarding):**

```bash
ZILLOW_API_KEY_TEST=...
ZILLOW_FEED_ID=...
ZILLOW_COMPANY_ID=...
```

**External Zillow API URLs (in .env):**

```bash
ZILLOW_MARK_FOR_UPDATE_URL_TEST=https://feeds.testpads.net/listing-tools/api/v1/externalListing/markForUpdate
ZILLOW_MARK_FOR_UPDATE_URL_PROD=https://api.zillowrentals.com/listing-tools/api/v1/externalListing/markForUpdate
ZILLOW_GET_STATUS_URL=https://listing-tools-api.hotpads.com/listing-tools/api/v1/syndication/getStatus
```

**PropMv public URLs (register these with Zillow):**

```bash
API_PUBLIC_BASE_URL=http://localhost:5000
ZILLOW_CALLBACK_URL=http://localhost:5000/api/v1/zillow/callback
ZILLOW_BULK_FEED_PUBLIC_URL=http://localhost:5000/feeds/zillow/hotpads.xml
```

**Frontend** (`innago-inspired-refresh/.env.local`): matching `VITE_ZILLOW_*` variables - see `.env.local` for the full list.

### 2. Register URLs with Zillow

| Purpose | URL |
|---------|-----|
| Bulk feed (static) | `https://your-domain.com/feeds/zillow/hotpads.xml` |
| Real-time callback | `https://your-domain.com/api/v1/zillow/callback` |

### 3. Start the API

```bash
npm run dev
```

The bulk feed cron starts automatically (configurable via `ZILLOW_BULK_FEED_CRON_ENABLED`).

### 4. Run tests

```bash
npm run test:zillow-syndication
```

## Listing flow hooks

| Flow | Behavior |
|------|----------|
| Create (Published/Active) | Fire-and-forget `publishListingAsync` |
| Edit (Active/Published) | Fire-and-forget `syncListingAsync` |
| Publish | `publishListingAsync` → real-time API + bulk feed flag |
| Unpublish/Inactive | `unpublishListingAsync` → removal XML |
| Delete | `unpublishListingAsync` before soft-delete |

Syndication failures are **non-blocking** - core CRUD always succeeds.

## API endpoints

### Landlord (authenticated)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/landlord/listing/listings/:id/syndication` | Cached syndication status |
| GET | `/api/v1/landlord/listing/listings/:id/syndication/live` | Live Zillow status API |
| POST | `/api/v1/landlord/listing/listings/:id/syndication/zillow/sync` | Manual retry sync |
| POST | `/api/v1/landlord/listing/listings/:id/syndication/zillow/remove` | Remove from Zillow |
| POST | `/api/v1/zillow/bulk-feed/regenerate` | Manual bulk feed regen |
| POST | `/api/v1/zillow/bulk-feed/confirm` | Confirm after 20% threshold breach |

### Public (Zillow servers)

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/v1/zillow/callback?feedListingIds=...` | Real-time listing XML |

## Zillow onboarding checklist

- [ ] Complete Zillow Feed Connect signup
- [ ] Receive `feedId` and `companyId` from Zillow
- [ ] Configure test API key (`ZILLOW_API_KEY_TEST`)
- [ ] Host bulk feed at static URL (no date in filename)
- [ ] Register callback URL for real-time API
- [ ] Submit test feed URL to Zillow for kick-off review
- [ ] Verify listings appear on test environment
- [ ] **Monday test reset**: Zillow test environment resets weekly - re-verify after reset
- [ ] Understand **20% threshold**: large listing count drops require manual `bulk-feed/confirm`
- [ ] Switch `ZILLOW_ENV=production` and production API key when approved

## Important Zillow quirks (implemented)

| Quirk | Handling |
|-------|----------|
| `succes` typo in API response | Parsed exactly as `succes` |
| Underscores stripped from IDs | Validation warns; IDs normalized |
| Fee ordering (multiplier/percentage) | Fees sorted before XML emission |
| UTC `lastUpdated` | ISO 8601 UTC timestamps |
| 20% listing count delta | Blocks feed overwrite; requires confirm |
| UTF-8 only | Never UTF-16; XML declaration included |

## Postman

Import `postman/Zillow_Syndication.postman_collection.json` for manual API testing.

## Frontend

The landlord portal shows Zillow sync status on the listing detail page. Select **Zillow** on the publish step to enable syndication (`syndicationPlatforms` includes `zillow`).
