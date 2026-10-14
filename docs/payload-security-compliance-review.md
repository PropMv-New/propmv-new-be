# PropMv ↔ Payload — Security & Compliance Review (for Payload)

**Purpose:** Share with Payload for production security/compliance review of PropMv’s current integration.  
**Scope:** Based on the **current codebase and UI** only. No business logic changes.  
**Repos:** PropMv backend (`propmv`) + owner/board frontend (`innago-inspired-refresh`).  
**Date:** 2026-03-25  

**Legend**

| Label | Meaning |
| ----- | ------- |
| **Current PropMv copy** | Verbatim (or lightly abbreviated) text in PropMv UI today |
| **Recommended PropMv copy** | Proposed PropMv wording pending Payload confirmation — **not** claimed as legally required |
| **Payload confirmation required** | Exact wording, disclosures, or behavior we need Payload to approve or supply |

---

## 1. Payment use cases

### 1.1 Roles

| Role | Who in PropMv | Payload object |
| ---- | ------------- | -------------- |
| **Merchant / processing account holder** | HOA Board Member, Property Manager, or Landlord who creates/manages a Payload **processing account** to receive property-related payments | `processing_account` (`acct_…`), local `PayloadAccount` |
| **Payer** | HOA Owner (and tenant-adjacent flows using the same APIs) paying invoices/dues | Payload `customer` + `payment_method` (`pm_…`) |
| **Platform** | PropMv orchestrates onboarding, wallets, charges, webhooks, ledger/invoice settlement, autopay, Check21 | Platform org via `PAYLOAD_ORG_PROCESSING_ID` when set |

### 1.2 What is collected

- HOA / property invoices and balances (dues, fees, related charges).
- **Owner instruments:** ACH bank (`send-only`, `account_class: personal`), card, Apple Pay / Google Pay (wallet save via Payload.js; autopay v1 = card/ACH/Plaid ACH only).
- **Merchant deposit banks:** `receive-only`, `account_class: business`, synced to local `PayloadDepositMethod` and assigned per property for settlement routing.
- Sensitive PAN/full account numbers are **not** stored by PropMv; local mirrors keep display metadata (brand/last4/exp/bankName/holder/routing display) + Payload IDs.

### 1.3 How payment methods associate to processing accounts

- **Unified HOA owner wallet** (default `PAYLOAD_HOA_UNIFIED_OWNER_WALLET=true`): one Payload Customer per owner per HOA; saved methods reusable across the community.
- Each **charge** sets `processing_id` (and optional `processing_method_id`) from the invoice property’s linked deposit bank / merchant account.
- Owner customer is bound at create time via `primary_processing_id`; payment-method create uses `customer_id` (not `processing_id` on the PM body).

### 1.4 Flows currently supported in code

| Flow | Status | Summary | Key paths |
| ---- | ------ | ------- | --------- |
| Merchant onboarding | Live (mode-dependent) | Plugin create (`processing_account_plugin`) and/or API + hosted **application_link**; status sync via webhooks / refresh | `payloadMerchant.service.js`, `PayloadMerchantOnboardingPage.tsx`, `PayloadProcessingAccountForm.tsx`, `PayloadApplicationLinkEmbed.tsx` |
| Deposit / payout bank | Live | Secure Input receive-only bank or hosted application Deposit/Payout step; primary + property routing | `payloadDepositMethod.service.js`, `PayloadAddDepositBankDialog.tsx`, `PayloadLinkedBanksPanel.tsx` |
| Owner PM save (card/ACH/wallets) | Live | Ephemeral client token + Payload.js Secure Input / Plaid / Apple/Google Pay | `payloadPaymentMethod.service.js`, `PayloadPaymentMethodForm.tsx`, `PayloadPaymentMethodsPanel.tsx` |
| One-time invoice pay | Live | Server `POST /transactions/` (`type: payment`); card settles earlier than ACH per settlement util | `payloadPayin.service.js`, `OwnerPaymentDialog.tsx`, `PayableNowCard.tsx` |
| Settlement / ledger | Live | Webhook re-fetch → invoice settle / fail / reverse | `payloadWebhook.service.js`, `payloadPayinSettlement.util.js` |
| Refund / void | Live (board) | Void or refund transaction | `payloadRefund.service.js` |
| Autopay | **Feature-flagged off by default** (`PAYLOAD_OWNER_AUTOPAY_ENABLED`) | Mirror Payload invoices (`autopay_allowed`); charges via `automatic_payment` webhook; enrollment requires `confirmAutopay: true` | `payloadAutopay.service.js`, `AutoPayCard.tsx` |
| Check21 | **Feature-flagged off by default** (`PAYLOAD_CHECK21_ENABLED`) | Board “Upload Check”: multipart front/back → `source=check` transaction | `payloadCheck21Payin.service.js`, `RecordPaymentDialog.tsx`, `Check21ImageUpload.tsx` |

