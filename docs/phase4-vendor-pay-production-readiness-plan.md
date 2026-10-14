# Phase 4 Production Readiness / Live Verification — PLAN ONLY

**Status:** APPROVED WITH CONSTRAINTS (2026-10-09) — verification may proceed; flag enablement requires separate explicit GO  
**Depends on:** Phase 4 sandbox/Atlas COMPLETE (`docs/phase4-vendor-owner-payment-engine.md`)  
**Production flag today:** `PAYLOAD_VENDOR_PAY_ENABLED` must remain **`false`** until every G1–G14 gate passes **and** an explicit production-enablement approval is issued.

### Mandatory constraints (approval addendum)

1. **Do not** use production Payload credentials in a non-production environment unless explicitly approved **and** technically isolated. Prefer a **tightly controlled production canary** for final live-rail verification.  
2. Final GO must include **actual production-rail evidence** for Card/ACH lifecycle and live webhook delivery/authentication/re-fetch. **Production-like / sandbox-only testing is insufficient** for enablement GO.

**Do not** implement Board→Vendor, HOA Treasury credit, HOA receive-only→two-way banks, HOA Primary/routing changes, Autopay, Check21, Rainforest, or Straddle migration as part of this phase.

**Preserve unchanged:** HOA Owner→HOA payins, HOA merchant routing, Autopay, Check21, Rainforest, Straddle, manual Vendor Record Payment.

---

## 1. Purpose

Promote Owner→Vendor electronic pay from **sandbox-complete** to **production-ready** by verifying live underwriting, rails lifecycle, webhooks, recovery, concurrency, monitoring, and an explicit enablement procedure for `PAYLOAD_VENDOR_PAY_ENABLED=true`.

This phase is **verification + ops readiness** (and only minimal code if a GO approval later identifies a hard blocker). It is **not** a new payment product surface.

---

## 2. Scope

### In scope

| Area | Intent |
| --- | --- |
| Production Vendor PA ACTIVE / eligibility | Live underwriting + PropMV `onboardingStatus=ACTIVE` |
| Vendor default deposit bank readiness | Configured default only; eligible for receive |
| Real Card + ACH lifecycle | Live statuses vs `resolvePayloadPayinSettlementAction` |
| Live webhook delivery / auth / re-fetch | Dashboard→PropMV URL; bearer/OAuth; secret-key GET txn |
| Duplicate webhook / idempotency | Event dedupe + payin settle-once |
| Failed Payload txn recovery | Decline/fail paths; attempt reconciliation |
| Concurrent payment protection | Collectable inequality under load |
| VendorInvoice settlement / reversal | Settle/fail/reverse books match util |
| Monitoring / reconciliation | Alerts + ops runbooks for Vendor payins |
| Rollback / feature-flag procedure | Safe disable without data loss |
| Enable criteria | Exact checklist before `PAYLOAD_VENDOR_PAY_ENABLED=true` |

### Out of scope (hard)

- Board→Vendor electronic pay  
- HOA Treasury → Vendor credit/payout  
- HOA bank two-way / Primary / routing changes  
- Autopay / Check21 / Rainforest / Straddle changes  
- New fee models or HOA fee reuse  
- Enabling production flag without signed GO  

---

## 3. Preconditions (must already be true)

1. Phase 0–4 sandbox/Atlas docs and gates PASS.  
2. Production Payload account / secret key available to ops (not committed to git).  
3. Production webhook URL reachable: `POST https://api.propmv.com/api/webhooks/payload` (or current prod API host).  
4. At least one **production** Vendor with:
   - `PayloadAccount(entityType=vendor)` linked to live `acct_…`
   - PropMV `onboardingStatus=ACTIVE` matching Payload processing account **active**
   - Configured **default** deposit bank (`defaultDepositMethod` / Payload `default_deposit_method`) ACTIVE + eligible  
5. At least one HOA Owner assignee with existing production Payload Customer + send-capable PM (card with billing address and/or ACH), HOA-scoped — **created outside execute** (Settings wallet).  
6. `PAYLOAD_VENDOR_MERCHANT_ENABLED` may be true in prod for onboarding/banks; **`PAYLOAD_VENDOR_PAY_ENABLED` remains false** until §12 GO.

