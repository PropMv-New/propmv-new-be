# PropMv Email Functionality Verification Report

**Overall result: PASS** - all email templates respect enable/disable flags and deliver correctly over live SMTP.

## Executive summary

| Item | Value |
| --- | --- |
| Recipient | `hiteshchavhan0811@gmail.com` |
| SMTP | Primary Gmail (`smtp.gmail.com:587` via `.env.local`) |
| Production send path | `emailHelper.sendEmail` → `smtpDelivery.service` |
| Templates tested | **41** |
| Live SMTP scenarios (flag false + true) | **82 / 82 PASS** |
| Capture + transactional scenarios | **108 / 108 PASS** |
| Live emails delivered (flag=true only) | **41** |
| Emails blocked when flag=false | **41** (SMTP never called) |
| Report generated | 2026-08-30T15:59:38.892Z |

## What was tested

For **each** known email template / functionality:

1. **Flag OFF** - set `EMAIL_TEMPLATE_<SLUG>_ENABLED=false` in-process (same runtime mechanism as `.env.local`), call production `emailHelper.sendEmail`, assert:
   - `isEmailTemplateEnabled` returns false
   - send returns `false`
   - SMTP is **not** invoked (no delivery)
2. **Flag ON** - set `EMAIL_TEMPLATE_<SLUG>_ENABLED=true`, call the same production path, assert:
   - flag reads true
   - send returns `true`
   - live SMTP accepts the message (Gmail `250 OK`)
   - message delivered to `hiteshchavhan0811@gmail.com`

Additionally (capture mode, no inbox spam): templates that use `transactionalEmail.service` were verified for both flag states (26 extra scenarios, all PASS).

## How to find the emails in your inbox

Subject prefix: `[Flag Verify][ON] <template-name>`

Example: `[Flag Verify][ON] welcome`, `[Flag Verify][ON] invoice-created`, etc.

You should see **41** messages. There are **no** messages for the flag=false runs (by design).

## Per-template results (live SMTP)

