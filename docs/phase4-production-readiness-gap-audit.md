# Phase 4 — Production-Readiness Gap Audit & Deployment Plan

**Date:** 2026-10-09  
**Mode:** PLAN / READ-ONLY AUDIT ONLY  
**No** live Card/ACH, **no** flag enablement, **no** code/config/data changes performed in this audit.

---

## Current Phase 4 production-readiness verdict

**NO-GO — not production-ready.**

Primary blocker is **deployment / branch promotion**, not nginx alone and not a missing canary allowlist as the first step.

| Layer | Verdict |
| --- | --- |
| Production API host | Up (`GET /health` = 200) |
| Payload routes on production | **Absent** (404) |
| Phase 4 Vendor Pay code | **Not in git remotes**; largely uncommitted local work |
| HOA Payload stack | Present on `origin/development` / `payment-fix` HEAD; **not** on `origin/production` or `origin/staging` |
| Canary allowlist | Not required to fix 404s; **still recommended** before any broad flag enable (document separately) |

---

## Exact root cause of the production 404s

### Observed

| Probe | Result |
| --- | --- |
| `GET https://api.propmv.com/health` | **200** |
| `POST https://api.propmv.com/api/webhooks/rainforest` | **401** (route exists; signature rejected) |
| `POST https://api.propmv.com/api/webhooks/payload` | **404** Express: `Cannot POST /api/webhooks/payload` |
| `GET https://api.propmv.com/api/v1/payments/payload/config` | **404** Express: `Cannot GET ...` |

### Root cause (ranked)

**Primary: old / wrong backend artifact — `origin/production` does not contain Payload route registration.**

Evidence from git:

- `origin/production` `src/app.js` mounts Rainforest + Straddle webhooks only — **no** `payloadRouter`, **no** `payloadWebhookRouter`.
- `origin/staging` same: Rainforest present, Payload mounts **absent**.
- Current workspace `payment-fix` / `origin/development` `src/app.js` **does** mount:
  - `/api/v1/payments/payload`
  - `/api/webhooks/payload`
- Production deploy workflow (`.github/workflows/deploy.yml`) **only** deploys when dispatched with the **`production` branch**, and guards that `origin/production` contains `origin/staging` history. EC2 resets to that branch tip. Protected config is `.env.production` on the server (secrets not in git).

Therefore production PM2 (`propmv-backend`) is running a tree **without Payload Express routes**. Express’s default handler returns exactly the observed “Cannot GET/POST …” HTML 404s.

### Ruled out / secondary

| Hypothesis | Assessment |
| --- | --- |
| Missing route registration in **current** Phase 4 repo tree | **No** — routes are registered in local/development app.js |
| Nginx blocking only Payload | **Unlikely** — Rainforest webhook on same host works; health works; 404 body is Express, not nginx |
| PM2 cwd mismatch | **Unlikely as primary** — other payment webhooks resolve; matches branch content without Payload |
| Wrong path (`/api/v1/webhooks/payload`) | Documented path is `/api/webhooks/payload`; both 404 on prod |
| Phase 4-only bug | **No** — even HOA Payload `/config` 404s; entire Payload surface missing from deployed branch |

---

## Phase 4 code vs deployability

### What production needs (ordered)

1. **Promote HOA Payload foundation** (already on `development`, not on `production`/`staging`):  
   `/api/v1/payments/payload/*` + `/api/webhooks/payload` + models/services already in those branches’ history relative to production.
2. **Commit + promote Vendor Phase 1–4 work** currently **untracked / modified only in the working tree** on this machine (not on `origin/payment-fix` / `origin/development`):
   - Untracked examples: `payloadVendorPayin.service.js`, `payloadVendorPayin.model.js`, `payloadVendorEligibility.service.js`, `vendorInvoiceGatewayPayment.helper.js`, Phase 0–4 scripts/docs  
   - Modified examples: `payload.routes.js`, `payload.controller.js`, `payloadWebhook.service.js`, `payload.config.js` (`vendorMerchantEnabled` / `vendorPayEnabled`), privileges, frontend Vendor pay UI
3. **Frontend** Vendor Pay changes similarly local/uncommitted relative to a production FE deploy pipeline.

### Conclusion on “deployable without additional code changes?”

| Question | Answer |
| --- | --- |
| Can production expose Payload routes by deploy alone today? | **Only after** merging the Payload-enabled branch chain into `staging` → Testing EC2 → `production` → Production EC2. Today’s `origin/production` **cannot**. |
| Is Phase 4 Vendor Pay deployable without more code? | **Architecturally yes once committed**, with flag default **false**. **Not deployable as-is** because it is **not committed / not on deploy branches**. |
| Must canary allowlist land before 404 fix? | **No.** Fix branch promotion first. |

