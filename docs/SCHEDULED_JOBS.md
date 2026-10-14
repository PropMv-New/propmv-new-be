# PROPMV Scheduled Jobs

List of all scheduled jobs in the PROPMV backend.

**Timezone for daily jobs:** `UTC` (`CRON_TIMEZONE=UTC`)

Daily jobs are **staggered** (different times) so they do not all run at once. Change times in `.env` - see `propmv/.env.example`.

---

## Daily jobs (staggered UTC schedule)

### 1. Ownership transfer activation

| | |
|---|---|
| **Name** | Ownership transfer activation |
| **Use** | Applies scheduled owner changes and removals when their effective date is reached. |
| **Time** | Daily at **00:00 UTC** (`OWNERSHIP_TRANSFER_SCHEDULE_TIME`) |

---

### 2. Future invoice generation (90-day extension)

| | |
|---|---|
| **Name** | Future invoice generation |
| **Use** | Creates the next batch of scheduled HOA invoices when a unit’s billing schedule is within 90 days of running out. |
| **Time** | Daily at **00:15 UTC** (`FUTURE_INVOICE_NOTIFICATION_TIME`) |

---

### 3. Invoice payment reminders (due / before due)

| | |
|---|---|
| **Name** | Invoice payment reminders |
| **Use** | Sends email reminders for unpaid HOA invoices that are due today or coming due. |
| **Time** | Daily at **00:30 UTC** (`INVOICE_NOTIFICATION_TIME`) |

---

### 4. Invoice overdue reminders

| | |
|---|---|
| **Name** | Invoice overdue reminders |
| **Use** | Sends email reminders for unpaid HOA invoices that are past due. |
| **Time** | Daily at **00:45 UTC** (`OVERDUE_NOTIFICATION_TIME`) |

---

### 5. Note reminder emails

| | |
|---|---|
| **Name** | Note reminder emails |
| **Use** | Sends reminder emails for board notes on invoices, properties, and owners. |
| **Time** | Daily at **01:00 UTC** (`NOTE_REMINDER_NOTIFICATION_TIME`) |

---

### 6. Maintenance created email (deferred send)

| | |
|---|---|
| **Name** | Maintenance created email |
| **Use** | Holds new maintenance ticket emails until the daily send window instead of sending immediately. |
| **Time** | Daily at **01:15 UTC** (`MAINTENANCE_NOTIFICATION_TIME`) |

---

### 7. Late-fee email (deferred send)

| | |
|---|---|
| **Name** | Late-fee email |
| **Use** | Holds late-fee notification emails until the daily send window (late fees may still be applied earlier). |
| **Time** | Daily at **01:30 UTC** (`LATE_FEE_NOTIFICATION_TIME`) |

---

### 8. Legacy daily late-fee sweep *(disabled by default)*

| | |
|---|---|
| **Name** | Legacy daily late-fee sweep |
| **Use** | Old method to apply late fees to all HOA units once per day. Replaced by the hourly property-local job below. |
| **Time** | Only when `HOA_LATE_FEE_LEGACY_DAILY_SCHEDULER_ENABLED=true` (uses `CRON_SCHEDULE` if set) |

---

## Recurring jobs (not on daily UTC schedule)

### 9. Property-local late-fee generation

| | |
|---|---|
| **Name** | Property-local late-fee generation |
| **Use** | Applies late fees at **midnight in each property’s billing timezone** (HOA units and landlord rentals). |
| **Time** | **Every hour** (checks which timezones are at local midnight) |

---

### 10. Zillow bulk feed

| | |
|---|---|
| **Name** | Zillow bulk feed |
| **Use** | Generates and updates the HotPads/Zillow XML listing feed for syndication. |
| **Time** | **04:30 and 16:30 US Eastern** daily |

---

### 11. Rainforest webhook retry

| | |
|---|---|
| **Name** | Rainforest webhook retry |
| **Use** | Retries failed Rainforest payment webhook deliveries. |
| **Time** | **Every 5 minutes** |

---

### 12. Audit outbox worker

| | |
|---|---|
| **Name** | Audit outbox worker |
| **Use** | Delivers pending audit log events from the outbox queue to the audit log. |
| **Time** | **Every 5 seconds** |

---

### 13. Email bounce IMAP poller

| | |
|---|---|
| **Name** | Email bounce IMAP poller |
| **Use** | Reads the support inbox for bounce/DSN messages and suppresses invalid email addresses. |
| **Time** | **Every 5 minutes** when `EMAIL_BOUNCE_IMAP_ENABLED=true` |

---

## Workers (process queued tasks)

### 14. Background job worker

| | |
|---|---|
| **Name** | Background job worker |
| **Use** | Processes queued work: emails, notifications, invoices, maintenance, and reports. |
| **Time** | **Continuous** - polls every **3 seconds** |

---

### 15. Notification reprocess worker (PROPMV)

| | |
|---|---|
| **Name** | Notification reprocess worker |
| **Use** | Retries stuck in-app notifications via the notification service. |
| **Time** | **Every 1 minute** (`npm run worker`) |

---

### 16. Notification service worker

| | |
|---|---|
| **Name** | Notification service worker |
| **Use** | Delivers in-app notifications (SSE/push) and retries pending deliveries when RabbitMQ is down. |
| **Time** | **Every 30 seconds** |

---

## Daily schedule at a glance

| Time (UTC) | Job |
|------------|-----|
| 00:00 | Ownership transfer |
| 00:15 | Future invoice generation |
| 00:30 | Invoice due reminders |
| 00:45 | Invoice overdue reminders |
| 01:00 | Note reminders |
| 01:15 | Maintenance emails (deferred slot) |
| 01:30 | Late-fee emails (deferred slot) |

**Env config:** `propmv/.env.example`
