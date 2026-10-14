# Phase 5 Plan — Board Member → Vendor Electronic Payment (Tightened)

**Status:** **IMPLEMENTED — Sandbox COMPLETE (2026-10-09)** — see `phase5-board-vendor-payment-report.md`  
**Prior status:** PLAN ONLY — approved and implemented  

**Architecture (approved in principle):** Board Customer → Board send-capable PM → Payload `type=payment` → Vendor PA → Vendor default deposit bank → existing Vendor payin/webhook/settlement engine → VendorInvoice  
**Depends on:** Phase 4 Owner→Vendor engine (Sandbox functionally complete)  
**Environment:** Sandbox E2E only  
**Flags:** Keep `PAYLOAD_VENDOR_PAY_ENABLED=false` as committed/default in all environments. Sandbox gate runners may set the flag **in-process only**. **No production deploy, canary, or live production payments.**

---

## 1. Goal

Enable **HOA Board Member → VendorInvoice** electronic payment in Sandbox using the **same customer-payment model** as Phase 4 Owner→Vendor, without using HOA Processing Account, HOA merchant bank, Payload credit, HOA Treasury, or HOA two-way banks as charge destination.

```text
Board Member
  → Board Payload Customer (send-capable; HOA scope key is wallet/Customer scope only)
  → Board send-capable ACH/Card Payment Method (already exists before execute)
  → Payload type=payment
  → processing_id = Vendor Payload Processing Account
  → processing_method_id = Vendor default deposit bank only
  → webhook / status + resolvePayloadPayinSettlementAction
  → VendorInvoice settlement (+ existing ledger/HoaExpense path)
```

---

## 2. Board Customer / HOA merchant separation (mandatory)

### 2.1 Scope reuse vs charge merchant

Reusing `ensurePayloadUserContext` with `entityType=hoa` and `billableMerchantId=hoa:{hoaId}` is **only** a Customer/wallet scope key (and may set Customer `primary_processing_id` to an HOA billable merchant for Payload Customer hosting — same as Owner wallet).

**That must never become the charge merchant.**

| Field | Meaning | Allowed value for Board→Vendor |
| --- | --- | --- |
| `billableMerchantId` / Customer scope | Local PropMV wallet partition | `hoa:{hoaId}` |
| Customer `primary_processing_id` | Payload Customer hosting only | May be HOA PA (wallet) |
| Charge `processing_id` | Who receives the payment | **Vendor** `acct_…` only |
| Charge `processing_method_id` | Deposit destination | **Vendor** default deposit `pm_…` only |

### 2.2 Hard asserts on every Board→Vendor execute (server)

Before calling Payload `createPaymentTransaction`, and again when persisting the attempt, assert:

1. `customer_id` / local `PayloadUser.userId` === Board actor `userId`
2. Local PM `userId` === Board actor `userId` (and HOA-scoped to invoice HOA)
3. `processing_id` === Vendor ACTIVE Processing Account `merchantId`
4. `processing_method_id` === Vendor **default** deposit bank `depositMethodId`
5. `processing_id` **≠** any HOA Processing Account id for that community
6. `processing_method_id` **≠** any HOA merchant/deposit bank `pm_…` for that community

Failure → reject charge (`4xx`), do not create a Payload payment.

### 2.3 Automated Sandbox assertions (not logs-only)

Gate script(s) must **fail the run** unless:

- Persisted `PayloadVendorPayin.merchantId` === Vendor PA id  
- Persisted `destinationDepositMethodId` === Vendor default bank id  
- Charge body / stored raw txn `processing_id` / `processing_method_id` match Vendor ids  
- Explicit inequality checks against resolved HOA merchant id(s) and HOA bank `pm_…` list for the invoice HOA  
- `payerUserId` === Board user id; PM ownership matches  

Same HOA-not-used asserts remain on Owner→Vendor regression.

---

## 3. Audit findings (read-only) — Customer / PM / auth

### 3.1 Board Payload Customer today

**No product send-only path.** Board Settings expose HOA merchant / deposit banks only. Models already allow Board `userId` + `hoa:{hoaId}` `PayloadUser` / PMs. API community access already allows Board via `HOAMembership`; UI does not onboard Board payer instruments.

### 3.2 Smallest correct Customer model

