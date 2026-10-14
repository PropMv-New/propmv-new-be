# HOA Owner Autopay — Implementation Overview & QA Guide

**Product:** PropMV (API) + Innago-inspired owner portal (UI)  
**Payment gateway:** Payload  
**Audience:** QA / UAT, product, and software engineers  
**Status:** Implemented behind feature flags (Point 2 / §17 shipped; Phase-0 sandbox required before production)

| Related document | Purpose |
|------------------|---------|
| [`roadmap-autopay.md`](./roadmap-autopay.md) | Full design, behavioral rules (§17), ship status, **code map (§18)** |
| [`existing-architecture.md`](./existing-architecture.md) | How Autopay fits manual Payload pay, webhooks, and ledger |
| **This file** | How the flow works today + how to test it |

---

## Part A — How Autopay is implemented (current)

### A.1 One-sentence summary

PropMV remains the **only** source of invoice creation, frequency, amount, balance, and due date. When an owner enrolls in Autopay, PropMV **mirrors** each open invoice to Payload; Payload charges the owner’s **default payment method** on that mirror’s due date; PropMV applies the result through the **same webhook → pay-in → ledger** path used for manual Payload payments.

**Payload Billing Schedules are not used.**

### A.2 End-to-end flow

```text
1. Owner enables Auto Pay (UI confirmation + card/ACH)
       ↓
2. PropMV stores OwnerPayloadAutopay (enabled=true)
   Payload PM → default_payment_method=true
       ↓
3. Open PropMV invoices → mirrored Payload invoices
   (external_uid = PropMV invoice _id, fee-inclusive line item, due_date)
       ↓
4. Board/owner changes balance, due date, credits, waive, manual pay…
   → Event-driven mirror sync (daily cron = repair only)
       ↓
5. On due_date, Payload runs automatic charge (trigger=automatic)
       ↓
6. Webhook: automatic_payment (+ authorized / processed / decline…)
       ↓
7. PropMV creates PayloadPayin if missing → applyPayloadPayinLifecycle
   Card: settle on authorized/processing (same as manual)
   ACH: settle only on processed / SUCCEEDED (same as manual)
       ↓
8. Invoice paymentTransactions + ledger updated; mirror closed on success
```

### A.3 Feature flags (must be on for QA)

| Layer | Variable | Value |
|-------|----------|--------|
| Backend (`propmv/.env`) | `PAYLOAD_ENABLED` | `true` |
| Backend | `PAYLOAD_OWNER_AUTOPAY_ENABLED` | `true` |
| Frontend (`.env.local`) | `VITE_PAYLOAD_ENABLED` | `true` |
| Frontend | `VITE_PAYLOAD_OWNER_AUTOPAY_ENABLED` | `true` |

Restart API and Vite after changing flags. Primary owner payment provider must be **Payload**.

### A.4 Main building blocks

| Piece | What it does | Where |
|-------|----------------|-------|
| Enrollment | Enable / disable / change method; `confirmAutopay: true` required on enable | `payloadAutopay.service.js`, routes under `/payments/payload/autopay*` |
| Status API | Returns `nextAutopay` (from PropMV invoices) + `lastAutopayAttempt` | `GET /payments/payload/autopay?hoaId=` |
| Mirror sync | Upsert/update/close Payload invoices; line-item **id** preservation; amount safety | `payloadInvoiceSync.service.js`, `payloadMirrorSafety.util.js` |
| Event sync | After invoice create/update/delete/waive and gateway settle/fail | `schedulePayloadAutopayMirrorSync.js` |
| Daily cron | Re-sync enrolled owners — **safety net only** | `payloadAutopayInvoiceSyncScheduler.service.js` |
| Webhook | Ingest automatic payments without prior `payins/execute` | `payloadWebhook.service.js` → `ensurePayinFromAutomaticPaymentWebhook` |
| Settlement | Shared Card vs ACH rules with manual pay | `payloadPayinSettlement.util.js` |
| Owner UI | Toggle, confirmation checkbox, next charge, last attempt | `AutoPayCard.tsx`, Settings → Auto Pay |

### A.5 Important behavioral rules

