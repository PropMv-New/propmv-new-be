# Phase 4 Plan — Owner → Vendor Electronic Payment Engine

**Status:** APPROVED WITH MANDATORY CORRECTIONS (2026-10-09) — implementation may proceed under this plan  
**Depends on:** Phase 0–3 COMPLETE (sandbox architecture verified; Vendor PA + banks; eligibility + safety gate)  
**Architecture (approved):**

```text
Assigned HOA Owner → Vendor Payload Processing Account → Vendor default deposit bank
  → Payload payment → verified webhook/status → VendorInvoice settlement
```

**Not this phase:** Board → Vendor; HOA Treasury credit; HOA bank two-way; HOA Primary/routing; Autopay; Check21; Rainforest; Straddle migration.

### Locked decisions (mandatory corrections)

| Topic | Decision |
| --- | --- |
| **Amount / fee** | Inspected VendorInvoice domain: **no** authoritative Vendor payer fee/convenience fee exists. Phase 4 v1 charges **`invoicePaymentAmount` only**. Do **not** reuse HOA fee logic. Same amount in validate, charge, persist, settle, UI. `processingFeeAmount = 0`. |
| **Partial payment** | VendorInvoice already supports partials (`amountPaid` / `balanceDue` / Record Payment). Phase 4 **supports partials**. Atomic: `amountPaid + inFlightElectronic + newPayment <= subAmount` (collectable ceiling). |
| **Settlement** | **Only** `resolvePayloadPayinSettlementAction` decides settle/fail/reverse/none. Never settle from raw PROCESSING/authorized alone outside that util. ACH waits until predicate allows. |
| **Destination bank** | **Only** configured default (`defaultDepositMethod` / verified default). **No** “first eligible bank” fallback. Missing/invalid/inactive default → blocker; do not execute. |
| **PM immutability on execute** | Execute must **not** create/update/delete/reassign Owner PMs or Vendor deposit methods. Both must already exist and pass eligibility. Customer id from existing records / remote PM read only. |
| **Production** | Sandbox COMPLETE ≠ production-ready. Keep `PAYLOAD_VENDOR_PAY_ENABLED=false` in production until live webhooks, auth, re-fetch, card/ACH lifecycle, webhook idempotency, crash recovery, and ACTIVE Vendor PA are separately verified. |

---

## 1. Goal and non-goals

### Goal

Enable the **assigned HOA Owner** to electronically pay a payable `VendorInvoice` through Payload, with PropMV-owned attempt persistence, webhook-driven lifecycle, and settlement onto the VendorInvoice only after the correct Payload success/settlement predicate.

### Non-goals (hard prohibitions)

| Prohibited | Rationale |
| --- | --- |
| Board → Vendor electronic pay | Deferred; Board Customer strategy remains document-only from Phase 3 |
| HOA Treasury → Vendor credit/payout | Separate treasury architecture |
| HOA bank receive-only → two-way | Phase 0 WARN: recreate PM later; not Vendor pay |
| HOA Primary / routing changes | Vendor banks only |
| Autopay / Check21 / Rainforest / Straddle migration | Orthogonal; must not regress |
| Reusing HOA `POST /payins/execute` with VendorInvoice ids | HOA `PayloadPayin.invoiceId` → `Invoice` only; wrong merchant/ledger |
| Restoring broken `OwnerPaymentDialog` → HOA executePayin for Vendor invoices | Phase 3 safety boundary stays until Vendor execute exists |

---

## 2. Feature flags

| Flag | Purpose |
| --- | --- |
| Existing `PAYLOAD_VENDOR_MERCHANT_ENABLED` (+ Vite) | Vendor PA / banks / eligibility remain required |
| **New** `PAYLOAD_VENDOR_PAY_ENABLED` (+ Vite mirror) | Gates electronic **execute** + UI ungating |

Phase 3 deliberately omitted `PAYLOAD_VENDOR_PAY_ENABLED`. Phase 4 **introduces** it so:

