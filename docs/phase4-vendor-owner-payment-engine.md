# Phase 4 — Owner → Vendor Electronic Payment Engine

**Status:** **COMPLETE** (sandbox / Atlas) — 2026-10-09  
**Production-ready:** **NO** — keep `PAYLOAD_VENDOR_PAY_ENABLED=false` in production until live webhook checklist is separately verified.

## Architecture

```text
Assigned HOA Owner existing Customer/PM
  → Vendor ACTIVE Processing Account (processing_id)
  → Vendor default deposit bank only (processing_method_id)
  → Payload type=payment
  → resolvePayloadPayinSettlementAction (sole settle authority)
  → VendorInvoice settlement
```

## Locked amount rule (v1)

Inspected VendorInvoice: **no** authoritative Vendor payer fee exists.

```text
chargeAmountDollars = invoicePaymentAmount
chargeAmountCents   = round(invoicePaymentAmount * 100)
processingFeeAmount = 0
```

Same calculation in validate, execute, persist, webhook settle, and UI. **Do not** reuse HOA fee logic.

## Partial payments

VendorInvoice already supports partials. Phase 4 supports them with:

```text
amountPaid + inFlightElectronic + newPayment <= subAmount
```

## Feature flags

| Flag | Role |
| --- | --- |
| `PAYLOAD_VENDOR_MERCHANT_ENABLED` | PA / banks / eligibility |
| `PAYLOAD_VENDOR_PAY_ENABLED` (+ `VITE_…`) | Electronic execute + UI ungating (**default false**) |

## APIs

| Method | Path |
| --- | --- |
| GET | `/api/v1/payments/payload/vendor-invoices/:id/pay-eligibility` |
| POST | `/api/v1/payments/payload/vendor-invoices/:id/payins/validate` |
| POST | `/api/v1/payments/payload/vendor-invoices/:id/payins/execute` |
| GET | `/api/v1/payments/payload/vendor-payins/:vendorPayinId` |

## Hard rules enforced

- Default deposit bank **only** — no first-eligible fallback  
- Execute does **not** create/update Owner PMs or Vendor deposit methods  
- Settlement **only** via `resolvePayloadPayinSettlementAction`  
- Assignee Owner only (no Board→Vendor)  
- Manual Record Payment preserved  

## Out of scope

Board→Vendor, HOA Treasury credit, HOA two-way/Primary/routing, Autopay, Check21, Rainforest, Straddle migration.

## Verification

```bash
node --test \
  src/shared/modules/payment/providers/payload/service/payloadVendorPayin.node.test.js \
  src/shared/modules/payment/providers/payload/service/payloadVendorEligibility.node.test.js \
  src/shared/modules/payment/providers/payload/service/payloadMerchant.vendor.node.test.js \
  src/shared/modules/payment/providers/payload/service/payloadDepositMethod.vendor.node.test.js \
  src/shared/modules/payment/providers/payload/utils/payloadPayinCharge.node.test.js

node --test ../innago-inspired-refresh/src/shared/pages/vendor-invoices/__tests__/vendorInvoiceElectronicPayGate.node.test.cjs

node scripts/phase4-vendor-owner-payment-gates.js
```

Raw results: `docs/phase4-vendor-owner-payment-results.json`

## Production checklist (not satisfied by sandbox COMPLETE)

- [ ] Live Vendor webhook delivery  
- [ ] Webhook auth (signature/bearer)  
- [ ] Secret-key transaction re-fetch  
- [ ] Card settlement predicate live  
- [ ] ACH success/return lifecycle live  
- [ ] Duplicate webhook idempotency  
- [ ] Timeout/crash recovery  
- [ ] Production Vendor PA ACTIVE  

**Stop:** Do not start Board→Vendor or Treasury without explicit approval.
