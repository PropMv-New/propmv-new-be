# Phase 0 — Vendor Payload Sandbox Gates (Verified)

**Status:** GO (with caveats)  
**Ran:** 2026-10-09  
**Script:** `scripts/phase0-vendor-payload-sandbox-gates.js`  
**Raw results:** `docs/phase0-vendor-payload-sandbox-results.json`

## Decision

**Proceed to Phase 1 (Vendor Processing Account onboarding)** is allowed.

Architecture assumptions for Owner/Board Customer → Vendor Processing Account `type=payment` were **verified in Payload Sandbox**.

HOA Treasury `credit` / HOA bank `two-way` remain **out of scope** for this phase (not tested as production path).

## Gate results

| Gate | Result | Notes |
|---|---|---|
| A. Vendor PA creation | **PASS** | `POST /processing_accounts/` succeeded (`acct_…`, status `incomplete`) |
| B. Multiple vendor banks | **PASS** | Two `receive-only` bank PMs on same PA |
| C. Receiving destinations | **PASS** | `default_deposit_method=true` on bank1; `transfer_type=receive-only`; `status=active`; `verification_status=verified` |
| D. Owner Customer → Vendor PA | **PASS** | Customer with `primary_processing_id=HOA_PA` charged `processing_id=Vendor_PA` |
| E. Board Customer → Vendor PA | **PASS** | Separate Board Customer + send-only bank charged Vendor PA |
| F. Settlement fields | **PASS** | Txn returned `processing_id`, `payment_method_id`, `processing_method_id` (Vendor bank) |
| G. Underwriting/status | **WARN** | Simulate-active left PA `incomplete`; sandbox still accepted payments |
| H. ACH lifecycle | **PASS** | ACH payment created (`processed` + `funding_status=pending` in sandbox) |
| H. Card lifecycle | **WARN** | Card PM create failed without billing address — must supply billing address in product |
| I. Webhooks | **PASS (docs)** | Triggers listed; live delivery to PropMV URL **not** exercised in this script |
| J. Idempotency | **WARN** | Replay with same key produced `status_code=duplicate_attempt` / declined txn (not same txn id) |
| K. Fields | **PASS** | See dictionary below |
| K. transfer_type update | **WARN** | PUT `transfer_type: two-way` left PM as `receive-only` — recreate PM for two-way later |

## Verified Payload field semantics (sandbox)

| Field | Observed use |
|---|---|
| `processing_id` | Vendor Processing Account receiving the payment |
| `payment_method_id` | Payer Customer send-only ACH/card PM |
| `processing_method_id` | Vendor receiving bank PM on Vendor PA |
| `default_deposit_method` | Vendor bank flag for default settlement destination |
| `transfer_type` | Vendor banks: `receive-only`; Owner/Board: `send-only` |
| Transaction `type` | `payment` |
| Webhook triggers (docs) | `payment`, `processed`, `authorized`, `decline`, `reject`, `deposit`, `processing_status` |

## Example successful Owner→Vendor charge (sandbox)

```text
type: payment
amount: 12.34
processing_id: acct_<Vendor_PA>
payment_method_id: pm_<Owner_send_only>
customer_id: acct_<Owner_Customer>
processing_method_id: pm_<Vendor_default_deposit_bank>
status: processed
funding_status: pending
```

Board→Vendor mirrored the same shape with a Board Customer PM.

## Caveats that Phase 1+ must honor

1. **Production underwriting:** Do not assume `incomplete` PAs accept live charges. Gate electronic Vendor pay on Vendor PA `active` (and PropMV ACTIVE sync).
2. **Card billing address:** Owner/Board card PMs need valid billing address for create/charge.
3. **Idempotency:** Payload may decline duplicates (`duplicate_attempt`) rather than return the original txn. PropMV attempt store + unique idempotency key remain mandatory; treat 400 duplicate / declined duplicate as safe no-op after lookup.
4. **ACH:** Sandbox may mark `processed` quickly; PropMV must still model ACH as Processing until verified webhook/`GET` confirms production behavior.
5. **Live webhooks:** Register/verify Vendor payment events against PropMV webhook endpoint in Phase 8 before calling electronic pay production-ready.
6. **`transfer_type`:** Cannot rely on updating existing receive-only banks to two-way (future treasury phase must create new PMs).

## Explicitly not verified / not implemented

- HOA Treasury `credit` to Vendor bank  
- HOA merchant bank `two-way`  
- Live webhook delivery into PropMV  
- PropMV Vendor UI / Mongo `PayloadAccount(entityType=vendor)`  
- VendorInvoice payment engine  

## Next step

**Phase 1 — Vendor Payload Processing Account** (feature-flagged), after this Phase 0 report is accepted.
