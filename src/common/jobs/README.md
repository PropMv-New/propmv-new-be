# Background Jobs, Workers, and Cron

PropMv processes emails, in-app notifications, late fees, invoice extensions, and payment reminders **outside the API request cycle**.

```
API / Cron
    |
    | persist BackgroundJob (idempotent)
    v
MongoDB background_jobs
    |
    +---- Redis / BullMQ  (when REDIS_URL is set)
    |
    +---- Mongo poller    (always; fallback if Redis is down)
    |
    v
Workers (email, notification, invoice, maintenance, report)
    |
    v
Existing email / notify / invoice / maintenance services
    |
    v
background_jobs + notification_logs
```

Cron **finds work and creates jobs**. Workers run the existing business logic. Invoice payment allocation, credit balance, ledger, and calculation code is unchanged.

## Existing pieces that were reused

| Area | Reused |
| --- | --- |
| Email | `emailHelper`, `transactionalEmail.service`, `invoiceLifecycleEmail.service` |
| In-app notifications | `notify()`, notification-service HTTP client, RabbitMQ inside notification-service |
| Invoice rules | `unitLateFee.service`, `lateFeeInvoice.service`, `invoiceScheduleMeta.service`, `paymentReminderAutomation.service` |
| Redis | Existing `REDIS_URL` (rate limit + now BullMQ) |
| Outbox pattern | Same claim/lock/retry design as Audit Outbox |

BullMQ is used when Redis is available. Jobs are **always** written to MongoDB first so a Redis outage cannot drop work.

## Start locally

API (embedded workers are on in non-production):

```bash
cd propmv
npm run dev
```

Standalone workers (required in production, optional locally):

```bash
cd propmv
npm run workers
```

The existing notification-service reprocess worker is unchanged:

```bash
npm run worker
```

Cron/schedulers start with the API process via `src/common/schedulers/schedulerRegistry.service.js` (late fees, invoice extension, payment reminders, ownership transfer, Zillow feed, bounce IMAP, audit outbox). Daily HOA tasks share `CRON_SCHEDULE` + `CRON_TIMEZONE` from `.env` (default `0 0 * * *` at `UTC`). They enqueue jobs instead of generating invoices or sending bulk email themselves.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `REDIS_URL` | unset | Redis for BullMQ. If unset, the Mongo poller processes jobs. |
| `BACKGROUND_JOBS_ENABLED` | `true` | Set `false` to fall back to in-process `setImmediate` (legacy). |
| `BACKGROUND_WORKERS_EMBEDDED` | `true` in non-prod, `false` in production | Run workers inside the API process. |
| `BACKGROUND_JOB_QUEUE_PREFIX` | `propmv:jobs` | BullMQ key prefix. |
| `BACKGROUND_JOB_MAX_ATTEMPTS` | `3` | Attempts before `FAILED_PERMANENTLY`. |
| `BACKGROUND_JOB_RETRY_DELAYS_MS` | `60000,300000,1800000` | Backoff after attempt 1 / 2 / 3 (1m, 5m, 30m). |
| `BACKGROUND_JOB_LOCK_MS` | `120000` | Claim lock so crashed workers can be retried. |
| `BACKGROUND_JOB_POLL_INTERVAL_MS` | `3000` | Mongo poller interval. |
| `BACKGROUND_JOB_POLL_BATCH_SIZE` | `20` | Jobs claimed per poller tick. |
| `BACKGROUND_JOB_EMAIL_CONCURRENCY` | `10` | Email worker concurrency. |
| `BACKGROUND_JOB_NOTIFICATION_CONCURRENCY` | `10` | Notification worker concurrency. |
| `BACKGROUND_JOB_INVOICE_CONCURRENCY` | `3` | Invoice / late-fee / reminder worker concurrency. |
| `BACKGROUND_JOB_MAINTENANCE_CONCURRENCY` | `5` | Maintenance worker concurrency. |
| `BACKGROUND_JOB_REPORT_CONCURRENCY` | `2` | Report worker concurrency. |

## Redis

If Redis is not running, jobs still persist in MongoDB and the poller processes them. Connection failures are logged **once**, then retries wait 60s (`BACKGROUND_JOB_REDIS_RETRY_AFTER_MS`).

Start Redis locally (Docker recommended):

Windows:

```bat
scripts\setup-local-infra.bat
```

Linux / macOS:

```bash
chmod +x scripts/setup-local-infra.sh
./scripts/setup-local-infra.sh
```

Optional RabbitMQ for the notification service:

```bat
scripts\setup-local-infra.bat --with-rabbitmq
```

```bash
./scripts/setup-local-infra.sh --with-rabbitmq
```

Then set:

```
REDIS_URL=redis://127.0.0.1:6379
```

Use `127.0.0.1`, not `localhost`, on Windows so the client does not try IPv6 `::1`. Restart the API after Redis is up.

Production deploy already sets Redis (see `deploy-production.sh`). BullMQ 5 is installed with `--legacy-peer-deps` because the API still uses `redis@4` for rate limiting; BullMQ talks to Redis through `ioredis`.

## Inspect failed jobs

Administrator JWT required.

```
GET /api/v1/system/jobs/metrics
GET /api/v1/system/jobs?status=FAILED_PERMANENTLY
GET /api/v1/system/jobs/:jobId
POST /api/v1/system/jobs/:jobId/retry
```

Metrics include job counts, email queued/sent/failed/retried, worker status, queue depth, and processing stats.

MongoDB collections:

- `background_jobs` - status, attempts, `errorMessage`, `errorHistory`, `nextRetryAt`, `workerId`
- `notification_logs` - channel, recipient, entity, send result

## Retry a failed job

```
POST /api/v1/system/jobs/{jobId}/retry
```

Only `FAILED` / `FAILED_PERMANENTLY` jobs can be retried. The job is reset to `PENDING` and dispatched again. Duplicate business events still cannot create a second row with the same `idempotencyKey`.

Validation / not-found errors are **not** retried indefinitely (`permanent: true`).

## Queue health

1. `GET /api/v1/system/jobs/metrics` - `jobs.pending`, `jobs.processing`, `jobs.retrying`, `workers.queueDepth`, `workers.redis`
2. Redis: `INFO` / queue keys under `propmv:jobs:*`
3. API logs: `[BackgroundJobs] Job completed` / `Permanent failure` / `Scheduled retry`

## Idempotency

Examples:

- `EMAIL_INVOICE_CREATED:{invoiceId}`
- `EMAIL_INVOICE_UPDATED:{invoiceId}:{changeFingerprint}`
- `EMAIL_PAYMENT_RECORDED:{invoiceId}:{paymentId}:{paidAt}`
- `INVOICE_LATE_FEE_UNIT:{unitId}:{dateKey}`
- `INVOICE_PAYMENT_REMINDER:{invoiceId}:{dateKey}`

A unique sparse index on `idempotencyKey` prevents duplicate jobs if the API or cron retries.

## Production layout

```
API  (BACKGROUND_WORKERS_EMBEDDED=false)  →  enqueue only + cron
Worker 1 / Worker 2 / Worker 3            →  npm run workers
Redis                                     →  BullMQ dispatch
MongoDB                                   →  source of truth + poller fallback
```

Atomic `findOneAndUpdate` claim prevents two workers from processing the same job.

## Tests

```bash
cd propmv
npm run test:background-jobs
```
