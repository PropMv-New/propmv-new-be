# Roadmap — HOA Owner Autopay (Payload)

Reference plan for Cursor / Claude agents. **Implemented** behind `PAYLOAD_OWNER_AUTOPAY_ENABLED` / `VITE_PAYLOAD_OWNER_AUTOPAY_ENABLED`. PropMV invoices remain the source of truth; Payload mirror invoices + customer default payment method drive automatic charges.

Companion: **`existing-architecture.md`** (current manual pay + models).

---

## 1. Executive summary

| Layer | Recurring **invoice creation** | **Automatic charge on due date** |
|--------|-------------------------------|----------------------------------|
| Payload docs | **Billing Schedule** API generates Payload invoices | **Default payment method** on Customer + Payload **Invoice** with `due_date` |
| PropMV today | **PropMV only** (HOA settings, schedule cron, late fees) | **Manual** `payins/execute` only |
| **Target** | **Keep PropMV** as sole invoice generator | **Payload native autopay** via **mirrored Payload Invoices** + **`default_payment_method`** |

Payload treats **recurring invoice generation** and **automatic payment** as **separate mechanisms**. Autopay does **not** require Payload Billing Schedules if PropMV syncs Payload Invoices.

Official references:

- [Automatic Payments](https://docs.payload.com/apis/automatic-payments/)
- [Customers — default payment method](https://docs.payload.com/apis/customers/)
- [Invoices](https://docs.payload.com/apis/object-reference/invoices/) (`autopay_allowed`)
- [Billing Schedules](https://docs.payload.com/apis/billing-schedules/) — **do not use for HOA dues** (duplicate of PropMV)

---

## 2. Payload autopay rules (source of truth)

### Enable autopay

- Set **`default_payment_method=true`** on exactly one stored **Payment Method** for the Payload **Customer**.
- Customer must be assigned Payload **Invoices** with **`due_date`** and outstanding balance.

### Automatic charge timing

- Charge on invoice **`due_date`** (Payload scheduler).
- **Retries:** up to **5 days** after due date if invoice remains open with default PM enabled.
- Declines may add **zero-amount payment line items** on the invoice (Payload behavior).

### Disable autopay

- Clear default PM, set invoice **`autopay_allowed=false`**, cancel/delete invoice, or (for billing-schedule-based subs) end schedule — for PropMV use **clear default + cancel/close synced Payload invoices**.

### Observability

- Webhook: **`automatic_payment`** (also generic **`payment`** for manual + automatic).
- Query: `GET /transactions/?type=payment&trigger=automatic`.

### Do not use for HOA v1

- **Payload Billing Schedules** to generate dues — would duplicate PropMV recurrence and board workflows.

---

## 3. Target end-to-end architecture

```text
[Existing] PropMV creates/updates Invoice (due date, balance, property → processing_id)
      ↓
[New] payloadInvoiceSync.service
      Upsert Payload Invoice when owner enrolled in autopay:
        customer_id, processing_id, due_date, amount_due,
        external_uid = propmvInvoiceId, autopay_allowed, attrs (hoaId, fee hints)
      ↓
[Payload] On due_date: charge default_payment_method (trigger=automatic)
      ↓
[New/Extended] Webhook automatic_payment (+ payment/processed)
      ↓
[Extended] Create or match PayloadPayin if missing (today: payin_not_found without execute)
      ↓
[Existing] applyPayloadPayinLifecycle → settleInvoiceGatewayPayment / fail
      ↓
Ledger + invoice paymentTransactions + status (webhook-authoritative)
```

---

## 4. Owner enrollment UX

### Behavior (Innago-like reference, not implementation copy)

- Toggle autopay on/off.
- Select one saved **card or ACH** (confirm wallet autopay with Payload in sandbox).
- Clear status when enabled; redirect to add payment method if none.
- Change method updates Payload default + local enrollment.
- Failures leave invoice unpaid; retries are **Payload’s**, not PropMV cron.

### PropMV UI (when built)

| Location | Work |
|----------|------|
| Replace mock | `innago-inspired-refresh/src/shared/pages/settings/AutoPayPage.tsx` |
| Entry | HOA owner Settings → Payment → Auto Pay |
| PM list | Reuse Payload APIs + same patterns as `PayloadPaymentMethodsPanel` / Cards page |
| Flags | `VITE_PAYLOAD_ENABLED` + proposed **`VITE_PAYLOAD_OWNER_AUTOPAY_ENABLED`** |

### Backend enrollment API (proposed)

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/payments/payload/autopay` | Status + selected PM |
| POST | `/payments/payload/autopay/enable` | Validate PM, set Payload default, persist enrollment |
| POST | `/payments/payload/autopay/disable` | Clear default, persist |
| PUT | `/payments/payload/autopay/payment-method` | Change PM |

---

## 5. Validation before enable

Must pass:

- Valid **`PayloadUser`** + **`metadata.payloadCustomerId`** (existing ensure-customer flow).
- ≥1 active **`PayloadPaymentMethod`** (not deleted; status usable).
- PM belongs to same **userId** + HOA **billableMerchantId** scope.
- Board **processing account active** for properties owner pays.
- **One enrollment per owner per HOA** (no conflicting config).

If no saved PM → **422/403** + UI → **`/settings/cards`**.

**v1 instrument scope:** Card + ACH; defer Apple/Google Pay until Payload confirms autopay eligibility.

---

## 6. Recurring invoices & frequencies (PropMV stays source)

| HOA setting | PropMV behavior |
|-------------|-----------------|
| `recurringFee.frequency` | monthly, quarterly, annually (`hoaSettings.model.js`) |
| `paymentTerm.dueDay` | Due date construction |
| Schedule extension | `invoiceScheduleMeta.service.js`, cron |
| Late fees | Separate PropMV invoices → sync when autopay enabled |

### Autopay vs frequency (target)

```text
Autopay enrollment (PropMV + Payload default PM)
      ↓
Invoice frequency (PropMV) → PropMV Invoice rows
      ↓
Invoice due date
      ↓
[Sync] Payload Invoice
      ↓
Due date → Payload automatic charge
      ↓
Webhook → ledger / invoice status
```

### Scenario matrix

| Scenario | Target behavior |
|----------|-----------------|
| Multiple open invoices | One Payload invoice per PropMV invoice; each charged on its own due date |
| Partial payments allowed | Sync `amount_due` = current `balanceDue`; update Payload invoice after manual partial pay |
| Partial not allowed | Sync full balance |
| Already paid | Close/skip Payload invoice sync |
| Late fee invoice | New PropMV invoice → new Payload invoice sync |
| Manual pay same period | Idempotency + balance check; no duplicate ledger (existing payin + webhook patterns) |
| **v1 FIFO sweep** | **Not** one autopay paying oldest across invoices — **one charge per invoice on its due date** unless product revises |

### Processing fees on autopay

- Manual pay uses `calculatePayloadProcessingFee` in validate/execute.
- **Spike required:** fee-inclusive **`amount_due`** on synced Payload Invoice so automatic charge matches PropMV rules (confirm Payload automatic charge vs `conv_fee` fields in sandbox).

---

## 7. Database changes (reuse first)

| Existing | Change | Purpose | Payload mapping |
|----------|--------|---------|-----------------|
| `PayloadUser` | Optional metadata fields **or** prefer new collection | Enrollment | `payloadCustomerId` |
| **New `OwnerPayloadAutopay`** (recommended) | `userId`, `hoaId`, `enabled`, local + provider PM ids, timestamps | One config per owner/HOA | `default_payment_method` |
| `PayloadPaymentMethod` | Reuse `isDefault`; enforce single default per scope when autopay on | Align with Payload | `default_payment_method` |
| `Invoice` | `metadata.payloadInvoiceId`, sync timestamps, eligibility flags | Reconciliation | Invoice `id`, `external_uid` |
| `PayloadPayin` | `metadata.trigger: 'automatic'` | Same lifecycle as manual | `transaction.trigger` |
| `PayloadWebhookEvent` | No change | Idempotency | `automatic_payment` |

Avoid parallel Customer/PM/Payment/ledger models.

---

## 8. Backend services (implementation phase)

| Service | Responsibility |
|---------|----------------|
| **`payloadInvoiceSync.service`** | Upsert/update/close Payload invoices on PropMV invoice lifecycle |
| **`payloadAutopay.service`** | Enable/disable/change method; validation |
| **`payload.client.js`** | `createInvoice`, `updateInvoice`, `getInvoice`, cancel as needed |
| **`payloadWebhook.service`** | Handle **`automatic_payment`**; ingest payin when no prior execute |
| **`payloadPayin.service`** | Extend `applyPayinWebhookUpdate` to match by Payload invoice / `external_uid` / attrs |
| **Hooks** | Invoice create/update/balance change/late fee → sync |
| **Reconciliation** | Extend existing Payload reconciliation for stale/missed autopay |
| **Cron** | Optional backfill/repair only — **not** payment scheduler |

---

## 9. Webhook lifecycle

### Success

```text
Payload automatic charge (trigger=automatic)
  → automatic_payment / processed webhook
  → PayloadWebhookEvent (idempotent)
  → GET /transactions/{id}
  → Find/create PayloadPayin
  → applyPayloadPayinLifecycle
  → settleInvoiceGatewayPayment + ledger
  → Invoice completed / balance updated
```

### Failure

```text
decline / reject
  → fail processing row; invoice unpaid
  → Payload retries ≤ 5 days (no PropMV retry cron)
  → Owner notification (email/in-app — product)
```

### Registration

Add dashboard webhook: **`automatic_payment`** (see [subscription tutorial](https://docs.payload.com/subscription-tutorial/)).

---

## 10. Disable / change payment method

### Disable

```text
Owner disables autopay
  → PropMV OwnerPayloadAutopay.enabled = false
  → Payload: default_payment_method=false on current PM
  → Open synced Payload invoices: autopay_allowed=false or cancel per Payload rules
  → Future dues not auto-charged
```

### Change method

```text
Validate new PM → clear old default → set new default on Payload
  → Update OwnerPayloadAutopay + local isDefault flags
```

### Deleted PM

- Disable autopay if enrolled PM removed; notify owner to re-enroll.

---

## 11. Multi-HOA / processing account safety

Autopay must preserve:

```text
HOA
  → Processing Account (invoice property deposit routing)
  → Payload Customer (per owner per HOA scope)
  → Payment Method
  → PropMV Invoice
  → Payload Invoice (same processing_id as manual payin)
```

- Never charge wrong **`processing_id`**: use same **`resolvePayinMerchantContext`** rules as manual pay.
- Unified wallet: enrollment is **per HOA**, not one global default across communities.

---

## 12. Security & production

- PCI: tokens only via Payload.js (unchanged).
- Webhook: persist + re-fetch transaction (unchanged).
- RBAC: owner-only enrollment mutations; audit via `auditPayload`.
- Idempotency: webhook eventId + payin keys + invoice attempt indexes.
- Monitoring: sync failures, `payin_not_found` on automatic webhooks, reconciliation alerts.
- Feature flag: **`PAYLOAD_OWNER_AUTOPAY_ENABLED`** (backend + frontend).

---

## 13. Migration / rollout phases

| Phase | Scope |
|-------|--------|
| **0** | Sandbox spike: sync one invoice, default PM, trigger automatic_payment, fee behavior |
| **1** | Enrollment API + real Auto Pay UI (no invoice sync) |
| **2** | Invoice sync + webhooks + payin ingest for automatic |
| **3** | Notifications + reconciliation hardening |
| **Prod** | Flag off until Phase 2 passes QA |

**Non-goals for v1:** Payload Billing Schedules; autopay for legacy Stripe/Straddle; breaking manual `payins/execute`.

---

## 14. Failure & recovery reference

| Failure | Autopay config | Invoice | Ledger | Owner UI |
|---------|----------------|---------|--------|----------|
| Declined card | Stays enabled during Payload retry window | Unpaid | No duplicate settle | Failed payment message |
| Retries exhausted (~5 days) | Enabled until owner acts | Unpaid | — | Pay manually / update PM |
| Deleted PM | Disable autopay | Open unpaid | — | Re-enroll |
| ACH failure | Per existing ACH webhook rules | Processing/failed | Webhook-only settle | Existing ACH copy |
| Webhook delay | — | May show processing | Reconciliation | Processing state |
| API/sync failure | Enabled | PropMV unchanged | — | Ops alert; retry sync job |

---

## 15. Implementation status

| Area | Status |
|------|--------|
| `OwnerPayloadAutopay` + invoice `payloadAutopayMirror` | Shipped |
| `/payments/payload/autopay` APIs | Shipped |
| `payloadInvoiceSync.service` + daily scheduler + event hooks | Shipped (§17.5) |
| `automatic_payment` webhook + pay-in ingest without execute | Shipped |
| Owner `AutoPayCard` + `useOwnerPayloadAutopay` | Shipped |
| Point 2: confirmation UX, next date/amount, event sync, pre-charge guard | **Shipped** (§17) — sandbox Phase-0 still required before prod |
| Autopay invoice ownership scope (`tenants: ObjectId` + property universe) | **Shipped** — `payloadAutopayInvoiceScope.util.js` (§17.4); fixes `nextAutopay` null when Owner Invoices showed open invoices |
| Sandbox fee parity spike / production webhook registration | **Ops** — Phase-0 checklist in §17.6 (required before prod) |

### Phase-0 / sandbox validation (required before production)

Run in Payload sandbox with `PAYLOAD_OWNER_AUTOPAY_ENABLED=true` and webhook `automatic_payment` registered:

1. Mirror upsert with line item id update after partial manual payment (amount_due drops).
2. Fee-inclusive charge matches manual `validate/execute` for same invoice + PM type.
3. Card autopay: invoice not Paid until authorized/processing webhook; ledger on settle.
4. ACH autopay: invoice stays Processing until `processed`; return fails without duplicate settle.
5. Declined autopay + retry with new transaction id — one ledger completion per success.
6. Duplicate `automatic_payment` webhook for same txn — no double settle.
7. Manual pay zeroing balance before due date — mirror closed/updated; autopay does not over-charge.
8. `assertMirrorSafeForAutopay` disables mirror if amount_due still high after correction attempt.

Enable in staging/production: set backend `PAYLOAD_OWNER_AUTOPAY_ENABLED=true`, frontend `VITE_PAYLOAD_OWNER_AUTOPAY_ENABLED=true`, register Payload webhook `automatic_payment`.

---

## 16. Agent instructions after approval

Point 2 (§17) is approved and implemented. Before production:

1. Implement **only** this roadmap; no unrelated refactors.
2. Preserve manual pay path and webhook idempotency.
3. Add tests: enrollment, sync upsert, webhook automatic without prior execute, fee amount parity sandbox test, pre-charge guard, retry duplicate txn ids, ACH vs card settle boundaries.
4. Update `PAYLOAD_FOUNDATION.md` and QA doc when shipping.
5. Keep frontend mock Auto Pay removed/replaced behind feature flag.

---

## 17. Point 2 gate — clarified design (pre-implementation)

This section finalizes the five approval topics. PropMV remains the **only** source of invoice schedule, frequency, amounts, and due dates. Payload executes automatic charges against **mirrored** open invoices; it does **not** own recurrence.

Official Payload references used here:

- [Automatic Payments](https://docs.payload.com/apis/automatic-payments/) — due-date charge, 5-day retry window, disable via cancel/close/`autopay_allowed`
- [Invoice object](https://docs.payload.com/apis/object-reference/invoices/) — `amount_due` / `total_due` are **readonly**; balance is derived from line items
- [Create / update invoices](https://docs.payload.com/apis/invoices/) + [API design — PUT updates](https://docs.payload.com/apis/api-design/) — `due_date`, `items`, `attrs`, `autopay_allowed`, `status` via `PUT /invoices/{id}/`; nested line items updated by including each item’s **`id`** in the payload
- [Line items](https://docs.payload.com/apis/object-reference/line-items/) — charge vs payment `entry_type`; payment rows tie to transactions (declined autopay attempts may appear as **zero-amount payment** line items per Automatic Payments doc)

### 17.1 Payload mirror amount safety

#### What Payload allows before due date

| Question | Answer |
|----------|--------|
| Can an open mirrored invoice be updated before `due_date`? | **Yes.** PropMV already calls `PUT /invoices/{id}/` via `payload.client.updateInvoice` in `upsertPayloadMirrorInvoice`. Writable fields include `due_date`, `processing_id`, `description`, `attrs`, `autopay_allowed`, `status`, and **`items`** (charges). |
| Can `amount_due` be set directly? | **No.** It is readonly; autopay uses the computed **`amount_due`** from charge/payment line items at charge time. |
| How must PropMV change the charge amount? | Reconcile PropMV `balanceDue` + fee quote → adjust **charge** line item(s) via `buildMirrorChargeItems` (preserves Payload line item **`id`** on PUT). |
| When does Payload charge? | On invoice **`due_date`** for open invoices with outstanding balance and customer **default payment method** ([Automatic Payments](https://docs.payload.com/apis/automatic-payments/)). |

#### Stale mirror prevention (PropMV policy)

Payload will charge whatever **`amount_due`** is on the mirror at charge time. PropMV must never leave a mirror amount above current **`balanceDue`** (plus agreed processing fee) after:

- partial manual payment, credit, board-side line edit, late fee add-on, waiver reversal, or due-date change.

**Primary mechanism:** event-driven **`syncInvoiceIfOwnerEnrolled(invoiceId)`** (see §17.5) after every balance/due/status change so the mirror is corrected **before** due date.

**Safety net:** daily repair job (existing scheduler) plus optional **due-date morning pass** (same cron timezone as HOA billing) to re-sync invoices whose `dueDate` is today — not the primary sync path.

#### Final pre-charge consistency check (authoritative algorithm for Point 2)

Run **`assertMirrorSafeForAutopay(invoiceId)`** in two places:

1. **Before every mirror upsert completes** (sync path).
2. **Immediately before ledger settlement** when processing an automatic payment webhook (last line of defense).

Steps (same inputs as manual pay fee logic):

```text
1. reconcileInvoiceStoredTotals(invoice)
2. If balanceDue <= 0 OR invoice not eligible → close mirror (autopay_allowed=false, status=closed); STOP
3. Load enrollment + PM → expected = calculatePayloadProcessingFee(balanceDue, methodType, billingSettings)
   expectedCharge = expected.chargeAmount   // fee-inclusive dollars Payload should charge
   expectedInvoicePayment = expected.invoicePaymentAmount
4. GET Payload mirror invoice (by payloadInvoiceId)
5. If GET fails / no mirror → upsert mirror from step 3; STOP
6. remoteDue = payload.due_date; localDue = formatPayloadDueDate(invoice.dueDate)
   If remoteDue != localDue → include due_date in PUT
7. If roundMoney(payload.amount_due) > roundMoney(expectedCharge) + $0.01:
     a. PUT corrected charge line item(s) + attrs (propmvInvoiceId, invoicePaymentAmount, chargeAmount, fees)
     b. Re-GET; if still amount_due > expectedCharge + $0.01 → set autopay_allowed=false, log + alert, do NOT rely on charge
8. If roundMoney(payload.amount_due) < roundMoney(expectedCharge) - $0.01:
     → upsert upward to expected (under-charge is acceptable to fix via sync; owner may need second payment if partial paid)
```

**On automatic webhook (before `settleInvoiceGatewayPayment`):**

```text
9. txnInvoicePayment = attrs.invoicePaymentAmount OR derived from transaction amount minus fee
10. If txnInvoicePayment > invoice.balanceDue + $0.01 → do NOT settle; mark payin for ops review; optionally void on Payload if API allows
11. If invoice already has completed gateway tx covering this balance → treat as duplicate (existing hasCompletedGatewayTransaction guard)
```

**Sandbox spike (Phase 0 / Point 2 QA):** confirm `PUT` with line item `id` updates `amount_due` on an open invoice 1–7 days before due date without cancel/recreate.

---

### 17.2 Retry and idempotency

#### How Payload retries appear

| Topic | Behavior (per Payload docs + transaction model) |
|-------|--------------------------------------------------|
| Retry window | Up to **5 days after due date** while invoice stays open, customer has default PM, autopay not disabled ([Automatic Payments](https://docs.payload.com/apis/automatic-payments/)). |
| Declined attempts | May add **zero-amount payment** line items on the invoice (same doc). |
| Webhooks | Subscribe to **`automatic_payment`** for autopay attempts; also register **`payment`**, **`processed`**, **`authorized`**, **`decline`**, **`reject`** (same as manual pay — already in `isPayinRelatedWebhookTrigger`). Each attempt is observed via webhooks; processor **re-fetches** `GET /transactions/{id}` before apply (`payloadWebhook.service.js`). |
| Retry = same transaction or new? | **New payment transaction per attempt.** Retries are separate charges (`trigger=automatic`), filterable by `created_at` ([Automatic Payments — querying](https://docs.payload.com/apis/automatic-payments/)). PropMV must **not** assume a stable transaction id across days. |
| Same attempt, duplicate delivery | Same **`transactionId`** → duplicate **`PayloadWebhookEvent.eventId`** (unique index) and/or existing **`PayloadPayin.payinId`** short-circuit in `ensurePayinFromAutomaticPaymentWebhook`. |

#### PropMV idempotency layers (existing + Point 2 hardening)

| Layer | Key | Effect |
|-------|-----|--------|
| Webhook inbox | `PayloadWebhookEvent.eventId` | Drop duplicate webhook deliveries |
| Payin record | `payinId` = Payload transaction id | One `PayloadPayin` per transaction |
| Attempt key | `paymentAttemptId` = `automatic:{transactionId}` | One processing row per attempt |
| Ledger settle | `hasCompletedGatewayTransaction` / `duplicate: true` in `settleInvoiceGatewayPayment` | No second COMPLETED tx for same `payinId` |
| Invoice | `findProcessingTransactionForGateway` | Match processing row before settle |

**Double-settle prevention:** A successful autopay attempt creates at most one COMPLETED invoice gateway transaction when settlement runs once with a settled-eligible status (§17.3). A later retry after failure uses a **new** `transactionId` → new processing row; if the first attempt partially settled or invoice balance changed, §17.1 step 10–11 applies.

**Point 2 tests:** duplicate `automatic_payment` webhook for one txn id; two txn ids for same invoice (decline then success); success webhook after PropMV manual pay zeroed balance (must not over-settle).

---

### 17.3 Card vs ACH lifecycle (PropMV settlement)

Policy is implemented in **`resolvePayloadPayinSettlementAction`** (`payloadPayinSettlement.util.js`) and **`applyPayloadPayinLifecycle`**. Autopay uses the **same** rules as manual Payload pay — initiating autopay does **not** mean paid.

#### Status map

| Stage | Card / instant (CARD, Apple Pay if enabled later) | ACH / bank (ACH, Plaid ACH) |
|-------|---------------------------------------------------|-----------------------------|
| `automatic_payment` webhook received | Create/update `PayloadPayin`; sync **processing** row on invoice (`syncPayloadPayinToInvoiceProcessing`) | Same — invoice moves to **processing**, not paid |
| Payload txn `authorized` / `processing` / payin PROCESSING | **Settle** (`settleInvoiceGatewayPayment`) — invoice may become Paid when balance cleared | **Do not settle** — remain processing |
| Payload txn `processed` / payin SUCCEEDED | No-op (already settled) or confirm | **Settle** — funds committed for deposit |
| `decline` / `reject` / FAILED / RETURNED / CANCELED | **Fail** processing row; invoice unpaid | Same; ACH **return** after success → fail path + audit |
| Owner-visible invoice status | Paid only after **settle** path recalculates totals | **Processing** until SUCCEEDED/processed settle; not Paid on initiate |

#### Webhook / status that means “successfully settled” for PropMV

| Method | Treat as settled when |
|--------|------------------------|
| Card-like | After webhook lifecycle with `resolvePayloadPayinSettlementAction → settle`, driven by **`authorized`**, **`processing`**, or normalized **PROCESSING** status (see util comments). |
| ACH-like | Only when normalized **SUCCEEDED** or event **`processed`**. |

**Not sufficient for Paid:** `automatic_payment` alone, CREATED payin, or ACH in PROCESSING.

**Autopay-specific:** On successful settle with `metadata.trigger === 'automatic'`, mirror invoice is **closed** (`closePayloadMirrorInvoice`) — already shipped.

---

### 17.4 Next autopay date and amount (PropMV-only)

Payload **Billing Schedules are not used** and must not drive owner “next charge” UI or backend fields.

#### Ownership / invoice scope (shared with mirror sync)

Owner Invoices **visibility** uses `applyOwnerPayerInvoiceScope` → `resolveHoaOwnerInvoicePropertyIds` (property universe; may show unit invoices even when this owner is not on `tenants[]`).

Autopay **chargeability** must not use property scope alone. Shared helper: **`payloadAutopayInvoiceScope.util.js`**.

| Gate | Implementation |
|------|----------------|
| Property universe | `resolveHoaOwnerInvoicePropertyIds(ownerId)` — same as Owner Invoices |
| HOA | `hoaId` = enrollment HOA |
| Payer isolation | **`tenants: ownerOid`** — HOA schema is `tenants: [ObjectId]`, **not** `tenants.userId` |
| Eligibility | `balanceDue > 0`, dueDate present, not deleted, `isInvoiceEligibleForAutopaySync` |

Same filter (or `isOwnerChargeableForAutopayInvoice` for single-invoice paths) applies to: `computeNextAutopayForOwner`, `computeLastAutopayAttemptForOwner`, `syncOpenInvoicesForOwner`, disable/cleanup, daily repair, and `syncInvoiceIfOwnerEnrolled` payer matching (`normalizeInvoiceTenantUserId` — no BSON `ObjectId._id` quirk).

**Isolation:** another owner on the same HOA/property who is **absent** from `tenants[]` must not get that invoice as `nextAutopay` or as a mirrored charge target. Co-owners **both** stamped on `tenants[]` follow existing shared-payer behavior.

#### Derivation (single source of truth)

```text
OwnerPayloadAutopay (enabled) + HOA scope
  → buildOwnerAutopayInvoiceMongoFilter(ownerId, hoaId):
       propertyId ∈ resolveHoaOwnerInvoicePropertyIds(ownerId)
       hoaId match
       tenants: ownerOid          // mandatory chargeability gate
       isDeleted != true
       balanceDue > 0, dueDate present
  → Filter with isInvoiceEligibleForAutopaySync (not paid/cancelled/waived/void)
  → Sort by dueDate ascending, then createdAt
  → nextAutopay:
       propmvInvoiceId      = earliest row._id
       nextChargeDate       = earliest row.dueDate (HOA/display timezone rules — same as invoice list UI)
       nextInvoicePaymentAmount = roundMoney(row.balanceDue)   // principal toward invoice
       nextProcessingFee    = calculatePayloadProcessingFee(..., enrolled PM methodType)
       nextChargeAmount     = fee quote chargeAmount            // what mirror/autopay should charge
       nextInvoiceNumber    = row.invoiceId (display)
```

If no open eligible invoice → `nextAutopay: null` (UI: “No upcoming charge…” — not a Payload schedule).

**Multiple open invoices:** v1 remains **one Payload mirror per PropMV invoice**, each charged on **its own due date** (§6 scenario matrix) — “next” is the **earliest due**, not FIFO sweep across one combined charge.

**Point 2 deliverables:** extend `GET /payments/payload/autopay` (and frontend card/settings) with computed `nextAutopay` object above; never read Payload Billing Schedule or Payload invoice due dates for schedule creation.

---

### 17.5 Invoice mirror sync triggers (event-driven primary)

`syncInvoiceIfOwnerEnrolled` is invoked via **`schedulePayloadAutopayMirrorSync`** on invoice create/update/delete/waive and gateway settle/fail. Daily cron remains **repair only**.

| Event | Mirror action |
|-------|----------------|
| PropMV invoice **created** (owner chargeable: property scope + on `tenants[]` as ObjectId, balance > 0) | Upsert mirror if owner enrolled |
| Board **updates** invoice (amount, due date, line items, late fees) | Upsert or refresh amounts/due date |
| **Manual payment** recorded (partial or full) via board or owner Payload manual pay | Reconcile totals → upsert if balance > 0; **close** if paid |
| **Credit / adjustment** reducing balance | Upsert or close |
| **Waive / cancel / void** invoice | Close mirror (`autopay_allowed=false`, `status=closed`) |
| Owner **enables** autopay | `syncOpenInvoicesForOwner` backfill (shipped) |
| Owner **changes** autopay PM | Re-sync open mirrors (fee/method type may change) |
| Owner **disables** autopay | Clear default PM + close open mirrors (shipped) |
| Autopay **settles** successfully | Close mirror (shipped on settle) |
| Payload PM **deleted** | Disable autopay + close mirrors (shipped) |

**Implementation hook points (shipped):** `schedulePayloadAutopayMirrorSync.js` → `invoice.service.js` (create/update/delete/waive) and `invoiceProcessingPayment.helper.js` (settle/fail).

**Daily scheduler (`payloadAutopayInvoiceSyncScheduler`):** safety net only — catches missed webhooks, drift between `payload.amount_due` and expected, missing mirrors for enrolled owners. **Not** the primary sync mechanism.

**Reconciliation extension:** flag mirrors where `amount_due` ≠ expected after sync, or open PropMV invoice lacks mirror while enrolled.

---

### 17.6 Point 2 scope checklist (after §17 approval)

| Item | Notes |
|------|--------|
| Mirror PUT with line item ids | §17.1 |
| `assertMirrorSafeForAutopay` | §17.1 steps 1–11 |
| Invoice lifecycle hooks | §17.5 |
| `nextAutopay` on GET autopay + UI | §17.4 |
| Confirmation step UX | Product copy + confirm PM/due/amount |
| Last attempt status on card | From latest `PayloadPayin` with `metadata.trigger=automatic` per invoice |
| Tests | §17.1–17.2 scenarios |

---

## 18. Code map (for software engineers)

Read **§3**, **§17**, and **`existing-architecture.md` § Owner autopay** first. Then use this index:

| Concern | Primary files |
|---------|----------------|
| Feature flags | `propmv/src/config/payload.config.js` (`ownerAutopayEnabled`); `innago-inspired-refresh` `VITE_PAYLOAD_OWNER_AUTOPAY_ENABLED` |
| Enrollment API | `payload.routes.js` → `payload.controller.js` → `payloadAutopay.service.js` |
| Enrollment DB | `ownerPayloadAutopay.model.js`; `invoice.model.js` → `payloadAutopayMirror` |
| Owner property universe (list + Autopay) | `common/helpers/hoaPropertyScope.js` → `resolveHoaOwnerInvoicePropertyIds` |
| Autopay invoice scope / payer isolation | `utils/payloadAutopayInvoiceScope.util.js` (+ `.test.js`) |
| Mirror sync | `payloadInvoiceSync.service.js`, `payloadMirrorSafety.util.js`, `payloadInvoiceSync.util.js` |
| Event-driven sync | `helpers/schedulePayloadAutopayMirrorSync.js` → `syncInvoiceIfOwnerEnrolled` (uses `isOwnerChargeableForAutopayInvoice`) |
| Daily repair | `payloadAutopayInvoiceSyncScheduler.service.js` → `syncOpenInvoicesForOwner` (same scope filter) |
| Payload HTTP | `payload.client.js` (`createInvoice`, `updateInvoice`, `getInvoice`) |
| Autopay webhooks | `payloadWebhook.service.js` → `payloadPayin.service.js` (`ensurePayinFromAutomaticPaymentWebhook`, `applyPayloadPayinLifecycle`) |
| Settlement (card/ACH) | `payloadPayinSettlement.util.js` — **same for manual + autopay** |
| Invoice ledger | `invoiceProcessingPayment.helper.js` |
| Owner UI | `AutoPayCard.tsx`, `OwnerAutoPaySettingsPanel.tsx`, `useOwnerPayloadAutopay.ts`, `payloadApi.ts` |
| QA + implementation overview | **`HOA-Owner-Autopay-Implementation-and-QA.md`** (canonical for QA; pointer in `qa-autopay-payload.md`) |

**Engineer onboarding:** **Yes — `roadmap-autopay.md` is sufficient** for a software engineer to understand Autopay in the codebase when read with **`existing-architecture.md`** and the code map above (§18). §17 is the authoritative behavioral spec; §15–§18 track ship status and file locations. Full confirmation + QA procedures: **`HOA-Owner-Autopay-Implementation-and-QA.md` Part C**.

---

*Reference architecture for PropMV HOA Owner Autopay using Payload Automatic Payments + Invoice mirror model.*
