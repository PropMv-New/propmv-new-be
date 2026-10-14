# Rainforest Foundation (Phase 1–3F Production)

Rainforest is introduced as a **parallel payment provider** alongside existing Stripe and Straddle integrations. Phase 1 covers merchant onboarding, payor saved payment methods, and webhook infrastructure. Phase 2 adds deposit bank listing, sync, add-bank component flow, and merchant detail pages. **Phase 3A** adds HOA owner invoice payins from stored Rainforest payment methods. **Phase 3B** wires owner pay dialogs to Rainforest payins. **Phase 3C** adds multi-merchant deposit routing validation and invoice payment status tracking. **Phase 3D** adds board refunds/voids. **Phase 3E** routes PropMv processing fees to the Rainforest platform via amount splits.

Legacy Stripe (cards) and Straddle (ACH) flows remain unchanged when `RAINFOREST_ENABLED` / `VITE_RAINFOREST_ENABLED` are off.

## Environment variables

### Backend (`propmv/.env`)

| Variable | Required | Description |
| ---------- | ---------- | ------------- |
| `RAINFOREST_ENABLED` | Yes | `true` to enable Rainforest APIs |
| `RAINFOREST_API_KEY` | Yes | Secret API key (server only) |
| `RAINFOREST_PLATFORM_ID` | Yes (Phase 2) | Platform id for deposit method configs (`plt_*` / `sbx_plt_*`) |
| `RAINFOREST_ENVIRONMENT` | Yes | `sandbox` or `production` |
| `RAINFOREST_WEBHOOK_SECRET` | Yes* | Webhook HMAC secret |
| `RAINFOREST_WEBHOOK_SIGNING_KEY` | Alt | Alias for webhook secret |
| `RAINFOREST_BASE_URL` | No | Override API base URL (sandbox: `https://api.sandbox.rainforestpay.com`) |
| `RAINFOREST_TERMS_URL` | Recommended | Terms URL for merchant onboarding component |
| `RAINFOREST_DEFAULT_BILLABLE_MERCHANT_ID` | Deprecated | Not used; billable merchant is resolved from Active HOA/landlord merchants |
| `RAINFOREST_SESSION_TTL_SECONDS` | No | Component session TTL (default 3600) |
| `RAINFOREST_TIMEOUT_MS` | No | HTTP client timeout |
| `RAINFOREST_OPS_CRON_ENABLED` | No | `true` (default) - background webhook retry worker |
| `RAINFOREST_WEBHOOK_RETRY_INTERVAL_MS` | No | Retry poll interval (default 5 min) |
| `RAINFOREST_WEBHOOK_RETRY_MAX` | No | Max retries per failed webhook (default 5) |
| `RAINFOREST_WEBHOOK_RETRY_BATCH_SIZE` | No | Events per retry batch (default 25) |

### Frontend (`innago-inspired-refresh/.env.local`)

| Variable | Description |
|----------|-------------|
| `VITE_RAINFOREST_ENABLED=true` | Shows Rainforest UI panels |
| `VITE_RAINFOREST_ENVIRONMENT=sandbox` | Selects Rainforest JS bundle |

## API endpoints

