# Payload Payments (PropMv)

Payload is the **preferred embedded gateway** when `PAYLOAD_ENABLED=true` / `VITE_PAYLOAD_ENABLED=true`. Rainforest remains available behind `RAINFOREST_ENABLED` but is not used when Payload is enabled on the frontend (`paymentProviderConfig`).

## Environment

### Backend

| Variable | Description |
| ---------- | ------------- |
| `PAYLOAD_ENABLED` | Master switch |
| `PAYLOAD_SECRET_KEY` | Server API key - HTTP Basic auth **username** with an **empty password** (`curl -u test_secret_key_xxx:`). Must be the **secret** key from the active Payload dashboard profile, not `PAYLOAD_CLIENT_KEY`. |
| `PAYLOAD_CLIENT_KEY` | **Deprecated for embeds** - do not pass to Payload.js; use ephemeral client tokens ([UI authentication](https://docs.payload.com/ui/authentication/)) |
| `PAYLOAD_MERCHANT_ONBOARDING_MODE` | `plugin` (default in sandbox), `api`, or `auto` |
| `PAYLOAD_ENVIRONMENT` | `sandbox` or `production` |
| `PAYLOAD_BASE_URL` | Default `https://api.payload.com` |
| `PAYLOAD_ORG_PROCESSING_ID` | Platform org processing account (parent) |
| `PAYLOAD_HOA_UNIFIED_OWNER_WALLET` | Default `true`. When `true`, HOA owners get one Payload Customer per community (`hoa:{hoaId}` scope). Set `false` to restore legacy single-merchant owner wallets. |
| `PAYLOAD_PHASE0_*` | Optional sandbox validation for cross-`processing_id` charges — see `scripts/payload-phase0-cross-processing-charge.js` |
| `PAYLOAD_TERMS_URL` | Terms link for payor UI |

**Do not set `PAYLOAD_WEBHOOK_SECRET`.** As of Payload’s public [Webhooks](https://docs.payload.com/apis/webhooks/) / [v2 Orchestrate](https://docs.payload.com/v2) docs, there is **no** documented inbound HMAC or signing-secret mechanism (unlike Rainforest `whsec_*`). Documented options are:

- Plain `POST` to your URL with `{ object, trigger, triggered_on }` ([triggers](https://docs.payload.com/apis/webhooks/triggers/))
- Optional **Webhook OAuth**: Payload obtains a token and sends it **in request headers to your URL** ([Webhook OAuth](https://docs.payload.com/apis/webhooks/oauth)) - you would validate that bearer token on PropMv, not a shared env secret mimicking Stripe/Rainforest

PropMv’s current approach until Payload publishes signing:

1. Accept webhook POST (CSRF-exempt route only).
2. Persist idempotently in `PayloadWebhookEvent`.
3. **Re-fetch** `triggered_on.id` via `GET /transactions/{id}` (or processing account for `processing_status`) using `PAYLOAD_SECRET_KEY` before updating invoices/ledger.
4. Use [WebhookLog](https://docs.payload.com/apis/object-reference/webhook-logs/) in the Payload dashboard for delivery debugging.

If you already added `PAYLOAD_WEBHOOK_SECRET` to `.env`, **remove it** - the middleware ignores it and logs a warning.

Webhook URL: `POST https://api.propmv.com/api/webhooks/payload`

Register Payload dashboard webhooks for: `processed`, `decline`, `void`, `refund`, `reject`, `processing_status`.

### Frontend

| Variable | Description |
| ---------- | ------------- |
| `VITE_PAYLOAD_ENABLED=true` | Enables Payload UI and owner pay |
| `VITE_PAYLOAD_ENVIRONMENT` | `sandbox` or `production` |
| `VITE_PAYLOAD_OWNER_WALLETS_ENABLED` | When `true` (default: same as `VITE_PAYLOAD_ENABLED`), owner **Cards** settings show **Apple Pay** and **Google Pay** on Payload [`payment_method_form`](https://docs.payload.com/ui/secure-input/) in addition to manual card entry. Set `false` to card-only. |
| `VITE_PAYLOAD_SCRIPT_URL` | Optional override for Payload.js CDN URL |

## Processing fees (HOA / landlord)

Fees are **not** Rainforest `amount_splits`. PropMv uses existing **billing settings** (`transactionFees` on HOA or landlord operator) via `billingSettings.service.js`. On pay-in, Payload transactions set:

- `amount` = net invoice amount (funds to merchant processing account)
- Payer processing fees are included in transaction `amount` (Payload `conv_fee` is readonly on transactions)

Board/landlord can change card % and ACH flat fee in billing settings; execute/validate endpoints enforce server-side totals.

### Owner invoice pay-ins (execute latency)

`POST .../payins/execute` creates a Payload `POST /transactions/` charge, then records a **Processing** row on the invoice (`paymentTransactions`) before responding. **Card** settlement to **Paid** (ledger + board Income) runs **asynchronously** after the HTTP response. **ACH / bank** never settles on execute - only Payload webhooks / `processed` events - so board Income stays **Processing** until funds are confirmed. Optional: `PAYLOAD_TIMEOUT_MS` (default `20000`) caps outbound Payload API wait time. The owner UI uses a **90s** axios timeout on execute (global axios default is 10s); without that override, the browser cancels at 10s while the server may still complete the charge.

Validate allocations (`POST .../payins/validate`) uses the same ledger rules as execute (FIFO, partial balances, unit ceiling) so owners see failures before Payload is called.

## Property deposit bank routing

Invoice pay-in resolves the **processing account** from the unit’s `depositBankAccountId` (local `PayloadDepositMethod` row) and sends Payload `processing_method_id` for deposit routing. HOA owners use a **unified community wallet** (`PAYLOAD_HOA_UNIFIED_OWNER_WALLET`, default `true`): one Payload Customer per owner per HOA; saved methods work across all HOA processing accounts; each charge sets `processing_id` from the invoice property. Landlord flows remain one merchant per operator.

## API surface

Mirror of Rainforest under `/api/v1/payments/payload/*` (merchants, deposit methods, payment methods, payins, refunds, ops).

### Business merchant onboarding (HOA board / landlord)

PropMv follows [Payload UI authentication](https://docs.payload.com/ui/authentication/): the **server** creates an ephemeral **`client` access token** with a **`processing_account_plugin`** intent; the browser loads `Payload.js` and calls `Payload(clientToken)` - **not** a static `PAYLOAD_CLIENT_KEY` on the script tag.

**Sandbox default (`PAYLOAD_MERCHANT_ONBOARDING_MODE=plugin`):**

1. `POST .../merchants/initialize` - creates a PropMv `PayloadAccount` **link row** (name + HOA/landlord scope only). Does **not** pretend a Payload processing account exists yet.
2. Response includes `onboarding.clientToken` (ephemeral).
3. User completes [Processing Account plugin](https://docs.payload.com/ui/processing-account-form/integrated-form/) → Payload creates the processing account (**visible in Payload dashboard**).
4. `POST .../merchants/:accountId/register-processing-account` - stores `processingAccountId`, re-fetches from Payload API, syncs status/deposit methods.

**Deposit banks:** Payload stores payout bank accounts as **`payment_methods`** with `type: bank_account` on the processing account (`GET /processing_accounts/{id}` or nested `.../payment_methods`). PropMv syncs those into local `PayloadDepositMethod` rows via `GET .../deposit-methods` (auto-sync when empty) or `POST .../deposit-methods/sync`.

**Processing activation (Payload vs PropMv):** Payload documents activation as an **underwriting workflow** - statuses move `incomplete` → `pending` → `active` (often ~24 business hours). There is **no public partner API** documented to force `active` in the Payload dashboard. Monitor changes with the [`processing_status` webhook trigger](https://docs.payload.com/apis/webhooks/triggers/) and `GET /processing_accounts/{id}`.

**Simulate active (PropMv sandbox only):** `POST .../merchants/:accountId/simulate-approval` attempts `PUT /processing_accounts/{id}` with `status=active`, then sets PropMv `onboardingStatus` to **ACTIVE** and `metadata.payloadSandboxSimulatedActive` so payins/onboarding can be tested. If Payload’s API keeps the remote status `pending`, PropMv still shows Active but the Payload dashboard may not - that is expected until Payload activates the account (production: webhook + API re-fetch update PropMv automatically).

**Production webhooks:** Register `processing_status` (and payment triggers as needed) to `POST /api/webhooks/payload`. PropMv re-fetches the processing account on each `processing_status` event before updating local merchant status and syncing deposit banks.

**Multiple payout banks:** A processing account exposes a **`payment_methods` list** ([ProcessingAccount object](https://docs.payload.com/apis/object-reference/processing-accounts/)); each `type: bank_account` entry can represent a payout bank. Use `default_deposit_method` on a payment method for the primary deposit route ([PaymentMethod object](https://docs.payload.com/apis/object-reference/payment-methods/)). PropMv syncs all bank methods, supports **Make primary**, and **Add bank** on active merchants via [`payment_method_form`](https://docs.payload.com/ui/authentication/) with `transfer_type: receive-only`.

Set `PAYLOAD_MERCHANT_ONBOARDING_MODE=api` only if your secret key is allowed to call `POST /processing_accounts/` server-side. `auto` tries API then falls back to plugin.

**HOA owner saved pay methods (cards + ACH):**

1. PropMv resolves the HOA’s active **`PayloadAccount`** (billable `processing_id`). With unified owner wallet enabled (`PAYLOAD_HOA_UNIFIED_OWNER_WALLET`, default on), owner saved methods also use a community **`PayloadUser`** scope (`hoa:{hoaId}`) and Payload [**Customer**](https://docs.payload.com/apis/customers/) `primary_processing_id` from a stable community default (deposit/property heuristic).
2. `POST .../payment-methods/initialize` ensures a local **`PayloadUser`**, creates or reuses a Payload customer (`POST /customers/` when missing) with that `primary_processing_id`, then mints a **`payment_method_form`** client token with `customer_id` and `transfer_type: send-only` (ACH adds `bank_account.account_class: personal` in the intent).
3. Owner completes Payload.js secure input (`pl-form="payment_method"`) - card or bank fields per [Secure Input](https://docs.payload.com/ui/secure-input/). When `VITE_PAYLOAD_OWNER_WALLETS_ENABLED` is on, the same form mounts [Google Pay](https://docs.payload.com/ui/payloadjs/google-pay/) and [Apple Pay](https://docs.payload.com/ui/payloadjs/apple-pay/) buttons; Payload hides each button when the browser/device does not support it. Saved wallet methods appear in the card list like manual cards.
4. `POST .../payment-methods/register` stores the returned `pm_…` id locally; list via `GET .../payment-methods`.
5. Pay-ins charge via `POST /transactions` with `customer_id`, `payment_method_id`, `processing_id`, and `amount` (invoice net + payer fee when applicable; do not send `conv_fee` on create). Optional `processing_method_id` for property deposit bank routing. See [Charge Customer](https://docs.payload.com/apis/payments/charging-a-customer/) (`payloadPayin.service.js`, `payloadPayinCharge.util.js`).

Owner UI: HOA Settings → Bank Accounts / Cards (`PayloadPaymentMethodsPanel`). Rainforest and legacy Stripe/Straddle paths remain when Payload is disabled.

### Owner payment methods: Payload vs Rainforest

| Method | Payload (owner Cards) | Rainforest (owner Cards) |
| -------- | ------------------------ | --------------------------- |
| Manual card (Secure Input) | Yes | Yes |
| Apple Pay | Yes (`payment_method_form` + Payload.js) | Yes |
| Google Pay | Yes | Yes |
| PayPal / Venmo / Pay Later | **No** - not on Payload.js Secure Input; use Rainforest or Payload [Checkout](https://docs.payload.com/ui/checkout/) redirect if product adds it later | Yes |

Initialize `allowedMethods` for Payload owner cards: `APPLE_PAY,CARD` when wallets are enabled (`resolveOwnerPayloadCardAllowedMethods()` in the frontend). PayPal/Venmo strings are Rainforest-only and are not passed to Payload setup.

## Vendor electronic payments

### Phase 0 — Sandbox architecture gates (verified)

See [`phase0-vendor-payload-sandbox-gates.md`](./phase0-vendor-payload-sandbox-gates.md) and `scripts/phase0-vendor-payload-sandbox-gates.js`.

| Capability | Sandbox result |
| --- | --- |
| Processing Account create (API) | Pass |
| Multiple `receive-only` bank PMs on one PA | Pass |
| Owner Customer (`primary_processing_id` = HOA PA) charges **different** Vendor PA | Pass |
| Board Customer charges Vendor PA | Pass |
| `processing_method_id` = Vendor `default_deposit_method` bank | Pass |
| `transfer_type` update receive-only → two-way | Does not apply (PM stays receive-only) |
| HOA Treasury `credit` / HOA two-way banks | **Not implemented / not in v1 scope** |

**Approved v1 money movement (after Phase 2+ product work):**  
Owner or Board Customer `send-only` PM → `type=payment` → `processing_id=Vendor_PA` → Vendor receiving bank via `processing_method_id` / `default_deposit_method`.

### Phase 1 — Vendor Processing Account onboarding (product)

**Implemented:** Yes (feature-flagged). See [`phase1-vendor-payload-onboarding.md`](./phase1-vendor-payload-onboarding.md).

| Item | Detail |
| --- | --- |
| Flag (API) | `PAYLOAD_VENDOR_MERCHANT_ENABLED` (requires `PAYLOAD_ENABLED`) |
| Flag (UI) | `VITE_PAYLOAD_VENDOR_MERCHANT_ENABLED` |
| Model | `PayloadAccount` with `entityType=vendor`, `entityId=createdBy=vendorUserId` |
| Mapping | `externalId=payload_vendor_{userId}` (one PA per Vendor) |
| UI | Vendor Portal → Settings → Bank Accounts (Payload hub when flag on; Straddle when off) |
| Payments | **Not** implemented (Phase 3+) |
| Webhooks live delivery | **Not** production-verified (Phase 8 gate) |

### Phase 2 — Vendor deposit banks (product)

**Implemented:** Yes (feature-flagged). See [`phase2-vendor-payload-deposit-banks.md`](./phase2-vendor-payload-deposit-banks.md).  
**Verification status:** **COMPLETE** (2026-10-09) — live Atlas + Payload Sandbox gates passed (`scripts/phase2-vendor-payload-deposit-banks-gates.js`).

| Item | Detail |
| --- | --- |
| Banks | Multiple Payload bank PMs under Vendor PA (`receive-only`) |
| Primary | Payload `default_deposit_method` (source of truth); `isPrimaryPayout` / `defaultDepositMethod` local mirrors |
| Persistence | `pm_…`, status, `verificationStatus`, `transferType` on `PayloadDepositMethod` |
| Security | Vendor flag on every deposit op; cross-account `pm_` → 409; Vendor ownership access |
| UI | Same merchant bank panels; `hoaSideEffects={false}` for Vendor |
| Straddle | Untouched when flag off |
| Payments | **Not** implemented (Phase 3+) |

**Hard gates still in force:** production electronic Vendor pay requires eligible/ACTIVE Vendor PA; card billing address required; PropMV idempotency primary; no HOA treasury/credit; no receive-only→two-way HOA banks; no Primary Bank or HOA Owner→HOA routing changes; no Straddle destructive migration.
