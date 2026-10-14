# Check21 (Upload Check) — QA & Automation Test Guide

**Status:** Feature shipped behind flags (default **off**). Local sandbox QA may enable flags; **do not enable staging/production** until a real check image completes OCR and confirms [roadmap-check21.md](./roadmap-check21.md) §6.1.

**Engineering:** [roadmap-check21.md](./roadmap-check21.md) · [existing-architecture.md](./existing-architecture.md)  
**Related regressions:** Card/ACH settle, Autopay, offline Record Payment (Cash / Check number / Money Order)

---

## 1. Environment setup (frontend + backend)

### Backend — `propmv/.env`

| Variable | Local QA | Staging / Prod | Notes |
|----------|----------|----------------|-------|
| `PAYLOAD_ENABLED` | `true` | as today | Required |
| `PAYLOAD_ENVIRONMENT` | `sandbox` | sandbox / production | |
| `PAYLOAD_SECRET_KEY` | sandbox `test_secret_key_…` | env-specific | Server only |
| `PAYLOAD_CHECK21_ENABLED` | **`true`** to test UI | **`false`** until OCR gate | Production Check21 path |
| `PAYLOAD_CHECK21_DOCS_JSON` | `false` | `false` | Live API rejects docs JSON; keep off |
| `PAYLOAD_WEBHOOK_BEARER` | optional | optional | If set, webhooks need `Authorization: Bearer …` |
| ~~`PAYLOAD_CHECK21_DEMO_ENABLED`~~ | **remove** | — | Demo removed |

Restart the API after changing flags.

### Frontend — `innago-inspired-refresh/.env.local`

| Variable | Local QA | Staging | Notes |
|----------|----------|---------|-------|
| `VITE_PAYLOAD_ENABLED` | `true` | as today | Required |
| `VITE_PAYLOAD_ENVIRONMENT` | `sandbox` | sandbox | |
| `VITE_PAYLOAD_CHECK21_ENABLED` | **`true`** to test UI | **`false`** until OCR gate | Shows **Upload Check (Check21)** in Record Payment |
| ~~`VITE_PAYLOAD_CHECK21_DEMO_ENABLED`~~ | **remove** | — | Demo settings page removed |

Restart Vite after changing (`npm run dev` / equivalent). Vite only reads `VITE_*` at build/start time.

### Minimal local snippet

**Backend (`propmv/.env`):**
```env
PAYLOAD_ENABLED=true
PAYLOAD_ENVIRONMENT=sandbox
PAYLOAD_CHECK21_ENABLED=true
PAYLOAD_CHECK21_DOCS_JSON=false
```

**Frontend (`innago-inspired-refresh/.env.local`):**
```env
VITE_PAYLOAD_ENABLED=true
VITE_PAYLOAD_ENVIRONMENT=sandbox
VITE_PAYLOAD_CHECK21_ENABLED=true
```

### Prerequisites before UI testing

1. HOA has an **ACTIVE** Payload processing account (`acct_…`) via **Settings → HOA Bank Accounts**.
2. Board user has **EDIT_INCOME** (same as Record Payment).
3. An open invoice with **balanceDue > 0** (and collectable balance after any in-flight processing).
4. Prefer **real check photos** (front MICR + back endorsement). Synthetic/blank JPEGs are rejected by Payload OCR (“Invalid or unreadable check image”).

---

## 2. UI testing — step by step

### Happy path (submit → Processing)

1. Start backend + frontend with flags above.
2. Log in as **HOA Board Member**.
3. Open **Income** (or invoice detail) → select an unpaid / partial invoice.
4. Click **Record Payment**.
5. Confirm payment method list includes **Upload Check (Check21)** (below Cash / Check / Money Order / Other).
6. Select **Upload Check (Check21)**.
7. Enter amount ≤ remaining balance (server rejects over-balance / ≤ 0).
8. Upload **front** and **back** (JPG/PNG/PDF, each &lt; 10MB, different files).
9. Click submit / Record.
10. **Expected:**
    - Toast: **“Check submitted — processing”** (never “Paid” / “Payment recorded successfully” for this path).
    - Dialog closes.
    - Invoice shows **Processing** (or processing amount &gt; 0), not Paid.