---

## 4. Workstreams (verification design)

### 4.1 Production Vendor PA ACTIVE / eligibility

**Goals**

- Confirm Payload dashboard processing account status is **active** (not incomplete/sandbox-only).  
- Confirm PropMV mirror: `merchantId`, `onboardingStatus=ACTIVE`, sync path used by HOA merchants still correct for Vendor.  
- Confirm eligibility API returns `electronicPayReady=true` for a payable assigned invoice when pay flag is **temporarily** enabled only in a controlled staging/prod-canary (see §10) — default remains off.

**Evidence**

- Screenshot / API `GET` processing account status.  
- Mongo `payloadaccounts` Vendor row.  
- `GET .../pay-eligibility` blockers empty for PA/bank (with pay flag off, expect `VENDOR_PAY_DISABLED` warning only).

**NO-GO if:** live PA is not ACTIVE; PropMV status drifts; eligibility allows execute against non-ACTIVE PA.

### 4.2 Vendor default deposit bank readiness

**Goals**

- Default bank present, `receive-only` (or accepted Vendor receive type), ACTIVE, verification not failed.  
- Non-default banks exist without being selected.  
- Missing/invalid default → blocker; **no** silent alternate bank.

**Evidence**

- Payload PM `default_deposit_method=true` matches PropMV `PayloadDepositMethod`.  
- Controlled dry-run validate rejects when default removed/disabled.

**NO-GO if:** any execute path can select non-default bank; default missing still charges.

### 4.3 Real Card lifecycle

**Goals**

- Production (or production-like live) card charge Owner→Vendor.  
- Billing address present on Owner card PM (Phase 0 hard gate).  
- Settlement **only** when `resolvePayloadPayinSettlementAction` returns `settle` (typically card PROCESSING/authorized).  
- Decline / void / reject → `fail` or `reverse` without double books.

**Evidence**

- Live `txn_…` in Payload; `payloadvendorpayins` row; VendorInvoice `amountPaid` timing matches util.  
- Card decline test: invoice not over-settled.

**NO-GO if:** settle on raw status strings outside util; missing billing address still charges successfully in a way that violates product policy; HOA Invoice/`payloadpayins` written.

### 4.4 Real ACH lifecycle

**Goals**

- ACH remains **pending** (VendorInvoice Processing / payin not settled) until util allows (`SUCCEEDED`/`processed`).  
- ACH return / `funding_status=reversed` → fail or reverse per util.  
- Sandbox “instant processed” must **not** be assumed for production timing.

**Evidence**

- Timeline: execute → Processing → later webhook → settle.  
- Simulated or real return path documented.

**NO-GO if:** ACH settles on execute solely because of PROCESSING; returns do not reopen balance correctly.

### 4.5 Live webhook delivery / authentication / re-fetch

**Goals**

- Payload dashboard webhook registered for Vendor-relevant triggers (`processed`, `authorized`, `decline`, `void`, `reject`, `refund`, and payment-related triggers already used by HOA).  
- Delivery reaches PropMV production URL.  
- Auth: use documented approach — optional `PAYLOAD_WEBHOOK_BEARER` and/or Payload Webhook OAuth bearer validation; **do not** rely on undocumented HMAC (`PAYLOAD_WEBHOOK_SECRET` is ignored — see `PAYLOAD_FOUNDATION.md`).  
- Handler **re-fetches** `GET /transactions/{id}` with `PAYLOAD_SECRET_KEY` before mutating Vendor payin / VendorInvoice.  
- Vendor branch in `payloadWebhook.service.js` handles Vendor txn before HOA payin path; HOA webhooks unaffected.

**Evidence**

- Payload WebhookLog success entries for Vendor `txn_…`.  
- PropMV `PayloadWebhookEvent` rows `processed`.  
- Logs showing re-fetch before settle.  
- Bearer rejection test (wrong token → 401, no settle).

