# HOA Payment & Invoice — QA Guide (Board + Owner)

Short reference for **current design** and **how to test**. Assumes **Payload** is the active payment provider for owner online pay (card + bank/eCheck).

---

## 1. Two different “status” concepts (do not confuse)

| Surface | Where | What it means |
|--------|--------|----------------|
| **Invoice status** | Income list, owner invoice list, invoice header (Due, Overdue, Processing, Partial, Paid, Waived) | **Invoice lifecycle** from balances: `balanceDue`, `alreadyPaid`, `processingAmount`, due date, waived. |
| **Payment Transactions tracker** | Invoice detail → “Payment Transactions” stepper | **One gateway payment’s lifecycle** (Payload pay-in), **not** the invoice row status. |
| **Payments Received table** | Same invoice detail | Ledger rows (amount, **Method**, paid by, balance after). Method for Payload = **card** or **echeck** (labels from Master DB). |

**QA rule:** Invoice can show **Processing** while the tracker shows **Verify** or **Process** on the owner’s Payload payment. That is expected.

---

## 2. Configuration QA depends on

| Setting | Location | Effect |
|---------|----------|--------|
| **Accept Partial Payments** | Settings → Manage HOA Fee → Monthly Recurring Fee (toggle) | **On:** owner “Pay other amount” + board record &lt; full balance allowed (within rules). **Off:** full balance only; API rejects partial. |
| **Payload** | Env / provider config | Owner online pay + gateway rows on invoice. |
| **HOA fee / invoices** | Recurring fee generates invoices | Units need open invoices with `balanceDue > 0` to pay. |

**API (owner + board can read policy):**  
`GET /api/v1/hoa/hoa-settings/:hoaId/payment-policy` → `{ acceptPartialPayments: boolean }`

**Restart propmv** after backend changes before regression.

---

## 3. Board member flows

### 3.1 Invoice list & detail

- **Income** → invoices with filters/KPIs.
- Open invoice → **Invoice detail** (`/income/...` or dialog from list).
- **Invoice status** on list/detail follows derived rules (not the Payload stepper).

### 3.2 Record Payment (manual: cash, check, etc.)

**Entry:** Invoice detail → **Record Payment** (also Income actions dropdown when eligible).

**Eligibility (UI):**

- Not paid / not waived; `remainingBalance > 0`.
- If owner **Payload payment in flight** (`processingAmount > 0`):
  - **Initiate / Verify** (from `payloadData.lifecycle_stages` on processing tx): **Record Payment hidden/blocked** with message about verification.
  - **Process / Deposit:** **Record Payment allowed** up to **`balanceDue` only** (no double-counting with in-flight amount).
  - **No Payload data** on processing tx (legacy/other gateway): blocked while processing (conservative).
- **Income list only** (no payment rows loaded): blocked while `processingAmount > 0` — open invoice detail to evaluate phase.

**Partial payments:**

- Toggle **Accept Partial Payments = Off** → amount **&lt; remaining balance** rejected (UI + `PUT` invoice payment).
- Toggle **On** → partial manual record allowed (FIFO/overpayment rules still apply on server).

**Deposit bank:** Board invoice edit flows unchanged; owner detail hides deposit bank where configured.

### 3.3 Board does not use Owner Pay dialog on HOA income invoice

Owner **Make a Payment** is owner-only (`OwnerPaymentDialog` / `PayableNowCard`).

---

## 4. Owner flows

### 4.1 Invoice listing

- **`/invoices`** (or HOA owner portal equivalent).
- Pay action opens **Owner Payment Dialog** with `acceptPartialPayments` from **payment-policy** API.

### 4.2 Pay Now entry points

| Entry | Component |
|-------|-----------|
| Owner invoice list → Pay | `OwnerPaymentDialog` |
| Owner dashboard → Payments & Billing | `PayableNowCard` |
| Invoice detail (owner read-only view) | `OwnerPaymentDialog` on details page when eligible |

### 4.3 Owner payment dialog behavior

1. **Amount step**
   - **Pay full / Pay through this invoice** — pays FIFO stack (older invoices first when applicable).
   - **Pay other amount** — only if **Accept Partial Payments = On**; otherwise disabled + message.
2. **Allocation preview** — `GET /invoice/:id/allocation-preview?amount=…` (must match server FIFO).
3. **Method** — saved Payload card/bank (Settings → payment methods).
4. **Processing fee** — from Payload pay-in validate quotes when applicable.
5. **Execute** — Payload pay-in; invoice gets **processing** payment row until webhooks/settlement.

**Partial OFF:** choosing less than this invoice’s collectable balance fails in UI and API (`PARTIAL_PAYMENTS_DISABLED`).

**FIFO:** Paying while an **older** invoice has balance → error: pay oldest first.

### 4.4 Owner invoice detail

- Read-only layout; **Payments Received** + **Payment Transactions** same as board view for that invoice.
- **Deposit bank account** hidden on owner detail where implemented.

---

## 5. Payload online payment (owner) — backend + UI

### 5.1 Invoice row after owner pays

- **`processingAmount`** increases; **`balanceDue`** reduced by applied amount (collectable math).
- Invoice status often **Processing** until gateway completes.

### 5.2 Payment Transactions stepper (Payload)

Stages (when `payloadData` enriched on payment tx):

1. **Initiate** → 2. **Verify** → 3. **Process** → 4. **Deposit** → 5. **Complete**