11. In Mongo / ops: `payloadpayins` row with `methodType: CHECK21`, `status: PROCESSING`, `payinId: txn_…`.

### Offline Check still works (regression)

1. Same dialog → select offline **Check** (not Upload Check).
2. Enter **check number** (no images).
3. Submit → **Expected:** immediate Paid/Partial via existing PUT (sync manual record).

### Negative / UX cases

| Step | Action | Expected |
|------|--------|----------|
| Missing image | Submit without front or back | Client validation error; no API call (or 400) |
| Same front/back | Upload identical file twice | 400 — must be different files |
| Oversize | File &gt; 10MB | 400 under 10MB |
| Bad file | Rename `.txt` to `.jpg` | 400 magic-byte / content mismatch |
| Amount tamper | Propose amount &gt; collectable | 400 from server |
| Flag off | Set `VITE_PAYLOAD_CHECK21_ENABLED=false`, restart | **Upload Check** option hidden; offline Check remains |
| No processing acct | HOA without `acct_` | 422 — complete Bank Accounts onboarding |
| Concurrent | Second Check21 while first PROCESSING | 409 open payin exists |
| Manual while Check21 in flight | Record Cash exceeding collectable | Blocked by existing manual/gateway gates |

### Settlement / webhooks (sandbox)

After a **successful** Payload Check21 create (real check images):

1. Wait for Payload webhooks (`processed` / `decline` / `reject`) **or** run ops reconciliation.
2. **Expected settle (PropMV Paid + ledger)** only when:
   - Remote status maps to settle-eligible (`processed` / local SUCCEEDED), **and**
   - `funding_status` is **not** `pending` or `processing` (stricter than ACH — see roadmap §6.1).
3. Pre-settle decline/void/reject → invoice processing **failed**, balance restored, **no** ledger payment.
4. Post-settle reject → original payment row **kept**; refundedAmount + ledger **adjustment** (non-destructive).

If OCR never succeeds, you cannot fully QA settle in UI — use unit tests for predicate matrix (below).

---

## 3. Manual API checks (optional)

```bash
# Public config should expose check21Enabled when backend flag is on
curl -s "$API/payments/payload/config" | jq '.data.check21Enabled'

# Submit (board session + CSRF as your app does)
# multipart: invoiceId, amount, paymentAttemptId, front, back
```

Privilege: route requires **EDIT_INCOME**. Unauthorized / wrong HOA → 403/422.

---

## 4. QA test matrix (manual)

| ID | Area | Steps | Expected |
|----|------|-------|----------|
| C21-UI-01 | Flag on | Enable both flags; open Record Payment | Upload Check (Check21) visible |
| C21-UI-02 | Flag off | Frontend flag false | Option hidden |
| C21-UI-03 | Submit success | Real check images + valid amount | Toast processing; invoice Processing |
| C21-UI-04 | Offline Check | Check + number | Immediate bookkeeping Paid/Partial |
| C21-UI-05 | Amount | Amount &gt; balance | Rejected |
| C21-UI-06 | Images | Missing / identical / bad magic | Rejected |
| C21-API-01 | Idempotency | Retry same `paymentAttemptId` | Same payin; no double charge |
| C21-API-02 | Concurrency | Two parallel submits | One wins; other 409 |
| C21-API-03 | Recovery | Payload OK, force invoice sync fail | `metadata.recoveryNeeded`; reconciler repairs |
| C21-WH-01 | Settle hold | `processed` + `funding_status=pending` | No ledger yet |
| C21-WH-02 | Settle | `processed` + funding batched/settled/absent | Paid + ledger |
| C21-WH-03 | Fail | decline before settle | fail processing; no ledger |
| C21-WH-04 | Return | reject after settle | reverse; original tx kept |
| C21-WH-05 | Body spoof | Webhook body says processed; re-fetch not settle-eligible | No settle |
| C21-SEC-01 | Query secret | `POST /api/webhooks/payload?token=…` | 400 (query auth forbidden) |
| C21-REG-01 | Card | Owner card pay | Settle-on-PROCESSING unchanged |
| C21-REG-02 | ACH | Owner ACH | Settle on processed unchanged |
| C21-REG-03 | Autopay | Enrollment + next charge | Unchanged |
| C21-REG-04 | Manual Cash | Record Payment Cash | Unchanged |

---

## 5. Automation testing