**NO-GO if:** webhooks not delivered; settle from body only; Vendor events break HOA webhook processing; auth disabled in prod without compensating control + explicit risk acceptance.

### 4.6 Duplicate webhook / idempotency

**Goals**

- Replay same Payload event id → no double VendorInvoice credit (`PayloadWebhookEvent` dedupe).  
- Replay settle after `settledAt` set → util `none` / no second `amountPaid` increment.  
- PropMV `paymentAttemptId` / `idempotencyKey` still primary for execute duplicates; Payload `duplicate_attempt` remains secondary.

**Evidence**

- Forced webhook replay; invoice `amountPaid` unchanged on second apply.  
- Execute same attempt id → `{ duplicate: true }`.

**NO-GO if:** double settlement observed.

### 4.7 Failed Payload transaction recovery

**Goals**

- Decline on execute → payin FAILED; Processing hold released if no other in-flight.  
- Client timeout after charge succeeded: same `paymentAttemptId` recovers existing row; no second charge.  
- Crash between Payload success and local `transactionId` persist: recovery via webhook match and/or ops re-fetch; document residual risk and runbook.  
- Ops: extend or document use of `retryFailedPayloadWebhooks` / reconciliation for Vendor payins (gap analysis — may require small follow-up code **only after GO**).

**Evidence**

- Timeout/retry test script results.  
- Runbook steps in this doc’s ops appendix (to be filled during verification).

**NO-GO if:** unrecovered “charged but unpaid invoice” with no ops path; duplicate charges on retry.

### 4.8 Concurrent payment protection

**Goals**

- Two overlapping executes (or execute + manual Record Payment) cannot violate  
  `amountPaid + inFlightElectronic + newPayment <= subAmount`.  
- Second request returns 409 `VENDOR_INVOICE_OVERPAY` (or equivalent) when over collectable.

**Evidence**

- Parallel request test in staging/prod-canary.  
- Manual Record Payment during electronic in-flight respects remaining collectable.

**NO-GO if:** overpayment possible under concurrency.

### 4.9 VendorInvoice settlement / reversal behavior

**Goals**

- Settle applies `invoicePaymentAmount` once; `Paid` + expense helper when fully covered (existing `ensureExpenseForPaidVendorInvoice`).  
- Fail clears Processing appropriately.  
- Reverse after settle decrements `amountPaid` / reopens balance; expense policy remains “no silent delete” (timeline note; ops if ambiguous).  
- Manual Record Payment still works when no electronic conflict.

**Evidence**

- Activity timeline entries for gateway initiate / payment / fail / reverse.  
- Regression: board/vendor Record Payment on unpaid invoice.

**NO-GO if:** books diverge from Payload settled amount; Record Payment broken.

### 4.10 Monitoring / reconciliation

**Goals**

- Dashboards/alerts (or log queries) for:
  - Vendor payin stuck in PROCESSING beyond SLA  
  - Webhook FAILED retries exhausted  
  - `VENDOR_INVOICE_OVERPAY` / charge errors spike  
  - Eligibility blockers rate (PA not ACTIVE, default bank missing)  
- Ops reconciliation: compare `payloadvendorpayins.transactionId` vs Payload GET vs VendorInvoice `amountPaid`.  
- Confirm HOA `operations/reconciliation` still HOA-only and unchanged; Vendor may need a **documented** manual query set first, then optional Vendor reconcile endpoint **only if GO requires code**.

**Evidence**

- Alert definitions + sample query pack.  
- One dry-run reconcile of a known Vendor txn.

**NO-GO if:** no way to detect stuck Processing or missed webhooks in prod.

### 4.11 Rollback / feature-flag procedure

**Disable (immediate)**