| Method | Path | Purpose |
| -------- | ------ | --------- |
| GET | `/api/v1/payments/rainforest/config` | Public feature flag / non-secret config |
| GET | `/api/v1/payments/rainforest/merchants` | List Rainforest business accounts for entity |
| POST | `/api/v1/payments/rainforest/merchants/initialize` | Create Rainforest merchant for entity |
| GET | `/api/v1/payments/rainforest/merchants/status` | Merchant onboarding status |
| POST | `/api/v1/payments/rainforest/merchants/onboarding-session` | Component session for merchant onboarding |
| POST | `/api/v1/payments/rainforest/merchants/:accountId/simulate-approval` | Sandbox only - approve merchant so payors can save payment methods |
| GET | `/api/v1/payments/rainforest/merchants/:accountId` | Merchant detail (status + deposit summary) |
| GET | `/api/v1/payments/rainforest/merchants/:accountId/deposit-methods` | List cached deposit banks |
| POST | `/api/v1/payments/rainforest/merchants/:accountId/deposit-methods/sync` | Pull deposit banks from Rainforest |
| POST | `/api/v1/payments/rainforest/merchants/:accountId/deposit-methods/initialize` | Deposit bank setup session - returns `flow: hub | onboarding | blocked` based on merchant status |
| POST | `/api/v1/payments/rainforest/merchants/:accountId/deposit-methods/register` | Register deposit method from component |
| POST | `/api/v1/payments/rainforest/merchants/:accountId/deposit-methods/:depositMethodId/set-primary` | Set PAYMENTS deposit route |
| POST | `/api/v1/payments/rainforest/payment-methods/initialize` | Payment method config + component session |
| POST | `/api/v1/payments/rainforest/payment-methods/register` | Persist Rainforest payment method id locally |
| GET | `/api/v1/payments/rainforest/payment-methods` | List user's Rainforest payment methods |
| POST | `/api/v1/payments/rainforest/payins/validate` | Pre-validate FIFO allocations (merchant routing, payment method match) |
| POST | `/api/v1/payments/rainforest/payins/execute` | Execute HOA invoice payin from stored payment method |
| GET | `/api/v1/payments/rainforest/payins/:payinId` | Read local + refreshed Rainforest payin status |
| POST | `/api/v1/payments/rainforest/refunds/request` | Board-initiated Rainforest void/refund |
| GET | `/api/v1/payments/rainforest/refunds/:refundId` | Read Rainforest refund status |
| GET | `/api/v1/payments/rainforest/operations/reconciliation` | HOA-scoped payin vs invoice vs ledger scan |
| POST | `/api/v1/payments/rainforest/operations/retry-webhooks` | Administrator - retry failed webhook events |
| POST | `/api/webhooks/rainforest` | Webhook ingress (signature verified, idempotent) |

## Resource mapping

| PropMv | Rainforest |
| -------- | ------------ |
| Landlord / HOA entity (`RainforestAccount`) | Merchant + Merchant Application |
| Merchant deposit bank (`RainforestDepositMethod`) | Deposit Method (`dmt_*`) |
| Tenant / HOA Owner user (`RainforestUser` context) | Payment method config scope |
| Saved method (`RainforestPaymentMethod`) | Payment Method |
| Invoice payin (`RainforestPayin`) | Payin (`pyi_*`) |
| Webhook audit (`RainforestWebhookEvent`) | Incoming webhook events |

## Webhook coverage

Prefix-based handlers (extensible for future payin/refund events):

- `merchant.*` → updates merchant status and syncs deposit methods from webhook payload
- `merchant_application.*` → updates application status and syncs deposit methods
- `deposit_method.*` → updates local `RainforestDepositMethod` cache
- `payment_method.*` → creates/updates `RainforestPaymentMethod` display metadata and status

## Local development

1. Set backend Rainforest sandbox credentials and `RAINFOREST_ENABLED=true`.
2. Set `VITE_RAINFOREST_ENABLED=true` in the frontend env.
3. Configure Rainforest dashboard webhook URL: `POST /api/webhooks/rainforest`.
4. Landlord/HOA board: **Settings → Payment → Business accounts** → Rainforest panel.
5. Tenant/Owner: **Settings → Payment → Cards / Bank accounts** → Rainforest panels.

## Payor saved cards and bank accounts

Owners and tenants store **payment methods** (not deposit methods) against an **Active** Rainforest merchant (`billable_merchant_id`). Rainforest rejects payment method storage until the merchant application is approved.

**Cards settings** (`allowedMethods=CARD`) also enables digital wallets in the Rainforest component: `APPLE_PAY`, `PAYPAL_WALLET`, `VENMO`, and `PAYPAL_PAYLATER`. Saved wallets appear in the owner pay dialog alongside cards and use the same server-side payin path. Bank accounts (`allowedMethods=ACH`) are unchanged.

Resolution order in PropMv:

1. Any **Active** Rainforest business merchant for the owner’s HOA (`metadata.hoaId` matches the owner’s HOA id). If the board has multiple merchants, **any one** that is Active is enough.
2. For landlords/property managers: any **Active** merchant for that entity scope.

PropMv does **not** use a hardcoded merchant id from `.env` for HOA owners or tenants.

**Sandbox:** After submitting merchant onboarding, the application stays `Processing` until you simulate approval:

- HOA board → **Settings → Business accounts** → **Simulate approval** on the under-review merchant, or
- `POST /api/v1/payments/rainforest/merchants/:accountId/simulate-approval`

