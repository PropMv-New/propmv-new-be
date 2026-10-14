# PropMv API

Node.js / Express REST API for the PropMv property management platform. Handles authentication, multi-portal business logic, payments, billing, messaging, document storage, background jobs, and third-party integrations.

## Tech Stack

- **Node.js 20+** (engines: `>=20.0.0 <23.0.0`)
- **Express 4** - HTTP API
- **MongoDB** + **Mongoose** - primary data store
- **Redis** + **BullMQ** - background job queues
- **Socket.IO** - real-time messaging
- **JWT** - authentication (access + refresh tokens)
- **Joi** - request validation
- **Swagger** - API documentation
- **AWS S3 / Azure Blob** - document and file storage
- **Stripe / Straddle** - payment processing
- **Nodemailer** - transactional email

## Prerequisites

- **Node.js** 20.x or 22.x
- **MongoDB** (local or Atlas)
- **Redis** (required for background jobs)
- Optional: RabbitMQ, SMTP credentials, cloud storage keys

## Getting Started

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.aws-example .env.local   # or use your existing .env.local

# Start API server (default port 5000)
npm run dev

# In a separate terminal - start background workers (if not embedded)
npm run workers
```

The API listens on `PORT` (default `5000`). Swagger docs are available at `/api-docs` when the server is running.

## Required Environment Variables

These must be set before the app starts (validated at boot via `src/config/validateEnv.js`):

| Variable | Description |
|----------|-------------|
| `DB_URL` | MongoDB connection string |
| `JWT_SECRET` | Access token signing secret (min 16 chars, no defaults in production) |
| `REFRESH_TOKEN_SECRET` | Refresh token signing secret |

Generate strong secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## Common Environment Variables

See `.env.aws-example` for a full reference. Highlights:

| Variable | Description |
|----------|-------------|
| `PORT` | HTTP port (default `5000`) |
| `NODE_ENV` / `APP_PROFILE` | Environment profile (`local`, `dev`, `prod`) |
| `CORS_ORIGINS` | Comma-separated allowed frontend origins |
| `STORAGE_PROVIDER` | `s3`, `azure`, or `mock` (dev only) |
| `REDIS_URL` | Redis connection for BullMQ jobs |
| `BACKGROUND_JOBS_ENABLED` | Enable async job processing |
| `BACKGROUND_WORKERS_EMBEDDED` | Run workers inside the API process |
| `NOTIFICATION_SERVICE_URL` | External notification microservice |
| `SMTP_*` | Primary/secondary SMTP for email delivery |
| `STRIPE_*` / `STRADDLE_*` | Payment provider credentials |
| `ZILLOW_*` | Zillow listing syndication |
| `MAPBOX_ACCESS_TOKEN` | Address autocomplete fallback |

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Start production server |
| `npm run dev` | Start with nodemon (hot reload) |
| `npm run worker` | Start notification worker only |
| `npm run workers` | Start all background workers |
| `npm run test:unit` | Core unit tests |
| `npm run test:security` | Security-focused test suite |
| `npm run test:landlord` | Landlord module tests |
| `npm run lint:check` | Validate privilege/middleware wiring |
| `npm run ensure:hoa-indexes` | Ensure HOA MongoDB indexes |
| `npm run setup:landlord-modules` | Seed landlord modules and functions |

Additional targeted test scripts are available for invoices, leases, Zillow syndication, email delivery, and more - see `package.json`.

## Project Structure

```
src/
├── server.js             # HTTP server + scheduler bootstrap
├── app.js                # Express app, middleware, route mounting
├── config/               # DB, env, CORS, Swagger, storage config
├── common/               # Shared helpers, jobs, schedulers, logger
├── middleware/           # Auth, rate limiting, authorization, audit
├── database/             # Migrations and DB utilities
├── portals/              # Portal-specific modules
│   ├── landlord/         # Landlord API routes & services
│   └── hoa-board/        # HOA board API routes & services
├── shared/               # Cross-portal modules (payments, messaging, audit)
├── integrations/         # Third-party integrations
├── privileges/           # RBAC privilege definitions
├── workers/              # BullMQ background workers
├── jobs/                 # Cron jobs (e.g. Zillow bulk feed)
├── tests/                # API and unit tests
└── docs/                 # Swagger schemas and YAML
```

## API Documentation

Interactive Swagger UI is served at:

```
http://localhost:5000/api-docs
```

OpenAPI schemas live in `src/docs/` and are assembled by `src/config/swagger.config.js`.

## Background Jobs

Async work (email, notifications, invoices, reports, maintenance) runs through BullMQ on Redis.

```bash
# Standalone workers
npm run workers

# Or embed workers in the API process
BACKGROUND_WORKERS_EMBEDDED=true npm run dev
```

## Portal Architecture

Business logic is organized by portal under `src/portals/`:

| Portal | Path | Description |
|--------|------|-------------|
| Landlord | `src/portals/landlord/` | Properties, leases, invoices, applications |
| HOA Board | `src/portals/hoa-board/` | Owners, units, HOA billing, assessments |

Shared capabilities (payments, messaging, file storage, audit logging) live in `src/shared/` and are consumed by portal modules.

## Authentication & Authorization

- JWT access tokens + refresh token rotation
- Role-based access control via `src/privileges/` and `authorize` middleware
- MFA support with configurable session windows
- Rate limiting on sensitive endpoints

## Integrations

| Integration | Config prefix | Notes |
|-------------|---------------|-------|
| Stripe | `STRIPE_*` | Card payments |
| Straddle | `STRADDLE_*` | ACH / bank payments |
| Zillow | `ZILLOW_*` | Listing syndication - see `README_ZILLOW_INTEGRATION.md` |
| Google Maps / Places | `GOOGLE_*` | Address services |
| Mapbox | `MAPBOX_*` | Address autocomplete fallback |
| AWS S3 / Azure Blob | `STORAGE_PROVIDER` | Document uploads |

## Testing

```bash
# Quick sanity checks
npm run check:auth
npm run check:profile

# Full security suite
npm run test:security

# Domain-specific
npm run test:landlord-invoice
npm run test:zillow-syndication
npm run test:email-delivery
```

## Development Notes

- Environment is loaded via `src/config/loadEnv.js` (supports `.env.local`, `.env.production`, etc.).
- Production startup fails fast on missing or weak secrets.
- CORS origins are resolved in `src/config/corsOrigins.js`; include `http://localhost:8080` for local UI dev.
- WebSocket connections are managed by `src/shared/messaging/service/websocket.manager.js`.
- Schedulers (late fees, invoice reminders, Zillow feed) start automatically with the server.

## Related Documentation

- **Frontend:** [`../PropMv-UI/README.md`](../PropMv-UI/README.md)
- **Zillow integration:** `README_ZILLOW_INTEGRATION.md`
- **Landlord logging:** `README_LANDLORD_LOGGING.md`
- **Payment testing:** `src/scripts/README_PAYMENT_TESTING.md`
- **Background jobs:** `src/common/jobs/README.md`
