# Existing Architecture — Payment Gateway (PropMV + Payload)

Reference document for Cursor / Claude agents implementing or extending HOA owner payments. Describes manual pay, saved methods, webhooks, and **HOA owner autopay** (Payload mirror invoices + default payment method). See `roadmap-autopay.md` for design rationale.

---

## 1. Provider selection

| Layer | Logic |
|--------|--------|
| Frontend | `innago-inspired-refresh/src/shared/utils/paymentProviderConfig.ts` → `getPrimaryPaymentProvider()` |
| Priority | **Payload** if `VITE_PAYLOAD_ENABLED=true`, else Rainforest if enabled, else **legacy** (Stripe/Straddle) |
| Backend | `PAYLOAD_ENABLED` + `PAYLOAD_SECRET_KEY` in `propmv/src/config/payload.config.js` |

Related env docs: `propmv/docs/PAYLOAD_FOUNDATION.md`, `propmv/docs/HOA_PAYLOAD_OWNER_WALLETS_QA.md`, `propmv/docs/HOA_PAYMENT_INVOICE_QA.md`.

---

## 2. High-level flow (HOA owner pays invoice)

```text
HOA Owner (User)
   ↓
PayloadUser (per user + HOA billableMerchantId scope)
   metadata.payloadCustomerId → Payload Customer
   ↓
PayloadPaymentMethod (saved card / ACH / wallet types)
   ↓
PropMV Invoice (MongoDB — system of record for dues, due dates, balance)
   ↓
POST /api/v1/payments/payload/payins/validate
POST /api/v1/payments/payload/payins/execute
   ↓
PayloadPayin (local) + POST /transactions/ (Payload API)
   processing_id from invoice property / deposit routing
   ↓
Payload Processing Account (board member merchant, acct_…)
   ↓
POST /api/webhooks/payload
   ↓
PayloadWebhookEvent (idempotent) → GET /transactions/{id} re-fetch
   ↓
applyPayinWebhookUpdate → invoice paymentTransactions + ledger
   ↓
Invoice balance / status (authoritative after webhook, not UI alone)
```

---

## 3. Backend module map (Payload)

Base path: **`/api/v1/payments/payload/*`**

| Area | Path (under `propmv/src/shared/modules/payment/providers/payload/`) |
|------|---------------------------------------------------------------------|
| Routes | `routes/payload.routes.js`, `routes/payloadWebhook.routes.js` |
| Controller | `controller/payload.controller.js` |
| HTTP client | `client/payload.client.js` |
| Merchants / onboarding | `service/payloadMerchant.service.js` |
| Owner saved PMs | `service/payloadPaymentMethod.service.js` |
| Client tokens (Payload.js) | `service/payloadComponentSession.service.js` |
| Pay-ins | `service/payloadPayin.service.js` |
| Webhooks | `service/payloadWebhook.service.js`, `middleware/payloadWebhook.middleware.js` |
| Refunds | `service/payloadRefund.service.js` |
| Reconciliation | `service/payloadReconciliation.service.js`, `utils/payloadReconciliation.util.js` |
| Deposit (settlement) banks | `service/payloadDepositMethod.service.js` |

### Mongoose models (`model/`)

| Model | Collection | Purpose |
|-------|------------|---------|
| `PayloadAccount` | payloadaccounts | Local link to board/landlord processing account (`processingAccountId`) |
| `PayloadUser` | payloadusers | Owner ↔ Payload customer scope (`billableMerchantId`, `metadata.payloadCustomerId`) |
| `PayloadPaymentMethod` | payloadpaymentmethods | Saved payor instruments (`providerPaymentMethodId`, `isDefault`, `type`) |
| `PayloadDepositMethod` | payloaddepositmethods | Settlement banks on processing account |
| `PayloadPayin` | payloadpayins | One pay-in attempt per execute (links `invoiceId`, idempotency) |
| `PayloadWebhookEvent` | payloadwebhookevents | Idempotent webhook inbox |
| `PayloadRefund` | payloadrefunds | Refund tracking |