1. **PropMV owns the schedule** — next Autopay date/amount = earliest open PropMV invoice for that owner+HOA (`balanceDue` + processing fee). Not a Payload schedule.
2. **One charge per PropMV invoice** on its own due date (v1 — not one sweep across all open invoices).
3. **Stale mirror safety** — mirror must not charge more than current `balanceDue` + calculated fee; `assertMirrorSafeForAutopay` + pre-settle guard.
4. **Card ≠ ACH for “Paid”** — ACH stays **Processing** until `processed`; do not treat Autopay initiate as Paid.
5. **Retries** — Payload may retry ~5 days after due date; each retry is a **new** transaction id; PropMV must not double-settle.
6. **Manual pay still works** — Autopay does not replace owner Pay dialog or board payment recording.

### A.6 UI entry points

| Screen | Location |
|--------|----------|
| Dashboard Auto Pay card | HOA owner dashboard (community/HOA selected) |
| Settings Auto Pay | Owner Settings → Auto Pay (`OwnerAutoPaySettingsPanel`) |
| Payment methods | Settings → Cards / banks (must add card or ACH before enable) |

---

## Part B — How QA should test Autopay

### B.1 Prerequisites checklist

- [ ] Flags from §A.3 set; both servers restarted  
- [ ] Payload sandbox/staging API key configured  
- [ ] Webhook registered on Payload dashboard to PropMV `POST /api/webhooks/payload` including **`automatic_payment`**, plus `payment`, `processed`, `authorized`, `decline`, `reject`, `void`, `refund`  
- [ ] HOA has **active** Payload processing account  
- [ ] Owner user is on invoice `tenants` for the unit  
- [ ] At least one saved **card or ACH**  
- [ ] At least one **open invoice** (`balanceDue > 0`) with a controllable **due date** (today/tomorrow for charge tests)

### B.2 API smoke (optional)

Base path: `/api/v1/payments/payload` (owner session; CSRF on mutating calls).

| Method | Path | Expect |
|--------|------|--------|
| GET | `/autopay?hoaId={24-hex}` | `enabled`, `paymentMethod`, `nextAutopay`, `lastAutopayAttempt` |
| POST | `/autopay/enable` | Body must include `confirmAutopay: true` or **400** |
| POST | `/autopay/disable` | `{ hoaId }` |
| PUT | `/autopay/payment-method` | `{ hoaId, paymentMethodLocalId }` |

### B.3 Functional test cases

#### Enrollment

| ID | Steps | Expected |
|----|--------|----------|
| AP-01 | Flags off | Auto Pay UI hidden or amber setup message |
| AP-02 | Enable with no saved PM | Prompt / navigate to add card or bank |
| AP-03 | Select method + check confirmation + Enable | Success; toggle Active; method shows card/bank + last4 |
| AP-04 | Enable without confirmation checkbox | Enable button disabled / cannot submit |
| AP-05 | Disable Autopay | Toggle off; future mirrors not charged |

#### Next Autopay display

| ID | Steps | Expected |
|----|--------|----------|
| AP-10 | Enrolled + open invoice | **Next Auto Pay**: due date, invoice #, balance + fee + total |
| AP-11 | No open balance | No upcoming charge (null next) |
| AP-12 | Two open invoices | Next = **earliest due date** only (not combined total for both) |

#### Mirror sync

| ID | Steps | Expected |
|----|--------|----------|
| AP-20 | Enable with open invoice | Invoice has `payloadAutopayMirror.payloadInvoiceId`; Payload `external_uid` = PropMV `_id` |
| AP-21 | Partial pay or board reduces amount | Mirror amount updated; Payload `amount_due` ≤ PropMV balance + fee |
| AP-22 | Full manual pay before due date | Mirror closed; no Autopay charge on due date |
| AP-23 | Change invoice due date | Payload mirror `due_date` matches |

#### Automatic charge — Card

| ID | Steps | Expected |
|----|--------|----------|
| AP-30 | Due date; card approved in sandbox | Webhooks fire; settle on authorized/processing → **Paid** when balance cleared |
| AP-31 | Check ledger / invoice | One payment; `balanceDue` correct |
| AP-32 | Owner UI | Last attempt = Succeeded |

#### Automatic charge — ACH

| ID | Steps | Expected |
|----|--------|----------|
| AP-40 | ACH Autopay starts | Invoice **Processing** — **not Paid** yet |
| AP-41 | ACH `processed` | Paid + ledger |
| AP-42 | ACH return after success | Fail path; not left incorrectly Paid |

#### Decline / retry / safety

| ID | Steps | Expected |
|----|--------|----------|
| AP-50 | Decline on due date | Invoice unpaid; last attempt Failed; Autopay **stays enabled** during retry window |
| AP-51 | Later retry succeeds (new txn id) | One successful settle; no duplicate for same txn |
| AP-60 | Replay same webhook | No double payment |
| AP-61 | Txn amount > current `balanceDue` | Settlement blocked; no over-pay |