- Driven by **Payload webhooks** + stored `metadata.payloadLifecycleHistory` on `PayloadPayin`.
- **Not** shown for **manual** board payments (completed chip, no fake stepper).

**Unpaid invoice placeholder row** (no payment yet): template **Awaiting → Initiate → Verify → Process → Deposit** — informational only, not a live Payload state.

### 5.3 Payments Received → Method

- Payload card → display label for **card** (e.g. Credit/Debit Card).
- Payload ACH → **echeck** / eCheck label.
- Manual payments → method from record (cash, check, etc.).

### 5.4 Webhooks (sanity check)

- Endpoint: `POST /api/webhooks/payload`
- Triggers include `authorized`, `processed`, `payment`, etc. → updates pay-in + invoice processing/settlement.
- QA in sandbox: pay with test method; confirm stepper advances after webhook delivery (or poll invoice refresh).

---

## 6. Test matrices

### 6.1 Accept Partial Payments

| Toggle | Owner “Pay other amount” | Owner pay &lt; balance via API | Board Record &lt; balance |
|--------|--------------------------|----------------------------------|----------------------------|
| **On** | Enabled | Allowed (within FIFO/balance) | Allowed |
| **Off** | Disabled | **400** Partial not allowed | **400** Partial not allowed |

### 6.2 Board Record Payment vs owner Payload in flight

Example: **$100 invoice**, owner paid **$50** online (processing), **`balanceDue = $50`**.

| Payload phase (tracker) | Board Record Payment | Max manual amount |
|-------------------------|----------------------|-------------------|
| Verify (or Initiate) | **Blocked** | — |
| Process / Deposit | **Allowed** | **$50** (not $100) |
| Completed (no processing tx) | Normal rules | Up to balance / overpayment rules |

### 6.3 Owner online pay limits

| Case | Expected |
|------|----------|
| Amount &gt; invoice collectable balance | Rejected |
| Amount &gt; unit total outstanding | Rejected |
| Older unpaid invoice exists | Rejected until older paid (FIFO) |
| Partial OFF, amount &lt; balance | Rejected |
| Card pay-in | Method **card** on Payments Received after sync |
| Bank pay-in | Method **echeck** on Payments Received |

### 6.4 Manual vs gateway rows

| Payment type | Payments Received | Payment Transactions tracker |
|--------------|-------------------|--------------------------------|
| Board Record (cash/check) | One completed row | Completed, no stepper |
| Owner Payload (in flight) | Row when recorded as processing | Payload stages |
| Owner Payload (settled) | Completed; correct Method | Stages through Complete |

---

## 7. Suggested QA scripts (happy paths)

### Board

1. Create/open invoice **$100**, partial payments **On**.
2. **Record Payment** $40 cash → status Partial, balance $60, manual row Completed.
3. Toggle partial **Off** → Record $30 → **fail**; Record $60 → **pass**.
4. (With Payload) Owner pays $50 card → invoice Processing, tracker moves, Method **card**.
5. While tracker on **Verify** → board Record **blocked**.
6. After tracker **Process/Deposit** → board Record **$60** max (if balance $60) or remaining cap per double-count rules.

### Owner

1. Confirm **payment-policy** returns correct toggle after settings save.
2. Partial **On** → Pay other $25 on $100 invoice → success, partial invoice.
3. Partial **Off** → only full/pay-through option works.
4. Pay full with card → processing then paid; tracker + Payments Received Method correct.
5. Open allocation preview in network tab; amounts match payment dialog.

---

## 8. API / network checklist

| Action | Method | Notes |
|--------|--------|--------|
| Read partial policy | `GET .../hoa-settings/:hoaId/payment-policy` | Owner + board (VIEW_INCOME) |
| Invoice detail | `GET .../invoice/:id` | Includes enriched `paymentTransactions[].payloadData` |
| Allocation preview | `GET .../invoice/:id/allocation-preview?amount=` | Partial rules for owner |
| Board record pay | `PUT .../invoice/:id` with `paymentAmount` | Partial + gateway-in-flight rules |
| Owner Payload pay-in | Payload pay-in validate + execute | Partial + FIFO in ledger assert |
| Payload webhook | `POST /api/webhooks/payload` | Advances lifecycle / settlement |

---

## 9. Known UI limitations (expected)

- **Income list** Record Payment while processing: may stay disabled until **invoice detail** is opened (needs `payloadData` on transactions for phase-aware rules).
- **Vitest** in frontend may require newer Node in some environments; backend tests: `node --test` on propmv payment/invoice helpers.

---

## 10. File map (for dev/QA triage)

| Area | Primary locations |
|------|-------------------|
| Invoice status helpers | `innago-inspired-refresh/.../invoiceFinancials.ts` |
| Board record gating | `.../invoiceManualRecordPayment.ts`, propmv `invoiceManualRecordPayment.helper.js` |
| Partial policy | propmv `hoaPartialPaymentPolicy.helper.js`, `useAcceptPartialPayments.ts` |
| Owner pay UI | `OwnerPaymentDialog.tsx`, `PayableNowCard.tsx` |
| Payload tracker UI | `TransactionStatusTracker.tsx`, `payloadPayinStatusDisplay.ts` |
| Payload lifecycle API | propmv `payloadPayinLifecycle.util.js`, `payloadWebhook.service.js`, enrich helper on invoice read |

---

*Last aligned with Payload tracker wiring, stage-aware board Record Payment, and Accept Partial Payments enforcement for owner + board.*
