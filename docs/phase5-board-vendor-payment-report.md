# Phase 5 Completion Report — Board Member → Vendor Electronic Payment

**Date:** 2026-10-09  
**Outcome:** **GO for Phase 5 Sandbox completion**  
**Production-ready:** **NO** — keep `PAYLOAD_VENDOR_PAY_ENABLED=false` in all committed/default environments  
**Evidence:** `docs/phase5-board-vendor-payment-results.json` (outcome=`pass`)

---

## Verdict

Phase 5 Sandbox is **COMPLETE**. Board Member → VendorInvoice electronic payment works through Board Customer + send-capable PM → Vendor PA + default deposit bank, reusing the Phase 4 payin/webhook/settlement engine. HOA Processing Account / HOA merchant banks were **not** used as charge destinations (automated asserts). No production deploy, canary, or live production payments were performed.

---

## Files changed

### Backend (`propmv`)

| File | Change |
| --- | --- |
| `src/shared/modules/payment/providers/payload/service/payloadVendorPayin.service.js` | Board auth; HOA≠Vendor charge asserts; payer ownership; `payerRole`; export collectable helpers |
| `src/shared/modules/payment/providers/payload/model/payloadVendorPayin.model.js` | `payerRole` enum field |
| `src/shared/modules/payment/providers/payload/service/payloadVendorEligibility.service.js` | Active Board wallet strategy; Board PM readiness / `BOARD_NO_PAYMENT_METHOD` |
| `src/portals/hoa-board/modules/vendor-invoice/service/vendorInvoice.service.js` | Manual Record Payment respects electronic in-flight collectable invariant |
| `src/shared/modules/payment/providers/payload/service/payloadVendorPayin.node.test.js` | Auth / HOA-forbid / idempotency unit tests |
| `src/shared/modules/payment/providers/payload/service/payloadVendorEligibility.node.test.js` | Board strategy active |
| `scripts/phase5-board-vendor-payment-gates.js` | Sandbox E2E gate runner |
| `docs/phase5-board-vendor-payment-plan.md` | Approved plan (prior) |
| `docs/phase5-board-vendor-payment-results.json` | Gate evidence |
| `docs/phase5-board-vendor-payment-report.md` | This report |

### Frontend (`innago-inspired-refresh`)

| File | Change |
| --- | --- |
| `src/portals/hoa-board/pages/settings/BoardPayerPaymentMethodsPage.tsx` | Board send-only payer Settings (ACH+Card) |
| `src/config/settingsConfig.ts` | Board “Payer payment methods” section |
| `src/shared/routing/hoaRoleSettingsPages.tsx` | Board payer page routing |
| `src/routes/routeGroups/operatorSettingsRoutes.tsx` | `/settings/payment/payer-methods` |
| `src/shared/components/VendorInvoicePayDialog.tsx` | Attempt-id pin + retry; empty-PM prerequisite |
| `src/shared/components/widgets/paymentMethodUtils.ts` | `BOARD_PAYER_PAYMENT_METHODS_HREF`; settingsHref redirect |
| `src/shared/components/widgets/ownerPaymentMethodGuard.ts` | Optional Board settings redirect |
| `src/shared/pages/vendor-invoices/VendorInvoicesInboxPage.tsx` | Board electronic Pay unlock |
| `src/shared/pages/vendor-invoices/VendorInvoiceDetailPage.tsx` | Board electronic Pay unlock |

---

## DB / model changes

- `PayloadVendorPayin.payerRole`: `'owner' | 'board'` (default `'owner'`)
- No new collections
- Board Customer/PM reuse existing `PayloadUser` / `PayloadPaymentMethod` with `billableMerchantId=hoa:{hoaId}`

---

## API / UI changes

- **Same routes** as Phase 4; auth widened to assignee Owner **or** Board of invoice HOA
- Pay Invoice **never** creates Customer/PM
- Board Settings → **Payer payment methods** (separate from HOA merchant banks)
- Board Vendor invoice inbox/detail: electronic Pay when flag on
- `paymentAttemptId` pinned across network retries of the same Pay action

**Flag:** `PAYLOAD_VENDOR_PAY_ENABLED` default remains `false`. Gates enable in-process only.

---

## Exact Sandbox transactions (final green run)

| Role | Method | Txn | Status | `processing_id` (Vendor) | `processing_method_id` (Vendor default) |
| --- | --- | --- | --- | --- | --- |
| Board | ACH | `txn_3fTjBI06fZWA3sadYQ8qx` | SUCCEEDED | `acct_3fTjBCaoMdqn2IJ8ZCxMk` | `pm_3fTjBDlgBWpnFxx4lYmVI` |
| Board | Card | `txn_3fTjBLatVdyUlOL3e6ICW` | SUCCEEDED | `acct_3fTjBCaoMdqn2IJ8ZCxMk` | `pm_3fTjBDlgBWpnFxx4lYmVI` |
| Owner | ACH | `txn_3fTjBND1ypoKPFIIk6Tsp` | SUCCEEDED | `acct_3fTjBCaoMdqn2IJ8ZCxMk` | `pm_3fTjBDlgBWpnFxx4lYmVI` |

HOA rails present but unused: `acct_3fTjBE2YRWRzOdeyibuEv` / `pm_3fTjBEOtZDjZ0JabguBx6`

---

## Gate results summary

| Gate | Result |
| --- | --- |
| Board ACH | **PASS** (`payerRole=board`, HOA inequalities empty) |
| Board Card | **PASS** |
| Owner regression | **PASS** |
| First-time Board onboarding (Customer+ACH) | **PASS** |
| First-time no-PM block | **PASS** (`PAYER_PM_NOT_FOUND`) |
| Board Card onboarding (existing Customer) | **PASS** |
| HOA-not-used asserts | **PASS** (failures `[]` on Board ACH/Card + Owner) |
| Idempotency (same attempt) | **PASS** (`duplicate: true`, count=1) |
| Duplicate webhook | **PASS** (paid stayed 5) |
| Concurrency in-flight overpay | **PASS** |
| Manual + electronic race invariant | **PASS** |
| Auth non-assignee Owner | **PASS** |
| Auth wrong-HOA Board | **PASS** |
| Settlement util authority | **PASS** |
| New payment → new attempt | **PASS** |
| Production not claimed | **PASS** |

Unit tests: **24/24 PASS** (`payloadVendorPayin` + `payloadVendorEligibility`).

---

## Settlement / ledger / HoaExpense

- Settlement exclusively via `resolvePayloadPayinSettlementAction` → `applyVendorPayinSettlement` → `settleVendorInvoiceGatewayPayment` (amountPaid / balanceDue / status; expense helper on Paid).
- Sandbox gates stubbed VendorInvoice collection with the same settlement helper path; duplicate webhook did not double-apply.

---

## Remaining gaps (non-blocking for Sandbox GO)

1. **Production** still out of scope (Phase 4 route-gap on `origin/production` unchanged).
2. Full UI browser walkthrough of Board Settings → Pay was not automated; API/Settings path is implemented and gate-proven via Settings-equivalent Customer/PM creation.
3. HoaExpense creation is best-effort in helper (unchanged from Phase 4); not separately asserted in Phase 5 gates beyond settlement path.

---

## Explicit GO / NO-GO

| Decision | Status |
| --- | --- |
| **Phase 5 Sandbox completion** | **GO** |
| Production enablement / canary / live pay | **NO-GO** |
| Keep `PAYLOAD_VENDOR_PAY_ENABLED=false` as default | **Required** |