Then owners/tenants can use **Add payment method** on Cards / Bank accounts settings pages.

## Multiple business accounts

Rainforest merchant onboarding mirrors Straddle's multi-account model:

- Each **Add Rainforest business** creates a new PropMv `RainforestAccount` and a new Rainforest merchant.
- HOA board members are scoped by `createdBy` + `metadata.hoaId` (same as Straddle).
- Landlords are scoped by `businessId`.
- Rainforest requires globally unique merchant names; PropMv sends a unique internal name while displaying your chosen `accountName`.
- Deposit bank accounts are collected during onboarding and can be added later based on merchant status:
  - **Active** merchants → Rainforest **merchant hub** component (`rainforest-merchant-hub`)
  - **Created / onboarding / needs information** → editable merchant onboarding (Deposit / Payout step)
  - **Processing / in review** → locked until Rainforest approves or requests more information (read-only review only)
- During onboarding/review, Rainforest may store the bank on the **merchant application** before it appears on the merchant `deposit_routes`; PropMv sync reads both.
- **`RAINFOREST_PLATFORM_ID`** is PropMv’s single Rainforest platform id (`sbx_plt_*` / `plt_*`). All merchants belong to this one platform; each merchant has its own `merchant_id`, not its own platform id.

## Frontend routes (business accounts)

| Route | Purpose |
|-------|---------|
| `.../rainforest/onboarding/:accountId` | Rainforest merchant onboarding component |
| `.../rainforest/:accountId` | Merchant detail + linked deposit banks + add bank |

If upgrading from the first Rainforest schema, drop the old Mongo unique index if present:

```js
db.rainforestaccounts.dropIndex("businessId_1_entityType_1_entityId_1")
```

- `payment_method.*` → creates/updates `RainforestPaymentMethod` display metadata and status
- `payin.*` → updates `RainforestPayin`, settles/fails HOA invoice processing payments

## Phase 3A - HOA owner invoice payins

### Execute payin

`POST /api/v1/payments/rainforest/payins/execute`

```json
{
  "invoiceId": "665f0c1cb59290eb87a6ae1d",
  "invoicePaymentAmount": 150.00,
  "chargeAmount": 154.50,
  "paymentMethodId": "665f0c1cb59290eb87a6ae1e",
  "paymentAttemptId": "attempt-uuid-123",
  "description": "Invoice #INV123456 – HOA payment"
}
```

- `invoicePaymentAmount` - net amount applied to the invoice (USD dollars)
- `chargeAmount` - total Rainforest payin amount including processing fees (optional; defaults to invoice amount)
- `paymentMethodId` - local `RainforestPaymentMethod` id or Rainforest `mtd_*` id
- Idempotent on `(user, invoice, paymentAttemptId)`

Flow mirrors Straddle ACH:

1. Validate FIFO / outstanding rules via `assertOwnerOnlinePaymentAllowed`
2. Create Rainforest payin config + payin from stored payment method
3. Persist `RainforestPayin` audit row
4. Mark invoice `Processing` via `initiateInvoiceProcessingPayment`
5. Apply settlement policy (below) from API response and `payin.*` webhooks

### Settlement policy (production)

| Method | Settle invoice + ledger | Fail invoice |
|--------|-------------------------|--------------|
| Card / Apple Pay | `payin.processing` (approved quickly; matches prior Stripe UX) | `payin.failed`, `payin.canceled` |
| ACH / Plaid ACH | `payin.succeeded` only (conservative; funds committed for deposit) | `payin.failed`, `payin.returned`, `payin.canceled`, or `payin.succeeded` with `has_ach_return` |

Merchant resolution:

1. Unit `depositBankAccountId` → `RainforestDepositMethod` → merchant (when mapped)
2. Otherwise payment method `billableMerchantId`
3. Payment method merchant must match deposit-bank merchant when unit bank is mapped

Funds settle to the merchant's Rainforest `deposit_routes.PAYMENTS` bank on Rainforest's normal deposit schedule (T+1 card, T+4 ACH by default).

## Phase 3B - Frontend owner pay flow

When Rainforest is enabled (`VITE_RAINFOREST_ENABLED=true` and backend config enabled):