| # | Template | Env key | Component | OFF (no send) | ON (live send) | Message ID |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | `welcome` | `EMAIL_TEMPLATE_WELCOME_ENABLED` | auth.service (notifyWelcomeEmailInBackground) | **PASS** | **PASS** | <3ce1278d-0478-0207-4812-a9a726fc5c5b@navgurukul.org> |
| 2 | `mfa-otp` | `EMAIL_TEMPLATE_MFA_OTP_ENABLED` | auth.service / paymentVerify.service (sendMfaOtpEmail) | **PASS** | **PASS** | <1e773bfb-8c6e-423d-5f76-22c1da564f45@navgurukul.org> |
| 3 | `email-verification` | `EMAIL_TEMPLATE_EMAIL_VERIFICATION_ENABLED` | emailHelper.sendEmailVerificationEmail (signup OTP) | **PASS** | **PASS** | <972ab2d1-828b-8789-549e-607319344f41@navgurukul.org> |
| 4 | `forgot-password` | `EMAIL_TEMPLATE_FORGOT_PASSWORD_ENABLED` | auth.service (sendForgotPasswordEmail) | **PASS** | **PASS** | <40bde4f6-8e9a-4ee7-f324-2b93222345ec@navgurukul.org> |
| 5 | `invoice-due-today` | `EMAIL_TEMPLATE_INVOICE_DUE_TODAY_ENABLED` | invoiceLifecycleEmail.service / paymentReminderAutomation.service | **PASS** | **PASS** | <147d6368-d500-5dca-8371-0bff3ecb1ec9@navgurukul.org> |
| 6 | `invoice-overdue` | `EMAIL_TEMPLATE_INVOICE_OVERDUE_ENABLED` | invoiceLifecycleEmail.service / paymentReminderAutomation.service | **PASS** | **PASS** | <327536b8-5ae0-93bf-c15d-f2fa7d9acafe@navgurukul.org> |
| 7 | `invoice-schedule-summary` | `EMAIL_TEMPLATE_INVOICE_SCHEDULE_SUMMARY_ENABLED` | invoiceLifecycleEmail.service / invoiceScheduleNotify.service | **PASS** | **PASS** | <034aeddd-7ab1-15f0-c3ab-b3ab13becc74@navgurukul.org> |
| 8 | `late-fee-notification` | `EMAIL_TEMPLATE_LATE_FEE_NOTIFICATION_ENABLED` | invoiceNotificationEmailHelper.sendLateFeeNotificationEmail | **PASS** | **PASS** | <68733860-e80e-3c7c-3739-2f296da528d5@navgurukul.org> |
| 9 | `invite` | `EMAIL_TEMPLATE_INVITE_ENABLED` | portalInvitation.service / owner.service / tenant.service | **PASS** | **PASS** | <df835cfc-c897-d96c-3bfd-9154a46e4b1f@navgurukul.org> |
| 10 | `unit-assignment` | `EMAIL_TEMPLATE_UNIT_ASSIGNMENT_ENABLED` | unitAssignmentEmailHelper | **PASS** | **PASS** | <861f3ae4-da02-b46c-3318-3cf54556f1aa@navgurukul.org> |
| 11 | `owner-removal-notice` | `EMAIL_TEMPLATE_OWNER_REMOVAL_NOTICE_ENABLED` | ownerRemovalNoticeEmailHelper | **PASS** | **PASS** | <255a30d3-b43f-9350-3332-28ee5fcafc65@navgurukul.org> |
| 12 | `invoice-created` | `EMAIL_TEMPLATE_INVOICE_CREATED_ENABLED` | invoiceLifecycleEmail.service | **PASS** | **PASS** | <43f8ddeb-29d1-8b0a-6128-93a1a86467de@navgurukul.org> |
| 13 | `payment-reminder` | `EMAIL_TEMPLATE_PAYMENT_REMINDER_ENABLED` | paymentReminderAutomation.service / invoice.service | **PASS** | **PASS** | <ab121346-10a4-06af-e09b-022d634307fc@navgurukul.org> |
| 14 | `payment-recorded` | `EMAIL_TEMPLATE_PAYMENT_RECORDED_ENABLED` | invoiceLifecycleEmail.service | **PASS** | **PASS** | <9706e987-5eb6-13c9-af36-85d8135b0cd1@navgurukul.org> |
| 15 | `payment-deleted` | `EMAIL_TEMPLATE_PAYMENT_DELETED_ENABLED` | invoiceLifecycleEmail.service | **PASS** | **PASS** | <dd4830ff-2346-7533-d266-be4495ba1506@navgurukul.org> |
| 16 | `invoice-updated` | `EMAIL_TEMPLATE_INVOICE_UPDATED_ENABLED` | invoiceLifecycleEmail.service | **PASS** | **PASS** | <2c873a8a-b3c6-6a5b-0fc3-f02c2e4c8fc2@navgurukul.org> |
| 17 | `invoice-balance-waived` | `EMAIL_TEMPLATE_INVOICE_BALANCE_WAIVED_ENABLED` | invoiceLifecycleEmail.service | **PASS** | **PASS** | <b4386afd-1bdb-8c2c-a0cf-ef0d8fd45a70@navgurukul.org> |
| 18 | `maintenance-ticket-created` | `EMAIL_TEMPLATE_MAINTENANCE_TICKET_CREATED_ENABLED` | maintenanceEmailHelper | **PASS** | **PASS** | <a05f804a-e5e1-17e5-6d51-3d6bca42b2a5@navgurukul.org> |
| 19 | `maintenance-ticket-updated` | `EMAIL_TEMPLATE_MAINTENANCE_TICKET_UPDATED_ENABLED` | actionUpdateEmail.service | **PASS** | **PASS** | <f3ba35b4-e04f-d3d2-abb4-0099f9565fa7@navgurukul.org> |
| 20 | `maintenance-ticket-resolved` | `EMAIL_TEMPLATE_MAINTENANCE_TICKET_RESOLVED_ENABLED` | actionUpdateEmail.service | **PASS** | **PASS** | <ec9aefb7-6565-a096-8bbb-923fc52ee372@navgurukul.org> |
| 21 | `hoa-document-uploaded` | `EMAIL_TEMPLATE_HOA_DOCUMENT_UPLOADED_ENABLED` | hoaDocumentNotify | **PASS** | **PASS** | <1890f9d5-3818-171d-aaee-5b601c14795e@navgurukul.org> |
| 22 | `hoa-board-invite` | `EMAIL_TEMPLATE_HOA_BOARD_INVITE_ENABLED` | hoa.controller | **PASS** | **PASS** | <8eb9d547-e0b8-47dd-7b29-29e46234d0e3@navgurukul.org> |
| 23 | `payment-received` | `EMAIL_TEMPLATE_PAYMENT_RECEIVED_ENABLED` | invoiceNotificationEmailHelper / invoiceLifecycleEmail.service | **PASS** | **PASS** | <855dd4b5-62e2-3248-5e1c-9d565222822c@navgurukul.org> |
| 24 | `maintenance-request-created-landlord` | `EMAIL_TEMPLATE_MAINTENANCE_REQUEST_CREATED_LANDLORD_ENABLED` | maintenanceEmailHelper | **PASS** | **PASS** | <937ce509-8d82-a3a8-6491-50cc62837ab4@navgurukul.org> |
| 25 | `hoa-board-access-removed` | `EMAIL_TEMPLATE_HOA_BOARD_ACCESS_REMOVED_ENABLED` | hoaBoardMemberAccess.helper | **PASS** | **PASS** | <0c2d587e-3c04-7a78-6270-202cc9de325a@navgurukul.org> |
| 26 | `ownership-change-scheduled` | `EMAIL_TEMPLATE_OWNERSHIP_CHANGE_SCHEDULED_ENABLED` | ownershipChangeEmailHelper | **PASS** | **PASS** | <c4187451-af44-4b0c-1241-036d58ec0806@navgurukul.org> |
| 27 | `ownership-change-effective` | `EMAIL_TEMPLATE_OWNERSHIP_CHANGE_EFFECTIVE_ENABLED` | ownershipChangeEmailHelper | **PASS** | **PASS** | <90af013e-d20d-c248-ef1f-c58763ad4b43@navgurukul.org> |
| 28 | `unit-credit-expense-notice` | `EMAIL_TEMPLATE_UNIT_CREDIT_EXPENSE_NOTICE_ENABLED` | unitCreditExpenseNoticeEmailHelper | **PASS** | **PASS** | <d0f4d3ee-111a-69ef-de1c-8c97305cbaf5@navgurukul.org> |
| 29 | `payment-failed` | `EMAIL_TEMPLATE_PAYMENT_FAILED_ENABLED` | invoiceNotificationEmailHelper | **PASS** | **PASS** | <03db3260-b68b-4b9c-1893-27ad0c02d8a1@navgurukul.org> |
| 30 | `late-fee-invoice-notification` | `EMAIL_TEMPLATE_LATE_FEE_INVOICE_NOTIFICATION_ENABLED` | lateFeeInvoice.service (landlord) | **PASS** | **PASS** | <6004f13e-c525-f33a-65a3-c16a7aac8f5c@navgurukul.org> |
| 31 | `maintenance-ticket-notification` | `EMAIL_TEMPLATE_MAINTENANCE_TICKET_NOTIFICATION_ENABLED` | maintenanceNotificationEmailQueue / email.processor | **PASS** | **PASS** | <38640deb-9e6f-7e9d-03f7-89aaa2237fc7@navgurukul.org> |
| 32 | `maintenance-request-created-tenant` | `EMAIL_TEMPLATE_MAINTENANCE_REQUEST_CREATED_TENANT_ENABLED` | maintenanceEmailHelper | **PASS** | **PASS** | <51ac4419-1ec9-38b8-bbfe-8b5b35ef61a6@navgurukul.org> |
| 33 | `action-update` | `EMAIL_TEMPLATE_ACTION_UPDATE_ENABLED` | actionUpdateEmail.service (legacy slug) | **PASS** | **PASS** | <3f67b68c-b7b7-5356-9942-001cc6e15256@navgurukul.org> |
| 34 | `note-reminder` | `EMAIL_TEMPLATE_NOTE_REMINDER_ENABLED` | noteReminder.service | **PASS** | **PASS** | <9fd9f67b-6f1f-3557-c240-89626be58149@navgurukul.org> |
| 35 | `invoice-template` | `EMAIL_TEMPLATE_INVOICE_TEMPLATE_ENABLED` | landlord invoice.service / income.service | **PASS** | **PASS** | <691ca932-f865-76e3-698c-b84947619dc7@navgurukul.org> |
| 36 | `screening-application` | `EMAIL_TEMPLATE_SCREENING_APPLICATION_ENABLED` | leaseTenantInviteDelivery.service / application.service | **PASS** | **PASS** | <227f06f6-d91a-e690-5bf2-ea69210d45b6@navgurukul.org> |
| 37 | `application-accepted` | `EMAIL_TEMPLATE_APPLICATION_ACCEPTED_ENABLED` | application.service | **PASS** | **PASS** | <e6a04b65-3dd0-39c5-a5ab-00971f050c37@navgurukul.org> |
| 38 | `coming-soon-launch` | `EMAIL_TEMPLATE_COMING_SOON_LAUNCH_ENABLED` | emailSubscriptionLaunchNotify.service | **PASS** | **PASS** | <1a9c3a21-d3a2-59b7-8336-a638ac922e93@navgurukul.org> |
| 39 | `coming-soon-subscription` | `EMAIL_TEMPLATE_COMING_SOON_SUBSCRIPTION_ENABLED` | emailSubscriptionNotify.service | **PASS** | **PASS** | <37e4f0a2-fdcb-db9a-aca3-54aa88b4c568@navgurukul.org> |
| 40 | `demo-request-acknowledgement` | `EMAIL_TEMPLATE_DEMO_REQUEST_ACKNOWLEDGEMENT_ENABLED` | demoRequestNotify.service | **PASS** | **PASS** | <41a62566-6d2a-2add-f3a0-46dcb1f5aa24@navgurukul.org> |
| 41 | `demo-request-team-notification` | `EMAIL_TEMPLATE_DEMO_REQUEST_TEAM_NOTIFICATION_ENABLED` | demoRequestNotify.service | **PASS** | **PASS** | <7d904567-7b5c-5b60-b55c-bca5dcbaa74f@navgurukul.org> |

