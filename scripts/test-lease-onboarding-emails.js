#!/usr/bin/env node
/**
 * ------------------------------------------------------------------
 * File: test-lease-onboarding-emails.js
 * Module: Admin Scripts
 *
 * Purpose:
 * Administrative script for database sync, testing, or system maintenance tasks.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * Lease onboarding email checks (no DB required for default run).
 *
 *   node scripts/test-lease-onboarding-emails.js
 *   node scripts/test-lease-onboarding-emails.js --send invite tenant@example.com
 *   node scripts/test-lease-onboarding-emails.js --send screening tenant@example.com
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const {
  resolveTenantScreeningForEmail,
  hasTenantScreening,
} = require('../src/portals/landlord/modules/leasing/service/leaseTenantInviteDelivery.service');
const emailHelper = require('../src/common/helpers/emailHelper');

/**
 * log Routing Scenario
 *
 * Performs logic operations for logRoutingScenario.
 *
 * @param label - Request/input argument
 * @param splitEntry - Request/input argument
 * @param payloadScreening - Request/input argument
 * @returns Operations result
 */
function logRoutingScenario(label, splitEntry, payloadScreening) {
  const screening = resolveTenantScreeningForEmail(splitEntry, payloadScreening);
  const channel = hasTenantScreening(screening) ? 'screening-only (invite after approval)' : 'lease-invite-now';
  console.log(`  ${label}: screening=[${screening.join(', ')}] → ${channel}`);
}

async function runDryRun() {
  console.log('=== Lease onboarding email dry run ===\n');

  console.log('Routing (2 tenants - mixed lease, same as Create Lease):');
  logRoutingScenario('Tenant A (no screening)', { screening: [] }, []);
  logRoutingScenario('Tenant B (application)', { screening: ['application'] }, ['application']);

  const acknowledgeUrl =
    process.env.TENANT_ACKNOWLEDGE_BASE_URL ||
    `${(process.env.FRONTEND_BASE_URL || 'http://localhost:8080').replace(/\/$/, '')}/acknowledge/demo-tenant/lease/demo-lease`;

  const invitePreview = await emailHelper.composeEmailPreview(
    'invite',
    'preview@example.com',
    {
      tenantName: 'Preview Tenant',
      landlordName: 'Preview Landlord',
      appName: process.env.APP_NAME || 'PropMv',
      inviteUrl: acknowledgeUrl,
      acknowledgeLink: acknowledgeUrl,
      propertyName: 'Preview Property',
      propertyAddress: '100 Test St',
      leaseStartDate: 'May 25, 2026',
    },
    { template: 'invite', subject: 'Action required: Lease invitation - Preview Property' }
  );

  console.log('\nInvite template:');
  console.log(`  Subject: ${invitePreview.subject}`);
  console.log(`  HTML length: ${invitePreview.html.length}`);
  console.log(`  Text length: ${invitePreview.text.length}`);
  console.log(`  URL in HTML: ${invitePreview.html.includes(acknowledgeUrl)}`);
  console.log(`  URL in text: ${invitePreview.text.includes(acknowledgeUrl)}`);

  const screeningUrl = `${(process.env.FRONTEND_BASE_URL || 'http://localhost:8080').replace(/\/$/, '')}/application/screening?leaseId=demo&tenantId=demo`;
  const screeningPreview = await emailHelper.composeEmailPreview(
    'screening-application',
    'preview@example.com',
    {
      tenantName: 'Preview Tenant',
      landlordName: 'Preview Landlord',
      propertyName: 'Preview Property',
      appDisplayName: process.env.APP_NAME || 'PropMv',
      screeningTitle: 'Complete your tenant screening',
      screeningIntro: 'Complete screening first; lease invite follows approval.',
      screeningChecksList: '<div>Application Form</div>',
      applicationUrl: screeningUrl,
      screeningCtaText: 'Start screening',
    },
    { template: 'screening-application', subject: 'Complete Your Tenant Screening - Preview Property' }
  );

  console.log('\nScreening template:');
  console.log(`  Subject: ${screeningPreview.subject}`);
  console.log(`  HTML length: ${screeningPreview.html.length}`);
  console.log(`  URL in text: ${screeningPreview.text.includes(screeningUrl)}`);

  console.log('\nDry run complete. Run unit tests: npm run test:lease-onboarding-emails');
}

async function runSend(type, to) {
  if (!to) {
    console.error('Usage: --send invite|screening <email>');
    process.exit(1);
  }
  const ok = await emailHelper.verifyEmailConfig();
  if (!ok) {
    console.error('SMTP not configured. Set SMTP_PRIMARY_* (or legacy SMTP_*) and FROM_* in .env');
    process.exit(1);
  }

  const base = (process.env.FRONTEND_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');

  if (type === 'invite') {
    const acknowledgeUrl = `${base}/acknowledge/send-test-tenant/lease/send-test-lease`;
    await emailHelper.sendEmail(
      'invite',
      to,
      {
        tenantName: 'SMTP Test Tenant',
        landlordName: 'SMTP Test Landlord',
        appName: process.env.APP_NAME || 'PropMv',
        inviteUrl: acknowledgeUrl,
        acknowledgeLink: acknowledgeUrl,
        propertyName: 'SMTP Test Property',
        propertyAddress: '1 Test Lane',
        leaseStartDate: new Date().toLocaleDateString('en-US'),
      },
      { template: 'invite', subject: `Action required: Lease invitation - SMTP Test` }
    );
    console.log(`Invite test email sent to ${to}`);
    return;
  }

  if (type === 'screening') {
    const applicationUrl = `${base}/application/screening?leaseId=test&tenantId=test`;
    await emailHelper.sendEmail(
      'screening-application',
      to,
      {
        tenantName: 'SMTP Test Tenant',
        landlordName: 'SMTP Test Landlord',
        propertyName: 'SMTP Test Property',
        appDisplayName: process.env.APP_NAME || 'PropMv',
        screeningTitle: 'Complete your tenant screening',
        screeningIntro: 'SMTP test - screening email.',
        screeningChecksList: '<div>Application Form</div>',
        applicationUrl,
        screeningCtaText: 'Start screening',
      },
      { template: 'screening-application', subject: 'Complete Your Tenant Screening - SMTP Test' }
    );
    console.log(`Screening test email sent to ${to}`);
    return;
  }

  console.error('Unknown type. Use invite or screening.');
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--send') {
    await runSend(args[1], args[2]);
    return;
  }
  await runDryRun();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