#### Regression — must not break

| ID | Steps | Expected |
|----|--------|----------|
| AP-70 | Owner **Pay** dialog on invoices | Works; invoice section does **not** blank |
| AP-71 | Board records check/cash/credit | Invoice updates; Autopay mirror stays consistent |

### B.4 Phase-0 sandbox sign-off (required before production)

Run in Payload **sandbox** with live webhooks:

1. [ ] Mirror line-item update after partial payment  
2. [ ] Fee-inclusive mirror matches manual validate/execute for same invoice + method  
3. [ ] Card lifecycle (not Paid until authorized/processing)  
4. [ ] ACH lifecycle (Processing until processed; return handling)  
5. [ ] Decline + retry (new transaction id)  
6. [ ] Duplicate `automatic_payment` webhook  
7. [ ] Manual full pay before due date → no over-charge  
8. [ ] Unsafe high `amount_due` → mirror Autopay disabled by safety guard  

| Environment | Date | Tester | Phase-0 | UI §B.3 | Regression AP-70/71 | Approved |
|-------------|------|--------|---------|---------|---------------------|----------|
| Sandbox | | | ☐ | ☐ | ☐ | ☐ |
| Staging | | | ☐ | ☐ | ☐ | ☐ |

### B.5 Debugging data

| Where | What to look at |
|-------|-----------------|
| MongoDB `OwnerPayloadAutopay` | `enabled`, customer + PM ids |
| MongoDB `Invoice.payloadAutopayMirror` | `payloadInvoiceId`, `syncStatus`, `lastSyncError` |
| MongoDB `PayloadPayin` | `metadata.trigger: 'automatic'`, `paymentAttemptId` |
| MongoDB `PayloadWebhookEvent` | Duplicate delivery / processing errors |
| Payload `GET /invoices/{id}` | `amount_due`, `due_date`, `autopay_allowed` |
| Payload transactions | `trigger=automatic` |

---

## Part C — Can engineers understand Autopay from `roadmap-autopay.md`?

### Confirmation: **Yes**

[`roadmap-autopay.md`](./roadmap-autopay.md) is the **primary engineering document** for Autopay. A software engineer can understand the implementation in code by reading it as follows:

| Order | Section | What you learn |
|-------|---------|----------------|
| 1 | §1–§3 | Product model: PropMV invoices + Payload automatic charge; no Billing Schedules |
| 2 | §6 | Frequency / due dates stay in PropMV |
| 3 | **§17** | Authoritative rules: mirror amount safety, retries/idempotency, Card vs ACH, next Autopay, sync triggers |
| 4 | §15 | What is shipped vs still ops/sandbox |
| 5 | **§18 Code map** | Exact files to open for enrollment, sync, webhooks, settlement, UI |
| 6 | Companion [`existing-architecture.md`](./existing-architecture.md) | Manual pay + Autopay side-by-side in the payments platform |

**Verdict:** An engineer who follows **roadmap §1–§3 → §17 → §18**, then opens the listed modules and traces **enable → mirror sync → `automatic_payment` webhook → settle**, can understand Autopay in the codebase **without additional design docs**.

This QA guide does **not** replace the roadmap; it is the **test / UAT companion**. The roadmap is the **design + code navigation** source of truth.

### Suggested engineer walkthrough (30–45 min)

1. Read roadmap §3 diagram and §17.3–§17.5.  
2. Open `payloadAutopay.service.js` (enable + `nextAutopay`).  
3. Open `payloadInvoiceSync.service.js` + `payloadMirrorSafety.util.js`.  
4. Open `payloadPayin.service.js` (`ensurePayinFromAutomaticPaymentWebhook` + settle guard).  
5. Open `AutoPayCard.tsx` + `useOwnerPayloadAutopay.ts`.  
6. Run unit tests under `propmv/.../payload/` for mirror safety, settlement, validators.

---

## Known v1 limitations

- One Autopay charge **per PropMV invoice** on its due date (not multi-invoice FIFO sweep).  
- Apple Pay / Google Pay not in Autopay enrollment (card + ACH only).  
- Production release blocked until Phase-0 (§B.4) passes and webhooks are registered per environment.

---

*Aligned with Point 2 (§17) implementation documented in `roadmap-autopay.md`.*