- Merchant onboarding / eligibility can stay on without enabling live charges.
- Broken path stays gated when merchant-on / pay-off.
- Electronic Pay UI mounts only when **both** merchant + pay flags are on **and** eligibility says executable.

**Authorization is not replaced by flags.** Flags only enable the engine surface.

---

## 3. Exact resolution chain (server-only)

Client may send: `vendorInvoiceId`, `invoicePaymentAmount`, `paymentMethodLocalId` (or provider PM id of **Owner’s** saved method), `paymentAttemptId`.  
Client must **never** supply Vendor `acct_…`, Vendor bank `pm_…`, or Owner `customer_id` as charge authorities.

### 3.1 VendorInvoice → Vendor PayloadAccount

1. Load invoice via `vendorInvoice.service.getVendorInvoiceById(vendorInvoiceId, actorId, hoaContext)` — preserves visibility/assignment auth.
2. Resolve `vendorUserId = invoice.vendorId`.
3. Load `PayloadAccount` where `entityType=vendor`, `createdBy=vendorUserId`, `isDeleted≠true` (same as Phase 3 `findVendorPayloadAccount`).
4. Require `merchantId` present and `onboardingStatus === ACTIVE` (production gate; Phase 0 incomplete-PA caveat).
5. Charge `processing_id` = server-resolved `merchantId` only.

### 3.2 Vendor receiving bank

1. Resolve **only** the configured default deposit bank (`defaultDepositMethod=true` and/or `isPrimaryPayout` mirror of Payload `default_deposit_method`).
2. **Never** fall back to “first eligible bank.” If default missing/invalid/inactive/ineligible → payment blocker; **do not** execute.
3. Charge `processing_method_id` = that bank’s `depositMethodId` only.
4. Cross-account isolation: bank’s `payloadAccountRef` must equal Vendor account; reject foreign `pm_`.

### 3.3 Owner Customer / payment method

1. Actor must be `invoice.assignedTo` (see §10 Authorization).
2. Load existing Owner `PayloadPaymentMethod` by local id; assert ownership (`userId=actor`, HOA scope, ACTIVE/CREATED, send-capable).
3. Resolve `customer_id` from **existing** local PayloadUser metadata and/or Payload `GET` payment method (`customer_id`) — **read only**.
4. If customer id or PM missing/ineligible → blocker. Execute must **not** create/update/delete/reassign Owner PMs or Vendor deposit methods.
5. Card: require billing address already present on the PM (Phase 0); do not invent address during execute.

### 3.4 Amount / balance validation (authoritative calculation)

**Final amount rule (Phase 4 v1):**

```text
chargeAmountDollars = invoicePaymentAmount
chargeAmountCents   = round(invoicePaymentAmount * 100)
processingFeeAmount = 0
```

No HOA fee util. Same value used in validate, Payload charge, `PayloadVendorPayin` persistence, settlement apply, and UI.

**Collectable / concurrency:**

```text
inFlightElectronic = sum(invoicePaymentAmount of non-terminal electronic payins)
assert: amountPaid + inFlightElectronic + invoicePaymentAmount <= subAmount
```

1. Re-read VendorInvoice under concurrency control.
2. Reject if status ∈ {Paid, Cancelled} or remaining collectable ≤ 0.
3. `invoicePaymentAmount > 0` and satisfies the inequality above.
4. **Partials allowed** (existing VendorInvoice behavior). No new partial-payment product rule.

### 3.5 Payload charge body (Phase 0 verified shape)

```text
type: payment
amount: <invoicePaymentAmount dollars only>
processing_id: acct_<Vendor_PA>          # server
payment_method_id: pm_<Owner_PM>         # server
customer_id: acct_<Owner_Customer>       # server (existing only)
processing_method_id: pm_<Vendor_default_bank>  # server default only
```

Idempotency header: PropMV key (see §5).

---

## 4. Persistence model (new)

### 4.1 Why not reuse `PayloadPayin` as-is

`payloadPayin.model.js` requires `invoiceId` → HOA `Invoice`. Webhook settle path calls `settleInvoiceGatewayPayment`. Mixing Vendor refs would corrupt HOA ledger/reconciliation.