## Transactional path coverage (capture mode)

These templates also go through `transactionalEmail.service` in production. Both flag states were verified (SMTP stubbed after the production gate):

| Template | OFF | ON |
| --- | --- | --- |
| `invoice-balance-waived` | **PASS** (skipped_disabled) | **PASS** (sent=true) |
| `invoice-created` | **PASS** (skipped_disabled) | **PASS** (sent=true) |
| `invoice-due-today` | **PASS** (skipped_disabled) | **PASS** (sent=true) |
| `invoice-overdue` | **PASS** (skipped_disabled) | **PASS** (sent=true) |
| `invoice-schedule-summary` | **PASS** (skipped_disabled) | **PASS** (sent=true) |
| `invoice-updated` | **PASS** (skipped_disabled) | **PASS** (sent=true) |
| `maintenance-ticket-created` | **PASS** (skipped_disabled) | **PASS** (sent=true) |
| `maintenance-ticket-resolved` | **PASS** (skipped_disabled) | **PASS** (sent=true) |
| `maintenance-ticket-updated` | **PASS** (skipped_disabled) | **PASS** (sent=true) |
| `payment-deleted` | **PASS** (skipped_disabled) | **PASS** (sent=true) |
| `payment-received` | **PASS** (skipped_disabled) | **PASS** (sent=true) |
| `payment-recorded` | **PASS** (skipped_disabled) | **PASS** (sent=true) |
| `payment-reminder` | **PASS** (skipped_disabled) | **PASS** (sent=true) |