### 1.5 Production compliance / security considerations (observed in code)

| Topic | Current PropMv behavior | Notes for Payload |
| ----- | ----------------------- | ----------------- |
| PCI / sensitive data | Payload.js Secure Inputs (`pl-input` iframes); PropMv never stores full card/account numbers | Confirm hosted fields cover PCI scope PropMv relies on |
| ACH auth / POA | No PropMv NACHA mandate UI on bank save or one-time ACH pay; Autopay has a PropMv checkbox | Public Payload support copy states Payload captures NACHA POA for ACH — **please confirm** whether PropMv must still display additional language |
| Autopay consent persistence | UI checkbox + API `confirmAutopay`; **consent text/version/IP not stored** on `OwnerPayloadAutopay` | Confirm required retention fields |
| Webhooks | Idempotent ingest + **re-fetch** with secret key before ledger mutation; optional `PAYLOAD_WEBHOOK_BEARER`; no inbound HMAC (documented: Payload v2 has no published HMAC) | Confirm production webhook auth expectations |
| Terms URL | `PAYLOAD_TERMS_URL` returned in some sessions; **not rendered** as owner T&C checkbox in live PM/pay UI | Confirm if PropMv must surface it outside Payload UI |
| Feature gates | Autopay + Check21 default **off** until QA gates | Confirm any production enablement requirements |

---

## 2. Payload components currently used

### 2.1 Live Payload-hosted / SDK surfaces

| Payload surface | Integration | PropMv flow | Wrapper / path |
| --------------- | ----------- | ----------- | -------------- |
| **Payload.js** (`https://payload.com/Payload.js`) | Script load | All Secure Input / Processing Account embeds | `payloadConfig.ts` → `getPayloadScriptUrl` |
| **`Payload(clientToken).ProcessingAccount({ inline, container })`** | SDK plugin | **New** merchant processing account (sandbox default / plugin mode) | `PayloadProcessingAccountForm.tsx` ← `PayloadMerchantOnboardingPage.tsx` |
| **Hosted application link** (URL opens in **new tab**, not iframe) | `POST …/application_link` → URL as `sessionKey` | Complete / update / resubmit existing processing account; deposit bank during onboarding when link returned | `PayloadApplicationLinkEmbed.tsx` |
| **`Payload(clientToken).Form({ form, payment_method })` + `pl-form="payment_method"` / `pl-input`** | Secure Input | Owner card/bank save & edit; merchant deposit bank (receive-only) | `PayloadPaymentMethodForm.tsx` |
| **`form.plaid(button)`** | Payload.js + Plaid | Owner bank link (recommended path) | `PayloadPaymentMethodForm.tsx` |
| **`form.applepay` / `form.googlepay`** | Payload.js wallets | Owner card/wallet save | `PayloadPaymentMethodForm.tsx` |
| Ephemeral **`POST /access_tokens`** `type: client` intents | Server | `processing_account_plugin`, `payment_method_form` (`send-only` / `receive-only`) | `payloadComponentSession.service.js` |

**Not used for owner checkout today:** `payment_form` intent builder exists server-side, but owner pay executes via PropMv API → Payload `POST /transactions/` (not an embedded Payload payment form).

### 2.2 Present in repo but **not mounted** on live routes

| Element / wrapper | Path | Status |
| ----------------- | ---- | ------ |
| `<payload-merchant-onboarding>` | `PayloadMerchantOnboarding.tsx` | Unused by current onboarding page |
| `<payload-merchant-hub>` | `PayloadMerchantHub.tsx` | Unused |

### 2.3 PropMv-built UI (not Payload components)

All titles, dialogs, lists, owner pay checkout, autopay enrollment, Check21 upload chrome, fee summaries, toasts, and status messaging — including:

- `PayloadMerchantList.tsx`, `PayloadMerchantDetailsPage.tsx`, `payloadMerchantUi.ts`
- `PayloadPaymentMethodsPanel.tsx`, `PayloadLinkedBanksPanel.tsx`, `PayloadAddDepositBankDialog.tsx`
- `OwnerPaymentDialog.tsx`, `PayableNowCard.tsx`, `OwnerPayloadPayMethodSelect.tsx`
- `AutoPayCard.tsx`, `OwnerAutoPaySettingsPanel.tsx`
- `RecordPaymentDialog.tsx`, `Check21ImageUpload.tsx`

**Interior copy of Payload SDK/hosted pages, Plaid Link, and Apple/Google Pay sheets is not in PropMv source** and must be confirmed by Payload.

---

## 3. Current user-facing copy (compliance-sensitive)

### 3.1 Merchant onboarding (Board / PM)

| Surface | Current PropMv copy (representative) | Flag |
| ------- | ------------------------------------ | ---- |
| List | “Create multiple Business Merchant Accounts to receive payments…”; dialog “similar to Straddle business onboarding” | Provider-comparison copy; branding mix (“Business” / “Payload” / “PropMv”) |
| Plugin create | “Complete the embedded Payload processing account form. PropMv only stores a link until Payload creates the account…” | OK operationally; sandbox-oriented |
| Hosted app | “Payload hosts this secure application. PropMV opens it in a new browser tab… PropMV never marks the merchant approved just because the link was opened.” | Clear; casing `PropMv`/`PropMV` inconsistent |
| Under review | “Payload is reviewing your information — wait for a status update…” | OK |
| Active | “Full business/legal (KYC) editing through Payload's hosted application is not supported for active merchants…” | Confirm with Payload that this matches product behavior |
| T&Cs | `termsAndConditionsUrl` may be on session; **not shown** as PropMv link/checkbox on live plugin path | **Payload confirmation required** — is disclosure only inside Payload UI? |

### 3.2 Deposit bank (Board / PM)

| Surface | Current PropMv copy | Flag |
| ------- | ------------------- | ---- |
| Add bank | “Add a settlement bank… (Payload receive-only bank account). Details are sent directly to Payload.” | No payout/ACH receive authorization language |
| Hub helper | “Assign each property to a linked bank so owner payments settle to that account…” | Operational; OK |
| Blocked | “Deposit banks are locked while Payload reviews this application.” | OK |

### 3.3 Owner payment method setup

| Surface | Current PropMv copy | Flag |
| ------- | ------------------- | ---- |
| Bank page | “Link a bank account to pay your HOA invoices securely through Payload” | Names processor to end user |
| Bank form | “Connect with Plaid (recommended) or enter routing and account number manually. Details are sent directly to Payload.” | **No ACH debit authorization / NACHA mandate text** |
| Card form | “Enter your card details below. Information is sent directly to Payload; PropMv never sees your full card number.” | Security language present; **no card charge authorization** at save time (expected if save ≠ charge) |
| Billing | “Required by Payload to save your card…” | OK |
| Edit | “For security, account and card numbers are not shown…” | OK |
| Delete | “This will remove the account ending in {last4} from PropMV and deactivate it in Payload.” | OK |

### 3.4 One-time payment (Owner)

| Surface | Current PropMv copy | Flag |
| ------- | ------------------- | ---- |
| Steps | “Select a payment method” → “Review and confirm your payment” | No ACH/card authorization paragraph |
| CTA | **“Verify & Pay”** then checkout badge **“Verified”** | **Misleading** — phone OTP UI is commented out; no verification occurs |
| Fees | “Payment Amount” / “Convenience Fee” / “Total” | Fee naming; processor not named on fee line |
| Success (card) | “Payment successful.” | Card may still be PROCESSING per settlement policy — confirm messaging vs settle timing |
| Success (bank) | “Payment submitted.” + “… is being processed.” | Better for ACH |

**Files:** `OwnerPaymentDialog.tsx`, `PayableNowCard.tsx`, `ownerPayloadPayExecution.ts`

### 3.5 Autopay (Owner) — strongest PropMv consent today