One Payload Customer / `PayloadUser` per `(boardUserId, hoa:{hoaId})` via existing `ensurePayloadUserContext` — **no second stack**, no shared “HOA Board” Customer, no duplicate Customer for the same user+scope.

### 3.3 Existing VendorInvoice authorization (evidence)

| Action | Who (code today) |
| --- | --- |
| **View** | Vendor **or** assignee Owner **or** `hoaContext.isHOABoardMember` with invoice `hoaId` match (`getVendorInvoiceById`) |
| **Update / Record Payment** | Vendor **or** HOA Board (`updateVendorInvoice`) — **not** assignee Owner |
| **Phase 4 electronic pay** | Assignee Owner only (`assertAssigneeOnly` → `VENDOR_PAY_ASSIGNEE_ONLY`) |

**Intended Phase 5 electronic-pay business rule (aligned to existing product, not broadened):**

Electronic pay is allowed if **either**:

1. **Assigned Owner path (unchanged):** actor === `invoice.assignedTo`, or  
2. **Board path (new, mirrors Record Payment):** `hoaContext.isHOABoardMember === true` **and** invoice `hoaId` matches `hoaContext.hoaId` (same match as view/update).

| Actor | Electronic pay |
| --- | --- |
| Assigned Owner | Allowed (Phase 4) |
| Non-assignee Owner | **Denied** |
| Board of invoice’s HOA | Allowed (Phase 5) |
| Board of wrong HOA | **Denied** (404/403 via existing HOA match) |
| Vendor / unauthorized | **Denied** for electronic pay |
| Unauthenticated / no membership | **Denied** |

Do **not** authorize “any Board Member anywhere” or “any HOA Owner.” Do **not** grant Board electronic pay without the same HOA membership + invoice HOA match already required for Board Record Payment.

---

## 4. Board payment-method onboarding (exact first-time flow)

### 4.1 Principle

**Pay Invoice must never silently create a Customer or payment instrument.**  
Customer/PM creation is explicit via Board Settings (reused Owner payer panel), idempotent under `(userId, hoa scope)`.

### 4.2 First-time Board flow

```text
1. Board login (HOA-scoped session / hoaContext)
2. Board Settings → “Payer payment methods” (send-only; NOT HOA merchant banks page)
3. User opens reused PayloadPaymentMethodsPanel (entityType=hoa, entityId=activeHoaId)
4. Explicit initialize/ensure Customer (ensurePayloadUserContext — idempotent)
5. User explicitly adds ACH and/or Card → saved PayloadPaymentMethod
6. Board opens Vendor Invoice → Pay Invoice
7. Eligibility shows ready only if usable Board PM exists
8. User selects existing PM → validate → execute (no PM create on execute)
```

### 4.3 Pay Invoice when no usable PM

- Eligibility / dialog: clear prerequisite, e.g. **“Add a payment method in Settings before paying.”**  
- CTA may deep-link to Board payer Settings.  
- Execute/validate reject if no eligible PM (`OWNER_PM_*` / Board-equivalent codes).  
- **No** auto-create Customer/PM inside validate/execute.

### 4.4 Onboarding test cases (mandatory)

| Case | Expect |
| --- | --- |
| **A. Existing Board Customer/PM** | Pay Invoice lists PMs; charge succeeds without Settings step |
| **B. First-time Board (no Customer/PM)** | Settings onboarding creates Customer+PM; then Pay Invoice works; Pay without setup blocked with clear prerequisite |

---

## 5. Target architecture

```text
[Board Member User]
    PayloadUser (userId=board, billableMerchantId=hoa:{hoaId})  ← wallet scope only
    Payload Customer (send-capable; primary_processing_id may be HOA for hosting only)
    Payment Method pm_… — must already exist before execute
        ↓
POST type=payment
  customer_id          = Board Customer (server-resolved)
  payment_method_id    = Board PM (server-resolved)
  processing_id        = Vendor acct_…                 ← NEVER HOA
  processing_method_id = Vendor default deposit pm_…   ← NEVER HOA bank
        ↓
PayloadVendorPayin (payerUserId=board, payerRole=board)
        ↓
Webhook re-fetch → resolvePayloadPayinSettlementAction → settle/fail/reverse
        ↓
VendorInvoice + ledger/HoaExpense (existing helpers)
```

---

## 6. Idempotency lifecycle (`paymentAttemptId`)