## Expected vs actual behavior

| Scenario | Expected | Actual |
| --- | --- | --- |
| `EMAIL_TEMPLATE_*_ENABLED=false` | Email must not send | Working as expected - all 41 returned false, smtpCalls=0 |
| `EMAIL_TEMPLATE_*_ENABLED=true` | Email must send via production SMTP | Working as expected - all 41 delivered with Gmail 250 OK |
| Transactional wrapper + flag=false | Skipped with reason=disabled | Working as expected |
| Transactional wrapper + flag=true | sent=true | Working as expected |

## Failures

None.

## Re-run commands

```bash
# Live SMTP to a mailbox (one email per template when ON)
EMAIL_TEMPLATE_VERIFY_MODE=real EMAIL_TEMPLATE_VERIFY_TO=hiteshchavhan0811@gmail.com EMAIL_TEMPLATE_VERIFY_SKIP_TRANSACTIONAL=true npm run verify:email-template-flags:real

# Fast gate check including transactional path (no real delivery)
npm run verify:email-template-flags
```

## Notes

- Flags were toggled on `process.env` per scenario - identical to reading `EMAIL_TEMPLATE_*` from `.env.local` at runtime. The file itself was not permanently rewritten so local disables stay intact after the test.
- Path under test is the same code deployed in production: `emailHelper.sendEmail` / `transactionalEmail.service` → `smtpDelivery.service`.
- Detailed row logs: `docs/EMAIL_TEMPLATE_FLAG_VERIFICATION_REPORT_REAL.md` (live) and `docs/EMAIL_TEMPLATE_FLAG_VERIFICATION_REPORT.md` (capture + transactional).
- Harness: `scripts/verify-email-template-flags.js`