1. Set `PAYLOAD_VENDOR_PAY_ENABLED=false` (API) and redeploy/restart.  
2. Set `VITE_PAYLOAD_VENDOR_PAY_ENABLED=false` (or omit) and redeploy frontend.  
3. UI returns to Phase 3 “Online payment coming soon” when merchant flag still on.  
4. Execute routes return 403 `VENDOR_PAY_DISABLED`.  
5. Leave `payloadvendorpayins` rows for audit; do **not** mass-delete.  
6. In-flight Processing: ops runbook — wait for webhook, manual Record Payment for remainder, or fail/reconcile tooling.  
7. Do **not** disable `PAYLOAD_VENDOR_MERCHANT_ENABLED` unless also rolling back onboarding (separate decision).  
8. Confirm HOA Owner→HOA, Autopay, Check21, Rainforest, Straddle, Record Payment unaffected.

**Rollback of code** (if needed): revert Vendor pay execute/UI only; webhook Vendor branch should no-op when no matching Vendor payin (safe).

### 4.12 Regression preservation (mandatory)

Before any enablement, re-run / smoke:

| Flow | Expectation |
| --- | --- |
| HOA Owner → HOA payin | Unchanged |
| HOA merchant / deposit routing | Unchanged |
| Autopay | Unchanged |
| Check21 | Unchanged |
| Rainforest (if still enabled anywhere) | Unchanged |
| Straddle Vendor banks (when merchant flag off) | Unchanged |
| Manual Vendor Record Payment | Unchanged |
| Phase 1–3 Vendor merchant/bank/eligibility | PASS |

---

## 5. Proposed verification environments

| Env | Use |
| --- | --- |
| **Production canary (preferred)** | Tightly controlled prod HOA/Vendor/Owner; live Card/ACH + live webhooks; flag off globally until enablement GO |
| Production Payload dashboard | Webhook registration, WebhookLog, PA ACTIVE |
| Production Mongo (Atlas) | Read/verify Vendor rows; limited write for canary invoices only |
| Sandbox / local | Regression, unit, amount/bank/util gates only — **not** sufficient for final enablement GO |

**Rules:**

- Prefer **production canary** for final live-rail verification.  
- **Do not** place production Payload credentials into staging/local unless separately approved and network/secret-isolated.  
- Keep `PAYLOAD_VENDOR_PAY_ENABLED=false` globally until G1–G14 PASS + explicit enablement approval (canary enable is still a separate change window, not automatic).

---

## 6. Suggested artifact set (after future implementation/verification — not now)

| Artifact | Purpose |
| --- | --- |
| `scripts/phase4-vendor-pay-production-gates.js` (optional) | Live gates with explicit prod/canary guards |
| `docs/phase4-vendor-pay-production-results.json` | Raw evidence |
| `docs/phase4-vendor-pay-production-report.md` | Signed GO/NO-GO |
| Ops runbook section | Timeout recovery, stuck Processing, rollback |

**This plan does not create these files until approved to implement verification work.**

---

## 7. Exact criteria to enable `PAYLOAD_VENDOR_PAY_ENABLED=true`

All of the following must be **PASS** and recorded:

1. **Production Vendor PA ACTIVE** (Payload + PropMV mirror).  
2. **Default deposit bank** configured, eligible, isolation proven.  
3. **Live Card** charge + settle/fail paths match settlement util.  
4. **Live ACH** pending-until-settle + return/fail/reverse paths match util.  
5. **Live webhook delivery** to PropMV URL with WebhookLog success.  
6. **Webhook authentication** configured and verified (bearer/OAuth as adopted).  
7. **Secret-key re-fetch** before every Vendor settle/fail/reverse.  
8. **Duplicate webhook** does not double-settle.  
9. **Execute idempotency** + timeout recovery proven.  
10. **Concurrency / overpay** protection proven.  
11. **VendorInvoice** settlement/reversal + Record Payment coexistence proven.  
12. **Monitoring / reconciliation** path documented and exercised once.  
13. **Rollback drill** executed (flag off → UI/API gated; HOA flows intact).  
14. **Regression pack** (§4.12) PASS.  
15. **Product/ops sign-off** on canary HOA/Vendor list and support runbook.

Only then set:

```bash
# API / server
PAYLOAD_VENDOR_PAY_ENABLED=true

# Frontend build
VITE_PAYLOAD_VENDOR_PAY_ENABLED=true
```

