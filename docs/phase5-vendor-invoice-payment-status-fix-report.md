# Vendor Invoice Payment Status & Activity — Root-Cause Fix Report

**Date:** 2026-10-10  
**Scope:** Vendor Invoice electronic payin lifecycle (Payload ACH/Card) — Paid Date, Payments Received, Activity Timeline, Payment Transactions.

## Confirmed root cause

### Primary (settlement)

`resolvePayloadPayinSettlementAction` in  
`propmv/src/shared/modules/payment/providers/payload/utils/payloadPayinSettlement.util.js`  
returned **`none`** for Card when status was already **`SUCCEEDED`** / event **`processed`**, and only settled on **`PROCESSING`**.

Sandbox (and some live) Card charges return **`processed` immediately** with no intermediate `PROCESSING`. Vendor execute path:

1. `executeVendorInvoicePayin` maps remote → `SUCCEEDED`
2. calls `markVendorInvoiceElectronicProcessing` → invoice **Processing**, timeline `status_change`
3. calls `resolvePayloadPayinSettlementAction({ status: SUCCEEDED, eventType: '' })` → was **`none`**
4. never calls `applyVendorPayinSettlement` → **`settledAt` stays null**, **`paidAt` unset**, no `kind: 'payment'` timeline entry

Webhooks were absent/empty in this environment, so nothing re-entered settlement later.

**Evidence (pre-fix DB):** VI-2026-0002 payin `CARD` / `SUCCEEDED`, `settledAt: null`, `lastWebhookAt: null`; invoice Processing, timeline = `created` + `status_change` only.

### Secondary (Activity Timeline UI)

`InvoiceActivityTimeline` returned **`null`** for `kind: 'status_change'`. Badge counted 2 events; only “Invoice Created” rendered.

### Why each UI field was wrong

| UI | Cause |
|----|--------|
| **Paid Date** | Reads `paidAt`; set only in `settleVendorInvoiceGatewayPayment` when status becomes Paid |
| **Payments Received / Payment Transactions** | Built from timeline `kind === 'payment'` via `paymentTransactionsFromTimeline`; settlement never ran |
| **Activity Timeline** | Missing payment entry (no settle); `status_change` not rendered |
| **Payment Transactions “Verifying”** | Synthetic processing tracker while invoice remains Processing and no completed txs |

ACH semantics unchanged: settle only on `SUCCEEDED`/`processed`. Frontend still does not mark Paid from execute success alone.

## Fix (minimal)

1. **Settlement util** — Card settles on first confirmation: `PROCESSING` **or** `SUCCEEDED` / `processed` / `authorized` / `processing`. `alreadySettled` still returns `none` (or reverse on fail paths) → no double-settle.
2. **Activity Timeline** — Render `status_change` in `InvoiceActivityTimeline` + type in `types.ts`.
3. **Tests** — Util + vendor payin + mocked gateway helper coverage.
4. **Repair script** — `scripts/repair-stuck-vendor-card-settlements.js` (dry-run default; `--apply` settles stuck Card/Apple Pay payins with `settledAt: null`).

Shared util change also corrects HOA Card payins that skip PROCESSING when webhooks are delayed/missing; idempotent via `settledAt`.

## Files changed

| File | Why |
|------|-----|
| `payloadPayinSettlement.util.js` | Card SUCCEEDED/processed → settle |
| `payloadPayinSettlement.util.test.js` | Regression: settle + alreadySettled |
| `payloadVendorPayin.node.test.js` | Card immediate SUCCEEDED settle |
| `vendorInvoiceGatewayPayment.helper.test.js` | paidAt / timeline / fail / reverse / partial |
| `InvoiceActivityTimeline.tsx` | Render status_change |
| `types.ts` | `status_change` ActivityTimelineEntry |
| `scripts/repair-stuck-vendor-card-settlements.js` | Repair stuck pre-fix payins |
| `docs/phase5-vendor-invoice-payment-status-fix-report.md` | This report |

## Tests executed

```text
node --test \
  src/shared/modules/payment/providers/payload/utils/payloadPayinSettlement.util.test.js \
  src/shared/modules/payment/providers/payload/service/payloadVendorPayin.node.test.js \
  src/portals/hoa-board/modules/vendor-invoice/helpers/vendorInvoiceGatewayPayment.helper.test.js
```

**Result:** all focused tests **PASS** (34 assertions across suites after partial-status expectation aligned with existing `deriveStatus`).

Phase 4/5 gate scripts not re-run end-to-end (Atlas IP not whitelisted from this agent host).

## Unverified

- Live Mongo repair of VI-2026-0002 / stuck payins (Atlas connection failed from this environment).
- Browser re-check of list/detail after repair + new Card pay.
- Live webhook delivery for ACH Processing → Succeeded in this env.
- Summary card `$1.00` vs row `$100.00` Processing KPI (separate from settlement root cause; not changed).

## Remaining blockers

1. Run `node scripts/repair-stuck-vendor-card-settlements.js --apply` from a host with Atlas access to settle existing stuck Card payins.
2. Re-pay or re-open VI-2026-0002 after repair to confirm Paid Date / Payments Received / Timeline / Transactions.
3. Optional follow-up: Processing summary KPI mismatch ($1 vs $100) if still present after settlement.

## Not changed (by design)

Payment routing, merchant ownership, convenience fees, HOA Processing Account rules, ACH settle-on-SUCCEEDED-only, Manual Record Payment, rent invoice settle paths (aside from shared Card util alreadySettled-safe broaden), feature flags.