| Surface | Current PropMv copy | Flag |
| ------- | ------------------- | ---- |
| Page | “Pay open HOA invoices automatically on each due date with a saved card or bank account.” | OK |
| Settings note | “Auto Pay charges are confirmed by Payload webhooks, not by this screen alone. After enabling, mirror invoices sync to Payload…” | Accurate but **operator-technical** for owners |
| Marketing | “Set up Auto Pay and never miss a payment again.” | Soft marketing; not an auth statement |
| Consent checkbox | **“I authorize Auto Pay on each open invoice's due date using the selected method. Amounts follow my current PropMV invoice balance plus applicable processing fees.”** | Good start; missing cancel/revoke, method change, and bank-vs-card nuance |
| Disable | Toggle off → toast only; **no cancel-authorization dialog** | Likely insufficient if recurring ACH auth requires clear revoke path |
| Eligibility | Apple/Google Pay excluded in UI | Matches backend `AUTOPAY_ELIGIBLE_PAYMENT_METHOD_TYPES` |

**Files:** `AutoPayCard.tsx`, `OwnerAutoPaySettingsPanel.tsx`, `payloadAutopay.service.js`

### 3.6 Check21 (Board) — feature-flagged

| Surface | Current PropMv copy | Flag |
| ------- | ------------------- | ---- |
| Method | “Upload Check (Check21)” | OK |
| Helper | “Submits check images for clearing. Invoice stays Processing until funds clear — not marked Paid on submit.” | Good settlement expectation; **no Check21 / substitute-check authorization** |
| Images | “Check front” / “MICR line visible”; “Check back” / “Endorsement visible”; “JPG, PNG, or PDF · max 10MB” | Operational only |
| Submit button | Still labeled **“Record Payment”** (same as offline record) | Ambiguous vs async Check21 submit |

**Files:** `RecordPaymentDialog.tsx`, `Check21ImageUpload.tsx`

---

## 4. Proposed production verbiage

> These are **Recommended PropMv copy** drafts for engineering after Payload responds. They are **not** asserted as NACHA/Reg E/PCI-required unless Payload confirms. Where Payload already covers a disclosure inside a hosted component, PropMv should avoid duplicating conflicting text.

### 4.1 One-time payment — authorization / amount / timing

**Flagged:** Missing ACH/card auth; misleading “Verified”.

| | Text |
| - | ---- |
| **Current PropMv copy** | “Verify & Pay” / badge “Verified”; “Review and confirm your payment”; Pay `{amount}` |
| **Recommended PropMv copy** | CTA: **“Review & Pay”** (remove Verified badge unless real verification ships). Above Pay: “By selecting **Pay**, you authorize a charge of **{total}** (invoice amount plus any convenience fee shown) to your selected payment method for invoice(s) listed above. Card charges are typically confirmed quickly; bank (ACH) payments may take several business days and your invoice may show **Processing** until funds clear.” |
| **Payload confirmation required** | Approved one-time ACH debit language (if PropMv must show it); whether card auth language is required outside Payload; settle/status wording for card vs ACH |

### 4.2 ACH / bank-account authorization (save + pay)

**Flagged:** No NACHA-style mandate on bank save or bank pay.

| | Text |
| - | ---- |
| **Current PropMv copy** | “Details are sent directly to Payload.” / Plaid recommended |
| **Recommended PropMv copy (draft)** | “By saving this bank account and/or paying with it, you authorize [HOA/merchant name] and its payment processor (Payload) to debit the account ending in **{last4}** for the amounts you approve. For one-time payments, the debit matches the total shown at checkout. You may remove this payment method in Settings; removing it stops future use but does not reverse payments already submitted.” |
| **Payload confirmation required** | **Verbatim** ACH/POA language Payload expects platforms to display (or confirmation that Payload Secure Input / transaction API already captures POA and PropMv must not add conflicting text). Revocation wording requirements. |

### 4.3 Card payment authorization

| | Text |
| - | ---- |
| **Current PropMv copy** | Security-only (“never sees your full card number”); pay via “Pay {amount}” |
| **Recommended PropMv copy (draft)** | “By selecting **Pay**, you authorize a charge of **{total}** to the card ending in **{last4}** for the invoice(s) shown. A convenience fee may apply as displayed.” |
| **Payload confirmation required** | Any required card disclosure beyond amount + Pay action |

### 4.4 Processing / settlement expectations

| | Text |
| - | ---- |
| **Current PropMv copy** | Card: “Payment successful.” Bank: “Payment submitted… being processed.” Check21: stays Processing until clear |
| **Recommended PropMv copy** | Align card toast with actual settle policy if card can remain Processing briefly: “Payment submitted. Card payments usually confirm shortly; refresh if status still shows Processing.” Keep ACH: “Payment submitted… being processed.” |
| **Payload confirmation required** | Canonical customer-facing status map for `authorized` / `processing` / `processed` / `decline` / `reject` / `void` / `refund` |

