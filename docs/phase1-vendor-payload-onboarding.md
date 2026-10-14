# Phase 1 — Vendor Payload Processing Account Onboarding

**Status:** Implemented (awaiting Phase 1 acceptance before Phase 2)  
**Feature flags:** `PAYLOAD_VENDOR_MERCHANT_ENABLED` (API) + `VITE_PAYLOAD_VENDOR_MERCHANT_ENABLED` (UI)  
**Requires:** `PAYLOAD_ENABLED=true`

## Scope

Vendor Portal → Settings → Bank Accounts:

- Feature-flagged **Payload Processing Account** onboarding (reuses HOA merchant hub components)
- PropMV `PayloadAccount` with `entityType=vendor`
- One Vendor user → one Processing Account mapping (`externalId=payload_vendor_{userId}`)
- Status sync / onboarding UI (plugin + application_link flows)
- Duplicate onboarding prevention (service + unique partial index)
- Authorization: only the owning Vendor (or admin) may manage the account
- When the flag is **off**, existing **Straddle** Vendor bank linking is unchanged

## Out of scope (hard gates)

- Vendor electronic **payment** execution (Phase 2+)
- HOA Treasury → Vendor credit
- Changing HOA merchant banks receive-only → two-way
- Primary Bank semantics
- HOA Owner → HOA payment routing
- Destructive Straddle Vendor bank migration
- Live webhook production verification (Phase 8)

## Mapping

| Field | Value |
| --- | --- |
| `entityType` | `vendor` |
| `entityId` | Vendor user `_id` |
| `createdBy` | Vendor user `_id` |
| `businessId` | Vendor `companyId` or user `_id` fallback |
| `externalId` | `payload_vendor_{userId}` (unique) |
| `metadata.vendorUserId` | Vendor user `_id` |
| `merchantId` | Payload Processing Account id (after plugin/API create) |

## APIs

Unchanged route paths; `entityType=vendor` accepted on merchant initialize/list only:

- `GET /api/v1/payments/payload/config` → includes `vendorMerchantEnabled`
- `GET /api/v1/payments/payload/merchants?entityType=vendor`
- `POST /api/v1/payments/payload/merchants/initialize` with `entityType=vendor`
- Existing status / session / register-processing-account / simulate-approval routes (access-checked)

Owner payment-method schemas **reject** `entityType=vendor` (merchant-only in Phase 1).

## Verification

```bash
# Unit
node --test src/shared/modules/payment/providers/payload/service/payloadMerchant.vendor.node.test.js
node --test src/shared/modules/payment/providers/payload/validators/payload.validator.test.js

# Mongo + Payload Sandbox gates
node scripts/phase1-vendor-payload-onboarding-gates.js
```

Raw results: `docs/phase1-vendor-payload-onboarding-results.json` (after script run).

## Gate results (latest local run)

| Gate | Result | Notes |
| --- | --- | --- |
| CONFIG | PASS | Sandbox client + vendor flag |
| CONFIG_DB | WARN | Atlas IP not whitelisted from this runner; in-memory store used (`PHASE1_MEMORY_DB=1`) |
| A_INITIALIZE | PASS | `entityType=vendor`, stable `externalId` |
| A2_SANDBOX_PA | PASS | Throwaway PA created in Payload Sandbox |
| B_DUPLICATE_PREVENTION | PASS | Second initialize → `alreadyExists`, count=1 |
| C_LIST_SCOPING | PASS | List scoped to Vendor `createdBy` |
| D_AUTHORIZATION | PASS | Owner ok / other Vendor 403 |
| E_FEATURE_FLAG | PASS | Flag-off rejects initialize |
| F_FIND_EXISTING | PASS | Helper finds mapping |
| G_CLEANUP | PASS | Memory discarded; sandbox PA left |

**Atlas Mongo verify:** re-run without `PHASE1_MEMORY_DB` from a whitelisted IP to persist a real `payloadaccounts` row.
