# Roadmap: Production Check21 (HOA Board Record Payment)

**Status:** Implementation in progress behind flags (default **off**). Staging/prod enablement still blocked by hard gates until real-check OCR lifecycle confirms §6.1.  
**Primary Payload docs:** [Check Payments (v2)](https://docs.payload.com/v2/pay/alternative-payments/check-payments)  
**Related:** [Chargebacks and Rejects](https://docs.payload.com/apis/chargebacks-and-rejects/), [Webhook triggers](https://docs.payload.com/apis/webhooks/triggers/), PropMV `docs/existing-architecture.md`, `docs/PAYLOAD_FOUNDATION.md`, `docs/roadmap-autopay.md`

### Final hard gates (blocking staging/production enablement)

1. **Do not enable `PAYLOAD_CHECK21_ENABLED` / `VITE_PAYLOAD_CHECK21_ENABLED` in staging or production** until the sandbox verification proves and this roadmap records the **exact Check21 settlement predicate** (§4.1 spike table + §6.1 predicate matrix): Payload `status`, `funding_status`/deposit, webhook/event, settle vs processing vs failure vs post-settlement return.
2. **Collectable balance invariant:** `allocated + in-flight processing amounts` must never exceed the invoice’s current collectable balance. Final enforcement is inside the **authoritative settlement path** (in addition to submit-time gates), with automated tests.
3. **Webhook security:** **No secrets in query-string URLs.** Prefer Payload-supported authentication/signatures when available. Otherwise use a protected webhook endpoint plus **mandatory server-side Payload transaction re-fetch and validation** before any invoice/ledger mutation. Body-alone settle is forbidden and tested.

**Approval gate:** Implement behind flags (default off) only after Agent mode approval. **Production/staging flag enablement** only after gates 1–3 are verified and covered by automated tests.

---

## 1. Current architecture audit

### 1.1 Check21 (production path)

Board **Record Payment → Upload Check (Check21)** (flag-gated):

- Frontend: `RecordPaymentDialog` + `Check21ImageUpload` widget
- Backend: `POST /payments/payload/check21/submit-for-invoice`
- Persists `PayloadPayin` (`methodType=CHECK21`) + invoice processing row; settles via webhooks/reconciliation
- Settings demo (`check21-demo`) **removed**

Reusable pieces: image validation / multipart form builder (`payloadCheck21.util.js`), `PayloadClient.createCheck21PaymentTransaction`, Check21-specific error mapping.

### 1.2 Board Record Payment (today)

- UI: `RecordPaymentDialog` (Income list + invoice detail)
- Methods: Cash, **Check** (offline check **number** only), Money Order, Other — from master data
- API: `PUT /api/v1/hoa/invoice/:id` with `paymentAmount` → `prepareInvoicePayment` → immediate `paymentTransactions` (`isManual`) + `ledger.service.recordPayment` + status Paid/Partial
- **Synchronous bookkeeping** — not suitable for Check21 submit-as-paid

### 1.3 Owner / Board invoice visibility

- Shared invoice `status`, `balanceDue`, `paymentTransactions`, `processingAmount`
- Owner pays Card/ACH via `OwnerPaymentDialog` → `executeInvoicePayin`
- Board and Owner both reflect Processing/Paid from the same invoice document

### 1.4 Payload Card / ACH (today)

- `executeInvoicePayin` → `PayloadPayin` → processing invoice row → webhooks → `applyPayloadPayinLifecycle`
- **Card:** may settle on PROCESSING  
- **ACH:** never settle on execute; settle on `processed` / local SUCCEEDED via `resolvePayloadPayinSettlementAction`
- Lifecycle UI can still show **DEPOSIT** while `funding_status` is pending after `processed` (`payloadPayinLifecycle.util.js`)

### 1.5 Webhooks (today)

- `POST /api/webhooks/payload`
- Idempotent `PayloadWebhookEvent` (unique event id)
- **No documented inbound HMAC**; middleware ignores `PAYLOAD_WEBHOOK_SECRET` and relies on **API re-fetch** before mutating invoices
- Triggers used: payment, automatic_payment, processed, authorized, decline, void, reject, refund, processing_status

### 1.6 Autopay

- Separate enrollment + invoice mirror path — **must not be modified** for Check21 v1

---

## 2. Existing Record Payment flow

```text
Board opens invoice → Record Payment
  → select Cash | Check | Money Order | Other
  → (Check) enter checkNumber
  → PUT /hoa/invoice/:id { paymentAmount, paymentMethod, … }
  → prepareInvoicePayment / processInvoiceOverpayment
  → paymentTransactions completed + ledger payment + status update
```

Gates while electronic gateway processing exists: `assertManualRecordPaymentAllowed`.

---

## 3. Existing Payload integration / webhook architecture

| Concern | Mechanism |
|---------|-----------|
| Charge create | `PayloadClient.createPaymentTransaction` JSON (Card/ACH) |
| Local money attempt | `PayloadPayin` + unique `idempotencyKey` |
| Invoice processing | `ensureGatewayProcessingPaymentRecorded` |
| Settle | `settleInvoiceGatewayPayment` + ledger `source: gateway_webhook` |
| Fail pre-settle | `failInvoiceGatewayPayment` (no ledger payment) |
| Refund / reverse | `reverseInvoiceGatewayPayment` — keeps original tx, adds `refundedAmount` + ledger adjustment |
| Webhook trust | Re-fetch txn with secret key; event idempotency |
| Reconciliation | Ops reconciliation util + webhook retry |

---

## 4. Payload Check21 API flow

### 4.1 Docs vs live sandbox (critical)

**Documented (v2 Check Payments):**

```js
Transaction.create({
  type: 'payment',
  source: 'check',
  amount,
  receiver: { account_id: 'acct_…' },
  check_images: {
    front: { file: { data_uri } },
    back: { file: { data_uri } },
  },
  order_number, description, attrs,
})
```

**Live sandbox (demo spike probe):** rejects `receiver` and `check_images` as `InvalidAttributes`. Accepts multipart:

- `type=payment`, `source=check`, `amount`, `processing_id=acct_…`
- `check_front[file]`, `check_back[file]` (binary)

**Pre-impl spike (recorded 2026-10-02, sandbox `Payload-Version: v2`, acct_3fQuklYZXM5IDKAqsibB2):**

| Probe | Result | Date |
|-------|--------|------|
| Docs JSON `receiver` + `check_images` data URIs | **400 InvalidAttributes** — fields not accepted on live API | 2026-10-02 |
| Multipart `processing_id` + `check_front[file]` / `check_back[file]` | **Fields accepted**; OCR returns **400** “Invalid or unreadable check image” on synthetic JPEG fixtures (no successful Check21 txn id from fake images) | 2026-10-02 |
| Required vs optional `amount` | Multipart accepts with amount; production path always sends **server-validated** amount | 2026-10-02 |
| `order_number` | Sent on multipart when provided (≤64); used as merchant reference — **not** PropMV idempotencyKey | 2026-10-02 |
| Success `status` + `funding_status` | **Not observed on Check21** (OCR blocked). Analog: recent sandbox `status=processed` payments show `funding_status=batched` (not bank-cleared deposit). | 2026-10-02 |
| `deposit` / funding webhooks | Same Payload trigger set as Card/ACH (`processed`, `reject`, …). No separate Check21-only deposit trigger documented; PropMV continues to re-fetch txn before mutate. | 2026-10-02 |

**Default wire format:** multipart; map docs `receiver.account_id` → `processing_id`. Optional docs-JSON adapter behind `PAYLOAD_CHECK21_DOCS_JSON` flag (default off) if Payload enables fields later.

**OCR gate:** Staging/prod flag enablement still requires at least one **real check image** sandbox success + observed lifecycle for §6.1 confirmation.

### 4.2 Docs semantics to preserve

- `type: payment`, `source: check`
- Invoice amount (server-authoritative)
- Processing account receiving funds
- Front + back images (JPG/PNG/PDF, &lt;10MB, clear/readable; ~300 DPI recommended)
- `attrs` for invoice/reference linkage
- Duplicate protection via Payload `order_number` (separate from PropMV idempotency — §12)

### 4.3 Returns

Payload: bank rejects / returns can move `processed` → `rejected` days/weeks later; register `reject` webhook; funds reversed ([chargebacks-and-rejects](https://docs.payload.com/apis/chargebacks-and-rejects/)).

---

## 5. Proposed PropMV Check21 architecture

**Surface:** Board Record Payment → **Upload Check (Check21)** (not Settings demo).

**Spine:** New submit service → **`PayloadPayin`** (`methodType` CHECK/CHECK21, ACH-like) → processing invoice row → existing webhook lifecycle → settle/fail/reverse.

**Not:** synchronous invoice PUT on submit; not Autopay; not demo collection as source of truth.

```text
Record Payment → Upload Check
  → POST /payments/payload/check21/submit-for-invoice (multipart)
  → server validates images + derives/validates amount
  → concurrency claim + PayloadPayin (idempotencyKey)
  → Payload Check21 create (multipart)
  → invoice Processing (not Paid)
  → webhooks / reconciliation → settle | fail | non-destructive return
```

---

## 6. Invoice / payment status lifecycle

**Do not equate Payload `processed` with HOA bank deposit without §4.1 verification.**

### 6.1 Exact settlement predicate matrix (locked interim — confirm with real Check21 OCR)

| Outcome | Payload `status` | `funding_status` / deposit | Webhook / event | PropMV action |
|---------|------------------|----------------------------|-----------------|---------------|
| Processing / pending | `authorized` / `processing` (or local PROCESSING) | any / absent | `payment`, `authorized`, `processing` | Keep/create processing row; **no** ledger; invoice Processing |
| **Allow settle + ledger** | `processed` → local SUCCEEDED | **not** in `{pending, processing, reversed}` (absent / `batched` / `settled` / similar OK) | `processed` (after secret-key re-fetch) | `settleInvoiceGatewayPayment` + ledger **iff** collectable invariant holds |
| Hold (stricter than ACH) | `processed` | `pending` or `processing` | `processed` | **Do not** settle yet; keep processing / UI deposit; wait for funding advance or reconciler |
| Failure pre-settle | `declined` / `voided` / `rejected` before settle | any / `reversed` | `decline`, `void`, early `reject` | `failInvoiceGatewayPayment` |
| Post-settlement return | `rejected` after local SUCCEEDED / settledAt | `reversed` or reject trigger | `reject` | Non-destructive `reverseInvoiceGatewayPayment` (keep original payment) |

**Code lock:** `resolvePayloadPayinSettlementAction` + Check21 funding guard in `payloadPayinSettlement.util.js`. Card settle-on-PROCESSING unchanged. ACH settle-on-`processed` unchanged (ACH does **not** wait on funding pending).

| Business stage | Payload signals | PayloadPayin | paymentTransactions | Invoice | Ledger |
|----------------|-----------------|--------------|---------------------|---------|--------|
| Check submitted | authorized / processing | PROCESSING | processing | Processing | none |
| Clearing / funding pending | processed + funding pending/processing | PROCESSING (hold) | processing | Processing | none until settle rule |
| PropMV settled (Paid) | processed + funding not deferred | SUCCEEDED | completed | Paid / Partially Paid | `recordPayment` gateway_webhook |
| Failed pre-settle | decline / void / early reject | FAILED / CANCELED | failed | balance restored | none |
| Returned post-settle | reject / rejected / funding reversed | RETURNED | original completed **kept**; refundedAmount + reverse meta | balance reopened | ledger **adjustment** (non-destructive) |

**Interim settle policy (spike-locked):** Check21 fail paths ACH-like; settle is **stricter than ACH** when `funding_status` is deferred (`pending`/`processing`). Staging/prod enable still requires real-check confirmation of this matrix.

**Collectable balance invariant (required):**  
At submit claim **and** inside the authoritative settle path:  
`sum(completed allocated) + sum(in-flight processing including this Check21) <= collectableBalance`.  
Refuse settle if the invariant would break.

**State-transition guards (required):**

- CREATED → PROCESSING → SUCCEEDED | FAILED | CANCELED | IN_REVIEW
- SUCCEEDED → RETURNED only via reverse path
- Forbid regressive transitions (e.g. SUCCEEDED → PROCESSING); ignore stale out-of-order webhooks after re-fetch

---

## 7. Webhook / event mapping

| Trigger / signal | Action |
|------------------|--------|
| payment / authorized / processing | Update payin + lifecycle history; no ledger |
| processed | Re-fetch; apply settle predicate (+ funding if required) |
| decline / void | Fail processing row if not settled |
| reject | If not settled → fail; if settled → **non-destructive reverse** |
| deposit (if present) | Feed funding/settle predicate; do not invent parallel pipeline |

**Auth / security:**

- Never trust webhook body alone — always secret-key **re-fetch and validate** the transaction before settle/fail/reverse (existing trust model)
- **Forbidden:** secrets in webhook **query-string** URLs
- Prefer Payload-supported authentication/signatures when available/documented
- Otherwise: protect `/api/webhooks/payload` as an application endpoint (deploy network controls as available) + mandatory re-fetch
- Validate trigger shape; rate-limit webhook route
- Document residual risk: Payload does not document inbound HMAC for v2; re-fetch remains the trust boundary
- Idempotency: `PayloadWebhookEvent` unique event id
- Automated tests: forged/stale body without settle-eligible re-fetched txn must not settle or post ledger

---

## 8. Processing Account resolution

- Resolve entirely **server-side** from invoice property deposit routing / HOA `PayloadAccount.merchantId` (`acct_…`)
- Require ACTIVE (or existing billable/sandbox rules)
- Client `accountId` is optional **hint** only — must pass `assertPayloadMerchantAccess`, same HOA, valid `acct_` — else reject
- Never hardcode account ids; never trust client alone

---

## 9. Data model / reference changes

| Store | Change |
|-------|--------|
| `PayloadPayin` | Reuse; `methodType=CHECK|CHECK21`; metadata: recoveryNeeded, check21, orderNumber, optional OCR check # |
| Indexes | Unique `idempotencyKey`; unique open Check21 payin per invoice (partial unique or atomic claim) |
| Invoice `paymentTransactions` | Existing gateway processing/completed/failed; method label `check` (or echeck if lower risk) |
| Demo model/routes | Remove after production path |
| Images / MICR | **Never** store in Mongo |

**Amount:** server-validated only; persist on payin; send that amount to Payload.

---

## 10. UI changes

- Add **Upload Check (Check21)** to `RecordPaymentDialog` (flag-gated)
- Extract upload/preview widget from demo page
- Keep offline **Check** (number) unchanged
- Progress / disable submit while uploading
- Success: “Check submitted — processing” + txn reference
- Failure: Check21-friendly API message
- Remove settings demo card + route when production flag replaces demo flag
- Owner invoices: reflect shared Processing/Paid (no owner Check21 submit in v1)

---

## 11. Security / compliance

- RBAC: authorized board member + invoice HOA/property ownership; CSRF
- Secrets server-side only
- Magic-byte validation (`fileContentValidation`); mime allowlist; ≤10MB; both sides required; distinct files
- Multer memory only; request size limits; Check21 route rate limit
- No sensitive logs (no data URIs, buffers, MICR, account numbers)
- Duplicate / concurrency protection (§12–13)
- Audit via payin events
- Return risk: NSF/stop-pay weeks later — product + ops note

---

## 12. Idempotency / duplicate handling

| Mechanism | Role |
|-----------|------|
| Client `paymentAttemptId` → PropMV `idempotencyKey` | Local dedupe of submit attempts (unique DB) |
| Payload `order_number` | Payload-side duplicate protection / merchant reference — **separate** from idempotencyKey; **not** physical check serial by default |
| Physical check # | OCR/remote only → metadata if available |
| Open payin unique per invoice | Blocks concurrent Check21 doubles |
| Webhook event id | Duplicate delivery safe |

---

## 13. Check return / failure handling

- Pre-settle failure → `failInvoiceGatewayPayment` (restore balance; keep failed tx history)
- Post-settle reject → **non-destructive** reverse:
  - Keep original completed paymentTransaction
  - Update `refundedAmount` / reverse metadata
  - Ledger adjustment entry (do not delete original payment ledger row)
  - Idempotent on reject/refund correlation id
- Never overwrite/delete the original successful payment record

---

## 14. Reconciliation / fallback

- `recoveryNeeded` payins after Payload success + local sync failure
- Poll/reconcile open CHECK payins older than N minutes (re-fetch → lifecycle)
- Out-of-order webhooks: re-fetch authoritative status + transition guards
- Delayed/missing webhooks: same reconciler; ops retry-webhooks
- Extend reconciliation codes for returned-still-completed Check21 cases

---

## 15. Test strategy

**Unit:** magic-byte/size/mime; multipart builder; amount server validation; idempotency vs order_number separation; ACH-like + funding settle predicates; transition guards; non-destructive reverse; concurrency claim.

**API/integration:** sandbox submit (after spike); bad files; amount tamper; unauthorized; wrong HOA/inactive acct; duplicate/concurrent; Payload failure; Payload OK/local fail recovery; webhook processed/fail/reject/duplicate/out-of-order.

**Regression:** Card, ACH, Autopay, manual Record Payment Cash/Check — run suites and record results in PR.

**UI:** Upload Check path; offline Check unchanged; disable-while-submit; success/error copy.

---

## 16. Exact files / services expected to change

**Docs:** this file; `existing-architecture.md` Check21 section.

**Backend:** new `payloadCheck21Payin.service.js`; evolve `payloadCheck21.util.js` / `payload.client.js`; `payloadPaymentMethodType.util.js`; settlement/lifecycle guards; webhook middleware hardening; reverse path generalization; reconciliation; new route/validator/privileges; remove demo service/model/routes; `payload.config.js` flag rename (`PAYLOAD_CHECK21_ENABLED`).

**Frontend:** `RecordPaymentDialog.tsx`; shared Check upload widget; `payloadApi.ts`; `payloadConfig.ts`; remove demo page/settings/routes/filters; `VITE_PAYLOAD_CHECK21_ENABLED`.

---

## 17. Migration / backward compatibility

- Demo submissions unused for settlement (archive/drop later)
- Production flag **default off** until QA
- Offline Check method unchanged forever
- Card/ACH/Autopay behavior unchanged
- Optional: one-release overlap with demo flag removed after production flag validated

---

## 18. Risks and edge cases

| Risk | Mitigation |
|------|------------|
| Docs JSON vs multipart drift | Spike gate; multipart default; roadmap table |
| Treating `processed` as deposited | Funding/deposit verification; possibly stricter Check21 settle |
| Frontend amount tampering | Server-authoritative amount |
| Double pay (Check21 + manual/Card/ACH) | Concurrency + collectable/processing gates |
| Payload OK, PropMV crash | recoveryNeeded + reconciler |
| Late reject after Paid | Non-destructive reverse |
| OCR amount mismatch | Fail/hold; do not settle mismatched blindly |
| Poor images | Clear Check21 errors; invoice unchanged |
| Webhook spoofing | Re-fetch trust + optional shared token; document HMAC gap |
| Wrong processing account | Server-only resolution + access asserts |

---

## Implementation order (after Agent mode approval)

1. Complete §4.1 sandbox spike; fill §6.1 predicate matrix; lock settle predicate.  
2. Backend Check21-for-invoice + PayloadPayin + collectable invariant in settle path + recovery (flags **default false**).  
3. Webhook/reconcile/return reverse (no query-string secrets; mandatory re-fetch).  
4. Record Payment UI + remove demo.  
5. Automated tests covering settle predicate, collectable invariant, webhook re-fetch security + Card/ACH/Autopay/manual regressions.  
6. **Staging/prod `PAYLOAD_CHECK21_ENABLED` only after steps 1 and 5 pass.**

**Implementation:** behind `PAYLOAD_CHECK21_ENABLED` / `VITE_PAYLOAD_CHECK21_ENABLED` (default false). **Do not enable staging/production flags until hard gates 1–3 are met** (including real-check OCR confirmation of §6.1).