---

## Production prerequisites audit

| Prerequisite | Status in this audit |
| --- | --- |
| `PAYLOAD_ENVIRONMENT=production` on EC2 `.env.production` | Unknown (server-only file; not readable here). Required. |
| Production `PAYLOAD_SECRET_KEY` in `.env.production` | Unknown; must not be copied to sandbox/staging. |
| Payload webhook URL in Payload dashboard → `https://api.propmv.com/api/webhooks/payload` | Pointless until route exists on prod. |
| `PAYLOAD_WEBHOOK_BEARER` (optional but recommended) | Not on local runner; set only in prod `.env.production` + Payload Webhook OAuth/bearer delivery. |
| Vendor PA ACTIVE + default deposit bank | Unverified in production data. |
| Owner Customer + send PM | Unverified in production. |
| Payable assigned VendorInvoice | Unverified / undesignated. |
| DB indexes for `payloadvendorpayins` etc. | Created by Mongoose on first boot of code that defines models — requires deploy of that code. |
| `PAYLOAD_VENDOR_PAY_ENABLED` | Process-wide; must stay **false** until GO. |
| `PAYLOAD_VENDOR_MERCHANT_ENABLED` | May be used for onboarding independently; still false-safe for execute if pay flag off. |
| Frontend `VITE_PAYLOAD_VENDOR_PAY_ENABLED` | Must stay false until enablement; must match server. |

---

## Phase 4 implementation safety (local design review)

Based on local Phase 4 engine design (sandbox-verified earlier; **not** on production):

| Concern | Local design |
| --- | --- |
| Server-side Vendor/Owner/PM resolution | Yes — no client-trusted merchant/bank/customer IDs |
| Amount = invoice only, fee 0 | Yes |
| Balance / in-flight collectable | Yes — `amountPaid + inFlight + new ≤ subAmount` |
| PropMV idempotency primary | Yes — unique `idempotencyKey` |
| Payload `duplicate_attempt` secondary | Yes |
| Webhook re-fetch | Yes — `GET /transactions/{id}` before apply |
| Settlement util sole authority | Yes — `resolvePayloadPayinSettlementAction` |
| ACH async / Card per util | Yes |
| Fail / reverse books | Yes — VendorInvoice gateway helper |
| No PM / deposit mutation on execute | Yes — read-only customer/PM resolution |
| Manual Record Payment coexistence | Preserved when pay gated |
| Reconciliation / recovery | Attempt id + webhook; ops reconcile for Vendor still light vs HOA |

Residual production-only risks remain (live ACTIVE PA, live ACH returns, live webhooks) — see category E.

---

## Classification A–E

### A. Production-ready (infra already proven)

- Production API host health
- Rainforest webhook path pattern on same host
- Deploy pipeline model: protected `.env.production`, PM2 reload, staging→production ancestry guard
- Manual Vendor Record Payment (pre-existing; unrelated to Payload Vendor Pay)

### B. Sandbox-only proven, architecturally production-ready (once deployed + flagged off)

- Owner→Vendor charge shape (Phase 0)
- Vendor PA / banks (Phase 1–2)
- Eligibility + broken-path gate (Phase 3)
- Payment engine semantics (Phase 4 sandbox gates)
- Settlement util / fee=0 / default-bank-only / idempotency patterns

### C. Requires code / git work before production

1. **Commit** Phase 1–4 Vendor Pay + related backend/frontend changes.  
2. **Merge/promote** Payload foundation + Vendor Pay through `development` → `staging` → Testing EC2 → `production` → Production EC2.  
3. Ensure `payloadVendorPayin` model indexes boot cleanly.  
4. (Optional, separate) Canary allowlist — **only if** first enablement must not be global (recommended later; **not** required to fix 404s).

### D. Requires production infrastructure / deployment work

1. Deploy Payload-enabled backend to Production EC2 (branch promotion).  
2. Confirm `.env.production`: `PAYLOAD_ENABLED`, `PAYLOAD_ENVIRONMENT=production`, production secret key, optional `PAYLOAD_WEBHOOK_BEARER`; keep `PAYLOAD_VENDOR_PAY_ENABLED=false`.  
3. Register Payload dashboard webhook to live URL after route exists.  
4. Deploy frontend build with Vendor Pay UI present but `VITE_PAYLOAD_VENDOR_PAY_ENABLED=false`.  
5. Designate production canary Vendor / HOA / Owner / Invoice; verify ACTIVE PA + default bank + Owner PM.

