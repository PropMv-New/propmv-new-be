# Email delivery safety (PropMv)

Protects Hostinger SMTP reputation when inviting owners.

## Layers

1. **Frontend format + typo checks** (`ownerValidation.ts`)
2. **Confirm email** - board must re-type email before invite when enabled (`EMAIL_REQUIRE_EMAIL_CONFIRM`)
3. **Backend syntax + MX + disposable/typo domains**
4. **SMTP RCPT probe** (`EMAIL_SMTP_RCPT_VERIFY_*`) - free check against recipient MX; blocks nonexistent Gmail locals before Hostinger send
5. **Optional mailbox API** (`EMAIL_MAILBOX_VERIFY_*`) - paid/backup when port 25 is blocked
6. **SMTP permanent bounce** - no retry/failover; suppress address
7. **IMAP bounce poller** - reads Hostinger DSNs and suppresses recipients
8. **Invite rate limits** - tighter caps on owner create + resend-invite
9. **Per-template enable/disable** - `EMAIL_SENDING_ENABLED` + `EMAIL_TEMPLATE_<SLUG>_ENABLED` (true/false/on/off). Unset = enabled. Gated in `emailHelper.sendEmail` via `emailTemplateFlags.js`.

## Production checklist

```bash
# Already recommended in .env.production
EMAIL_VALIDATE_SYNTAX=true
EMAIL_VALIDATE_MX=true
EMAIL_REQUIRE_EMAIL_CONFIRM=true # recommended; unset defaults to backward-compatible false
OWNER_INVITE_SEND_TIMEOUT_MS=10000
EMAIL_SMTP_RCPT_VERIFY_ENABLED=true
EMAIL_SMTP_RCPT_VERIFY_ON_ERROR=allow
EMAIL_BOUNCE_IMAP_ENABLED=true
EMAIL_BOUNCE_IMAP_HOST=imap.hostinger.com
EMAIL_BOUNCE_IMAP_LOOKBACK_DAYS=14

# Optional when outbound :25 is blocked on the app host
EMAIL_MAILBOX_VERIFY_ENABLED=true
EMAIL_MAILBOX_VERIFY_PROVIDER=abstract
EMAIL_MAILBOX_VERIFY_API_KEY=...

EMAIL_BOUNCE_WEBHOOK_SECRET=long-random-secret
```

## Deploy smoke test (run on the production host)

```bash
cd propmv

# 1) Confirm outbound :25 can reach Gmail MX and reject bad locals
npm run check:smtp-rcpt -- pawardurva406@gmail.com
# expect: smtpRcpt.status=reject, code=550

# 2) Suppress any historical bad recipients from Hostinger bounce inbox
npm run poll:email-bounces

# 3) Or suppress one address / ingest a DSN file
npm run suppress:email -- bad@example.com "manual"
npm run ingest:email-bounce -- ./scripts/fixtures/sample-hostinger-bounce.txt

# 4) Unit suite
npm run test:email-delivery

# 5) Sync email-delivery indexes in a maintenance window
npm run ensure:email-delivery-indexes
```

If step 1 fails with `error_allowed` / connection timeout, outbound port 25 is blocked - keep RCPT fail-open and enable `EMAIL_MAILBOX_VERIFY_*`.

## Ops commands

```bash
cd propmv
npm run poll:email-bounces
npm run ingest:email-bounce -- ./bounce.txt
npm run suppress:email -- bad@example.com "reason"
npm run unsuppress:email -- good@example.com
npm run check:smtp-rcpt -- nobody@gmail.com
npm run ensure:email-delivery-indexes
npm run test:email-delivery
```

Bounce webhook auth uses **headers only**:
`x-bounce-webhook-secret` (or `x-webhook-secret`). Query/body secrets are rejected.

## Invite delivery feedback

Owner create/update now **awaits** the invitation SMTP attempt and returns:

- `invitationSent` / `invitationError` on create
- `invitationResent` / `invitationError` on email-change update

`OWNER_INVITE_SEND_TIMEOUT_MS` caps how long these synchronous invite paths wait before returning an invitation error response.

The UI shows a clear error if delivery fails, instead of silently succeeding.

## SMTP RCPT note

Gmail’s `550 5.1.1` for bad locals happens at **RCPT TO**. Probing the recipient MX directly catches that **before** Hostinger/Mailchannels accepts the message. If your host blocks outbound TCP 25, the probe fails open (`ON_ERROR=allow`) and you should enable a mailbox API instead.