### 4.2 Proposed model: `PayloadVendorPayin` (new collection)

**File (new):** `src/shared/modules/payment/providers/payload/model/payloadVendorPayin.model.js`

| Field | Purpose |
| --- | --- |
| `provider` | `PAYLOAD` |
| `vendorInvoiceId` | ref `VendorInvoice` (required, indexed) |
| `hoaId` | from invoice |
| `vendorUserId` | invoice.vendorId |
| `payerUserId` | assigned Owner (actor) |
| `payloadAccountRef` | Vendor `PayloadAccount` |
| `merchantId` | Vendor `acct_…` |
| `destinationDepositMethodId` | Vendor bank `pm_…` |
| `providerPaymentMethodId` | Owner PM `pm_…` |
| `paymentMethodLocalId` | Owner local PM |
| `customerId` | Owner Payload customer id |
| `methodType` | CARD / ACH / PLAID_ACH |
| `status` | CREATED → PROCESSING → SUCCEEDED / FAILED / RETURNED / CANCELED / IN_REVIEW |
| `invoicePaymentAmount` | net applied to VendorInvoice |
| `chargeAmountCents` | Payload charge minor units |
| `processingFeeAmount` | if fees enabled |
| `paymentAttemptId` | client/server attempt id |
| `idempotencyKey` | unique `(provider, idempotencyKey)` |
| `transactionId` / `payinId` | Payload txn id (sparse unique) |
| `settledAt` / `failedAt` / `lastWebhookAt` | lifecycle |
| `raw` / `refusalCode` / `refusalDesc` | diagnostics |
| `metadata` | phase markers, eligibility snapshot ids |

**Indexes:** unique idempotency; sparse unique transaction id; `(vendorInvoiceId, paymentAttemptId)`; `(vendorInvoiceId, status)` for in-flight holds.

### 4.3 Optional VendorInvoice gateway fields

Add (non-breaking):

- `gatewayProvider`, `activePayloadVendorPayinId`, or keep linkage only on payin docs + activity timeline.

Prefer **payin doc as source of truth**; VendorInvoice gets amount/status updates via settlement helpers.

---

## 5. Idempotency (primary) + Payload `duplicate_attempt` (secondary)

### Primary — PropMV

Mirror `buildPayinIdempotencyKey` pattern from `payloadPayin.service.js`:

```text
idempotencyKey = sha256(userId + vendorInvoiceId + paymentAttemptId).slice(...)
```

1. Client generates stable `paymentAttemptId` per UI submit (UUID).
2. Before Payload call: insert `PayloadVendorPayin` with unique key.
3. If key exists and already charged → return `{ duplicate: true, item }` (HTTP 200).
4. Pass `Idempotency-Key: ${idempotencyKey}_vendor_payin` to Payload `createPaymentTransaction`.

### Secondary — Payload

Phase 0: same key may yield `status_code=duplicate_attempt` / declined **new** txn id (not original).

On Payload decline/400 with duplicate semantics:

1. Look up local row by idempotency key / attempt id.
2. If local already has `transactionId` → return that row (safe no-op).
3. Else re-fetch by stored id if any; else mark attempt failed-open for support with clear code `PAYLOAD_DUPLICATE_ATTEMPT` and **do not** double-settle.
4. Never create a second settlement from a duplicate decline body.

---

## 6. Card vs ACH lifecycle and VendorInvoice transitions

**Sole settlement authority:** `resolvePayloadPayinSettlementAction` (`payloadPayinSettlement.util.js`).

Do **not** settle VendorInvoice merely because Payload returns raw `PROCESSING`, `authorized`, or another status string. Map remote fields → call the util → act only on `settle` | `fail` | `reverse` | `none`.

| Rail | On execute | Settle VendorInvoice when |
| --- | --- | --- |
| Card / wallets | May move invoice → `Processing`; settle **only if util returns `settle`** | Util `settle` (typically PROCESSING/authorized for card-like) |
| ACH / Plaid | Invoice → `Processing`; remain pending until util allows | Util `settle` (SUCCEEDED/processed only) |
| Fail | Release hold | Util `fail` |
| Post-settle return/reject | Reverse books | Util `reverse` |