### 4.5 Autopay authorization and cancellation

| | Text |
| - | ---- |
| **Current PropMv copy** | “I authorize Auto Pay on each open invoice's due date using the selected method. Amounts follow my current PropMV invoice balance plus applicable processing fees.” Disable: switch + toast |
| **Recommended PropMv copy (draft)** | Enable: “I authorize PropMv to instruct Payload to charge my selected payment method on each open HOA invoice’s due date for the then-current invoice balance plus applicable processing fees shown in PropMv. Amounts may change when my HOA updates invoices. I can change my method or turn Auto Pay off in Settings before the due date; turning Auto Pay off stops future automatic charges but does not cancel payments already submitted.” Soften settings note to: “Automatic charges are confirmed when the payment processor finalizes them; your invoice status updates when that confirmation arrives.” |
| **Payload confirmation required** | Required recurring ACH/card language; whether Payload invoice `autopay_allowed` + customer default PM implies additional UI mandates; cancel timing relative to due date / automatic_payment |

### 4.6 Failed / pending / reversed states

| | Text |
| - | ---- |
| **Current PropMv copy** | Mixed “successful” / “submitted” / “being processed”; processing conflict: “This payment is already being processed…” |
| **Recommended PropMv copy (draft)** | Pending: “Payment processing — this may take several business days for bank payments.” Failed: “Payment failed — no funds were applied; you may try again or use another method.” Reversed/returned: “Payment was reversed or returned; your balance has been updated.” |
| **Payload confirmation required** | Customer-safe descriptions for reject/return/refund/void |

### 4.7 Check21 / check-image authorization

| | Text |
| - | ---- |
| **Current PropMv copy** | Processing disclaimer only; button “Record Payment” |
| **Recommended PropMv copy (draft)** | Button: **“Submit Check for Clearing”**. Consent: “I confirm these images are of a valid check authorized for electronic presentment/clearing for invoice {id} in the amount of {amount}. The invoice will remain Processing until funds clear and may fail if the check cannot be processed.” |
| **Payload confirmation required** | **Verbatim** Check21 / image-based presentment authorization Payload requires of platforms; warranty/indemnity if any |

### 4.8 Security / privacy

| | Text |
| - | ---- |
| **Current PropMv copy** | “PropMv never stores full account or card numbers” / “sent directly to Payload” |
| **Recommended PropMv copy** | Keep; standardize brand to **PropMv**. Optional: “Payment details are transmitted to our payment processor, Payload, using their secure fields.” |
| **Payload confirmation required** | Required privacy/security disclosures for co-branded processor mention |

### 4.9 Merchant T&Cs / deposit banks

| | Text |
| - | ---- |
| **Current PropMv copy** | Operational onboarding/deposit guidance; Straddle comparison on create dialog |
| **Recommended PropMv copy** | Remove “similar to Straddle…” from production UI. If Payload requires platform T&Cs: “By continuing, you agree to the payment processing terms presented by Payload and any PropMv terms linked here.” |
| **Payload confirmation required** | Whether `terms-and-conditions-url` / Processing Account UI already satisfies merchant disclosures; any text PropMv must show outside the plugin |

---

## 5. Payload team — questions & confirmations needed

Please confirm or provide the following for **production**:

### 5.1 Approved copy & disclosures

1. **Verbatim production copy** (or “no additional copy required”) for each live surface we use:
   - `ProcessingAccount` plugin (integrated form)
   - Hosted **application_link** pages
   - Secure Input `payment_method_form` (card + bank)
   - Plaid bank linking via Payload.js
   - Apple Pay / Google Pay via Payload.js
2. **Required ACH / NACHA authorization language** for: (a) saving a bank PM, (b) one-time ACH pay via server `POST /transactions/`, (c) recurring autopay. Clarify what Payload already captures as Proof of Authorization vs what PropMv must display and retain.
3. **Required card authorization / disclosure language** for saved cards and one-time charges.
4. **Required autopay / recurring language**, including cancellation/revocation requirements and timing.
5. **Required Check21 / check-image authorization language** for platform-uploaded front/back images (`source=check`).
6. **Security/privacy text** Payload requires platforms to display (if any).
7. Whether **`PAYLOAD_TERMS_URL` / terms-and-conditions-url** must be rendered by PropMv outside Payload-hosted UI.

