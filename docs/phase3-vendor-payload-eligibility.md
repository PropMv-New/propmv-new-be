# Phase 3 — Vendor Pay Readiness + Eligibility + Safety Layer

**Status:** **COMPLETE** (2026-10-09) — Atlas + Payload Sandbox gates passed; **zero** payment transactions created.  
**Feature flags:** `PAYLOAD_VENDOR_MERCHANT_ENABLED` + `VITE_PAYLOAD_VENDOR_MERCHANT_ENABLED` only.  
**Not introduced:** `PAYLOAD_VENDOR_PAY_ENABLED` (not required for readiness-only).

## Scope

Phase 3 = **readiness / eligibility / safety only** — not the payment engine.

| Deliverable | Status |
| --- | --- |
| Server-side Vendor payment eligibility resolver | Done |
| Vendor → PayloadAccount → ACTIVE Processing Account | Done |
| Resolve `default_deposit_method` + bank eligibility | Done |
| Owner Customer / PM readiness (read-only, no create) | Done |
| Board Customer strategy documented (deferred) | Done |
| Read-only `GET .../vendor-invoices/:id/pay-eligibility` | Done |
| Gate broken Vendor Pay → HOA `OwnerPaymentDialog` / executePayin | Done |
| Preserve Manual Record Payment | Done |
| Server resolves all merchant/bank/payer IDs | Done |

## Out of scope (hard prohibitions)

- `POST /transactions`, VendorInvoice settlement, payment-attempt collection  
- Owner → Vendor / Board → Vendor / HOA Treasury → Vendor credit  
- HOA receive-only → two-way; HOA Primary/routing changes  
- Autopay / Check21 / Rainforest / Straddle migration  
- New persistent Board Customer / PM infrastructure  
- Broadening VendorInvoice auth to every HOA Owner  

## API

```
GET /api/v1/payments/payload/vendor-invoices/:vendorInvoiceId/pay-eligibility
```

- Auth: existing session + **VendorInvoice visibility/assignment** via `getVendorInvoiceById`  
- Never trusts client-supplied Payload merchant / bank / customer IDs  
- Always returns `electronicPayAvailable: false`, `electronicPayExecutable: false` in Phase 3  
- When merchant mode on: `brokenHoaPayinPathGated: true`, `manualRecordPaymentPreserved: true`  
- Includes `boardCustomerStrategy` (deferred; reuse HOA-scoped Owner wallet pattern later)

## Frontend safety

When `vendorMerchantEnabled` (local + server):

- Vendor invoice inbox / detail: electronic **Pay Invoice** hidden / disabled  
- UI shows **Online payment coming soon** (non-payment state)  
- `OwnerPaymentDialog` not mounted for Vendor invoices  
- **Record Payment** unchanged  

When merchant mode is off: legacy Pay button remains (still incorrect for Vendor; not restored as a fallback when mode is on).

## Board Customer strategy (document only)

Reuse existing `ensurePayloadUserContext` / HOA-scoped send-only payment methods for a future Board → Vendor Customer payment. Do **not** invent a second Customer stack in Phase 3. Persistent Board Customer creation belongs in the payment-engine phase if product requires Board electronic pay.

## Verification

```bash
# Unit (Phase 3 + Phase 1/2 regression)
node --test \
  src/shared/modules/payment/providers/payload/service/payloadVendorEligibility.node.test.js \
  src/shared/modules/payment/providers/payload/service/payloadMerchant.vendor.node.test.js \
  src/shared/modules/payment/providers/payload/service/payloadDepositMethod.vendor.node.test.js

# UI gate logic
node --test ../innago-inspired-refresh/src/shared/pages/vendor-invoices/__tests__/vendorInvoiceElectronicPayGate.node.test.cjs

# HOA Owner → HOA payin helper regression
node --test src/shared/modules/payment/providers/payload/utils/payloadPayinCharge.node.test.js

# Live Atlas + Payload (REQUIRED) — creates ZERO transactions
node scripts/phase3-vendor-payload-eligibility-gates.js
```

Raw results: `docs/phase3-vendor-payload-eligibility-results.json`

### Gate results (latest — COMPLETE)

| Gate | Result |
| --- | --- |
| CONFIG | PASS |
| ATLAS_CONNECT | PASS |
| SANDBOX_PA_READONLY | PASS |
| ATLAS_FIXTURES | PASS |
| SANDBOX_DEFAULT_BANK | PASS |
| ELIGIBILITY_INACTIVE_PA | PASS |
| ELIGIBILITY_DEFAULT_BANK | PASS |
| CROSS_VENDOR_ISOLATION | PASS |
| OWNER_PAYER_READINESS | PASS |
| ELECTRONIC_PAY_GATED | PASS |
| NO_VENDOR_PAY_FLAG_REQUIRED | PASS |
| AUTH_MODEL_PRESERVED | PASS |
| ZERO_TRANSACTIONS | PASS |

## Mandatory Phase 3 gates — checklist

- [x] Eligibility returns blockers for inactive/incomplete Vendor PA  
- [x] Eligibility resolves Vendor default deposit bank  
- [x] Cross-Vendor merchant/bank isolation enforced  
- [x] Owner payer readiness resolved server-side  
- [x] Existing Vendor manual Record Payment remains functional (not replaced)  
- [x] Broken Vendor electronic Pay cannot invoke HOA invoice payment when merchant mode on  
- [x] Phase 3 tests create zero Payload payment transactions  
- [x] HOA Owner → HOA payment regression PASS  
- [x] Vendor Phase 1/2 onboarding and bank regression PASS  

## Hard gates still in force for later phases

Production Vendor electronic pay still requires: ACTIVE Vendor PA; card billing address; PropMV idempotency primary; Phase 8 webhooks before production-ready pay.

**Stop:** Do not start the **payment-engine** phase without explicit approval.