### VendorInvoice state machine (electronic)

| Event | Transition |
| --- | --- |
| Execute accepted (charge created) | `Pending` → `Processing` (if not already); record activity `payment_gateway_initiated` |
| Settle predicate met | Apply `invoicePaymentAmount` to `amountPaid`; recompute `balanceDue`; `Paid` if covered else stay `Processing`/`Pending` per `deriveStatus`; `paidAt` when Paid; `ensureExpenseForPaidVendorInvoice` |
| Fail before settle | Clear in-flight hold; return toward `Pending` if no other holds; activity `payment_gateway_failed` |
| Reverse after settle | Decrement `amountPaid` / reopen balance; activity `payment_gateway_reversed`; expense handling TBD (idempotent adjust or flag — kickoff decision; proposal: reverse expense link only if expense was created solely from this payin) |

**Coexistence with manual Record Payment:** Manual PUT remains Vendor/Board-only. Electronic path must:

- Count in-flight electronic `PROCESSING` amounts in collectable balance.
- Reject execute if manual/electronic would overpay.
- Never block Record Payment when no electronic in-flight conflict.

---

## 7. Payment-attempt persistence and recovery

| Stage | Behavior |
| --- | --- |
| Pre-charge | Persist CREATED attempt |
| Post-charge | Store Payload `transactionId`, status map, raw |
| Client timeout | Client may retry **same** `paymentAttemptId` → duplicate-safe |
| Crash after charge before local update | Reconciliation job / webhook re-fetch by idempotency metadata or txn search; Phase 4 minimum: webhook + get-by-id recovery endpoint |
| Stuck Processing | Ops: `retryFailedPayloadWebhooks` extended to Vendor payins; optional reconcile script |

**New service file:** `payloadVendorPayin.service.js`  
**Helpers:** `payloadVendorPayinSettlement.helper.js` (or under vendor-invoice helpers) for invoice book updates — **do not** call `settleInvoiceGatewayPayment`.

---

## 8. Concurrency / overpayment protection

1. Atomic collectable check: `findOneAndUpdate` / session transaction locking VendorInvoice when recording Processing hold and on settle.
2. Collectable = `subAmount - amountPaid - sum(in-flight electronic net amounts)`.
3. Reject concurrent executes that would exceed collectable (`409` / `VENDOR_INVOICE_OVERPAY`).
4. Settle applies amount only once per payin (`settledAt` guard); webhook retries are no-ops after settle.
5. Manual Record Payment during electronic Processing: either block overpay or reduce collectable — proposal: **allow manual only up to remaining after electronic holds**.

---

## 9. Webhooks

### Reuse existing ingress

| File | Role |
| --- | --- |
| `payloadWebhook.routes.js` | `POST /api/webhooks/payload` |
| `payloadWebhook.middleware.js` | Auth, validate, rate limit |
| `payloadWebhook.service.js` | Persist `PayloadWebhookEvent`, dedupe, re-fetch txn, dispatch |

### Phase 4 additions

1. After re-fetch, if txn `processing_id` matches a Vendor `PayloadAccount.merchantId` **or** local `PayloadVendorPayin.transactionId` matches → route to `applyVendorPayinWebhookUpdate`.
2. Never settle from webhook body alone — always `GET /transactions/{id}`.
3. Event dedupe via existing `PayloadWebhookEvent` unique `eventId`.
4. Apply `resolvePayloadPayinSettlementAction` → Vendor settlement helper.
5. Live Vendor webhook delivery verification is a **production-readiness gate** (Phase 0/1 called this Phase 8). Phase 4 sandbox must still simulate webhook handler with re-fetched fixtures.

---

## 10. Authorization — who may pay

| Actor | Electronic pay | Manual Record Payment |
| --- | --- | --- |
| Assigned Owner (`assignedTo`) | **Yes** (Phase 4) | No (existing) |
| Other HOA Owner (same HOA, not assignee) | **No** | No |
| HOA Board Member | **No** (Phase 4) | Yes (existing) |
| Vendor | **No** | Yes (existing) |