- `PayableNowCard` and `OwnerPaymentDialog` load Rainforest saved payment methods via `useOwnerPaymentInstruments`
- OTP verify → checkout → one Rainforest payin per FIFO allocation line
- Idempotency key: `${paymentAttemptId}:${invoiceId}`
- 409 duplicate attempts are treated as already submitted (refresh balances)

Legacy Stripe card / Straddle ACH paths remain when Rainforest is disabled.

## Phase 3C - Multi-merchant routing + status tracking

### Pre-pay validation

`POST /api/v1/payments/rainforest/payins/validate`

```json
{
  "paymentMethodId": "665f0c1cb59290eb87a6ae1e",
  "allocations": [
    { "invoiceId": "665f0c1cb59290eb87a6ae1d", "invoicePaymentAmount": 150.00 }
  ]
}
```

Returns `{ valid, merchantId, merchantCount, allocations, issues }`. Rejects when:

- Any invoice cannot resolve a merchant
- Payment method merchant does not match unit deposit bank merchant
- FIFO allocations span **multiple** Rainforest merchants (pay separately)

Frontend calls validate before executing payins.

### Invoice payment status enrichment

`getInvoiceById` and `GET /invoices/:id/payment-transactions` enrich each payment transaction with:

- `straddleData` - existing Straddle webhook history (unchanged)
- `rainforestData` - Rainforest payin status history for HOA board `TransactionStatusTracker`

Matching uses `gatewayTransactionId` (local `RainforestPayin._id`), `gatewayExternalId` (`payinId`), then amount fallback.

## Phase 3D - Board refunds / voids

Board-initiated void/refund of Rainforest gateway payments. Stripe/Straddle flows and manual payment delete behavior are unchanged.

### Request refund

`POST /api/v1/payments/rainforest/refunds/request`

```json
{
  "invoiceId": "665f0c1cb59290eb87a6ae1d",
  "paymentTransactionId": "665f0c1cb59290eb87a6ae1f",
  "amount": 150.00,
  "reason": "REQUESTED_BY_CUSTOMER",
  "refundAttemptId": "refund-attempt-uuid"
}
```

- Board / property manager only (HOA membership scoped to invoice `hoaId`)
- `amount` optional - defaults to remaining refundable balance on the payment row
- In-flight (`processing`) Rainforest payments can only be **voided in full** (Rainforest void rules)
- Settled payments support full or partial refunds
- Idempotent on `(user, invoice, paymentTransactionId, refundAttemptId)`
- Blocks duplicate in-flight refunds for the same payment row

Flow:

1. Resolve local `RainforestPayin` from invoice payment transaction
2. Call Rainforest `POST /v1/payins/{payin_id}/void_or_refund`
3. Persist `RainforestRefund` audit row
4. On `refund.succeeded` webhook → `reverseInvoiceGatewayPayment` restores invoice balance + ledger adjustment
5. On processing payin void → existing `payin.canceled` webhook still calls `failInvoiceGatewayPayment`

### Poll refund status

`GET /api/v1/payments/rainforest/refunds/:refundId`

Accepts local Mongo id or Rainforest `rfd_*` id.

### Invoice payment row fields

Payment transactions track partial/full reversals:

- `refundedAmount` - cumulative invoice amount restored
- `refundedAt` - set when fully refunded
- `refundExternalId` - latest Rainforest refund id

Invoice enrichment adds optional `rainforestData.refund` summary for the payments table UI.

## Phase 3E - Platform fee splits

PropMv processing fees (from HOA billing settings) route to the Rainforest **platform** via `amount_splits` on payin config. Stripe/Straddle fee handling is unchanged.

### Payin fee policy

| Billing setting | Payin charge | PLATFORM split |
| ----------------- | ------------- | ---------------- |
| Payer pays card/ACH fee | Invoice amount + fee | Fee amount (flat PLATFORM split) |
| Operator absorbs fee | Invoice amount only | None |

Backend is authoritative:

1. Loads effective billing settings for the invoice unit
2. Validates `chargeAmount` on execute matches configured fee math
3. Adds `amount_splits` with `amount_split_reversal_config.on_full_refund` and `on_ach_return` when payer fee applies
4. Persists `processingFeeAmount`, `processingFeePaidBy`, `platformFeeCents` on `RainforestPayin`

### Pre-pay fee quote

`POST /api/v1/payments/rainforest/payins/validate` now returns per-allocation:

- `invoicePaymentAmount`
- `processingFeeAmount` (fee applies to first allocation only in FIFO batches)
- `processingFeePaidBy`
- `chargeAmount`
- `platformFeeCents`

Frontend pay dialogs should use these values when present.

### Refund split reversal

- **Full refund:** Rainforest `amount_split_reversal_config` on the original payin returns platform fee to merchant
- **Partial refund:** Refund API includes proportional PLATFORM `amount_splits` via `buildRainforestRefundAmountSplits`

### Merchant deposit transparency

When embedding Rainforest's Deposit Report Component, configure an activity column:

```json
{ "name": "Platform Fees", "type": "builtin", "value": "split_remainder_amount" }
```

## Phase 3F - Production hardening

Operational reliability improvements that keep Stripe/Straddle/manual payment flows unchanged.

### Stripe card → ledger parity

Successful synchronous Stripe card charges now mirror Rainforest/Straddle settlement:

1. Invoice payment row includes `gatewayTransactionId` (local `StripePayment._id`)
2. `ledgerService.recordPayment` runs once per PaymentIntent (idempotent on `metadata.gatewayExternalId`)
3. Unapplied credit is re-applied to due invoices on the unit

### Rainforest reconciliation scan

`GET /api/v1/payments/rainforest/operations/reconciliation?hoaId=<id>`

Board / property manager scoped. Compares recent Rainforest payins for the HOA against:

- Completed invoice `paymentTransactions`
- Invoice-linked ledger payment rows
- Failed webhook events for scanned payin resource ids

Issue codes include:

| Code | Meaning |
| ------ | --------- |
| `payin_settled_missing_invoice_tx` | Payin succeeded but invoice has no completed gateway row |
| `payin_settled_missing_ledger` | Payin succeeded but no matching ledger payment entry |
| `invoice_tx_amount_mismatch` | Completed invoice amount ≠ payin net amount |
| `payin_returned_still_completed` | ACH return/chargeback but invoice still completed |
| `payin_in_review_stale` | `IN_REVIEW` longer than threshold (default 72h) |
| `payin_processing_stale` | `PROCESSING` longer than threshold (default 168h) |
| `webhook_failed` | Failed webhook event tied to a scanned payin |

Response includes `issues[]` and `summary.byCode`.

### Webhook retry worker

Failed `RainforestWebhookEvent` rows (`processingStatus: failed`) are retried automatically when Rainforest is enabled:

- Started from `server.js` via `rainforestOperationsCronJob`
- Controlled by `RAINFOREST_OPS_CRON_ENABLED` (default on)
- Manual batch: `POST /api/v1/payments/rainforest/operations/retry-webhooks` (Administrator only)

### ACH return / in-review alerting

Payin lifecycle emits dedicated audit events:

- `RAINFOREST_PAYIN_IN_REVIEW` - manual Rainforest review required
- `RAINFOREST_PAYIN_RETURNED` - ACH return or chargeback signal (`has_ach_return`)

These appear in the Rainforest audit stream and server logs for support triage.

### Runbook - `payin.in_review`

1. Open invoice → **Transaction status** tracker for the Rainforest payment row.
2. Poll `GET /api/v1/payments/rainforest/payins/:payinId` for current Rainforest status.
3. Check Rainforest dashboard / support for the payin id (`pyi_*`).
4. Do **not** delete the invoice payment row manually while status is `IN_REVIEW`.
5. When Rainforest resolves to `SUCCEEDED` or `FAILED`, webhooks (or retry worker) will settle or fail the invoice automatically.
6. If webhooks remain failed, run reconciliation for the HOA and optionally trigger administrator webhook retry.

### Runbook - reconciliation mismatch

1. `GET .../operations/reconciliation?hoaId=<hoaId>&since=<iso-date>`
2. For `payin_settled_missing_invoice_tx` / `payin_settled_missing_ledger`: confirm payin id on invoice payment row, then re-process webhook or contact Rainforest support with payin id.
3. For `payin_returned_still_completed`: board refund flow (Phase 3D) or wait for `failInvoiceGatewayPayment` webhook.
4. For `webhook_failed`: administrator retry endpoint or wait for cron; inspect `RainforestWebhookEvent.error`.

## Out of scope (future phases)

- Autopay execution (Rainforest), reconciliation dashboards UI
- Stripe/Straddle migration or decommissioning