### E. Requires real Payload production verification (cannot simulate in sandbox)

- Live Vendor PA underwriting ACTIVE  
- Live Card lifecycle + billing address  
- Live ACH pending → settle / return  
- Live webhook delivery + auth + re-fetch on prod URL  
- Duplicate webhook / timeout recovery on prod rail  
- Concurrency under prod load  
- Monitoring / rollback drill on prod  

---

## Canary allowlist

**Not required to remediate 404s or deploy Payload routes.**

**Still recommended before any `PAYLOAD_VENDOR_PAY_ENABLED=true`** because the flag is process-wide. Smallest safe design (document only — do not implement in this audit):

- Env allowlist of one `VendorInvoice` id (optional HOA/Vendor match)
- Execute/validate allowed if global flag **or** allowlisted invoice in `production`
- Keep global flag false during canary

Defer implementation until after D (deploy) succeeds and routes return non-404.

---

## Required deployment / configuration fixes (no code logic change)

1. Promote Payload-capable backend to `staging`, verify on Testing EC2:  
   - `GET /api/v1/payments/payload/config` ≠ 404  
   - `POST /api/webhooks/payload` ≠ 404 (expect 400/401 without valid body/bearer — proves route)  
2. Promote same history to `production` per workflow ancestry guard; deploy Production EC2.  
3. Re-probe production URLs until Payload routes respond.  
4. Configure prod Payload env + webhook registration; flag remains **false**.  
5. Only then designate canary entities and plan live-rail verification.

---

## Required code fixes (if any)

| Item | Needed now? |
| --- | --- |
| Fix Express route registration for Payload | **No** — already correct on development/payment-fix trees |
| Nginx rewrite for Payload | **No** evidence required if Express 404 is from missing mount |
| Commit + merge Phase 1–4 Vendor Pay | **Yes** — packaging/promotion, not a runtime bugfix |
| Canary allowlist | **Not for 404**; optional before enablement |

---

## Sandbox verification still required

- Re-run Phase 1–4 unit/gates after commit (clean CI)  
- Confirm FE/BE flag defaults false  
- Confirm no HOA Owner→HOA / Record Payment regressions in CI  

(Already largely done on dirty tree; must pass on committed tree.)

---

## Production-only verification that cannot be simulated

G1, G3–G13 live-rail gates from the production-readiness plan (ACTIVE PA, Card/ACH, webhooks, recovery, concurrency, monitoring, rollback).

---

## Is Phase 4 architecturally production-ready after identified fixes?

**Yes, with flag default false** — after:

1. Commit + promote code  
2. Production deploy exposes Payload routes  
3. Prod env/webhook configured  
4. Live-rail GO checklist passes  

**Not ready today.**

---

## Recommended exact next implementation step

**Do not implement canary allowlist next.**

**Next step:**  
**Promote and deploy the Payload-enabled backend (HOA Payload foundation already on `development`) onto Staging/Testing EC2, prove Payload routes non-404, then promote to `production` / Production EC2 — while keeping `PAYLOAD_VENDOR_PAY_ENABLED=false`. In parallel, commit Phase 1–4 Vendor Pay so it can ride the same promotion train (or an immediate follow-on deploy).**

Only after production probes show Payload routes alive: designate canary entities → decide allowlist vs controlled enable window → live-rail verification → separate enablement approval.

---

## GO / NO-GO criteria for eventual production enablement

**GO** only when all are true:

1. Production `GET /api/v1/payments/payload/config` works (auth as designed).  
2. Production `POST /api/webhooks/payload` accepts/rejects at app layer (not Express Cannot POST).  
3. Phase 1–4 Vendor Pay committed and deployed; flag **false** until enablement.  
4. Production Vendor ACTIVE PA + default bank + Owner PM + designated invoice verified.  
5. Live Card + ACH + webhook auth/re-fetch + idempotency + recovery + concurrency + books + monitoring + rollback = PASS.  
6. HOA Owner→HOA, Record Payment, Autopay/Check21/Rainforest/Straddle unchanged.  
7. Explicit human approval to set `PAYLOAD_VENDOR_PAY_ENABLED=true` (and Vite mirror).

**NO-GO** if any of: Payload routes still 404; Phase 4 uncommitted; live-rail gate fail; global flag on without approval.

---

## Explicit stop

Audit complete. **No code, flag, deploy, or payment changes made.** Awaiting approval before commit/promotion/deploy work.