### HOA-specific utils

| File | Role |
|------|------|
| `utils/payloadHoaOwnerCustomerContext.util.js` | HOA scope, customer context |
| `utils/payloadHoaOwnerBillableMerchant.util.js` | Billable merchant / HOA id |
| `utils/payloadHoaOwnerProcessingAccount.util.js` | Primary processing id for unified wallet |
| `utils/resolvePayloadPayinMerchant.util.js` | Invoice → `processing_id`, PM validation for pay-in |
| `utils/payloadPayinCharge.util.js` | Build `POST /transactions/` body |
| `utils/payloadPayinFee.util.js` | Processing fees from billing settings |
| `utils/payloadPayinSettlement.util.js` | Card vs ACH settlement timing |
| `utils/payloadPayinLifecycle.util.js` | Webhook status → local payin phases |

---

## 4. REST API surface (Payload)

From `payload.routes.js`:

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/config` | Public flags for UI |
| *Merchants* | `/merchants/*` | Board onboarding, status, deposit methods |
| POST | `/payment-methods/initialize` | Client token + ensure Payload customer |
| POST | `/payment-methods/register` | Persist `pm_…` after Payload.js |
| GET | `/payment-methods` | List owner methods |
| PUT | `/payment-methods/:id` | Update (includes `default_payment_method` on Payload when `isDefault`) |
| DELETE | `/payment-methods/:id` | Soft-delete / deactivate |
| POST | `/payins/validate` | Allocations, fees, ledger rules |
| POST | `/payins/execute` | Create charge + processing row on invoice |
| GET | `/payins/:payinId` | Status |
| POST | `/refunds/request` | Refunds |
| GET | `/operations/reconciliation` | Ops reconciliation |
| POST | `/check21/submit-for-invoice` | Board **Upload Check (Check21)** — multipart front/back; `PayloadPayin` + processing; webhook settle (flag-gated) |

Webhook (separate mount): **`POST /api/webhooks/payload`**

**Check21 production** (board Record Payment → Upload Check): multipart → Payload `POST /transactions/` with `type=payment`, `source=check`, `processing_id=<HOA processing acct_>`, binary `check_front[file]` / `check_back[file]`, server-validated `amount`, and `order_number` (merchant ref; not PropMV idempotency). Docs-only `receiver` / `check_images` JSON is rejected by live API. Uses `PayloadPayin` (`methodType=CHECK21`) + ACH-like fail paths; settle is **stricter than ACH** when `funding_status` is deferred (`pending`/`processing`). Gated by `PAYLOAD_CHECK21_ENABLED` / `VITE_PAYLOAD_CHECK21_ENABLED` (default **off**). Offline Record Payment Check (check number) unchanged. Settings demo removed.

---

## 5. Unified HOA owner wallet

- Env: **`PAYLOAD_HOA_UNIFIED_OWNER_WALLET`** (default `true`).
- One **Payload Customer per owner per HOA community** (`billableMerchantId` / `hoa:{hoaId}` style scope).
- Saved methods work across units; each **charge** sets **`processing_id`** from the **invoice’s property** deposit routing (not from the wallet’s primary alone).
- Cross-processing charges validated in Phase 0 tooling: `scripts/payload-phase0-cross-processing-charge.js`.

Owner pay-in docs: charge uses `customer_id`, `payment_method_id`, `processing_id`, optional `processing_method_id` for deposit bank — see `PAYLOAD_FOUNDATION.md`.

---

## 6. Owner saved payment methods (cards / ACH / wallets)

### Backend sequence

1. `initializePaymentMethod` → ensure `PayloadUser`, `POST /customers/` if needed (with `primary_processing_id` = board-scoped active processing account), `POST /access_tokens` with **`payment_method_form`** intent (`customer_id`, `transfer_type: send-only` — **never** `processing_id` on payment-method create; merchant deposit banks use `account_id` instead).
2. Browser: Payload.js secure form (`pl-form="payment_method"`).
3. `registerPaymentMethod` → local `PayloadPaymentMethod` row.
4. **`isDefault`** on local model maps to Payload **`default_payment_method=true`** via `updatePaymentMethod` (used for future autopay — not yet wired to invoice sync).

### Frontend (reference)

| Piece | Path |
|-------|------|
| Cards / wallet hub | `innago-inspired-refresh/.../PayloadPaymentMethodsPanel.tsx` |
| Secure form | `PayloadPaymentMethodForm.tsx`, `PayloadPaymentMethodSetup.tsx` |
| Owner pay dialog | `OwnerPaymentDialog.tsx`, `ownerPayloadPayExecution.ts` |
| Config | `payloadConfig.ts`, `resolveOwnerPayloadCardAllowedMethods()` |

Wallets: `VITE_PAYLOAD_OWNER_WALLETS_ENABLED` — Apple/Google via Payload.js (activation prerequisites in `HOA_PAYLOAD_OWNER_WALLETS_QA.md`).

---

## 7. Manual pay-in lifecycle

### Execute (`payloadPayin.service.js`)

1. Validate user, `PayloadPaymentMethod`, invoice(s), **`ledgerService.assertOwnerOnlinePaymentAllowed`**.
2. Resolve merchant context (`resolvePayinMerchantContext`).
3. Compute fees (`calculatePayloadProcessingFee` from HOA/landlord billing settings).
4. Create **`PayloadPayin`** with idempotency key.
5. **`POST /transactions/`** via `PayloadClient.createPaymentTransaction`.
6. Record invoice **`paymentTransactions`** with status **processing** (gateway row, not manual).
7. **Card**: may async-settle after HTTP response. **ACH**: never settle on execute — **webhook only**.

### Webhook (`payloadWebhook.service.js`)

- Triggers handled for pay-ins: `payment`, **`automatic_payment`**, `processed`, `authorized`, `decline`, `void`, `reject`, `refund` (see `isPayinRelatedWebhookTrigger`).
- Pattern: persist **`PayloadWebhookEvent`** (unique `eventId`) → re-fetch transaction → **`applyPayinWebhookUpdate`**.
- Manual execute: **`applyPayinWebhookUpdate`** expects an existing **`PayloadPayin`** (or links via `attrs.invoiceId`).
- Autopay: when no local pay-in exists, **`ensurePayinFromAutomaticPaymentWebhook`** creates **`PayloadPayin`** from webhook + mirrored invoice attrs (`propmvInvoiceId`, `payloadAutopayMirror.payloadInvoiceId`), then runs the same lifecycle.

### Invoice + ledger

- Helpers: `portals/hoa-board/modules/invoice/helpers/invoiceProcessingPayment.helper.js`
  - `ensureGatewayProcessingPaymentRecorded`, `settleInvoiceGatewayPayment`, `failInvoiceGatewayPayment`, `reconcileInvoiceStoredTotals`
- Ledger: `portals/hoa-board/modules/owners/services/ledger.service.js`
- Invoice schema: embedded **`paymentTransactions`** (processing / completed / failed), FIFO fields for cross-invoice allocation.

**Rule:** Do not mark invoice paid from frontend success alone; webhook-confirmed Payload status is authoritative.

---

## 8. Invoices & recurrence (PropMV-owned)

Payload **Billing Schedules are not used** for HOA dues.

| Concern | Location |
|---------|----------|
| Invoice model | `portals/hoa-board/modules/invoice/model/invoice.model.js` |
| Invoice service | `portals/hoa-board/modules/invoice/service/invoice.service.js` |
| HOA recurring fee settings | `portals/hoa-board/modules/hoa-settings/model/hoaSettings.model.js` — `recurringFee.frequency`: monthly, quarterly, annually |
| Schedule generation / extension | `portals/hoa-board/modules/owners/services/invoiceScheduleMeta.service.js`, `unit.service.js` |
| Notifications | `invoiceScheduleNotify.service.js` |
| Late fees | Schedulers / `invoice.processor.js`, property late fee jobs |

Invoice generation, due dates, late fees, and partial-payment rules are **PropMV business logic**. Payload is invoked at **charge time** (manual pay-in execute or automatic payment on mirrored Payload invoice due date).

### Owner autopay (implemented behind flags)

| Piece | Location |
|-------|----------|
| Feature flags | `PAYLOAD_OWNER_AUTOPAY_ENABLED`, `VITE_PAYLOAD_OWNER_AUTOPAY_ENABLED` |
| Enrollment model | `OwnerPayloadAutopay` (`ownerPayloadAutopay.model.js`) — one row per owner + HOA |
| Mirror fields on PropMV invoice | `invoice.payloadAutopayMirror` (`payloadInvoiceId`, sync metadata) |
| Enrollment API | `GET/POST/PUT /api/v1/payments/payload/autopay*` (`payloadAutopay.service.js`) |
| **Invoice ownership scope (Autopay)** | `payloadAutopayInvoiceScope.util.js` — shared filter for next/last/sync/disable/daily + event-driven chargeability |
| Invoice mirror sync | `payloadInvoiceSync.service.js` — upsert/update/close Payload Invoice (`external_uid` = PropMV `_id`); charge line items updated **with Payload line item `id`**; `assertMirrorSafeForAutopay` blocks stale mirrors |
| Event-driven sync | `schedulePayloadAutopayMirrorSync` → `syncInvoiceIfOwnerEnrolled` from invoice create/update/delete/waive and gateway settle/fail |
| Pre-settle guard | `assertAutopaySettlementAmountAllowed` in `applyPayloadPayinLifecycle` (automatic only) — same card/ACH settle rules as manual pay |
| Payload client | `createInvoice`, `updateInvoice`, `getInvoice` on `payload.client.js` |
| Default PM | Payload `default_payment_method` via existing `updatePaymentMethodForUser` |
| Daily repair sync | `payloadAutopayInvoiceSyncScheduler.service.js` — **safety net only** (§17.5); uses same owner invoice scope as enable/backfill |
| Autopay status API | `nextAutopay` + `lastAutopayAttempt` on `GET /payments/payload/autopay`; enable requires `confirmAutopay: true` |
| Owner UI | `AutoPayCard.tsx` — confirmation checkbox, next charge, last attempt |

PropMV **does not** use Payload Billing Schedules. Each open PropMV invoice with balance gets its own mirrored Payload invoice when the owner is enrolled.

#### Autopay invoice ownership / chargeability (critical)

Owner Invoices list visibility uses **property universe** via `applyOwnerPayerInvoiceScope` → `resolveHoaOwnerInvoicePropertyIds` (assigned units + historical payer units). That list path intentionally does **not** require the owner on `tenants[]`.

Autopay **charging** reuses the same property universe but adds a mandatory payer gate. HOA invoices store `tenants` as **`[ObjectId]`** user refs (not `{ userId }`).

| Gate | Rule |
|------|------|
| Property universe | `resolveHoaOwnerInvoicePropertyIds(ownerId)` — same helper as Owner Invoices |
| HOA | `hoaId` = enrollment HOA |
| Chargeability | **`tenants: ownerOid`** — owner must be a stamped payer |
| Eligibility | `balanceDue > 0`, valid `dueDate`, not deleted, non-terminal status (`isInvoiceEligibleForAutopaySync`) |

**Do not** use property scope alone for Autopay (a co-owner on the same unit must not charge an invoice that only lists another owner in `tenants[]`).  
**Do not** query `'tenants.userId'` (invalid for HOA schema; historically caused `nextAutopay: null` while Upcoming invoices still appeared on the list).

Shared helpers: `buildOwnerAutopayInvoiceMongoFilter`, `isOwnerChargeableForAutopayInvoice`, `normalizeInvoiceTenantUserId` in `payloadAutopayInvoiceScope.util.js`. Applied consistently to `computeNextAutopayForOwner`, `computeLastAutopayAttemptForOwner`, `syncOpenInvoicesForOwner`, disable/cleanup, daily repair, and `syncInvoiceIfOwnerEnrolled`.

---

## 9. Webhooks & security

| Topic | Implementation |
|-------|----------------|
| URL | `POST /api/webhooks/payload` |
| Signing | **No documented HMAC** — do not rely on `PAYLOAD_WEBHOOK_SECRET` (see `payloadWebhookSignature.util.js`, `PAYLOAD_FOUNDATION.md`) |
| Trust | Idempotent store + **GET /transactions/{id}** (or processing account for `processing_status`) |
| Idempotency | `PayloadWebhookEvent.eventId` unique |
| Retry ops | `payloadWebhookRetry.service.js`, `POST .../operations/retry-webhooks` |
| Registered triggers (docs checklist) | `processed`, `decline`, `void`, `refund`, `reject`, `processing_status`, **`automatic_payment`** (autopay) |

---

## 10. Processing fees

- Not Rainforest splits; from **billing settings** (`billingSettings.service.js`, transaction fee config on HOA/operator).
- Validate/execute compute payer fee; charge amount includes fee when payer pays fee.
- Autopay mirror sync uses `calculatePayloadProcessingFee` when upserting Payload invoice line items (same billing settings as manual pay).

---

## 11. Other gateways (unchanged when Payload enabled)

| Provider | Notes |
|----------|--------|
| Rainforest | Parallel module under `providers/rainforest/`; disabled on frontend when Payload primary |
| Stripe / Straddle | Legacy owner/tenant paths; `CardsPage` legacy in `shared/pages/settings/` |

Do not break legacy flows when extending Payload.

---

## 12. Key scripts & tests

| Artifact | Purpose |
|----------|---------|
| `scripts/payload-register-applepay-domain.js` | Apple Pay domain registration (Payload API) |
| `scripts/payload-phase0-cross-processing-charge.js` | Sandbox cross-`processing_id` charge test |
| `payload*.test.js`, `*.node.test.js` | Unit/integration tests under payload provider |

---

## 13. Agent checklist (before changing payments)

1. Read **`PAYLOAD_FOUNDATION.md`** and this file.
2. Trace **validate → execute → webhook → settle** for any pay-in change.
3. Preserve **HOA unified wallet** + per-invoice **`processing_id`**.
4. Keep **ACH webhook-only** settlement behavior.
5. Extend webhooks idempotently; re-fetch remote transaction.
6. For UI work, mirror **`innago-inspired-refresh`** Payload components and env flags.
7. **Autopay**: read `roadmap-autopay.md`; production UI is **`AutoPayCard`** on the owner dashboard (not Billing Schedules).

---

## 14. Known gaps / limitations

- **`AutoPayPage.tsx`** (settings route) may still exist as legacy/mock; dashboard **`AutoPayCard`** is the production enrollment surface.
- Apple/Google Pay wallets are **not** eligible for autopay v1 (`AUTOPAY_ELIGIBLE_PAYMENT_METHOD_TYPES`: card + ACH only).
- End-to-end autopay requires Payload dashboard webhook subscription for **`automatic_payment`** and sandbox validation of fee-inclusive mirror amounts.
- PayHoA-imported `autopayEnabled` fields on units are unrelated to Payload enrollment.

---

*Last updated after Payload HOA owner autopay implementation. Align with `payload.routes.js` and `PAYLOAD_FOUNDATION.md` if code diverges.*