Rules:

1. Electronic execute requires `String(actorId) === String(invoice.assignedTo)`.
2. Do **not** broaden to every HOA Owner.
3. Board electronic pay explicitly out of scope (even if board can view invoice).
4. Eligibility API remains available to actors who can already `getVendorInvoiceById`; execute adds assignee-only check.

---

## 11. API surface

### New routes (`payload.routes.js` + privileges)

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/payments/payload/vendor-invoices/:vendorInvoiceId/payins/validate` | Amount/PM/eligibility dry-run (no txn) |
| `POST` | `/api/v1/payments/payload/vendor-invoices/:vendorInvoiceId/payins/execute` | Create attempt + Payload payment |
| `GET` | `/api/v1/payments/payload/vendor-payins/:vendorPayinId` | Status poll / recovery |

Keep Phase 3:

| Method | Path |
| --- | --- |
| `GET` | `/api/v1/payments/payload/vendor-invoices/:vendorInvoiceId/pay-eligibility` |

Update eligibility when pay flag on: `electronicPayAvailable` / `electronicPayExecutable` reflect true readiness (still false if PA/bank/payer blockers).

### Request (execute) — proposed

```json
{
  "invoicePaymentAmount": 100.0,
  "paymentMethodLocalId": "<ObjectId>",
  "paymentAttemptId": "<uuid>"
}
```

### Response

Sanitized vendor payin + `duplicate` boolean; never echo secrets.

### Controllers / validators

- Extend `payload.controller.js`, `payload.validator.js`, `privileges/payments/payload.routes.js`.

---

## 12. Exact file inventory

### Backend — create

| File | Role |
| --- | --- |
| `.../model/payloadVendorPayin.model.js` | Attempt + txn persistence |
| `.../service/payloadVendorPayin.service.js` | validate / execute / get / webhook apply |
| `.../helpers/vendorInvoiceGatewayPayment.helper.js` (or under vendor-invoice) | Processing hold, settle, fail, reverse |
| `.../validators` additions | validate/execute schemas |
| `scripts/phase4-vendor-owner-payment-gates.js` | Sandbox + Atlas gates |
| `.../payloadVendorPayin*.node.test.js` | Unit tests |

### Backend — modify

| File | Change |
| --- | --- |
| `payload.routes.js` | New validate/execute/get routes |
| `payload.controller.js` | Handlers |
| `payload.validator.js` | Joi schemas |
| `privileges/payments/payload.routes.js` | Privilege entries |
| `payload.config.js` + env | `PAYLOAD_VENDOR_PAY_ENABLED` |
| `payloadVendorEligibility.service.js` | Executable flags when pay enabled |
| `payloadWebhook.service.js` | Dispatch to Vendor payin apply |
| `getPublicConfig` | Expose `vendorPayEnabled` |
| `vendorInvoice.service.js` | Optional activity kinds; collectable helper export |

### Backend — reuse unchanged (call into)

| File | Reuse |
| --- | --- |
| `payloadPayinSettlement.util.js` | Card/ACH settle predicates |
| `payloadPayinCharge.util.js` / client `createPaymentTransaction` | Charge body + API |
| `payloadVendorEligibility.service.js` | PA/bank readiness inputs |
| `payloadWebhook.middleware.js` | Auth |
| HOA `payloadPayin.service.js` | **Do not** call `executeInvoicePayin` for Vendor |

### Frontend — create / modify

| File | Change |
| --- | --- |
| `payloadApi.ts` | `validateVendorPayin`, `executeVendorPayin`, `getVendorPayin`; config `vendorPayEnabled` |
| `usePayloadMerchant.ts` / `payloadConfig` | `vendorPayEnabled` |
| New: `ownerVendorPayloadPayExecution.ts` (or similar) | Vendor execute client (not HOA allocate) |
| New or adapted pay dialog for Vendor invoices | Amount → method → confirm → poll; **not** HOA `OwnerPaymentDialog` wired to HOA execute |
| `VendorInvoiceDetailPage.tsx` / `VendorInvoicesInboxPage.tsx` | Ungate when `vendorMerchantEnabled && vendorPayEnabled`; keep Record Payment |
| Gate tests | Update truth table for pay flag |

### Docs — create after implementation

| File | Role |
| --- | --- |
| `docs/phase4-vendor-owner-payment-engine.md` | Implemented behavior |
| `docs/phase4-vendor-owner-payment-results.json` | Gate raw results |
| `docs/phase4-vendor-owner-payment-report.md` | Completion report |

---

## 13. UI behavior

1. If merchant on and pay **off**: keep Phase 3 “Online payment coming soon”.
2. If both on: show **Pay Invoice** for assignee Owner only (board still Record Payment only in Phase 4).
3. Flow: eligibility fetch → validate → select Owner PM → execute with `paymentAttemptId` → poll payin / rely on webhook → refresh invoice.
4. Manual Record Payment unchanged for Vendor/Board.
5. Do not mount HOA `OwnerPaymentDialog` against Vendor invoice ids.

---

## 14. Failure, retry, return / reversal

| Case | Handling |
| --- | --- |
| Payload decline on execute | Mark payin FAILED; no settle; invoice hold released |
| Network timeout after charge | Same attempt id retry; duplicate-safe |
| ACH return / funding reversed | Webhook → `fail` or `reverse` per settlement util |
| Card authorized then reject | Reverse if already settled |
| Partial then second pay | New attempt id; balance re-check |
| Manual pay races electronic | Collectable includes holds |

---

## 15. Sandbox verification gates (mandatory)

Script: `scripts/phase4-vendor-owner-payment-gates.js`

| Gate | Assert |
| --- | --- |
| CONFIG | Payload sandbox + `VENDOR_MERCHANT` + `VENDOR_PAY` on |
| ATLAS_CONNECT | Mongo Atlas (IPv4 `family: 4`) |
| FIXTURES | Vendor ACTIVE PA + default bank; Owner customer + PM; VendorInvoice assigned to Owner |
| ELIGIBILITY_EXECUTABLE | Pay eligibility `electronicPayExecutable=true` when ready |
| EXECUTE_CARD_OR_ACH | Real `POST /transactions` Owner→Vendor shape; persist `PayloadVendorPayin` |
| IDEMPOTENCY_PRIMARY | Same `paymentAttemptId` → duplicate true, single settlement |
| DUPLICATE_ATTEMPT_SECONDARY | Replay / forced duplicate → safe no-op after local lookup |
| CARD_OR_ACH_LIFECYCLE | Status mapping matches settlement util |
| SETTLE_PREDICATE | VendorInvoice `amountPaid` changes **only** after settle action |
| CONCURRENCY | Second overlapping execute rejected or capped |
| WEBHOOK_APPLY | Simulated/authenticated webhook path re-fetches and settles/fails correctly |
| CROSS_VENDOR_ISOLATION | Cannot charge Vendor A bank onto Vendor B invoice |
| AUTH_ASSIGNEE_ONLY | Non-assignee Owner 403 |
| ZERO_BOARD_PATH | No Board customer charge created |
| MANUAL_RECORD_COEXIST | Record Payment still updates invoice when no conflict |
| CLEANUP | Mark fixtures; optional delete |

---

## 16. Atlas / database verification

| Check | Assert |
| --- | --- |
| `payloadvendorpayins` | Row with real `transactionId`, Vendor `merchantId`, Owner PM, `vendorInvoiceId` |
| Indexes | Unique idempotency; sparse txn id |
| VendorInvoice | Status/`amountPaid` match settle outcome |
| No HOA `payloadpayins` row | Vendor execute must not write HOA Invoice payins |
| No HOA bank mutation | HOA deposit methods unchanged |
| Webhook events | Dedupe rows for Vendor txn events when exercised |

---

## 17. Regression gates

| Suite | Command / focus |
| --- | --- |
| Phase 1 Vendor merchant | `payloadMerchant.vendor.node.test.js` |
| Phase 2 deposit banks | `payloadDepositMethod.vendor.node.test.js` |
| Phase 3 eligibility | `payloadVendorEligibility.node.test.js` + eligibility gates (executable flags updated carefully) |
| HOA Owner → HOA payin | `payloadPayinCharge.node.test.js` + existing payin unit tests; smoke execute path unchanged |
| Autopay / Check21 | No file changes expected; run existing suites if touched indirectly |
| UI gate | Updated gate tests for pay flag |

---

## 18. Rollback strategy

1. **Flag off:** `PAYLOAD_VENDOR_PAY_ENABLED=false` → execute routes 403; UI returns to Phase 3 coming-soon; merchant/banks/eligibility remain.
2. **Leave data:** `PayloadVendorPayin` rows retained for audit; no automatic destructive cleanup in prod.
3. **In-flight Processing:** Ops run reconcile/fail tooling; manual Record Payment available for settlement outside gateway.
4. **Code rollback:** Revert execute routes + UI ungating; webhook dispatch should no-op if no Vendor payin match (safe).
5. **Do not** roll back Phase 1–3 merchant/bank data as part of pay rollback.

---

## 19. Production-readiness gates (beyond Phase 4 sandbox COMPLETE)

**Sandbox Phase 4 COMPLETE does NOT mean production-ready.**

Keep `PAYLOAD_VENDOR_PAY_ENABLED=false` in production until **all** of the following are separately verified:

| Gate | Requirement |
| --- | --- |
| Live Vendor webhook delivery | Events reach PropMV webhook URL for Vendor payments |
| Webhook authentication | Signature and/or bearer mechanism verified |
| Secret-key transaction re-fetch | `GET /transactions/{id}` with secret key before mutate |
| Card settlement predicate | Live card statuses match util settle/fail/reverse |
| ACH success/return lifecycle | ACH remains pending until util settle; returns reverse/fail correctly |
| Duplicate webhook idempotency | Replay does not double-settle |
| Transaction recovery | Timeout/crash recovery via same attempt id + webhook/re-fetch |
| Production Vendor PA ACTIVE | Live underwriting; PropMV ACTIVE |
| Monitoring | Failed / stuck Processing alerts |

Do not enable the pay flag in production on sandbox green alone.

---

## 20. Implementation sequence (after approval only)

1. Model + config flag + eligibility executable wiring  
2. Validate/execute/get services + routes (no UI)  
3. VendorInvoice settlement helpers + concurrency  
4. Webhook dispatch branch  
5. Unit tests  
6. Sandbox/Atlas gates script  
7. Frontend Vendor pay flow + ungating  
8. Regressions (HOA payin, Phase 1–3)  
9. Docs + report  
10. **Stop** — Board→Vendor and treasury remain future phases  

---

## 21. Locked decisions (resolved)

1. **Partials:** Supported (existing VendorInvoice). Atomic collectable inequality enforced.  
2. **Fees:** Invoice amount only; no HOA fee reuse; fee = 0.  
3. **Expense reverse:** On gateway reverse, decrement `amountPaid` / reopen balance; expense link left as-is unless expense was created solely from this payin and can be safely voided — prefer timeline note + leave expense for ops if ambiguous (no silent delete).  
4. **Board UI:** Hide electronic Pay for non-assignees; board keeps Record Payment only.  
5. **Model:** New `PayloadVendorPayin` collection (not polymorphic HOA `PayloadPayin`).

---

## 22. Approval checklist

- [x] Architecture: Assigned Owner → Vendor PA → default bank → payment → verified status → VendorInvoice  
- [x] Hard prohibitions accepted  
- [x] `PAYLOAD_VENDOR_PAY_ENABLED` accepted  
- [x] `PayloadVendorPayin` accepted  
- [x] Assignee-only electronic auth accepted  
- [x] Board→Vendor deferred  
- [x] Mandatory corrections (§ locked decisions) incorporated  

**Implementation proceeds under this corrected plan. Stop after Phase 4.**