### 6.1 Generation (client)

On **each intentional Pay submit** (user confirms Pay in `VendorInvoicePayDialog`):

1. Generate a new `paymentAttemptId` = `crypto.randomUUID()` (fallback `vp_${Date.now()}_…`).  
2. Store it in a submit-scoped ref/state for **that attempt only**.  
3. Call validate, then execute with that id.

**Do not** generate a new id on automatic network retry of the same user action.

### 6.2 Persistence (server)

```text
idempotencyKey = sha256(payerUserId | vendorInvoiceId | paymentAttemptId | vendor_payin)
```

- Persist `PayloadVendorPayin` with `paymentAttemptId` + unique `idempotencyKey` **before** Payload charge when possible.  
- Payload `Idempotency-Key` = secondary (`${idempotencyKey}_vendor_payin`).  
- Seed includes `userId` → Owner and Board attempts do not collide.

### 6.3 Reuse on retry vs regenerate

| Scenario | Client `paymentAttemptId` | Expected result |
| --- | --- | --- |
| Network timeout + retry of same submit | **Same** id | One payment / one row (`duplicate: true` if already charged) |
| Duplicate request (double-click / replay) | **Same** id | One payment |
| Legitimate second payment (partial #2, new Pay) | **New** id | New payment (after collectable check) |
| Duplicate webhook | n/a | Settlement util + `settledAt` → **no** double settle |

### 6.4 FE gap to close in Phase 5 (Owner + Board)

Current dialog generates UUID per click but does not pin it across timeout retries. Implementation must:

- Pin attempt id for in-flight submit retries.  
- Clear / regenerate only after terminal success, user cancel, or user starts a **new** Pay action.  
- Prove timeout+retry in Sandbox gates (service-level and/or dialog contract tests).

### 6.5 Webhook duplicate settlement

Settlement only via `resolvePayloadPayinSettlementAction`.  
`applyVendorPayinSettlement` no-ops if `doc.settledAt` set. Duplicate webhook → no duplicate books.

---

## 7. Partial / concurrency invariant (Owner + Board + Manual)

### 7.1 Single invariant

```text
amountPaid + inFlightElectronic + newPayment <= current collectible balance
```

where `current collectible balance` = invoice `subAmount` (existing Phase 4 rule).

`inFlightElectronic` = sum of unsettled `PayloadVendorPayin` amounts in in-flight statuses for that invoice (**all payers** — Owner and Board share the hold pool).

### 7.2 When enforced

| Path | Enforcement |
| --- | --- |
| Owner electronic execute | `assertCollectableAllowsPayment` (reuse) |
| Board electronic execute | Same function |
| Manual Record Payment (`updateVendorInvoice` amountPaid increase) | **Must** apply the same invariant against electronic in-flight (gap today — close in Phase 5) |
| Immediately before settlement | Server re-check in `settleVendorInvoiceGatewayPayment`: `amountPaid + settlingAmount <= subAmount` (already present); reject `VENDOR_INVOICE_OVERPAY` without double-apply |

Note: At settle time, the settling payin’s amount is moving from in-flight → paid; the settle ceiling is `amountPaid + settlingAmount <= subAmount` (do not double-count that payin as both in-flight and new paid).

### 7.3 Mandatory concurrency tests

- Owner + Board concurrent electronic payment  
- Board + Manual Record Payment race  
- Owner + Manual Record Payment race  
- Two Board attempts (same / different attempt ids)  
- Overpayment rejection (execute and settle)

---

## 8. Data model / API / files

### 8.1 Data model

| Change | Detail |
| --- | --- |
| `PayloadVendorPayin` | Optional `payerRole`: `'owner' \| 'board'` (default `'owner'`) |
| `PayloadUser` / PM / VendorInvoice | **No** schema change |
| New collections | **None** |

### 8.2 API

Same routes; widen server auth only:

| Endpoint | Change |
| --- | --- |
| validate / execute / get Vendor payin | Assignee **or** Board of invoice HOA |
| pay-eligibility | Board payer readiness; `boardCustomerStrategy` → `active_reuse_hoa_scoped_wallet`; clear `PAYER_PM_REQUIRED` (or equivalent) when Board has no usable PM |
| PM initialize/list/register | Confirm Board Settings path; **idempotent** Customer ensure; execute still never creates PMs |

Request body unchanged: `invoicePaymentAmount`, `paymentMethodLocalId`, `paymentAttemptId`.

**Flag:** Same `PAYLOAD_VENDOR_PAY_ENABLED` (no new Board flag by default).

### 8.3 Exact files to change

**Backend (`propmv`)**

| File | Change |
| --- | --- |
| `payloadVendorPayin.service.js` | `assertVendorPayPayerAuthorized`; HOA≠Vendor charge asserts; Board PM loader rename; `payerRole`; pin settlement pre-check |
| `payloadVendorEligibility.service.js` | Board readiness + strategy graduation + PM prerequisite codes |
| `payloadPaymentMethod.service.js` | Board Settings initialize messaging; reuse `ensurePayloadUserContext` |
| `payloadVendorPayin.model.js` | `payerRole` |
| `vendorInvoice.service.js` | Manual Record Payment respects electronic in-flight collectable invariant |
| `vendorInvoiceGatewayPayment.helper.js` | Keep final settle overpay guard; Board payer labels optional |
| Controllers/routes/validators/privileges | Document Board auth; no new routes preferred |
| Gate scripts | `phase5-board-vendor-payment-gates.js` (+ Owner regression) |
| Unit tests | Auth matrix, HOA-not-used, concurrency, idempotency |

**Frontend (`innago-inspired-refresh`)**

| File | Change |
| --- | --- |
| Board Settings + `settingsConfig` / role settings | Payer PM page (reuse `PayloadPaymentMethodsPanel`, `entityType=hoa`) — separate from HOA merchant banks |
| `VendorInvoicePayDialog.tsx` | Attempt-id pin on retry; Board prerequisite copy when no PM |
| `VendorInvoicesInboxPage.tsx` / `VendorInvoiceDetailPage.tsx` | Unlock Board electronic Pay when flag on; keep Record Payment; Owner path unchanged |
| `ensureOwnerHasPayInstrument` (or Board twin) | Board prerequisite navigation to Settings |

**Webhook:** `payloadWebhook.service.js` — no structural change (Vendor payin first).

---

## 9. UI changes (Sandbox)

1. Board Settings: send-only **Payer payment methods** (explicit create).  
2. Vendor invoice UI: Board sees **Pay Invoice** when flag on + eligibility executable; otherwise clear prerequisite.  
3. Preserve Board **Record Payment**.  
4. Never route Board→Vendor through HOA `OwnerPaymentDialog` / HOA executePayin.  
5. Owner Phase 4 UI behavior preserved (+ attempt-id retry pin).

---

## 10. Sandbox E2E test matrix

### 10.1 Minimum Board E2E (first-time setup required)

Do **not** only test a pre-seeded Board Customer.

```text
Board login
  → Board payer payment-method setup (Settings)
  → ACH and/or Card saved
  → Vendor Invoice
  → Pay Invoice
  → Payload transaction
  → webhook/status
  → VendorInvoice settlement
  → ledger / HoaExpense behavior
```

Also run case **A** (pre-existing Board Customer/PM) for fast regression.

### 10.2 Board→Vendor matrix

| Case | ACH | Card |
| --- | --- | --- |
| First-time Customer/PM setup then pay | ✓ | ✓ |
| Existing Customer/PM pay | ✓ | ✓ |
| Full payment | ✓ | ✓ |
| Partial (if rules allow) | ✓ | ✓ |
| Timeout + retry same `paymentAttemptId` → one payment | ✓ | ✓ |
| Duplicate request → one payment | ✓ | ✓ |
| Legitimate second payment (new attempt id) | ✓ | ✓ |
| Duplicate webhook → no duplicate settlement | ✓ | ✓ |
| Failed / declined | ✓ | ✓ |
| Overpay rejected | ✓ | ✓ |
| Concurrent / race cases (§7.3) | ✓ | ✓ |
| Vendor PA + default bank only | ✓ | ✓ |
| Correct settlement + expense | ✓ | ✓ |
| Automated HOA-not-used asserts (§2.3) | ✓ | ✓ |
| Auth: non-assignee Owner / wrong-HOA Board / unauthorized denied | ✓ | ✓ |

### 10.3 Owner→Vendor regression (required)

Equivalent Phase 4 matrix (ACH/Card, full/partial, idempotency, webhook, fail, overpay, concurrency, manual race, Vendor PA/bank, settlement, HOA-not-used).

---

## 11. Regression matrix

| Suite | Expect |
| --- | --- |
| Phase 1–3 Vendor merchant/bank/eligibility | PASS |
| Phase 4 Owner→Vendor unit + sandbox gates | PASS |
| HOA Owner→HOA payin helpers | PASS |
| Manual Record Payment (+ new in-flight guard) | PASS |
| Autopay / Check21 / Rainforest / Straddle | Untouched |
| HOA Primary / receive-only / treasury / credit | Untouched |

---

## 12. Production-readiness (architecture only; phase remains Sandbox)

Implement with the same Phase 4 patterns:

- Server-side resolution of Customer / PM / Vendor PA / default bank  
- PropMV idempotency primary + Payload secondary  
- Webhook re-fetch + `resolvePayloadPayinSettlementAction` sole settlement authority  
- Recovery via same `paymentAttemptId`  
- Shared concurrency invariant  
- Auditability (`payerRole`, `payerUserId`, merchant/bank ids on attempt)

**Out of Phase 5:** production deploy, production canary, persistent flag enablement, live production payments.  
Phase 4 production gap (routes missing on `origin/production`) remains a **separate** track.

---

## 13. Migration / rollback

| Step | Action |
| --- | --- |
| Forward | Ship code with flag default false; Board wallet optional until Sandbox gates set flag in-process |
| Rollback | Flag off → electronic Pay gated; Record Payment remains; no data deletion |
| Data | Board `PayloadUser`/PMs retained safely |

---

## 14. Explicit no-touch / out of scope

- HOA Processing Account as Vendor payment merchant  
- HOA Treasury / Credit / `default_credit_method`  
- HOA receive-only → two-way migration  
- HOA Primary / routing / `default_deposit_method` semantics for HOA  
- HOA Owner → HOA dues  
- Autopay, Check21, Rainforest, Straddle, Vendor Straddle migration  
- Production deployment / canary / live production payments  
- Silent PM/Customer creation on Pay Invoice  

---

## 15. Risks

| Risk | Mitigation |
| --- | --- |
| Wallet scope confused with charge merchant | Server asserts + automated Sandbox inequalities |
| Board merchant banks vs payer wallet UX | Separate Settings entry; explicit copy |
| Silent instrument create | Forbidden on execute; eligibility prerequisite |
| Auth over-broadening | Mirror Record Payment + assignee only; deny matrix in gates |
| Attempt id regenerated on retry | Pin id in dialog; gate timeout+retry |
| Manual vs electronic overpay | Shared invariant on Record Payment + settle guard |
| Concurrent Owner+Board | Shared in-flight sum |

---

## 16. Implementation sequence (after approval only)

1. Board payer Settings onboarding (idempotent Customer/PM) + prerequisite UX.  
2. Auth widen + HOA≠Vendor charge asserts + `payerRole`.  
3. Shared collectable invariant on Manual Record Payment; settle pre-check confirmed.  
4. FE: Board Pay unlock + attempt-id pin on retry.  
5. Unit tests (auth, separation, concurrency, idempotency).  
6. Sandbox gates: first-time Board E2E + existing Board PM + Owner regression + HOA-not-used asserts.  
7. Docs/report.  
8. **Stop** — no production enablement.

---

## 17. GO / NO-GO approval gate (this tightened plan)

Approve implementation only if reviewers accept:

- [ ] Customer-payment model; HOA PA/bank never charge destination  
- [ ] Automated Sandbox asserts for Board Customer/PM ownership + Vendor-only `processing_*` + HOA inequalities  
- [ ] Explicit first-time Board Settings onboarding; Pay never silent-creates instruments  
- [ ] Auth = assignee Owner **or** Board of invoice’s HOA (mirrors Record Payment); non-assignee Owner / wrong-HOA / unauthorized denied  
- [ ] Documented `paymentAttemptId` lifecycle + timeout retry = one payment  
- [ ] Shared collectable invariant across Owner, Board, Manual + settle-time check  
- [ ] Sandbox E2E includes first-time Board setup path + Owner regression  
- [ ] No-touch / production-out-of-scope list accepted  
- [ ] Flag defaults remain false; Sandbox in-process only  

**Do not modify code until this tightened plan is explicitly approved.**
