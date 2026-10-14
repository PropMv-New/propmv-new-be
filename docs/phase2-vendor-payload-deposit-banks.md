# Phase 2 — Vendor Payload Deposit Bank Management

**Status:** **COMPLETE** (2026-10-09) — live Atlas + Payload Sandbox gates passed.  
**Feature flags:** `PAYLOAD_VENDOR_MERCHANT_ENABLED` + `VITE_PAYLOAD_VENDOR_MERCHANT_ENABLED` (unchanged from Phase 1)  
**Requires:** `PAYLOAD_ENABLED=true`

## Scope

Vendor Processing Account → multiple Payload bank Payment Methods:

- Reuse HOA merchant deposit-method APIs/UI (`list` / `sync` / `initialize` / `register` / `set-primary`)
- Vendor-scoped ownership via Phase 1 `assertPayloadMerchantAccess`
- `PAYLOAD_VENDOR_MERCHANT_ENABLED` enforced on **every** Vendor deposit-method operation
- Account-scoped duplicate detection; cross-account `pm_…` reuse → **409**
- Persist/sync `pm_…`, `status`, `verification_status`, `transfer_type`, and `default_deposit_method`
- Local `isPrimaryPayout` remains a **compatibility mirror** of Payload `default_deposit_method` (source of truth)
- Vendor UI suppresses HOA bank side-effect notifications (`hoaSideEffects={false}`)
- Straddle Vendor banks untouched when flag is off

## Out of scope

- Vendor invoice / Owner→Vendor / Board→Vendor payment execution  
- HOA Treasury credit, HOA two-way banks, HOA Primary semantics, Owner→HOA routing  
- Autopay, Check21, ledger, Rainforest, HOA payin changes  
- Straddle migration/deletion  

## Model additions (`payloaddepositmethods`)

| Field | Purpose |
| --- | --- |
| `verificationStatus` | Payload `verification_status` |
| `transferType` | Payload `transfer_type` (Vendor banks: `receive-only`) |
| `defaultDepositMethod` | Local mirror of Payload `default_deposit_method` |
| `isPrimaryPayout` | Unchanged HOA-compatible mirror of the same flag |

Indexes: existing unique `(provider, depositMethodId)`; `(payloadAccountRef, depositMethodId, isDeleted)`; `(entityType, entityId, isDeleted)`.

## Verification

```bash
# Unit
node --test src/shared/modules/payment/providers/payload/service/payloadDepositMethod.vendor.node.test.js

# Live Atlas + Payload (REQUIRED for Phase 2 complete)
node scripts/phase2-vendor-payload-deposit-banks-gates.js
```

Raw results: `docs/phase2-vendor-payload-deposit-banks-results.json`

### Gate results (latest — COMPLETE)

| Gate | Result | Notes |
| --- | --- | --- |
| CONFIG | PASS | Sandbox client configured |
| ATLAS_CONNECT | PASS | Atlas via IPv4 (`family: 4`) |
| SANDBOX_PA | PASS | Vendor Processing Account created |
| ATLAS_VENDOR_ACCOUNT | PASS | Live Vendor `PayloadAccount` insert/read |
| SANDBOX_TWO_BANKS | PASS | Two `receive-only` bank PMs; one `default_deposit_method` |
| ATLAS_DEPOSIT_METHODS | PASS | Two `PayloadDepositMethod` rows with real `pm_…` |
| PRIMARY_DEFAULT | PASS | Exactly one intended default |
| TWO_BANKS_COEXIST | PASS | Same Vendor PA |
| INDEXES | PASS | Unique `provider+depositMethodId` (partial) + account scope |
| CROSS_VENDOR_PM_REJECT | PASS | 409 on foreign `pm_` |
| CROSS_VENDOR_ACCESS | PASS | Other Vendor 403 |
| FLAG_OFF_DEPOSIT_GATE | PASS | Vendor deposit ops denied when flag off |
| STRADDLE_PRESERVED | PASS | No Straddle mutation |
| Payload Sandbox ↔ Mongo | PASS | `acct_` / `pm_` ids match persisted docs |

Raw results: `docs/phase2-vendor-payload-deposit-banks-results.json`

## Hard gates still in force for later phases

Production Vendor electronic pay requires ACTIVE Vendor PA; card billing address; PropMV idempotency primary; Phase 8 webhooks before production-ready pay.  
Phase 3 (readiness / eligibility / safety — not payment execution) is documented in `docs/phase3-vendor-payload-eligibility.md`. Payment-engine phase requires separate explicit approval.
