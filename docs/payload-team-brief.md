# PropMv → Payload: Use Case, Components & Copy Guidance Request

**From:** PropMv  
**To:** Payload (product / compliance / support)  
**Ask:** Please provide Payload’s approved production wording (or confirm that each Payload-hosted/SDK component already includes required disclosures) for the components and PropMv screens listed below.

---

## 1. PropMv payment use case

PropMv is a property-management / HOA payment platform. HOA Board Members, Property Managers, and Landlords create and manage Payload **processing accounts** to receive payments; HOA Owners/Tenants pay property-related invoices and dues using saved **ACH/bank accounts** and **cards**, including **Apple Pay** and **Google Pay** where device/support allows. PropMv uses Payload for merchant/processing-account onboarding, customer payment-method onboarding (Secure Input), payment processing (server-initiated charges), and payment status updates via webhooks. **Autopay** (recurring invoice charges on due date) and **Check21** (board upload of check front/back images) are implemented and planned for production behind feature flags; they are not always enabled in every environment today.

---

## 2. Payload components currently used

### A. Payload components / SDK surfaces (live)

| Payload component / API | Purpose | PropMv flow | Implementation |
| ----------------------- | ------- | ----------- | -------------- |
| **Payload.js** (`Payload.js` script) | Loads Payload UI SDK | All embedded Payload UI | `innago-inspired-refresh/src/shared/utils/payloadConfig.ts` (`getPayloadScriptUrl`), `PayloadScriptLoader` |
| **Ephemeral client token** (`POST /access_tokens`, `type: client` + intent) | Authenticates Payload.js embeds | Merchant create; payment-method / deposit-bank forms | `propmv/.../payloadComponentSession.service.js` |
| **`Payload(clientToken).ProcessingAccount`** (integrated Processing Account form) | New processing-account / merchant onboarding | Board/PM/Landlord creates a business processing account (inline embed) | `PayloadProcessingAccountForm.tsx` ← `PayloadMerchantOnboardingPage.tsx` |
| **Hosted Application Link** (`application_link` URL, opened in a **new browser tab**) | Complete / update / resubmit an existing processing account; deposit bank during onboarding when Payload returns a link | Existing merchant application; deposit-bank path when session is a URL | `PayloadApplicationLinkEmbed.tsx` ← `PayloadMerchantOnboardingPage.tsx`, `PayloadAddDepositBankDialog.tsx` |
| **Secure Input — Payment Method Form** (`pl-form="payment_method"` + `Payload(...).Form`) | Capture/store payment methods without PropMv handling raw PAN/account numbers | Owner save/edit card or bank; merchant **receive-only** deposit bank | `PayloadPaymentMethodForm.tsx` (via `PayloadPaymentMethodSetup.tsx` / `PayloadDepositMethodSetup.tsx`) |
| **Payload.js card Secure Inputs** (`pl-input` e.g. `card` / `card_number`, `expiry`, `cvc` + billing address fields) | Card data entry | Owner card / wallet setup | Same form, card mode |
| **Payload.js bank Secure Inputs** (`pl-input` `routing_number`, `account_number`, `account_type`) | Manual ACH/bank entry | Owner bank setup; merchant deposit bank | Same form, bank mode |
| **Plaid via Payload.js** (`form.plaid(...)`) | Bank linking through Plaid | Owner bank setup (recommended path) | `PayloadPaymentMethodForm.tsx` |
| **Apple Pay via Payload.js** (`form.applepay(...)`) | Save Apple Pay as payment method | Owner card/wallet setup | `PayloadPaymentMethodForm.tsx` |
| **Google Pay via Payload.js** (`form.googlepay(...)`) | Save Google Pay as payment method | Owner card/wallet setup | `PayloadPaymentMethodForm.tsx` |

**Not used today for checkout:** We do **not** embed Payload’s `payment_form` / payment checkout component for owner invoice payment. One-time charges use PropMv UI + PropMv API → Payload transaction create. Autopay charges are initiated via Payload’s automatic/invoice path when Autopay is enabled.

**Present in repo but not mounted on live flows:** custom elements `<payload-merchant-onboarding>` and `<payload-merchant-hub>` (`PayloadMerchantOnboarding.tsx`, `PayloadMerchantHub.tsx`) — **not currently used**.

### B. PropMv-built UI (surrounds / invokes Payload; not Payload components)

Examples of PropMv chrome around the above: merchant account list/details, deposit-bank lists/dialogs, owner Cards / Bank Accounts settings panels, one-time **Make a Payment** checkout, Autopay enrollment UI, Check21 image upload in Record Payment. These screens may need copy aligned with Payload guidance (§3).

---

## 3. PropMv screens where we need Payload guidance

| PropMv screen | What we need from Payload |
| ------------- | ------------------------- |
| **Merchant / processing-account onboarding** (Processing Account form + Application Link) | Approved production wording for any disclosures PropMv must show outside the Payload UI, **or** confirmation that the Processing Account form / hosted Application Link already covers required merchant disclosures. |
| **Deposit / settlement bank setup** (Secure Input receive-only bank and/or Application Link) | Approved/required wording for adding a settlement bank, **or** confirmation that Payload’s form/link already provides it. |
| **Owner bank account setup** (Secure Input + Plaid) | Approved ACH/bank authorization language PropMv should display (if any), **or** confirmation that Payload already captures required authorization/POA in Secure Input / Plaid. |
| **Owner card / Apple Pay / Google Pay setup** | Approved card/wallet save language PropMv should display (if any), **or** confirmation Payload’s Secure Input / wallet UI already covers it. |
| **One-time payment checkout** (PropMv-built; charges via Payload API) | Approved one-time payment / ACH / card authorization language for platforms that charge saved methods via API (no embedded Payload payment form). |
| **Autopay enrollment** (PropMv-built; planned for production) | Approved recurring / Autopay wording, **or** confirmation of what PropMv must show vs what Payload handles when invoices are set for automatic payment. |
| **Check21 submission** (PropMv-built image upload; planned for production) | Approved check-image / Check21 wording platforms must show when submitting front/back images to Payload, if any. |

We are **not** proposing final legal wording in this note; we will adopt Payload’s approved copy or follow your confirmation that the hosted/SDK UI is sufficient.

---

## 4. Questions for Payload

Please provide or confirm:

1. **Approved production copy** for each Payload component/surface in §2A (or “no additional PropMv copy required”).
2. **Required ACH/bank authorization language**, and whether Payload already captures the required authorization/POA in Secure Input, Plaid, and/or API charges.
3. **Required card/payment authorization language** for saving a card/wallet and for charging a saved method via API.
4. **Required Autopay / recurring-payment language**, if applicable to our invoice automatic-payment approach.
5. **Required Check21 / check-image language**, if applicable.
6. Any **Terms, Privacy, security, or consent disclosures** PropMv must display **outside** Payload-hosted/SDK components (including use of a terms URL if required).
7. Any **production-specific** component or configuration requirements for the surfaces we use above.

Thank you — once we have your approved wording/guidance, we will align PropMv UI copy accordingly.