### Unit / node:test (CI-friendly)

```bash
cd propmv && node --test \
  src/shared/modules/payment/providers/payload/utils/payloadCheck21.util.test.js \
  src/shared/modules/payment/providers/payload/utils/payloadPayinSettlement.util.test.js \
  src/privileges/payments/payload.routes.test.js \
  src/shared/modules/payment/providers/payload/utils/payloadPayinLifecycle.util.test.js \
  src/shared/modules/payment/providers/payload/utils/payloadAutopayInvoiceScope.util.test.js \
  src/portals/hoa-board/modules/invoice/helpers/invoiceManualRecordPayment.helper.test.js \
  src/shared/modules/payment/providers/payload/utils/payloadPayinCharge.node.test.js \
  src/shared/modules/payment/providers/payload/service/payloadWebhook.service.node.test.js
```

**Coverage included today:**

- Magic-byte / size / mime / identical front-back
- Multipart builder (`processing_id`, `order_number`, no docs JSON fields)
- Check21 settle vs ACH (funding deferred hold)
- Payin transition guards (no SUCCEEDED→PROCESSING)
- Privilege map: Check21 submit → `EDIT_INCOME`
- Card/ACH/Autopay/manual Record Payment regressions listed above

### Suggested automation backlog (not all implemented yet)

| Suite | Cases to add |
|-------|----------------|
| Service integration (mocked Payload client) | submit success; amount reject; open-payin 409; Payload fail → FAILED payin; recoveryNeeded path |
| Webhook integration | processed+funding; reject→reverse; duplicate eventId; out-of-order ignore |
| API e2e (supertest) | multipart submit with auth+CSRF; 403 without EDIT_INCOME |
| Frontend (Playwright/Cypress) | option visible when flag on; hide when off; upload+submit toast; offline Check path |

Example Playwright outline:

```ts
// flags: VITE_PAYLOAD_CHECK21_ENABLED=true
test('board upload check shows processing toast', async ({ page }) => {
  await loginAsBoard(page);
  await openRecordPayment(page, invoiceId);
  await page.getByText('Upload Check (Check21)').click();
  await page.setInputFiles('#rp-check21-front', 'fixtures/check-front.jpg');
  await page.setInputFiles('#rp-check21-back', 'fixtures/check-back.jpg');
  await page.getByRole('button', { name: /record|submit/i }).click();
  await expect(page.getByText(/Check submitted — processing/i)).toBeVisible();
});
```

Use fixture images that pass magic bytes; for sandbox e2e against live Payload, use **real check scans** or expect OCR 400.

### Sandbox contract probe (ops / pre-staging)

Record results in roadmap §4.1:

1. Docs JSON `receiver`/`check_images` → expect InvalidAttributes.
2. Multipart `processing_id` + `check_front`/`check_back` → fields accepted.
3. Real check → capture `status`, `funding_status`, webhook triggers → confirm §6.1 before staging flag on.

---

## 6. Staging / production enablement checklist

Do **not** set staging/prod flags until all are true:

- [ ] Real-check sandbox txn created (`txn_…`)
- [ ] §6.1 matrix confirmed against live `status` + `funding_status`
- [ ] Webhook re-fetch settle/fail/reverse tested
- [ ] Automated unit suite green
- [ ] Card/ACH/Autopay/manual Record Payment regressions signed off
- [ ] `PAYLOAD_CHECK21_DOCS_JSON=false`
- [ ] No secrets in webhook query strings
- [ ] Then enable `PAYLOAD_CHECK21_ENABLED` + `VITE_PAYLOAD_CHECK21_ENABLED` in that environment only

---

## 7. Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| No Upload Check option | Frontend flag off or Vite not restarted; or `VITE_PAYLOAD_ENABLED=false` |
| 403 Check21 not enabled | Backend `PAYLOAD_CHECK21_ENABLED=false` |
| Unreadable check image | Synthetic/blank image — use real check photos |
| 422 processing account | Complete HOA Bank Accounts; need active `acct_…` |
| 409 already processing | Open Check21 payin on invoice — wait or reconcile |
| Stuck Processing after Payload success | Missing webhook; run reconciliation; check `recoveryNeeded` |
| Settings Check21 demo page 404 | Expected — demo removed; use Record Payment |