Prefer **canary enable** (single HOA or allowlist) if/when engineering adds an allowlist — until then, treat first enable as high-touch with immediate rollback owner on call.

---

## 8. Explicit GO / NO-GO production gates

### GO (all required)

| # | Gate | GO when |
| --- | --- | --- |
| G1 | PA ACTIVE | Live Vendor processing account active; PropMV ACTIVE |
| G2 | Default bank | Default only; ineligible default blocks execute |
| G3 | Card lifecycle | Live card settle/fail via util only |
| G4 | ACH lifecycle | Live ACH pending → settle; returns handled |
| G5 | Webhook delivery | Live events reach PropMV; WebhookLog OK |
| G6 | Webhook auth | Bearer/OAuth (or accepted control) verified |
| G7 | Re-fetch | No settle without secret-key GET txn |
| G8 | Idempotency | Duplicate event + duplicate attempt safe |
| G9 | Recovery | Timeout/crash has proven recovery path |
| G10 | Concurrency | No overpay under parallel pay / Record Payment |
| G11 | Books | Settlement/reversal match amounts; expense policy OK |
| G12 | Monitoring | Stuck/missed webhook detectable |
| G13 | Rollback | Flag-off drill PASS; HOA/Vendor manual flows intact |
| G14 | Regression | HOA payin, Autopay, Check21, Rainforest, Straddle, Record Payment PASS |

### NO-GO (any one fails)

| Condition | Action |
| --- | --- |
| Any G1–G14 FAIL | Keep `PAYLOAD_VENDOR_PAY_ENABLED=false` |
| Webhooks undeliverable | NO-GO |
| Double settlement observed | NO-GO |
| HOA Owner→HOA or Record Payment regression | NO-GO |
| Production PA not ACTIVE | NO-GO |
| Desire to “enable and watch” without G5–G9 | NO-GO |

**Default stance until signed GO report:** **NO-GO for production enablement.**

---

## 9. Implementation policy for this phase

| Activity | Allowed only after plan approval? |
| --- | --- |
| Write verification scripts / runbooks / results docs | Yes (after GO to *implement verification*) |
| Temporary canary flag enable under change window | Yes, only after verification GO |
| Board→Vendor / Treasury / two-way / routing / Autopay / Check21 / Rainforest / Straddle | **Never** in this phase |
| Broad production `PAYLOAD_VENDOR_PAY_ENABLED=true` | Only after §7 + §8 all PASS + explicit enable approval |

---

## 10. Recommended sequence (after this plan is approved)

1. Inventory prod Vendor PA + default banks + Owner wallets (read-only).  
2. Register/verify Payload webhooks + bearer; prove delivery with HOA txn first if needed, then Vendor.  
3. Controlled canary Card charge (flag on briefly or staging-with-prod-keys).  
4. Controlled canary ACH charge; wait for live settle/return evidence.  
5. Duplicate webhook + idempotency + timeout recovery drills.  
6. Concurrency + Record Payment coexistence.  
7. Monitoring queries + rollback drill.  
8. Full regression pack.  
9. Publish production results + **GO/NO-GO report**.  
10. **Stop** — do **not** enable `PAYLOAD_VENDOR_PAY_ENABLED` automatically after verification. Await **separate explicit production-enablement approval**.  

---

## 11. Approval checklist

Reviewers confirm:

- [x] Plan is verification-only; no Board→Vendor / Treasury / two-way / unrelated payment work  
- [x] Production flag stays false until §7–§8 PASS **and** explicit enablement approval  
- [x] HOA Owner→HOA, Autopay, Check21, Rainforest, Straddle, Record Payment must remain green  
- [x] Settlement util remains sole settle authority  
- [x] Default bank only; no first-bank fallback  
- [x] Explicit GO/NO-GO gates accepted  
- [x] No production Payload credentials in non-prod unless isolated + approved  
- [x] Final GO requires actual production-rail Card/ACH + live webhook evidence  

**Verification may proceed. Broad production enablement requires a second explicit approval after GO report.**
