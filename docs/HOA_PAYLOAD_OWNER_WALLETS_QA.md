# HOA Owner Payload Wallets (Apple Pay / Google Pay) — QA

Scope A: saved wallets via `payment_method_form`, unified owner add dialog, invoice pay with saved Apple/Google methods. Rainforest / Straddle / Stripe unchanged.

## Prerequisites

- `VITE_PAYLOAD_ENABLED=true`
- `VITE_PAYLOAD_OWNER_WALLETS_ENABLED=true` (defaults on when Payload enabled)
- HOA owner linked to community with board-member Payload processing account
- **Google Pay (Payload + Google — required before the button activates)**
  1. [Google Pay Account Activation](https://docs.payload.com/ui/mobile-wallets/activation/google-pay-activation/) — register business in [Google Pay Business Console](https://pay.google.com/business/console), add your **website origin** (e.g. `https://owner.propmv.com` or dev URL) as Gateway integration, get approval.
  2. Payload dashboard → **Settings → Features & Add-ons → Google Pay** → enter **Google Pay Merchant ID**.
  3. Processing account for the HOA board member must be **`active`** ([processing activation](https://docs.payload.com/apis/processing-accounts/processing-activation/)).
  4. Owner: Chrome, signed into Google, card in Google Pay; avoid incognito.
- **Apple Pay**
  1. [Apple Pay Account Activation](https://docs.payload.com/ui/mobile-wallets/activation/apple-pay-activation/) — host Payload’s file at `https://owner.propmv.com/.well-known/apple-developer-merchantid-domain-association` (source: `innago-inspired-refresh/public/.well-known/`; deploy owner frontend + nginx `spa-static-locations.conf` `^~ /.well-known/` block).
  2. Confirm URL is **not** HTML: `node scripts/payload-register-applepay-domain.js --domain owner.propmv.com --verify-url-only` (from `propmv/`).
  3. Register domain via API (processing account id = `profile_id`):  
     `node scripts/payload-register-applepay-domain.js --profile-id acct_XXXX --domain owner.propmv.com`
  4. Payload dashboard → **Settings → Features & Add-ons → Apple Pay** — complete verification if prompted.
  5. Owner: **Safari** on Mac/iPhone/iPad with Apple Pay in Wallet (not Chrome on desktop).

## Settings — Payment Methods (owner `/settings/cards`)

| # | Case | Expected |
|---|------|----------|
| 1 | Add → Card | Manual card + billing; registers as `CARD` |
| 2 | Add → Bank Account / ACH | ACH form; existing ACH behavior |
| 3 | Add → Apple Pay (Safari / supported device) | Apple button visible; saves as `APPLE_PAY` |
| 4 | Add → Apple Pay (unsupported browser) | Help text; no broken button |
| 5 | Add → Google Pay (Chrome / supported) | Google button visible; saves as `GOOGLE_PAY` |
| 6 | List grouping | Sections: Cards, Apple Pay, Google Pay, Bank / ACH |
| 7 | Delete wallet | Removed locally + Payload deactivate |
| 8 | Regression: existing saved card | Still listed and editable |
| 9 | Regression: existing ACH | Still listed under Bank / ACH |

## Invoice pay (`OwnerPaymentDialog`)

| # | Case | Expected |
|---|------|----------|
| 10 | Pay with saved card | `payins/validate` + `payins/execute`; webhook confirms |
| 11 | Pay with saved Apple Pay | Same payin path; card-like fee/settlement |
| 12 | Pay with saved Google Pay | Same payin path; card-like fee/settlement |
| 13 | Pay with ACH | Unchanged ACH settlement (SUCCEEDED) |
| 14 | Failed / declined payin | Invoice not marked paid from UI alone |
| 15 | No saved methods | Prompt to add payment method |

## Backend / webhooks

| # | Case | Expected |
|---|------|----------|
| 16 | Duplicate webhook | Idempotent `PayloadWebhookEvent`; no double ledger |
| 17 | Ledger + invoice | Same helpers as card pay after re-fetch |

## Automated tests

**propmv:** `node --test src/shared/modules/payment/providers/payload/utils/payloadPaymentMethodType.util.test.js src/shared/modules/payment/providers/payload/utils/payloadPayinSettlement.util.test.js`

**innago-inspired-refresh (Node 22+):** `npx vitest run src/portals/hoa-board/utils/__tests__/ownerPayloadPaymentMethodPartition.test.ts src/shared/components/payload/__tests__/payloadPaymentMethodTypes.test.ts src/shared/components/widgets/__tests__/OwnerPayloadPayMethodSelect.test.ts`
