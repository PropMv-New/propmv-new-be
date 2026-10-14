'use strict';

/**
 * Verify EMAIL_TEMPLATE_<SLUG>_ENABLED gating through the production send path.
 *
 * For each known template:
 *   1) flag=false → emailHelper.sendEmail must return false and must NOT call SMTP
 *   2) flag=true  → emailHelper.sendEmail must return true and must call SMTP
 *      (or deliver via real SMTP when EMAIL_TEMPLATE_VERIFY_MODE=real)
 *
 * Also exercises sendTransactionalEmail for templates that use that wrapper.
 *
 * Usage:
 *   node scripts/verify-email-template-flags.js
 *   EMAIL_TEMPLATE_VERIFY_MODE=real node scripts/verify-email-template-flags.js
 *   EMAIL_TEMPLATE_VERIFY_TO=you@example.com EMAIL_TEMPLATE_VERIFY_MODE=real node ...
 *
 * Modes:
 *   capture (default) - stubs smtpDelivery.sendMail (still uses emailHelper + templates)
 *   real              - uses configured SMTP (sends for enabled=true cases only)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env.local');

require('dotenv').config({ path: ENV_PATH });

const MODE = String(process.env.EMAIL_TEMPLATE_VERIFY_MODE || 'capture').trim().toLowerCase();
const REPORT_PATH = path.join(
  ROOT,
  'docs',
  MODE === 'real'
    ? 'EMAIL_TEMPLATE_FLAG_VERIFICATION_REPORT_REAL.md'
    : 'EMAIL_TEMPLATE_FLAG_VERIFICATION_REPORT.md'
);
const TEST_TO =
  process.env.EMAIL_TEMPLATE_VERIFY_TO ||
  process.env.FROM_EMAIL ||
  process.env.SMTP_PRIMARY_FROM ||
  process.env.SUPPORT_TEAM_EMAIL ||
  'verify@propmv.local';

const REAL_SEND_DELAY_MS = Number(process.env.EMAIL_TEMPLATE_VERIFY_DELAY_MS || 800);
const ONLY = String(process.env.EMAIL_TEMPLATE_VERIFY_ONLY || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const SKIP_TRANSACTIONAL =
  String(process.env.EMAIL_TEMPLATE_VERIFY_SKIP_TRANSACTIONAL || '').toLowerCase() === 'true' ||
  String(process.env.EMAIL_TEMPLATE_VERIFY_SKIP_TRANSACTIONAL || '') === '1';

const {
  KNOWN_EMAIL_TEMPLATES,
  templateEnvKey,
  isEmailTemplateEnabled,
} = require('../src/common/helpers/emailTemplateFlags');

const COMPONENT_BY_TEMPLATE = {
  welcome: 'auth.service (notifyWelcomeEmailInBackground)',
  'mfa-otp': 'auth.service / paymentVerify.service (sendMfaOtpEmail)',
  'email-verification': 'emailHelper.sendEmailVerificationEmail (signup OTP)',
  'forgot-password': 'auth.service (sendForgotPasswordEmail)',
  'invoice-due-today': 'invoiceLifecycleEmail.service / paymentReminderAutomation.service',
  'invoice-overdue': 'invoiceLifecycleEmail.service / paymentReminderAutomation.service',
  'invoice-schedule-summary': 'invoiceLifecycleEmail.service / invoiceScheduleNotify.service',
  'late-fee-notification': 'invoiceNotificationEmailHelper.sendLateFeeNotificationEmail',
  invite: 'portalInvitation.service / owner.service / tenant.service',
  'unit-assignment': 'unitAssignmentEmailHelper',
  'owner-removal-notice': 'ownerRemovalNoticeEmailHelper',
  'invoice-created': 'invoiceLifecycleEmail.service',
  'payment-reminder': 'paymentReminderAutomation.service / invoice.service',
  'payment-recorded': 'invoiceLifecycleEmail.service',
  'payment-deleted': 'invoiceLifecycleEmail.service',
  'invoice-updated': 'invoiceLifecycleEmail.service',
  'invoice-balance-waived': 'invoiceLifecycleEmail.service',
  'maintenance-ticket-created': 'maintenanceEmailHelper',
  'maintenance-ticket-updated': 'actionUpdateEmail.service',
  'maintenance-ticket-resolved': 'actionUpdateEmail.service',
  'hoa-document-uploaded': 'hoaDocumentNotify',
  'hoa-board-invite': 'hoa.controller',
  'payment-received': 'invoiceNotificationEmailHelper / invoiceLifecycleEmail.service',
  'maintenance-request-created-landlord': 'maintenanceEmailHelper',
  'hoa-board-access-removed': 'hoaBoardMemberAccess.helper',
  'ownership-change-scheduled': 'ownershipChangeEmailHelper',
  'ownership-change-effective': 'ownershipChangeEmailHelper',
  'unit-credit-expense-notice': 'unitCreditExpenseNoticeEmailHelper',
  'payment-failed': 'invoiceNotificationEmailHelper',
  'late-fee-invoice-notification': 'lateFeeInvoice.service (landlord)',
  'maintenance-ticket-notification': 'maintenanceNotificationEmailQueue / email.processor',
  'maintenance-request-created-tenant': 'maintenanceEmailHelper',
  'action-update': 'actionUpdateEmail.service (legacy slug; updates use ticket templates)',
  'note-reminder': 'noteReminder.service',
  'invoice-template': 'landlord invoice.service / income.service',
  'screening-application': 'leaseTenantInviteDelivery.service / application.service',
  'application-accepted': 'application.service',
  'coming-soon-launch': 'emailSubscriptionLaunchNotify.service',
  'coming-soon-subscription': 'emailSubscriptionNotify.service',
  'demo-request-acknowledgement': 'demoRequestNotify.service',
  'demo-request-team-notification': 'demoRequestNotify.service',
};

const TRANSACTIONAL_TEMPLATES = new Set([
  'invoice-created',
  'invoice-due-today',
  'invoice-overdue',
  'payment-recorded',
  'payment-received',
  'payment-deleted',
  'invoice-updated',
  'invoice-balance-waived',
  'invoice-schedule-summary',
  'payment-reminder',
  'maintenance-ticket-created',
  'maintenance-ticket-updated',
  'maintenance-ticket-resolved',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function baseTemplateData(template) {
  return {
    recipientName: 'Flag Verify',
    userName: 'Flag Verify',
    otp: '123456',
    expiryMinutes: 10,
    inviteLink: 'https://app.propmv.com/invite/test',
    dashboardUrl: 'https://app.propmv.com/dashboard',
    loginUrl: 'https://app.propmv.com/login',
    resetUrl: 'https://app.propmv.com/reset',
    appName: 'PropMv',
    communityName: 'Verify Community',
    hoaName: 'Verify Community',
    propertyName: 'Verify Property',
    unitName: 'Unit 1',
    unitNumber: '1',
    invoiceNumber: 'INV-VERIFY-001',
    invoiceYear: '2026',
    invoiceCount: '1',
    amountDue: '$100.00',
    totalAmountDue: '$100.00',
    dueDate: 'Aug 30, 2026',
    paymentAmount: '$100.00',
    paymentMethod: 'Card',
    remainingBalance: '$0.00',
    paidOn: 'Aug 30, 2026',
    ticketId: 'ticket-verify-1',
    ticketNumber: 'M-1001',
    ticketTitle: 'Verify leak',
    ticketStatus: 'Open',
    issue: 'Plumbing',
    description: 'Flag verification maintenance email',
    priority: 'Normal',
    eventMessage: 'A maintenance request was updated.',
    documentName: 'verify-doc.pdf',
    documentUrl: 'https://app.propmv.com/documents/verify',
    landlordName: 'Verify Landlord',
    landlordEmail: TEST_TO,
    applicantName: 'Flag Verify',
    applicationDate: 'Aug 30, 2026',
    approvalDate: 'Aug 30, 2026',
    propertyAddress: '123 Verify St',
    lateFeeAmount: '$25.00',
    daysOverdue: '3',
    noteTitle: 'Verify note',
    noteBody: 'Reminder verification',
    reminderDate: 'Aug 30, 2026',
    creditAmount: '50.00',
    unitAddress: '123 Verify St',
    performedByName: 'Board Member',
    introParagraph: 'Verification intro for unit credit expense notice.',
    emailHeadline: 'Invoices for 2026',
    introText: 'Verification invoice schedule summary.',
    hasMultipleInvoices: false,
    isNextYear: false,
    showOwnerColumn: false,
    invoiceRows: [
      {
        invoiceNumber: 'INV-VERIFY-001',
        term: 'August 2026',
        dueDate: 'Aug 30, 2026',
        amountDue: '$100.00',
        propertyName: 'Verify Property',
        ownerName: 'Flag Verify',
      },
    ],
    siteUrl: 'https://www.propmv.com',
    signupUrl: 'https://www.propmv.com/signup',
    companyName: 'Verify Co',
    requestType: 'Product demo',
    preferredDate: 'Sep 1, 2026',
    message: 'Please schedule a demo.',
    action: 'login',
    _verifyTemplate: template,
  };
}

function setTemplateFlag(template, enabled) {
  const key = templateEnvKey(template);
  if (!key) throw new Error(`No env key for template ${template}`);
  process.env.EMAIL_SENDING_ENABLED = 'true';
  process.env[key] = enabled ? 'true' : 'false';
  return key;
}

function clearSmtpCaptures(smtpDelivery) {
  smtpDelivery.__verifyCaptures = [];
}

function installSmtpCapture(smtpDelivery, { passthrough = false } = {}) {
  smtpDelivery.__verifyCaptures = [];
  smtpDelivery.__verifyOriginalSendMail = smtpDelivery.sendMail.bind(smtpDelivery);
  smtpDelivery.sendMail = async (mailOptions) => {
    if (passthrough) {
      const info = await smtpDelivery.__verifyOriginalSendMail(mailOptions);
      smtpDelivery.__verifyCaptures.push({
        to: mailOptions.to,
        subject: mailOptions.subject,
        from: mailOptions.from,
        htmlLength: mailOptions.html ? String(mailOptions.html).length : 0,
        messageId: info?.messageId || '',
        response: info?.response || '',
      });
      return info;
    }
    smtpDelivery.__verifyCaptures.push({
      to: mailOptions.to,
      subject: mailOptions.subject,
      from: mailOptions.from,
      htmlLength: mailOptions.html ? String(mailOptions.html).length : 0,
      messageId: `<verify-capture-${Date.now()}@propmv.local>`,
    });
    return {
      messageId: `<verify-capture-${Date.now()}@propmv.local>`,
      accepted: [mailOptions.to],
      rejected: [],
      response: '250 OK (captured)',
    };
  };
}

function restoreSmtp(smtpDelivery) {
  if (smtpDelivery.__verifyOriginalSendMail) {
    smtpDelivery.sendMail = smtpDelivery.__verifyOriginalSendMail;
    delete smtpDelivery.__verifyOriginalSendMail;
  }
  delete smtpDelivery.__verifyCaptures;
}

async function runDirectSend(emailHelper, template, enabled) {
  const envKey = setTemplateFlag(template, enabled);
  const flagReadsEnabled = isEmailTemplateEnabled(template);
  const result = await emailHelper.sendEmail(template, TEST_TO, baseTemplateData(template), {
    template,
    subject: `[Flag Verify][${enabled ? 'ON' : 'OFF'}] ${template}`,
    skipRecipientValidation: true,
    skipPersist: true,
    preheaderText: `PropMv email flag verification for ${template}`,
  });
  return { envKey, flagReadsEnabled, result };
}

async function runTransactionalSend(transactional, template, enabled) {
  const envKey = setTemplateFlag(template, enabled);
  const flagReadsEnabled = isEmailTemplateEnabled(template);
  const result = await transactional.sendTransactionalEmail({
    eventKey: `flag-verify:${template}:${enabled ? 'on' : 'off'}:${Date.now()}`,
    type: template,
    toEmail: TEST_TO,
    data: baseTemplateData(template),
    options: {
      template,
      subject: `[Flag Verify TX][${enabled ? 'ON' : 'OFF'}] ${template}`,
      skipRecipientValidation: true,
      skipPersist: true,
      preheaderText: `PropMv transactional flag verification for ${template}`,
    },
    entityType: 'FlagVerify',
    entityId: template,
    skipDuplicateCheck: true,
  });
  return { envKey, flagReadsEnabled, result };
}

function evaluateDisabled(scenario) {
  const smtpCalled = scenario.smtpCalls > 0;
  const returnedFalse = scenario.result === false;
  const flagOff = scenario.flagReadsEnabled === false;
  const ok = flagOff && returnedFalse && !smtpCalled;
  return {
    ok,
    expected: 'flag=false, sendEmail→false, SMTP not called',
    actual: `flag=${scenario.flagReadsEnabled}, result=${JSON.stringify(scenario.result)}, smtpCalls=${scenario.smtpCalls}`,
  };
}

function evaluateEnabled(scenario) {
  const smtpCalled = scenario.smtpCalls > 0;
  const returnedTrue = scenario.result === true;
  const flagOn = scenario.flagReadsEnabled === true;
  const ok = flagOn && returnedTrue && smtpCalled;
  return {
    ok,
    expected: 'flag=true, sendEmail→true, SMTP called (or real delivery)',
    actual: `flag=${scenario.flagReadsEnabled}, result=${JSON.stringify(scenario.result)}, smtpCalls=${scenario.smtpCalls}${
      scenario.messageId ? `, messageId=${scenario.messageId}` : ''
    }${scenario.error ? `, error=${scenario.error}` : ''}`,
  };
}

function evaluateTransactionalDisabled(scenario) {
  const smtpCalled = scenario.smtpCalls > 0;
  const skipped =
    scenario.result &&
    scenario.result.sent === false &&
    scenario.result.skipped === true &&
    scenario.result.reason === 'disabled';
  const flagOff = scenario.flagReadsEnabled === false;
  const ok = flagOff && skipped && !smtpCalled;
  return {
    ok,
    expected: 'flag=false, transactional skipped_disabled, SMTP not called',
    actual: `flag=${scenario.flagReadsEnabled}, result=${JSON.stringify(scenario.result)}, smtpCalls=${scenario.smtpCalls}`,
  };
}

function evaluateTransactionalEnabled(scenario) {
  const smtpCalled = scenario.smtpCalls > 0;
  const sent = scenario.result && scenario.result.sent === true;
  const flagOn = scenario.flagReadsEnabled === true;
  const ok = flagOn && sent && smtpCalled;
  return {
    ok,
    expected: 'flag=true, transactional sent=true, SMTP called',
    actual: `flag=${scenario.flagReadsEnabled}, result=${JSON.stringify(scenario.result)}, smtpCalls=${scenario.smtpCalls}${
      scenario.error ? `, error=${scenario.error}` : ''
    }`,
  };
}

function mdEscape(value) {
  return String(value == null ? '' : value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function buildReport({ startedAt, finishedAt, mode, to, rows, summary }) {
  const lines = [];
  lines.push('# Email Template Flag Verification Report');
  lines.push('');
  lines.push('This report verifies that each PropMv system email template respects');
  lines.push('`EMAIL_TEMPLATE_<SLUG>_ENABLED` using the **production** send path');
  lines.push('(`emailHelper.sendEmail` / `transactionalEmail.service`).');
  lines.push('');
  lines.push('## Run metadata');
  lines.push('');
  lines.push(`| Field | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Started | ${startedAt} |`);
  lines.push(`| Finished | ${finishedAt} |`);
  lines.push(`| Mode | \`${mode}\` (${mode === 'real' ? 'live SMTP delivery for enabled=true' : 'SMTP stubbed after emailHelper render/gate'}) |`);
  lines.push(`| Recipient | \`${to}\` |`);
  lines.push(`| Env file | \`.env.local\` (loaded; per-template flags overridden in-process per scenario) |`);
  lines.push(`| Templates tested | ${summary.templates} |`);
  lines.push(`| Scenarios | ${summary.total} |`);
  lines.push(`| Passed | **${summary.passed}** |`);
  lines.push(`| Failed | **${summary.failed}** |`);
  lines.push(`| Overall | **${summary.failed === 0 ? 'PASS' : 'FAIL'}** |`);
  lines.push('');
  lines.push('## Expected behavior');
  lines.push('');
  lines.push('1. When `EMAIL_TEMPLATE_<SLUG>_ENABLED=false` → send path returns skipped/false and **must not** deliver.');
  lines.push('2. When `EMAIL_TEMPLATE_<SLUG>_ENABLED=true` → send path renders the real HTML template and **must** deliver (or invoke SMTP).');
  lines.push('');
  lines.push('## Scenario results');
  lines.push('');
  lines.push('| # | Template | Env key | Component | Path | Flag | Expected | Result | Details |');
  lines.push('| ---: | --- | --- | --- | --- | --- | --- | --- | --- |');

  rows.forEach((row, idx) => {
    lines.push(
      `| ${idx + 1} | \`${row.template}\` | \`${row.envKey}\` | ${mdEscape(row.component)} | ${row.path} | \`${row.flag}\` | ${mdEscape(row.expected)} | **${row.ok ? 'PASS' : 'FAIL'}** | ${mdEscape(row.actual)} |`
    );
  });

  lines.push('');
  lines.push('## Failures');
  lines.push('');
  const failures = rows.filter((r) => !r.ok);
  if (failures.length === 0) {
    lines.push('None. All scenarios matched expected behavior.');
  } else {
    failures.forEach((f) => {
      lines.push(`- **${f.template}** (${f.path}, flag=${f.flag}): expected \`${f.expected}\`; actual \`${f.actual}\``);
    });
  }

  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- Flag overrides are applied on `process.env` for each scenario (same mechanism as `.env.local` at runtime).');
  lines.push('- `.env.local` itself is not permanently mutated by this script.');
  lines.push('- `skipPersist=true` avoids writing Email collection rows during verification.');
  lines.push('- `skipRecipientValidation=true` mirrors trusted system-email callers.');
  lines.push('- Templates without an active `.env.local` line still default to enabled unless overridden; this harness forces both states.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`[verify-email-template-flags] mode=${MODE} to=${TEST_TO}`);
  console.log(`[verify-email-template-flags] templates=${KNOWN_EMAIL_TEMPLATES.length}`);

  process.env.EMAIL_SENDING_ENABLED = 'true';

  const templatesToRun = ONLY.length
    ? KNOWN_EMAIL_TEMPLATES.filter((t) => ONLY.includes(t))
    : KNOWN_EMAIL_TEMPLATES;
  if (!templatesToRun.length) {
    throw new Error(
      `EMAIL_TEMPLATE_VERIFY_ONLY matched no templates: ${ONLY.join(',') || '(empty)'}`
    );
  }
  if (ONLY.length) {
    console.log(`[verify-email-template-flags] ONLY=${templatesToRun.join(',')}`);
  }

  const smtpDelivery = require('../src/common/helpers/smtpDelivery.service');
  // Always wrap sendMail so we can count SMTP invocations.
  // In real mode, passthrough=true still delivers via configured SMTP.
  installSmtpCapture(smtpDelivery, { passthrough: MODE === 'real' });

  // Avoid requiring a live Mongo connection for delivery-log side effects.
  const EmailDeliveryLog = require('../src/common/models/emailDeliveryLog.model');
  EmailDeliveryLog.findOne = async () => null;
  EmailDeliveryLog.create = async (doc) => doc;

  const emailHelper = require('../src/common/helpers/emailHelper');
  const transactional = require('../src/common/helpers/transactionalEmail.service');

  const rows = [];

  try {
    for (const template of templatesToRun) {
      const component = COMPONENT_BY_TEMPLATE[template] || 'emailHelper.sendEmail';
      const envKey = templateEnvKey(template);

      // --- disabled via emailHelper ---
      clearSmtpCaptures(smtpDelivery);
      let disabledScenario;
      try {
        const out = await runDirectSend(emailHelper, template, false);
        disabledScenario = {
          template,
          envKey: out.envKey,
          component,
          path: 'emailHelper.sendEmail',
          flag: 'false',
          flagReadsEnabled: out.flagReadsEnabled,
          result: out.result,
          smtpCalls: smtpDelivery.__verifyCaptures.length,
        };
      } catch (err) {
        disabledScenario = {
          template,
          envKey,
          component,
          path: 'emailHelper.sendEmail',
          flag: 'false',
          flagReadsEnabled: isEmailTemplateEnabled(template),
          result: null,
          smtpCalls: smtpDelivery.__verifyCaptures.length,
          error: err.message || String(err),
        };
      }
      {
        const evalResult = evaluateDisabled(disabledScenario);
        if (disabledScenario.error) {
          evalResult.ok = false;
          evalResult.actual = `error=${disabledScenario.error}; ${evalResult.actual}`;
        }
        rows.push({
          ...disabledScenario,
          ...evalResult,
        });
        console.log(
          `${evalResult.ok ? 'PASS' : 'FAIL'} ${template} flag=false emailHelper → ${evalResult.actual}`
        );
      }

      // --- enabled via emailHelper ---
      clearSmtpCaptures(smtpDelivery);
      let enabledScenario;
      try {
        const out = await runDirectSend(emailHelper, template, true);
        enabledScenario = {
          template,
          envKey: out.envKey,
          component,
          path: 'emailHelper.sendEmail',
          flag: 'true',
          flagReadsEnabled: out.flagReadsEnabled,
          result: out.result,
          smtpCalls: smtpDelivery.__verifyCaptures.length,
          messageId: smtpDelivery.__verifyCaptures[0]?.messageId || undefined,
        };
        if (MODE === 'real' && out.result === true) {
          await sleep(REAL_SEND_DELAY_MS);
        }
      } catch (err) {
        enabledScenario = {
          template,
          envKey,
          component,
          path: 'emailHelper.sendEmail',
          flag: 'true',
          flagReadsEnabled: isEmailTemplateEnabled(template),
          result: null,
          smtpCalls: smtpDelivery.__verifyCaptures.length,
          error: err.message || String(err),
        };
      }
      {
        const evalResult = evaluateEnabled(enabledScenario);
        if (enabledScenario.error) {
          evalResult.ok = false;
          evalResult.actual = `error=${enabledScenario.error}; ${evalResult.actual}`;
        }
        rows.push({
          ...enabledScenario,
          ...evalResult,
        });
        console.log(
          `${evalResult.ok ? 'PASS' : 'FAIL'} ${template} flag=true emailHelper → ${evalResult.actual}`
        );
      }

      // --- transactional path (subset) ---
      if (!SKIP_TRANSACTIONAL && TRANSACTIONAL_TEMPLATES.has(template)) {
        clearSmtpCaptures(smtpDelivery);
        let txOff;
        try {
          const out = await runTransactionalSend(transactional, template, false);
          txOff = {
            template,
            envKey: out.envKey,
            component,
            path: 'transactionalEmail.service',
            flag: 'false',
            flagReadsEnabled: out.flagReadsEnabled,
            result: out.result,
            smtpCalls: smtpDelivery.__verifyCaptures.length,
          };
        } catch (err) {
          txOff = {
            template,
            envKey,
            component,
            path: 'transactionalEmail.service',
            flag: 'false',
            flagReadsEnabled: isEmailTemplateEnabled(template),
            result: null,
            smtpCalls: smtpDelivery.__verifyCaptures.length,
            error: err.message || String(err),
          };
        }
        {
          const evalResult = evaluateTransactionalDisabled(txOff);
          if (txOff.error) {
            evalResult.ok = false;
            evalResult.actual = `error=${txOff.error}; ${evalResult.actual}`;
          }
          rows.push({ ...txOff, ...evalResult });
          console.log(
            `${evalResult.ok ? 'PASS' : 'FAIL'} ${template} flag=false transactional → ${evalResult.actual}`
          );
        }

        clearSmtpCaptures(smtpDelivery);
        let txOn;
        try {
          const out = await runTransactionalSend(transactional, template, true);
          txOn = {
            template,
            envKey: out.envKey,
            component,
            path: 'transactionalEmail.service',
            flag: 'true',
            flagReadsEnabled: out.flagReadsEnabled,
            result: out.result,
            smtpCalls: smtpDelivery.__verifyCaptures.length,
            messageId: smtpDelivery.__verifyCaptures[0]?.messageId || undefined,
          };
          if (MODE === 'real' && out.result?.sent) {
            await sleep(REAL_SEND_DELAY_MS);
          }
        } catch (err) {
          txOn = {
            template,
            envKey,
            component,
            path: 'transactionalEmail.service',
            flag: 'true',
            flagReadsEnabled: isEmailTemplateEnabled(template),
            result: null,
            smtpCalls: smtpDelivery.__verifyCaptures.length,
            error: err.message || String(err),
          };
        }
        {
          const evalResult = evaluateTransactionalEnabled(txOn);
          if (txOn.error) {
            evalResult.ok = false;
            evalResult.actual = `error=${txOn.error}; ${evalResult.actual}`;
          }
          rows.push({ ...txOn, ...evalResult });
          console.log(
            `${evalResult.ok ? 'PASS' : 'FAIL'} ${template} flag=true transactional → ${evalResult.actual}`
          );
        }
      }
    }
  } finally {
    restoreSmtp(smtpDelivery);
  }

  const finishedAt = new Date().toISOString();
  const summary = {
    templates: templatesToRun.length,
    total: rows.length,
    passed: rows.filter((r) => r.ok).length,
    failed: rows.filter((r) => !r.ok).length,
  };

  const report = buildReport({
    startedAt,
    finishedAt,
    mode: MODE,
    to: TEST_TO,
    rows,
    summary,
  });

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, report, 'utf8');

  console.log('');
  console.log(`[verify-email-template-flags] passed=${summary.passed} failed=${summary.failed} total=${summary.total}`);
  console.log(`[verify-email-template-flags] report=${REPORT_PATH}`);

  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[verify-email-template-flags] fatal:', err);
  process.exitCode = 1;
});
