# HOA Owner Auto Pay (Payload) — QA Test Guide

> **Canonical document (use this):**  
> **[`HOA-Owner-Autopay-Implementation-and-QA.md`](./HOA-Owner-Autopay-Implementation-and-QA.md)**  
> — full implementation overview + QA test cases + confirmation that `roadmap-autopay.md` is sufficient for engineers.

This file is kept so older links and PDF export notes still resolve. It also documents the **Autopay invoice ownership scope** regression (Owner Invoices vs Auto Pay card).

**Engineering:** [`roadmap-autopay.md`](./roadmap-autopay.md) (§17.4 ownership scope, §18 code map) · [`existing-architecture.md`](./existing-architecture.md) (§ Owner autopay)

**Optional PDF:** export `HOA-Owner-Autopay-Implementation-and-QA.md` via Markdown PDF / pandoc.

---

## Autopay invoice ownership scope (regression)

### Problem that was fixed

Owner Invoices could show Upcoming invoices (e.g. **INV563768**, due Aug 02, 2027) while Auto Pay showed **“No upcoming charge”** (`nextAutopay: null`).

**Cause:** Autopay queried `'tenants.userId'`, but HOA invoices store `tenants` as **`[ObjectId]`**. That Mongo path matched nothing. Owner Invoices correctly use property scope via `applyOwnerPayerInvoiceScope` → `resolveHoaOwnerInvoicePropertyIds`.

### Correct Autopay scope (production)

| Gate | Rule |
|------|------|
| Property universe | Same as Owner Invoices: `resolveHoaOwnerInvoicePropertyIds(ownerId)` |
| HOA | Enrollment `hoaId` |
| Chargeability | **`tenants: ownerOid`** (owner must be stamped on the invoice) |
| Eligibility | `balanceDue > 0`, valid `dueDate`, not deleted, non-terminal status |

**Never** Autopay-charge from property scope alone (shared unit / co-owner isolation).

Implementation: `payloadAutopayInvoiceScope.util.js` — used by next/last Autopay, mirror sync, disable cleanup, daily repair, and `syncInvoiceIfOwnerEnrolled`.

### QA checks for this fix

| ID | Steps | Expected |
|----|--------|----------|
| AP-SCOPE-01 | Owner enrolled; open invoice on unit where owner is in `tenants[]` (e.g. INV563768) | `GET /autopay?hoaId=` → `nextAutopay.invoiceNumber` matches that invoice; date/amount from `balanceDue` + fee util |
| AP-SCOPE-02 | Two open invoices for same owner | Next = **earliest** `dueDate` only |
| AP-SCOPE-03 | Second owner on same HOA/property but **not** in `tenants[]` | That owner’s Autopay must **not** select the first owner’s invoice |
| AP-SCOPE-04 | Co-owners **both** on `tenants[]` | Either enrolled co-owner may mirror/charge (shared-payer) |
| AP-SCOPE-05 | Invoice visible on Owner Invoices only via property assignment, owner **absent** from `tenants[]` | Must **not** appear as Autopay next charge |
| AP-SCOPE-06 | Partial/manual pay / credit / waive before due | Mirror updates or closes; `assertMirrorSafeForAutopay` still protects amounts |
| AP-SCOPE-07 | Enable or change Autopay PM with open eligible invoice | `payloadAutopayMirror.payloadInvoiceId` set; Payload `external_uid` = PropMV `_id` |
| AP-SCOPE-08 | Card vs ACH enrollment | Fee quote still from `calculatePayloadProcessingFee` by method type; settlement/webhook paths unchanged |

### Automated coverage

```bash
cd propmv && node --test \
  src/shared/modules/payment/providers/payload/utils/payloadAutopayInvoiceScope.util.test.js \
  src/shared/modules/payment/providers/payload/utils/payloadInvoiceSync.util.test.js \
  src/shared/modules/payment/providers/payload/utils/payloadMirrorSafety.util.test.js \
  src/common/helpers/hoaPropertyScope.test.js
```

### Related full QA matrix

Use **Part B** in [`HOA-Owner-Autopay-Implementation-and-QA.md`](./HOA-Owner-Autopay-Implementation-and-QA.md) for enrollment, webhooks, Card/ACH settle, and sandbox Phase-0 cases.
