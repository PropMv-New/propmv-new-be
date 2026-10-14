# Automated notification schedule

PropMv sends **scheduled** HOA emails at staggered fixed times in **UTC** (`CRON_TIMEZONE`), then workers process queued jobs asynchronously. Each daily job has its own time slot so they do not all run at once.

## Flow

```text
.env (CRON_SCHEDULE + CRON_TIMEZONE)
      ↓
dailySchedule.config.js + automatedNotificationSchedule.config.js
      ↓
Daily scheduler (setTimeout / msUntilNextDailyRun - not server local TZ)
      ↓
Scheduler leader lock (MongoDB - one instance per daily slot)
      ↓
Enqueue background_jobs (idempotencyKey)
      ↓
BullMQ worker and/or Mongo poller
      ↓
Send email (transactional + EmailDeliveryLog)
      ↓
Job status: PENDING → PROCESSING → COMPLETED | RETRYING | FAILED*
```

## Env configuration

| Variable | Purpose | Default (UTC) |
|----------|---------|---------------|
| `CRON_TIMEZONE` | IANA zone for all daily job times | `UTC` |
| `OWNERSHIP_TRANSFER_SCHEDULE_TIME` | Ownership transfer activation | `00:00` |
| `FUTURE_INVOICE_NOTIFICATION_TIME` | 90-day schedule extension | `00:15` |
| `INVOICE_NOTIFICATION_TIME` | Invoice due / before-due reminders | `00:30` |
| `OVERDUE_NOTIFICATION_TIME` | Invoice overdue reminders | `00:45` |
| `NOTE_REMINDER_NOTIFICATION_TIME` | Board note reminder sweep | `01:00` |
| `MAINTENANCE_NOTIFICATION_TIME` | New maintenance request emails (deferred) | `01:15` |
| `LATE_FEE_NOTIFICATION_TIME` | Late-fee applied emails (deferred) | `01:30` |
| `SCHEDULERS_ENABLED` | Master switch for all API schedulers | `true` |
| `SCHEDULER_SKIP_STARTUP_RUN` | Skip post-boot catch-up runs | `false` |
| `SCHEDULER_LEADER_LOCK_ENABLED` | MongoDB lock for multi-instance safety | `true` |

Example:

```env
CRON_TIMEZONE=UTC
OWNERSHIP_TRANSFER_SCHEDULE_TIME=00:00
FUTURE_INVOICE_NOTIFICATION_TIME=00:15
INVOICE_NOTIFICATION_TIME=00:30
OVERDUE_NOTIFICATION_TIME=00:45
NOTE_REMINDER_NOTIFICATION_TIME=01:00
MAINTENANCE_NOTIFICATION_TIME=01:15
LATE_FEE_NOTIFICATION_TIME=01:30
```

## What is scheduled vs event-driven

**Fixed daily schedule (this doc):**
- Invoice due / overdue reminders
- Future HOA invoice generation (90-day threshold) + `invoice-schedule-summary`
- Ownership transfer activation
- Maintenance **created** notifications (job `scheduledAt` = next slot)
- Late-fee **emails** (fee apply may run earlier; email waits for slot)
- Note reminders (invoice / property / owner notes)

**Property-local midnight (hourly checker - separate from CRON_SCHEDULE):**
- Late-fee invoice generation per property billing timezone

**Interval / integration schedulers (separate env):**
- Zillow bulk feed (ET hours)
- Rainforest webhook retry
- Audit outbox poller
- Email bounce IMAP poller

**Immediate / event-driven (not batched to daily schedule):**
- Invites, OTP, welcome, password reset
- Manual board “send payment reminder”
- Payment recorded / deleted / received
- Invoice created (ad-hoc), updated, balance waived
- Maintenance **updated / resolved** (action emails)
- Document uploaded

## Idempotency

- Job: unique `background_jobs.idempotencyKey` (e.g. one reminder job per invoice per day)
- Email: `EmailDeliveryLog.eventKey` + `skipped_duplicate`
- Invoice reminders also check `invoice.reminderHistory`
- Daily scheduler: MongoDB `scheduler_locks` leader lock per task + date

## Code entry points

| Concern | Path |
|---------|------|
| Central daily schedule | `src/config/dailySchedule.config.js` |
| Notification schedule slots | `src/config/automatedNotificationSchedule.config.js` |
| Scheduler registry | `src/common/schedulers/schedulerRegistry.service.js` |
| Daily run helper | `src/common/schedulers/scheduledDailyRun.service.js` |
| Due/overdue cron | `hoaInvoiceReminderScheduler.service.js` |
| 90-day extension | `hoaInvoiceExtensionScheduler.service.js` |
| Ownership transfer | `hoaOwnershipTransferScheduler.service.js` |
| Maintenance defer | `maintenance.service.js` → `getNextMaintenanceNotificationRunAt` |
| Late-fee email defer | `invoiceNotificationEmailHelper.js` → `getNextLateFeeNotificationRunAt` |
| Note reminders | `noteReminderScheduler.service.js` |
| Workers | `src/common/jobs/` + `npm run workers` |