### 5.2 Hosted component coverage

8. Do Payload-hosted/SDK components **already satisfy** any ACH, card, merchant KYC, or T&Cs disclosures so PropMv should **not** duplicate them?
9. For **ACTIVE** processing accounts, is it correct that hosted application_link does **not** support full KYC edit (as PropMv currently tells users)?
10. Are unused web components `<payload-merchant-onboarding>` / `<payload-merchant-hub>` recommended for production vs current `ProcessingAccount` + application_link approach?

### 5.3 Production integration requirements

11. **Webhook** production requirements: triggers to subscribe (`processed`, `decline`, `void`, `refund`, `reject`, `processing_status`, `automatic_payment`, others?); Webhook OAuth / bearer vs no signature; any PM/deposit/merchant_application triggers we should handle (handlers exist but are not wired to the current webhook switch).
12. **Autopay**: confirmation that mirroring open invoices with `autopay_allowed` + customer default PM is the approved pattern (vs Billing Schedules); any production dashboard / underwriting prerequisites.
13. **Check21**: production enablement prerequisites; settlement/funding status semantics PropMv should use for ledger (we defer settle while `funding_status` ∈ pending/processing).
14. **Settlement messaging**: customer-facing guidance for card vs ACH timing that Payload endorses.
15. Any **production-only** UI, component, onboarding, or API requirements not covered above.

### 5.4 Engineering contact points (PropMv)

| Area | Backend | Frontend |
| ---- | ------- | -------- |
| Config / flags | `propmv/src/config/payload.config.js` | `innago-inspired-refresh/src/shared/utils/payloadConfig.ts` |
| Client tokens / intents | `…/payload/service/payloadComponentSession.service.js` | — |
| Merchant | `…/payloadMerchant.service.js` | `PayloadMerchantOnboardingPage.tsx`, `PayloadProcessingAccountForm.tsx`, `PayloadApplicationLinkEmbed.tsx` |
| Deposit banks | `…/payloadDepositMethod.service.js` | `PayloadAddDepositBankDialog.tsx`, `PayloadLinkedBanksPanel.tsx` |
| Owner PMs | `…/payloadPaymentMethod.service.js` | `PayloadPaymentMethodForm.tsx`, `PayloadPaymentMethodsPanel.tsx` |
| Pay / settle | `…/payloadPayin.service.js`, `payloadPayinSettlement.util.js` | `OwnerPaymentDialog.tsx`, `PayableNowCard.tsx` |
| Autopay | `…/payloadAutopay.service.js` | `AutoPayCard.tsx`, `OwnerAutoPaySettingsPanel.tsx` |
| Check21 | `…/payloadCheck21Payin.service.js` | `RecordPaymentDialog.tsx`, `Check21ImageUpload.tsx` |
| Webhooks | `…/payloadWebhook.service.js`, `payloadWebhook.middleware.js` | — |
| Foundation notes | `propmv/docs/PAYLOAD_FOUNDATION.md` | — |

---

## Appendix A — Intent / API summary (for Payload reviewers)

| Intent / API | Purpose in PropMv |
| ------------ | ----------------- |
| `access_tokens` + `type: client` + `intent.type: processing_account_plugin` | New merchant create (plugin) |
| `POST /processing_accounts/{id}/application_link` | Existing merchant complete/update (new tab) |
| `payment_method_form` + `transfer_type: send-only` + `customer_id` (+ bank `account_class: personal` or card) | Owner save card/ACH |
| `payment_method_form` + `transfer_type: receive-only` + `account_id` + bank `account_class: business` | Merchant deposit bank |
| `POST /transactions/` `type: payment` + `payment_method_id` | Owner one-time / API charge |
| `POST /transactions/` multipart `source: check` | Check21 |
| `POST /transactions/` `type: refund` / void | Board refund/void |
| `POST/PATCH /invoices/` with `autopay_allowed` | Autopay mirror |
| Webhooks on `/api/webhooks/payload` | Settlement & merchant status (re-fetch before ledger write) |

---

**End of document.** Please reply with approved verbatim copy, “covered by Payload UI,” or “PropMv must add…” for each item in §5 so PropMv engineering can implement without inventing compliance language.
